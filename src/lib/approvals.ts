// Module-scoped approval registry.
//
// Why this exists: ChatSurface used to keep pending approvals in a
// useRef'd Map that lived for the lifetime of the component
// instance. If the component remounted (parent layout swap, dev-
// mode StrictMode double-invoke, hot reload, route change), the
// resolver was lost — the agent's executor sat awaiting a Promise
// that nobody could resolve, and the approval card on screen
// became permanently unclickable.
//
// Lifting the registry to module scope decouples it from the
// component lifecycle: resolvers persist across remounts, the UI
// always finds the right resolver by tool_use_id, and explicit
// stop() / sign-out paths are the only places we mass-cancel.
//
// The Map is keyed by tool_use_id (globally unique across qlaud)
// so two simultaneous threads can have pending approvals without
// colliding. We never expose direct .clear() — pending requests
// must always be resolved (allow/reject) so the executor unwinds
// instead of leaking.

import type { ApprovalDecision } from './tools';

type Resolver = (d: ApprovalDecision) => void;

const PENDING = new Map<string, Resolver>();

/** Register a resolver for a tool_use_id awaiting an approval
 *  decision. Replaces any prior resolver for the same id (e.g. a
 *  remount during the request) so the latest UI listener wins. */
export function registerApproval(toolUseId: string, resolve: Resolver): void {
  // If somehow a stale resolver lingered for this id, reject it
  // before installing the new one. Two listeners means double-
  // dispatch on click, which is worse than a clean reject + re-
  // register. (In practice this only fires under HMR / strict-
  // mode mounts.)
  const prior = PENDING.get(toolUseId);
  if (prior) prior('reject');
  PENDING.set(toolUseId, resolve);
}

/** Resolve the pending approval for a tool_use_id with the user's
 *  decision and remove it. No-op when there's nothing pending —
 *  covers a double-click on Allow/Reject. */
export function resolveApproval(
  toolUseId: string,
  decision: ApprovalDecision,
): void {
  const r = PENDING.get(toolUseId);
  if (!r) return;
  PENDING.delete(toolUseId);
  r(decision);
}

/** Reject every pending approval — called from stop() / abort() /
 *  sign-out. The executor sees ApprovalDecision='reject' and
 *  unwinds the tool call cleanly. */
export function rejectAllApprovals(): void {
  // Snapshot then clear so a resolver that re-registers during
  // its own rejection (paranoid case) doesn't loop.
  const snapshot = [...PENDING.values()];
  PENDING.clear();
  for (const r of snapshot) r('reject');
}

/** Diagnostic — number of approvals currently awaiting decision.
 *  Useful for telemetry; do not use to gate UI logic. */
export function pendingApprovalCount(): number {
  return PENDING.size;
}
