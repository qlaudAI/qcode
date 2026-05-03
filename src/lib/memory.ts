// Project memory — concatenated context the user writes to teach the
// agent project conventions. Loaded from a tiered + walk-up search:
//
//   1. User-tier (lowest priority):
//        ~/.qlaud/CLAUDE.md
//        ~/.qlaud/rules/*.md
//        ~/.claude/CLAUDE.md
//        ~/.claude/rules/*.md
//   2. Project-tier — at every ancestor dir from workspace up to /:
//        <dir>/qcode.md / QCODE.md / CLAUDE.md (root-level files)
//        <dir>/.qcode/{CLAUDE.md,rules/*.md}
//        <dir>/.qlaud/{CLAUDE.md,rules/*.md}
//        <dir>/.claude/{CLAUDE.md,rules/*.md}
//
// Closer-to-CWD wins ties (workspace overrides parent overrides ~/.).
// Files are concatenated with a section header showing their source so
// the model can tell which rule came from where.
//
// Pattern lifted from Claude Code (walk-up + multi-tier + .claude/
// rules/), with two extensions: (a) we accept `.qcode/`, `.qlaud/`,
// `.claude/` interchangeably so users moving between tools don't
// re-do setup, (b) we keep the legacy single-file qcode.md/CLAUDE.md
// at workspace root so existing qcode users don't lose their memory.

import { findConfigFiles, listConfigDir, type DiscoveredFile } from './qcode-paths';
import { isTauri } from './tauri';

/** Hard cap on total concatenated memory. Most projects run well
 *  under 5KB; anything larger usually means a runaway README got
 *  named CLAUDE.md and would burn tokens on every turn. */
const MAX_BYTES = 32_000;

/** Per-source cap. Prevents one giant rule file from monopolizing
 *  the budget and starving everything else. */
const MAX_BYTES_PER_FILE = 16_000;

const TIER_MEMORY_FILENAMES = ['CLAUDE.md', 'qcode.md', 'QCODE.md'] as const;

type CacheEntry = ProjectMemory | null;
const CACHE = new Map<string, CacheEntry>();

export type ProjectMemory = {
  /** Single combined source label for UI ("3 files: CLAUDE.md, .claude/rules/style.md, …"). */
  source: string;
  /** Concatenated body fed to the system prompt. Already capped. */
  text: string;
  /** Individual source files for UI / debug. */
  sources: Array<{ displayPath: string; bytes: number }>;
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

/** Drop the cache entry for a workspace. Call when the user edits a
 *  memory file inside qcode itself, or runs `/init` to regenerate it.
 *  No path = clear everything. */
export function clearProjectMemoryCache(workspacePath?: string): void {
  if (workspacePath === undefined) CACHE.clear();
  else CACHE.delete(workspacePath);
}

async function loadFromDisk(workspacePath: string): Promise<ProjectMemory | null> {
  if (!isTauri()) return null;

  // Discovery order: lowest priority first (user-tier, then ancestors
  // farthest from workspace), highest priority last (workspace root).
  // We CONCAT in priority order so closer-to-CWD lands later, which
  // means the model reads it later — recency bias works in our favor.
  const discovered: DiscoveredFile[] = [];

  // 1. Root-level memory files (qcode.md / CLAUDE.md at every ancestor).
  //    These are the "legacy" forms users already have.
  for (const name of TIER_MEMORY_FILENAMES) {
    const found = await findConfigFiles({
      workspace: workspacePath,
      relativeName: name,
      alsoAtRoot: true,
    });
    discovered.push(
      ...found.filter((f) => isRootLevelMemory(f, name) || f.source === 'user'),
    );
  }

  // 2. .qcode/.qlaud/.claude CLAUDE.md (the "project context" file
  //    that lives inside the alias dir).
  for (const name of TIER_MEMORY_FILENAMES) {
    const found = await findConfigFiles({
      workspace: workspacePath,
      relativeName: name,
    });
    discovered.push(...found.filter((f) => !isRootLevelMemory(f, name)));
  }

  // 3. .qcode/rules/*.md, .qlaud/rules/*.md, .claude/rules/*.md —
  //    arbitrary user-defined per-topic rule files.
  const ruleFiles = await listConfigDir({
    workspace: workspacePath,
    directoryName: 'rules',
    extensions: ['.md'],
  });
  discovered.push(...ruleFiles);

  if (discovered.length === 0) return null;

  // Dedupe by absolute path (a CLAUDE.md at workspace root could match
  // both ROOT and `.claude/` searches if the user has odd nesting).
  const seenPaths = new Set<string>();
  const unique = discovered.filter((f) => {
    if (seenPaths.has(f.path)) return false;
    seenPaths.add(f.path);
    return true;
  });

  // Sort: user-tier first (lowest priority), then ancestors deepest-up
  // (depth descending), then closer-to-workspace (depth ascending).
  // Path tiebreak so the order is stable across runs.
  unique.sort((a, b) => {
    if (a.source === 'user' && b.source !== 'user') return -1;
    if (a.source !== 'user' && b.source === 'user') return 1;
    if (a.depth !== b.depth) return b.depth - a.depth;
    return a.path.localeCompare(b.path);
  });

  const { readTextFile } = await import('@tauri-apps/plugin-fs');
  const sections: string[] = [];
  const sourcesMeta: Array<{ displayPath: string; bytes: number }> = [];
  let totalBytes = 0;

  for (const f of unique) {
    if (totalBytes >= MAX_BYTES) break;
    let raw: string;
    try {
      raw = await readTextFile(f.path);
    } catch {
      continue;
    }
    const text = raw.trim();
    if (!text) continue;
    let body =
      text.length > MAX_BYTES_PER_FILE
        ? text.slice(0, MAX_BYTES_PER_FILE) + '\n\n…(truncated for length)'
        : text;
    const remaining = MAX_BYTES - totalBytes;
    if (body.length > remaining) {
      body = body.slice(0, remaining - 32) + '\n\n…(truncated, total cap reached)';
    }
    sections.push(`### From ${f.displayPath}\n\n${body}`);
    sourcesMeta.push({ displayPath: f.displayPath, bytes: body.length });
    totalBytes += body.length;
  }

  if (sections.length === 0) return null;

  const sourceLabel =
    sourcesMeta.length === 1
      ? sourcesMeta[0]!.displayPath
      : `${sourcesMeta.length} files (${sourcesMeta
          .slice(0, 3)
          .map((s) => s.displayPath)
          .join(', ')}${sourcesMeta.length > 3 ? ', …' : ''})`;

  return {
    source: sourceLabel,
    text: sections.join('\n\n---\n\n'),
    sources: sourcesMeta,
  };
}

/** Whether the discovered file is a top-level workspace file (e.g.
 *  CLAUDE.md at the workspace root) vs. one inside an alias dir. We
 *  use depth + alias to tell them apart since findConfigFiles() with
 *  alsoAtRoot:true returns both shapes mixed. */
function isRootLevelMemory(
  file: DiscoveredFile,
  filename: string,
): boolean {
  if (file.source === 'user') return false;
  // Root-level matches don't include any alias dir in the displayPath.
  return !file.displayPath.includes('/.qcode/') &&
    !file.displayPath.includes('/.qlaud/') &&
    !file.displayPath.includes('/.claude/') &&
    file.displayPath.endsWith(filename) &&
    !file.displayPath.includes('/');
}

/** Compose the project-memory section appended to the system prompt.
 *  Returns empty string when there's no memory so callers can just
 *  concatenate without conditionals. */
export function memorySystemSection(memory: ProjectMemory | null): string {
  if (!memory) return '';
  return `\n\n## Project context (from ${memory.source})\nThe user has written the following notes about this project. Treat them as authoritative — they describe conventions, gotchas, and goals you should respect. Multiple files are joined with horizontal-rule separators; the source path is shown above each section.\n\n${memory.text}`;
}
