// Per-thread run state — the "what's happening on this thread RIGHT
// NOW" store, decoupled from any particular ChatSurface instance.
//
// Why this exists: blocks + busy used to be ChatSurface-local
// useState. That meant when the user switched threads, the
// component re-rendered with the new thread's data, and the
// off-screen run had nowhere to write its events — they got
// dropped by the run-id guard. The user came back to a half-empty
// thread that polling slowly filled in from server-persisted
// canonical history (final assistant message only, no tool cards
// or partial text).
//
// Now: each thread has its own slot here. send() captures the
// thread it was started on and writes to THAT slot for the entire
// turn, no matter which thread the user is currently looking at.
// ChatSurface subscribes to whichever thread is visible via
// useThreadRunState — when the user switches, the subscription
// rewires; the writer doesn't notice or care.
//
// What this enables:
//   1. Live SSE re-attach. User leaves thread A mid-stream, comes
//      back later — the events that arrived while away are
//      already in A's slot, and any future events flow in live.
//   2. Sidebar running indicators (handed off to in-flight.ts
//      separately, which still tracks "this thread's last send
//      hasn't returned yet" semantics).
//   3. Per-thread stop()  — the runId is also per-thread, so
//      stopping thread A doesn't disturb thread B's parallel run.
//
// What this does NOT enable (yet — Phase 2):
//   - Multiple concurrent sends from the SAME thread. The runId
//     model is still "one active run per thread" — re-sending
//     while busy queues the message instead of forking. Concurrent
//     sends in one thread is a Phase 2 design problem.

import { useSyncExternalStore } from 'react';

/** Generic block type — kept open here to avoid a circular import
 *  with ChatSurface's RenderBlock union. The store treats blocks
 *  as opaque arrays; the UI does the actual reduce/render. */
export type Block = unknown;

export type ThreadRunState = {
  blocks: Block[];
  /** Number of currently-active sends on this thread. Phase 1
   *  guaranteed at most 1; Phase 2 (alpha.157) lets the user fire
   *  parallel sends via Cmd+Enter, so this becomes a counter.
   *  Composer shows "busy" when > 0 — same visual signal, but the
   *  underlying state allows multiple concurrent runs. */
  busyCount: number;
  /** Pending send-while-busy message. Lives here (vs ChatSurface
   *  local state) so that switching threads while one has a queued
   *  send doesn't drop the queue. */
  queued: string | null;
  /** Stop generation. Bumped ONLY by explicit stop() (the user
   *  pressing the Stop button on this thread). Each running send
   *  captures the value at start; events check against the
   *  current value before mutating, bail if mismatched.
   *
   *  Critically NOT bumped on a follow-up send to the same thread
   *  — that's what enables parallel runs to coexist (each run
   *  shares the same stopGen until the user explicitly stops them
   *  all). */
  stopGen: number;
};

const FALLBACK: ThreadRunState = Object.freeze({
  blocks: [],
  busyCount: 0,
  queued: null,
  stopGen: 0,
});

const STATES = new Map<string, ThreadRunState>();
const SUBS = new Map<string, Set<() => void>>();

function getOrCreate(threadId: string): ThreadRunState {
  let s = STATES.get(threadId);
  if (!s) {
    s = { blocks: [], busyCount: 0, queued: null, stopGen: 0 };
    STATES.set(threadId, s);
  }
  return s;
}

function notify(threadId: string): void {
  const subs = SUBS.get(threadId);
  if (!subs || subs.size === 0) return;
  // Snapshot before iterating — subscribers calling subscribe /
  // unsubscribe inside their callback would mutate the live set.
  for (const cb of [...subs]) cb();
}

/** Replace the run state for a thread with the result of `updater`.
 *  Always emits a new object so React's identity check re-renders
 *  any subscribed components. */
export function updateRunState(
  threadId: string,
  updater: (s: ThreadRunState) => ThreadRunState,
): void {
  if (!threadId) return;
  const next = updater(getOrCreate(threadId));
  STATES.set(threadId, next);
  notify(threadId);
}

/** Convenience: update just the blocks for a thread. */
export function updateBlocks(
  threadId: string,
  updater: (b: Block[]) => Block[],
): void {
  updateRunState(threadId, (s) => ({ ...s, blocks: updater(s.blocks) }));
}

/** Increment the active-send counter. Each send() calls this at
 *  start; the matching decBusy fires in the finally block. UI
 *  treats busyCount > 0 as "this thread has work running." */
export function incBusy(threadId: string): void {
  updateRunState(threadId, (s) => ({ ...s, busyCount: s.busyCount + 1 }));
}

/** Decrement the active-send counter. Floored at 0 — a desync
 *  shouldn't underflow into "negative busy" which would render
 *  weird states. */
export function decBusy(threadId: string): void {
  updateRunState(threadId, (s) => ({
    ...s,
    busyCount: Math.max(0, s.busyCount - 1),
  }));
}

/** Convenience: set queued message for a thread. */
export function setQueued(threadId: string, queued: string | null): void {
  updateRunState(threadId, (s) => ({ ...s, queued }));
}

/** Bump the stop-generation counter. Called by stop() ONLY — every
 *  active send on this thread captures the pre-bump value and bails
 *  on the next event when the captured value no longer matches.
 *  Effectively "kill all active runs on this thread."
 *
 *  Returns the new stopGen so callers can cross-check during their
 *  own cleanup (for instance, the in-flight registry decision in
 *  send()'s finally block). */
export function bumpStopGen(threadId: string): number {
  if (!threadId) return 0;
  const s = getOrCreate(threadId);
  const next = s.stopGen + 1;
  STATES.set(threadId, { ...s, stopGen: next });
  notify(threadId);
  return next;
}

/** Read the current run state for a thread without subscribing.
 *  Use inside event handlers / send() loops where you need the
 *  latest runId for the stale-check. */
export function readRunState(threadId: string | null): ThreadRunState {
  if (!threadId) return FALLBACK;
  return STATES.get(threadId) ?? FALLBACK;
}

/** Drop a thread's run state entirely. Called when the conversation
 *  is deleted or the user explicitly resets — no point keeping
 *  stale state for a thread that doesn't exist. */
export function clearRunState(threadId: string): void {
  if (!threadId) return;
  if (!STATES.has(threadId)) return;
  STATES.delete(threadId);
  notify(threadId);
}

/** React hook: subscribe to a thread's run state. Re-renders the
 *  consumer whenever any field on that thread's state changes.
 *  Switching `threadId` arg rewires the subscription seamlessly —
 *  prior thread's writes keep happening but no longer trigger
 *  re-renders here. */
export function useThreadRunState(
  threadId: string | null,
): ThreadRunState {
  return useSyncExternalStore(
    (cb) => {
      if (!threadId) return () => {};
      let subs = SUBS.get(threadId);
      if (!subs) {
        subs = new Set();
        SUBS.set(threadId, subs);
      }
      subs.add(cb);
      return () => {
        subs!.delete(cb);
      };
    },
    () => (threadId ? STATES.get(threadId) ?? FALLBACK : FALLBACK),
    () => (threadId ? STATES.get(threadId) ?? FALLBACK : FALLBACK),
  );
}
