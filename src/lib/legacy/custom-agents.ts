// User-defined agents discovered from disk. Mirror of skills.ts but
// for the `task` tool's named-agent dispatch instead of on-demand
// content loading.
//
// Drop a markdown file at `.qcode/agents/<name>.md` (or `.qlaud/`,
// `.claude/`, or user-tier `~/.qlaud/`, `~/.claude/`) with a YAML
// frontmatter declaring the agent + the system prompt body. The
// `task` tool sees built-in agents (Explorer / Verifier / Builder /
// Planner / Reviewer) AND every custom agent the workspace defines,
// so power users extend the roster without code changes.
//
// File format:
//   ---
//   name: code-reviewer        (the dispatch token; required)
//   description: One-line role (REQUIRED — model uses this to pick)
//   tools: [read_file, grep, glob, bash, verify]  (optional; default = read-only set)
//   model: claude-haiku-4-5    (optional; reserved for future per-agent model swap)
//   ---
//   You are Code Reviewer. <freeform system prompt body — what the
//   agent's role is, how it should respond, return format, etc.>
//
// Tool filtering: if `tools` is specified in frontmatter, only those
// tools are exposed to the agent. If absent, the read-only set
// (list_files / read_file / glob / grep + skill + browser_*) is the
// safe default — custom agents don't get write access unless they
// ask for it explicitly.

import { asString, asStringArray, parseDocument } from './frontmatter';
import { listConfigDir } from './qcode-paths';
import { isTauri } from '../tauri';

/** Tools a custom agent gets when frontmatter doesn't list any —
 *  read-only investigation set. Mirrors the Explorer agent's posture:
 *  conservative by default, write tools require explicit opt-in. */
const DEFAULT_CUSTOM_AGENT_TOOLS = [
  'list_files',
  'read_file',
  'glob',
  'grep',
  'skill',
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_console',
];

export type CustomAgent = {
  /** Dispatch token. Lowercased, hyphenated. Must not collide with
   *  built-ins (explorer / verifier / builder / planner / reviewer);
   *  collisions are ignored — built-in wins. */
  name: string;
  /** One-line description shown to the orchestrator so it knows when
   *  to dispatch this agent. */
  description: string;
  /** Tool name allowlist. Empty = use DEFAULT_CUSTOM_AGENT_TOOLS. */
  tools: string[];
  /** Optional preferred model slug. Not currently enforced. */
  model: string;
  /** System prompt body the agent runs with. */
  body: string;
  /** Source path for UI / debugging. */
  source: string;
};

const BUILTIN_NAMES = new Set([
  'explorer',
  'verifier',
  'builder',
  'planner',
  'reviewer',
]);

const CACHE = new Map<string, CustomAgent[]>();

export async function getCustomAgents(workspace: string): Promise<CustomAgent[]> {
  if (CACHE.has(workspace)) return CACHE.get(workspace)!;
  const agents = await loadCustomAgents(workspace);
  CACHE.set(workspace, agents);
  return agents;
}

export function clearCustomAgentsCache(workspace?: string): void {
  if (workspace === undefined) CACHE.clear();
  else CACHE.delete(workspace);
}

async function loadCustomAgents(workspace: string): Promise<CustomAgent[]> {
  if (!isTauri()) return [];
  const files = await listConfigDir({
    workspace,
    directoryName: 'agents',
    extensions: ['.md'],
  });
  if (files.length === 0) return [];

  const { readTextFile } = await import('@tauri-apps/plugin-fs');
  const agents: CustomAgent[] = [];
  const seenNames = new Set<string>();

  for (const f of files) {
    let raw: string;
    try {
      raw = await readTextFile(f.path);
    } catch {
      continue;
    }
    const { frontmatter, body } = parseDocument(raw);
    const description = asString(frontmatter.description).trim();
    if (!description) continue;

    const fileName = f.path.split('/').pop() ?? '';
    const fileBase = fileName.replace(/\.md$/i, '');
    const folderName = f.path.split('/').slice(-2, -1)[0] ?? '';
    const inferredName =
      fileBase.toUpperCase() === 'AGENT' ? folderName : fileBase;
    const rawName = (asString(frontmatter.name) || inferredName).trim();
    const name = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!name || BUILTIN_NAMES.has(name) || seenNames.has(name)) continue;
    seenNames.add(name);

    const declaredTools = asStringArray(frontmatter.tools);
    const tools = declaredTools.length > 0 ? declaredTools : DEFAULT_CUSTOM_AGENT_TOOLS;
    if (!body.trim()) continue; // an agent with no system prompt is useless

    agents.push({
      name,
      description,
      tools,
      model: asString(frontmatter.model).trim(),
      body: body.trim(),
      source: f.displayPath,
    });
  }
  return agents;
}

/** Look up a custom agent by name. Used by the dispatcher when the
 *  model emits `task({agent_type: 'code-reviewer', ...})` and
 *  'code-reviewer' isn't a built-in. */
export function findCustomAgent(
  agents: CustomAgent[],
  name: string,
): CustomAgent | null {
  const trimmed = name.trim().toLowerCase();
  return agents.find((a) => a.name === trimmed) ?? null;
}

/** Markdown bullet list of custom agents for inclusion in the
 *  orchestrator's task-tool description, alongside built-in agents.
 *  Empty string when no custom agents exist. */
export function customAgentsRoster(agents: CustomAgent[]): string {
  if (agents.length === 0) return '';
  return (
    '\n\nCustom agents in this workspace:\n' +
    agents.map((a) => `- **${a.name}** — ${a.description}`).join('\n')
  );
}
