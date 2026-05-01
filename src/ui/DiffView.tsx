import { cn } from '../lib/cn';
import type { DiffLine } from '../lib/diff';

// Compact unified-diff renderer. We collapse long runs of unchanged
// lines (more than CONTEXT*2) so big files don't wall the UI; the
// user can expand a hidden region if they need to see it.

const CONTEXT = 3;

type Group =
  | { kind: 'changed'; lines: DiffLine[] }
  | { kind: 'context'; lines: DiffLine[]; collapsed: number };

export function DiffView({ lines }: { lines: DiffLine[] }) {
  const groups = collapse(lines);

  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-muted/30 font-mono text-[11.5px] leading-snug">
      {groups.map((g, gi) => (
        <Group key={gi} group={g} />
      ))}
    </div>
  );
}

function Group({ group }: { group: Group }) {
  if (group.kind === 'context' && group.collapsed > 0) {
    return (
      <div className="flex items-center justify-center bg-muted/40 px-3 py-1 text-[10px] tracking-wide text-muted-foreground">
        ⋯ {group.collapsed} unchanged line{group.collapsed === 1 ? '' : 's'} ⋯
      </div>
    );
  }
  return (
    <div>
      {group.lines.map((line, i) => (
        <Line key={i} line={line} />
      ))}
    </div>
  );
}

function Line({ line }: { line: DiffLine }) {
  return (
    <div
      className={cn(
        'grid grid-cols-[36px_36px_1fr] items-baseline',
        line.kind === 'add' && 'bg-emerald-500/10',
        line.kind === 'remove' && 'bg-rose-500/10',
      )}
    >
      <Gutter n={line.oldLineNo} />
      <Gutter n={line.newLineNo} />
      <pre
        className={cn(
          'overflow-x-auto whitespace-pre py-0.5 pl-2 pr-3 font-mono',
          line.kind === 'add' && 'text-emerald-700',
          line.kind === 'remove' && 'text-rose-700',
          line.kind === 'context' && 'text-foreground/80',
        )}
      >
        {prefix(line.kind)}
        {line.text || ' '}
      </pre>
    </div>
  );
}

function Gutter({ n }: { n: number | null }) {
  return (
    <span className="border-r border-border/40 px-1 text-right text-[10px] tabular-nums text-muted-foreground/70">
      {n ?? ''}
    </span>
  );
}

function prefix(kind: DiffLine['kind']): string {
  if (kind === 'add') return '+ ';
  if (kind === 'remove') return '- ';
  return '  ';
}

function collapse(lines: DiffLine[]): Group[] {
  const groups: Group[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i++;
      continue;
    }
    if (line.kind !== 'context') {
      // Run of changed lines.
      const start = i;
      while (i < lines.length && lines[i]?.kind !== 'context') i++;
      groups.push({ kind: 'changed', lines: lines.slice(start, i) });
      continue;
    }
    // Run of context lines. Trailing/leading CONTEXT stays visible;
    // the middle collapses with a count if the run exceeds 2*CONTEXT.
    const start = i;
    while (i < lines.length && lines[i]?.kind === 'context') i++;
    const run = lines.slice(start, i);
    if (run.length <= CONTEXT * 2) {
      groups.push({ kind: 'context', lines: run, collapsed: 0 });
      continue;
    }
    const isFirst = start === 0;
    const isLast = i === lines.length;
    const head = isFirst ? [] : run.slice(0, CONTEXT);
    const tail = isLast ? [] : run.slice(-CONTEXT);
    const collapsedCount = run.length - head.length - tail.length;
    if (head.length) groups.push({ kind: 'context', lines: head, collapsed: 0 });
    if (collapsedCount > 0)
      groups.push({ kind: 'context', lines: [], collapsed: collapsedCount });
    if (tail.length) groups.push({ kind: 'context', lines: tail, collapsed: 0 });
  }
  return groups;
}
