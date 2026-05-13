// useThreadEvents — long-lived SSE subscription to GET /v1/threads/:id/events
//
// Cross-device live sync. When the user is viewing a thread in this
// tab and a write lands from another device (or even from the
// server-side agent loop in this same thread), the relevant
// react-query caches update within ~2s with no manual refetch.
//
// Why a custom fetch+ReadableStream parser instead of EventSource:
// the qlaud auth middleware reads the bearer from request headers
// (x-api-key / Authorization), and the browser EventSource API can't
// set custom headers. Passing the key as a query-string would expose
// it in proxy logs + browser history. fetch + ReadableStream gives
// us header-based auth with a 50-line SSE frame parser.
//
// Wire contract: documented in
//   apps/edge/src/routes/thread-events.ts
// (qlaud_router).
//
// Reconnection: server closes the stream after ~4min; we re-open
// immediately with the last numeric message seq in the
// `Last-Event-ID` header. Thread + workspace snapshots are always
// re-sent on connect so dropped frames self-heal.

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { getKey } from './auth';
import { qk } from './queries';
import type { ThreadSummary } from './threads';
import type { RemoteWorkspace } from './workspace-sync';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ??
  'https://api.qlaud.ai';

/** Parsed SSE frame. event=null when the server sent no `event:`
 *  field (defaults to 'message' per the spec); we surface it as null
 *  so the dispatch switch can decide. */
type SseFrame = { event: string | null; id: string | null; data: string };

/** Strict line-by-line SSE parser. Handles the three fields qlaud
 *  emits (event, id, data), ignores everything else. Yields complete
 *  frames as they finish (blank-line terminator). The caller owns
 *  the buffer between calls; we append, scan for terminators, slice. */
function* parseSse(buffer: string): Generator<SseFrame, string> {
  // Frames are separated by a blank line. \r\n and \n both legal per spec.
  let current: SseFrame = { event: null, id: null, data: '' };
  let consumed = 0;
  let i = 0;
  while (i < buffer.length) {
    // Find end-of-line.
    let lineEnd = buffer.indexOf('\n', i);
    if (lineEnd === -1) break; // partial line — wait for more bytes
    let line = buffer.slice(i, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    i = lineEnd + 1;

    if (line === '') {
      // Frame terminator. Emit if there's anything to emit (don't
      // emit empty data-only frames).
      if (current.data !== '' || current.event !== null) {
        yield current;
        consumed = i;
      }
      current = { event: null, id: null, data: '' };
      continue;
    }
    if (line.startsWith(':')) continue; // comment line
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        current.event = value;
        break;
      case 'id':
        current.id = value;
        break;
      case 'data':
        // Multi-line data values are concatenated with \n per spec.
        current.data = current.data === '' ? value : current.data + '\n' + value;
        break;
      default:
        /* ignore unknown fields */
        break;
    }
  }
  return buffer.slice(consumed);
}

/** Subscribe to a thread's live event stream. Idempotent on mount
 *  (one open connection per thread per hook instance); cleans up
 *  on unmount or threadId change.
 *
 *  Wires server events into react-query caches:
 *    event:message    → invalidate qk.threadMessages(threadId)
 *    event:thread     → patch qk.threads row + qk.workspaces if
 *                       workspace_id changed
 *    event:workspace  → patch qk.workspaces row (or insert if new)
 *    event:deleted    → remove from qk.threads
 *    event:reconnect  → re-open with Last-Event-ID (transparent)
 *
 *  The hook is fire-and-forget — components don't read its return
 *  value, they read from the react-query caches it updates. */
export function useThreadEvents(threadId: string | null): void {
  const qc = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!threadId) return;
    const key = getKey();
    if (!key) return;

    let cancelled = false;
    let lastEventId = '0';

    const connect = async (): Promise<void> => {
      while (!cancelled) {
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const res = await fetch(
            `${BASE}/v1/threads/${encodeURIComponent(threadId)}/events`,
            {
              method: 'GET',
              headers: {
                'x-api-key': key,
                accept: 'text/event-stream',
                'last-event-id': lastEventId,
              },
              signal: controller.signal,
              cache: 'no-store',
            },
          );
          if (!res.ok || !res.body) {
            // Auth failure / server 5xx / no body — bail to the
            // back-off loop. Don't tight-loop on persistent failures.
            await backoff(2_000);
            continue;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let shouldReconnect = false;

          // Read until the server closes (lifetime cap or error).
          while (!cancelled) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // Drain whatever complete frames are in the buffer.
            // parseSse yields frames + returns the unparsed remainder.
            const iter = parseSse(buffer);
            let next = iter.next();
            while (!next.done) {
              const frame = next.value;
              if (frame.id) lastEventId = frame.id;
              handleFrame(frame, qc, threadId);
              if (frame.event === 'reconnect') {
                // Server told us to reconnect. Stop reading; outer
                // loop will reconnect with Last-Event-ID.
                shouldReconnect = true;
                try {
                  await reader.cancel();
                } catch {
                  /* already closed */
                }
                break;
              }
              if (frame.event === 'deleted') {
                // Thread was hard-deleted server-side. Stop
                // subscribing; the App.tsx delete-thread flow
                // already handles UI dismissal.
                cancelled = true;
                break;
              }
              next = iter.next();
            }
            buffer = (next.done ? next.value : buffer) as string;
            if (shouldReconnect || cancelled) break;
          }

          if (cancelled) break;
          // Stream closed without a reconnect frame (network blip or
          // CF retired the connection). Back off briefly then retry.
          if (!shouldReconnect) await backoff(1_500);
        } catch (e) {
          if (cancelled) break;
          // Abort errors are expected on cleanup; everything else
          // gets a brief backoff to avoid hot-loop on persistent
          // network failure.
          if ((e as Error)?.name === 'AbortError') break;
          await backoff(2_000);
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      abortRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
}

/** Sleep + cancellable backoff. setTimeout is fine — the outer loop
 *  checks `cancelled` after this resolves. */
function backoff(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Apply one server frame to the react-query caches. Pure function
 *  over the cache; no network. */
function handleFrame(
  frame: SseFrame,
  qc: ReturnType<typeof useQueryClient>,
  threadId: string,
): void {
  if (!frame.data) return;
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    return; // malformed frame — ignore
  }
  const event = frame.event ?? 'message';
  switch (event) {
    case 'message': {
      // New message landed on this thread. The cheapest correct
      // path is to invalidate the messages query — the user-visible
      // chat surface either has it open (refetch is a tight loop)
      // or doesn't (refetch is a no-op until the next mount).
      void qc.invalidateQueries({ queryKey: qk.threadMessages(threadId) });
      break;
    }
    case 'thread': {
      // Patch the thread row in qk.threads. Server-canonical fields
      // (workspace_id, default_mode, latest_claude_sid, last_active_at)
      // get folded into the cached ThreadSummary so the sidebar +
      // mode toggle reflect cross-device changes within one tick.
      const t = payload as {
        id: string;
        workspace_id: string | null;
        title: string | null;
        default_mode: string | null;
        default_model: string | null;
        latest_claude_sid: string | null;
        last_active_at: number;
      };
      const prev = qc.getQueryData<ThreadSummary[]>(qk.threads) ?? [];
      const idx = prev.findIndex((s) => s.id === t.id);
      if (idx === -1) return;
      const next = [...prev];
      next[idx] = {
        ...prev[idx]!,
        // Title flows through only when the server has one — never
        // clobber a local-seeded title with null.
        ...(t.title ? { title: t.title } : {}),
        ...(t.workspace_id ? { workspaceId: t.workspace_id } : {}),
        updatedAt: t.last_active_at,
      };
      qc.setQueryData<ThreadSummary[]>(qk.threads, next);
      break;
    }
    case 'workspace': {
      // Workspace metadata changed (rename, gitlab path populated,
      // last_used bump). Fold into qk.workspaces.
      const w = payload as RemoteWorkspace;
      const prev = qc.getQueryData<RemoteWorkspace[]>(qk.workspaces) ?? [];
      const idx = prev.findIndex((x) => x.id === w.id);
      const next = idx === -1 ? [w, ...prev] : [...prev];
      if (idx !== -1) next[idx] = { ...prev[idx]!, ...w };
      qc.setQueryData<RemoteWorkspace[]>(qk.workspaces, next);
      break;
    }
    case 'keepalive':
    case 'reconnect':
    case 'deleted':
    case 'error':
      // Connection-management frames — handled in the outer loop.
      break;
    default:
      /* unknown event type — ignore (forward-compat) */
      break;
  }
}
