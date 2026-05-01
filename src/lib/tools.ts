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

// `task` belongs to neither READ_TOOLS nor WRITE_TOOLS — it's a
// meta-tool that delegates work to a child agent. The child runs
// with the same workspace + tools (minus task itself, no recursion)
// and returns a single text summary. Use cases:
//   - Investigations the parent doesn't want to read raw output for
//     ("find every reference to X" → child returns a summary)
//   - Fan-out: parent kicks off 3 task() calls, each handles a slice
//   - Plan-then-execute: parent plans, dispatches a task to do the
//     heavy edit work, gets a final report
//
// Implementation: client-dispatched. agent.ts intercepts the tool
// dispatch and runs streamThreadMessage against a fresh remote
// thread instead of executeTool. Approval prompts from the child
// surface in the same UI so the user always sees + approves writes.
export const TASK_TOOL: ToolDef = {
  name: 'task',
  description:
    "Spawn a sub-agent to handle a focused investigation or self-contained sub-task. The sub-agent has the same workspace and tools as you do (except it can't recurse — no nested tasks), but starts with empty context: it sees only the prompt you write. Use when:\n- The task needs extensive exploration whose intermediate output would bloat your context (\"find auth files\", \"map the routing layer\")\n- You want to fan out parallel investigations across the codebase\n- A self-contained refactor that's clearer with a fresh agent (\"replace deprecated imports across these files\")\n\nThe sub-agent's prompt must stand alone — include file paths, what to look for, and what success looks like. Returns the sub-agent's final text response. Don't use for one-shot tools like a single read_file or grep — call those directly.",
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description:
          'Short 3-7 word noun phrase shown to the user (e.g. "Audit auth flow", "Find dead exports"). Imperative.',
      },
      prompt: {
        type: 'string',
        description:
          "Self-contained prompt for the sub-agent. The sub-agent doesn't see this conversation; everything it needs has to be here.",
      },
    },
    required: ['description', 'prompt'],
  },
};

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

export const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS, TASK_TOOL];

/** Subagent-mode tool list. The child agent gets every tool the
 *  parent has EXCEPT `task` itself — recursive subagent spawning
 *  is too easy a footgun (cost runaway, confused-deputy patterns)
 *  and we have a depth-1 cap baked in by simply not exposing the
 *  tool. Read-mode subagents drop write tools too, mirroring Plan. */
export const SUBAGENT_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];
export const SUBAGENT_READ_TOOLS = [...READ_TOOLS];

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

export type ExecuteOpts = {
  /** Workspace root — every relative path is resolved against this. */
  workspace: string;
  /** Approval gate. Required for write_file / edit_file / bash; the
   *  executor returns an error if a dangerous tool is called without one. */
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Live progress callback. Currently only bash uses this — emits
   *  the full accumulated stdout/stderr-formatted text on every chunk
   *  so the UI can render it as the command runs. The agent still gets
   *  the final consolidated result via the returned ToolResult. */
  onPartial?: (text: string) => void;
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
  if (!opts.requestApproval) {
    return err(
      call.id,
      'Write tools are not enabled in this session — approval gate missing.',
    );
  }

  let before = '';
  let isNew = false;
  if (isTauri()) {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs');
    const present = await exists(abs);
    if (!present) isNew = true;
    else before = await readTextFile(abs);
  }
  const diff = computeDiff(before, content);
  const added = diff.filter((d) => d.kind === 'add').length;
  const removed = diff.filter((d) => d.kind === 'remove').length;

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

  const decision = await opts.requestApproval({
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
  if (!opts.requestApproval) {
    return err(call.id, 'Edit tools are not enabled in this session.');
  }
  if (!isTauri()) {
    return ok(call.id, `[browser-mode stub: would edit ${abs}]`);
  }

  const { exists, readTextFile, writeTextFile } = await import(
    '@tauri-apps/plugin-fs'
  );
  if (!(await exists(abs))) {
    return err(call.id, 'File does not exist; use write_file to create it.');
  }
  const before = await readTextFile(abs);
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

  const decision = await opts.requestApproval({
    kind: 'edit_file',
    path: relativizePath(abs, opts.workspace),
    diff,
    added,
    removed,
  });
  if (decision !== 'allow') {
    return ok(call.id, 'User rejected the edit. No changes made.');
  }
  await writeTextFile(abs, after);

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
  if (!opts.requestApproval) {
    return err(call.id, 'Bash is not enabled in this session.');
  }
  const runInBackground = input.run_in_background === true;

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

  const decision = await opts.requestApproval({
    kind: 'bash',
    command: runInBackground ? `[background] ${command}` : command,
    cwd: opts.workspace,
  });
  if (decision !== 'allow') {
    return ok(call.id, 'User rejected the command. Not run.');
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
