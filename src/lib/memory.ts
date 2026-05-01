// Project memory — qcode.md (preferred) or CLAUDE.md (CC interop).
// Read on first agent turn against a workspace, cached per workspace
// path so the cost is one fs round-trip per session. Contents are
// appended to the system prompt verbatim; we trust the user to write
// what they want the model to know.

import { isTauri } from './tauri';

/** Hard cap. Most project memory files run 500 B – 5 KB; anything
 *  larger is almost certainly a runaway README mistakenly named
 *  qcode.md and would burn tokens every turn. */
const MAX_BYTES = 32_000;

/** Filenames we look for, in priority order. qcode.md wins so users
 *  can keep CC-flavored context in CLAUDE.md and qcode-specific
 *  overrides in qcode.md without touching the original. */
const FILENAMES = ['qcode.md', 'QCODE.md', 'CLAUDE.md'] as const;

const CACHE = new Map<string, { source: string; text: string } | null>();

export type ProjectMemory = {
  /** Filename it came from, e.g. "qcode.md". For UI display. */
  source: string;
  /** Trimmed contents. Empty file returns null, not an empty string. */
  text: string;
};

export async function getProjectMemory(
  workspacePath: string,
): Promise<ProjectMemory | null> {
  if (CACHE.has(workspacePath)) {
    return CACHE.get(workspacePath) ?? null;
  }
  const result = await loadFromDisk(workspacePath);
  CACHE.set(workspacePath, result);
  return result;
}

/** Drop the cache entry for a workspace. Call when the user edits
 *  qcode.md inside qcode itself, or runs `/init` to regenerate it. */
export function clearProjectMemoryCache(workspacePath: string): void {
  CACHE.delete(workspacePath);
}

async function loadFromDisk(
  workspacePath: string,
): Promise<ProjectMemory | null> {
  if (!isTauri()) return null;
  try {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs');
    for (const name of FILENAMES) {
      const path = `${workspacePath}/${name}`;
      if (!(await exists(path))) continue;
      const raw = await readTextFile(path);
      const text = raw.trim();
      if (!text) return null;
      // Naive byte-length guard — we don't want to ship a tokenizer
      // here. UTF-8 is at most 4 B/char so this is conservative.
      const truncated =
        text.length > MAX_BYTES
          ? text.slice(0, MAX_BYTES) + '\n\n…(truncated)'
          : text;
      return { source: name, text: truncated };
    }
    return null;
  } catch {
    return null;
  }
}

/** Compose the project-memory section appended to the system prompt.
 *  Returns empty string when there's no memory so callers can just
 *  concatenate without conditionals. */
export function memorySystemSection(memory: ProjectMemory | null): string {
  if (!memory) return '';
  return `\n\n## Project context (from ${memory.source})\nThe user has written the following notes about this project. Treat them as authoritative — they describe conventions, gotchas, and goals you should respect.\n\n${memory.text}`;
}
