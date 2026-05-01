// Hand-rolled markdown → React tokens. We don't pull in marked /
// remark / unified — they're well-tested but each adds 30–80 KB to
// the bundle. Coding-agent output is constrained:
//
//   - fenced code blocks (```lang … ```)
//   - inline code (`x`)
//   - bold (**x**) and italic (*x*)
//   - headings (#, ##, ###)
//   - bulleted (- ) and numbered (1. ) lists
//   - links ([label](url))
//   - paragraphs separated by blank lines
//
// That's the whole grammar. ~120 LOC, zero deps. We emit a flat
// AST that <Markdown> renders; this keeps the tokenizer trivial
// and the renderer trivial.

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; tokens: Inline[] }
  | { type: 'code_block'; lang: string; code: string }
  | {
      type: 'list';
      ordered: boolean;
      items: Inline[][];
    };

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; tokens: Inline[] }
  | { type: 'italic'; tokens: Inline[] }
  | { type: 'link'; href: string; tokens: Inline[] }
  /** Workspace-relative file path mentioned in assistant text.
   *  Clicking opens the file in the user's default editor. */
  | { type: 'file_link'; path: string; line: number | null };

export function parseMarkdown(src: string): Block[] {
  const lines = src.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code block
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        codeLines.push(lines[i] ?? '');
        i++;
      }
      i++; // skip closing fence (or end of input)
      blocks.push({ type: 'code_block', lang, code: codeLines.join('\n') });
      continue;
    }

    // Heading
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({
        type: 'heading',
        level: h[1]!.length as 1 | 2 | 3,
        text: h[2]!.trim(),
      });
      i++;
      continue;
    }

    // List (consume contiguous list lines)
    const listOpen = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (listOpen) {
      const ordered = /^\d+\./.test(listOpen[2]!);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i] ?? '');
        if (!m) break;
        items.push(parseInline(m[3] ?? ''));
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Blank line — paragraph separator
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph: consume contiguous non-empty, non-special lines
    const start = i;
    while (i < lines.length) {
      const cur = lines[i] ?? '';
      if (!cur.trim()) break;
      if (/^```/.test(cur)) break;
      if (/^#{1,3}\s/.test(cur)) break;
      if (/^(\s*)([-*]|\d+\.)\s+/.test(cur)) break;
      i++;
    }
    const para = lines.slice(start, i).join(' ');
    blocks.push({ type: 'paragraph', tokens: parseInline(para) });
  }

  return blocks;
}

// Inline parser. Order of operations matters: code spans first so
// later passes don't tokenize their contents. Then links, then bold,
// then italic, then plain text.
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let buf = '';

  function flush() {
    if (buf) {
      out.push({ type: 'text', text: buf });
      buf = '';
    }
  }

  while (i < src.length) {
    const ch = src[i];

    if (ch === '`') {
      const close = src.indexOf('`', i + 1);
      if (close > i) {
        flush();
        out.push({ type: 'code', text: src.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    if (ch === '[') {
      const end = src.indexOf('](', i + 1);
      const close = end > i ? src.indexOf(')', end) : -1;
      if (end > i && close > end) {
        flush();
        const label = src.slice(i + 1, end);
        const href = src.slice(end + 2, close);
        out.push({ type: 'link', href, tokens: parseInline(label) });
        i = close + 1;
        continue;
      }
    }

    if (ch === '*' && src[i + 1] === '*') {
      const close = src.indexOf('**', i + 2);
      if (close > i) {
        flush();
        out.push({ type: 'bold', tokens: parseInline(src.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if (ch === '*') {
      const close = src.indexOf('*', i + 1);
      if (close > i && src[close - 1] !== ' ') {
        flush();
        out.push({
          type: 'italic',
          tokens: parseInline(src.slice(i + 1, close)),
        });
        i = close + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return linkifyFilePaths(out);
}

// ─── File-path detection ──────────────────────────────────────────
//
// Walk the token tree post-parse and split `text` tokens whenever a
// path-like substring appears. We require at least one slash before
// the extension to avoid false positives on prose ("the readme.md
// approach is fine") — model output that wants to refer to a root-
// level file should write `./readme.md`. The regex also picks up the
// optional `:line` suffix Claude Code et al. emit (`src/auth.ts:42`).

// Match either:
//   ./<filename>.<ext>            — explicit root-relative form
//   <dir>/<…dirs>/<file>.<ext>    — path with at least one directory
// Optional :<line> suffix in both cases. We don't match bare
// filenames (`README.md` in prose) because the false-positive rate
// is too high — model that wants to link a root file should write
// `./README.md`.
const FILE_PATH_RE =
  /(?:\.\/[\w.-]+|(?:[\w@-][\w.-]*\/)+[\w.-]+)\.[a-zA-Z][\w]{0,5}(?::\d+)?/g;

function linkifyFilePaths(tokens: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const t of tokens) {
    if (t.type === 'text') {
      out.push(...splitText(t.text));
    } else if (t.type === 'bold' || t.type === 'italic') {
      out.push({ ...t, tokens: linkifyFilePaths(t.tokens) });
    } else if (t.type === 'link') {
      // Don't recurse into explicit markdown links — the href there
      // is the source of truth, and link labels are user-authored.
      out.push(t);
    } else {
      out.push(t);
    }
  }
  return out;
}

function splitText(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  FILE_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_PATH_RE.exec(src)) !== null) {
    if (m.index > last) {
      out.push({ type: 'text', text: src.slice(last, m.index) });
    }
    const raw = m[0];
    // Strip leading "./" for the cleaner path we render.
    const cleaned = raw.startsWith('./') ? raw.slice(2) : raw;
    const colon = cleaned.lastIndexOf(':');
    const hasLine = colon > 0 && /^\d+$/.test(cleaned.slice(colon + 1));
    const path = hasLine ? cleaned.slice(0, colon) : cleaned;
    const line = hasLine ? Number.parseInt(cleaned.slice(colon + 1), 10) : null;
    out.push({ type: 'file_link', path, line });
    last = m.index + raw.length;
  }
  if (last < src.length) {
    out.push({ type: 'text', text: src.slice(last) });
  }
  return out.length ? out : [{ type: 'text', text: src }];
}
