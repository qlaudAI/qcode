// Module-level "the workspace was modified" signal.
//
// Why this exists: Media, Files, and Diff tabs each scan the
// workspace fs on mount. When the agent then runs tools that
// modify the fs (write_file / bash that creates artifacts /
// renders / copies / etc.), those tabs stay frozen showing the
// pre-agent state. User opens Media tab while agent is mid-render,
// sees "No media yet" — even after the agent finishes ten minutes
// later — because nothing in the tab's React deps changed.
//
// Fix: a monotonic counter that bumps every time the agent does
// something that COULD have changed the workspace. Each tab
// subscribes via useWorkspaceRevision() and re-runs its scan when
// the value ticks. ChatSurface wires the bump into tool_done
// events for fs-modifying tools (bash, write_file, edit_file).
//
// Cheaper than fs polling, more responsive than manual rescan.
// Works across thread switches because the counter is global —
// any thread's agent activity refreshes whichever tab is open.

import { useSyncExternalStore } from 'react';

let revision = 0;
const subscribers = new Set<() => void>();

/** Bump the revision. Called by tool-result handlers in
 *  ChatSurface for tools that may have modified the fs. */
export function bumpWorkspaceRevision(): void {
  revision += 1;
  for (const cb of [...subscribers]) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): number {
  return revision;
}

/** React hook: returns the current workspace revision. The number
 *  itself is opaque; consumers use it as a useEffect dependency
 *  so their scan re-runs whenever it ticks. */
export function useWorkspaceRevision(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
