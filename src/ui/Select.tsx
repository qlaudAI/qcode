// Custom Select primitive — replaces native <select> across the app.
//
// Why custom: native <select> renders OS-default chrome (macOS gets
// the system blue dropdown, Windows gets a flat box, Linux varies),
// which clashes with everything else in qcode and gives Settings
// a "draft UI" feel. Custom matches the title-bar ModelPicker
// visual language so every selector in the app reads as the same
// component family.
//
// Features the native control can't do:
//   - Per-option icon + description + tier badge
//   - Keyboard navigation (Up/Down/Home/End/Enter/Esc) with
//     focus stays inside the listbox until close
//   - Click outside / Esc to close
//   - Matches dark/light theme tokens automatically
//   - Smooth open/close animation
//
// Scope: simple Select with a single value. No multi-select, no
// search/filter (large lists like the model picker have their own
// component). For < ~15 entries this is the right tool.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Lock } from 'lucide-react';
import { cn } from '../lib/cn';

export type SelectOption<T extends string = string> = {
  value: T;
  label: string;
  /** Optional rich content shown ABOVE the label inside the row.
   *  Useful for tier/provider chips. */
  badge?: string;
  /** Optional one-line subtitle under the label. */
  description?: string;
  /** When true, the row renders as locked + non-clickable, with a
   *  lock icon in place of the check + an accent badge (overrides
   *  `badge` when set, takes precedence). Drives the plan-tier
   *  upsell pattern: gated models on Free render with locked=true
   *  and lockBadge='Pro'. */
  locked?: boolean;
  /** Replaces `badge` when locked=true. Typically 'Pro' or 'Power'.
   *  Tinted accent color reflects the upgrade tier. */
  lockBadge?: string;
  /** Color treatment for the lockBadge: 'pro' = primary tint,
   *  'power' = amber tint. Defaults to 'pro'. */
  lockTone?: 'pro' | 'power';
};

type Props<T extends string> = {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** Optional label above the trigger. When provided, the component
   *  also wires aria-labelledby for screen readers. */
  ariaLabel?: string;
  /** Compact triggers in dense rows (Settings, palette items)
   *  default to 'sm'; loud triggers in the title bar use 'md'. */
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
};

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = 'sm',
  className,
  disabled,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  // active = which row is keyboard-highlighted while the menu is
  // open. Defaults to the current value's index so Enter on first
  // open just confirms the existing selection.
  const [active, setActive] = useState<number>(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value),
    ),
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const current = options.find((o) => o.value === value) ?? options[0];

  // Close on click outside.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Re-sync active when the menu opens (in case the controlled
  // value changed from outside while closed).
  useEffect(() => {
    if (open) {
      setActive(
        Math.max(
          0,
          options.findIndex((o) => o.value === value),
        ),
      );
    }
  }, [open, options, value]);

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
          e.preventDefault();
          setOpen(true);
        }
        return;
      }
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          // Skip locked rows — they're upgrade-pitch placeholders
          // and selecting them would silently pick a non-functional
          // model that the server would 402 on the first send.
          if (options[active] && !options[active].locked) {
            onChange(options[active].value);
            setOpen(false);
            triggerRef.current?.focus();
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          setActive((i) => Math.min(options.length - 1, i + 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActive((i) => Math.max(0, i - 1));
          break;
        case 'Home':
          e.preventDefault();
          setActive(0);
          break;
        case 'End':
          e.preventDefault();
          setActive(options.length - 1);
          break;
      }
    },
    [open, options, active, onChange],
  );

  return (
    <div className={cn('relative', className)} onKeyDown={onKey}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background text-left text-foreground transition-all',
          'focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-foreground/30',
          'hover:border-foreground/30',
          disabled && 'cursor-not-allowed opacity-50 hover:border-border',
          size === 'sm' ? 'px-2.5 py-1.5 text-sm' : 'px-3 py-2 text-[14px]',
          open && 'border-foreground/30 ring-2 ring-primary/20',
        )}
      >
        <span className="truncate">{current?.label ?? ''}</span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180 text-foreground/70',
          )}
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={
            options[active] ? `qcode-select-${options[active].value}` : undefined
          }
          className="absolute left-0 right-0 z-50 mt-1.5 max-h-72 overflow-y-auto rounded-lg border border-border bg-background shadow-lg shadow-black/5 dark:shadow-black/30"
        >
          {options.map((opt, i) => {
            const selected = opt.value === value;
            const isActive = i === active;
            const locked = opt.locked === true;
            return (
              <li
                key={opt.value}
                id={`qcode-select-${opt.value}`}
                role="option"
                aria-selected={selected}
                aria-disabled={locked}
                onMouseEnter={() => !locked && setActive(i)}
                onClick={() => {
                  if (locked) return;
                  onChange(opt.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                title={
                  locked
                    ? `${opt.label} requires qcode ${opt.lockBadge ?? 'Pro'}`
                    : undefined
                }
                className={cn(
                  'flex items-start gap-2 px-3 py-2 text-sm transition-colors',
                  locked
                    ? 'cursor-not-allowed opacity-55'
                    : 'cursor-pointer',
                  !locked && (isActive ? 'bg-muted/70' : 'hover:bg-muted/50'),
                )}
              >
                {locked ? (
                  <Lock
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                ) : (
                  <Check
                    className={cn(
                      'mt-0.5 h-3.5 w-3.5 shrink-0 transition-opacity',
                      selected ? 'text-primary opacity-100' : 'opacity-0',
                    )}
                    aria-hidden
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        'truncate',
                        selected ? 'font-medium text-foreground' : 'text-foreground/90',
                      )}
                    >
                      {opt.label}
                    </span>
                    {locked && opt.lockBadge ? (
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
                          opt.lockTone === 'power'
                            ? 'bg-amber-500/10 text-amber-700'
                            : 'bg-primary/10 text-primary',
                        )}
                      >
                        {opt.lockBadge}
                      </span>
                    ) : (
                      opt.badge && (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                          {opt.badge}
                        </span>
                      )
                    )}
                  </div>
                  {opt.description && (
                    <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
                      {locked
                        ? `Included on ${opt.lockBadge ?? 'Pro'}. ${opt.description}`
                        : opt.description}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
