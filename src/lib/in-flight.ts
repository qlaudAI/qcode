// Track threads with in-flight sends so we can "resume" — really,
// poll the canonical history — when the user switches back to one.
//
// Why this exists: when the user sends a long turn and navigates
// away, qlaud's edge worker keeps the upstream call alive via
// waitUntil and persists the assistant turn server-side. There's
// no SSE-resume endpoint to reattach to the live stream, but we
// CAN ask the messages API "do you have it yet?" until it shows
// up. From the user's perspective: switch away during a slow
// turn, come back later, see the finished answer waiting.
//
// We also remember WHEN the send started so we can stop polling
// after a sane timeout (long-tail upstream errors shouldn't pin
// the indicator forever). The seq of the user's prompt at send-
// time is the "have we landed past this yet?" sentinel — once
// the messages list contains an assistant turn with seq >
// userTurnSeq, the work is done and we stop polling.

const IN_FLIGHT = new Map<
  string,
  {
    startedAt: number;
    /** Seq of the user message that kicked off this turn. The
     *  assistant's response will land at seq+1 (or higher if the
     *  agent looped through tools). null when we don't know it
     *  yet (turn is still being created). */
    userTurnSeq: number | null;
  }
>();

/** Mark a thread as having an in-flight send. Called when send()
 *  starts; the userTurnSeq is filled in when the message ack lands
 *  (we don't know the seq until the server responds). */
export function markInFlight(threadId: string): void {
  IN_FLIGHT.set(threadId, {
    startedAt: Date.now(),
    userTurnSeq: null,
  });
}

/** Update the seq of the user prompt for an in-flight thread. The
 *  server returns this on the streaming response's headers
 *  (x-qlaud-assistant-seq) — once we have it, polling can detect
 *  when a higher-seq assistant turn has been persisted. */
export function setUserTurnSeq(threadId: string, seq: number): void {
  const entry = IN_FLIGHT.get(threadId);
  if (entry) entry.userTurnSeq = seq;
}

/** Drop a thread from the in-flight set — call on send-success
 *  (we already have the assistant turn; no need to poll) AND on
 *  poll-success (we detected the assistant turn landed). */
export function clearInFlight(threadId: string): void {
  IN_FLIGHT.delete(threadId);
}

/** Is this thread currently in-flight (within the 2-minute
 *  polling window)? Threads older than that are auto-cleared so
 *  we don't poll forever on a stuck upstream. */
export function isInFlight(threadId: string): boolean {
  const entry = IN_FLIGHT.get(threadId);
  if (!entry) return false;
  if (Date.now() - entry.startedAt > 2 * 60_000) {
    IN_FLIGHT.delete(threadId);
    return false;
  }
  return true;
}

/** Check whether the messages array now contains an assistant turn
 *  AFTER the user's prompt — i.e. the in-flight work has finished
 *  + been persisted. Used by the polling loop to decide when to
 *  stop. Returns true when we should stop polling. */
export function hasLanded(
  threadId: string,
  latestMessages: Array<{ role: string; seq?: number }>,
): boolean {
  const entry = IN_FLIGHT.get(threadId);
  if (!entry) return true; // not tracked — nothing to wait for
  const userSeq = entry.userTurnSeq;
  if (userSeq == null) {
    // We never learned the user-turn seq (header missed, very fast
    // turn). Fall back to "any assistant message present" — works
    // for fresh threads where there shouldn't be assistant turns
    // pre-send.
    return latestMessages.some((m) => m.role === 'assistant');
  }
  return latestMessages.some(
    (m) => m.role === 'assistant' && (m.seq ?? 0) > userSeq,
  );
}
