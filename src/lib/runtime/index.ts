// Runtime factory. Pick the right impl per environment + opt-in.
//
// Selection rules (in order):
//   1. If the path is `/play` (or `?play=1` query is set), force the
//      sandbox impl. The /play landing page IS the playground entry,
//      and main.tsx already routes that pathname to PlayPage — the
//      runtime needs to match. Earlier this only checked the query
//      param, which silently fell through to the web-noop and
//      surfaced as a confusing "runtime: not available in web build"
//      error on the very first step of the demo.
//   2. If we're inside Tauri (`isTauri()`), use the Tauri impl.
//      This is the default for the desktop app — fastest path,
//      direct fs / shell access, no network tax.
//   3. Otherwise (qcode-web root path, no /play opt-in) → sandbox
//      runtime. Originally this branch returned a web-noop stub —
//      qcode-web has nothing local to run against, so there was
//      no runtime to pick. With the sandbox-agent engine in place
//      every web user IS implicitly running inside a CF sandbox
//      session, so routing the runtime there too keeps File Tree /
//      preview / media in sync with what the agent is editing.
//      Pre-sandbox callers that never expected a runtime can still
//      opt out via setRuntimeOverride(null no-op) at the test seam.
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

  // /play page (browser) → sandbox runtime, regardless of whether
  // we're inside Tauri (so a desktop user can also test the
  // playground path by typing /play). Either pathname=/play or the
  // legacy ?play=1 query escape hatch trips it. Same logic as
  // main.tsx's isPlay check; centralizing here means a single
  // source of truth for "are we in playground mode?".
  if (typeof window !== 'undefined') {
    const path = window.location.pathname.replace(/\/+$/, '');
    const params = new URLSearchParams(window.location.search);
    if (path === '/play' || params.get('play') === '1') {
      return getSandboxRuntime();
    }
  }

  if (isTauri()) return getTauriRuntime();

  // qcode-web (any path that's not /play) → sandbox by default.
  // Every web turn already mints a sandbox session via sandbox-agent
  // .ts; the runtime just routes ad-hoc fs/preview calls through
  // the same container so what the user SEES (FileTree, preview
  // iframe, media) matches what the agent is doing.
  if (typeof window !== 'undefined') {
    return getSandboxRuntime();
  }

  // SSR / non-window context (vitest, prerender). No runtime to
  // talk to; the no-op throws if anyone calls it.
  return WEB_NOOP;
}

/** Convenience reflection — was the active runtime selected
 *  because the user is on the /play page? Useful for UI badges
 *  ("Sandbox · 10:00 left") that should only appear in playground
 *  mode. Mirrors getRuntime()'s selection logic above so the badge
 *  doesn't lie when only one of the two checks trips. */
export function isPlayMode(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === '/play') return true;
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
  async readDir() {
    throw new Error('runtime: not available in web build');
  },
};

// Re-export the contract types so consumers don't have to know
// about the file split.
export type {
  DirEntry,
  ExecOptions,
  ExecResult,
  PreviewUrl,
  Runtime,
} from './types';
// Export terminateSandbox so /play unmount handlers can clean up.
export { getSandboxSessionId, terminateSandbox } from './sandbox';
