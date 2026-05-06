// Client-side mirror of apps/edge/src/billing/plans.ts MODEL_TIER_MAP.
//
// Why duplicate: model picker + Settings need to know whether a
// given slug is available on the user's current plan, BEFORE the
// user clicks Send. The server is still the source of truth at
// dispatch time (checkQcodePlanQuota gates the actual request),
// but UI gating prevents wasted clicks + clarifies the upgrade
// pitch ("you can't use Opus on Free, upgrade to Pro").
//
// Sync with the server table when adding catalog entries. Drift
// failure mode is non-fatal: if a model is mis-categorized here,
// either (a) the picker greys it out incorrectly (annoying, easy
// to fix on next deploy) or (b) it doesn't grey it out and the
// user sees the 402 upgrade card instead. Either way no data
// loss.
//
// To keep the qcode bundle small, only the slugs that exist in the
// catalog are included. Unknown slugs default to 'mid' (same
// fallback as server-side tierFor()).

import type { QcodeMe } from './qcode-me';

export type ModelTier =
  | 'cheap'
  | 'mid'
  | 'premium'
  | 'image-cheap'
  | 'image'
  | 'tts'
  | 'stt'
  | 'video'
  | 'embedding'
  | 'search';

export const MODEL_TIER_MAP: Record<string, ModelTier> = {
  // cheap (the wedge — unlimited on every plan)
  'deepseek-chat': 'cheap',
  'deepseek-reasoner': 'cheap',
  'qwen-coder-plus': 'cheap',
  'kimi-k2.6': 'cheap',
  'MiniMax-M2': 'cheap',

  // mid (generous Pro caps)
  'claude-sonnet-4-6': 'mid',
  'claude-haiku-4-5': 'mid',
  'gemini-3-pro-preview': 'mid',
  'gpt-5.4': 'mid',
  'gpt-5.4-mini': 'mid',
  'grok-4.20-0309-reasoning': 'mid',

  // premium (tight Pro caps, BLOCKED on Free)
  'claude-opus-4-7': 'premium',

  // image
  'gpt-image-1': 'image',

  // tts
  'eleven_multilingual_v2': 'tts',
  'eleven_turbo_v2_5': 'tts',

  // stt
  'nova-3': 'stt',
  'whisper-1': 'stt',

  // video (BLOCKED on Free)
  'sora-2': 'video',
  'sora-2-pro': 'video',

  // embeddings
  'text-embedding-3-large': 'embedding',

  // search
  'sonar-pro': 'search',
};

export function tierFor(modelSlug: string): ModelTier {
  return MODEL_TIER_MAP[modelSlug] ?? 'mid';
}

/** Returns true if the user's current plan blocks this model
 *  entirely. With the credit-model rewrite, NO model is gated by
 *  plan tier — every plan covers every model, the only ceiling is
 *  the period-to-date $-budget. So this always returns false now.
 *
 *  Kept as a function (rather than deleted) so the call sites stay
 *  stable; future per-feature gates (e.g. "Power only: priority
 *  routing") can plug in without touching the callers. */
export function isModelGatedForPlan(
  _modelSlug: string,
  _qcodeMe: QcodeMe | null,
): boolean {
  return false;
}

/** What plan does the user need to upgrade to in order to use this
 *  model? Free → Pro for premium/image/video. Pro → Power for power-
 *  exclusive features (none today, but future-proofed). Returns
 *  null when no upgrade unlocks it (shouldn't happen with current
 *  LIMITS, but defensive). The modelSlug arg is currently unused
 *  but kept for the future case where some power-only premium
 *  models exist (e.g. Sora-2-pro on Power only). */
export function upgradeTierForModel(
  _modelSlug: string,
  qcodeMe: QcodeMe | null,
): 'pro' | 'power' | null {
  if (!qcodeMe) return null;
  const planTier = qcodeMe.plan.tier;
  if (planTier === 'free') return 'pro';
  if (planTier === 'pro') return 'power';
  return null;
}
