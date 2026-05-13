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
  /** Stable id of the workspace registry entry the thread belongs
   *  to. The canonical link as of the workspace/chat split — the
   *  registry owns name + current path, so threads survive folder
   *  renames/moves without restranding. Per-device (ids are
   *  generated on the client that registered the workspace), so a
   *  thread fetched on a different device falls back to
   *  workspacePath matching. */
  workspaceId?: string;
  /** Workspace path the thread was scoped to at creation time.
   *  Pre-split this was the sole link; post-split it's a fallback
   *  for legacy threads / cross-device resolution. The sidebar
   *  groups by `workspaceId || workspacePath` so both eras coexist. */
  workspacePath?: string;
  /** Last segment of the workspace path, cached for sidebar display
   *  so we don't re-derive it on every render. */
  workspaceName?: string;
  /** GitLab project path (e.g. `qcode-users/jane-myapp-ab12`) of
   *  the sandbox repo backing this thread's workspace. Server stamps
   *  it into metadata as `gitlab_project_path` at end-of-turn push;
   *  surfaced here so the header workspace badge can render its
   *  "Saved to gitlab.com/<slug>" row immediately on first thread
   *  open, without waiting for the user to fire another turn. Empty
   *  on desktop threads (no GitLab backing) and on web threads that
   *  haven't successfully pushed yet. */
  gitlabProjectPath?: string;
  /** Where the title came from. 'auto' = first-prompt or LLM-
   *  generated; safe to overwrite on every turn. 'user' = the
   *  user manually renamed it; auto-regen leaves it alone. We
   *  default to 'auto' on every code path — the user-edit UI
   *  hasn't shipped yet but the field is here so the contract
   *  is correct from day one. */
  titleSource?: 'auto' | 'user';
  /** Wall-clock ms when the user pinned this thread, or undefined
   *  when not pinned. Pinned threads float above the time-bucketed
   *  groups in the sidebar and never age out into "Earlier". The
   *  user toggles via the row's hover-revealed pin icon or the
   *  ⌘D shortcut. Persisted both locally and in qlaud thread
   *  metadata so it survives reinstalls + cross-device sync. */
  pinnedAt?: number;
};

// ─── Remote API ────────────────────────────────────────────────────

export type RemoteThread = {
  id: string;
  end_user_id: string | null;
  /** Server-side title. Populated post-create by PATCH after the
   *  first user message; null until then (clients render
   *  placeholder). Survives sign-out + cross-device. */
  title: string | null;
  /** Workspace this thread is pinned to. Canonical column post-
   *  migration 0030; previously buried in metadata.workspace_id.
   *  Always populated server-side — POST /v1/threads auto-resolves
   *  to the user's chat workspace when the caller doesn't specify. */
  workspace_id: string | null;
  /** Last-used surface state. 'chat' | 'agent' | 'plan'. Drives the
   *  ChatSurface mode toggle on reopen without per-device
   *  localStorage. */
  default_mode: string | null;
  /** Last-used model slug. Same role as default_mode for the model
   *  picker. */
  default_model: string | null;
  /** Latest claude --resume sid. Populated by the server on every
   *  agent turn; surfaced here for diagnostics + debug surfaces.
   *  Clients rarely need to read this directly. */
  latest_claude_sid: string | null;
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
 *  conversation.
 *
 *  v2 contract (post migration 0030): server resolves a
 *  workspace_id for every thread. Resolution priority:
 *
 *    1. explicit `workspaceId` arg → server validates ownership
 *    2. explicit `kind` arg (currently only 'chat' allowed via
 *       this surface) → server resolves to the user's chat
 *       singleton via ensureUserChatWorkspace
 *    3. neither → server defaults to the user's chat workspace
 *
 *  Pass `defaultMode` to seed the thread's last-used surface
 *  state (chat | agent | plan). When omitted the server defaults
 *  to 'chat' — safe baseline; promotion to agent happens
 *  implicitly on the first agent turn (the server then mints a
 *  sandbox workspace and re-pins the thread). */
export async function createRemoteThread(opts?: {
  workspaceId?: string;
  kind?: 'chat';
  defaultMode?: 'chat' | 'agent' | 'plan';
  defaultModel?: string;
  endUserId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): Promise<RemoteThread> {
  const body: Record<string, unknown> = {};
  if (opts?.workspaceId) body.workspace_id = opts.workspaceId;
  if (opts?.kind) body.kind = opts.kind;
  if (opts?.defaultMode) body.default_mode = opts.defaultMode;
  if (opts?.defaultModel) body.default_model = opts.defaultModel;
  if (opts?.endUserId) body.end_user_id = opts.endUserId;
  if (opts?.title !== undefined) body.title = opts.title;
  if (opts?.metadata !== undefined) body.metadata = opts.metadata;
  return api<RemoteThread>('/v1/threads', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Fetch a single thread row by id. Used by the engine-mode
 *  session-id-append path — we read the current thread metadata,
 *  modify it (append session_id to claude_session_ids), then PATCH
 *  back. Returns the freshly-fetched server row, NOT the cached
 *  ThreadSummary, so we operate on canonical metadata. */
export async function getRemoteThread(id: string): Promise<RemoteThread> {
  return api<RemoteThread>(`/v1/threads/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
}

/** Newest-first list of the caller's threads. Up to `limit` rows.
 *  Default 200 (was 50 — too tight; users with active workflows on
 *  multiple workspaces hit the cap and missed older threads on
 *  cross-device views, esp. on qcode-web). 200 covers the
 *  vast majority of real users; future v1 will paginate when we
 *  have real numbers on the long tail. */
export async function listRemoteThreads(
  limit = 200,
  signal?: AbortSignal,
): Promise<RemoteThread[]> {
  const data = await api<{ data: RemoteThread[] }>(
    `/v1/threads?limit=${limit}`,
    { signal },
  );
  return data.data;
}

/** Shallow-merge fields into a thread's server-side metadata.
 *  Used to persist things like workspace_path / pinned_at so the
 *  sidebar shows the same shape on a second device, after a cache
 *  wipe, on the qcode-web tab — without relying on localStorage
 *  for any of those paths. Fire-and-forget at the callsite: a
 *  failed PATCH leaves the thread's prior metadata intact + the
 *  client cache still has the new value, so the UX is unaffected. */
export async function updateThreadMetadata(
  id: string,
  patch: Record<string, unknown>,
): Promise<RemoteThread> {
  return api<RemoteThread>(`/v1/threads/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ metadata: patch }),
  });
}

/** Set the canonical thread title (server-side `title` column). Use
 *  this for the auto-derived title that fires on first send and for
 *  the LLM-regenerated title that lands a few turns in. Title flows
 *  through the dedicated column (added in migration 0022) so list
 *  responses serialize it as a top-level field — no metadata
 *  unboxing on the read side, and survives sign-out + cross-device.
 *
 *  Pass null to clear (uncommon — clients typically replace, not
 *  delete). Fire-and-forget pattern same as updateThreadMetadata. */
export async function updateThreadTitle(
  id: string,
  title: string | null,
): Promise<RemoteThread> {
  return api<RemoteThread>(`/v1/threads/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
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

/** Server-side bulk cleanup of threads that have zero messages. Called
 *  on app load to wipe orphans created when sends fail mid-flight (e.g.
 *  the CORS gap that caused 16 "New chat" rows to pile up before this
 *  was added). Idempotent + safe to call repeatedly — server returns
 *  `{ deleted: 0 }` when nothing matches. Swallows errors silently;
 *  cleanup is best-effort and shouldn't block app boot. */
export async function purgeEmptyRemoteThreads(): Promise<number> {
  try {
    const r = await api<{ deleted: number }>('/v1/threads/empty', {
      method: 'DELETE',
    });
    return r.deleted ?? 0;
  } catch {
    return 0;
  }
}

/** Auto-compaction status for a thread. Surfaced by /v1/threads/:id
 *  /messages so the UI can render a "↳ N earlier turns summarized"
 *  pill above the visible messages. Null on threads that haven't
 *  crossed the compaction threshold yet. */
export type CompactionInfo = {
  summary: string;
  summarizedThroughSeq: number;
};

/** Bundle of what `/v1/threads/:id/messages` returns: the rehydrated
 *  Anthropic-shape Messages + compaction state for the indicator +
 *  pagination cursors. */
export type RemoteThreadHistory = {
  messages: Message[];
  compaction: CompactionInfo | null;
  /** Sequence number of the oldest message in this page. Pass back
   *  as `before_seq` to fetch the next-older page. Null when this
   *  page already includes seq=1 (no more history above). */
  oldestSeq: number | null;
  /** True when more turns exist before the oldest we just loaded.
   *  UI uses this to render the "Load earlier turns" affordance. */
  hasMore: boolean;
};

const DEFAULT_PAGE_SIZE = 50;

/** Load conversation history for a thread, paginated by sequence.
 *  Default: latest `limit` turns (newest-first server-side, returned
 *  oldest-first client-side so ChatSurface can render top-to-bottom).
 *  Pass `beforeSeq` to fetch the next page of older turns; the
 *  caller threads pages together by prepending. */
export async function getRemoteThreadMessages(
  id: string,
  opts: {
    limit?: number;
    beforeSeq?: number;
    signal?: AbortSignal;
  } = {},
): Promise<RemoteThreadHistory> {
  const limit = opts.limit ?? DEFAULT_PAGE_SIZE;
  const params = new URLSearchParams({
    limit: String(limit),
    // Newest-first from the server so the latest page lands first
    // (chat UI's natural default — "what did we just say?"). We
    // reverse client-side before returning so ChatSurface renders
    // oldest→newest top-to-bottom as expected.
    order: 'desc',
  });
  if (opts.beforeSeq != null) params.set('before_seq', String(opts.beforeSeq));
  const data = await api<{
    data: RemoteThreadMessage[];
    has_more: boolean;
    next_before_seq: number | null;
    compaction: {
      summary: string;
      summarized_through_seq: number;
    } | null;
  }>(
    `/v1/threads/${encodeURIComponent(id)}/messages?${params.toString()}`,
    { signal: opts.signal },
  );
  // Server returned newest-first; reverse so callers always see
  // chronological order. Preserve the server's seq on every
  // message — it's the canonical "where am I in this thread?"
  // signal, used by the in-flight resume detector + future
  // pagination consumers without inventing a parallel counter.
  const messages = [...data.data].reverse().map((m) => ({
    role: m.role,
    content: normalizeContent(m.content),
    seq: m.seq,
  }));
  return {
    messages,
    compaction: data.compaction
      ? {
          summary: data.compaction.summary,
          summarizedThroughSeq: data.compaction.summarized_through_seq,
        }
      : null,
    oldestSeq: data.next_before_seq,
    hasMore: !!data.has_more,
  };
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
