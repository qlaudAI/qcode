// /v1/qcode/usage — daily-bucketed cost + token + request rollup over
// the last N days for the authenticated qcode user (product keys only,
// i.e. qpk_ traffic, not qlk_ developer-API traffic).
//
// Mirrors lib/qcode-me.ts — same fetch hardening, same graceful-fail.
// Returns null when the gateway predates the route or fetch fails so
// the Usage view can degrade to "today only" via /v1/qcode/me.

import { getKey } from './auth';

const BASE = (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

export type QcodeUsageDay = {
  day_ms: number;
  cost_micros: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
};

export type QcodeUsageModel = {
  model_slug: string;
  provider_slug: string;
  cost_micros: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
};

export type QcodeUsage = {
  from_ms: number;
  to_ms: number;
  days: number;
  totals: {
    cost_micros: number;
    input_tokens: number;
    output_tokens: number;
    request_count: number;
  };
  by_model: QcodeUsageModel[];
  by_day: QcodeUsageDay[];
};

/** Fetch the last `days` of qcode-only usage (default 30, max 90). */
export async function fetchQcodeUsage(
  days: number = 30,
): Promise<QcodeUsage | null> {
  const key = getKey();
  if (!key) return null;
  try {
    const res = await fetch(`${BASE}/v1/qcode/usage?days=${days}`, {
      headers: { 'x-api-key': key },
      cache: 'no-store',
    });
    if (!res.ok) {
      // 404 = gateway predates the route — caller falls back to
      // today-only via /v1/qcode/me. Other failures are logged.
      if (res.status !== 404) {
        console.warn(
          `[qcode-usage] /v1/qcode/usage returned ${res.status}: ${await res.text().catch(() => '')}`,
        );
      }
      return null;
    }
    return (await res.json()) as QcodeUsage;
  } catch (e) {
    console.warn('[qcode-usage] fetch failed:', e);
    return null;
  }
}

// ─── Bucketing helpers ────────────────────────────────────────────
//
// The endpoint returns daily granularity. The Usage view re-buckets
// to weekly / monthly views in JS to avoid round-tripping for each
// toggle the user flips. Buckets are UTC-aligned to match the
// server's day_ms (which is UTC midnight).

export type UsageBucket = {
  /** Display label: "Today" / "Mon Jul 8" / "Wk Jul 1" / "Jul 2025". */
  label: string;
  /** Anchor timestamp at the bucket start (UTC midnight for day,
   *  Monday-midnight for week, 1st-of-month for month). */
  start_ms: number;
  cost_micros: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
};

/** Per-day buckets, oldest → newest. The server already returns
 *  daily, so this is mostly a label-attachment pass. */
export function bucketByDay(usage: QcodeUsage): UsageBucket[] {
  const todayUtc = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  return usage.by_day.map((d) => ({
    label:
      d.day_ms === todayUtc
        ? 'Today'
        : new Date(d.day_ms).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            timeZone: 'UTC',
          }),
    start_ms: d.day_ms,
    cost_micros: d.cost_micros,
    input_tokens: d.input_tokens,
    output_tokens: d.output_tokens,
    request_count: d.request_count,
  }));
}

/** Monday-anchored ISO week buckets, oldest → newest. */
export function bucketByWeek(usage: QcodeUsage): UsageBucket[] {
  const buckets = new Map<number, UsageBucket>();
  for (const d of usage.by_day) {
    const date = new Date(d.day_ms);
    // ISO weeks start Monday. getUTCDay() returns 0=Sun..6=Sat;
    // shift to Monday-anchor by subtracting (day - 1 + 7) % 7.
    const dow = date.getUTCDay();
    const monShift = (dow + 6) % 7; // Mon=0, Sun=6
    const monday = d.day_ms - monShift * 86_400_000;
    if (!buckets.has(monday)) {
      buckets.set(monday, {
        label: `Wk ${new Date(monday).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        })}`,
        start_ms: monday,
        cost_micros: 0,
        input_tokens: 0,
        output_tokens: 0,
        request_count: 0,
      });
    }
    const b = buckets.get(monday)!;
    b.cost_micros += d.cost_micros;
    b.input_tokens += d.input_tokens;
    b.output_tokens += d.output_tokens;
    b.request_count += d.request_count;
  }
  return [...buckets.values()].sort((a, b) => a.start_ms - b.start_ms);
}

/** Calendar-month buckets (UTC 1st of month), oldest → newest. */
export function bucketByMonth(usage: QcodeUsage): UsageBucket[] {
  const buckets = new Map<number, UsageBucket>();
  for (const d of usage.by_day) {
    const date = new Date(d.day_ms);
    const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    if (!buckets.has(monthStart)) {
      buckets.set(monthStart, {
        label: new Date(monthStart).toLocaleDateString('en-US', {
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        }),
        start_ms: monthStart,
        cost_micros: 0,
        input_tokens: 0,
        output_tokens: 0,
        request_count: 0,
      });
    }
    const b = buckets.get(monthStart)!;
    b.cost_micros += d.cost_micros;
    b.input_tokens += d.input_tokens;
    b.output_tokens += d.output_tokens;
    b.request_count += d.request_count;
  }
  return [...buckets.values()].sort((a, b) => a.start_ms - b.start_ms);
}
