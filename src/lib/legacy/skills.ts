// Skills registry — markdown files with YAML frontmatter that the
// model can call via the `skill(name)` tool to load on-demand context.
//
// Mirrors Claude Code's skill pattern (loadSkillsDir.ts): drop a file
// at `.claude/skills/<name>.md` (or `.qlaud/skills/`, `.qcode/skills/`,
// or user-tier `~/.qlaud/skills/`, `~/.claude/skills/`), and qcode
// surfaces it to the model with name + description in the system
// prompt. The model invokes `skill(name)` to load the full body when
// it decides the skill is relevant.
//
// Why on-demand: putting every skill body in the system prompt every
// turn is a token tax on conversations that don't need them. Listing
// them with one-line descriptions is cheap; bodies load lazily.
//
// File format:
//   ---
//   name: skill-name             (defaults to filename without .md)
//   description: One-line summary (REQUIRED — what the skill is for)
//   when_to_use: Usage guidance   (optional, freeform)
//   allowed-tools: [bash, read_file]  (optional, future use — not enforced yet)
//   model: claude-haiku-4-5       (optional, future use — could swap model when loaded)
//   ---
//   <markdown body the model reads when invoked>
//
// Files without a `description` are skipped (we won't surface a
// skill the model has no idea when to call).

import { asString, asStringArray, parseDocument } from './frontmatter';
import { listConfigDir } from './qcode-paths';
import { isTauri } from '../tauri';

export type Skill = {
  /** Stable identifier the model invokes via `skill(name)`. */
  name: string;
  /** One-line description shown in the model's system prompt skill
   *  catalog. The model uses this to decide when to load the skill. */
  description: string;
  /** Optional longer guidance — when to use, when not. */
  whenToUse: string;
  /** Optional tool subset declaration. Not currently enforced; reserved
   *  for a future "skills can restrict tools while loaded" feature. */
  allowedTools: string[];
  /** Optional preferred model slug. Not currently enforced. */
  model: string;
  /** The markdown body — what the model reads when it calls
   *  `skill(name)`. */
  body: string;
  /** Source path for UI / debugging. */
  source: string;
};

const CACHE = new Map<string, Skill[]>();

/** Discover every skill in the workspace + user tier. Cached per
 *  workspace; call clearSkillsCache(workspace) when files change. */
export async function getSkills(workspace: string): Promise<Skill[]> {
  if (CACHE.has(workspace)) return CACHE.get(workspace)!;
  const skills = await loadSkills(workspace);
  CACHE.set(workspace, skills);
  return skills;
}

export function clearSkillsCache(workspace?: string): void {
  if (workspace === undefined) CACHE.clear();
  else CACHE.delete(workspace);
}

async function loadSkills(workspace: string): Promise<Skill[]> {
  if (!isTauri()) return [];
  const files = await listConfigDir({
    workspace,
    directoryName: 'skills',
    extensions: ['.md'],
  });
  if (files.length === 0) return [];

  const { readTextFile } = await import('@tauri-apps/plugin-fs');
  const skills: Skill[] = [];
  const seenNames = new Set<string>(); // closer-to-CWD wins on name conflict

  for (const f of files) {
    let raw: string;
    try {
      raw = await readTextFile(f.path);
    } catch {
      continue;
    }
    const { frontmatter, body } = parseDocument(raw);
    const description = asString(frontmatter.description).trim();
    if (!description) continue; // skill without description is unusable
    // Default name: file basename minus .md, or basename of containing
    // dir if file is named SKILL.md (Claude Code convention for
    // <name>/SKILL.md folder layout).
    const fileName = f.path.split('/').pop() ?? '';
    const fileBase = fileName.replace(/\.md$/i, '');
    const folderName = f.path.split('/').slice(-2, -1)[0] ?? '';
    const inferredName =
      fileBase.toUpperCase() === 'SKILL' ? folderName : fileBase;
    const name = (asString(frontmatter.name) || inferredName).trim();
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);

    skills.push({
      name,
      description,
      whenToUse: asString(frontmatter.when_to_use).trim(),
      allowedTools: asStringArray(frontmatter['allowed-tools']),
      model: asString(frontmatter.model).trim(),
      body: body.trim(),
      source: f.displayPath,
    });
  }
  return skills;
}

/** Render the skill catalog injected into the orchestrator's system
 *  prompt. Returns empty string when no skills — caller can
 *  unconditionally concatenate. */
export function skillsSystemSection(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => {
    const when = s.whenToUse ? ` — ${s.whenToUse}` : '';
    return `- **${s.name}** — ${s.description}${when}`;
  });
  return `\n\n## Available skills\n\nThe user has defined custom skills in their workspace's \`.qcode/skills/\` / \`.qlaud/skills/\` / \`.claude/skills/\` directory. Each skill is a markdown body you can load on demand by calling \`skill\` with the skill's name. Use them when the description matches the user's request.\n\n${lines.join('\n')}\n\nThe skill body loads when you call the tool — don't try to recall body contents from memory; always invoke the tool to get the canonical text.`;
}

/** Look up a skill by name. Used by the skill tool's executor. */
export function findSkill(skills: Skill[], name: string): Skill | null {
  const trimmed = name.trim();
  return skills.find((s) => s.name === trimmed) ?? null;
}
