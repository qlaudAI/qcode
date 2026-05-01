import { useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronRight,
  FolderTree,
  FileText,
  Loader2,
  Wrench,
} from 'lucide-react';

import { cn } from '../lib/cn';

type Status = 'running' | 'done' | 'error';

export type ToolCallView = {
  id: string;
  name: string;
  input: unknown;
  status: Status;
  /** Output text. May be long; we collapse by default and let the user expand. */
  output?: string;
};

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  list_files: FolderTree,
  read_file: FileText,
};

export function ToolCallCard({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[call.name] ?? Wrench;
  const summary = summarize(call);
  const hasOutput = call.status !== 'running' && (call.output?.length ?? 0) > 0;

  return (
    <div
      className={cn(
        'rounded-lg border bg-background/70 backdrop-blur-sm transition-colors',
        call.status === 'error'
          ? 'border-primary/30 bg-primary/5'
          : 'border-border/60',
      )}
    >
      <button
        onClick={() => hasOutput && setOpen((v) => !v)}
        disabled={!hasOutput}
        className={cn(
          'flex w-full items-center gap-2.5 px-3 py-2 text-left',
          hasOutput && 'cursor-pointer hover:bg-muted/40',
          !hasOutput && 'cursor-default',
        )}
      >
        <StatusIcon status={call.status} />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[12px] font-medium tabular-nums text-foreground">
              {call.name}
            </span>
            <span className="truncate text-[11px] font-mono text-muted-foreground">
              {summary}
            </span>
          </div>
        </div>
        {hasOutput && (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
        )}
      </button>
      {open && hasOutput && (
        <pre className="m-0 max-h-72 overflow-auto border-t border-border/40 bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/90">
          {call.output}
        </pre>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: Status }) {
  if (status === 'running') {
    return (
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
    );
  }
  if (status === 'error') {
    return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-primary" />;
  }
  return <Check className="h-3.5 w-3.5 shrink-0 text-foreground/70" />;
}

function summarize(call: ToolCallView): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  switch (call.name) {
    case 'list_files':
    case 'read_file':
      return typeof input.path === 'string' ? input.path : '…';
    default:
      // Generic fallback — show the first non-trivial input value.
      for (const [, v] of Object.entries(input)) {
        if (typeof v === 'string' && v.length > 0)
          return v.length > 60 ? v.slice(0, 57) + '…' : v;
      }
      return '';
  }
}
