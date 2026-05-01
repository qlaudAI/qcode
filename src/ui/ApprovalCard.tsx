import { Check, FilePlus, FileText, Terminal, X } from 'lucide-react';

import { cn } from '../lib/cn';
import type { ApprovalRequest } from '../lib/tools';
import { DiffView } from './DiffView';

export type ApprovalCardProps = {
  request: ApprovalRequest;
  /** Resolved when the user has decided. The chat surface holds the
   *  promise resolver and uses it to drive the agent loop forward. */
  onAllow: () => void;
  onReject: () => void;
  /** Set when the user has already responded; freezes the buttons. */
  resolved?: 'allow' | 'reject';
};

export function ApprovalCard(props: ApprovalCardProps) {
  const { request } = props;
  if (request.kind === 'bash') return <BashCard {...props} request={request} />;
  return <FileChangeCard {...props} request={request} />;
}

// ─── File write / edit ──────────────────────────────────────────────

function FileChangeCard(
  props: ApprovalCardProps & {
    request: Extract<ApprovalRequest, { kind: 'write_file' | 'edit_file' }>;
  },
) {
  const { request, onAllow, onReject, resolved } = props;
  const isNew = request.kind === 'write_file' && request.isNew;
  const Icon = isNew ? FilePlus : FileText;

  return (
    <div className="overflow-hidden rounded-lg border border-foreground/15 bg-background shadow-[0_2px_8px_rgba(0,0,0,0.04),0_12px_28px_rgba(0,0,0,0.06)]">
      <header className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[12px] font-medium tracking-tight">
          {isNew
            ? 'Create file'
            : request.kind === 'write_file'
              ? 'Overwrite file'
              : 'Edit file'}
        </span>
        <span className="truncate text-[11px] font-mono text-muted-foreground">
          {request.path}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[11px] tabular-nums">
          <span className="text-emerald-700">+{request.added}</span>
          <span className="text-rose-700">−{request.removed}</span>
        </span>
      </header>

      <div className="max-h-[360px] overflow-y-auto p-2">
        <DiffView lines={request.diff} />
      </div>

      <Footer
        resolved={resolved}
        onAllow={onAllow}
        onReject={onReject}
        allowLabel={isNew ? 'Create' : request.kind === 'write_file' ? 'Overwrite' : 'Apply edit'}
      />
    </div>
  );
}

// ─── Bash ───────────────────────────────────────────────────────────

function BashCard(
  props: ApprovalCardProps & { request: Extract<ApprovalRequest, { kind: 'bash' }> },
) {
  const { request, onAllow, onReject, resolved } = props;
  return (
    <div className="overflow-hidden rounded-lg border border-foreground/15 bg-background shadow-[0_2px_8px_rgba(0,0,0,0.04),0_12px_28px_rgba(0,0,0,0.06)]">
      <header className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2">
        <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[12px] font-medium tracking-tight">
          Run shell command
        </span>
        <span className="ml-auto truncate text-[10px] font-mono text-muted-foreground">
          {request.cwd.split(/[/\\]/).pop()}
        </span>
      </header>

      <pre className="m-0 max-h-44 overflow-auto bg-[#0a0a0a] px-4 py-3 font-mono text-[12px] leading-snug text-emerald-300">
        $ {request.command}
      </pre>

      <Footer
        resolved={resolved}
        onAllow={onAllow}
        onReject={onReject}
        allowLabel="Run"
      />
    </div>
  );
}

// ─── Shared footer ─────────────────────────────────────────────────

function Footer({
  resolved,
  onAllow,
  onReject,
  allowLabel,
}: {
  resolved?: 'allow' | 'reject';
  onAllow: () => void;
  onReject: () => void;
  allowLabel: string;
}) {
  if (resolved === 'allow') {
    return (
      <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <Check className="h-3 w-3 text-emerald-700" /> Approved
      </div>
    );
  }
  if (resolved === 'reject') {
    return (
      <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <X className="h-3 w-3 text-rose-700" /> Rejected
      </div>
    );
  }
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-3 py-2">
      <button
        onClick={onReject}
        className="rounded-md border border-border bg-background px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:border-foreground/30"
      >
        Reject
      </button>
      <button
        onClick={onAllow}
        className={cn(
          'rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90',
        )}
      >
        {allowLabel}
      </button>
    </div>
  );
}
