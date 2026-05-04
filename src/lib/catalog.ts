// qlaud catalog client.
//
// The hardcoded MODELS array in src/lib/models.ts is no longer the
// source of truth — it's the offline / first-paint fallback. The
// real list comes from GET /v1/catalog (public, cacheable).
//
// We split surfaces by `task`:
//   - text-generation → ModelPicker + Settings dropdowns
//   - image-generation, tts, stt, video-generation → tool surfaces
//     (skills), not the model picker
//   - embeddings, search → not user-pickable today
//
// Fetched eagerly on app boot, cached in React Query (5 min stale)
// + mirrored to localStorage so the picker paints instantly on the
// next cold start without waiting for the network.

import type { ModelEntry } from './models';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ??
  'https://api.qlaud.ai';

const CACHE_KEY = 'qcode.catalog.v1';

export type CatalogTask =
  | 'text-generation'
  | 'image-generation'
  | 'tts'
  | 'stt'
  | 'video-generation'
  | 'embeddings'
  | 'search';

export type CatalogCapability =
  | 'function-calling'
  | 'streaming'
  | 'reasoning'
  | 'vision'
  | 'audio-in'
  | 'audio-out';

export type CatalogHost = {
  provider: string;
  input_per_mtok_usd: number;
  output_per_mtok_usd: number;
  throughput_score: number;
  verified_tools_ok: boolean;
  quant?: string;
};

export type CatalogModel = {
  slug: string;
  display_name: string;
  author: string;
  description: string;
  task: CatalogTask;
  capabilities: CatalogCapability[];
  context_window: number;
  default_max_tokens: number;
  hosts: CatalogHost[];
};

export type CatalogProvider = {
  slug: string;
  display_name: string;
};

export type Catalog = {
  providers: CatalogProvider[];
  models: CatalogModel[];
  markup_multiplier: number;
  generated_at: string;
};

/** Public, no auth needed. Edge caches for 5 min so the request is
 *  basically free even on every cold start. */
export async function fetchCatalog(signal?: AbortSignal): Promise<Catalog> {
  const res = await fetch(`${BASE}/v1/catalog`, { signal });
  if (!res.ok) {
    throw new Error(`catalog_${res.status}`);
  }
  return (await res.json()) as Catalog;
}

/** localStorage hydration — gives the picker something to render
 *  during the first network round-trip. The cached blob is
 *  authoritative until the live fetch lands; if both are missing
 *  callers fall through to the bundled MODELS list. */
export function loadCachedCatalog(): Catalog | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Catalog;
  } catch {
    return null;
  }
}

export function saveCachedCatalog(c: Catalog): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(CACHE_KEY, JSON.stringify(c));
}

// ─── Catalog → ModelEntry mapping ──────────────────────────────────
//
// ModelPicker / SettingsDrawer consume `ModelEntry[]`. Project the
// live catalog into that shape, filtered to text-generation only.
// Tier is derived heuristically — the catalog doesn't carry one,
// and a price-based bucketing matches user intuition ("I want the
// cheap one" / "I want the smartest one") without us hand-editing
// per-slug entries.

/** Provider display name lookup (catalog slug → human label) using
 *  the catalog's own providers list. Falls back to the slug if a
 *  provider entry is missing — defensive only, the catalog should
 *  always include every provider its hosts reference. */
function providerLabel(c: Catalog, slug: string): string {
  return c.providers.find((p) => p.slug === slug)?.display_name ?? slug;
}

/** Tier inference from price + capabilities. Order matters — we
 *  check reasoning first (caps a model into the "reasoning" bucket
 *  even when its price would otherwise put it elsewhere) so users
 *  searching for a thinking model find it under a stable label. */
function inferTier(m: CatalogModel): ModelEntry['tier'] {
  if (m.capabilities.includes('reasoning')) return 'reasoning';
  // Use the cheapest host's input price as the basis — that's what
  // qlaud routes to when no override is set.
  const price = Math.min(...m.hosts.map((h) => h.input_per_mtok_usd));
  if (price <= 0.5) return 'cheap';
  if (price >= 4) return 'flagship';
  return 'fast';
}

/** First sentence of the catalog description, capped at ~120 chars
 *  for the picker's blurb slot. The catalog descriptions tend to
 *  start with a punchy summary then trail into routing details
 *  irrelevant to end users; the first sentence is usually the
 *  user-facing line. */
function shortBlurb(description: string): string {
  const firstSentence = description.split(/(?<=[.!?])\s/)[0] ?? description;
  if (firstSentence.length > 140) return firstSentence.slice(0, 137).trim() + '…';
  return firstSentence;
}

/** Project the catalog's text-generation models into the picker's
 *  ModelEntry shape. Caller passes a Catalog (live or cached) and
 *  gets back a sorted, picker-ready array. */
export function textModelsFromCatalog(c: Catalog): ModelEntry[] {
  return c.models
    .filter((m) => m.task === 'text-generation')
    .map<ModelEntry>((m) => ({
      slug: m.slug,
      label: m.display_name,
      provider: providerLabel(c, m.hosts[0]?.provider ?? ''),
      tier: inferTier(m),
      blurb: shortBlurb(m.description),
    }));
}

/** Filter helper for the future media skill / tool injection paths.
 *  Returns models whose `task` matches any of the given kinds.
 *  Used by the image/TTS/video skill registration code path. */
export function modelsByTasks(
  c: Catalog,
  tasks: CatalogTask[],
): CatalogModel[] {
  const want = new Set(tasks);
  return c.models.filter((m) => want.has(m.task));
}
