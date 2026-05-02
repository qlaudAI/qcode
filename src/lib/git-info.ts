// Tiny git inspector. Reads `<workspace>/.git/HEAD` to figure out
// which branch the user has checked out. No spawning git — we do
// this on every workspace change and want it to be free.
//
// What's covered:
//   - Normal branch → "ref: refs/heads/<name>" → returns the name.
//   - Detached HEAD → bare SHA → returns first 7 chars.
//   - Worktrees (HEAD is a `gitdir:` pointer) → not yet handled;
//     returns null and the composer just hides the chip.
//
// Why not `git branch --show-current`: that would require
// child-process spawn, a 30ms+ round-trip, and more capability
// surface to maintain in tauri.conf.json. The HEAD file is two
// lines of text; reading it directly is ~free and all of `tauri-
// plugin-fs` already has read permission for the workspace path.

import { runBashSession } from './bash-session';
import { isTauri } from './tauri';

export type GitInfo = {
  /** Branch name, or short SHA when detached. Null when the dir
   *  isn't a git repo. */
  branch: string | null;
};

const cache = new Map<string, Promise<GitInfo>>();

export function readGitInfo(workspace: string): Promise<GitInfo> {
  const cached = cache.get(workspace);
  if (cached) return cached;
  const p = doRead(workspace);
  cache.set(workspace, p);
  return p;
}

/** Drop the cache entry for one workspace — call after a `git
 *  checkout`-like action so the chip refreshes without an app
 *  restart. Currently unused by the agent but exposed for future
 *  hooks. */
export function clearGitCache(workspace: string): void {
  cache.delete(workspace);
}

async function doRead(workspace: string): Promise<GitInfo> {
  if (!isTauri()) return { branch: null };
  try {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs');
    const headPath = `${workspace}/.git/HEAD`;
    if (!(await exists(headPath))) return { branch: null };
    const text = (await readTextFile(headPath)).trim();
    const refMatch = /^ref:\s+refs\/heads\/(.+)$/.exec(text);
    if (refMatch) return { branch: refMatch[1] ?? null };
    // Detached HEAD: 40-char SHA.
    if (/^[0-9a-f]{7,40}$/.test(text)) {
      return { branch: text.slice(0, 7) };
    }
    return { branch: null };
  } catch {
    return { branch: null };
  }
}

// ─── Diff (uncommitted changes) ───────────────────────────────────

export type FileDiff = {
  path: string;
  /** Working-tree status from `git status --porcelain`:
   *  'M' modified, 'A' added/staged-new, 'D' deleted, '??' untracked. */
  status: string;
  added: number;
  removed: number;
  /** Unified diff body — null when too large or untracked (we don't
   *  render binary or oversized diffs inline). */
  patch: string | null;
};

const MAX_DIFF_BYTES = 64 * 1024;
const MAX_FILES = 50;

/** Read uncommitted file diffs in a single bash round-trip. Returns
 *  empty array when the workspace isn't a git repo or git fails.
 *  Surfaced by the Diff view in the right rail; refresh on demand
 *  via the rail's reload button (no auto-poll — git diff is cheap
 *  but not free, and the user knows when they want fresh state). */
export async function readWorkspaceDiff(workspace: string): Promise<FileDiff[]> {
  if (!isTauri()) return [];
  try {
    // First the porcelain summary (path + status); then per-file
    // numstat + the patch body. One bash call to minimize round-
    // trip overhead. Sentinel-separated so we parse cleanly.
    const cmd = [
      `cd "${workspace}"`,
      `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo NOT_GIT; exit 0; }`,
      `echo __QCODE_PORCELAIN__`,
      `git status --porcelain 2>/dev/null | head -${MAX_FILES}`,
      `echo __QCODE_NUMSTAT__`,
      `git diff --numstat HEAD 2>/dev/null | head -${MAX_FILES}`,
      `echo __QCODE_PATCH__`,
      `git diff HEAD 2>/dev/null | head -c ${MAX_DIFF_BYTES}`,
    ].join('\n');
    const r = await runBashSession({
      workspace,
      command: cmd,
      timeoutMs: 5_000,
    });
    if (r.stdout.includes('NOT_GIT')) return [];
    const sections = r.stdout.split(
      /__QCODE_PORCELAIN__|__QCODE_NUMSTAT__|__QCODE_PATCH__/,
    );
    const porcelain = (sections[1] ?? '').trim();
    const numstat = (sections[2] ?? '').trim();
    const patch = (sections[3] ?? '').trim();
    if (!porcelain) return [];

    const numByPath = new Map<string, { added: number; removed: number }>();
    for (const line of numstat.split('\n')) {
      const m = /^(\d+|-)\s+(\d+|-)\s+(.+)$/.exec(line.trim());
      if (!m) continue;
      const added = m[1] === '-' ? 0 : Number.parseInt(m[1] ?? '0', 10);
      const removed = m[2] === '-' ? 0 : Number.parseInt(m[2] ?? '0', 10);
      numByPath.set(m[3] ?? '', { added, removed });
    }

    const patchByPath = splitPatchByFile(patch);

    return porcelain
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const status = line.slice(0, 2).trim();
        const p = line.slice(3).trim();
        const num = numByPath.get(p) ?? { added: 0, removed: 0 };
        return {
          path: p,
          status,
          added: num.added,
          removed: num.removed,
          patch: patchByPath.get(p) ?? null,
        };
      });
  } catch {
    return [];
  }
}

/** Split a unified diff into per-file segments keyed by the new
 *  path. Untracked files (no diff entry) get null. */
function splitPatchByFile(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!diff) return out;
  const segments = diff.split(/\n(?=diff --git )/);
  for (const seg of segments) {
    const m = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(seg);
    if (!m) continue;
    out.set(m[2] ?? '', seg);
  }
  return out;
}
