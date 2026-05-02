// Track threads where the user kicked off a send + then navigated
// away. qlaud's edge worker keeps the upstream call alive via
// waitUntil + persists the assistant turn server-side; we just
// have to refetch until we see it.
//
// Detection is purely seq-based — qlaud already stamps every
// message with a monotonic seq, so we just remember the highest
// seq the thread had at send-start and watch for one greater.
// No client-side counters, no synthetic indices.

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

export function markInFlight(threadId: string, seqFloor: number): void {
  IN_FLIGHT.set(threadId, { startedAt: Date.now(), seqFloor });
}

export function clearInFlight(threadId: string): void {
  IN_FLIGHT.delete(threadId);
}

export function isInFlight(threadId: string): boolean {
  const entry = IN_FLIGHT.get(threadId);
  if (!entry) return false;
  if (Date.now() - entry.startedAt > TIMEOUT_MS) {
    IN_FLIGHT.delete(threadId);
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
