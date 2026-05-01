// qcode's tool catalog. The agent loop sends these definitions to
// qlaud (Anthropic-shape), the model returns tool_use blocks, the
// executors below handle them, and the loop sends tool_result back.
//
// Phase 1 ships only READ-ONLY tools — list_files, read_file. Anything
// that mutates the filesystem (write_file, edit_file, delete_file)
// or runs arbitrary code (bash, run_command) lives in a separate
// catalog gated behind the approval UI we'll build next sprint. The
// safety boundary is enforced here at definition time, not at
// runtime: the dangerous tools simply aren't exported into the agent
// loop's tool list yet.

import { isTauri } from './tauri';

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

// ─── Tool definitions (sent to the model) ──────────────────────────

export const READ_TOOLS: ToolDef[] = [
  {
    name: 'list_files',
    description:
      'List files and directories at the given path inside the user\'s open workspace. Returns up to 200 entries; if the directory has more, the result is truncated. Use this to discover the project structure before reading specific files.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute path inside the workspace, or a path relative to the workspace root. Use "." for the workspace root.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read the full contents of a text file inside the workspace. Returns the file body. Files larger than 200 KB are rejected — use grep or list_files to narrow first.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute path inside the workspace, or a path relative to the workspace root.',
        },
      },
      required: ['path'],
    },
  },
];

// ─── Tool executors (run in qcode, called by the agent loop) ───────

const MAX_FILE_BYTES = 200 * 1024;
const MAX_LIST_ENTRIES = 200;

export type ExecuteOpts = {
  /** Workspace root — every relative path is resolved against this. */
  workspace: string;
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
      default:
        return {
          tool_use_id: call.id,
          content: `Unknown tool: ${call.name}`,
          is_error: true,
        };
    }
  } catch (e) {
    return {
      tool_use_id: call.id,
      content: e instanceof Error ? e.message : String(e),
      is_error: true,
    };
  }
}

async function runListFiles(
  call: ToolCall,
  opts: ExecuteOpts,
): Promise<ToolResult> {
  const input = call.input as { path?: unknown };
  const requested = typeof input.path === 'string' ? input.path : '.';
  const abs = resolveInWorkspace(requested, opts.workspace);
  if (!abs) {
    return badPath(call.id, requested);
  }
  if (!isTauri()) {
    // Browser-mode dev: stub out so the agent flow is still testable
    // visually, even without the OS bridge.
    return {
      tool_use_id: call.id,
      content: `[browser-mode stub for ${abs}]\nsrc/\npackage.json\nREADME.md`,
    };
  }
  const { readDir } = await import('@tauri-apps/plugin-fs');
  const entries = await readDir(abs);
  const sliced = entries.slice(0, MAX_LIST_ENTRIES);
  const lines = sliced.map((e) => (e.isDirectory ? `${e.name}/` : e.name));
  const trailer =
    entries.length > MAX_LIST_ENTRIES
      ? `\n…(${entries.length - MAX_LIST_ENTRIES} more entries truncated)`
      : '';
  return {
    tool_use_id: call.id,
    content: `${lines.join('\n')}${trailer}`,
  };
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
    return {
      tool_use_id: call.id,
      content: `[browser-mode stub: would read ${abs}]`,
    };
  }
  const { stat, readTextFile } = await import('@tauri-apps/plugin-fs');
  const info = await stat(abs);
  if (info.size != null && info.size > MAX_FILE_BYTES) {
    return {
      tool_use_id: call.id,
      content: `File too large (${info.size} bytes; limit is ${MAX_FILE_BYTES}). Use grep to narrow the read.`,
      is_error: true,
    };
  }
  const text = await readTextFile(abs);
  return { tool_use_id: call.id, content: text };
}

// ─── Path safety ────────────────────────────────────────────────────

function resolveInWorkspace(input: string, workspace: string): string | null {
  if (!input) return null;
  // Strip leading ./ for prettier display; absolute paths are checked
  // for the workspace prefix below.
  let p = input.replace(/^\.\/+/, '');
  if (p === '.') p = '';
  const isAbsolute = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
  const joined = isAbsolute ? p : workspace + '/' + p;
  // Refuse anything that escapes the workspace via traversal.
  // Tauri's fs plugin enforces its own sandbox too — this is just
  // defense in depth + a clearer error message for the model.
  const norm = normalize(joined);
  const wsNorm = normalize(workspace);
  if (norm !== wsNorm && !norm.startsWith(wsNorm + '/')) return null;
  return norm;
}

function normalize(p: string): string {
  // Minimal POSIX-style normalize. Good enough for our path checks
  // since both inputs come from controlled sources (workspace = OS-
  // picked path; input = model output we already filter).
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

function badPath(id: string, requested: string): ToolResult {
  return {
    tool_use_id: id,
    content: `Path "${requested}" is not inside the open workspace. Pass a relative path (e.g. "src/main.ts") or an absolute path that starts with the workspace root.`,
    is_error: true,
  };
}
