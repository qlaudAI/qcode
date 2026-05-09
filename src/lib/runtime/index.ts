// Runtime factory. Pick the right impl per environment + opt-in.
//
// Selection rules (in order):
//   1. If `?play=1` is in the URL, force the sandbox impl.
//      The /play landing page sets this so a user who Try-It-Now's
//      on the marketing site lands directly in playground mode.
//   2. If we're inside Tauri (`isTauri()`), use the Tauri impl.
//      This is the default for the desktop app — fastest path,
//      direct fs / shell access, no network tax.
//   3. Otherwise we're in a plain browser tab without an explicit
//      opt-in. Return a no-op impl that throws on every call.
//      The web build (qcode-web.pages.dev) currently doesn't have
//      a remote runtime to connect to outside of /play, so any
//      caller that ends up here is a bug worth surfacing loudly.
//
// Why module-local memoization: every consumer (FileTree, agent
// loop, RightRail) calls getRuntime() per render — without the
// cache we'd allocate fresh adapter objects each time. The state
// inside sandbox.ts (session id, mint-in-flight promise) only
// matters once; recreating the wrapper would lose it.
//
// To force a specific runtime in tests / scripts, pass
// `setRuntimeOverride(...)` with a custom impl. Reset with
// `setRuntimeOverride(null)`.

import { isTauri } from '../tauri';
import { getSandboxRuntime } from './sandbox';
import { getTauriRuntime } from './tauri';
import type { Runtime } from './types';

let override: Runtime | null = null;

/** Test seam — install a custom runtime impl before any consumer
 *  reads it. Pass `null` to clear and fall back to auto-detect. */
export function setRuntimeOverride(rt: Runtime | null): void {
  override = rt;
}

/** Pick the runtime for the current environment. See file header
 *  for selection rules. Idempotent — safe to call from a render. */
export function getRuntime(): Runtime {
  if (override) return override;

  // Browser opt-in: ?play=1 → sandbox runtime even in Tauri (lets
  // a desktop user test the playground path without rebuilding).
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('play') === '1') {
      return getSandboxRuntime();
    }
  }

  if (isTauri()) return getTauriRuntime();

  // Plain web build, no /play opt-in. Return a stub that fails fast
  // on use — better than silently no-op'ing fs writes and confusing
  // the user about why their changes aren't saved.
  return WEB_NOOP;
}

/** Convenience reflection — was the active runtime selected
 *  because the user is on the /play page? Useful for UI badges
 *  ("Sandbox · 10:00 left") that should only appear in playground
 *  mode. */
export function isPlayMode(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('play') === '1';
}

/** No-op runtime for the web build outside of /play. Throws with a
 *  clear message rather than silently succeeding — the early failure
 *  is the whole point. */
const WEB_NOOP: Runtime = {
  kind: 'web-noop',
  async exec() {
    throw new Error(
      'runtime: not available in web build — open qcode desktop or visit /play',
    );
  },
  async readFile() {
    throw new Error('runtime: not available in web build');
  },
  async readBinaryFile() {
    throw new Error('runtime: not available in web build');
  },
  async writeFile() {
    throw new Error('runtime: not available in web build');
  },
  async mkdir() {
    throw new Error('runtime: not available in web build');
  },
  async exposePort() {
    throw new Error('runtime: not available in web build');
  },
};

// Re-export the contract types so consumers don't have to know
// about the file split.
export type { ExecOptions, ExecResult, PreviewUrl, Runtime } from './types';
// Export terminateSandbox so /play unmount handlers can clean up.
export { getSandboxSessionId, terminateSandbox } from './sandbox';
