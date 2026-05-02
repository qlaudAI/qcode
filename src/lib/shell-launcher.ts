// Cross-platform shell launcher for the bash tool + hook scripts.
//
// macOS / Linux: native `sh` is fine — what the rest of the agent
// expects, what every script the model writes assumes.
//
// Windows: no `sh` by default. Two acceptable shells:
//   1. Git Bash (preferred) — ships with Git for Windows. Most Windows
//      devs already have it; the installer adds bash.exe to PATH so
//      Command.create("bash", ...) resolves it. Bash semantics, all
//      the unix tools (sed/awk/grep/find), no extra setup.
//   2. WSL — fallback for users who installed it but not Git for
//      Windows. Slower per-call (the WSL bridge has overhead), but
//      a fully-fledged Linux environment, so anything the model
//      generates Just Works once we cross the bridge.
//
// We probe both on first call and cache the result for the session.
// If neither is available, the bash tool throws a clear error with
// install instructions instead of looking frozen.
//
// Tauri scope: the bash/wsl entries in src-tauri/capabilities/default.json
// must match the `cmd` values returned here, otherwise spawn fails
// with `permission denied`.

import { getPlatform } from './tauri';

export type ShellLauncher = {
  /** What to pass to Command.create as the binary name. */
  cmd: string;
  /** Wraps the unix-style argv we'd run on macOS into the right
   *  shape for this shell. For native shells this is a no-op. For
   *  WSL, prepends `bash` so we end up running bash inside Linux. */
  wrap: (args: string[]) => string[];
  /** Human-readable label for logs / banners. */
  label: 'sh' | 'git-bash' | 'wsl';
};

let cached: ShellLauncher | null = null;
let detectionError: string | null = null;

/** Returns null if no working shell is found — caller should surface
 *  the error in `getShellDetectionError()` to the user. */
export async function detectShell(): Promise<ShellLauncher | null> {
  if (cached) return cached;
  if (detectionError) return null;

  const platform = await getPlatform();
  if (platform !== 'windows') {
    cached = { cmd: 'sh', wrap: (a) => a, label: 'sh' };
    return cached;
  }

  // Windows path. Probe Git Bash first (faster than WSL), then WSL.
  if (await probe('bash', ['-c', 'exit 0'])) {
    cached = { cmd: 'bash', wrap: (a) => a, label: 'git-bash' };
    return cached;
  }
  if (await probe('wsl', ['bash', '-c', 'exit 0'])) {
    cached = {
      cmd: 'wsl',
      // Whatever the unix-shell args would be, run them via `bash` inside WSL.
      // e.g. ['-i','-s'] becomes ['bash','-i','-s']; ['/path/to/hook.sh'] becomes
      // ['bash','/path/to/hook.sh'].
      wrap: (a) => ['bash', ...a],
      label: 'wsl',
    };
    return cached;
  }

  detectionError =
    'No bash shell found. Install Git for Windows (https://git-scm.com/download/win) ' +
    'or enable WSL (https://learn.microsoft.com/windows/wsl/install).';
  return null;
}

export function getShellDetectionError(): string | null {
  return detectionError;
}

/** Try to run `cmd args` and return whether it exits 0. Tauri's
 *  Command.execute resolves the binary through PATH; if it's not
 *  installed, spawn rejects and we return false. */
async function probe(cmd: string, args: string[]): Promise<boolean> {
  try {
    const { Command } = await import('@tauri-apps/plugin-shell');
    const out = await Command.create(cmd, args).execute();
    return out.code === 0;
  } catch {
    return false;
  }
}
