import { useState } from 'react';
import { MessageSquare, Trash2 } from 'lucide-react';

import { cn } from '../lib/cn';
import { prefetchThreadMessages } from '../lib/queries';
import type { ThreadSummary } from '../lib/threads';

export function ThreadList({
  threads,
  currentId,
  onPick,
  onDelete,
}: {
  threads: ThreadSummary[];
  currentId: string | null;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
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
      {threads.map((t) => (
        <Row
          key={t.id}
          thread={t}
          active={t.id === currentId}
          onPick={() => onPick(t.id)}
          onDelete={() => onDelete(t.id)}
          onHover={() => {
            // Hover prefetch: warms the message-history query so the
            // click-to-render is ≤1 frame from cache. Idempotent
            // (Query dedupes) and gated by the 30s staleTime in
            // prefetchThreadMessages, so this is cheap on hover-spam.
            void prefetchThreadMessages(t.id);
          }}
        />
      ))}
    </ul>
  );
}

function Row({
  thread,
  active,
  onPick,
  onDelete,
  onHover,
}: {
  thread: ThreadSummary;
  active: boolean;
  onPick: () => void;
  onDelete: () => void;
  onHover?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const stamp = relativeTime(thread.updatedAt);
  return (
    <li
      onMouseEnter={onHover}
      onFocus={onHover}
      className={cn(
        'group relative flex items-center gap-2 rounded px-2 py-1.5 text-left transition-colors',
        active ? 'bg-muted/80' : 'hover:bg-muted/50',
      )}
    >
      <button
        onClick={onPick}
        className="flex min-w-0 flex-1 items-center gap-2"
      >
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
    </li>
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
