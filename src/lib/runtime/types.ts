// Runtime contract — the surface every "place where qcode runs"
// must implement. Two impls today:
//
//   - tauri.ts   → desktop. Calls plugin-fs / plugin-shell directly,
//                  same as every existing helper used to. The
//                  performance baseline.
//   - sandbox.ts → web playground (`/play`). Calls the qlaud edge
//                  worker which calls the Cloudflare Sandbox SDK,
//                  which calls the container. ~50–200ms latency on
//                  every op vs <1ms on Tauri.
//
// The contract is intentionally narrow. Only the operations that
// today have to branch on `if (isTauri()) { ... }` belong here.
// Things like keychain, deep-linking, native window dragging stay
// in their existing per-platform files; web mode just no-ops them.
//
// Naming convention: methods mirror the Cloudflare Sandbox SDK
// where possible (exec / writeFile / readFile / mkdir / exposePort)
// so the sandbox impl is a near-passthrough and bugs there are
// easier to diagnose against the SDK docs.

/** Result of a one-shot shell command. Mirrors the SDK's
 *  ExecResult shape minus the `command` echo field; callers don't
 *  need it back since they already have the input string. */
export interface ExecResult {
  /** True iff exitCode === 0. Convenience flag — callers can read
   *  exitCode directly when they care about the difference between
   *  "1: error" and "127: command not found". */
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Wall-clock ms. Useful for telemetry; safe to ignore. */
  durationMs: number;
}

/** One-shot exec options. Matches the SDK's ExecOptions subset we
 *  actually use today — extend here when a new field becomes load-
 *  bearing on either impl. */
export interface ExecOptions {
  /** Working directory for the command. Defaults to runtime-specific
   *  workspace root (e.g. user's chosen folder on Tauri,
   *  /workspace inside the sandbox container). */
  cwd?: string;
  /** Hard timeout in ms. Caller responsibility to choose a sane
   *  value — agent loops typically pick 60_000–300_000. */
  timeoutMs?: number;
  /** Environment variables. Merged on top of the runtime's defaults
   *  (PATH, HOME). Don't set sensitive values here on the sandbox
   *  impl — they cross the network in a JSON body. */
  env?: Record<string, string>;
}

/** One immediate child of a directory. Minimal shape: just enough
 *  to render a tree row and decide whether to recurse. Symlinks
 *  surface as files (isDirectory=false) — the FileTree doesn't
 *  follow them, and the agent's Bash tool can resolve when needed.
 *  Add `kind: 'dir' | 'file' | 'symlink'` here when a caller needs
 *  the distinction. */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

/** Preview URL exposed for a port the user's app is listening on.
 *  Same shape on both runtimes:
 *    - tauri.ts   → http://localhost:<port> (+ optional 127.0.0.1 fallback)
 *    - sandbox.ts → https://<port>-sandbox-<id>-<token>.sbx.qlaud.app */
export interface PreviewUrl {
  port: number;
  /** Fully qualified URL the browser can hit. Always https in
   *  sandbox mode; http in tauri mode (localhost is exempt from
   *  mixed-content rules in modern browsers). */
  url: string;
  /** Caller-supplied label ("dev server", "api"). Useful for the
   *  preview-tabs UI when multiple ports are exposed. */
  name?: string;
}

/** The minimal runtime surface. */
export interface Runtime {
  /** Stable identifier for the runtime kind. UI branches on this
   *  for things like "show keychain settings only on tauri". */
  readonly kind: 'tauri' | 'sandbox' | 'web-noop';

  /** Run a shell command. Buffered stdout/stderr — for streaming
   *  command output, callers should use a separate startProcess
   *  helper (TODO: add when the agent loop migrates to remote). */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /** Read a UTF-8 text file from disk / sandbox FS. Throws when the
   *  file doesn't exist or permission is denied — callers should
   *  catch and decide whether that's a fatal error. */
  readFile(path: string): Promise<string>;

  /** Read a binary file. Returns Uint8Array regardless of runtime —
   *  the sandbox impl base64-decodes server-side; Tauri reads
   *  natively via plugin-fs. */
  readBinaryFile(path: string): Promise<Uint8Array>;

  /** Write a UTF-8 text file. Creates the file (and parent dir
   *  on sandbox; Tauri requires explicit mkdir). Overwrites if
   *  it exists. */
  writeFile(path: string, content: string): Promise<void>;

  /** Create a directory. `recursive: true` matches `mkdir -p`. */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;

  /** List immediate children of a directory. Returns the raw shape
   *  without the workspace.ts filtering layer (gitignore, hidden
   *  files, sort) — that policy lives at the call site so each
   *  surface (FileTree vs media scanner vs agent's Glob) can opt
   *  into the rules it actually wants.
   *  Throws on non-existent path / permission denied; callers
   *  decide whether that's fatal. */
  readDir(path: string): Promise<DirEntry[]>;

  /** Expose an open port and return a publicly reachable URL. On
   *  Tauri this is a glorified `http://localhost:<port>` since the
   *  user already has direct network access; on sandbox it goes
   *  through `sandbox.exposePort()` and returns the SDK-shaped
   *  `<port>-sandbox-<id>-<token>` URL. */
  exposePort(port: number, options?: { name?: string }): Promise<PreviewUrl>;

  /** Heartbeat — fires a cheap no-op against the runtime to reset
   *  idle eviction timers. Used by PreviewView to keep a sandbox
   *  container alive while the user is reading the agent's output
   *  but not driving a new turn. No-op on Tauri (desktop has no
   *  idle-eviction problem). Returns true on success, false on
   *  any failure (container dead, network error) — callers treat
   *  it as best-effort. */
  ping(): Promise<boolean>;
}
