// Unified right-rail panel — single column on the right of the chat
// surface that can host any of six workbench views, all sharing the
// same width so the chat layout stays stable as the user flips
// between them. Mirrors Codex's pattern (Preview / Diff / Terminal /
// Files / Tasks / Plan, accessible via the titlebar dropdown).
//
// Each view is a small focused subcomponent. New views slot in by
// adding the discriminator + a render branch — no other glue.

import {
  CheckCircle2,
  ChevronRight,
  GitCompare,
  ListTodo,
  Loader2,
  Play,
  Terminal as TerminalIcon,
  X,
  XCircle,
} from 'lucide-react';
import type React from 'react';

import { cn } from '../lib/cn';
import { FileTree } from './FileTree';
import type { ToolCallView } from './ToolCallCard';

export type RightRailView =
  | 'tasks'
  | 'plan'
  | 'files'
  | 'terminal'
  | 'preview'
  | 'diff';

// The render-block shape is mirrored from ChatSurface so the rail
// can run as a leaf component without circular imports. We only
// need the tool/text variants for now; expand on demand.
type ToolBlock = { type: 'tool'; call: ToolCallView };
type AnyBlock = ToolBlock | { type: string; [k: string]: unknown };

export type RightRailProps = {
  view: RightRailView;
  blocks: AnyBlock[];
  workspacePath?: string | null;
  onClose?: () => void;
};

export function RightRail({
  view,
  blocks,
  workspacePath,
  onClose,
}: RightRailProps) {
  const tools = blocks
    .filter((b): b is ToolBlock => b.type === 'tool')
    .filter((b) => b.call.name !== 'todo_write');

  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l border-border/40 bg-background/60 backdrop-blur-sm md:flex">
      <header className="flex h-10 items-center justify-between border-b border-border/40 px-3">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold capitalize text-foreground">
            {view}
          </span>
          {view === 'tasks' && tools.length > 0 && (
            <TaskCounts tools={tools} />
          )}
        </div>
        {onClose && (
          <button
            aria-label="Close panel"
            onClick={onClose}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === 'tasks' && <TasksView tools={tools} />}
        {view === 'plan' && <PlanView blocks={blocks} />}
        {view === 'files' && <FilesView workspacePath={workspacePath} />}
        {view === 'terminal' && <ComingSoon icon={TerminalIcon} label="Terminal" hint="Live persistent shell session — coming next." />}
        {view === 'preview' && <ComingSoon icon={Play} label="Preview" hint="Browser preview powered by Playwright MCP — coming next." />}
        {view === 'diff' && <ComingSoon icon={GitCompare} label="Diff" hint="Inline git diff viewer — coming next." />}
      </div>
    </aside>
  );
}

// ─── Tasks ────────────────────────────────────────────────────────

function TaskCounts({ tools }: { tools: ToolBlock[] }) {
  const counts = tools.reduce(
    (acc, t) => {
      acc[t.call.status] = (acc[t.call.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  return (
    <span className="text-[10px] tabular-nums text-muted-foreground">
      {counts.completed
        ? `${counts.completed} done`
        : `${tools.length} total`}
      {counts.error ? ` · ${counts.error} failed` : ''}
      {counts.running ? ` · ${counts.running} running` : ''}
    </span>
  );
}

function TasksView({ tools }: { tools: ToolBlock[] }) {
  const reversed = [...tools].reverse();
  if (reversed.length === 0) {
    return (
      <p className="px-4 py-3 text-[11.5px] leading-relaxed text-muted-foreground">
        No tools run yet this thread. Tool calls (read_file, bash,
        browser_navigate, …) will show up here as they happen, with
        a status pip you can scan at a glance.
      </p>
    );
  }
  return (
    <ul className="space-y-0.5 p-2">
      {reversed.map((t) => (
        <TaskRow key={t.call.id} call={t.call} />
      ))}
    </ul>
  );
}

function TaskRow({ call }: { call: ToolCallView }) {
  const summary = oneLineSummary(call);
  const onClick = () => {
    const el = document.getElementById(`tool-${call.id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('qcode-row-flash');
      setTimeout(() => el.classList.remove('qcode-row-flash'), 1200);
    }
  };
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
      >
        <TaskStatusPip status={call.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate font-mono text-[11px] font-medium text-foreground">
              {call.name}
            </span>
            <span
              className={cn(
                'shrink-0 rounded-sm px-1 py-0 text-[9px] font-medium uppercase tracking-wider',
                call.status === 'running'
                  ? 'bg-primary/10 text-primary'
                  : call.status === 'error'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              {call.status === 'running'
                ? 'running'
                : call.status === 'error'
                  ? 'failed'
                  : 'done'}
            </span>
          </div>
          {summary && (
            <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
              {summary}
            </div>
          )}
        </div>
      </button>
    </li>
  );
}

function TaskStatusPip({ status }: { status: ToolCallView['status'] }) {
  if (status === 'running') {
    return (
      <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-primary" />
    );
  }
  if (status === 'error') {
    return <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />;
  }
  return (
    <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
  );
}

function oneLineSummary(call: ToolCallView): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.command === 'string') return truncate(input.command, 60);
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.description === 'string') return input.description;
  if (typeof input.element === 'string') return input.element;
  return '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ─── Plan (mirror of the inline TodoListPanel) ────────────────────

type TodoItem = {
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
};

function PlanView({ blocks }: { blocks: AnyBlock[] }) {
  // Walk reverse for the latest todo_write tool call.
  let latest: TodoItem[] | null = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b?.type !== 'tool') continue;
    const call = (b as ToolBlock).call;
    if (call.name !== 'todo_write') continue;
    const input = call.input as { todos?: unknown };
    if (Array.isArray(input?.todos)) {
      latest = input.todos.filter(
        (t): t is TodoItem =>
          !!t &&
          typeof t === 'object' &&
          typeof (t as TodoItem).content === 'string',
      );
      break;
    }
  }
  if (!latest || latest.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <ListTodo className="h-5 w-5 text-muted-foreground/60" />
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          No plan yet. Ask the agent to do something multi-step and
          it&rsquo;ll lay out a todo list here as it works.
        </p>
      </div>
    );
  }
  const done = latest.filter((t) => t.status === 'completed').length;
  return (
    <div className="p-3">
      <div className="mb-2 flex items-baseline gap-2 px-1 text-[11px] tabular-nums text-muted-foreground">
        <span>
          {done}/{latest.length} done
        </span>
      </div>
      <ul className="space-y-1.5">
        {latest.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-[12.5px]">
            <PlanStatusIcon status={t.status} />
            <span
              className={cn(
                'flex-1 leading-snug transition-colors',
                t.status === 'completed'
                  ? 'text-muted-foreground line-through decoration-muted-foreground/40'
                  : t.status === 'in_progress'
                    ? 'font-medium text-foreground'
                    : 'text-foreground/85',
              )}
            >
              {t.status === 'in_progress' ? t.activeForm : t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlanStatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') {
    return (
      <span
        className="mt-1 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
        aria-hidden
      >
        <CheckCircle2 className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span
        className="mt-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
        aria-hidden
      >
        <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
      </span>
    );
  }
  return (
    <span
      className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border border-muted-foreground/30"
      aria-hidden
    />
  );
}

// ─── Files (workspace tree) ───────────────────────────────────────

function FilesView({ workspacePath }: { workspacePath?: string | null }) {
  if (!workspacePath) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <ChevronRight className="h-5 w-5 text-muted-foreground/60" />
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Open a folder to browse the project tree here.
        </p>
      </div>
    );
  }
  return (
    <div className="p-2">
      <FileTree rootPath={workspacePath} />
    </div>
  );
}

// ─── Coming-soon placeholder ──────────────────────────────────────

function ComingSoon({
  icon: Icon,
  label,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-muted/60 text-foreground/70">
        <Icon className="h-4 w-4" />
      </span>
      <div className="space-y-1">
        <p className="text-[12.5px] font-semibold text-foreground">{label}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  );
}
