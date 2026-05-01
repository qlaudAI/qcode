// Minimal auth state. Tauri-less by design so the same code can run in
// `vite dev` (browser) for UI iteration and in the packaged app.
//
// On the packaged app the qlaud API key lives in the OS keychain via
// the @tauri-apps/api keyring (added later); here we use localStorage
// as the fallback for browser-mode dev.
//
// Auth flow (Phase 1):
//   1. User clicks "Sign in with qlaud" → opens https://qlaud.ai/cli-auth
//   2. qlaud.ai mints a CLI key, deep-links back to qcode://auth?k=...
//   3. Tauri's deep-link plugin captures the URL → posts the key into
//      this module → it's persisted to keychain.

const KEY_STORAGE = 'qcode.qlaud_key';
const PROFILE_STORAGE = 'qcode.profile';

export type Profile = {
  email: string;
  user_id: string;
  balance_usd?: number;
};

export function getKey(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(KEY_STORAGE);
}

export function setKey(k: string): void {
  localStorage.setItem(KEY_STORAGE, k);
}

export function clearAuth(): void {
  localStorage.removeItem(KEY_STORAGE);
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

/** Open the qlaud CLI-auth flow. Tauri-mode opens via plugin-shell;
 *  browser-mode opens a new tab. */
export async function startSignIn(): Promise<void> {
  const cbScheme = 'qcode://auth';
  const url = `https://qlaud.ai/cli-auth?cb=${encodeURIComponent(cbScheme)}&app=qcode`;
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
