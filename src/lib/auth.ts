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

/** Open the qlaud CLI-auth flow in the user's browser. */
export async function startSignIn(): Promise<void> {
  const cb = 'qcode://auth';
  const url = `https://qlaud.ai/cli-auth?cb=${encodeURIComponent(cb)}&app=qcode`;
  await openExternal(url);
}
