// /v1/account fetcher. Called once after hydrateAuth so the user's
// email + display name make it into the profile cache and the
// settings drawer renders "Signed in as foo@bar.com" instead of an
// empty string.
//
// Lives separate from billing.ts because the data shape + cadence
// differ: balance refreshes after every turn, account info changes
// only on sign-in / email change. We fetch account once per session
// and let the cached profile carry it.

import { getKey } from './auth';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

export type AccountInfo = {
  user_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
};

export async function fetchAccount(): Promise<AccountInfo | null> {
  const key = getKey();
  if (!key) return null;
  try {
    // cache:'no-store' forces a fresh network hit every time. Without
    // this the Tauri webview happily serves a stale 401 from a
    // pre-signin attempt — the user signs in, refreshAccount fires,
    // and the cached 401 wins, leaving the settings row empty.
    const res = await fetch(`${BASE}/v1/account?t=${Date.now()}`, {
      headers: { 'x-api-key': key },
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn(
        `[account] /v1/account returned ${res.status}: ${await res.text().catch(() => '')}`,
      );
      return null;
    }
    return (await res.json()) as AccountInfo;
  } catch (e) {
    console.warn('[account] /v1/account fetch failed:', e);
    return null;
  }
}
