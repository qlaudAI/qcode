import { useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronRight,
  FilePlus,
  FileSearch,
  FileText,
  FolderTree,
  Loader2,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { BashView } from './tool-output/BashView';
import { GlobView } from './tool-output/GlobView';
import { GrepView } from './tool-output/GrepView';
import { ListFilesView } from './tool-output/ListFilesView';
import { ReadFileView } from './tool-output/ReadFileView';

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
  glob: FileSearch,
  grep: Search,
  write_file: FilePlus,
  edit_file: Pencil,
  bash: Terminal,
};

export function ToolCallCard({ call }: { call: ToolCallView }) {
  const [userToggled, setUserToggled] = useState(false);
  const [open, setOpenState] = useState(false);
  const Icon = ICONS[call.name] ?? Wrench;
  const summary = summarize(call);
  // Show the output panel as soon as there's output, even mid-stream.
  // Auto-expand on the first chunk while running so the user sees
  // bash progress without clicking; stop auto-managing once the user
  // toggles it themselves.
  const hasOutput = (call.output?.length ?? 0) > 0;
  const streaming = call.status === 'running' && hasOutput;
  const effectivelyOpen = userToggled ? open : streaming || open;
  function setOpen(next: boolean) {
    setUserToggled(true);
    setOpenState(next);
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-background/70 backdrop-blur-sm transition-colors',
        call.status === 'error'
          ? 'border-primary/30 bg-primary/5'
          : 'border-border/60',
      )}
    >
      <button
        onClick={() => hasOutput && setOpen(!effectivelyOpen)}
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
            {streaming && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                live
              </span>
            )}
          </div>
        </div>
        {hasOutput && (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
              effectivelyOpen && 'rotate-90',
            )}
          />
        )}
      </button>
      {effectivelyOpen && hasOutput && (
        <div className="border-t border-border/40 bg-muted/20">
          <Output call={call} />
        </div>
      )}
    </div>
  );
}

// ─── Output dispatcher ─────────────────────────────────────────────

function Output({ call }: { call: ToolCallView }) {
  const output = call.output ?? '';
  const input = (call.input ?? {}) as Record<string, unknown>;
  switch (call.name) {
    case 'list_files':
      return <ListFilesView output={output} />;
    case 'read_file':
      return (
        <ReadFileView
          path={typeof input.path === 'string' ? input.path : undefined}
          output={output}
        />
      );
    case 'glob':
      return <GlobView output={output} />;
    case 'grep':
      return (
        <GrepView
          output={output}
          pattern={typeof input.pattern === 'string' ? input.pattern : undefined}
        />
      );
    case 'bash':
      return <BashView output={output} isError={call.status === 'error'} />;
    default:
      return (
        <pre className="m-0 max-h-72 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/90">
          {output}
        </pre>
      );
  }
}

// ─── Status pip ────────────────────────────────────────────────────

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

// ─── Per-tool one-line summary in the header ──────────────────────

function summarize(call: ToolCallView): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  switch (call.name) {
    case 'list_files':
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return typeof input.path === 'string' ? input.path : '…';
    case 'glob':
      return typeof input.pattern === 'string' ? input.pattern : '…';
    case 'grep': {
      const p = typeof input.pattern === 'string' ? input.pattern : '…';
      const path = typeof input.path === 'string' ? ` in ${input.path}` : '';
      return p + path;
    }
    case 'bash':
      return typeof input.command === 'string' ? input.command : '…';
    default:
      for (const [, v] of Object.entries(input)) {
        if (typeof v === 'string' && v.length > 0)
          return v.length > 60 ? v.slice(0, 57) + '…' : v;
      }
      return '';
  }
}
