// Conversation persistence. One row per thread, persisted to
// localStorage today; we'll move to Tauri's app-data directory once
// we want cross-device sync via qlaud's threads API. The shape here
// matches what qlaud's /v1/threads endpoint emits, so the eventual
// switch is a renamed import + a different storage adapter.
//
// Storage layout:
//   qcode.threads          — index { ids: string[] }
//   qcode.thread.<uuid>    — full Thread object
//
// Rationale for one-key-per-thread instead of one big blob: writes
// stay O(1) per turn even when the user has hundreds of threads,
// and a corrupted single thread doesn't take down the whole list.

import { getKey } from './auth';
import type { ContentBlock, Message } from './qlaud-client';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ??
  'https://api.qlaud.ai';

export type Thread = {
  id: string;
  /** Auto-derived from the first user message; user-editable later. */
  title: string;
  /** Model slug at the moment of the latest turn. */
  model: string;
  /** Full message history in Anthropic shape. */
  history: Message[];
  createdAt: number;
  updatedAt: number;
};

export type ThreadSummary = Pick<
  Thread,
  'id' | 'title' | 'model' | 'createdAt' | 'updatedAt'
>;

const INDEX_KEY = 'qcode.threads';
const THREAD_KEY = (id: string) => `qcode.thread.${id}`;
const TITLE_MAX = 60;

type Index = { ids: string[] };

function readIndex(): Index {
  if (typeof localStorage === 'undefined') return { ids: [] };
  const raw = localStorage.getItem(INDEX_KEY);
  if (!raw) return { ids: [] };
  try {
    const v = JSON.parse(raw) as Index;
    return Array.isArray(v.ids) ? v : { ids: [] };
  } catch {
    return { ids: [] };
  }
}

function writeIndex(idx: Index): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
}

/** All threads, newest-first by updatedAt. Cheap — only reads the
 *  per-thread blobs to surface their summary fields. */
export function listThreads(): ThreadSummary[] {
  const idx = readIndex();
  const out: ThreadSummary[] = [];
  for (const id of idx.ids) {
    const t = getThread(id);
    if (!t) continue;
    out.push({
      id: t.id,
      title: t.title,
      model: t.model,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function getThread(id: string): Thread | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(THREAD_KEY(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Thread;
  } catch {
    return null;
  }
}

/** Create a new empty thread and prepend it to the index. */
export function createThread(model: string): Thread {
  const now = Date.now();
  const t: Thread = {
    id: uuid(),
    title: 'New chat',
    model,
    history: [],
    createdAt: now,
    updatedAt: now,
  };
  saveThread(t);
  return t;
}

/** Persist updated thread state. Updates updatedAt automatically.
 *  Auto-derives the title from the first user message if it's still
 *  the placeholder. */
export function saveThread(t: Thread): Thread {
  const next: Thread = {
    ...t,
    updatedAt: Date.now(),
    title:
      t.title === 'New chat' && t.history.length > 0
        ? deriveTitle(t.history) || t.title
        : t.title,
  };
  localStorage.setItem(THREAD_KEY(next.id), JSON.stringify(next));
  // Move (or insert) to the front of the index.
  const idx = readIndex();
  const ids = [next.id, ...idx.ids.filter((x) => x !== next.id)];
  writeIndex({ ids });
  return next;
}

export function deleteThread(id: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(THREAD_KEY(id));
  const idx = readIndex();
  writeIndex({ ids: idx.ids.filter((x) => x !== id) });
}

/** Drop everything. Wired to the Settings → "Clear chat history"
 *  action when that lands. */
export function clearAllThreads(): void {
  const idx = readIndex();
  for (const id of idx.ids) localStorage.removeItem(THREAD_KEY(id));
  writeIndex({ ids: [] });
}

// ─── Helpers ────────────────────────────────────────────────────────

function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for the rare environment without crypto.randomUUID.
  return 't_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function deriveTitle(history: Message[]): string | null {
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

// ─── Remote thread API ─────────────────────────────────────────────
//
// Server-side thread storage at /v1/threads. qlaud owns the canonical
// history; localStorage now only caches the summary list for the
// sidebar (id, title, model, timestamps) so it can render before the
// network round-trip lands. The remote always wins on conflict.

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
 *  will use for every subsequent message + tool-result POST on this
 *  conversation. Optional metadata stays on the qlaud row — surfaced
 *  back via getRemoteThread / listRemoteThreads. */
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
  limit = 20,
  signal?: AbortSignal,
): Promise<RemoteThread[]> {
  const data = await api<{ data: RemoteThread[] }>(
    `/v1/threads?limit=${limit}`,
    { signal },
  );
  return data.data;
}

/** Soft-delete a thread on qlaud. Idempotent — already-deleted
 *  rows return 404 which we map to a no-throw resolution so the
 *  sidebar can prune optimistically without retry loops. */
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

/** Load the conversation history for a thread, oldest-first. Returns
 *  Anthropic-shape Messages so ChatSurface can re-render with the
 *  same renderer it uses for live turns. Tool-result blocks pair
 *  back with their tool_use blocks via tool_use_id (the model loop
 *  already enforced that ordering). */
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
//
// qcode wants instant "list my threads" even before the network round-
// trip lands, especially on cold app start. We cache the summary
// fields locally and reconcile in the background. The remote `id`
// is authoritative — we never invent ids on the client now that
// qlaud generates them on POST /v1/threads.

const SUMMARY_INDEX_KEY = 'qcode.threads.summaries.v2';

export type RemoteThreadSummary = {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
};

export function loadCachedSummaries(): RemoteThreadSummary[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(SUMMARY_INDEX_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as RemoteThreadSummary[]) : [];
  } catch {
    return [];
  }
}

export function saveCachedSummaries(rows: RemoteThreadSummary[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(SUMMARY_INDEX_KEY, JSON.stringify(rows));
}

/** Update one summary in the local cache. Used after the user sends
 *  a turn (updates updatedAt + maybe the auto-derived title). */
export function patchCachedSummary(
  id: string,
  patch: Partial<RemoteThreadSummary>,
): RemoteThreadSummary[] {
  const all = loadCachedSummaries();
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) return all;
  const next = { ...all[idx]!, ...patch };
  const out = [next, ...all.filter((s) => s.id !== id)];
  saveCachedSummaries(out);
  return out;
}

/** Used when a remote thread is created or first observed locally —
 *  prepends to the cache so the sidebar shows it immediately. */
export function upsertCachedSummary(s: RemoteThreadSummary): RemoteThreadSummary[] {
  const all = loadCachedSummaries().filter((x) => x.id !== s.id);
  const out = [s, ...all];
  saveCachedSummaries(out);
  return out;
}

export function removeCachedSummary(id: string): RemoteThreadSummary[] {
  const out = loadCachedSummaries().filter((s) => s.id !== id);
  saveCachedSummaries(out);
  return out;
}

/** Re-export deriveTitle for callers that need to seed a summary
 *  from the user's first message. */
export { deriveTitle };
