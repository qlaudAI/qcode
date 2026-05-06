import { useState } from 'react';
import { MessageSquare, Pin, PinOff, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import { cn } from '../lib/cn';
import { useInFlightThreads } from '../lib/in-flight';
import { prefetchThreadMessages } from '../lib/queries';
import type { ThreadSummary } from '../lib/threads';

export function ThreadList({
  threads,
  currentId,
  onPick,
  onDelete,
  onTogglePin,
  snippetByThread,
}: {
  threads: ThreadSummary[];
  currentId: string | null;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  /** Toggle pin state. Optional — sections that don't want pins
   *  (semantic-search results, anything non-canonical) leave it
   *  unwired and the row hides the pin affordance. */
  onTogglePin?: (id: string) => void;
  /** Per-thread excerpt from semantic search, rendered under the
   *  title so the user gets a content preview without opening the
   *  thread. Null/undefined entries fall back to title-only. */
  snippetByThread?: Map<string, string> | null;
}) {
  // Reactive set of threads currently mid-turn — bumps whenever a
  // turn starts/lands so each row's "running" pulse dot turns on
  // and off in real time even when it isn't the active thread.
  const inFlight = useInFlightThreads();
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
            running={inFlight.has(t.id)}
            onPick={() => onPick(t.id)}
            onDelete={() => onDelete(t.id)}
            onTogglePin={onTogglePin ? () => onTogglePin(t.id) : undefined}
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
  running,
  onPick,
  onDelete,
  onTogglePin,
  onHover,
}: {
  thread: ThreadSummary;
  snippet: string | null;
  active: boolean;
  /** This thread has a turn running in the background — show a
   *  pulsing dot so the user knows it's still working even when
   *  they've switched to a different thread. Driven by the
   *  reactive useInFlightThreads() set in the parent. */
  running: boolean;
  onPick: () => void;
  onDelete: () => void;
  onTogglePin?: () => void;
  onHover?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const stamp = relativeTime(thread.updatedAt);
  const pinned = !!thread.pinnedAt;
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
          {pinned ? (
            <Pin
              className={cn(
                'h-3 w-3 shrink-0 fill-current',
                active ? 'text-primary' : 'text-primary/80',
              )}
              aria-label="Pinned"
            />
          ) : (
            <MessageSquare
              className={cn(
                'h-3 w-3 shrink-0',
                active ? 'text-foreground' : 'text-muted-foreground',
              )}
            />
          )}
          <span
            className={cn(
              'truncate text-xs',
              active ? 'font-medium text-foreground' : 'text-foreground/85',
              !thread.title && 'text-muted-foreground/70 italic',
            )}
          >
            {/* Empty title = thread server-side has title=NULL.
             *  Render the placeholder at display time only — never
             *  store 'New chat' as the actual title (the server
             *  rejects that string at PATCH time too, so the column
             *  stays NULL until LLM regen produces a real title). */}
            {thread.title || 'New chat'}
          </span>
        </div>
        {snippet && (
          <span className="ml-5 truncate text-[11px] leading-snug text-muted-foreground">
            {snippet}
          </span>
        )}
      </button>
      {/* Right-side rail: timestamp by default; on hover (or when
       *  the row is pinned), reveal pin + trash actions. The
       *  timestamp fades out under the actions so the row width
       *  doesn't jitter as state changes. */}
      <div className="relative flex shrink-0 items-center gap-1.5">
        {/* Background-running indicator — pulsing primary dot when
         *  this thread has a turn streaming while the user is
         *  elsewhere. Stays visible even while the action buttons
         *  reveal on hover, because "is this thread working?" is
         *  more important than the timestamp. */}
        {running && (
          <span
            className="grid h-3 w-3 place-items-center"
            title="Working in the background"
            aria-label="Running"
          >
            <span className="absolute h-3 w-3 animate-ping rounded-full bg-primary/60" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-primary" />
          </span>
        )}
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
        <div
          className={cn(
            'absolute inset-y-0 right-0 flex items-center gap-0.5 transition-opacity',
            confirming ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          {onTogglePin && (
            <button
              type="button"
              aria-label={pinned ? 'Unpin conversation' : 'Pin conversation'}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin();
              }}
              className={cn(
                'grid place-items-center rounded p-1 transition-colors',
                pinned
                  ? 'text-primary hover:text-primary/80'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              title={pinned ? 'Unpin' : 'Pin to top'}
            >
              {pinned ? (
                <PinOff className="h-3 w-3" />
              ) : (
                <Pin className="h-3 w-3" />
              )}
            </button>
          )}
          <button
            type="button"
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
              'grid place-items-center rounded p-1 transition-all',
              confirming
                ? 'scale-110 text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
            title={confirming ? 'Click again to confirm' : 'Delete'}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
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
