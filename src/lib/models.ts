// Curated model picker entries. Source of truth is the qlaud catalog
// API at https://api.qlaud.ai/v1/catalog — we hard-code the v0 list
// here so the picker renders before we fetch. Production code refreshes
// this on app start; the snapshot is just for first paint.

export type ModelEntry = {
  slug: string;
  label: string;
  provider: string;
  /** Tier hint for the picker — mostly cosmetic. */
  tier: 'flagship' | 'fast' | 'cheap' | 'reasoning';
  /** Surface-level hook for the user — not pricing copy. */
  blurb: string;
};

export const MODELS: ModelEntry[] = [
  {
    slug: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    provider: 'Anthropic',
    tier: 'flagship',
    blurb: 'Best reasoning, best coding, slowest, most expensive.',
  },
  {
    slug: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    tier: 'fast',
    blurb: 'Default for most tasks. Great speed/quality balance.',
  },
  {
    slug: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    tier: 'cheap',
    blurb: 'Cheapest Anthropic. Good for tight loops + fast iteration.',
  },
  {
    slug: 'gpt-5.4',
    label: 'GPT-5.4',
    provider: 'OpenAI',
    tier: 'flagship',
    blurb: 'OpenAI’s flagship. Strong on tools, second on coding.',
  },
  {
    slug: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    provider: 'OpenAI',
    tier: 'fast',
    blurb: 'OpenAI’s fast tier. Solid for everyday tasks.',
  },
  {
    slug: 'deepseek-chat',
    label: 'DeepSeek Chat',
    provider: 'DeepSeek',
    tier: 'cheap',
    blurb: '5–10× cheaper than Claude/GPT. Great for high-volume coding.',
  },
  {
    slug: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    provider: 'DeepSeek',
    tier: 'reasoning',
    blurb: 'Open-source reasoning model. Strong on multi-step problems.',
  },
  {
    slug: 'kimi-k2.6',
    label: 'Kimi K2.6',
    provider: 'Moonshot',
    tier: 'flagship',
    blurb: 'Long-context champion. 200k+ tokens with no quality drop.',
  },
  {
    slug: 'qwen-coder-plus',
    label: 'Qwen Coder Plus',
    provider: 'Alibaba',
    tier: 'cheap',
    blurb: 'Code-specialized open-source model. Great pricing.',
  },
  {
    slug: 'gemini-3-pro-preview',
    label: 'Gemini 3 Pro',
    provider: 'Google',
    tier: 'flagship',
    blurb: 'Google’s flagship. Multimodal, large context.',
  },
];

export const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Approximate context windows in tokens — used by the composer's
// usage indicator ("32k / 200k") and the auto-compaction headroom
// calculation. Keep this aligned with the upstream provider docs;
// when in doubt, prefer the smaller number so we trigger compaction
// sooner rather than overshooting and 4xx-ing.
const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-7': 200_000,
  'claude-opus-4-7[1m]': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'gpt-5.4': 200_000,
  'gpt-5.4-mini': 128_000,
  'deepseek-chat': 128_000,
  'deepseek-reasoner': 64_000,
  'kimi-k2.6': 200_000,
  'qwen-coder-plus': 128_000,
  'gemini-3-pro-preview': 2_000_000,
};

/** Look up the (approximate) context window for a model slug. Falls
 *  back to a conservative 200k when we don't know the model — the
 *  indicator stays informative without claiming a window we can't
 *  guarantee. */
export function contextWindowFor(slug: string): number {
  return CONTEXT_WINDOWS[slug] ?? 200_000;
}
