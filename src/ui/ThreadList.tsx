import { useState } from 'react';
import { MessageSquare, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import { cn } from '../lib/cn';
import { prefetchThreadMessages } from '../lib/queries';
import type { ThreadSummary } from '../lib/threads';

export function ThreadList({
  threads,
  currentId,
  onPick,
  onDelete,
  snippetByThread,
}: {
  threads: ThreadSummary[];
  currentId: string | null;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  /** Per-thread excerpt from semantic search, rendered under the
   *  title so the user gets a content preview without opening the
   *  thread. Null/undefined entries fall back to title-only. */
  snippetByThread?: Map<string, string> | null;
}) {
  if (threads.length === 0) {
    return (
      <p className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        No conversations yet. Press ⌘N to start one.
      </p>
    );
  }
  return (
    <ul className="space-y-0.5">
      {/* AnimatePresence wraps each Row so:
       *   - new threads fade + slide in (a fresh send / synced from
       *     another device makes a row appear, not just pop in)
       *   - deleted threads fade + slide out (delete animation
       *     instead of an instant disappear)
       *   - layout="position" smooths reorder when lastActiveAt
       *     changes (a recently-active thread moves up)
       *  initial={false} on AnimatePresence means existing rows
       *  don't re-animate when the parent re-renders — only NEW
       *  rows do. */}
      <AnimatePresence initial={false}>
        {threads.map((t) => (
          <Row
            key={t.id}
            thread={t}
            snippet={snippetByThread?.get(t.id) ?? null}
            active={t.id === currentId}
            onPick={() => onPick(t.id)}
            onDelete={() => onDelete(t.id)}
            onHover={() => {
              // Hover prefetch: warms the message-history query so
              // the click-to-render is ≤1 frame from cache. Idempotent
              // (Query dedupes) and gated by the 30s staleTime in
              // prefetchThreadMessages, so this is cheap on hover-spam.
              void prefetchThreadMessages(t.id);
            }}
          />
        ))}
      </AnimatePresence>
    </ul>
  );
}

function Row({
  thread,
  snippet,
  active,
  onPick,
  onDelete,
  onHover,
}: {
  thread: ThreadSummary;
  snippet: string | null;
  active: boolean;
  onPick: () => void;
  onDelete: () => void;
  onHover?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const stamp = relativeTime(thread.updatedAt);
  return (
    <motion.li
      // layout="position" only: animate the row's vertical position
      // when reorder happens (lastActiveAt changes → row moves up),
      // but DON'T animate width/height — those would jitter on
      // every text reflow inside the row. Snappy 180ms tween.
      layout="position"
      transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
      // Entry: subtle slide-in from the left, like the row was
      // pushed onto the stack. Exit: collapse height + fade so a
      // delete reads as "this is going away" not "this vanished."
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -8, height: 0, marginTop: 0, marginBottom: 0 }}
      onMouseEnter={onHover}
      onFocus={onHover}
      className={cn(
        'group relative flex items-start gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left transition-all duration-150 active:scale-[0.99]',
        active
          ? 'bg-primary/[0.06] shadow-sm shadow-primary/5'
          : 'hover:bg-muted/60',
      )}
    >
      {/* Active-state indicator — a 2.5px primary bar on the left
       *  that animates in when this row becomes active. Layout ID
       *  makes motion smoothly translate the bar from the previous
       *  active row to this one when the user picks. Slight glow
       *  via shadow gives it weight without being loud. */}
      {active && (
        <motion.span
          layoutId="qcode-thread-active-indicator"
          className="absolute inset-y-1 left-0 w-[2.5px] rounded-full bg-primary shadow-[0_0_8px_rgba(var(--primary),0.4)]"
          transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
        />
      )}
      <button
        onClick={onPick}
        className="flex min-w-0 flex-1 flex-col gap-0.5"
      >
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare
            className={cn(
              'h-3 w-3 shrink-0',
              active ? 'text-foreground' : 'text-muted-foreground',
            )}
          />
          <span
            className={cn(
              'truncate text-xs',
              active ? 'font-medium text-foreground' : 'text-foreground/85',
            )}
          >
            {thread.title}
          </span>
        </div>
        {snippet && (
          <span className="ml-5 truncate text-[11px] leading-snug text-muted-foreground">
            {snippet}
          </span>
        )}
      </button>
      {/* Right-side rail: timestamp by default, swaps for the trash
       *  affordance on hover. Two micro-states (idle / confirming)
       *  animate via transition-opacity on top of the timestamp so
       *  the user sees motion when they engage, nothing otherwise. */}
      <div className="relative shrink-0">
        <span
          className={cn(
            'pointer-events-none block text-[10px] tabular-nums text-muted-foreground/70 transition-opacity',
            confirming
              ? 'opacity-0'
              : 'opacity-100 group-hover:opacity-0',
          )}
        >
          {stamp}
        </span>
        <button
          aria-label="Delete conversation"
          onClick={(e) => {
            e.stopPropagation();
            if (confirming) {
              onDelete();
              setConfirming(false);
            } else {
              setConfirming(true);
              setTimeout(() => setConfirming(false), 2500);
            }
          }}
          className={cn(
            'absolute inset-y-0 right-0 grid place-items-center rounded p-1 transition-all',
            confirming
              ? 'text-primary opacity-100 scale-110'
              : 'text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100',
          )}
          title={confirming ? 'Click again to confirm' : 'Delete'}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </motion.li>
  );
}

// Compact relative-time formatter. "now" under 60s; minutes / hours /
// days / weeks until 30 days; absolute date past that. Tuned for
// sidebar density — single-glyph units (3h, 1w) keep rows narrow.
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return 'now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(day / 365)}y`;
}
