// Shared config-discovery primitive. Memory, hooks, skills, custom
// agents, and plans all live in a config directory next to the user's
// code. Three names are accepted interchangeably:
//
//   .qcode/   — qcode-native (legacy from earlier alphas)
//   .qlaud/   — qlaud-platform-wide (preferred for new users; same
//               dir works across qlaud products)
//   .claude/  — Claude Code compat (drop in a Claude Code project,
//               qcode finds the same skills/agents/hooks/CLAUDE.md
//               without re-doing setup)
//
// Plus user-tier (~/.qlaud/, ~/.claude/) for cross-workspace defaults.
//
// Walk-up discovery: from CWD up to the filesystem root, collect
// every match at every level. Closer-to-CWD wins ties. User-tier is
// merged with lowest priority (overridden by anything project-level).
//
// Why one primitive: each config surface (skills, agents, hooks,
// memory) needs the same "find all files at all levels of the tree"
// walk. Centralizing here means one cache, one place to fix path bugs,
// one place to add a new alias if the brand evolves.

import { isTauri } from './tauri';

export const CONFIG_DIR_ALIASES = ['.qcode', '.qlaud', '.claude'] as const;
const USER_TIER_ALIASES = ['.qlaud', '.claude'] as const;

export type ConfigSource = 'project' | 'user';

export type DiscoveredFile = {
  /** Absolute path on disk. */
  path: string;
  /** Workspace-relative path when source='project', '~/'-prefixed when
   *  source='user'. For UI display + log lines. */
  displayPath: string;
  /** Which alias dir it came from (`.qcode` / `.qlaud` / `.claude`). */
  alias: (typeof CONFIG_DIR_ALIASES)[number];
  /** Discovery distance from the workspace — 0 = workspace root, N =
   *  N parent dirs up, -1 = user-tier. Lower = higher priority. */
  depth: number;
  source: ConfigSource;
};

/** Walk from `start` up to the filesystem root, returning every dir
 *  in order (closest first). Also walks Windows roots safely. */
function ancestorDirs(start: string): string[] {
  const dirs: string[] = [];
  let cur = start.replace(/\/+$/, '');
  while (cur && cur !== '/' && !/^[A-Za-z]:[/\\]?$/.test(cur)) {
    dirs.push(cur);
    const idx = cur.lastIndexOf('/');
    if (idx <= 0) break;
    cur = cur.slice(0, idx);
  }
  return dirs;
}

async function exists(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { exists: fsExists } = await import('@tauri-apps/plugin-fs');
    return await fsExists(path);
  } catch {
    return false;
  }
}

async function homeDir(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { homeDir: getHome } = await import('@tauri-apps/api/path');
    return (await getHome()).replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Find a config-relative file across every alias + every ancestor of
 *  the workspace + user-tier. Use for SINGLE-file lookups like a
 *  CLAUDE.md or qcode.md at workspace root.
 *
 *  `relativeName` is the file name with no leading slash, e.g.
 *  `'CLAUDE.md'` or `'rules/style.md'`. */
export async function findConfigFiles(args: {
  workspace: string;
  /** File name (no leading slash) inside an alias dir (e.g.
   *  `'rules/style.md'` resolves to `<dir>/.qcode/rules/style.md`). */
  relativeName: string;
  /** When true, also look for `relativeName` directly at the
   *  workspace root (no alias prefix). Used for top-level files like
   *  CLAUDE.md / qcode.md that historically lived at root, not
   *  inside `.claude/` etc. Default false. */
  alsoAtRoot?: boolean;
}): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  if (!isTauri()) return out;

  const ancestors = ancestorDirs(args.workspace);
  for (let depth = 0; depth < ancestors.length; depth++) {
    const dir = ancestors[depth]!;
    if (args.alsoAtRoot) {
      const direct = `${dir}/${args.relativeName}`;
      if (await exists(direct)) {
        out.push({
          path: direct,
          displayPath: relativizeForDisplay(direct, args.workspace),
          alias: '.qcode',
          depth,
          source: 'project',
        });
      }
    }
    for (const alias of CONFIG_DIR_ALIASES) {
      const path = `${dir}/${alias}/${args.relativeName}`;
      if (await exists(path)) {
        out.push({
          path,
          displayPath: relativizeForDisplay(path, args.workspace),
          alias,
          depth,
          source: 'project',
        });
      }
    }
  }
  // User-tier — lowest priority. Same alias set, no walk-up.
  const home = await homeDir();
  if (home) {
    for (const alias of USER_TIER_ALIASES) {
      const path = `${home}/${alias}/${args.relativeName}`;
      if (await exists(path)) {
        out.push({
          path,
          displayPath: `~/${alias}/${args.relativeName}`,
          alias,
          depth: -1,
          source: 'user',
        });
      }
    }
  }
  return out;
}

/** List every file under a config-relative directory across every
 *  alias / ancestor / user-tier. Use for skills, agents, rules
 *  directories where the user drops N files and we want them all.
 *
 *  `directoryName` is the dir relative to the alias (e.g. `'skills'`
 *  → `<dir>/.qcode/skills/*`).
 *
 *  Returned files are sorted by (depth ascending, path ascending) so
 *  callers iterating in order get closest-first / overrides-last. */
export async function listConfigDir(args: {
  workspace: string;
  directoryName: string;
  /** Filter by extension (e.g. ['.md']). Empty = no filter. */
  extensions?: string[];
}): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  if (!isTauri()) return out;
  const { readDir } = await import('@tauri-apps/plugin-fs');

  const collectFrom = async (
    base: string,
    alias: (typeof CONFIG_DIR_ALIASES)[number],
    depth: number,
    source: ConfigSource,
    displayBase: string,
  ): Promise<void> => {
    const dir = `${base}/${alias}/${args.directoryName}`;
    if (!(await exists(dir))) return;
    let entries: Awaited<ReturnType<typeof readDir>>;
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory) {
        // Recurse one level — sufficient for skills/agents which can
        // be `<name>/SKILL.md` style. We don't go deeper to avoid
        // surprising scopes (a stray .git inside .qcode/skills would
        // explode the walk).
        await collectFromSubdir(`${dir}/${e.name}`, alias, depth, source, `${displayBase}/${e.name}`);
        continue;
      }
      if (
        args.extensions &&
        args.extensions.length > 0 &&
        !args.extensions.some((ext) => e.name.endsWith(ext))
      ) {
        continue;
      }
      out.push({
        path: `${dir}/${e.name}`,
        displayPath: `${displayBase}/${e.name}`,
        alias,
        depth,
        source,
      });
    }
  };

  const collectFromSubdir = async (
    dir: string,
    alias: (typeof CONFIG_DIR_ALIASES)[number],
    depth: number,
    source: ConfigSource,
    displayBase: string,
  ): Promise<void> => {
    let entries: Awaited<ReturnType<typeof readDir>>;
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory) continue; // depth-1 cap inside subdirs
      if (
        args.extensions &&
        args.extensions.length > 0 &&
        !args.extensions.some((ext) => e.name.endsWith(ext))
      ) {
        continue;
      }
      out.push({
        path: `${dir}/${e.name}`,
        displayPath: `${displayBase}/${e.name}`,
        alias,
        depth,
        source,
      });
    }
  };

  const ancestors = ancestorDirs(args.workspace);
  for (let depth = 0; depth < ancestors.length; depth++) {
    const dir = ancestors[depth]!;
    for (const alias of CONFIG_DIR_ALIASES) {
      await collectFrom(
        dir,
        alias,
        depth,
        'project',
        relativizeForDisplay(`${dir}/${alias}/${args.directoryName}`, args.workspace),
      );
    }
  }
  const home = await homeDir();
  if (home) {
    for (const alias of USER_TIER_ALIASES) {
      await collectFrom(home, alias, -1, 'user', `~/${alias}/${args.directoryName}`);
    }
  }
  out.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.path.localeCompare(b.path);
  });
  return out;
}

/** Resolve where a NEW file should be written for a given config
 *  surface. Picks the first alias that already exists at the workspace
 *  root; falls back to `.qcode/` on a fresh workspace. Lets us write
 *  to whatever convention the user already has — if they have
 *  `.claude/skills/`, new skills land in `.claude/`; if they have
 *  `.qlaud/`, new ones land in `.qlaud/`. */
export async function pickWriteAlias(
  workspace: string,
): Promise<(typeof CONFIG_DIR_ALIASES)[number]> {
  if (!isTauri()) return '.qcode';
  for (const alias of CONFIG_DIR_ALIASES) {
    if (await exists(`${workspace}/${alias}`)) return alias;
  }
  return '.qcode';
}

function relativizeForDisplay(abs: string, workspace: string): string {
  const ws = workspace.replace(/\/+$/, '');
  if (abs === ws) return '.';
  if (abs.startsWith(ws + '/')) return abs.slice(ws.length + 1);
  return abs;
}
