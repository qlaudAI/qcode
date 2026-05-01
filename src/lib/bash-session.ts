// Persistent bash session for the bash tool.
//
// Without persistence, each `bash` tool call spawns sh -c '...' fresh:
// `cd src/` and `source venv/bin/activate` from one call don't survive
// to the next. That's the single biggest agent-UX gap on a real
// codebase — "run pytest" after "cd packages/foo" should just work.
//
// This module keeps one long-running shell per workspace alive for
// the duration of the qcode session. Commands are written to its
// stdin followed by a sentinel marker; we read stdout until we see
// the sentinel echoed back, capture exit code, and return.
//
// Concurrency: bash calls within one workspace are serialized via
// a Promise queue. Two parallel bash tool calls would garble each
// other's stdout otherwise. (Different workspaces would each get
// their own shell — but qcode only has one workspace at a time.)
//
// Lifecycle:
//   - Lazy: shell spawned on first bash call per workspace.
//   - Persistent: lives until the workspace closes or the shell
//     process itself dies (user runs `exit`, OOM, etc.).
//   - Auto-respawn: if the shell is dead when a command arrives,
//     start a fresh one. State from the dead one is gone, but
//     the agent loop continues without erroring out.

import { isTauri } from './tauri';

const DONE_SENTINEL_PREFIX = '__QCODE_BASH_DONE_';

/** When stdin is dead the shell is gone; treat as terminated. */
type SessionState =
  | { status: 'idle'; childRef: ChildHandle }
  | { status: 'busy'; childRef: ChildHandle }
  | { status: 'dead' };

type ChildHandle = {
  child: import('@tauri-apps/plugin-shell').Child;
  /** Buffers per fd, accumulated since the last command's sentinel. */
  stdout: string;
  stderr: string;
  /** Resolved when the next sentinel lands; replaced per command. */
  waiter: ((code: number) => void) | null;
};

const sessions = new Map<string, SessionState>();

export type BashRunOptions = {
  workspace: string;
  command: string;
  /** Streamed progress — same contract as the old one-shot bash. The
   *  caller wraps this in the BashView formatting; we just hand
   *  cumulative stdout/stderr. Called on every chunk. */
  onPartial?: (text: string) => void;
  /** Cap. Default 60s. The shell stays alive on timeout — we just
   *  tell the agent the command didn't finish. */
  timeoutMs?: number;
};

export type BashRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/** Run a command in the workspace's persistent shell. Serialized
 *  per workspace so concurrent invocations queue cleanly. */
export async function runBashSession(opts: BashRunOptions): Promise<BashRunResult> {
  if (!isTauri()) {
    return {
      exitCode: 0,
      stdout: `[browser-mode stub: would run \`${opts.command}\`]`,
      stderr: '',
      timedOut: false,
    };
  }

  const session = await ensureSession(opts.workspace);
  if (session.status === 'busy') {
    // Wait until the previous command finishes. Polling the map is
    // simpler than chaining Promises and gets the right ordering
    // because this fn is the only mutator of the busy flag.
    await waitIdle(opts.workspace);
  }

  return runSerialized(opts);
}

/** Force-kill the workspace's shell. Called when the user closes
 *  the workspace; next bash call lazily spawns a fresh one. */
export async function killBashSession(workspace: string): Promise<void> {
  const s = sessions.get(workspace);
  if (!s || s.status === 'dead') return;
  try {
    await s.childRef.child.kill();
  } catch {
    // Already dead — ignore.
  }
  sessions.set(workspace, { status: 'dead' });
}

async function waitIdle(workspace: string): Promise<void> {
  // Bounded poll. Most bash commands finish in seconds; long-running
  // ones (test suites) can take minutes but still finish. We don't
  // do an unbounded wait — if the previous command really hangs,
  // the per-call timeout in runSerialized handles it.
  for (let i = 0; i < 600; i++) {
    const s = sessions.get(workspace);
    if (!s || s.status !== 'busy') return;
    await sleep(100);
  }
  throw new Error('previous bash command never completed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureSession(workspace: string): Promise<SessionState> {
  const existing = sessions.get(workspace);
  if (existing && existing.status !== 'dead') return existing;

  const { Command } = await import('@tauri-apps/plugin-shell');
  // -i (interactive) loads .bashrc/.bash_profile so user aliases +
  // PATH additions are available; -s reads commands from stdin.
  // Without -i, sourcing venvs and pyenv shims doesn't pick up the
  // user's shell config and the model's first `python` call hits
  // the system Python instead of the project's.
  const cmd = Command.create('sh', ['-i', '-s'], { cwd: workspace });
  const handle: ChildHandle = {
    child: null as unknown as import('@tauri-apps/plugin-shell').Child,
    stdout: '',
    stderr: '',
    waiter: null,
  };

  cmd.stdout.on('data', (line: string) => {
    handle.stdout += line.endsWith('\n') ? line : line + '\n';
    checkSentinel(workspace, handle);
  });
  cmd.stderr.on('data', (line: string) => {
    handle.stderr += line.endsWith('\n') ? line : line + '\n';
  });
  cmd.on('close', () => {
    sessions.set(workspace, { status: 'dead' });
  });

  handle.child = await cmd.spawn();
  const next: SessionState = { status: 'idle', childRef: handle };
  sessions.set(workspace, next);
  return next;
}

/** Each command writes a unique sentinel after itself; the stdout
 *  watcher calls this when it sees the sentinel. */
function checkSentinel(workspace: string, handle: ChildHandle): void {
  const idx = handle.stdout.lastIndexOf(DONE_SENTINEL_PREFIX);
  if (idx === -1) return;
  // Sentinel format: __QCODE_BASH_DONE_<id>__ <exit_code>
  // Extract the line containing the sentinel.
  const before = handle.stdout.slice(0, idx);
  const after = handle.stdout.slice(idx);
  const newlineAt = after.indexOf('\n');
  if (newlineAt === -1) return; // sentinel printed but newline pending
  const sentinelLine = after.slice(0, newlineAt);
  const m = sentinelLine.match(/__QCODE_BASH_DONE_[\w-]+__\s+(\d+)/);
  if (!m) return;
  const code = Number.parseInt(m[1] ?? '0', 10);

  // Strip the sentinel line out of the rendered stdout so the agent
  // never sees it. Stuff after the sentinel (if any) is from a
  // racing prompt redraw — also discard.
  handle.stdout = before;
  if (handle.waiter) {
    const w = handle.waiter;
    handle.waiter = null;
    w(code);
  }
  // Mark idle for the next caller.
  const sessionState = sessions.get(workspace);
  if (sessionState && sessionState.status === 'busy') {
    sessions.set(workspace, { status: 'idle', childRef: handle });
  }
}

async function runSerialized(opts: BashRunOptions): Promise<BashRunResult> {
  const session = sessions.get(opts.workspace);
  if (!session || session.status === 'dead') {
    // Recreate
    await ensureSession(opts.workspace);
    return runSerialized(opts);
  }
  if (session.status === 'busy') {
    await waitIdle(opts.workspace);
    return runSerialized(opts);
  }
  const handle = session.childRef;
  // Reset per-call buffers so we only return what THIS command emits.
  handle.stdout = '';
  handle.stderr = '';
  sessions.set(opts.workspace, { status: 'busy', childRef: handle });

  const id = randomId();
  const sentinel = `${DONE_SENTINEL_PREFIX}${id}__`;

  // Wrap user command + sentinel in a brace group so they're a single
  // logical statement — `;` separator + `echo` to print sentinel +
  // exit code on completion. Whitespace before the echo keeps it on
  // its own line even when the user's command doesn't end with one.
  // Note: stderr is printed to fd 2 by the user's command directly —
  // we don't intercept it; just merge what the watcher buffers.
  const wrapped = `{ ${opts.command}\n}; printf '\\n%s %d\\n' "${sentinel}" "$?"\n`;

  const exitPromise = new Promise<number>((resolve) => {
    handle.waiter = resolve;
  });

  // Stream cumulative output as it accumulates. We poll the buffer
  // in a loop because Tauri's data callbacks fire on the main thread
  // — there's no event we can hook to "buffer changed."
  let lastSent = '';
  const partialTimer = setInterval(() => {
    if (!opts.onPartial) return;
    const sofar = renderPartial(handle.stdout, handle.stderr, null);
    if (sofar !== lastSent) {
      lastSent = sofar;
      opts.onPartial(sofar);
    }
  }, 100);

  try {
    await handle.child.write(wrapped);
  } catch (e) {
    clearInterval(partialTimer);
    sessions.set(opts.workspace, { status: 'dead' });
    return {
      exitCode: 1,
      stdout: '',
      stderr:
        'failed to write to bash session: ' +
        (e instanceof Error ? e.message : 'unknown'),
      timedOut: false,
    };
  }

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const winner = await Promise.race([
    exitPromise,
    sleep(timeoutMs).then(() => 'timeout' as const),
  ]);
  clearInterval(partialTimer);

  if (winner === 'timeout') {
    // Don't kill the shell — the user's command might still finish
    // in the background. Mark idle so the next call queues; the
    // sentinel from the timed-out command will eventually arrive
    // and the watcher will harmlessly wake up its (already-resolved)
    // waiter (which is null, so nothing happens).
    sessions.set(opts.workspace, { status: 'idle', childRef: handle });
    return {
      exitCode: -1,
      stdout: handle.stdout,
      stderr: handle.stderr,
      timedOut: true,
    };
  }

  return {
    exitCode: winner,
    stdout: handle.stdout,
    stderr: handle.stderr,
    timedOut: false,
  };
}

function randomId(): string {
  // 8 hex chars is plenty of entropy for our sentinel; collisions
  // would only matter if two commands somehow ran in parallel
  // against the same shell, which the queue prevents.
  return Math.random().toString(16).slice(2, 10);
}

function renderPartial(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string {
  const exitLine = exitCode == null ? 'exit running…' : `exit ${exitCode}`;
  return (
    `${exitLine}\n` +
    (stdout ? `--- stdout ---\n${stdout}` : '') +
    (stderr ? `--- stderr ---\n${stderr}` : '')
  );
}
