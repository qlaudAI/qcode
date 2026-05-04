import { useMemo, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';

import { cn } from '../lib/cn';
import { MODELS, type ModelEntry } from '../lib/models';
import { useTextModels } from '../lib/queries';

// Drop the brand prefix on tight viewports so the picker doesn't
// wrap. "Claude Sonnet 4.6" → "Sonnet 4.6", "GPT-5.4 mini" stays
// (already short), "DeepSeek Chat" → "DeepSeek Chat" (no brand
// prefix to drop). The tooltip preserves the full label.
function shortLabel(label: string): string {
  return label.replace(/^Claude\s+/, '').trim();
}

export function ModelPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (slug: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Live catalog (with localStorage seed) drives the list. Falls
  // back to bundled MODELS during the very first cold start before
  // the network fetch lands.
  const models = useTextModels();
  // Group memoization: the catalog can change between renders (refetch
  // lands), so re-derive the grouped view when it does. Cheap —
  // ~12 entries, single linear pass.
  const grouped = useMemo(() => groupByProvider(models), [models]);
  const current =
    models.find((m) => m.slug === value) ?? models[0] ?? MODELS[0]!;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-[60vw] items-center gap-1.5 rounded border border-border/60 bg-background px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:border-foreground/30"
        title={`${current.provider} · ${current.label}`}
      >
        {/* Provider tag is helpful context on desktop but eats too
         *  much horizontal real estate in the mobile titlebar (see
         *  the wrap-3-line bug). Hide it below sm. */}
        <span className="hidden rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-primary sm:inline">
          {current.provider}
        </span>
        <span className="truncate">{shortLabel(current.label)}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <ul
            role="listbox"
            className="absolute right-0 z-40 mt-1.5 max-h-96 w-80 overflow-y-auto rounded-lg border border-border bg-background shadow-lg"
          >
            {grouped.map((group) => (
              <li key={group.provider}>
                <div className="sticky top-0 z-10 border-b border-border/40 bg-muted/40 px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground backdrop-blur">
                  {group.provider}
                </div>
                <ul>
                  {group.models.map((m) => (
                    <li key={m.slug}>
                      <button
                        role="option"
                        aria-selected={m.slug === value}
                        onClick={() => {
                          onChange(m.slug);
                          setOpen(false);
                        }}
                        className={cn(
                          'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-muted',
                          m.slug === value && 'bg-muted/60',
                        )}
                      >
                        <Check
                          className={cn(
                            'mt-0.5 h-3.5 w-3.5 shrink-0',
                            m.slug === value ? 'text-primary' : 'opacity-0',
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-xs font-medium">
                              {m.label}
                            </span>
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                              {m.tier}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                            {m.blurb}
                          </p>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function groupByProvider(
  models: ModelEntry[],
): Array<{ provider: string; models: ModelEntry[] }> {
  const map = new Map<string, ModelEntry[]>();
  for (const m of models) {
    const arr = map.get(m.provider);
    if (arr) arr.push(m);
    else map.set(m.provider, [m]);
  }
  return Array.from(map.entries()).map(([provider, models]) => ({
    provider,
    models,
  }));
}
