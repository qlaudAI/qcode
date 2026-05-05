// /v1/qcode/me — plan tier + today's per-tier usage + wallet balance,
// in a single bearer-authed read. Used by the title-bar SpendBar +
// (future) Settings plan panel to render the right UI for the user's
// current plan.
//
// Mirrors lib/billing.ts (fetchBalance) — same fetch hardening, same
// graceful-fail. Returns null when the gateway doesn't have the
// route deployed yet so older clients keep working.

import { getKey } from './auth';

const BASE = (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

export type QcodePlanTier = 'free' | 'pro' | 'power';

export type QcodeMe = {
  user_id: string;
  plan: {
    tier: QcodePlanTier;
    status: string;
    renewed_at: number | null;
    expires_at: number | null;
    has_active_subscription: boolean;
    benefits: {
      displayName: string;
      monthlyUsd: number;
      walletCreditUsd: number;
      oneLine: string;
      bullets: string[];
    };
  };
  today: {
    day_utc: string;
    tiers: Array<{
      tier: string;
      used: number;
      limit: number | null;
      unit: 'messages' | 'tokens' | 'minutes';
      remaining: number | null;
      percent: number | null;
    }>;
  };
  wallet: {
    balance_micros: number;
    balance_usd: number;
  };
};

export async function fetchQcodeMe(): Promise<QcodeMe | null> {
  const key = getKey();
  if (!key) return null;
  try {
    const res = await fetch(`${BASE}/v1/qcode/me?t=${Date.now()}`, {
      headers: { 'x-api-key': key },
      cache: 'no-store',
    });
    if (!res.ok) {
      // 404 = gateway predates the /v1/qcode/me route; degrade
      // gracefully so legacy clients keep working without the plan
      // badge. Other failures are logged for debug visibility.
      if (res.status !== 404) {
        console.warn(
          `[qcode-me] /v1/qcode/me returned ${res.status}: ${await res.text().catch(() => '')}`,
        );
      }
      return null;
    }
    return (await res.json()) as QcodeMe;
  } catch (e) {
    console.warn('[qcode-me] /v1/qcode/me fetch failed:', e);
    return null;
  }
}
