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
  /** Auto-approve mode. When the agent calls a tool that's
   *  workspace-scoped + non-destructive, just run it instead of
   *  prompting the user for every step. The whole point of an
   *  agent is to do the work; clicking "Allow" 50 times in a
   *  session defeats that. Dangerous operations (the BASH_DENYLIST
   *  patterns + writes outside the workspace) ALWAYS still require
   *  approval regardless of these flags.
   *
   *  Defaults to ON for both because that's the agent experience
   *  the user paid for. Toggle off in Settings for "watch every
   *  step" mode. */
  autoApprove: {
    /** write_file + edit_file when target is inside the workspace.
     *  We already path-jail; auto-approving inside that jail is
     *  the same trust posture as letting the agent edit at all. */
    workspaceEdits: boolean;
    /** bash commands that match the safe-prefix whitelist (read-
     *  only ops, package-manager noops, git read-only, etc).
     *  Anything outside the whitelist still prompts. The full
     *  whitelist lives in lib/tools.ts:isSafeBash. */
    safeBash: boolean;
  };
};

const DEFAULT_SUBAGENT_MODEL = 'claude-haiku-4-5';

const DEFAULTS: Settings = {
  defaultModel: DEFAULT_MODEL,
  autoUpdate: true,
  mode: 'agent',
  enableConnectors: false,
  subagentModel: DEFAULT_SUBAGENT_MODEL,
  theme: 'system',
  autoApprove: {
    workspaceEdits: true,
    safeBash: true,
  },
};

export function getSettings(): Settings {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Deep-merge nested objects so a stored partial doesn't drop
    // fields we add later (autoApprove.* would have been dropped
    // for users who saved settings before the field existed).
    return {
      ...DEFAULTS,
      ...parsed,
      autoApprove: { ...DEFAULTS.autoApprove, ...(parsed.autoApprove ?? {}) },
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
