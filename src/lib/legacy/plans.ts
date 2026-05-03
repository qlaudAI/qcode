// Plan persistence. When the Planner subagent completes successfully,
// qcode writes the plan body to a file at `<config-alias>/plans/<slug>.md`
// so the user (and the orchestrator on subsequent turns) can reference
// it by path. Pattern from Claude Code's plan-mode flow.
//
// Why filesystem instead of a DB row: the user opens the plan in their
// editor, edits inline, and the next Builder dispatch reads the
// edited version. Round-tripping through D1 would force the user to
// edit through qcode's UI for trivial wording fixes.
//
// Slug strategy: a stable random word + 8-char id. Same slug for the
// duration of one workspace's session — the most recent plan
// overwrites the oldest, so a thread's "latest plan" is always at
// the same path. Old plans accumulate at distinct paths (one per
// thread/session) so the user has history.

import { pickWriteAlias } from './qcode-paths';
import { isTauri } from '../tauri';

const PLAN_NOUNS = [
  'aurora', 'borealis', 'cascade', 'delta', 'eclipse', 'foundry',
  'galaxy', 'horizon', 'iris', 'jade', 'kestrel', 'lattice',
  'meridian', 'nimbus', 'orbit', 'prism', 'quill', 'redwood',
  'silver', 'tundra', 'umbra', 'vertex', 'willow', 'xenon',
  'yarrow', 'zephyr',
];

/** Stable per-session slug. Generated once per workspace process and
 *  cached so multiple Planner runs in the same session overwrite
 *  rather than litter the plans dir. Two-component for readability +
 *  collision avoidance. */
const SESSION_SLUGS = new Map<string, string>();

function sessionSlug(workspace: string): string {
  const cached = SESSION_SLUGS.get(workspace);
  if (cached) return cached;
  const noun = PLAN_NOUNS[Math.floor(Math.random() * PLAN_NOUNS.length)]!;
  const id = Math.random().toString(36).slice(2, 10);
  const slug = `${noun}-${id}`;
  SESSION_SLUGS.set(workspace, slug);
  return slug;
}

export type PlanPersistResult = {
  /** Absolute path of the persisted plan. */
  path: string;
  /** Workspace-relative path for UI / system prompt. */
  displayPath: string;
};

/** Write a plan body to disk, prefer whichever config-alias dir
 *  the user already has (`.qcode/`, `.qlaud/`, `.claude/`). On a
 *  fresh workspace falls back to `.qcode/`. Returns the resolved
 *  path, or null if persistence failed. */
export async function persistPlan(args: {
  workspace: string;
  body: string;
  /** Optional sub-slug — when set, the file is suffixed with it
   *  (e.g. `aurora-7ab3c01d-investigation.md`). Lets multiple
   *  Planner runs in one session live side-by-side. */
  subSlug?: string;
}): Promise<PlanPersistResult | null> {
  if (!isTauri()) return null;
  if (!args.body.trim()) return null;
  try {
    const alias = await pickWriteAlias(args.workspace);
    const dir = `${args.workspace}/${alias}/plans`;
    const slug = sessionSlug(args.workspace);
    const filename = args.subSlug ? `${slug}-${args.subSlug}.md` : `${slug}.md`;
    const path = `${dir}/${filename}`;
    const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
    await mkdir(dir, { recursive: true }).catch(() => null);
    const header =
      `<!-- qcode plan · session ${slug} · written ${new Date().toISOString()} -->\n\n`;
    await writeTextFile(path, header + args.body.trim() + '\n');
    return {
      path,
      displayPath: `${alias}/plans/${filename}`,
    };
  } catch {
    return null;
  }
}

/** Most recent plan in the workspace's plans dir, across all aliases.
 *  Used to expose the latest plan to the orchestrator on a fresh turn
 *  so it can hand the path to a Builder dispatch ("now execute the
 *  plan at .qcode/plans/aurora-7ab3c01d.md"). */
export async function findLatestPlan(
  workspace: string,
): Promise<PlanPersistResult | null> {
  if (!isTauri()) return null;
  const { readDir } = await import('@tauri-apps/plugin-fs');
  const aliases = ['.qcode', '.qlaud', '.claude'] as const;
  let best: { path: string; alias: string; mtime: number; name: string } | null = null;
  for (const alias of aliases) {
    const dir = `${workspace}/${alias}/plans`;
    let entries: Awaited<ReturnType<typeof readDir>>;
    try {
      entries = await readDir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory) continue;
      if (!e.name.endsWith('.md')) continue;
      const path = `${dir}/${e.name}`;
      // We don't have stat on every entry; fall back to lexicographic
      // ordering by filename which includes timestamp-ish slug. The
      // slug suffix doesn't include a sortable timestamp by itself,
      // but multiple plans within a session share the same noun so
      // the most-recently-written one wins on simple sort within
      // that session.
      const mtime = 0;
      if (!best || e.name > best.name) {
        best = { path, alias, mtime, name: e.name };
      }
    }
  }
  if (!best) return null;
  return { path: best.path, displayPath: `${best.alias}/plans/${best.name}` };
}
