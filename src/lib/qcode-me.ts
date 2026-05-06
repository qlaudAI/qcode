// /v1/qcode/me — plan tier + period-to-date usage + wallet balance,
// in a single bearer-authed read.
//
// Subscription pricing on the surface, credit-style accounting under
// the hood. The user just sees "Pro $17/mo, used $X this period."
// One number per plan, one comparison, no per-tier buckets.
//
// Returns null when the gateway 404s the route (older edge worker
// not yet upgraded) so the client degrades gracefully.

import { getKey } from './auth';

const BASE = (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

export type QcodePlanTier = 'free' | 'pro' | 'power';

export type QcodeMe = {
  user_id: string;
  plan: {
    tier: QcodePlanTier;
    /** Start of the current billing period (ms epoch). Free's
     *  trial starts at user.createdAt; Pro/Power at the last
     *  Stripe invoice.paid renewal. */
    period_starts_at: number;
    /** End of the current billing period (ms epoch). Null for
     *  Free (lifetime trial credit, no reset). For Pro/Power, the
     *  next billing date; clients render countdown text. */
    period_resets_at: number | null;
    has_active_subscription: boolean;
    benefits: {
      displayName: string;
      monthlyUsd: number;
      walletCreditUsd: number;
      oneLine: string;
      bullets: string[];
    };
  };
  /** Period-to-date usage. Single bar fuel — used_usd vs budget_usd
   *  is the entire UI surface. Per-model breakdown is a separate
   *  query against /v1/qcode/usage when the user opens the Usage tab. */
  usage: {
    used_usd: number;
    budget_usd: number;
    /** 0-100, one decimal. UI maps this to color states:
     *    < 70  white/muted
     *    < 90  amber
     *    < 100 red
     *    >= 100 black + Upgrade CTA */
    percent: number;
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
