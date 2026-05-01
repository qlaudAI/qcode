import { useState } from 'react';
import { MessageSquare, Trash2 } from 'lucide-react';

import { cn } from '../lib/cn';
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
}: {
  thread: ThreadSummary;
  active: boolean;
  onPick: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li
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
          'shrink-0 rounded p-1 transition-opacity',
          confirming
            ? 'text-primary opacity-100'
            : 'text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100',
        )}
        title={confirming ? 'Click again to confirm' : 'Delete'}
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </li>
  );
}
