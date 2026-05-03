import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';

import { cn } from '../../../lib/cn';

// grep emits one match per line: `path:line_no:content`. We parse,
// group by file, and let the user expand/collapse per-file. Default
// state shows files collapsed for files with 5+ matches and expanded
// otherwise — usually what you want when scanning results.

type Match = { lineNo: number; content: string };
type Group = { file: string; matches: Match[] };

export function GrepView({
  output,
  pattern,
}: {
  output: string;
  pattern?: string;
}) {
  const groups = parse(output);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const g of groups) if (g.matches.length >= 5) s.add(g.file);
    return s;
  });

  if (groups.length === 0) {
    return (
      <div className="px-3 py-3 text-[11.5px] text-muted-foreground">
        No matches.
      </div>
    );
  }

  function toggle(file: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }

  return (
    <div className="space-y-1 py-1.5">
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.file);
        return (
          <div key={g.file}>
            <button
              onClick={() => toggle(g.file)}
              className="flex w-full items-center gap-1.5 px-3 py-1 text-left transition-colors hover:bg-muted/40"
            >
              {isCollapsed ? (
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground/70" />
              <span className="truncate font-mono text-[11.5px] text-foreground/90">
                {g.file}
              </span>
              <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {g.matches.length}
              </span>
            </button>
            {!isCollapsed && (
              <ul className="mb-1">
                {g.matches.map((m, i) => (
                  <li
                    key={i}
                    className="grid grid-cols-[44px_1fr] gap-2 px-3 py-0.5 font-mono text-[11px] leading-snug"
                  >
                    <span className="text-right tabular-nums text-muted-foreground/70">
                      {m.lineNo}
                    </span>
                    <span className="overflow-x-auto whitespace-pre text-foreground/85">
                      {pattern
                        ? renderHighlighted(m.content, pattern)
                        : m.content}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function parse(output: string): Group[] {
  const lines = output.split('\n').filter((l) => l.length);
  const map = new Map<string, Match[]>();
  for (const line of lines) {
    if (line.startsWith('…')) continue;
    const i1 = line.indexOf(':');
    if (i1 < 0) continue;
    const i2 = line.indexOf(':', i1 + 1);
    if (i2 < 0) continue;
    const file = line.slice(0, i1);
    const lineNo = Number.parseInt(line.slice(i1 + 1, i2), 10);
    if (!Number.isFinite(lineNo)) continue;
    const content = line.slice(i2 + 1);
    if (!map.has(file)) map.set(file, []);
    map.get(file)!.push({ lineNo, content });
  }
  return Array.from(map.entries()).map(([file, matches]) => ({
    file,
    matches,
  }));
}

function renderHighlighted(text: string, pattern: string): React.ReactNode {
  // Best-effort: highlight every regex match. If the pattern doesn't
  // compile (rare — the agent's regex went through the executor), we
  // just render the line as-is.
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'g');
  } catch {
    return text;
  }
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <mark
        key={m.index}
        className={cn(
          'bg-amber-200/70 px-0.5 text-foreground',
        )}
      >
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++; // safety: zero-width match
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
