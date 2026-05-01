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

export type Settings = {
  /** Model picked when a new chat is created. The title-bar dropdown
   *  still lets the user override per-thread. */
  defaultModel: string;
  /** Auto-fetch + install updates on launch. Default on. */
  autoUpdate: boolean;
  /** agent — full tool kit including write_file/edit_file/bash.
   *  plan  — read tools only; model proposes changes in prose. */
  mode: AgentMode;
};

const DEFAULTS: Settings = {
  defaultModel: DEFAULT_MODEL,
  autoUpdate: true,
  mode: 'agent',
};

export function getSettings(): Settings {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function patchSettings(p: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...p };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
