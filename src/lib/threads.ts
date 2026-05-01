// Thread state — qlaud now owns the canonical conversation history.
//
// We keep a localStorage cache of thread *summaries* (id, title,
// model, timestamps) so the sidebar renders before the network
// round-trip lands on cold app start. The remote is authoritative;
// the cache is best-effort and reconciled in the background by
// listRemoteThreads().
//
// Sprint C-2 dropped the per-thread message blobs in localStorage —
// /v1/threads/:id/messages GET is the source of truth now.

import { getKey } from './auth';
import type { ContentBlock, Message } from './qlaud-client';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ??
  'https://api.qlaud.ai';

const TITLE_MAX = 60;
const SUMMARY_INDEX_KEY = 'qcode.threads.summaries.v2';

export type ThreadSummary = {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
};

// ─── Remote API ────────────────────────────────────────────────────

export type RemoteThread = {
  id: string;
  end_user_id: string | null;
  metadata: unknown;
  created_at: number;
  last_active_at: number;
};

export type RemoteThreadMessage = {
  seq: number;
  role: 'user' | 'assistant';
  content: ContentBlock[] | string;
  request_id: string | null;
  created_at: number;
};

async function api<T>(
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<T> {
  const key = getKey();
  if (!key) throw new Error('not_authed');
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'x-api-key': key,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (res.status === 404) throw new Error('not_found');
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`upstream_${res.status}:${txt.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Create a fresh thread on qlaud. Returns the canonical id qcode
 *  uses for every subsequent message + tool-result POST on this
 *  conversation. */
export async function createRemoteThread(opts?: {
  metadata?: Record<string, unknown>;
}): Promise<RemoteThread> {
  return api<RemoteThread>('/v1/threads', {
    method: 'POST',
    body: JSON.stringify({ metadata: opts?.metadata ?? null }),
  });
}

/** Newest-first list of the caller's threads. Up to `limit` rows. */
export async function listRemoteThreads(
  limit = 50,
  signal?: AbortSignal,
): Promise<RemoteThread[]> {
  const data = await api<{ data: RemoteThread[] }>(
    `/v1/threads?limit=${limit}`,
    { signal },
  );
  return data.data;
}

/** Soft-delete a thread on qlaud. Idempotent — already-deleted rows
 *  return 404 which we map to a no-throw resolution so the sidebar
 *  can prune optimistically without retry loops. */
export async function deleteRemoteThread(id: string): Promise<void> {
  try {
    await api<unknown>(`/v1/threads/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  } catch (e) {
    if (e instanceof Error && e.message === 'not_found') return;
    throw e;
  }
}

/** Load full conversation history for a thread, oldest-first.
 *  Returns Anthropic-shape Messages so ChatSurface can render with
 *  the same renderer it uses for live turns. */
export async function getRemoteThreadMessages(
  id: string,
  signal?: AbortSignal,
): Promise<Message[]> {
  const data = await api<{ data: RemoteThreadMessage[] }>(
    `/v1/threads/${encodeURIComponent(id)}/messages?limit=200&order=asc`,
    { signal },
  );
  return data.data.map((m) => ({
    role: m.role,
    content: normalizeContent(m.content),
  }));
}

function normalizeContent(c: ContentBlock[] | string): ContentBlock[] {
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return c;
}

// ─── Sidebar summary cache (localStorage) ───────────────────────────

export function loadCachedSummaries(): ThreadSummary[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(SUMMARY_INDEX_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as ThreadSummary[]) : [];
  } catch {
    return [];
  }
}

export function saveCachedSummaries(rows: ThreadSummary[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(SUMMARY_INDEX_KEY, JSON.stringify(rows));
}

/** Update one summary in the local cache. Used after the user sends
 *  a turn (refreshes updatedAt + may set the auto-derived title). */
export function patchCachedSummary(
  id: string,
  patch: Partial<ThreadSummary>,
): ThreadSummary[] {
  const all = loadCachedSummaries();
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) return all;
  const next = { ...all[idx]!, ...patch };
  const out = [next, ...all.filter((s) => s.id !== id)];
  saveCachedSummaries(out);
  return out;
}

/** Insert/refresh a summary at the top of the cache. Used when a
 *  remote thread is created or first observed locally. */
export function upsertCachedSummary(s: ThreadSummary): ThreadSummary[] {
  const all = loadCachedSummaries().filter((x) => x.id !== s.id);
  const out = [s, ...all];
  saveCachedSummaries(out);
  return out;
}

export function removeCachedSummary(id: string): ThreadSummary[] {
  const out = loadCachedSummaries().filter((s) => s.id !== id);
  saveCachedSummaries(out);
  return out;
}

/** Wipe local cache — does NOT delete remote threads. Use when
 *  signing out / clearing local state. */
export function clearCachedSummaries(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(SUMMARY_INDEX_KEY);
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Best-effort derivation of a thread title from its history. We
 *  use the first non-empty user-text line, truncated. Called when
 *  qcode wants to update the local summary after a turn lands. */
export function deriveTitle(history: Message[]): string | null {
  for (const msg of history) {
    if (msg.role !== 'user') continue;
    for (const block of msg.content) {
      if (block.type !== 'text') continue;
      const text = block.text.trim().split('\n')[0] ?? '';
      if (!text) continue;
      return text.length > TITLE_MAX
        ? text.slice(0, TITLE_MAX - 1).trim() + '…'
        : text;
    }
  }
  return null;
}

/** Same idea as deriveTitle but pulls the seed straight from a
 *  user-typed prompt before any history exists. */
export function titleFromPrompt(prompt: string): string {
  const first = prompt.trim().split('\n')[0] ?? '';
  if (!first) return 'New chat';
  return first.length > TITLE_MAX
    ? first.slice(0, TITLE_MAX - 1).trim() + '…'
    : first;
}
