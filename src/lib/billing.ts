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
    const res = await fetch(`${BASE}/v1/billing/balance`, {
      headers: { 'x-api-key': key },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { balance_usd?: number; balance_micros?: number };
    const balanceUsd =
      typeof body.balance_usd === 'number'
        ? body.balance_usd
        : typeof body.balance_micros === 'number'
          ? body.balance_micros / 1_000_000
          : 0;
    return { balanceUsd, fetchedAt: Date.now() };
  } catch {
    return null;
  }
}
