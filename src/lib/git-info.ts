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
