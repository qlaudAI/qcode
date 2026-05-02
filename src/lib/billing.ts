// Wallet balance polling. The qlaud /v1/billing/balance endpoint
// returns the user's wallet balance in USD; we hit it on app start
// and again after every chat turn so the spend bar stays current.
//
// We deliberately don't poll on a timer — that's wasteful when the
// app is idle. Instead `refreshBalance()` is called at well-defined
// moments: app boot (after auth), end of agent turn, manual refresh
// (clicking the spend bar in the title bar).

import { getKey } from './auth';

const BASE = (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

export type BalanceInfo = {
  balanceUsd: number;
  fetchedAt: number;
};

export async function fetchBalance(): Promise<BalanceInfo | null> {
  const key = getKey();
  if (!key) return null;
  try {
    // cache:'no-store' + cache-buster — same hardening pattern as
    // /v1/account. Without this, the Tauri webview happily serves
    // a stale 401 from a pre-signin attempt back to refreshBalance,
    // and the spend bar gets stuck at $0 long after sign-in worked.
    const res = await fetch(`${BASE}/v1/billing/balance?t=${Date.now()}`, {
      headers: { 'x-api-key': key },
      cache: 'no-store',
    });
    if (!res.ok) {
      // Loud failure — the dropped /v1/account symptom (silent CORS
      // rejection invisible for weeks) was the same code shape as
      // this. Console.warn so devtools sees it; the empty return
      // keeps callers happy on the happy-path-degraded fallback.
      console.warn(
        `[billing] /v1/billing/balance returned ${res.status}: ${await res.text().catch(() => '')}`,
      );
      return null;
    }
    const body = (await res.json()) as { balance_usd?: number; balance_micros?: number };
    const balanceUsd =
      typeof body.balance_usd === 'number'
        ? body.balance_usd
        : typeof body.balance_micros === 'number'
          ? body.balance_micros / 1_000_000
          : 0;
    return { balanceUsd, fetchedAt: Date.now() };
  } catch (e) {
    console.warn('[billing] /v1/billing/balance fetch failed:', e);
    return null;
  }
}
