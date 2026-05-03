// Allow/deny permission rules layered on top of the YOLO/Smart/Strict
// auto-approve mode. Pattern from Claude Code's three-tier rule
// storage (utils/permissions/permissions.ts) — projects can declare
// "this bash pattern is always allowed without asking" or "never run
// this command, even on yolo." Rules persist to disk so they apply
// consistently across qcode sessions.
//
// Rule format (matches Claude Code's wire form):
//   "ToolName"               — applies to ALL invocations of the tool
//   "ToolName(content)"      — applies when content matches a glob:
//     "Bash(npm:*)"          — any bash starting with "npm "
//     "Bash(pnpm install)"   — exact-match bash command
//     "WebFetch(domain:github.com)"  — domain match
//     "write_file(src/**)"   — path glob
//
// Storage layers (read in this order; deny ALWAYS wins):
//   1. .qcode/permissions.json or .qlaud/ or .claude/ — project-level
//   2. .qcode/permissions.local.json — gitignored, machine-specific
//   3. ~/.qlaud/permissions.json or ~/.claude/permissions.json — user-tier
//      (deferred to a future alpha; the loader reads them today but
//      no UI to edit yet — power users can hand-write the JSON)
//
// Decision logic:
//   - ANY deny rule matches → DENY (refuse before approval prompt fires)
//   - ANY allow rule matches → ALLOW (skip approval, run silently)
//   - No match → fall through to YOLO/Smart/Strict mode behavior

import { CONFIG_DIR_ALIASES } from './qcode-paths';
import { isTauri } from './tauri';

export type PermissionRule = string;

export type PermissionRuleset = {
  allow: PermissionRule[];
  deny: PermissionRule[];
};

export type RuleSource = 'project' | 'local' | 'user';

export type ResolvedRuleset = {
  /** Combined allow rules across all tiers, deduplicated. */
  allow: PermissionRule[];
  /** Combined deny rules across all tiers. Deny always wins so we
   *  never need per-tier provenance for blocking — we just need the
   *  full set. */
  deny: PermissionRule[];
  /** Per-source breakdown for UI / debugging. Not used by evaluate. */
  sources: Array<{
    source: RuleSource;
    path: string;
    allow: number;
    deny: number;
  }>;
};

const EMPTY: ResolvedRuleset = { allow: [], deny: [], sources: [] };

const CACHE = new Map<string, ResolvedRuleset>();

export async function getPermissionRules(
  workspace: string,
): Promise<ResolvedRuleset> {
  if (CACHE.has(workspace)) return CACHE.get(workspace)!;
  const ruleset = await loadFromDisk(workspace);
  CACHE.set(workspace, ruleset);
  return ruleset;
}

export function clearPermissionRulesCache(workspace?: string): void {
  if (workspace === undefined) CACHE.clear();
  else CACHE.delete(workspace);
}

async function loadFromDisk(workspace: string): Promise<ResolvedRuleset> {
  if (!isTauri()) return EMPTY;
  const { exists, readTextFile } = await import('@tauri-apps/plugin-fs');
  const sources: ResolvedRuleset['sources'] = [];
  const allow: PermissionRule[] = [];
  const deny: PermissionRule[] = [];
  const seenAllow = new Set<string>();
  const seenDeny = new Set<string>();

  // Layer 1: project rules. First alias hit wins (we don't merge
  // permissions.json across aliases — that'd be confusing for users
  // who happen to have both .qcode/ and .claude/ dirs).
  for (const alias of CONFIG_DIR_ALIASES) {
    const path = `${workspace}/${alias}/permissions.json`;
    if (!(await exists(path))) continue;
    const ruleset = await loadJson(readTextFile, path);
    if (ruleset) {
      sources.push({
        source: 'project',
        path: `${alias}/permissions.json`,
        allow: ruleset.allow.length,
        deny: ruleset.deny.length,
      });
      mergeRules(ruleset, allow, deny, seenAllow, seenDeny);
      break;
    }
  }

  // Layer 2: local rules (gitignored). Same alias-priority order;
  // local file is .permissions.local.json so users keep machine-
  // specific overrides separate from team-shared rules.
  for (const alias of CONFIG_DIR_ALIASES) {
    const path = `${workspace}/${alias}/permissions.local.json`;
    if (!(await exists(path))) continue;
    const ruleset = await loadJson(readTextFile, path);
    if (ruleset) {
      sources.push({
        source: 'local',
        path: `${alias}/permissions.local.json`,
        allow: ruleset.allow.length,
        deny: ruleset.deny.length,
      });
      mergeRules(ruleset, allow, deny, seenAllow, seenDeny);
      break;
    }
  }

  // Layer 3: user-tier rules (~/.qlaud/permissions.json,
  // ~/.claude/permissions.json). Users edit by hand for now; UI to
  // come in a follow-up alpha.
  try {
    const { homeDir } = await import('@tauri-apps/api/path');
    const home = (await homeDir()).replace(/\/+$/, '');
    for (const alias of ['.qlaud', '.claude'] as const) {
      const path = `${home}/${alias}/permissions.json`;
      if (!(await exists(path))) continue;
      const ruleset = await loadJson(readTextFile, path);
      if (ruleset) {
        sources.push({
          source: 'user',
          path: `~/${alias}/permissions.json`,
          allow: ruleset.allow.length,
          deny: ruleset.deny.length,
        });
        mergeRules(ruleset, allow, deny, seenAllow, seenDeny);
        break;
      }
    }
  } catch {
    // Home dir lookup failed (sandboxed?). Skip user-tier.
  }

  return { allow, deny, sources };
}

async function loadJson(
  readTextFile: (path: string) => Promise<string>,
  path: string,
): Promise<PermissionRuleset | null> {
  try {
    const raw = await readTextFile(path);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as { allow?: unknown; deny?: unknown };
    return {
      allow: Array.isArray(obj.allow)
        ? obj.allow.filter((x): x is string => typeof x === 'string')
        : [],
      deny: Array.isArray(obj.deny)
        ? obj.deny.filter((x): x is string => typeof x === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

function mergeRules(
  ruleset: PermissionRuleset,
  allow: PermissionRule[],
  deny: PermissionRule[],
  seenAllow: Set<string>,
  seenDeny: Set<string>,
): void {
  for (const r of ruleset.allow) {
    if (seenAllow.has(r)) continue;
    seenAllow.add(r);
    allow.push(r);
  }
  for (const r of ruleset.deny) {
    if (seenDeny.has(r)) continue;
    seenDeny.add(r);
    deny.push(r);
  }
}

// ─── Decision evaluation ─────────────────────────────────────────

export type RuleDecision =
  | { kind: 'deny'; matchedRule: PermissionRule }
  | { kind: 'allow'; matchedRule: PermissionRule }
  | { kind: 'no_match' };

/** Evaluate the ruleset against a tool invocation. Deny wins if any
 *  rule on the deny list matches; otherwise the FIRST matching allow
 *  rule lets it through; otherwise no_match (caller falls back to
 *  the auto-approve mode). */
export function evaluateRule(
  rules: ResolvedRuleset,
  toolName: string,
  toolContent: string,
): RuleDecision {
  // Deny first.
  for (const rule of rules.deny) {
    if (matchesRule(rule, toolName, toolContent)) {
      return { kind: 'deny', matchedRule: rule };
    }
  }
  for (const rule of rules.allow) {
    if (matchesRule(rule, toolName, toolContent)) {
      return { kind: 'allow', matchedRule: rule };
    }
  }
  return { kind: 'no_match' };
}

/** True when the rule applies to a specific tool invocation. Format:
 *
 *    "Bash"                   — matches ANY bash (no content scope)
 *    "Bash(npm:*)"            — content starts with "npm "
 *    "Bash(pnpm install)"     — content exact-match
 *    "WebFetch(domain:gh.com)"— domain shorthand
 *
 *  Tool-name comparison is case-insensitive; the registry uses lower-
 *  case names but users sometimes write "Bash" by Claude Code habit. */
export function matchesRule(
  rule: PermissionRule,
  toolName: string,
  toolContent: string,
): boolean {
  const m = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return false;
  const ruleName = m[1]!;
  const ruleContent = m[2];
  if (ruleName.toLowerCase() !== toolName.toLowerCase()) return false;
  if (!ruleContent) return true; // tool-level rule, no content scope

  // Content match. Three forms:
  //  - "domain:foo.com" → domain shorthand for WebFetch URL
  //  - "<glob>"         → glob pattern via globToRegex
  //  - "<exact>"        → exact-match (when no glob meta-chars)
  if (ruleContent.startsWith('domain:')) {
    const wanted = ruleContent.slice('domain:'.length).trim().toLowerCase();
    try {
      const u = new URL(toolContent);
      return u.hostname.toLowerCase() === wanted;
    } catch {
      return false;
    }
  }
  if (/[*?[]/.test(ruleContent)) {
    return globMatch(ruleContent, toolContent);
  }
  return ruleContent === toolContent;
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return re.test(value);
}

/** Helper: stringify a tool's input for content matching. Different
 *  tools have different "content" concepts — bash has command,
 *  write_file/edit_file have path, web_fetch has url. The dispatcher
 *  passes the right field; this helper just normalizes whatever we
 *  receive into the string the rule matcher expects. */
export function contentForTool(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  switch (toolName) {
    case 'bash':
    case 'bash_status':
      return typeof obj.command === 'string' ? obj.command : '';
    case 'write_file':
    case 'edit_file':
    case 'read_file':
    case 'list_files':
      return typeof obj.path === 'string' ? obj.path : '';
    case 'glob':
      return typeof obj.pattern === 'string' ? obj.pattern : '';
    case 'grep':
      return typeof obj.pattern === 'string' ? obj.pattern : '';
    case 'browser_navigate':
      return typeof obj.url === 'string' ? obj.url : '';
    default:
      // Best effort: first string field of the input. Lets users
      // write rules for newer/custom tools without us having to
      // enumerate them.
      for (const v of Object.values(obj)) {
        if (typeof v === 'string') return v;
      }
      return '';
  }
}
