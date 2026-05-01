// Workspace state — the open folder qcode is currently working in,
// plus the recent-folders MRU. Persisted to localStorage (non-
// sensitive: just paths). The actual file contents come from
// Tauri's fs plugin on demand; we don't cache them here.

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
  return w;
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
  try {
    const { readDir: fsReadDir } = await import('@tauri-apps/plugin-fs');
    const entries = await fsReadDir(path);
    return entries
      .map((e) => ({
        name: e.name,
        path: `${path}/${e.name}`,
        isDir: e.isDirectory,
      }))
      .filter((e) => !shouldHide(e.name))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'en');
      });
  } catch {
    return [];
  }
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

