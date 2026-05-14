// Auth state. In the packaged Tauri app, the qlaud key lives in the
// OS-native keychain (Apple Keychain / Windows Credential Manager /
// libsecret) via Rust commands defined in src-tauri/src/secret.rs.
// In vite-dev (no Tauri host) we fall back to localStorage so the UI
// stays iterable without the desktop shell.
//
// Profile (email, balance) stays in localStorage either way — it's
// non-sensitive and we don't want to round-trip the keychain on every
// render.
//
// Auth flow:
//   1. User clicks "Sign in with qlaud" → opens https://qlaud.ai/cli-auth
//   2. qlaud.ai mints a CLI key, deep-links back to qcode://auth?k=...
//   3. Tauri's deep-link plugin captures the URL → posts the key into
//      this module → it's persisted to keychain.

import { invoke, isTauri, openExternal } from './tauri';

const SERVICE = 'ai.qlaud.qcode';
const ACCOUNT = 'qlaud_key';
const PROFILE_STORAGE = 'qcode.profile';
// Browser-mode fallback only. Never read this in the packaged app.
const FALLBACK_STORAGE = 'qcode.qlaud_key';
// Set by clearAuth() in web mode. When present, hydrateAuth() skips
// the boot-time Clerk→qpk_ SSO exchange. Without this gate, hitting
// "Sign out" in qcode would be useless — the next page load would
// auto-mint a new qpk_ from the still-active Clerk session. The
// flag is cleared on any explicit sign-in path (startSignIn,
// setKey) so signing back in re-enables the silent SSO.
const SSO_DISABLED_FLAG = 'qcode.sso_disabled';

// API origin for the Clerk session → qpk_ exchange. Same base every
// other qlaud lib in qcode reads from (kept in sync deliberately).
const EDGE_BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

// Keychain reads are async, but the rest of the app expects a sync
// snapshot for React's initial render. We hydrate this cache once at
// startup via hydrateAuth() and keep it in sync on writes.
let cachedKey: string | null = null;
let hydrated = false;

export type Profile = {
  email: string;
  user_id: string;
  balance_usd?: number;
};

/** Block on the first keychain read so React's initial render can
 *  decide whether to show the sign-in gate. Idempotent.
 *
 *  alpha.204: when running in web mode with no cached key, attempt
 *  the silent Clerk → qpk_ exchange BEFORE returning. The visitor
 *  may already be signed into qlaud.ai (the Clerk cookie lives on
 *  `.qlaud.ai` so it's readable from every subdomain); if so, we
 *  mint a fresh qpk_ off that session and skip the SignInGate
 *  entirely. Failures (no Clerk session, network error, 401) fall
 *  through silently to the existing sign-in gate flow.
 */
export async function hydrateAuth(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  if (isTauri()) {
    try {
      const v = await invoke<string | null>('secret_get', {
        service: SERVICE,
        account: ACCOUNT,
      });
      cachedKey = typeof v === 'string' ? v : null;
    } catch {
      cachedKey = null;
    }
    // Tauri can't read browser cookies from qlaud.ai — the desktop
    // app authenticates exclusively via the deep-link cli-auth flow.
    // Skip the SSO bridge entirely on the desktop side.
    return;
  }
  cachedKey = localStorage.getItem(FALLBACK_STORAGE);
  if (cachedKey) return;
  // No cached key + web mode. Try the Clerk SSO bridge — but only
  // if the user hasn't explicitly signed out (the flag would mean
  // their intent is "stay signed out" regardless of Clerk state).
  if (localStorage.getItem(SSO_DISABLED_FLAG)) return;
  await attemptSsoSignIn();
}

/** Attempt to mint a fresh qpk_ from the visitor's Clerk session by
 *  hitting `/dashboard/api/qcode/session/issue` on the edge worker.
 *  Requires the Clerk `__session` cookie to be sent (achieved via
 *  `credentials: 'include'` + CORS allow-credentials on the worker
 *  side, which is already configured for the dashboard origins
 *  list — qcode.qlaud.ai is included).
 *
 *  Returns true if a key was minted + persisted, false otherwise.
 *  Never throws — every failure path falls through to the existing
 *  SignInGate flow.
 *
 *  Cost: one fetch on first cold boot when no qpk_ is cached. The
 *  call resolves in ~50-150ms at the edge. Subsequent boots have
 *  cachedKey present and skip this entirely.
 */
export async function attemptSsoSignIn(): Promise<boolean> {
  if (isTauri()) return false;
  try {
    // Short timeout — if the bridge can't answer in ~3s, the user
    // is better served by seeing SignInGate quickly than waiting on
    // a slow round-trip. AbortController is the standard primitive.
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(`${EDGE_BASE}/dashboard/api/qcode/session/issue`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client: 'qcode-web',
        // Best-effort client version tag — useful for the
        // product_keys.client_version column. Reads the runtime
        // string Vite injects at build (alpha.NNN). Falls back to
        // an empty string which the server treats as unknown.
        client_version: (import.meta.env.VITE_APP_VERSION as string) ?? '',
      }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return false;
    const data = (await r.json()) as { ok?: boolean; key?: string };
    if (!data.key) return false;
    await setKey(data.key);
    void import('./analytics').then((a) =>
      a.posthog.capture('sso_auto_signin_success'),
    );
    return true;
  } catch {
    // Network error, abort, JSON parse — all silent. The user just
    // sees SignInGate, same as today.
    return false;
  }
}

export function getKey(): string | null {
  return cachedKey;
}

export async function setKey(k: string): Promise<void> {
  cachedKey = k;
  if (isTauri()) {
    await invoke('secret_set', {
      service: SERVICE,
      account: ACCOUNT,
      value: k,
    });
  } else {
    localStorage.setItem(FALLBACK_STORAGE, k);
    // Any successful key persistence means the user is signed in,
    // so the explicit-sign-out flag is no longer current. Clear it
    // so a future sign-out (and re-arrival) can re-trigger SSO.
    localStorage.removeItem(SSO_DISABLED_FLAG);
  }
}

export async function clearAuth(): Promise<void> {
  cachedKey = null;
  if (isTauri()) {
    try {
      await invoke('secret_del', { service: SERVICE, account: ACCOUNT });
    } catch {
      // Sign-out shouldn't fail loudly if the keychain entry was
      // already gone.
    }
  } else {
    localStorage.removeItem(FALLBACK_STORAGE);
    // Mark the explicit sign-out so hydrateAuth doesn't auto-mint a
    // fresh qpk_ from the still-active Clerk session on next load.
    // Cleared by setKey() (the next successful sign-in re-enables
    // silent SSO) and by startSignIn() (clicking the sign-in button
    // signals the user wants in again).
    localStorage.setItem(SSO_DISABLED_FLAG, '1');
  }

  // Wipe ALL user-scoped state so the next account doesn't see the
  // previous one's workspaces, thread history, mode preferences, etc.
  // The qcode.catalog.v1 cache and qcode.settings are deliberately
  // preserved — catalog is not user-scoped (same model list for
  // everyone), and settings carry device-level prefs (theme, default
  // model picker behavior) the user reasonably wants to keep.
  //
  // Strategy: explicit list for the well-known keys + a prefix sweep
  // for the dynamic ones (per-thread mode tracking writes
  // qcode.thread.<id>.lastMode, can't be enumerated without reading
  // localStorage's keys).
  const EXACT_KEYS = [
    PROFILE_STORAGE,
    'qcode.workspace.current',
    'qcode.workspace.mru',
    'qcode.workspaces.v1',
    'qcode.threads.summaries.v2',
  ];
  for (const k of EXACT_KEYS) {
    localStorage.removeItem(k);
  }
  // Sweep dynamic per-thread keys. Iterate by index from the end so
  // removeItem during iteration doesn't skip entries.
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (k.startsWith('qcode.thread.')) {
      localStorage.removeItem(k);
    }
  }

  // Notify any still-mounted workspace subscribers (e.g. the
  // sidebar visible briefly during the auth transition) that the
  // registry has been cleared. Avoids a stale-render flash before
  // the sign-in gate replaces the chrome.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('qcode:workspaces-changed'));
  }
}

export function getProfile(): Profile | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(PROFILE_STORAGE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Profile;
  } catch {
    return null;
  }
}

export function setProfile(p: Profile): void {
  localStorage.setItem(PROFILE_STORAGE, JSON.stringify(p));
}

/** Open the qlaud CLI-auth flow.
 *  - Tauri: uses `qcode://auth` as the callback so the OS dispatches
 *    the result back to the desktop app via the deep-link plugin.
 *  - Browser (qcode.qlaud.ai or vite dev): uses the current origin's
 *    `/auth` path so qlaud.ai can redirect the user back into the
 *    web app, where consumeAuthCallback() picks up the `k` query
 *    param and stores it in localStorage.
 *
 *  Throws on Tauri permission failures so the caller can surface them
 *  to the user. We hit this once already (alpha.14) when capabilities/
 *  was missing — `await openExternal` rejected silently, the click
 *  handler ate the rejection, and sign-in looked frozen. Never again. */
export async function startSignIn(): Promise<void> {
  // Clicking the sign-in button is an explicit "I want in" — wipe
  // the explicit-sign-out flag so silent SSO is re-armed for the
  // next cold boot. No-op for Tauri (the flag is web-only).
  if (!isTauri()) {
    try {
      localStorage.removeItem(SSO_DISABLED_FLAG);
    } catch {
      // localStorage can throw in incognito; the flag wasn't there
      // anyway, so this is fine to swallow.
    }
  }
  // Fire before any IO — even if the redirect fails or the user
  // bails halfway, we still see they clicked.
  void import('./analytics').then((a) => a.posthog.capture('sign_in_started'));
  const cb = isTauri()
    ? 'qcode://auth'
    : `${window.location.origin}/auth`;
  const url = `https://qlaud.ai/cli-auth?cb=${encodeURIComponent(cb)}&app=qcode`;
  if (isTauri()) {
    try {
      await openExternal(url);
    } catch (e) {
      throw new Error(
        `Couldn't open the browser. Tauri error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else {
    // Browser: same-tab redirect feels more like the OAuth flows
    // users are used to. After qlaud.ai authorizes, they land back
    // on /auth with the key as a query param.
    window.location.href = url;
  }
}

/** Browser-mode callback handler. Called once at app boot (main.tsx)
 *  to capture `?k=<key>` from the URL after a redirect from qlaud.ai
 *  /cli-auth. Persists the key, scrubs it from the URL bar, and
 *  resolves true so the caller can show a "signed in" state.
 *  No-op in Tauri (deep-link plugin handles that flow). */
export async function consumeAuthCallback(): Promise<boolean> {
  if (isTauri()) return false;
  if (typeof window === 'undefined') return false;
  // Match either /auth?k= (intended path) or any page receiving ?k=
  // (defensive — qlaud may redirect to / with the param in some
  // configurations, and we shouldn't lose the key over that).
  const url = new URL(window.location.href);
  const k = url.searchParams.get('k');
  if (!k) return false;
  await setKey(decodeURIComponent(k));
  // Scrub the key from the URL bar before any user-visible render —
  // we don't want it sitting in browser history or screenshots.
  url.searchParams.delete('k');
  url.searchParams.delete('app');
  // /auth is just the landing path for the redirect; bring the user
  // home now that we've consumed the callback.
  if (url.pathname === '/auth') url.pathname = '/';
  window.history.replaceState({}, '', url.toString());
  return true;
}
