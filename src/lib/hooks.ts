// User hooks for tool dispatch.
//
// A hook is a shell script the user drops in their workspace at
// `.qcode/hooks/<event>` (no extension required). When the matching
// event fires, qcode runs it via `sh <path>`, pipes a JSON
// description of the tool call to stdin, and reads stdout/stderr +
// exit code.
//
// Event semantics:
//   pre_<tool>:
//     stdin:  the tool input as JSON
//     stdout: optional message — if non-empty AND the hook exits 0,
//             the message is APPENDED to the tool's normal output
//             so the model sees both. If exit ≠ 0, the message
//             BLOCKS the tool: it never runs, the model gets the
//             hook's stdout (or stderr if stdout is empty) as the
//             tool's `is_error: true` result.
//
//   post_<tool>:
//     stdin:  { input, output, isError } — the tool's result as JSON
//     stdout: optional override — if non-empty, REPLACES the tool's
//             output before the model sees it. Useful for
//             auto-formatting after edit_file or summarizing long
//             bash output.
//
// Why shell scripts: every developer has shell. No new runtime to
// learn. If users want Python/JS/whatever, they shebang it on the
// first line and chmod +x — but qcode itself only ever invokes
// `sh <path>` so the hook scope stays narrow (we already spawn sh
// for the bash tool, no new Tauri permission needed).
//
// Why opt-in (no defaults): hooks run with the user's shell privs.
// We don't ship any default hooks — your repo, your scripts,
// your call. Missing hook directory = no hooks fire = old behavior.

import { isTauri } from './tauri';

export type HookEvent =
  | 'pre_bash'
  | 'post_bash'
  | 'pre_write_file'
  | 'post_write_file'
  | 'pre_edit_file'
  | 'post_edit_file';

export type HookResult = {
  /** Whether the tool should proceed. Pre-hooks set this to false
   *  when they block; post-hooks always set true (post can't block,
   *  only transform). */
  proceed: boolean;
  /** Replacement output — when set, used instead of (post) or
   *  alongside (pre) the tool's own output. Empty string = passthrough. */
  message: string;
  /** True when the hook itself failed to run. We surface this as
   *  is_error to the model so it doesn't silently believe the tool
   *  succeeded when its post-hook crashed. */
  hookErrored: boolean;
};

const PASSTHROUGH: HookResult = {
  proceed: true,
  message: '',
  hookErrored: false,
};

export async function runHook(opts: {
  workspace: string;
  event: HookEvent;
  input: unknown;
  /** Soft cap so a misbehaving hook doesn't hang the tool loop. */
  timeoutMs?: number;
}): Promise<HookResult> {
  if (!isTauri()) return PASSTHROUGH;

  const { exists } = await import('@tauri-apps/plugin-fs');
  const path = `${opts.workspace}/.qcode/hooks/${opts.event}`;
  // Hot path: most users won't have a hook for this event. Quick
  // exists check before spawning anything.
  try {
    if (!(await exists(path))) return PASSTHROUGH;
  } catch {
    return PASSTHROUGH;
  }

  const { Command } = await import('@tauri-apps/plugin-shell');
  const cmd = Command.create('sh', [path], { cwd: opts.workspace });
  let stdoutBuf = '';
  let stderrBuf = '';
  cmd.stdout.on('data', (line: string) => {
    stdoutBuf += line.endsWith('\n') ? line : line + '\n';
  });
  cmd.stderr.on('data', (line: string) => {
    stderrBuf += line.endsWith('\n') ? line : line + '\n';
  });

  const exitPromise = new Promise<number>((resolve) => {
    cmd.on('close', (data) => {
      const code = (data as { code?: number }).code ?? 0;
      resolve(code);
    });
  });

  let child: import('@tauri-apps/plugin-shell').Child;
  try {
    child = await cmd.spawn();
  } catch (e) {
    return {
      proceed: true,
      message: '',
      hookErrored: true,
      // Surface why so the user can debug — this comes through as
      // a tool result line if the caller surfaces hookErrored.
    } as HookResult & { _err: string } as HookResult;
  }

  // Feed the JSON input on stdin and close it so the script's `read`
  // / cat reaches EOF.
  try {
    await child.write(JSON.stringify(opts.input) + '\n');
  } catch {
    // stdin closed already — script may not be reading. That's fine.
  }

  const timeout = opts.timeoutMs ?? 30_000;
  const winner = await Promise.race([
    exitPromise,
    sleep(timeout).then(() => 'timeout' as const),
  ]);
  if (winner === 'timeout') {
    try {
      await child.kill();
    } catch {
      // already dead
    }
    return {
      proceed: true,
      message: `[hook ${opts.event} timed out after ${timeout / 1000}s; ignored]`,
      hookErrored: true,
    };
  }

  const exitCode = winner;
  // Pre-hook with non-zero exit blocks the tool. Post-hook can't
  // block — it can only transform.
  const isPre = opts.event.startsWith('pre_');
  const stdoutTrim = stdoutBuf.trim();
  const stderrTrim = stderrBuf.trim();

  if (isPre && exitCode !== 0) {
    return {
      proceed: false,
      message:
        stdoutTrim ||
        stderrTrim ||
        `Tool blocked by ${opts.event} hook (exit ${exitCode}).`,
      hookErrored: false,
    };
  }

  // Pre-hook 0 → optional informational message appended to result.
  // Post-hook → stdout (if any) replaces the tool's output.
  return {
    proceed: true,
    message: stdoutTrim,
    hookErrored: exitCode !== 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
