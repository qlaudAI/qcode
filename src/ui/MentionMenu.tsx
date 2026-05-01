import { useEffect, useMemo } from 'react';
import { FileText } from 'lucide-react';

import { cn } from '../lib/cn';
import { fuzzyScore } from '../lib/fuzzy';

// Floating autocomplete shown over the composer when the user types
// `@`. Pure-presentational: parent owns query state + selection;
// this only renders + announces hover/click intents.

const MAX_RESULTS = 8;

type Props = {
  files: string[];
  query: string;
  active: number;
  onPick: (path: string) => void;
  onHover: (i: number) => void;
};

export function MentionMenu({
  files,
  query,
  active,
  onPick,
  onHover,
}: Props) {
  const results = useMemo(() => {
    if (!query) {
      return files.slice(0, MAX_RESULTS);
    }
    const scored: Array<{ p: string; s: number }> = [];
    for (const p of files) {
      const s = fuzzyScore(query, p);
      if (s !== null) scored.push({ p, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, MAX_RESULTS).map((x) => x.p);
  }, [files, query]);

  // Defensive: out-of-range active when the result set shrinks.
  useEffect(() => {
    if (active >= results.length && results.length > 0) onHover(0);
  }, [results, active, onHover]);

  if (results.length === 0) return null;

  return (
    <div className="absolute bottom-full left-2 right-2 z-20 mb-1.5 overflow-hidden rounded-md border border-border bg-background shadow-[0_2px_8px_rgba(0,0,0,0.06),0_12px_28px_rgba(0,0,0,0.08)]">
      <ul role="listbox">
        {results.map((p, i) => (
          <li key={p}>
            <button
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(p);
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
                i === active ? 'bg-muted/70' : 'hover:bg-muted/40',
              )}
            >
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-[12px] text-foreground/90">
                {p}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="border-t border-border/40 bg-muted/20 px-3 py-1 text-[10px] text-muted-foreground">
        ↑↓ to navigate · ⏎ to attach · esc to dismiss
      </div>
    </div>
  );
}

export function getMentionResults(
  files: string[],
  query: string,
): string[] {
  if (!query) return files.slice(0, MAX_RESULTS);
  const scored: Array<{ p: string; s: number }> = [];
  for (const p of files) {
    const s = fuzzyScore(query, p);
    if (s !== null) scored.push({ p, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, MAX_RESULTS).map((x) => x.p);
}
