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
// Three modes the user can pick per-thread:
//   chat  — pure conversation, no sandbox provisioned, no tools.
//           Cheap (just /v1/messages roundtrips). Default for new
//           threads. Use for "explain X", "review this code I'm
//           pasting", architecture chats, etc.
//   agent — full coding agent. Sandbox container minted lazily on
//           desktop = local fs sidecar; on web = Cloudflare
//           Sandbox container. Tool calls happen for real
//           (read/write/bash/etc). Pick when you want to BUILD.
//   plan  — agent's read-only sibling. Same toolkit minus
//           write/bash; the model proposes a plan, you flip to
//           agent to execute. Useful for trust-but-verify flows
//           where you want to see the diff before anything lands.
//
// The dispatcher in ChatSurface routes chat → qcode-legacy
// (existing /v1/threads streaming, no sandbox), agent/plan →
// claude-code or sandbox-agent depending on isTauri(). Picking
// chat on web doesn't provision a sandbox, which keeps the cost
// model: only paying for compute on real coding sessions.
export type AgentMode = 'chat' | 'agent' | 'plan';

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
 *
 *  Architecture as of alpha.110:
 *  - Desktop (Tauri) → ALWAYS 'claude-code'. We bundle the bun
 *    sidecar + claude-code package, so every desktop install
 *    speaks Anthropic's loop. With the qlaud /v1/messages
 *    translation gaps closed, 12/12 catalog models work via
 *    this single engine — there's no longer a reason to expose
 *    an engine picker. getSettings() coerces the stored value
 *    on read; the SettingsDrawer hides the section.
 *  - Web → ALWAYS 'qcode-legacy'. Browsers can't spawn
 *    subprocesses, so we hit qlaud's POST /v1/threads/:id/messages
 *    instead. Despite the "legacy" name this is the canonical
 *    thin-client path: qlaud runs the LLM server-side, the
 *    browser streams SSE + dispatches `client_tools` for the
 *    pieces it can do (none in pure-browser today, but the loop
 *    is in place for future polish).
 *
 *  The type stays a union so we can rename / split later without
 *  a breaking type change; user-facing copy never says "engine"
 *  on desktop. */
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
  /** Sync agent-generated media (images, audio, video, documents)
   *  to qlaud's cross-device storage. Off by default — local-only
   *  is the privacy-preserving default; only flip on if you want
   *  generations accessible from other devices / web qcode.
   *
   *  When on, the qlaud-media skill instructs the agent to ALSO
   *  upload to qlaud cloud after saving locally to .qcode/media/.
   *  Backed by the qlaud /v1/artifacts/* routes (R2 + D1 ledger,
   *  per-tenant prefix). Pricing: $0.015/GB-mo deducted from your
   *  qlaud wallet. Local copy stays unchanged regardless. */
  mediaCloudSync: boolean;
  /** Enable the "video creator" skill — turns the agent into a
   *  professional faceless / explainer / ad / reel video editor.
   *  Off by default because the skill markdown adds ~7-8k tokens
   *  to every claude-code spawn's system prompt; users who never
   *  make video shouldn't pay that token tax.
   *
   *  When on, the agent gains the workflow + Remotion patterns +
   *  ffmpeg recipes + asset sourcing (Pexels, Pixabay, AI gen,
   *  ElevenLabs) needed to ship full videos from a brief. Wallet
   *  usage scales with the assets the agent reaches for during
   *  any given render — typically $0.30-0.50/min for explainers,
   *  $4-10/min if Sora-2 b-roll is in the mix. Tell users when
   *  about to spend > $1. */
  videoCreatorSkill: boolean;
};

const DEFAULT_SUBAGENT_MODEL = 'claude-haiku-4-5';

const DEFAULTS: Settings = {
  defaultModel: DEFAULT_MODEL,
  autoUpdate: true,
  // Default to 'chat' so first-time users get a fast, cheap
  // conversation experience and only opt into the agent (which
  // mints a sandbox / spawns a sidecar) when they want to build.
  // Power users who'd prefer to land in 'agent' mode by default
  // can flip it via the toggle and it sticks for the next thread.
  mode: 'chat',
  // Default ON. The four meta-tools (qlaud_search_tools,
  // qlaud_get_tool_schemas, qlaud_multi_execute,
  // qlaud_manage_connections) are pure-discovery — search/schemas
  // never trigger side effects, multi_execute only fires for tools
  // the user has registered + (for per-user MCPs) explicitly
  // connected with credentials. Without this on, the web agent has
  // ZERO awareness of qlaud's tool ecosystem and falls back to
  // generic answers ("here's some Resend npm code") even when the
  // user has Resend / Slack / Linear etc. registered. Default
  // changed alpha.125; existing users keep whatever they had.
  enableConnectors: true,
  subagentModel: DEFAULT_SUBAGENT_MODEL,
  theme: 'system',
  autoApprove: 'smart',
  autoCommit: false,
  outputStyle: 'default',
  // Engine is always coerced to the platform's canonical value on
  // read — see coerceEngine(). This default only matters for the
  // very first read on a fresh install before localStorage has
  // anything stored.
  engine: 'qcode-legacy',
  // Media cloud sync — default ON. Generated media uploads to qlaud
  // R2 so the user can see it on every device. The previous default
  // (off) confused users who expected images they saw the agent
  // generate to also appear in the dashboard's media library — they
  // didn't know they had to opt in via Settings. Users who want
  // strictly local-only flip it OFF; the privacy posture is
  // documented in the Settings drawer.
  mediaCloudSync: true,
  // Video creator skill — opt-in. Adds ~7-8k tokens to system
  // prompt; users who never make video shouldn't pay it.
  videoCreatorSkill: false,
};

/** Coerce stored engine value to the platform's canonical choice.
 *  Ignores user-stored values entirely — the "engine" concept is
 *  no longer user-configurable (see Engine docs).
 *
 *  Both desktop (Tauri) and web now run the SAME 'claude-code'
 *  engine — the dispatcher in ChatSurface picks the spawn site
 *  (Tauri sidecar vs Cloudflare Sandbox SSE) based on isTauri().
 *  qcode-legacy stays as a string union member for the migration
 *  window so old localStorage values don't crash, but no fresh
 *  install ever returns it from this function.
 *
 *  Idempotent: same answer for the same platform. */
function coerceEngine(): Engine {
  return 'claude-code';
}

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
  if (typeof localStorage === 'undefined') {
    return { ...DEFAULTS, engine: coerceEngine() };
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { ...DEFAULTS, engine: coerceEngine() };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings> & {
      autoApprove?: unknown;
    };
    return {
      ...DEFAULTS,
      ...parsed,
      autoApprove: coerceAutoApprove(parsed.autoApprove),
      // Always platform-coerced — even if the user has 'qcode-legacy'
      // stored from alpha.109 era, getSettings() returns 'claude-code'
      // on desktop. The stored value is left intact so a downgrade
      // doesn't strand the user; new patches refresh it on write.
      engine: coerceEngine(),
    };
  } catch {
    return { ...DEFAULTS, engine: coerceEngine() };
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
