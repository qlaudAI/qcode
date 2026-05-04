// User-level preferences. Local to the install — no sync with qlaud
// today. We deliberately keep this small so the Settings UI doesn't
// turn into a kitchen sink; everything here has a clear "if I change
// this, what visibly happens?" answer.

import { DEFAULT_MODEL } from './models';

const STORAGE_KEY = 'qcode.settings';

/** Plan mode: model only sees read-only tools, system prompt
 *  steers it toward investigation + proposal. Useful for safe
 *  exploration of unfamiliar code or when the user wants to
 *  approve every step manually before any tools fire. */
export type AgentMode = 'agent' | 'plan';

/** Theme preference. 'system' (default) follows the OS dark-mode
 *  pref via prefers-color-scheme; 'light' / 'dark' force the
 *  matching palette regardless. Settings is the source of truth;
 *  `applyTheme` toggles the .dark class on <html> at boot + on
 *  settings change. */
export type Theme = 'system' | 'light' | 'dark';

/** Auto-approve posture for tool execution. Single tri-state instead
 *  of N booleans because the user actually thinks about this in
 *  three modes — full auto, sensible defaults, watch every step —
 *  and exposing two checkboxes (workspaceEdits + safeBash) made the
 *  states inconsistent ("safe-bash on but workspace-edits off" is
 *  nonsensical for an agent that has to read your code to write to
 *  it). The deny-list (rm -rf /, sudo, fork bombs, curl|sh) ALWAYS
 *  applies regardless of mode — yolo doesn't disable the safety net.
 *
 *  - yolo:   auto-approve every write_file / edit_file / bash, even
 *            commands that aren't on the safe-bash whitelist. For
 *            users who trust the agent and have git as their undo.
 *  - smart:  auto-approve workspace writes + the safe-bash whitelist.
 *            Anything outside the whitelist (commit, push, merge,
 *            destructive ops) prompts. Background bash always prompts
 *            so dev servers don't spawn behind your back.
 *  - strict: ask for everything. The "watch every step" mode for
 *            unfamiliar codebases or live demos. */
export type AutoApproveMode = 'yolo' | 'smart' | 'strict';

/** Output style controls how the agent formats its prose responses.
 *  Doesn't change tool behavior — only the style of explanatory text
 *  between tool calls + the final response.
 *
 *  - default:  full prose, code-fenced snippets, headings as needed.
 *              Best for learning + complex tasks where you want the
 *              full reasoning visible.
 *  - compact:  tight summaries, no preamble, results-first. Best for
 *              power users who want fewer tokens spent on prose and
 *              more on tool execution.
 *  - explain:  expand reasoning, narrate decisions, include "why"
 *              for choices. Best for unfamiliar codebases or learning. */
export type OutputStyle = 'default' | 'compact' | 'explain';

/** Engine Mode: which agent runtime drives a turn.
 *  - 'qcode-legacy' — the homegrown loop in src/lib/legacy/agent.ts
 *    routed through qlaud's streaming-with-tools edge handler.
 *    Slated for deletion once Engine Mode wraps cover all flows.
 *  - 'claude-code' — spawn the official `claude` CLI in the workspace
 *    with ANTHROPIC_BASE_URL=qlaud. Anthropic's loop, qlaud's gateway.
 *    Codex / Qwen Code / Aider land as additional members of this
 *    union once their adapters ship.
 *  Per-workspace would be ideal eventually, but for v0 a global
 *  setting keeps the wiring simple — flip the toggle, all sends use
 *  the chosen engine. */
export type Engine = 'qcode-legacy' | 'claude-code';

export type Settings = {
  /** Model picked when a new chat is created. The title-bar dropdown
   *  still lets the user override per-thread. */
  defaultModel: string;
  /** Auto-fetch + install updates on launch. Default on. */
  autoUpdate: boolean;
  /** agent — full tool kit including write_file/edit_file/bash.
   *  plan  — read tools only; model proposes changes in prose. */
  mode: AgentMode;
  /** When on, qcode passes `tools_mode: 'dynamic'` to qlaud so the
   *  model gets the 4 meta-tools (qlaud_search_tools, etc.) for
   *  discovering and calling MCP tools the user connected on the
   *  qlaud dashboard. Coexists with the 7 local tools — they ride
   *  alongside the meta-tools in the same request. Off by default
   *  because most users don't have connectors configured yet. */
  enableConnectors: boolean;
  /** Model used for `task` subagent spawns. Subagents do bounded
   *  scout work (find auth files, audit imports, summarize a
   *  module) — they don't need the same firepower as the parent.
   *  Default: a cheap model. Set to null to use the parent's model
   *  (the old behavior). The user picks in Settings → Subagent.
   *
   *  Cost math: a 5-call planning loop on Opus + 4 subagent dives
   *  on Opus is ~$0.50. Same on Opus parent + DeepSeek-Chat
   *  subagents is ~$0.12 — same final answer, 4x cheaper. */
  subagentModel: string | null;
  /** Theme — 'system' follows the OS pref, 'light' / 'dark' lock it. */
  theme: Theme;
  /** Auto-approve mode. See AutoApproveMode for the three values.
   *  Default 'smart' because the deny-list still gates dangerous
   *  ops and asking for every read is a worse experience than
   *  letting the agent move. */
  autoApprove: AutoApproveMode;
  /** Auto-commit per agent turn. After each turn that wrote files,
   *  qcode runs `git add -A && git commit` on the user's current
   *  branch. Author is `qcode <bot@qlaud.ai>` so manual vs. agent
   *  commits stay distinguishable. Skipped when the working tree
   *  had pre-existing uncommitted changes at turn start, when the
   *  workspace isn't a git repo, when HEAD is detached, or when a
   *  merge/rebase is in progress — auto-committing through any of
   *  those would mix work or confuse the merge state machine.
   *  Never pushes to remote; that stays the user's call.
   *
   *  Default off — opt-in. When users like it we can flip the
   *  default; pushing it on by default risks surprising people who
   *  weren't watching. */
  autoCommit: boolean;
  /** Style for the agent's prose responses. See OutputStyle docs.
   *  Forwarded to the server in qlaud_runtime so the system prompt
   *  reflects the choice. */
  outputStyle: OutputStyle;
  /** Which agent runtime drives a turn. See Engine doc. */
  engine: Engine;
  /** Per-thread Claude Code session id, persisted so multi-turn
   *  conversations chain via `claude --resume <id>`. Claude Code owns
   *  the conversation state on disk (`~/.claude/projects/...`); qcode
   *  just remembers the handle. Keyed by qcode threadId. */
  claudeSessionByThread?: Record<string, string>;
};

const DEFAULT_SUBAGENT_MODEL = 'claude-haiku-4-5';

const DEFAULTS: Settings = {
  defaultModel: DEFAULT_MODEL,
  autoUpdate: true,
  mode: 'agent',
  enableConnectors: false,
  subagentModel: DEFAULT_SUBAGENT_MODEL,
  theme: 'system',
  autoApprove: 'smart',
  autoCommit: false,
  outputStyle: 'default',
  // Default stays legacy until Engine Mode is proven on real users.
  // The wrap path (claude-code) ships dark via the engine picker.
  engine: 'qcode-legacy',
};

/** Coerce the stored autoApprove value to a tri-state mode. Handles
 *  three cases:
 *    1. Already a string — pass through if valid, fall back to default.
 *    2. Old { workspaceEdits, safeBash } object — map both-true→smart,
 *       both-false→strict, mixed→smart (close enough; previous mixed
 *       states were a UI inconsistency anyway).
 *    3. Anything else — default. */
function coerceAutoApprove(v: unknown): AutoApproveMode {
  if (v === 'yolo' || v === 'smart' || v === 'strict') return v;
  if (v && typeof v === 'object') {
    const obj = v as { workspaceEdits?: unknown; safeBash?: unknown };
    if (obj.workspaceEdits === false && obj.safeBash === false) return 'strict';
    return 'smart';
  }
  return DEFAULTS.autoApprove;
}

export function getSettings(): Settings {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings> & {
      autoApprove?: unknown;
    };
    return {
      ...DEFAULTS,
      ...parsed,
      autoApprove: coerceAutoApprove(parsed.autoApprove),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function patchSettings(p: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...p };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  // Apply theme immediately so users see the swap on click,
  // not after the next reload.
  if (p.theme) applyTheme(next.theme);
  return next;
}

// ─── Theme application ────────────────────────────────────────────

/** Toggle the .dark class on <html> based on the resolved theme.
 *  Idempotent — safe to call repeatedly. Hooks the OS pref via
 *  matchMedia so 'system' tracks the user's flip without a reload.
 *  Returns the matchMedia listener so callers can clean it up,
 *  but the boot path leaks it intentionally — there's only one. */
let mqlCleanup: (() => void) | null = null;

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  // Tear down any prior system listener — switching from 'system'
  // to 'light' must stop reacting to OS flips.
  if (mqlCleanup) {
    mqlCleanup();
    mqlCleanup = null;
  }
  const html = document.documentElement;
  const apply = (dark: boolean) => {
    html.classList.toggle('dark', dark);
  };
  if (theme === 'system' && typeof window !== 'undefined') {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    apply(mql.matches);
    const listener = (e: MediaQueryListEvent) => apply(e.matches);
    mql.addEventListener('change', listener);
    mqlCleanup = () => mql.removeEventListener('change', listener);
    return;
  }
  apply(theme === 'dark');
}
