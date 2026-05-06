// Track threads where the user kicked off a send + then navigated
// away. qlaud's edge worker keeps the upstream call alive via
// waitUntil + persists the assistant turn server-side; we just
// have to refetch until we see it.
//
// Detection is purely seq-based — qlaud already stamps every
// message with a monotonic seq, so we just remember the highest
// seq the thread had at send-start and watch for one greater.
// No client-side counters, no synthetic indices.
//
// Reactivity: subscribers fire on mark/clear so the sidebar can
// render a "running" indicator on threads working in the
// background. The useInFlightThreads() hook plugs into
// useSyncExternalStore so components re-render when ANY thread's
// in-flight state flips, no polling needed.

import { useSyncExternalStore } from 'react';

const IN_FLIGHT = new Map<
  string,
  {
    startedAt: number;
    /** Highest seq the thread had at send-start. The new assistant
     *  turn will land at seq > this. */
    seqFloor: number;
  }
>();

const TIMEOUT_MS = 2 * 60_000;

const subscribers = new Set<() => void>();
let cachedSnapshot: Set<string> | null = null;

function notify(): void {
  // Invalidate first so subscribers reading getSnapshot during
  // their callback get the post-mutation set.
  cachedSnapshot = null;
  // Snapshot the subscriber list — callbacks subscribing or
  // unsubscribing during a notify pass would otherwise mutate the
  // live set we're iterating.
  for (const cb of [...subscribers]) cb();
}

export function markInFlight(threadId: string, seqFloor: number): void {
  IN_FLIGHT.set(threadId, { startedAt: Date.now(), seqFloor });
  notify();
}

export function clearInFlight(threadId: string): void {
  if (!IN_FLIGHT.delete(threadId)) return;
  notify();
}

export function isInFlight(threadId: string): boolean {
  const entry = IN_FLIGHT.get(threadId);
  if (!entry) return false;
  if (Date.now() - entry.startedAt > TIMEOUT_MS) {
    IN_FLIGHT.delete(threadId);
    // Lazy timeout sweep — notify so the sidebar drops the
    // indicator. Microtask-deferred to avoid notifying inside a
    // call that's still computing its own answer.
    queueMicrotask(notify);
    return false;
  }
  return true;
}

/** Has a new assistant turn landed past the seq floor we recorded
 *  at send-start? Used by the polling loop to decide when to stop. */
export function hasLanded(
  threadId: string,
  messages: Array<{ role: string; seq?: number }>,
): boolean {
  const entry = IN_FLIGHT.get(threadId);
  if (!entry) return true;
  return messages.some(
    (m) => m.role === 'assistant' && (m.seq ?? 0) > entry.seqFloor,
  );
}

/** Stable Set snapshot for useSyncExternalStore. Re-built only
 *  when notify() invalidates — React's identity check on the
 *  return value catches that and re-renders. */
function getInFlightSnapshot(): Set<string> {
  if (!cachedSnapshot) {
    cachedSnapshot = new Set(IN_FLIGHT.keys());
  }
  return cachedSnapshot;
}

function subscribeInFlight(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** React hook: returns a Set<threadId> of every currently in-flight
 *  thread, re-rendering the consumer whenever the set changes.
 *  Cheap — subscribers are invoked synchronously on mark/clear, no
 *  polling. The returned Set's identity is stable until the next
 *  mutation, so consumers can use it directly in useMemo deps. */
export function useInFlightThreads(): Set<string> {
  return useSyncExternalStore(
    subscribeInFlight,
    getInFlightSnapshot,
    getInFlightSnapshot,
  );
}
