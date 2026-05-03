// Named agents — the orchestrator's roster.
//
// Replaces the old "task spawns a generic subagent" model with a
// registry of specialized agents. The main agent (orchestrator) picks
// from this list when delegating; each agent has a focused tool subset
// and (server-side) a focused system prompt. Mirrors how Claude Code
// dispatches Explore / Plan / general-purpose / etc.: small named
// agents with clear roles beat one anonymous subagent every time
// because the orchestrator can reason about WHICH agent fits the work.
//
// Why not user-defined yet: shipping a fixed roster first lets us
// shape the prompt format + tool gating in one place, then promote
// to .qcode/agents/<name>.md once the shape is stable.
//
// The matching server-side prompts live in
// apps/edge/src/lib/qcode-agents.ts. Client picks the tool subset +
// metadata; server picks the persona prompt. Two halves, joined by
// agent_type passed through qlaud_runtime.

export type AgentType =
  | 'explorer'
  | 'verifier'
  | 'builder'
  | 'planner'
  | 'reviewer';

export type AgentDef = {
  type: AgentType;
  /** UI label, capitalized. */
  label: string;
  /** One-line description shown to the orchestrator in the task tool
   *  description so the model knows when to dispatch this agent. */
  description: string;
  /** Tool names this agent has access to. The dispatcher filters
   *  ALL_TOOLS to this subset before passing to runThreadAgent. */
  toolNames: string[];
  /** When true, route to settings.subagentModel (typically a cheaper
   *  model). When false/undefined, inherit the parent's model. Use
   *  cheap for bounded scout work; flagship for anything that needs
   *  judgment (planning, reviewing). */
  useCheapModel: boolean;
  /** Per-turn iteration cap for this agent. Pattern from Claude Code:
   *  the cap is bounded explicitly per agent type rather than a
   *  global default. Builder needs the most (scaffold + multi-file
   *  edits + verify can chain 100+ tool calls); read-only agents
   *  cap lower because their work is bounded by definition.
   *  Effectively unbounded if the model produces a long chain — the
   *  doom-loop detector + token budget cap are the real ceilings. */
  maxIterations: number;
};

// Tool subsets — declared once here so the server prompt + the
// dispatcher both see the same source of truth. read-only set
// excludes write_file / edit_file / bash so the agent literally
// can't mutate the workspace.
//
// `skill` is included in every agent's toolset because skills are
// project-defined playbooks that may be relevant regardless of role
// (an Explorer benefits from a "how-this-codebase-is-organized"
// skill just as much as a Builder does).
const READ_ONLY = ['list_files', 'read_file', 'glob', 'grep', 'skill'];
const READ_AND_BROWSE = [
  ...READ_ONLY,
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_console',
];
const FULL_BUILD = [
  ...READ_AND_BROWSE,
  'browser_click',
  'browser_type',
  'write_file',
  'edit_file',
  'bash',
  'bash_status',
  'verify',
  'todo_write',
];

export const AGENTS: Record<AgentType, AgentDef> = {
  explorer: {
    type: 'explorer',
    label: 'Explorer',
    description:
      "Investigate the codebase. Read-only — list_files, read_file, glob, grep, browser_*. Use for 'find every reference to X', 'map the auth layer', 'what does module Y do'. Returns a tight markdown summary with file:line citations.",
    toolNames: READ_AND_BROWSE,
    useCheapModel: true,
    maxIterations: 100,
  },
  verifier: {
    type: 'verifier',
    label: 'Verifier',
    description:
      "Confirm the work landed correctly after a write or scaffold. Has verify + read tools + bash for inspection. Use after the orchestrator finishes a code change, or when a foreground command timed out and you want to know if it actually completed. Reports PASS/FAIL with specifics.",
    toolNames: ['verify', 'read_file', 'glob', 'list_files', 'bash', 'bash_status'],
    useCheapModel: true,
    maxIterations: 50,
  },
  builder: {
    type: 'builder',
    label: 'Builder',
    description:
      'Execute a self-contained subtask end-to-end with full toolkit (write, edit, bash, browser, verify). Use for "scaffold X", "add feature Y", "refactor Z" — anything where the subagent owns the whole loop. Returns a one-paragraph summary of what changed.',
    toolNames: FULL_BUILD,
    useCheapModel: false,
    maxIterations: 200,
  },
  planner: {
    type: 'planner',
    label: 'Planner',
    description:
      "Investigate, then return a concrete file-by-file plan. Read-only. Use when the user asks 'how should we approach X' or before kicking off a Builder for an ambiguous change. Quotes existing code; never edits.",
    toolNames: READ_ONLY,
    useCheapModel: false,
    maxIterations: 100,
  },
  reviewer: {
    type: 'reviewer',
    label: 'Reviewer',
    description:
      'Audit a surface for bugs, security issues, or style violations. Read-only. Returns findings with file:line and severity (high/medium/low). Use for "audit src/auth for OWASP issues", "review my recent changes".',
    toolNames: READ_ONLY,
    useCheapModel: true,
    maxIterations: 75,
  },
};

/** Default iteration cap for the orchestrator (parent) agent. Higher
 *  than any single subagent because the parent dispatches multiple
 *  subagents + does its own work. Pattern from Claude Code:
 *  effectively unbounded except by the doom-loop detector + token
 *  budget. Set high enough that real coding sessions don't bump it. */
export const ORCHESTRATOR_MAX_ITERATIONS = 200;

/** All agent types the orchestrator can dispatch. Used in the task
 *  tool's input schema enum. */
export const AGENT_TYPES: AgentType[] = Object.keys(AGENTS) as AgentType[];

/** Default agent when the model omits agent_type (back-compat with
 *  pre-registry calls). Builder = today's "task spawns a generic
 *  agent with full tools" behavior. */
export const DEFAULT_AGENT_TYPE: AgentType = 'builder';

/** Resolve a string from the model into a known AgentType, falling
 *  back to default if the model emitted something off-roster. */
export function resolveAgentType(input: unknown): AgentType {
  return typeof input === 'string' && (AGENT_TYPES as string[]).includes(input)
    ? (input as AgentType)
    : DEFAULT_AGENT_TYPE;
}
