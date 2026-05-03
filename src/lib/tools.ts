// qcode's tool catalog.
//
// Tools split into two tiers:
//
//   READ_TOOLS    — list_files, read_file, glob, grep
//                    Run without user approval. Bounded by path-jail
//                    (workspace root) + size caps.
//
//   WRITE_TOOLS   — write_file, edit_file, bash
//                    Require explicit approval before execution. The
//                    executor calls back into the agent loop with an
//                    ApprovalRequest; the loop forwards it to the UI;
//                    the UI returns 'allow' or 'reject'.
//
// All filesystem paths are jailed inside the open workspace. Every
// dangerous tool also has its own per-tool defense (deny-list for
// bash, expected-replacements check for edit_file, etc.).

import { checkBgJob, runBashBackground, runBashSession } from './bash-session';
import {
  callBrowserTool,
  firstImage,
  textOf,
} from './browser-sidecar';
import { computeDiff, type DiffLine } from './diff';
import type { IgnoreMatcher } from './gitignore';
import { runHook } from './hooks';
import { hasRipgrep, rgGlob, rgGrep } from './ripgrep';
import { isTauri } from './tauri';
import { getMatcher } from './workspace';

// Anthropic-shape tool definition. Sent verbatim to /v1/messages.
export type ToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type ToolResult = {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ApprovalRequest =
  | {
      kind: 'write_file';
      path: string;
      diff: DiffLine[];
      added: number;
      removed: number;
      isNew: boolean;
    }
  | {
      kind: 'edit_file';
      path: string;
      diff: DiffLine[];
      added: number;
      removed: number;
    }
  | {
      kind: 'bash';
      command: string;
      cwd: string;
    }
  | {
      // Doom-loop guard: surfaced when the agent is about to dispatch
      // the same tool with the same input three times in a row. Lets
      // the user break a stuck cycle (or confirm it really should
      // proceed) instead of watching it spin. Pattern from opencode's
      // session/processor.ts.
      kind: 'doom_loop';
      toolName: string;
      /** Pretty-printed input for display only — not used for matching. */
      inputPreview: string;
      /** How many identical consecutive dispatches we've seen. */
      repeats: number;
    };

export type ApprovalDecision = 'allow' | 'reject';

// ─── Tool definitions (sent to the model) ──────────────────────────

export const READ_TOOLS: ToolDef[] = [
  {
    name: 'list_files',
    description:
      "List files and directories at the given path inside the user's open workspace. Returns up to 200 entries; if more, the result is truncated. Use this to discover the project structure before reading specific files.",
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Workspace-relative path, or "." for the workspace root.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read the full contents of a text file inside the workspace. Files larger than 200 KB are rejected — use grep to narrow first.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'glob',
    description:
      'Find files matching a glob pattern. Supports **, *, ?. Returns up to 500 paths. Cheaper than recursive list_files when looking for files by name.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description:
            'Glob pattern (e.g. "**/*.ts", "src/**/route.tsx"). Workspace-relative.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description:
      'Search file contents using regex. Returns matching lines as file:line:content. Use `path` to restrict the search root, or `glob` to filter file names. Up to 200 matches returned.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex to search for.' },
        path: {
          type: 'string',
          description:
            'Optional workspace-relative directory to start from. Defaults to the workspace root.',
        },
        glob: {
          type: 'string',
          description:
            'Optional file-name glob filter (e.g. "*.ts"). Leave empty to search all text files.',
        },
        case_insensitive: {
          type: 'boolean',
          description: 'Case-insensitive match. Defaults to false.',
        },
      },
      required: ['pattern'],
    },
  },
];

// `todo_write` is the agent's persistent checklist. The latest tool
// call's `todos` input IS the current state — we render it as a
// sticky panel above the chat. No filesystem dispatch needed; the
// executor just acks. Persistence rides for free on the message
// history (qlaud thread is canonical), so the panel survives reload
// and cross-device sync without a separate store.
export const TODO_TOOL: ToolDef = {
  name: 'todo_write',
  description:
    "Maintain a structured checklist of work for the current task. Call this tool whenever you start a non-trivial multi-step task, when you finish a step, when you discover new sub-tasks, or when the user changes scope. Always pass the FULL list (not a delta) — the latest call replaces the prior list.\n\nWhen to use:\n- Tasks with 3+ distinct steps or actions\n- Multi-file refactors, new feature implementations, anything that branches\n- After receiving new instructions — capture them as todos\n- Mark items completed IMMEDIATELY after finishing (don't batch — the user sees the update live)\n- Exactly ONE item should be in_progress at a time\n\nWhen NOT to use:\n- Single-step tasks (read one file, run one command, answer one question)\n- Purely conversational replies\n\nStatus values: pending (not started), in_progress (working on now), completed (done).",
  input_schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            activeForm: { type: 'string' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
            },
          },
          required: ['content', 'activeForm', 'status'],
        },
      },
    },
    required: ['todos'],
  },
};

// `task` is the orchestrator's dispatch primitive. The model picks an
// agent type (Explorer / Verifier / Builder / Planner / Reviewer) and
// hands off a self-contained prompt; the named agent runs in a fresh
// remote thread with its own focused system prompt + tool subset, then
// returns a text summary. Multiple task calls in one turn run in
// parallel via the SSE fire-and-forget dispatch path.
//
// Implementation: client-dispatched. agent.ts intercepts the dispatch,
// resolves agent_type to a tool subset (from lib/agents.ts) + flips
// the qlaud_runtime.agent_type so the server applies the focused
// persona prompt. Approval prompts from the child surface in the same
// UI so the user always sees + approves writes.
export const TASK_TOOL: ToolDef = {
  name: 'task',
  description:
    "Dispatch a named agent to a focused subtask. Pick the right one for the job:\n\n• explorer — read-only investigation (find references, map architecture). Returns markdown summary with file:line citations. Use when answering would balloon your context (\"find every caller of X\", \"map the auth layer\").\n• verifier — confirm a code change actually landed and the project's check command passes. Run AFTER write_file/edit_file or after a foreground bash that timed out — don't trust 'I think it worked'. Returns PASS/FAIL with specifics.\n• builder — self-contained execution with full toolkit (write/edit/bash/browser/verify). Use for \"scaffold X\", \"add feature Y\", \"refactor Z\" — the Builder owns the whole edit→verify loop.\n• planner — read-only proposal-style plan. Use before a Builder when the change is ambiguous; Planner returns a file-by-file plan you pass into Builder.\n• reviewer — read-only audit for bugs / security / perf. Returns ranked findings with file:line and severity.\n\nMultiple task calls in one assistant message run IN PARALLEL — fan out independent work rather than serializing. The agent doesn't see this conversation; the prompt must stand alone (file paths, what to look for, success criteria). Don't use task for one-shot operations (one read_file, one grep) — call those directly.",
  input_schema: {
    type: 'object',
    properties: {
      agent_type: {
        type: 'string',
        enum: ['explorer', 'verifier', 'builder', 'planner', 'reviewer'],
        description:
          'Which agent to dispatch. See the tool description for when to pick each.',
      },
      description: {
        type: 'string',
        description:
          'Short 3-7 word noun phrase shown to the user (e.g. "Audit auth flow", "Verify scaffold landed", "Find dead exports").',
      },
      prompt: {
        type: 'string',
        description:
          "Self-contained prompt for the agent. The agent doesn't see this conversation; everything it needs has to be here.",
      },
    },
    required: ['agent_type', 'description', 'prompt'],
  },
};

// ─── Browser tools (Playwright MCP) ────────────────────────────────
//
// Built-in headless Chromium via @playwright/mcp. The sidecar spawns
// on first call and persists for the qcode session — page state,
// cookies, console accumulation all survive across calls.
//
// browser_navigate / browser_snapshot / browser_screenshot run
// without approval (they don't mutate the user's machine — at most
// they GET URLs the model picked). browser_click and browser_type
// could in theory hit a malicious URL's "delete account" flow, but
// since the URL only got loaded because the model navigated to it,
// the trust boundary is the workspace + the URLs the agent reaches.
// We treat them as read-tier for now; if that proves wrong we can
// route them through the approval gate the way bash does.
export const BROWSER_TOOLS: ToolDef[] = [
  {
    name: 'browser_navigate',
    description:
      'Open a URL in the built-in headless Chromium. Use this to load a page before snapshotting, screenshotting, or interacting. Common flow: navigate → snapshot → click/type → screenshot. Returns the page title + the URL that loaded (which may differ from input due to redirects).',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to load.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      "Capture the page's accessibility tree — text + role + ref ids for every interactive element. Cheaper and more semantic than a screenshot when you need to find a button to click or a form field to fill. Use the returned ref ids with browser_click / browser_type.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_screenshot',
    description:
      "Take a PNG screenshot of the current page. Returns base64-encoded image content the chat surface renders inline. Pass full_page:true for the entire scroll height (default: viewport only). Use this when visual verification matters — layout, colors, rendering — that the accessibility tree can't show.",
    input_schema: {
      type: 'object',
      properties: {
        full_page: {
          type: 'boolean',
          description: 'Capture the entire page including below the fold. Default false.',
        },
      },
    },
  },
  {
    name: 'browser_click',
    description:
      'Click an element by its ref id from the most recent browser_snapshot. The element description is shown to the user for context. Page state changes after the click — re-snapshot if you need to interact with the resulting page.',
    input_schema: {
      type: 'object',
      properties: {
        element: {
          type: 'string',
          description: 'Human-readable description of the target ("Sign in button"). Shown to the user.',
        },
        ref: {
          type: 'string',
          description: 'Ref id from the latest browser_snapshot.',
        },
      },
      required: ['element', 'ref'],
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into an input element identified by ref id from the latest browser_snapshot. Set submit:true to press Enter after typing (useful for search boxes / login forms).',
    input_schema: {
      type: 'object',
      properties: {
        element: {
          type: 'string',
          description: 'Human-readable description of the field ("Email field").',
        },
        ref: {
          type: 'string',
          description: 'Ref id from the latest browser_snapshot.',
        },
        text: {
          type: 'string',
          description: 'Text to type into the field.',
        },
        submit: {
          type: 'boolean',
          description: 'Press Enter after typing. Default false.',
        },
      },
      required: ['element', 'ref', 'text'],
    },
  },
  {
    name: 'browser_console',
    description:
      'Read console messages (log/info/warn/error) accumulated since the page loaded. Use after navigating + interacting to verify a feature ran cleanly — no JS errors, no failed fetches, no React warnings.',
    input_schema: { type: 'object', properties: {} },
  },
];

export const WRITE_TOOLS: ToolDef[] = [
  {
    name: 'write_file',
    description:
      'Create or overwrite a file with the given content. Workspace-jailed. Requires user approval — qcode shows a diff before any change is written. Prefer edit_file for small changes to existing files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path.' },
        content: { type: 'string', description: 'Full file contents.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      "Replace `old_string` with `new_string` in the named file. The match must be unique unless `expected_replacements` is set. Requires user approval. Prefer this over write_file for small edits — it's safer and the diff is tighter.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path.' },
        old_string: {
          type: 'string',
          description:
            'Exact text to find. Include enough surrounding context to be unique.',
        },
        new_string: {
          type: 'string',
          description: 'Replacement text.',
        },
        expected_replacements: {
          type: 'integer',
          description:
            'Required if old_string appears more than once. Pass the exact count.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'bash',
    description:
      "Run a shell command. Persistent session: cwd, env vars, and shell state (sourced venvs, exported variables) survive across calls in the same conversation, so `cd packages/foo` followed by `pytest` works as you'd expect. Requires user approval. Output streams in. Default 6-minute per-call timeout (the shell stays alive on timeout — env preserved for the next call). Deny-list catches obviously-dangerous commands (rm -rf /, fork bombs, sudo, curl|sh).\n\nFor long-running processes that should keep going while you work — dev servers, watch builds, file watchers — set run_in_background:true. The call returns immediately with a job_id; use bash_status to drain output and check whether the job has finished.",
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        description: {
          type: 'string',
          description:
            'One-line plain-English summary of why you want to run this. Shown to the user in the approval dialog.',
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Spawn the command in a detached background process and return a job_id immediately instead of waiting. Use for `pnpm dev`, `cargo watch`, anything you want running while you keep iterating. Default false. Output is captured to a file; retrieve it with bash_status({job_id}).',
        },
      },
      required: ['command', 'description'],
    },
  },
  {
    name: 'bash_status',
    description:
      'Drain new output from a background bash job and check if it has finished. Returns stdout produced since the previous bash_status call (or since the job started if first call), whether the job is still running, and the exit code (only when finished). Use after a bash with run_in_background:true. The job_id you pass came from that call.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'The job_id returned by a prior bash {run_in_background: true} call.',
        },
      },
      required: ['job_id'],
    },
  },
];

// `verify` runs the project's check command — what the user runs
// before claiming a change is done. Auto-detects from qcode.md
// (`verify: <cmd>` line) → package.json scripts → lang defaults →
// otherwise tells the model to ask the user. Read-tier (no approval,
// no mutations); just runs a command and reports pass/fail. The
// system prompt requires this after any write_file/edit_file.
export const VERIFY_TOOL: ToolDef = {
  name: 'verify',
  description:
    "Run the project's verification command (typecheck / tests / lint) and report whether it passed. Auto-detects the right command from qcode.md (a `verify: <cmd>` line wins), then package.json scripts (in order: `check`, `typecheck`, `test`, `lint`), then language defaults (`cargo check`, `go build ./...`). Use this after every write_file or edit_file before saying the task is done — code that doesn't typecheck isn't done. Returns the resolved command, exit code, and trimmed output. No args.",
  input_schema: { type: 'object', properties: {} },
};

export const ALL_TOOLS = [
  ...READ_TOOLS,
  ...BROWSER_TOOLS,
  ...WRITE_TOOLS,
  TASK_TOOL,
  TODO_TOOL,
  VERIFY_TOOL,
];

/** Subagent-mode tool list. The child agent gets every tool the
 *  parent has EXCEPT `task` itself — recursive subagent spawning
 *  is too easy a footgun (cost runaway, confused-deputy patterns)
 *  and we have a depth-1 cap baked in by simply not exposing the
 *  tool. Read-mode subagents drop write tools too, mirroring Plan.
 *  Browser tools ride along in both — a "verify this page renders"
 *  subagent is the canonical use case. */
export const SUBAGENT_TOOLS = [
  ...READ_TOOLS,
  ...BROWSER_TOOLS,
  ...WRITE_TOOLS,
  VERIFY_TOOL,
];
export const SUBAGENT_READ_TOOLS = [...READ_TOOLS, ...BROWSER_TOOLS, VERIFY_TOOL];

// ─── Executor ───────────────────────────────────────────────────────

const MAX_FILE_BYTES = 200 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_GLOB_MATCHES = 500;
const MAX_GREP_MATCHES = 200;
const BASH_TIMEOUT_MS = 360_000; // 6 min — covers most real builds + test suites

// Patterns we refuse to run regardless of approval. Belt-and-suspenders
// with the workspace cwd jail; catches the most obvious foot-guns even
// when the user is moving fast and clicks "allow" reflexively.
const BASH_DENYLIST: RegExp[] = [
  /\brm\s+-rf?\s+\/(\s|$)/i,
  /\bsudo\s/i,
  /:\(\)\s*\{[^}]*:\|:&[^}]*\};\s*:/, // fork bomb
  /\bdd\s+if=.*of=\/dev\/(?:sd|hd|nvme)/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bcurl\b[^|]*\|\s*(?:bash|sh)\b/i, // curl|sh
];

// Bash commands we trust to auto-execute under autoApprove.safeBash.
// Read-only ops + workspace-scoped package-manager noops + git
// read-only commands. The list is intentionally conservative — when
// in doubt, fall through to "ask the user." Adding a pattern here
// is a security decision; a misfire means the agent ran something
// the user didn't expect.
//
// Anything outside the whitelist (or matching the denylist) still
// prompts. The agent + the model see the user-facing description
// and can be more measured because they know the executor will
// challenge anything spicy.
const BASH_SAFE_PATTERNS: RegExp[] = [
  // Read-only inspection
  /^\s*(ls|cat|head|tail|grep|find|which|where|pwd|echo|stat|file|wc|sort|uniq|cut|awk|sed|tree|du|df|ps|env|printenv|date)\b/,
  // Git read-only ops (status, log, diff, show, branch listing, etc.)
  /^\s*git\s+(status|log|diff|show|branch|remote|ls-files|blame|describe|reflog|stash\s+list|tag\s+(-l|--list)?|fetch|config\s+(?!--global))/,
  // Git reversible workspace ops — checkout/switch refuse to clobber
  // dirty state by default, stash is the user-recoverable save, restore
  // is per-file and only undoes uncommitted changes. Excludes any `--`
  // long flag (negative lookahead) so destructive forms like
  // `git checkout -- file` or `git checkout --force` still hit the
  // approval gate. Commit/push/merge/rebase/reset/cherry-pick/clean
  // intentionally NOT included — those mutate history or destroy data.
  /^\s*git\s+(checkout|switch)(\s+(?!--)\S+)+\s*$/,
  /^\s*git\s+stash(\s+(push|pop|apply|drop|show))?\s*$/,
  /^\s*git\s+restore\s+(?!--)\S+\s*$/,
  // Package-manager safe ops — install/test/build/lint/typecheck/format/dev are workspace-scoped
  /^\s*(pnpm|npm|yarn|bun)\s+(install|i|add|remove|test|t|build|run|dev|start|typecheck|tc|lint|format|fmt|exec|x|outdated|why|list|ls|info|view|audit|update|upgrade)\b/,
  // Runtime version checks
  /^\s*(node|deno|bun|python|python3|ruby|go|rustc|cargo|pip|pip3)\s+(-v|--version|version)\s*$/,
  // Cargo (Rust) read/build/test
  /^\s*cargo\s+(check|test|build|run|fmt|clippy|doc|tree|search|update)\b/,
  // Python/Ruby/Go safe ops
  /^\s*(python|python3|ruby|go|rustc)\s+(-c|-m|-V|--version|run|test|build|fmt|vet|mod|env)\b/,
  /^\s*(pytest|jest|vitest|mocha|tap|tape)\b/,
  // make / just — usually safe build orchestrators
  /^\s*(make|just)\s+(-n|--dry-run|build|test|check|lint|clean|fmt)\b/,
  /^\s*(make|just)\s*$/, // bare make = default target, usually fine
  // Docker read-only / status
  /^\s*docker\s+(ps|images|version|info|logs|inspect)\b/,
  // Read-only HTTP probes
  /^\s*curl\s+(-s\s+|-sS\s+|-I\s+|-fsSL\s+)?(http|https):\/\//,
  // Shell pipe / redirect detectors (if any read-only command pipes
  // to head/grep/wc/jq, it's still safe). These match commands ALREADY
  // matching above plus a pipe to a known safe consumer.
  /\|\s*(head|tail|grep|wc|sort|uniq|jq|awk|sed|cut|less|cat)\b/,
];

/** Whether write_file / edit_file should bypass the approval prompt.
 *  yolo + smart auto-approve workspace writes (the path-jail already
 *  guarantees the target is inside the open folder); strict prompts. */
function autoApproveWrite(mode: import('./settings').AutoApproveMode | undefined): boolean {
  return mode === 'yolo' || mode === 'smart';
}

/** Whether a bash invocation should bypass the approval prompt.
 *  yolo bypasses everything (the deny-list still applies via the
 *  caller before this is reached). smart bypasses only the safe-bash
 *  whitelist for foreground commands; background jobs always prompt
 *  in smart so dev servers don't spawn behind your back. strict
 *  prompts for everything. */
function autoApproveBash(
  mode: import('./settings').AutoApproveMode | undefined,
  command: string,
  runInBackground: boolean,
): boolean {
  if (mode === 'yolo') return true;
  if (mode === 'strict') return false;
  return !runInBackground && isSafeBashCommand(command);
}

/** Whether a bash command is safe enough to auto-execute under
 *  smart mode. Conservative — the deny-list always wins, and only
 *  commands matching the explicit allow patterns return true.
 *  Multi-statement (cmd1 && cmd2) requires EVERY segment to be safe;
 *  one risky segment fails the whole thing. */
export function isSafeBashCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  if (BASH_DENYLIST.some((re) => re.test(trimmed))) return false;
  // Split on && / ; / | (top-level only — won't perfectly handle
  // quoted ampersands, but good enough). Each segment must be safe.
  const segments = trimmed
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) =>
    BASH_SAFE_PATTERNS.some((re) => re.test(seg)),
  );
}

export type ExecuteOpts = {
  /** Workspace root — every relative path is resolved against this. */
  workspace: string;
  /** Approval gate. Required for write_file / edit_file / bash unless
   *  autoApprove gates them; the executor returns an error if an
   *  approval is needed but the gate isn't wired. */
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Live progress callback. Currently only bash uses this — emits
   *  the full accumulated stdout/stderr-formatted text on every chunk
   *  so the UI can render it as the command runs. The agent still gets
   *  the final consolidated result via the returned ToolResult. */
  onPartial?: (text: string) => void;
  /** Auto-approve mode — read from settings at send time and passed
   *  through every executor call. yolo bypasses every approval (still
   *  honors the deny-list); smart auto-approves workspace writes +
   *  safe-bash whitelist; strict prompts for everything. The deny-
   *  list (BASH_DENYLIST, workspace path-jail) always wins regardless. */
  autoApprove?: import('./settings').AutoApproveMode;
};

export async function executeTool(
  call: ToolCall,
  opts: ExecuteOpts,
): Promise<ToolResult> {
  try {
    switch (call.name) {
      case 'list_files':
        return await runListFiles(call, opts);
      case 'read_file':
        return await runReadFile(call, opts);
      case 'glob':
        return await runGlob(call, opts);
      case 'grep':
        return await runGrep(call, opts);
      case 'write_file':
        return await runWriteFile(call, opts);
      case 'edit_file':
        return await runEditFile(call, opts);
      case 'bash':
        return await runBash(call, opts);
      case 'bash_status':
        return await runBashStatus(call, opts);
      case 'browser_navigate':
      case 'browser_snapshot':
      case 'browser_screenshot':
      case 'browser_click':
      case 'browser_type':
      case 'browser_console':
        return await runBrowser(call);
      case 'todo_write':
        // Pure ack — the rendering layer reads the call's input
        // directly from the message history. We return a tiny
        // confirmation so the model sees the call landed and can
        // continue without confusion.
        return ok(call.id, 'Todo list updated.');
      case 'verify':
        return await runVerify(call, opts);
      default:
        return err(call.id, `Unknown tool: ${call.name}`);
    }
  } catch (e) {
    return err(call.id, e instanceof Error ? e.message : String(e));
  }
}

// ─── Read tools ─────────────────────────────────────────────────────

async function runListFiles(
  call: ToolCall,
  opts: ExecuteOpts,
): Promise<ToolResult> {
  const input = call.input as { path?: unknown };
  const requested = typeof input.path === 'string' ? input.path : '.';
  const abs = resolveInWorkspace(requested, opts.workspace);
  if (!abs) return badPath(call.id, requested);
  if (!isTauri()) {
    return ok(
      call.id,
      `[browser-mode stub for ${abs}]\nsrc/\npackage.json\nREADME.md`,
    );
  }
  const { readDir } = await import('@tauri-apps/plugin-fs');
  const entries = await readDir(abs);
  const sliced = entries.slice(0, MAX_LIST_ENTRIES);
  const lines = sliced.map((e) => (e.isDirectory ? `${e.name}/` : e.name));
  const trailer =
    entries.length > MAX_LIST_ENTRIES
      ? `\n…(${entries.length - MAX_LIST_ENTRIES} more entries truncated)`
      : '';
  return ok(call.id, lines.join('\n') + trailer);
}

async function runReadFile(
  call: ToolCall,
  opts: ExecuteOpts,
): Promise<ToolResult> {
  const input = call.input as { path?: unknown };
  const requested = typeof input.path === 'string' ? input.path : '';
  const abs = resolveInWorkspace(requested, opts.workspace);
  if (!abs) return badPath(call.id, requested);
  if (!isTauri()) {
    return ok(call.id, `[browser-mode stub: would read ${abs}]`);
  }
  const { stat, readTextFile } = await import('@tauri-apps/plugin-fs');
  const info = await stat(abs);
  if (info.size != null && info.size > MAX_FILE_BYTES) {
    return err(
      call.id,
      `File too large (${info.size} bytes; limit is ${MAX_FILE_BYTES}). Use grep to narrow.`,
    );
  }
  const text = await readTextFile(abs);
  // Record the read so subsequent write_file/edit_file can confirm
  // the agent has seen the file recently. recordRead() is module-
  // scoped LRU; safe to call without a workspace param. read_file
  // is a full read (no offset/limit support yet) so isPartialView
  // defaults to false.
  const { recordRead } = await import('./read-cache');
  recordRead({ path: abs, content: text });
  return ok(call.id, text);
}

async function runGlob(
  call: ToolCall,
  opts: ExecuteOpts,
): Promise<ToolResult> {
  const input = call.input as { pattern?: unknown };
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  if (!pattern) return err(call.id, 'pattern required');
  if (!isTauri()) {
    return ok(call.id, `[browser-mode stub: would glob ${pattern}]`);
  }

  // Fast path: ripgrep --files -g <pattern>. Respects .gitignore
  // automatically, ~10-50× faster than the JS walker on big repos.
  // Falls back to the walker on detection or runtime failure so
  // a busted rg install doesn't break the tool.
  if (await hasRipgrep()) {
    try {
      const result = await rgGlob({
        workspace: opts.workspace,
        pattern,
        max: MAX_GLOB_MATCHES,
      });
      const trailer = result.truncated
        ? `\n…(more matches truncated; narrow your pattern)`
        : '';
      return ok(call.id, result.files.join('\n') + trailer || '(no matches)');
    } catch {
      // Fall through to the walker.
    }
  }

  const re = globToRegex(pattern);
  const matches: string[] = [];
  const matcher = await getMatcher(opts.workspace);
  await walkDir(opts.workspace, opts.workspace, re, matches, matcher);
  const top = matches.slice(0, MAX_GLOB_MATCHES);
  const trailer =
    matches.length > MAX_GLOB_MATCHES
      ? `\n…(${matches.length - MAX_GLOB_MATCHES} more truncated)`
      : '';
  return ok(call.id, top.join('\n') + trailer || '(no matches)');
}

async function runGrep(
  call: ToolCall,
  opts: ExecuteOpts,
): Promise<ToolResult> {
  const input = call.input as {
    pattern?: unknown;
    path?: unknown;
    glob?: unknown;
    case_insensitive?: unknown;
  };
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  if (!pattern) return err(call.id, 'pattern required');
  const requestedPath =
    typeof input.path === 'string' && input.path ? input.path : '.';
  const root = resolveInWorkspace(requestedPath, opts.workspace);
  if (!root) return badPath(call.id, requestedPath);
  const fileGlob =
    typeof input.glob === 'string' && input.glob ? input.glob : null;
  const ci = input.case_insensitive === true;

  let re: RegExp;
  try {
    re = new RegExp(pattern, ci ? 'gi' : 'g');
  } catch (e) {
    return err(call.id, `Invalid regex: ${e instanceof Error ? e.message : e}`);
  }
  if (!isTauri()) {
    return ok(call.id, `[browser-mode stub: would grep ${pattern} in ${root}]`);
  }

  // Fast path: ripgrep. Same line:content output shape as the walker
  // so the model never sees the boundary. Bails to the walker on
  // detection or runtime failure.
  if (await hasRipgrep()) {
    try {
      const rootRel = relativizePath(root, opts.workspace) || '.';
      const result = await rgGrep({
        workspace: opts.workspace,
        rootRel,
        pattern,
        fileGlob,
        caseInsensitive: ci,
        max: MAX_GREP_MATCHES,
        maxFileBytes: MAX_FILE_BYTES,
      });
      const lines = result.hits.map(
        (h) => `${h.path}:${h.line}:${h.content}`,
      );
      const trailer = result.truncated
        ? `\n…(${MAX_GREP_MATCHES} match cap reached; narrow your pattern)`
        : '';
      return ok(call.id, lines.join('\n') + trailer || '(no matches)');
    } catch {
      // Fall through to the walker.
    }
  }

  const fileGlobRe = fileGlob ? globToRegex(fileGlob) : null;
  const files: string[] = [];
  const matcher = await getMatcher(opts.workspace);
  await walkDir(root, opts.workspace, /.*/, files, matcher);
  const matches: string[] = [];
  const { stat, readTextFile } = await import('@tauri-apps/plugin-fs');
  for (const file of files) {
    if (fileGlobRe && !fileGlobRe.test(file)) continue;
    let info;
    try {
      info = await stat(opts.workspace + '/' + file);
    } catch {
      continue;
    }
    if (info.size != null && info.size > MAX_FILE_BYTES) continue;
    let text;
    try {
      text = await readTextFile(opts.workspace + '/' + file);
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      re.lastIndex = 0;
      if (re.test(line)) {
        matches.push(`${file}:${i + 1}:${line}`);
        if (matches.length >= MAX_GREP_MATCHES) break;
      }
    }
    if (matches.length >= MAX_GREP_MATCHES) break;
  }
  const trailer =
    matches.length >= MAX_GREP_MATCHES
      ? `\n…(${MAX_GREP_MATCHES} match cap reached; narrow your pattern)`
      : '';
  return ok(call.id, matches.join('\n') + trailer || '(no matches)');
}

// ─── Write tools (approval-gated) ──────────────────────────────────

async function runWriteFile(
  call: ToolCall,
  opts: ExecuteOpts,
): Promise<ToolResult> {
  const input = call.input as { path?: unknown; content?: unknown };
  const requested = typeof input.path === 'string' ? input.path : '';
  const content = typeof input.content === 'string' ? input.content : '';
  const abs = resolveInWorkspace(requested, opts.workspace);
  if (!abs) return badPath(call.id, requested);
  // requestApproval is only required when we're NOT auto-approving;
  // checked inside the conditional below.
  const skipWriteApproval = autoApproveWrite(opts.autoApprove);
  if (!skipWriteApproval && !opts.requestApproval) {
    return err(
      call.id,
      'Write tools are not enabled in this session — approval gate missing.',
    );
  }

  let before = '';
  let isNew = false;
  let mtimeMs = 0;
  if (isTauri()) {
    const { exists, readTextFile, stat } = await import('@tauri-apps/plugin-fs');
    const present = await exists(abs);
    if (!present) {
      isNew = true;
    } else {
      before = await readTextFile(abs);
      const info = await stat(abs).catch(() => null);
      // Tauri fs returns mtime as a Date | null. Handle both shapes
      // defensively — null mtime falls through to "treat as fresh."
      const m = info?.mtime;
      if (m instanceof Date) mtimeMs = m.getTime();
      else if (typeof m === 'number') mtimeMs = m;
    }
  }
  const diff = computeDiff(before, content);
  const added = diff.filter((d) => d.kind === 'add').length;
  const removed = diff.filter((d) => d.kind === 'remove').length;

  // Read-before-Edit gate. New files are exempt (creation can't be
  // stale by definition). Existing files MUST have a recent
  // recordRead() entry whose timestamp covers the disk's current
  // mtime — otherwise we refuse the write so the agent doesn't edit
  // based on stale knowledge of the file.
  const { checkReadBeforeWrite } = await import('./read-cache');
  const gateError = checkReadBeforeWrite({
    path: abs,
    currentContent: isNew ? null : before,
    currentMtimeMs: mtimeMs,
  });
  if (gateError) {
    return err(call.id, gateError.message);
  }

  // Pre-write hook — gate by path/content. Common use: enforce
  // license headers, block edits to vendored files, require
  // updates to a CHANGELOG when src/* changes.
  const preWrite = await runHook({
    workspace: opts.workspace,
    event: 'pre_write_file',
    input: { path: relativizePath(abs, opts.workspace), content, isNew },
  });
  if (!preWrite.proceed) {
    return err(call.id, preWrite.message);
  }

  // Auto-approve workspace-scoped writes under yolo + smart. Path-jail
  // (resolveInWorkspace, line above) already confirmed `abs` is inside
  // the workspace; auto-approving here is the same trust posture as
  // letting the agent edit at all.
  if (!skipWriteApproval) {
    const decision = await opts.requestApproval!({
      kind: 'write_file',
      path: relativizePath(abs, opts.workspace),
      diff,
      added,
      removed,
      isNew,
    });
    if (decision !== 'allow') {
      return ok(call.id, 'User rejected the write. No changes made.');
    }
  }

  if (!isTauri()) {
    return ok(call.id, `[browser-mode stub: would write ${abs}]`);
  }
  const { writeTextFile, mkdir } = await import('@tauri-apps/plugin-fs');
  const parent = abs.replace(/[/\\][^/\\]*$/, '');
  if (parent && parent !== abs) {
    try {
      await mkdir(parent, { recursive: true });
    } catch {
      // mkdir failures bubble up clearly via writeTextFile
    }
  }
  await writeTextFile(abs, content);
  // Refresh the read-cache so chained edits of the same file don't
  // need an explicit re-read between them. The cache now reflects
  // exactly what's on disk because we just wrote it.
  const { recordWrite } = await import('./read-cache');
  recordWrite({ path: abs, content });

  // Post-write hook — auto-format, lint, etc. Output (if any) is
  // appended so the model sees what the formatter said.
  const postWrite = await runHook({
    workspace: opts.workspace,
    event: 'post_write_file',
    input: { path: relativizePath(abs, opts.workspace), content, isNew },
  });
  let summary = `Wrote ${content.length} bytes to ${relativizePath(abs, opts.workspace)} (+${added} -${removed}).`;
  if (postWrite.message) {
    summary += `\n[post_write_file hook]\n${postWrite.message}`;
  }
  return ok(call.id, summary);
}

async function runEditFile(
  call: ToolCall,
  opts: ExecuteOpts,
): Promise<ToolResult> {
  const input = call.input as {
    path?: unknown;
    old_string?: unknown;
    new_string?: unknown;
    expected_replacements?: unknown;
  };
  const requested = typeof input.path === 'string' ? input.path : '';
  const oldString =
    typeof input.old_string === 'string' ? input.old_string : '';
  const newString =
    typeof input.new_string === 'string' ? input.new_string : '';
  const expected =
    typeof input.expected_replacements === 'number'
      ? input.expected_replacements
      : null;
  if (!oldString) return err(call.id, 'old_string required');

  const abs = resolveInWorkspace(requested, opts.workspace);
  if (!abs) return badPath(call.id, requested);
  const skipEditApproval = autoApproveWrite(opts.autoApprove);
  if (!skipEditApproval && !opts.requestApproval) {
    return err(call.id, 'Edit tools are not enabled in this session.');
  }
  if (!isTauri()) {
    return ok(call.id, `[browser-mode stub: would edit ${abs}]`);
  }

  const { exists, readTextFile, stat, writeTextFile } = await import(
    '@tauri-apps/plugin-fs'
  );
  if (!(await exists(abs))) {
    return err(call.id, 'File does not exist; use write_file to create it.');
  }
  const before = await readTextFile(abs);
  // Read-before-Edit gate — same posture as runWriteFile. edit_file
  // is even more sensitive to staleness because old_string matching
  // assumes the agent's mental model of the file matches disk.
  const editStatInfo = await stat(abs).catch(() => null);
  const editMtimeMs =
    editStatInfo?.mtime instanceof Date
      ? editStatInfo.mtime.getTime()
      : typeof editStatInfo?.mtime === 'number'
        ? editStatInfo.mtime
        : 0;
  const { checkReadBeforeWrite: editGate } = await import('./read-cache');
  const editGateError = editGate({
    path: abs,
    currentContent: before,
    currentMtimeMs: editMtimeMs,
  });
  if (editGateError) {
    return err(call.id, editGateError.message);
  }
  const occurrences = countOccurrences(before, oldString);
  if (occurrences === 0) {
    return err(
      call.id,
      'old_string not found. Make sure it matches the file exactly, including whitespace.',
    );
  }
  if (expected != null && occurrences !== expected) {
    return err(
      call.id,
      `Expected ${expected} occurrences of old_string but found ${occurrences}.`,
    );
  }
  if (expected == null && occurrences > 1) {
    return err(
      call.id,
      `old_string appears ${occurrences} times. Add more surrounding context to make it unique, or pass expected_replacements.`,
    );
  }
  const after = before.split(oldString).join(newString);
  const diff = computeDiff(before, after);
  const added = diff.filter((d) => d.kind === 'add').length;
  const removed = diff.filter((d) => d.kind === 'remove').length;

  // Pre-edit hook — symmetric with pre_write_file but receives
  // old/new strings rather than full content (useful for "block
  // edits that change a SQL migration file" or similar).
  const preEdit = await runHook({
    workspace: opts.workspace,
    event: 'pre_edit_file',
    input: {
      path: relativizePath(abs, opts.workspace),
      old_string: oldString,
      new_string: newString,
    },
  });
  if (!preEdit.proceed) {
    return err(call.id, preEdit.message);
  }

  // Auto-approve workspace-scoped edits — same posture as
  // write_file above. Path-jail already confirmed scope.
  if (!skipEditApproval) {
    const decision = await opts.requestApproval!({
      kind: 'edit_file',
      path: relativizePath(abs, opts.workspace),
      diff,
      added,
      removed,
    });
    if (decision !== 'allow') {
      return ok(call.id, 'User rejected the edit. No changes made.');
    }
  }
  await writeTextFile(abs, after);
  // Refresh the read-cache with the post-edit content so chained
  // edits don't need a re-read.
  const { recordWrite: recordEdit } = await import('./read-cache');
  recordEdit({ path: abs, content: after });

  // Post-edit hook — most useful for auto-formatting after a
  // surgical edit. e.g. ${file}.ts edits → run prettier on it.
  const postEdit = await runHook({
    workspace: opts.workspace,
    event: 'post_edit_file',
    input: {
      path: relativizePath(abs, opts.workspace),
      old_string: oldString,
      new_string: newString,
    },
  });
  let summary = `Edited ${relativizePath(abs, opts.workspace)} (+${added} -${removed}).`;
  if (postEdit.message) {
    summary += `\n[post_edit_file hook]\n${postEdit.message}`;
  }
  return ok(call.id, summary);
}

async function runBash(
  call: ToolCall,
  opts: ExecuteOpts,
): Promise<ToolResult> {
  const input = call.input as {
    command?: unknown;
    run_in_background?: unknown;
  };
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return err(call.id, 'command required');
  if (BASH_DENYLIST.some((re) => re.test(command))) {
    return err(
      call.id,
      'Command rejected by qcode safety filter. Try a safer alternative.',
    );
  }
  const runInBackground = input.run_in_background === true;
  // Tri-state gate: yolo bypasses approval entirely (deny-list above
  // already filtered the truly nasty stuff); smart bypasses only the
  // safe-bash whitelist for foreground commands (background jobs
  // always prompt in smart so dev servers don't spawn behind your
  // back); strict prompts for everything.
  const autoApproved = autoApproveBash(opts.autoApprove, command, runInBackground);

  if (!autoApproved && !opts.requestApproval) {
    return err(call.id, 'Bash is not enabled in this session.');
  }

  // Pre-bash hook: runs BEFORE approval so a project-level guard
  // (e.g. block any `git push --force` against main) can deny the
  // call without bothering the user. Post-hook fires after the
  // command runs and can transform output (summarize a 2K-line
  // pytest dump down to "x failed, y passed", etc.).
  const preHook = await runHook({
    workspace: opts.workspace,
    event: 'pre_bash',
    input: { command, run_in_background: runInBackground },
  });
  if (!preHook.proceed) {
    return err(call.id, preHook.message);
  }

  if (!autoApproved) {
    const decision = await opts.requestApproval!({
      kind: 'bash',
      command: runInBackground ? `[background] ${command}` : command,
      cwd: opts.workspace,
    });
    if (decision !== 'allow') {
      return ok(call.id, 'User rejected the command. Not run.');
    }
  }

  // Background path: spawn detached, return job_id immediately.
  // No streaming progress (the model uses bash_status to poll), no
  // post_bash hook (the job runs after this tool call returns).
  if (runInBackground) {
    try {
      const { jobId, pid } = await runBashBackground({
        workspace: opts.workspace,
        command,
      });
      const msg =
        `Started background job ${jobId} (pid ${pid}). The command is running detached.\n` +
        `Use bash_status({"job_id": "${jobId}"}) to drain output and check status.`;
      return ok(call.id, msg);
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'unknown';
      return err(call.id, `failed to start background job: ${reason}`);
    }
  }

  // Foreground path: persistent shell. cd / source venv / set vars
  // persist across bash calls within the same workspace session — the
  // model can run "cd packages/foo" then "pytest" in two calls and have
  // pytest actually find foo's venv. See lib/bash-session.ts.
  const result = await runBashSession({
    workspace: opts.workspace,
    command,
    onPartial: opts.onPartial,
    timeoutMs: BASH_TIMEOUT_MS,
  });

  if (result.timedOut) {
    return err(
      call.id,
      `Command exceeded the ${BASH_TIMEOUT_MS / 1000}s timeout. The shell stays alive — your environment (cwd, env vars) is preserved for the next call. Partial output:\n${result.stdout}${result.stderr ? '\n[stderr]\n' + result.stderr : ''}`,
    );
  }

  const { exitCode, stdout, stderr } = result;
  let out =
    `exit ${exitCode}\n` +
    (stdout ? `--- stdout ---\n${stdout}` : '') +
    (stderr ? `--- stderr ---\n${stderr}` : '');

  // Post-bash hook: transform the result before the model sees it.
  // Returning empty stdout = passthrough (most hooks are gates, not
  // transformers, so the empty case is the common one).
  const postHook = await runHook({
    workspace: opts.workspace,
    event: 'post_bash',
    input: {
      command,
      exitCode,
      stdout,
      stderr,
    },
  });
  if (postHook.message) {
    out = postHook.message;
  }
  if (preHook.message) {
    out = `[pre_bash hook]\n${preHook.message}\n\n${out}`;
  }

  return exitCode === 0 && !postHook.hookErrored
    ? ok(call.id, out)
    : { tool_use_id: call.id, content: out, is_error: true };
}

// Per-job byte offset cache so consecutive bash_status calls only
// return delta output (not the same buffer over and over). Keyed by
// job_id; lives only in this process — restart loses the cursor and
// the next bash_status returns full history, which is fine.
const bgJobOffsets = new Map<string, number>();

async function runBashStatus(
  call: ToolCall,
  opts: ExecuteOpts,
): Promise<ToolResult> {
  const input = call.input as { job_id?: unknown };
  const jobId = typeof input.job_id === 'string' ? input.job_id : '';
  if (!jobId) return err(call.id, 'job_id required');

  let result;
  try {
    result = await checkBgJob({
      jobId,
      workspace: opts.workspace,
      sinceOffset: bgJobOffsets.get(jobId) ?? 0,
    });
  } catch (e) {
    return err(call.id, e instanceof Error ? e.message : 'unknown bg job');
  }
  bgJobOffsets.set(jobId, result.totalOffset);

  const lines: string[] = [];
  lines.push(`status: ${result.stillRunning ? 'running' : 'finished'}`);
  if (!result.stillRunning && result.exitCode != null) {
    lines.push(`exit: ${result.exitCode}`);
  }
  if (result.stdout) {
    lines.push(`--- new output ---\n${result.stdout}`);
  } else if (result.stillRunning) {
    lines.push('(no new output since last check)');
  }
  const out = lines.join('\n');
  return result.stillRunning || result.exitCode === 0
    ? ok(call.id, out)
    : { tool_use_id: call.id, content: out, is_error: true };
}

// ─── Browser executor ──────────────────────────────────────────────
//
// Thin shim: every browser_X tool maps to one Playwright MCP tool
// call (sometimes with arg renaming). We resolve the MCP `content`
// array down to a single string for the model — text content joined
// with newlines, image content surfaced as a base64 marker the chat
// surface picks up and renders inline.
//
// Errors: callBrowserTool throws when the sidecar is dead or
// unreachable; we catch and surface as is_error so the model sees
// the failure (with the actual stderr from Playwright, when we have
// it) instead of qcode just hanging.

async function runBrowser(call: ToolCall): Promise<ToolResult> {
  if (!isTauri()) {
    return err(call.id, 'browser tools require the qcode desktop app.');
  }
  const input = (call.input as Record<string, unknown>) ?? {};
  let mcpName: string;
  let mcpArgs: Record<string, unknown> = {};
  switch (call.name) {
    case 'browser_navigate':
      mcpName = 'browser_navigate';
      mcpArgs = { url: input.url };
      break;
    case 'browser_snapshot':
      mcpName = 'browser_snapshot';
      break;
    case 'browser_screenshot':
      // Playwright MCP's tool is `browser_take_screenshot`; `raw:true`
      // returns PNG base64 in the content array (vs. saving to disk).
      mcpName = 'browser_take_screenshot';
      mcpArgs = {
        raw: true,
        ...(input.full_page === true ? { fullPage: true } : {}),
      };
      break;
    case 'browser_click':
      mcpName = 'browser_click';
      mcpArgs = { element: input.element, ref: input.ref };
      break;
    case 'browser_type':
      mcpName = 'browser_type';
      mcpArgs = {
        element: input.element,
        ref: input.ref,
        text: input.text,
        ...(input.submit === true ? { submit: true } : {}),
      };
      break;
    case 'browser_console':
      mcpName = 'browser_console_messages';
      break;
    default:
      return err(call.id, `Unknown browser tool: ${call.name}`);
  }

  let result;
  try {
    result = await callBrowserTool(mcpName, mcpArgs);
  } catch (e) {
    return err(call.id, e instanceof Error ? e.message : 'browser call failed');
  }

  const text = textOf(result.content);
  const img = firstImage(result.content);
  // Embed images using a sentinel the chat surface picks up. The
  // model never sees raw base64 (would blow context) — it sees a
  // placeholder noting the screenshot was captured, the UI strips
  // the placeholder and renders the image. is_error pushes the model
  // toward retrying / debugging when the MCP layer reports failure.
  const summary = img
    ? `${text || '(no text content)'}\n[qcode:image:${img.mimeType}:${img.data}]`
    : text || '(no content)';
  return {
    tool_use_id: call.id,
    content: summary,
    is_error: !!result.isError,
  };
}

// ─── Verify ────────────────────────────────────────────────────────
//
// Runs the project's check command. Detection is intentionally
// simple — most projects fall into one of three cases (qcode.md
// directive, package.json scripts, lang default), and a fourth
// "couldn't tell" path that asks the user to configure. We don't
// cache: re-detect each call so adding a script or editing qcode.md
// takes effect on the next verify without a session restart.

const VERIFY_TIMEOUT_MS = 360_000; // 6 min — same as bash; covers a real test run

async function runVerify(
  call: ToolCall,
  opts: ExecuteOpts,
): Promise<ToolResult> {
  const resolved = await resolveVerifyCommand(opts.workspace);
  if (!resolved) {
    return err(
      call.id,
      "No verify command could be detected. Add a `verify: <command>` line to qcode.md, OR add a `check`/`typecheck`/`test`/`lint` script to package.json. Until then, run your check manually with bash and tell the user what command they should set as the project's verify.",
    );
  }
  const result = await runBashSession({
    workspace: opts.workspace,
    command: resolved.command,
    onPartial: opts.onPartial,
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  if (result.timedOut) {
    return err(
      call.id,
      `Verify (${resolved.source}: ${resolved.command}) exceeded ${VERIFY_TIMEOUT_MS / 1000}s. Partial output:\n${result.stdout}${result.stderr ? '\n[stderr]\n' + result.stderr : ''}`,
    );
  }
  const passed = result.exitCode === 0;
  const head =
    `verify (${resolved.source}): ${resolved.command}\n` +
    `${passed ? 'PASSED' : `FAILED (exit ${result.exitCode})`}\n`;
  const body =
    (result.stdout ? `--- stdout ---\n${result.stdout}` : '') +
    (result.stderr ? `${result.stdout ? '\n' : ''}--- stderr ---\n${result.stderr}` : '');
  return passed
    ? ok(call.id, head + body)
    : err(call.id, head + body);
}

type VerifyResolved = {
  command: string;
  /** Where the command came from. Shown in the result so the model
   *  + the user can both see why this command ran. */
  source: 'qcode.md' | 'package.json' | 'cargo' | 'go' | 'python';
};

async function resolveVerifyCommand(
  workspace: string,
): Promise<VerifyResolved | null> {
  if (!isTauri()) return null;

  // 1. qcode.md `verify:` line — explicit user override always wins.
  const memCmd = await readQcodeMdVerify(workspace);
  if (memCmd) return { source: 'qcode.md', command: memCmd };

  // 2. package.json scripts in priority order.
  const pkgCmd = await readPackageJsonVerify(workspace);
  if (pkgCmd) return { source: 'package.json', command: pkgCmd };

  // 3. Language defaults — only when the project file exists. Order:
  //    Rust → Go → Python (likely-correct) — first hit wins. Skipped
  //    for projects that ship none of these.
  const { exists } = await import('@tauri-apps/plugin-fs');
  if (await exists(`${workspace}/Cargo.toml`)) {
    return { source: 'cargo', command: 'cargo check' };
  }
  if (await exists(`${workspace}/go.mod`)) {
    return { source: 'go', command: 'go build ./...' };
  }
  if (await exists(`${workspace}/pyproject.toml`)) {
    return { source: 'python', command: 'python -m compileall -q .' };
  }
  return null;
}

async function readQcodeMdVerify(workspace: string): Promise<string | null> {
  const { readTextFile } = await import('@tauri-apps/plugin-fs');
  const { findConfigFiles } = await import('./qcode-paths');
  // Look across the same tiered surfaces as the main memory loader:
  // root-level qcode.md/CLAUDE.md/QCODE.md AND inside .qcode/.qlaud/
  // .claude/. First file with a `verify:` line wins.
  const candidates: Array<{ path: string }> = [];
  for (const name of ['qcode.md', 'QCODE.md', 'CLAUDE.md']) {
    const found = await findConfigFiles({
      workspace,
      relativeName: name,
      alsoAtRoot: true,
    });
    candidates.push(...found);
  }
  for (const c of candidates) {
    let raw: string;
    try {
      raw = await readTextFile(c.path);
    } catch {
      continue;
    }
    // Match `verify: <cmd>` on its own line. Anchored to start-of-line
    // so a markdown sentence "to verify: run pnpm test" doesn't match.
    const m = /^[ \t]*verify:[ \t]*(.+?)[ \t]*$/m.exec(raw);
    if (m && m[1]) return m[1];
  }
  return null;
}

async function readPackageJsonVerify(
  workspace: string,
): Promise<string | null> {
  const { exists, readTextFile } = await import('@tauri-apps/plugin-fs');
  const path = `${workspace}/package.json`;
  if (!(await exists(path))) return null;
  let raw: string;
  try {
    raw = await readTextFile(path);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const scripts =
    parsed && typeof parsed === 'object' && parsed !== null
      ? ((parsed as { scripts?: Record<string, string> }).scripts ?? null)
      : null;
  if (!scripts) return null;
  const pm = await detectPackageManager(workspace);
  for (const name of ['check', 'typecheck', 'test', 'lint']) {
    if (typeof scripts[name] === 'string') return `${pm} run ${name}`;
  }
  return null;
}

async function detectPackageManager(workspace: string): Promise<'pnpm' | 'npm' | 'yarn' | 'bun'> {
  const { exists } = await import('@tauri-apps/plugin-fs');
  if (await exists(`${workspace}/pnpm-lock.yaml`)) return 'pnpm';
  if (await exists(`${workspace}/yarn.lock`)) return 'yarn';
  if (await exists(`${workspace}/bun.lockb`)) return 'bun';
  return 'npm';
}

// ─── Path helpers ──────────────────────────────────────────────────

function resolveInWorkspace(input: string, workspace: string): string | null {
  if (!input) return null;
  let p = input.replace(/^\.\/+/, '');
  if (p === '.') p = '';
  const isAbsolute = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
  const joined = isAbsolute ? p : workspace + '/' + p;
  const norm = normalize(joined);
  const wsNorm = normalize(workspace);
  if (norm !== wsNorm && !norm.startsWith(wsNorm + '/')) return null;
  return norm;
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split(/[/\\]+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  const lead = p.startsWith('/') ? '/' : '';
  return lead + out.join('/');
}

function relativizePath(abs: string, workspace: string): string {
  const ws = normalize(workspace);
  if (abs === ws) return '.';
  if (abs.startsWith(ws + '/')) return abs.slice(ws.length + 1);
  return abs;
}

// Glob → regex. Supports **, *, ?, and { , } alternation. Scoped to
// what the agent emits in practice; not a full-shell glob impl.
function globToRegex(pattern: string): RegExp {
  let i = 0;
  let out = '^';
  while (i < pattern.length) {
    const c = pattern[i] ?? '';
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        out += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if (c === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        out += '\\{';
        i++;
        continue;
      }
      const alts = pattern.slice(i + 1, close).split(',');
      out += '(?:' + alts.map(escapeRe).join('|') + ')';
      i = close + 1;
    } else if ('.+()|[]{}^$\\'.includes(c)) {
      out += '\\' + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  out += '$';
  return new RegExp(out);
}

function escapeRe(s: string): string {
  return s.replace(/[.+()|[\]{}^$\\*?]/g, '\\$&');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

async function walkDir(
  start: string,
  root: string,
  re: RegExp,
  out: string[],
  matcher: IgnoreMatcher,
): Promise<void> {
  if (out.length >= MAX_GLOB_MATCHES) return;
  const { readDir } = await import('@tauri-apps/plugin-fs');
  let entries;
  try {
    entries = await readDir(start);
  } catch {
    return;
  }
  for (const e of entries) {
    const childAbs = start + '/' + e.name;
    const rel = relativizePath(childAbs, root);
    if (matcher(rel, e.isDirectory)) continue;
    if (e.isDirectory) {
      await walkDir(childAbs, root, re, out, matcher);
    } else if (re.test(rel)) {
      out.push(rel);
    }
    if (out.length >= MAX_GLOB_MATCHES) return;
  }
}

// ─── Result helpers ────────────────────────────────────────────────

function ok(id: string, content: string): ToolResult {
  return { tool_use_id: id, content };
}

function err(id: string, content: string): ToolResult {
  return { tool_use_id: id, content, is_error: true };
}

function badPath(id: string, requested: string): ToolResult {
  return err(
    id,
    `Path "${requested}" is not inside the open workspace. Pass a relative path (e.g. "src/main.ts") or an absolute path that starts with the workspace root.`,
  );
}
