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
    const res = await fetch(`${BASE}/v1/account`, {
      headers: { 'x-api-key': key },
    });
    if (!res.ok) return null;
    return (await res.json()) as AccountInfo;
  } catch {
    return null;
  }
}
