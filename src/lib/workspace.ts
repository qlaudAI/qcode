// Workspace state — the open folder qcode is currently working in,
// plus the recent-folders MRU. Persisted to localStorage (non-
// sensitive: just paths). The actual file contents come from
// Tauri's fs plugin on demand; we don't cache them here.

import { killBashSession } from './bash-session';
import { buildMatcher, type IgnoreMatcher } from './gitignore';
import { getProjectMemory } from './memory';
import { isTauri, pickFolder } from './tauri';

const CURRENT_KEY = 'qcode.workspace.current';
const MRU_KEY = 'qcode.workspace.mru';
const MRU_MAX = 8;

export type Workspace = {
  /** Absolute path on disk. */
  path: string;
  /** Last component of the path — handy for the title bar. */
  name: string;
};

export type FileNode = {
  name: string;
  path: string;
  isDir: boolean;
};

export function getCurrentWorkspace(): Workspace | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(CURRENT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Workspace;
  } catch {
    return null;
  }
}

export function setCurrentWorkspace(w: Workspace | null): void {
  // Kill any persistent bash session attached to the OLD workspace
  // before swapping. Carrying a shell rooted in /Users/foo/projA into
  // a session for /Users/foo/projB would leak cwd/env state and the
  // user would be very confused by `pytest` running against the
  // wrong project.
  const prev = getCurrentWorkspace();
  if (prev && (!w || prev.path !== w.path)) {
    void killBashSession(prev.path);
  }
  if (w) {
    localStorage.setItem(CURRENT_KEY, JSON.stringify(w));
    pushMru(w);
  } else {
    localStorage.removeItem(CURRENT_KEY);
  }
}

export function getMru(): Workspace[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(MRU_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Workspace[];
  } catch {
    return [];
  }
}

function pushMru(w: Workspace): void {
  const next = [w, ...getMru().filter((x) => x.path !== w.path)].slice(0, MRU_MAX);
  localStorage.setItem(MRU_KEY, JSON.stringify(next));
}

export async function openFolderPicker(): Promise<Workspace | null> {
  const path = await pickFolder('Open folder');
  if (!path) return null;
  const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
  const w = { path, name };
  setCurrentWorkspace(w);
  // Pre-warm the matcher and project memory so the first walk +
  // first agent turn don't pay extra fs round-trips.
  void getMatcher(path);
  void getProjectMemory(path);
  return w;
}

/** Walk the workspace recursively and return relative file paths.
 *  Skips per-workspace `.gitignore` patterns + a base list of
 *  things you'd never want scanned. Bails at 10k entries so
 *  command-palette indexing never hangs on a giant monorepo. */
export async function listAllFiles(root: string): Promise<string[]> {
  if (!isTauri()) {
    return ['src/main.tsx', 'src/App.tsx', 'package.json', 'README.md'];
  }
  const matcher = await getMatcher(root);
  const out: string[] = [];
  await walkAll(root, '', out, matcher);
  return out;
}

async function walkAll(
  root: string,
  rel: string,
  out: string[],
  matcher: IgnoreMatcher,
): Promise<void> {
  if (out.length >= 10_000) return;
  const { readDir: fsReadDir } = await import('@tauri-apps/plugin-fs');
  const start = rel ? `${root}/${rel}` : root;
  let entries;
  try {
    entries = await fsReadDir(start);
  } catch {
    return;
  }
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (matcher(childRel, e.isDirectory)) continue;
    if (e.isDirectory) {
      await walkAll(root, childRel, out, matcher);
    } else {
      out.push(childRel);
    }
    if (out.length >= 10_000) return;
  }
}

/** Read the immediate children of a folder. Used by the file tree
 *  on expand. Returns an empty array if not in Tauri or on error. */
export async function readDir(path: string): Promise<FileNode[]> {
  if (!isTauri()) {
    // Browser-mode: no fs access. Show a stub so the tree renders.
    return [
      { name: 'src', path: `${path}/src`, isDir: true },
      { name: 'package.json', path: `${path}/package.json`, isDir: false },
      { name: 'README.md', path: `${path}/README.md`, isDir: false },
    ];
  }
  // Resolve the active workspace root by stripping the requested
  // path back to its current-workspace prefix; if the user happens
  // to navigate outside the workspace (rare — the picker enforces
  // it) we fall back to a workspace-less matcher so nothing leaks.
  const ws = getCurrentWorkspace();
  const matcher = ws && path.startsWith(ws.path) ? await getMatcher(ws.path) : null;
  try {
    const { readDir: fsReadDir } = await import('@tauri-apps/plugin-fs');
    const entries = await fsReadDir(path);
    return entries
      .map((e) => ({
        name: e.name,
        path: `${path}/${e.name}`,
        isDir: e.isDirectory,
      }))
      .filter((e) => {
        if (!matcher || !ws) return !shouldHide(e.name);
        const rel = e.path.startsWith(ws.path + '/')
          ? e.path.slice(ws.path.length + 1)
          : e.name;
        return !matcher(rel, e.isDir);
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'en');
      });
  } catch {
    return [];
  }
}

// ─── Per-workspace matcher cache ───────────────────────────────────
//
// Each workspace gets one matcher built from its .gitignore + our
// base list. The cache invalidates when a different workspace is
// opened (by storing the path-keyed map). We don't watch for
// .gitignore changes; users opening a fresh workspace gets a fresh
// matcher, which is the common case.

const MATCHER_CACHE = new Map<string, IgnoreMatcher>();

export async function getMatcher(workspacePath: string): Promise<IgnoreMatcher> {
  const cached = MATCHER_CACHE.get(workspacePath);
  if (cached) return cached;
  let gitignoreText: string | null = null;
  if (isTauri()) {
    try {
      const { exists, readTextFile } = await import('@tauri-apps/plugin-fs');
      const giPath = `${workspacePath}/.gitignore`;
      if (await exists(giPath)) {
        gitignoreText = await readTextFile(giPath);
      }
    } catch {
      gitignoreText = null;
    }
  }
  const m = buildMatcher(gitignoreText);
  MATCHER_CACHE.set(workspacePath, m);
  return m;
}

// Drop the noise that fills every dev workspace. We can extend this
// list to read .gitignore later — for now, the most common offenders
// are enough.
function shouldHide(name: string): boolean {
  const skip = new Set([
    'node_modules',
    '.git',
    '.next',
    '.open-next',
    'dist',
    'build',
    'target',
    '.DS_Store',
    'coverage',
    '.cache',
  ]);
  return skip.has(name);
}

