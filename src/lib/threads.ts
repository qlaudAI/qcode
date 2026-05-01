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

import type { Message } from './qlaud-client';

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
