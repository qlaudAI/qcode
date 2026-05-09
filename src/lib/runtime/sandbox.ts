// Sandbox runtime adapter. Routes every Runtime call through the
// qlaud edge worker (apps/edge/src/routes/sandbox.ts), which in
// turn routes through the Cloudflare Sandbox SDK to the live
// container.
//
// One sandbox session per qcode browser tab. The session id is
// minted lazily on the first call that needs the container; it's
// stashed in module-local state so subsequent calls reuse the same
// container until either:
//   - the user closes the tab (we never call /destroy; the 10-min
//     sleepAfter handles cleanup)
//   - 10 minutes of inactivity pass (server-side container sleep,
//     state wiped — see Cloudflare Sandbox lifecycle docs)
//   - the caller explicitly invokes terminate() below
//
// Authentication: every request sends `x-api-key`. The api key is
// the same qpk_/qlk_ token qcode uses for /v1/messages, sourced
// from `lib/auth.ts:getKey()`. No special "playground key" — the
// quota lives at the user level on the worker side.

import { getKey } from '../auth';
import type {
  ExecOptions,
  ExecResult,
  PreviewUrl,
  Runtime,
} from './types';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

/** Lazily-minted session id. Lives in module scope so multiple
 *  consumers (FileTree, ChatSurface, RightRail) all see the same
 *  container. Nullable because the first call has to mint it. */
let sessionId: string | null = null;
let mintInFlight: Promise<string> | null = null;

/** Mint or return the cached session id. Concurrency-safe — if two
 *  callers race the mint, both await the same promise so we don't
 *  end up with two unused containers (and two billing entries). */
async function ensureSession(): Promise<string> {
  if (sessionId) return sessionId;
  if (mintInFlight) return mintInFlight;
  mintInFlight = (async () => {
    const apiKey = getKey();
    if (!apiKey) {
      throw new Error('sandbox runtime: sign in required (no api key)');
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
      throw new Error(`sandbox mint failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { session_id?: string };
    if (!data.session_id) {
      throw new Error('sandbox mint: response missing session_id');
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

/** Wrap fetch with auth + JSON-body convention used by every
 *  sandbox endpoint. Throws with a useful error message on non-2xx
 *  so callers don't have to repeat the boilerplate. */
async function call<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const apiKey = getKey();
  if (!apiKey) throw new Error('sandbox runtime: sign in required');
  const id = await ensureSession();
  const res = await fetch(
    `${BASE}/v1/sandbox/sessions/${encodeURIComponent(id)}${path}`,
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sandbox ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

class SandboxRuntime implements Runtime {
  readonly kind = 'sandbox' as const;

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const r = await call<{
      success: boolean;
      exit_code: number;
      stdout: string;
      stderr: string;
      duration_ms: number;
    }>('/exec', {
      command,
      cwd: options?.cwd,
      timeoutMs: options?.timeoutMs,
    });
    return {
      success: r.success,
      exitCode: r.exit_code,
      stdout: r.stdout,
      stderr: r.stderr,
      durationMs: r.duration_ms,
    };
  }

  async readFile(path: string): Promise<string> {
    const r = await call<{ content: string }>('/fs/read', { path });
    return r.content;
  }

  async readBinaryFile(path: string): Promise<Uint8Array> {
    // The sandbox /fs/read endpoint currently returns plain UTF-8
    // strings only. Until we add a binary-read variant (likely a
    // base64 wrapper, since the SDK's readFileStream returns raw
    // bytes that don't roundtrip through JSON cleanly), call sites
    // that want binary on the sandbox impl have to fall back to a
    // shell-out: `base64 <path>` via exec(). Throwing here makes
    // the gap visible at typecheck time rather than silently
    // returning garbage UTF-8.
    throw new Error(
      'sandbox runtime: readBinaryFile not implemented — use exec("base64 <path>") for now',
    );
    // (uses path arg silently — keep the parameter name so the
    // contract stays uniform for future implementations.)
    void path;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await call<unknown>('/fs/write', { path, content });
  }

  async mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    await call<unknown>('/fs/mkdir', {
      path,
      recursive: options?.recursive,
    });
  }

  async exposePort(
    port: number,
    options?: { name?: string },
  ): Promise<PreviewUrl> {
    const r = await call<{ port: number; url: string; name?: string }>(
      '/expose-port',
      { port, name: options?.name },
    );
    return { port: r.port, url: r.url, name: r.name };
  }
}

let cached: SandboxRuntime | null = null;

/** Memoized — single runtime per tab matches the single-session
 *  model. */
export function getSandboxRuntime(): Runtime {
  if (!cached) cached = new SandboxRuntime();
  return cached;
}

/** Hard-tear-down. Tells the worker to destroy the DO + container
 *  immediately rather than waiting for sleepAfter. Call when the
 *  user clicks "End session" or navigates away from /play. Idle
 *  navigation away (close tab) skips this — the 10-min idle is
 *  enough cleanup, and forcing a synchronous teardown on unload
 *  would block the page transition. */
export async function terminateSandbox(): Promise<void> {
  const id = sessionId;
  if (!id) return;
  const apiKey = getKey();
  if (!apiKey) return;
  sessionId = null;
  cached = null;
  await fetch(
    `${BASE}/v1/sandbox/sessions/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: { 'x-api-key': apiKey },
    },
  ).catch(() => {
    /* best-effort — server idles us out anyway */
  });
}

/** For diagnostics / UI badges. Returns the active session id
 *  without minting one. */
export function getSandboxSessionId(): string | null {
  return sessionId;
}
