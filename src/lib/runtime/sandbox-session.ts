// Sandbox session manager — extracted from runtime/sandbox.ts so
// the engine layer (engines/sandbox-agent.ts) can reuse the same
// session id without depending on the full Runtime adapter.
//
// One session per browser tab. Lazy-minted on first access,
// concurrency-safe via a shared in-flight promise so two callers
// don't race the mint and end up paying for two containers.
//
// The session id lives in module scope (not localStorage) on
// purpose — sandboxes idle out after 10 min, so persisting across
// reloads gives a stale id that 404s on first use. Better to mint
// fresh per tab session and let the user see the new ID.

import { getKey } from '../auth';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ??
  'https://api.qlaud.ai';

let sessionId: string | null = null;
let mintInFlight: Promise<string> | null = null;

/** Mint a new sandbox session, or return the cached id. The first
 *  caller pays the ~100ms mint round-trip; subsequent callers in
 *  the same tab get the cached value instantly. Throws if not
 *  signed in or the mint endpoint fails. */
export async function ensureSandboxSession(): Promise<string> {
  if (sessionId) return sessionId;
  if (mintInFlight) return mintInFlight;

  mintInFlight = (async () => {
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
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`mint failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { session_id?: string };
    if (!data.session_id) {
      throw new Error('mint response missing session_id');
    }
    sessionId = data.session_id;
    return sessionId;
  })();

  try {
    return await mintInFlight;
  } finally {
    mintInFlight = null;
  }
}

/** Read-only snapshot of the active session id without minting one.
 *  Returns null when no session has been created yet. UI can use
 *  this for a "sandbox ready" badge that only renders post-mint. */
export function getSandboxSessionId(): string | null {
  return sessionId;
}

/** Tear down the active session and clear the cache. Best-effort —
 *  network failures are swallowed because the server-side
 *  sleepAfter handles cleanup either way. */
export async function terminateSandboxSession(): Promise<void> {
  const id = sessionId;
  if (!id) return;
  sessionId = null;
  const apiKey = getKey();
  if (!apiKey) return;
  await fetch(`${BASE}/v1/sandbox/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'x-api-key': apiKey },
  }).catch(() => {
    /* server idles us out anyway */
  });
}
