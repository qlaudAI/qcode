// Workspace state — first-class registry of folders the user has
// opened, plus a pointer to the active one. Persisted to
// localStorage (non-sensitive: just paths + a stable id). Actual
// file contents come from Tauri's fs plugin on demand; we don't
// cache them here.
//
// alpha.109 and earlier modeled "workspace" as a single in-memory
// `{ path, name }` plus a separate path-keyed MRU. The sidebar
// derived its WORKSPACES section by *grouping threads* whose
// `workspacePath` matched. That had two failure modes:
//   1. Open a folder, never chat → workspace invisible. The MRU
//      knew about it, the sidebar didn't.
//   2. Workspace identity = path string. Renaming/moving the
//      folder stranded every prior thread.
// The registry below makes Workspace a stable entity with its own
// `id`. Threads now reference `workspaceId` as the canonical link;
// the legacy `workspacePath` still resolves for back-compat.

import { killBashSession } from './legacy/bash-session';
import { probeEnv } from './legacy/env-probe';
import { buildMatcher, type IgnoreMatcher } from './gitignore';
import { getProjectMemory } from './legacy/memory';
import { clearPermissionRulesCache } from './legacy/permission-rules';
import { clearAllReads } from './legacy/read-cache';
import { isTauri, pickFolder } from './tauri';

// Legacy keys — kept for read-only migration. We don't delete them
// after seeding the registry so a downgrade to alpha.109 doesn't
// land users on an empty MRU.
const CURRENT_KEY = 'qcode.workspace.current';
const MRU_KEY = 'qcode.workspace.mru';
// Canonical registry blob.
const REGISTRY_KEY = 'qcode.workspaces.v1';
const MRU_MAX = 8;

export type Workspace = {
  /** Stable id assigned on first registration. Threads link to a
   *  workspace via this id so renaming or moving the folder keeps
   *  the relationship intact. Optional in legacy parses — call
   *  sites that need it should pull through getCurrentWorkspace()
   *  / listWorkspaces() which always return populated rows. */
  id?: string;
  /** Absolute path on disk. The "current location" of this
   *  workspace — may change if the user moves the folder and re-
   *  registers, but the id stays stable. */
  path: string;
  /** Last component of the path — handy for the title bar. */
  name: string;
  /** Wall-clock ms when first registered. Used for stable sort of
   *  workspaces that have never been touched. Optional in legacy
   *  parses. */
  createdAt?: number;
  /** Wall-clock ms last activated (= last opened in the picker or
   *  picked from the sidebar). Drives the "recent first" ordering
   *  in the sidebar's WORKSPACES section. */
  lastUsedAt?: number;
};

type WorkspaceRegistry = {
  workspaces: Workspace[];
  /** id of the currently active workspace, or null = no workspace
   *  open (pure-chat mode). */
  activeId: string | null;
};

function newId(): string {
  // crypto.randomUUID is available in Tauri webview + every
  // browser qcode-web targets. Fallback would only matter in
  // tests; not worth the bytes.
  return crypto.randomUUID();
}

/** Derive a display name from an absolute path. Splits on both
 *  POSIX and Windows separators, drops empty segments (handles
 *  trailing slashes), and uses the last non-empty segment.
 *
 *  Edge cases this handles intentionally:
 *   - Folders literally named `0`, `42`, `1.0` → preserved as
 *     strings. Truthy in JS, render as themselves.
 *   - Trailing slashes (`/foo/`) → `'foo'`, not `''`. (`??` would
 *     leave the empty string in place because it's not nullish.)
 *   - Root path (`/` alone) → falls back to the full path so the
 *     user at least sees something instead of a blank pill.
 *   - Windows backslashes (`C:\Users\bob\proj`) → splits cleanly.
 *   - Unicode / emoji names → preserved.
 *
 *  Use this everywhere a name is derived from a path. The callsites
 *  that pre-dated this helper had subtle differences (split('/')
 *  only, no filter for empty segments) that bit us on numbered
 *  folders and trailing slashes. */
export function deriveWorkspaceName(path: string): string {
  const segments = path.split(/[/\\]/).filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : path;
}

export type FileNode = {
  name: string;
  path: string;
  isDir: boolean;
};

// ─── Registry (canonical) ──────────────────────────────────────────

function readRegistry(): WorkspaceRegistry {
  if (typeof localStorage === 'undefined') {
    return { workspaces: [], activeId: null };
  }
  const raw = localStorage.getItem(REGISTRY_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as WorkspaceRegistry;
      if (parsed && Array.isArray(parsed.workspaces)) return parsed;
    } catch {
      /* fall through to migrate */
    }
  }
  // First read on this client — migrate from the legacy current+MRU
  // keys. We keep the legacy keys intact so downgrades stay safe.
  const seeded = migrateFromLegacy();
  writeRegistry(seeded);
  return seeded;
}

function writeRegistry(reg: WorkspaceRegistry): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(reg));
  emitRegistryChange();
}

/** Custom event fired on every registry mutation. The sidebar
 *  subscribes via useWorkspaces() so adding/removing/activating
 *  a workspace re-renders without wiring callbacks through every
 *  caller. localStorage's native 'storage' event only fires
 *  cross-tab, hence this same-tab signal. */
export const WORKSPACE_REGISTRY_EVENT = 'qcode:workspaces-changed';

function emitRegistryChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(WORKSPACE_REGISTRY_EVENT));
}

function migrateFromLegacy(): WorkspaceRegistry {
  if (typeof localStorage === 'undefined') {
    return { workspaces: [], activeId: null };
  }
  const now = Date.now();
  let current: Workspace | null = null;
  let mru: Workspace[] = [];
  try {
    const rawCurrent = localStorage.getItem(CURRENT_KEY);
    if (rawCurrent) current = JSON.parse(rawCurrent) as Workspace;
  } catch {
    /* ignore */
  }
  try {
    const rawMru = localStorage.getItem(MRU_KEY);
    if (rawMru) {
      const arr = JSON.parse(rawMru);
      if (Array.isArray(arr)) mru = arr as Workspace[];
    }
  } catch {
    /* ignore */
  }
  // Dedupe by path; current first (it's most-recent by definition),
  // then MRU in declared order. Each gets a stable id + timestamps.
  const byPath = new Map<string, Workspace>();
  const order: string[] = [];
  if (current) {
    byPath.set(current.path, {
      id: newId(),
      path: current.path,
      name: current.name,
      createdAt: now,
      lastUsedAt: now,
    });
    order.push(current.path);
  }
  // Walk MRU oldest→newest in terms of lastUsedAt offset so the
  // sidebar sort below still surfaces the active one first.
  let offset = 1;
  for (const w of mru) {
    if (byPath.has(w.path)) continue;
    byPath.set(w.path, {
      id: newId(),
      path: w.path,
      name: w.name,
      createdAt: now - offset,
      lastUsedAt: now - offset,
    });
    order.push(w.path);
    offset += 1;
  }
  const workspaces = order.map((p) => byPath.get(p)!).filter(Boolean);
  const activeId = current ? workspaces[0]?.id ?? null : null;
  return { workspaces, activeId };
}

/** All registered workspaces, sorted most-recently-used first.
 *  Sidebar's WORKSPACES section iterates over this directly. */
export function listWorkspaces(): Workspace[] {
  const reg = readRegistry();
  return [...reg.workspaces].sort(
    (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
  );
}

/** Look up a registered workspace by id. Null when the id no
 *  longer exists (e.g. user removed it via the registry). */
export function getWorkspaceById(id: string | null | undefined): Workspace | null {
  if (!id) return null;
  const reg = readRegistry();
  return reg.workspaces.find((w) => w.id === id) ?? null;
}

/** Look up a registered workspace by absolute path. Used to
 *  resolve legacy threads (which only carry workspacePath) to
 *  the registry entry that owns that path today. */
export function getWorkspaceByPath(path: string): Workspace | null {
  const reg = readRegistry();
  return reg.workspaces.find((w) => w.path === path) ?? null;
}

/** Register a folder in the registry. If a workspace with the same
 *  path already exists, that one is returned (and lastUsedAt
 *  refreshed). Otherwise a new entry is created with a fresh id.
 *  Does NOT mark the workspace active — call setActiveWorkspaceId. */
export function registerWorkspace(input: { path: string; name: string }): Workspace {
  const reg = readRegistry();
  const now = Date.now();
  const existing = reg.workspaces.find((w) => w.path === input.path);
  if (existing) {
    existing.lastUsedAt = now;
    if (input.name && existing.name !== input.name) existing.name = input.name;
    writeRegistry(reg);
    return existing;
  }
  const created: Workspace = {
    id: newId(),
    path: input.path,
    name: input.name,
    createdAt: now,
    lastUsedAt: now,
  };
  reg.workspaces.push(created);
  writeRegistry(reg);
  return created;
}

/** Remove a workspace from the registry. Threads previously linked
 *  to it keep their `workspaceId`/`workspacePath` fields but won't
 *  group anywhere in the WORKSPACES section — they fall through to
 *  CHATS (the sidebar's filter is "no matching workspace"). */
export function removeWorkspace(id: string): void {
  const reg = readRegistry();
  const next = reg.workspaces.filter((w) => w.id !== id);
  if (next.length === reg.workspaces.length) return;
  reg.workspaces = next;
  if (reg.activeId === id) reg.activeId = null;
  writeRegistry(reg);
}

/** Bump lastUsedAt without changing active. Useful when a workspace
 *  is referenced (e.g. picked from MRU palette) but not activated. */
export function touchWorkspace(id: string): void {
  const reg = readRegistry();
  const w = reg.workspaces.find((x) => x.id === id);
  if (!w) return;
  w.lastUsedAt = Date.now();
  writeRegistry(reg);
}

/** Active workspace id (null when in pure-chat mode). */
export function getActiveWorkspaceId(): string | null {
  return readRegistry().activeId;
}

/** Switch which workspace is active. Pass null to enter pure-chat
 *  mode (no folder open). Tears down any persistent bash session
 *  and per-workspace caches scoped to the previous active path. */
export function setActiveWorkspaceId(id: string | null): void {
  const reg = readRegistry();
  if (reg.activeId === id) return;
  const prev = reg.workspaces.find((w) => w.id === reg.activeId) ?? null;
  const next = id ? reg.workspaces.find((w) => w.id === id) ?? null : null;
  if (prev && (!next || prev.path !== next.path)) {
    void killBashSession(prev.path);
    clearAllReads();
    clearPermissionRulesCache(prev.path);
  }
  reg.activeId = next?.id ?? null;
  if (next) next.lastUsedAt = Date.now();
  // Mirror to the legacy CURRENT_KEY too so any code path still
  // reading it (or a downgrade) sees the same active workspace.
  if (next) {
    localStorage.setItem(
      CURRENT_KEY,
      JSON.stringify({ path: next.path, name: next.name }),
    );
  } else {
    localStorage.removeItem(CURRENT_KEY);
  }
  writeRegistry(reg);
}

// ─── Compat shims ──────────────────────────────────────────────────
//
// Existing callers ask for "the current workspace" as a single
// `{ path, name }`. Internally that's now "the active entry in the
// registry." Returning the full Workspace (with id + timestamps)
// is structurally compatible — extra fields are ignored by callers
// that only destructure path/name.

export function getCurrentWorkspace(): Workspace | null {
  const reg = readRegistry();
  if (!reg.activeId) return null;
  return reg.workspaces.find((w) => w.id === reg.activeId) ?? null;
}

/** Set / clear the active workspace. Accepts the same shape callers
 *  used to pass — when a registry entry exists at that path we
 *  activate it; otherwise we register-then-activate. Passing null
 *  drops to pure-chat mode. */
export function setCurrentWorkspace(w: Workspace | null): void {
  if (!w) {
    setActiveWorkspaceId(null);
    return;
  }
  // If the caller passed a Workspace that already has a registry
  // id, activate by id. Otherwise resolve / register by path.
  if (w.id && getWorkspaceById(w.id)) {
    setActiveWorkspaceId(w.id);
    return;
  }
  const entry = registerWorkspace({ path: w.path, name: w.name });
  setActiveWorkspaceId(entry.id ?? null);
}

/** Legacy MRU helper — now derived from the registry (sorted by
 *  lastUsedAt) rather than its own list. Kept exported so any
 *  caller still asking for "recent folders" Just Works without
 *  needing to learn about the registry. */
export function getMru(): Workspace[] {
  return listWorkspaces().slice(0, MRU_MAX);
}

export async function openFolderPicker(): Promise<Workspace | null> {
  const path = await pickFolder('Open folder');
  if (!path) return null;
  const name = deriveWorkspaceName(path);
  // Register-then-activate so the returned Workspace carries its
  // stable id. Existing entries at the same path are reused (no
  // duplicate registry rows).
  const entry = registerWorkspace({ path, name });
  setActiveWorkspaceId(entry.id ?? null);
  // Pre-warm the matcher, project memory, and environment probe so
  // the first walk + first agent turn don't pay extra round-trips.
  // probeEnv runs `node --version` etc. through the persistent shell
  // which spawns lazily — kicking it off now lets the bash session
  // come up while the user is still typing.
  void getMatcher(path);
  void getProjectMemory(path);
  void probeEnv(path);
  // Initialize git on fresh folders so the agent has history to walk
  // (git log / git diff / git blame) and the user can revert anything
  // qcode writes. Idempotent: skipped when .git already exists, so
  // re-opening an existing repo is a no-op.
  void initGitIfFresh(path);
  return entry;
}

/** Run `git init` in the workspace if it isn't already a git repo.
 *  Best-effort: any failure (no git installed, fs error, permissions)
 *  is logged but doesn't block the workspace from opening. The first
 *  commit is the user's responsibility — we don't auto-commit so we
 *  don't surprise them with a tree that thinks they meant to track
 *  things they didn't. */
async function initGitIfFresh(workspacePath: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { exists } = await import('@tauri-apps/plugin-fs');
    if (await exists(`${workspacePath}/.git`)) return;
    const { Command } = await import('@tauri-apps/plugin-shell');
    // -q so the "Initialized empty Git repository in ..." line doesn't
    // ride out via the shell channel and surprise anyone watching the
    // logs. Branch name follows the user's git default; we don't
    // override (some users have main, some master, some custom).
    const result = await Command.create('bash', ['-c', 'git init -q'], {
      cwd: workspacePath,
    }).execute();
    if (result.code !== 0) {
      console.warn(
        `[workspace] git init failed in ${workspacePath} (exit ${result.code}): ${result.stderr}`,
      );
    }
  } catch (e) {
    console.warn(
      `[workspace] git init skipped: ${e instanceof Error ? e.message : 'unknown'}`,
    );
  }
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

