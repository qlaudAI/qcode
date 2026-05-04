// Resolves the current git branch for a given workspace path.
//
// Used by the sidebar's WorkspaceGroup to show a branch chip next to
// the active workspace name. Spawns `git branch --show-current` in
// the workspace cwd via Tauri's shell plugin (legitimate use of the
// already-allowed `bash` capability) and caches the result in a Map
// keyed by path so flipping between projects doesn't re-shell every
// render.
//
// Caveats this v1 punts on (acceptable for a sidebar-chip):
//   - Doesn't watch .git/HEAD, so a `git checkout` in the user's
//     terminal won't reflect until they switch workspaces and back
//     (or until the cache TTL elapses, ~30s).
//   - Detached HEAD prints empty stdout from `--show-current`. We
//     fall back to a 7-char short SHA in that case so the chip
//     still has something to render. Still distinguishes "in a
//     branch" from "detached at <sha>" because branch names don't
//     look like SHAs.
//   - Doesn't list the branch list yet; chip is current-branch only.

import { useEffect, useState } from 'react';

import { isTauri } from './tauri';

type Cached = { branch: string | null; at: number };
const CACHE = new Map<string, Cached>();
const CACHE_TTL_MS = 30_000;

async function resolveBranch(path: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { Command } = await import('@tauri-apps/plugin-shell');
    // First try: branch name. Empty stdout means detached HEAD or
    // not a git repo — distinguish via the second probe.
    const named = await Command.create(
      'bash',
      ['-lc', 'git branch --show-current'],
      { cwd: path },
    ).execute();
    const name = (named.stdout || '').trim();
    if (named.code === 0 && name) return name;

    // Detached or no branch — try short SHA. If that ALSO errors,
    // path isn't a git repo at all and we return null.
    const sha = await Command.create(
      'bash',
      ['-lc', 'git rev-parse --short=7 HEAD 2>/dev/null'],
      { cwd: path },
    ).execute();
    const shortSha = (sha.stdout || '').trim();
    if (sha.code === 0 && shortSha) return `@${shortSha}`;
    return null;
  } catch {
    return null;
  }
}

/** React hook — returns current branch name (or null) for a path.
 *  Cached for 30s so toggling workspace groups in the sidebar
 *  doesn't re-spawn bash unnecessarily.
 *
 *  Returns null while loading; the branch chip should hide rather
 *  than flicker between null and a value. Callers can opt in to a
 *  different loading state if they want a placeholder. */
export function useGitBranch(path: string | null): string | null {
  const [branch, setBranch] = useState<string | null>(() => {
    if (!path) return null;
    const c = CACHE.get(path);
    if (c && Date.now() - c.at < CACHE_TTL_MS) return c.branch;
    return null;
  });

  useEffect(() => {
    if (!path) {
      setBranch(null);
      return;
    }
    const cached = CACHE.get(path);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      setBranch(cached.branch);
      return;
    }
    let cancelled = false;
    void (async () => {
      const b = await resolveBranch(path);
      if (cancelled) return;
      CACHE.set(path, { branch: b, at: Date.now() });
      setBranch(b);
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  return branch;
}
