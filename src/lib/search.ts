// Semantic search across thread history.
//
// Hits qlaud's /v1/search endpoint which embeds the query (OpenAI
// text-embedding-3-large at 1536 dims) and runs k-NN against every
// indexed user + final-assistant turn the caller owns. Tool-loop
// intermediates are excluded server-side so results stay prose-only.
//
// Why this beats the title-substring match the sidebar started with:
//   - Finds threads by what was DISCUSSED, not just by title — the
//     auto-generated title is whatever the first user prompt looked
//     like, which is rarely how the user remembers the thread later.
//   - Ranks by cosine similarity (score 0.6+ = strong topical match)
//     so the most-relevant thread floats to the top.
//   - Returns a 240-char snippet centered on the match — instant
//     "is this the conversation I'm looking for?" preview.
//
// Caller pattern: debounce ~250ms after the user stops typing, fire
// searchThreads(q), dedupe by thread_id keeping highest-score hit.

import { getKey } from './auth';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ??
  'https://api.qlaud.ai';

export type SearchHit = {
  thread_id: string;
  seq: number;
  role: 'user' | 'assistant';
  /** Cosine similarity, -1.0..1.0. >0.6 = strong, 0.3..0.6 = related,
   *  <0.3 = weak. We render a small score badge so the user can
   *  spot the difference at a glance. */
  score: number;
  /** ~240-char excerpt centered on the matching tokens. Server-
   *  side trims; we don't need to truncate further. */
  snippet: string;
  created_at: number;
};

export type SearchResponse = {
  object: 'list';
  query: string;
  data: SearchHit[];
};

/** Search across every thread the caller owns. Returns hits ranked
 *  by cosine similarity (best first). Errors surface to console
 *  and resolve to []; the sidebar then falls back to title-
 *  substring match for graceful degradation. */
export async function searchThreads(
  query: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<SearchHit[]> {
  const key = getKey();
  if (!key || !query.trim()) return [];
  const url = new URL(`${BASE}/v1/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(opts.limit ?? 20));
  try {
    const res = await fetch(url.toString(), {
      headers: { 'x-api-key': key },
      cache: 'no-store',
      signal: opts.signal,
    });
    if (!res.ok) {
      console.warn(
        `[search] /v1/search returned ${res.status}: ${await res.text().catch(() => '')}`,
      );
      return [];
    }
    const body = (await res.json()) as SearchResponse;
    return body.data ?? [];
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return [];
    console.warn('[search] /v1/search fetch failed:', e);
    return [];
  }
}

/** Collapse multiple hits-per-thread (the user + assistant turn
 *  often both match the same query) into a single entry per thread,
 *  keeping the highest-scoring snippet. Returns hits in score
 *  order so the sidebar can render them top-down. */
export function dedupeByThread(hits: SearchHit[]): SearchHit[] {
  const best = new Map<string, SearchHit>();
  for (const h of hits) {
    const prior = best.get(h.thread_id);
    if (!prior || h.score > prior.score) best.set(h.thread_id, h);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}
