// Per-thread snapshot of ChatSurface's `blocks` state.
//
// Why this exists: ChatSurface holds blocks as useState, scoped to
// the active thread. When the user switches threads while a turn
// is mid-stream, the old thread's blocks state is dropped from the
// component (the prop change re-renders against the new thread)
// and re-populating from server history loses every tool card,
// approval card, usage pill, and live text fragment that was
// rendered LIVE — server only persists the final assistant
// message, not the play-by-play.
//
// Fix: snapshot on switch-AWAY, hydrate on switch-BACK. The user's
// in-flight turn keeps running server-side via waitUntil; when
// they come back they see exactly where they left off (with the
// live progress preserved) rather than a stripped-down "just the
// user message" view that fills in slowly via polling.
//
// Generic over RenderBlock — ChatSurface keeps the type definition
// (it's huge, with a dozen variants) and we just store an array
// of unknowns at the API boundary. The caller does the cast.
//
// Lifetime: snapshots live for the JS heap. They're cleared on
// explicit clear(), or implicitly when the user closes/reloads
// qcode. Memory pressure is bounded — each snapshot is small
// (tens of objects per turn × maybe 5-10 active threads tops).

const SNAPSHOTS = new Map<string, unknown[]>();

/** Save the current blocks for a thread. Replaces any prior
 *  snapshot for the same thread id. */
export function saveBlocksSnapshot(threadId: string, blocks: unknown[]): void {
  if (!threadId) return;
  // Shallow clone so later mutations to the original array (very
  // unlikely in React but defensive) don't bleed into the cache.
  SNAPSHOTS.set(threadId, [...blocks]);
}

/** Hydrate blocks for a thread, returns null when no snapshot exists. */
export function loadBlocksSnapshot(threadId: string): unknown[] | null {
  if (!threadId) return null;
  return SNAPSHOTS.get(threadId) ?? null;
}

/** Drop a thread's snapshot. Called when a turn fully lands and
 *  the canonical server history is authoritative again — there's
 *  no value in keeping the stale snapshot around once the live
 *  state has been superseded. */
export function clearBlocksSnapshot(threadId: string): void {
  SNAPSHOTS.delete(threadId);
}

/** True if a snapshot exists for the given thread. Cheap (Map.has). */
export function hasBlocksSnapshot(threadId: string): boolean {
  return SNAPSHOTS.has(threadId);
}
