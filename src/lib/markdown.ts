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
  | { type: 'link'; href: string; tokens: Inline[] };

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
  return out;
}
