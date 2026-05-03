// Minimal YAML frontmatter parser. Used by skills + custom agents
// (both load markdown files with a YAML header that declares
// metadata, plus a body the agent reads).
//
// Why not pull js-yaml: 700 KB+ for two-line scalar values + arrays
// is an awful tradeoff. Skills and agent frontmatter are simple by
// design — the spec is "key: value" or "key: [a, b, c]" or "key:\n
// - a\n  - b". Anything fancier (nested mappings, multi-line block
// scalars, anchors) we don't need and shouldn't encourage.
//
// The parser is forgiving by intent: malformed frontmatter degrades
// to "no frontmatter" so the user's broken file doesn't crash the
// loader; they'll see the missing-required-field error instead.

export type Frontmatter = Record<string, string | string[] | boolean | number | null>;

export type ParsedDoc = {
  frontmatter: Frontmatter;
  /** Body (markdown) with the frontmatter block stripped. Already
   *  trimmed of leading whitespace. */
  body: string;
};

/** Split a markdown source into frontmatter + body. Frontmatter is
 *  the YAML block bounded by `---` lines at the very top of the file.
 *  Files without a leading `---` get an empty frontmatter and the
 *  whole content as body. */
export function parseDocument(source: string): ParsedDoc {
  const trimmed = source.replace(/^﻿/, ''); // strip BOM
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(trimmed);
  if (!fmMatch) {
    return { frontmatter: {}, body: trimmed.trim() };
  }
  const fmRaw = fmMatch[1] ?? '';
  const body = trimmed.slice(fmMatch[0].length).trim();
  return { frontmatter: parseFrontmatter(fmRaw), body };
}

/** Parse a YAML-shaped frontmatter body. Supports:
 *    key: value           (string scalar)
 *    key: "value"         (quoted scalar — strips quotes)
 *    key: 'value'         (single-quoted)
 *    key: true|false      (boolean)
 *    key: 42              (number)
 *    key:                 (null when no value)
 *    key: [a, b, c]       (inline array)
 *    key:                 (block array — keys followed by indented `- item` lines)
 *      - a
 *      - b
 *
 *  Comments (`# ...`) are stripped. Unknown shapes degrade to a
 *  string scalar. */
export function parseFrontmatter(raw: string): Frontmatter {
  const out: Frontmatter = {};
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim() || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1]!;
    const rawValue = stripInlineComment(m[2] ?? '');
    if (!rawValue) {
      // Could be either null (`key:`) or a block array.
      const blockItems: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? '';
        const itemMatch = /^\s+-\s+(.+?)\s*$/.exec(next);
        if (itemMatch) {
          blockItems.push(parseScalar(stripInlineComment(itemMatch[1]!)) as string);
          j++;
          continue;
        }
        // Blank line continues the array; non-empty + non-list
        // line ends it.
        if (!next.trim()) {
          j++;
          continue;
        }
        break;
      }
      if (blockItems.length > 0) {
        out[key] = blockItems;
        i = j;
      } else {
        out[key] = null;
        i++;
      }
      continue;
    }
    out[key] = parseScalar(rawValue);
    i++;
  }
  return out;
}

function parseScalar(raw: string): string | string[] | boolean | number | null {
  const v = raw.trim();
  if (!v) return null;
  // Inline array: [a, b, c]
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1);
    return inner
      .split(',')
      .map((s) => parseScalar(s.trim()))
      .map((s) => (typeof s === 'string' ? s : String(s ?? ''))); // flatten to strings
  }
  // Quoted scalar
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  // Boolean
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  // Number
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  // Otherwise plain string
  return v;
}

function stripInlineComment(s: string): string {
  // Strip ` # comment` while preserving `#` inside quoted strings.
  // Cheap heuristic: only strip when ` #` appears outside the first
  // quoted run.
  const q1 = s.indexOf('"');
  const q2 = s.indexOf("'");
  const firstQuote = q1 === -1 ? q2 : q2 === -1 ? q1 : Math.min(q1, q2);
  if (firstQuote === -1) {
    const hashIdx = s.indexOf(' #');
    return hashIdx === -1 ? s : s.slice(0, hashIdx);
  }
  return s; // contains a quote — leave conservative
}

/** Coerce a frontmatter value to a string array. Single strings →
 *  [string]. Used by `tools:` / `disallowedTools:` etc. where the
 *  user might write `tools: bash` or `tools: [bash, read_file]`. */
export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}

/** Coerce a frontmatter value to a string, returning '' if absent. */
export function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
