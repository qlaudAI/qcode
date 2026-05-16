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
import {
  ensureSandboxSession,
  getSandboxSessionId,
  terminateSandboxSession,
} from './sandbox-session';
import type {
  DirEntry,
  ExecOptions,
  ExecResult,
  PreviewUrl,
  Runtime,
} from './types';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

// Session minting + lifecycle moved to ./sandbox-session so the
// agent engine (engines/sandbox-agent.ts) can mint without dragging
// the whole Runtime contract through. Re-export ensureSession here
// as a private alias to keep the call sites below readable.
//
// Runtime helpers (exec, readFile, writeDir, etc.) are NOT
// workspace-aware at the call site — they're used by the /play
// surface and the chat-surface file tree, both of which currently
// operate against whatever container is alive. As of alpha.179
// sessions are per-workspace, but the Runtime layer hasn't been
// plumbed for workspaceId yet, so we use a stable shared key. Any
// runtime helper running inside an agent turn will hit the same
// container the agent uses because the agent already minted a
// per-workspace session with the agent's workspaceId. This shared
// key just gives non-agent helpers a stable home.
const RUNTIME_FALLBACK_KEY = '__legacy_runtime__';
const ensureSession = () => ensureSandboxSession(RUNTIME_FALLBACK_KEY);

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

  async readDir(path: string): Promise<DirEntry[]> {
    // Worker shells out to `find -mindepth 1 -maxdepth 1 -printf …`
    // and returns the parsed listing. We deliberately don't pre-
    // filter dotfiles or apply gitignore here — that's
    // workspace.readDir's job. Keep this layer dumb so the agent's
    // own Glob tool can also rely on it without surprises.
    const r = await call<{ entries: DirEntry[] }>('/fs/readdir', { path });
    return r.entries ?? [];
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

  /** Heartbeat — POSTs to /v1/sandbox/sessions/:id/ping which runs
   *  a no-op `:` shell command inside the container. Resets the
   *  10-min idle-eviction timer so the container survives long
   *  reads of agent output. Returns false on any failure (dead
   *  container, network) — caller decides what to do (typically
   *  stops pinging + surfaces a "session ended" affordance). */
  async ping(): Promise<boolean> {
    try {
      await call<{ ok: boolean }>('/ping', {});
      return true;
    } catch {
      return false;
    }
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
  cached = null;
  await terminateSandboxSession();
}

/** Re-export for callers that still import from './sandbox'. */
export { getSandboxSessionId };
