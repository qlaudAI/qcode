// Built-in browser via Microsoft's @playwright/mcp.
//
// What this is: a singleton that spawns `@playwright/mcp` as a
// subprocess on first browser-tool call, speaks JSON-RPC over its
// stdio, and routes per-tool requests through it. Same surface area
// Claude Code uses for browser automation — we get DOM accessibility
// snapshots, screenshots, console logs, network requests, click/type
// interactions, all backed by a real Playwright Chromium.
//
// Why subprocess + stdio rather than HTTP: stdio is simpler (no port
// allocation, no localhost firewall surprises) and exactly matches
// the MCP spec's primary transport. The JSON-RPC framing is
// newline-delimited; we read whole lines off stdout and dispatch.
//
// Lifecycle:
//   - Lazy start. First browser_* tool call triggers spawn + MCP init.
//   - Persistent for the qcode session. Subsequent calls reuse the
//     same Chromium window — page state, cookies, console log
//     accumulation all survive.
//   - The user can close it via stopBrowserSidecar() (e.g. from a
//     /browser stop command, or implicitly when qcode quits).
//
// Cost: first call pays the npx fetch + Chromium download (~80MB,
// happens once per machine via Playwright's cache). Subsequent
// launches are ~1s.

import { type Child, Command } from '@tauri-apps/plugin-shell';

import { getPlatform } from './tauri';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse =
  | {
      jsonrpc: '2.0';
      id: number;
      result: unknown;
    }
  | {
      jsonrpc: '2.0';
      id: number;
      error: { code: number; message: string; data?: unknown };
    };

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

type BrowserSession = {
  child: Child;
  /** Map of in-flight requests by id → pending promise. */
  pending: Map<number, Pending>;
  /** Monotonic id counter. */
  nextId: number;
  /** Buffer for partial stdout lines (stdio is newline-framed but the
   *  OS pipe may split a write across multiple readable events). */
  stdoutBuf: string;
  /** Chronological tail of stderr — surfaced when a startup fails so
   *  the user sees Playwright's actual complaint, not "spawn failed". */
  stderrTail: string;
  /** True after we've received the initialize response. We hold tool
   *  calls until init completes. */
  ready: boolean;
};

let session: BrowserSession | null = null;
let startInFlight: Promise<BrowserSession> | null = null;

const STARTUP_TIMEOUT_MS = 60_000; // npx fetch + Chromium check
const CALL_TIMEOUT_MS = 120_000; // browser actions (load, screenshot, etc.)
const STDERR_TAIL_LIMIT = 8 * 1024;

/** Public entrypoint. Idempotent — concurrent callers share one
 *  startup promise; subsequent callers get the existing session. */
export async function ensureBrowserSidecar(): Promise<BrowserSession> {
  if (session && session.ready) return session;
  if (startInFlight) return startInFlight;
  startInFlight = startSidecar()
    .then((s) => {
      session = s;
      return s;
    })
    .finally(() => {
      startInFlight = null;
    });
  return startInFlight;
}

/** Stop the sidecar and clean up. Safe to call when nothing is
 *  running. */
export async function stopBrowserSidecar(): Promise<void> {
  if (!session) return;
  const s = session;
  session = null;
  for (const p of s.pending.values()) {
    p.reject(new Error('browser sidecar stopped'));
  }
  s.pending.clear();
  try {
    await s.child.kill();
  } catch {
    // child already dead
  }
}

/** Call a Playwright MCP tool by name. The tool list comes from
 *  @playwright/mcp's `tools/list`; we don't pre-validate names —
 *  the server will return an error if it's bogus and that error
 *  goes back to the model as the tool result. */
export async function callBrowserTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{
  /** MCP `content` array — text, image (base64), or resource refs. */
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}> {
  const s = await ensureBrowserSidecar();
  const result = (await rpc(s, 'tools/call', { name, arguments: args })) as {
    content?: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
  };
  return {
    content: result.content ?? [],
    isError: !!result.isError,
  };
}

/** Convenience: collect all text content into a single string. Useful
 *  for tools that return "ref tree" or "console messages" as text. */
export function textOf(
  content: Array<{ type: string; text?: string }>,
): string {
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/** Convenience: pull the first image (base64 PNG) out of an MCP
 *  content array. Returns null when there isn't one. */
export function firstImage(
  content: Array<{ type: string; data?: string; mimeType?: string }>,
): { data: string; mimeType: string } | null {
  for (const c of content) {
    if (c.type === 'image' && c.data) {
      return { data: c.data, mimeType: c.mimeType ?? 'image/png' };
    }
  }
  return null;
}

// ─── Internal: startup ────────────────────────────────────────────

async function startSidecar(): Promise<BrowserSession> {
  const platform = await getPlatform();
  // npx is the path of least resistance — Playwright MCP's official
  // distribution channel is the npm registry. -y auto-accepts the
  // download prompt for first-run installs. --headless: we don't
  // pop a Chromium window for every snapshot; the agent just needs
  // the DOM + screenshot bytes.
  //
  // Windows note: npx is `npx.cmd`. Tauri's plugin-shell resolves
  // through PATH so the platform-specific extension works either way,
  // but the capability needs to allow both — see default.json.
  const cmd = platform === 'windows' ? 'npx.cmd' : 'npx';
  const args = ['-y', '@playwright/mcp@latest', '--headless'];
  const command = Command.create(cmd, args);

  const pending = new Map<number, Pending>();
  let stdoutBuf = '';
  let stderrTail = '';

  command.stdout.on('data', (line) => {
    // Tauri's plugin-shell emits newline-split chunks already, but
    // we still buffer in case a long JSON-RPC frame splits.
    stdoutBuf += line;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const l of lines) {
      const trimmed = l.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        const p = pending.get(msg.id);
        if (!p) continue; // notification or stale
        pending.delete(msg.id);
        if ('error' in msg) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg.result);
        }
      } catch {
        // Not JSON-RPC (Playwright MCP can emit info banner lines
        // before the protocol kicks in). Ignore.
      }
    }
  });
  command.stderr.on('data', (line) => {
    stderrTail = (stderrTail + line).slice(-STDERR_TAIL_LIMIT);
  });

  let child: Child;
  try {
    child = await command.spawn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `browser sidecar failed to spawn (npx not on PATH?): ${msg}. ` +
        'Install Node 20+ from https://nodejs.org and try again.',
    );
  }

  const s: BrowserSession = {
    child,
    pending,
    nextId: 1,
    stdoutBuf,
    stderrTail,
    ready: false,
  };
  // Keep the buffer mutable on the session — the closure above
  // already references `stdoutBuf` and `stderrTail` directly so
  // the local vars track. Stash them anyway so stopBrowserSidecar
  // can read the tail for diagnostics.
  Object.defineProperty(s, 'stderrTail', {
    get: () => stderrTail,
  });

  command.on('close', () => {
    for (const p of pending.values()) {
      p.reject(
        new Error(
          `browser sidecar exited unexpectedly. stderr tail:\n${stderrTail || '(empty)'}`,
        ),
      );
    }
    pending.clear();
    if (session === s) session = null;
  });

  // MCP handshake: client → initialize, server → result, client →
  // notifications/initialized. Tools are not callable until the
  // notification has been sent.
  try {
    await withTimeout(
      rpc(s, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'qcode', version: '0.1.0' },
      }),
      STARTUP_TIMEOUT_MS,
      'browser sidecar initialize timed out',
    );
  } catch (e) {
    try {
      await child.kill();
    } catch {
      // already gone
    }
    const reason = e instanceof Error ? e.message : 'unknown';
    throw new Error(
      `browser sidecar init failed: ${reason}. ` +
        (stderrTail
          ? `Playwright stderr:\n${stderrTail}`
          : 'No stderr — check Node + npx are installed (Node 20+).'),
    );
  }
  // initialized is a notification (no id, no response).
  await sendRaw(s, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  } as unknown as JsonRpcRequest);
  s.ready = true;
  return s;
}

// ─── Internal: JSON-RPC plumbing ──────────────────────────────────

function rpc(
  s: BrowserSession,
  method: string,
  params: unknown,
): Promise<unknown> {
  const id = s.nextId++;
  const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
  return new Promise((resolve, reject) => {
    s.pending.set(id, { resolve, reject });
    sendRaw(s, req).catch((e) => {
      s.pending.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
    setTimeout(() => {
      if (s.pending.has(id)) {
        s.pending.delete(id);
        reject(new Error(`browser RPC ${method} timed out`));
      }
    }, CALL_TIMEOUT_MS);
  });
}

async function sendRaw(
  s: BrowserSession,
  msg: JsonRpcRequest,
): Promise<void> {
  const line = JSON.stringify(msg) + '\n';
  await s.child.write(line);
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  msg: string,
): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(msg)), ms),
    ),
  ]);
}
