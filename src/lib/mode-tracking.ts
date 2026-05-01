// Per-thread tracking of the agent mode the user was in for the
// most recent turn. Used by the Plan → Agent handoff: if the user
// asked the model to plan, then switched the title-bar mode toggle
// to Agent and sent a follow-up, qcode injects a one-line context
// note ahead of the new user turn so the model knows it should now
// EXECUTE the plan it previously produced.
//
// localStorage-only — qlaud doesn't need to know about modes; the
// system prompt already differs between plan and agent so the
// upstream call carries the intent.

import type { AgentMode } from './settings';

const KEY = (id: string) => `qcode.thread.${id}.lastMode`;

export function getLastMode(threadId: string): AgentMode | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(KEY(threadId));
  if (raw === 'plan' || raw === 'agent') return raw;
  return null;
}

export function setLastMode(threadId: string, mode: AgentMode): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(KEY(threadId), mode);
}

/** Returns a context-injection string when the user has just
 *  transitioned plan → agent on this thread, otherwise empty.
 *
 *  Empty when:
 *   - threadId is null (no thread yet)
 *   - this is the first turn (no prior mode)
 *   - prior mode == current mode (no transition)
 *   - going agent → plan (we don't gate the other direction —
 *     planning a previously-agent thread is fine; the new system
 *     prompt does the right framing on its own)
 */
export function planToAgentHandoff(
  threadId: string | null,
  currentMode: AgentMode,
): string {
  if (!threadId) return '';
  if (currentMode !== 'agent') return '';
  const last = getLastMode(threadId);
  if (last !== 'plan') return '';
  return [
    '> _Mode just switched from Plan to Agent. The user has reviewed your plan above and is now asking you to execute it._',
    '> _Pick up where the plan left off — you can use write_file / edit_file / bash. Approval cards still surface for every change; ask before deviating from the plan._',
    '',
  ].join('\n');
}
