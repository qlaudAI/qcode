// Tauri runtime adapter. Wraps the existing plugin-fs / plugin-shell
// helpers so consumers can switch between local and sandbox without
// rewriting their call sites.
//
// Rule of thumb: do NOT add new logic here. This file is a thin
// re-export layer over things qcode already does directly today.
// Anything load-bearing (workspace discovery, gitignore filtering,
// streaming bash sessions) stays in its existing module — we'd
// just over-fit the runtime contract trying to absorb it.

import { runBashSession } from '../legacy/bash-session';
import { isTauri } from '../tauri';
import type {
  ExecOptions,
  ExecResult,
  PreviewUrl,
  Runtime,
} from './types';

/** Default workspace root for runs that don't specify a cwd. The
 *  consumer is expected to pass cwd explicitly for any workspace-
 *  scoped command — this fallback only exists so a missing-cwd bug
 *  surfaces with a clear error instead of running in the user's
 *  home directory by accident. */
const NO_CWD_SENTINEL = '';

class TauriRuntime implements Runtime {
  readonly kind = 'tauri' as const;

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const cwd = options?.cwd ?? NO_CWD_SENTINEL;
    if (!cwd) {
      throw new Error(
        'tauri runtime: cwd is required for exec() — pass options.cwd',
      );
    }
    const start = performance.now();
    // Note: options.env is ignored on the Tauri impl today. The
    // existing runBashSession runs through a persistent shell per
    // workspace; per-call env would require either restarting that
    // shell (slow + breaks any cd state) or prefixing each command
    // with `KEY=VAL ...`. Neither is worth doing until a caller
    // actually needs it. The sandbox impl honors env directly via
    // the SDK; sites that do today depend on env (engines/claude-
    // code.ts) call Command.sidecar themselves, not this helper.
    const r = await runBashSession({
      workspace: cwd,
      command,
      timeoutMs: options?.timeoutMs,
    });
    return {
      success: r.exitCode === 0,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      durationMs: Math.round(performance.now() - start),
    };
  }

  async readFile(path: string): Promise<string> {
    if (!isTauri()) throw new Error('tauri runtime: readFile requires desktop');
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    return readTextFile(path);
  }

  async readBinaryFile(path: string): Promise<Uint8Array> {
    if (!isTauri()) {
      throw new Error('tauri runtime: readBinaryFile requires desktop');
    }
    const { readFile } = await import('@tauri-apps/plugin-fs');
    return readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!isTauri()) throw new Error('tauri runtime: writeFile requires desktop');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(path, content);
  }

  async mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    if (!isTauri()) throw new Error('tauri runtime: mkdir requires desktop');
    const { mkdir } = await import('@tauri-apps/plugin-fs');
    await mkdir(path, { recursive: options?.recursive });
  }

  async exposePort(
    port: number,
    options?: { name?: string },
  ): Promise<PreviewUrl> {
    // On Tauri the user's own machine is reachable directly. There's
    // no Cloudflare proxy to mint a public URL through — and the
    // existing preview iframe in qcode points at localhost anyway.
    // We pass back the conventional URL so the runtime contract
    // stays uniform; the qcode preview surface already knows what
    // to do with localhost (force IPv4, cache-bust, etc — see the
    // preview-iframe fix in alpha.168).
    return {
      port,
      url: `http://localhost:${port}`,
      name: options?.name,
    };
  }
}

let cached: TauriRuntime | null = null;

/** Memoized — runtime instances are stateless, no reason to ever
 *  have more than one. */
export function getTauriRuntime(): Runtime {
  if (!cached) cached = new TauriRuntime();
  return cached;
}
