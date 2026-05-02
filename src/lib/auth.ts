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
 *  decide whether to show the sign-in gate. Idempotent. */
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
  } else {
    cachedKey = localStorage.getItem(FALLBACK_STORAGE);
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
  }
  localStorage.removeItem(PROFILE_STORAGE);
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
