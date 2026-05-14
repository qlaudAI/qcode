// Sandbox session manager — extracted from runtime/sandbox.ts so
// the engine layer (engines/sandbox-agent.ts) can reuse the same
// session id without depending on the full Runtime adapter.
//
// Per-workspace as of alpha.179: every workspace gets its own
// Cloudflare Sandbox DO (container). Two workspaces never share a
// container, so transient state (env vars, /tmp, running processes)
// can never bleed across workspaces.
//
// The map lives in module scope (not localStorage) on purpose —
// sandboxes idle out after 10 min, so persisting across reloads
// gives stale ids that 404 on first use. Mint fresh per tab session;
// the server-side LRU + ~11min KV TTL keeps the (workspace →
// session) mapping aligned automatically.

import { getKey } from '../auth';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ??
  'https://api.qlaud.ai';

/** workspaceId → sessionId for live containers in this tab. Cleared
 *  on terminateSandboxSession, or surgically per-workspace when the
 *  server signals a rebind via qcode_session_rebound. */
const sessionByWorkspace = new Map<string, string>();
/** workspaceId → in-flight mint promise. Prevents two concurrent
 *  ensureSandboxSession calls for the same workspace from minting
 *  two containers and burning quota. */
const mintInFlight = new Map<string, Promise<string>>();

/** Mint a new sandbox session for `workspaceId`, or return the
 *  cached id. The first caller for a given workspace pays the
 *  ~100ms mint round-trip; subsequent callers get the cached value
 *  instantly. Throws if not signed in or the mint endpoint fails. */
export async function ensureSandboxSession(workspaceId: string): Promise<string> {
  const cached = sessionByWorkspace.get(workspaceId);
  if (cached) return cached;
  const pending = mintInFlight.get(workspaceId);
  if (pending) return pending;

  const promise = (async () => {
    const apiKey = getKey();
    if (!apiKey) {
      throw new Error('sign in required (no api key)');
    }
    const res = await fetch(`${BASE}/v1/sandbox/sessions`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`mint failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { session_id?: string };
    if (!data.session_id) {
      throw new Error('mint response missing session_id');
    }
    sessionByWorkspace.set(workspaceId, data.session_id);
    return data.session_id;
  })();

  mintInFlight.set(workspaceId, promise);
  try {
    return await promise;
  } finally {
    mintInFlight.delete(workspaceId);
  }
}

/** Read-only snapshot of the active sessionId for a workspace.
 *  Returns null when no session has been minted for it yet. UI can
 *  use this for a "sandbox ready" badge that only renders post-mint. */
export function getSandboxSessionId(workspaceId: string): string | null {
  return sessionByWorkspace.get(workspaceId) ?? null;
}

/** Update the cache from a server-side rebind. Fired by the agent
 *  stream's `qcode_session_rebound` event when the server resolved
 *  the canonical sessionId differently from what the client
 *  supplied — typically after an implicit chat→sandbox promotion
 *  or a container LRU eviction. The NEXT agent turn on this
 *  workspace targets the new sessionId. */
export function setSandboxSessionFromServer(
  workspaceId: string,
  sessionId: string,
): void {
  sessionByWorkspace.set(workspaceId, sessionId);
}

/** Invalidate a single workspace's session cache — e.g. on a
 *  `stale_session` 409 from the server. The next ensureSandboxSession
 *  for this workspace will mint fresh. */
export function invalidateSandboxSession(workspaceId: string): void {
  sessionByWorkspace.delete(workspaceId);
  mintInFlight.delete(workspaceId);
}

/** Tear down EVERY active session for this tab and clear the cache.
 *  Used on sign-out so no stale credentials linger. Best-effort —
 *  network failures are swallowed because the server-side
 *  sleepAfter handles cleanup either way. */
export async function terminateSandboxSession(): Promise<void> {
  const apiKey = getKey();
  const entries = [...sessionByWorkspace.entries()];
  sessionByWorkspace.clear();
  mintInFlight.clear();
  if (!apiKey || entries.length === 0) return;
  await Promise.allSettled(
    entries.map(([_ws, sid]) =>
      fetch(`${BASE}/v1/sandbox/sessions/${encodeURIComponent(sid)}`, {
        method: 'DELETE',
        headers: { 'x-api-key': apiKey },
      }),
    ),
  );
}
