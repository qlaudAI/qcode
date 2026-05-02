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
  RefreshCw,
  Terminal as TerminalIcon,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';

import { cn } from '../lib/cn';
import { readWorkspaceDiff, type FileDiff } from '../lib/git-info';
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
    <>
      {/* Mobile scrim — taps close the sheet. md+ never sees this. */}
      <button
        aria-label="Close panel"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm md:hidden"
      />
      <aside
        className={cn(
          // Mobile: bottom-anchored sheet that takes 75dvh, slides up
          // over the chat. Desktop md+: in-flow column on the right
          // (272px wide) with the chat surface to the left.
          'fixed inset-x-0 bottom-0 z-50 flex h-[75dvh] flex-col rounded-t-xl border-t border-border/40 bg-background/95 backdrop-blur-md',
          'md:static md:h-auto md:w-72 md:shrink-0 md:rounded-none md:border-l md:border-t-0 md:bg-background/60',
        )}
      >
        {/* Sheet grabber on mobile only — visual handoff that this is
         *  draggable-feeling. Just decoration; actual close is via
         *  the X button or scrim tap. */}
        <div className="mx-auto mt-1.5 h-1 w-9 shrink-0 rounded-full bg-border md:hidden" />
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
        {view === 'diff' && <DiffView workspacePath={workspacePath} />}
          {view === 'terminal' && <TerminalView tools={tools} />}
          {view === 'preview' && <ComingSoon icon={Play} label="Preview" hint="Browser preview powered by Playwright MCP — coming next." />}
        </div>
      </aside>
    </>
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

// ─── Terminal (recent bash) ───────────────────────────────────────
//
// Surfaces every bash tool call from the current thread as a
// terminal-style scrollback. Each entry shows the command + its
// stdout/stderr in a chronological feed; latest pinned to the
// bottom (terminal convention). Lifts the inline BashView output
// out of the chat blocks and into a persistent reading lens —
// useful when the agent runs ten commands and you want to scan
// them as a build log instead of scrolling through prose.

function TerminalView({ tools }: { tools: ToolBlock[] }) {
  const bash = tools.filter((t) => t.call.name === 'bash');
  if (bash.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <TerminalIcon className="h-5 w-5 text-muted-foreground/60" />
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          No shell commands run yet. When the agent uses bash, the
          output streams in here as a chronological log.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-2">
      {bash.map((b) => (
        <TerminalEntry key={b.call.id} call={b.call} />
      ))}
    </div>
  );
}

function TerminalEntry({ call }: { call: ToolCallView }) {
  const command = (call.input as { command?: string })?.command ?? '';
  const out = call.output ?? '';
  const exitMatch = /^exit (\d+)/.exec(out);
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1] ?? '0', 10) : null;
  const ok = call.status === 'done' && (exitCode === 0 || exitCode === null);
  const stdoutMatch = /\n--- stdout ---\n([\s\S]*?)(?=\n--- stderr ---|$)/m.exec(out);
  const stderrMatch = /\n--- stderr ---\n([\s\S]*)$/m.exec(out);
  const stdout = stdoutMatch?.[1]?.trim() ?? '';
  const stderr = stderrMatch?.[1]?.trim() ?? '';
  const body = stdout || stderr || (call.status === 'running' ? '(running…)' : out);
  return (
    <div className="overflow-hidden rounded border border-border/40">
      <div className="flex items-center gap-1.5 border-b border-border/40 bg-muted/40 px-2 py-1 text-[10.5px]">
        <span
          className={cn(
            'inline-flex h-1.5 w-1.5 rounded-full',
            call.status === 'running'
              ? 'bg-primary animate-pulse'
              : ok
                ? 'bg-emerald-500'
                : 'bg-primary',
          )}
          aria-hidden
        />
        <span className="font-mono text-foreground/85">$</span>
        <span className="min-w-0 flex-1 truncate font-mono text-foreground/85">
          {command}
        </span>
        {exitCode != null && (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            exit {exitCode}
          </span>
        )}
      </div>
      <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap bg-[#0a0a0a] px-2 py-1.5 font-mono text-[10.5px] leading-snug text-[#d8d8d8]">
        {body || ' '}
      </pre>
      {stderr && stdout && (
        <pre className="m-0 max-h-32 overflow-auto whitespace-pre-wrap border-t border-white/10 bg-[#0a0a0a] px-2 py-1.5 font-mono text-[10.5px] leading-snug text-rose-300">
          {stderr}
        </pre>
      )}
    </div>
  );
}

// ─── Diff (uncommitted changes) ───────────────────────────────────

function DiffView({ workspacePath }: { workspacePath?: string | null }) {
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());

  // Fetch on mount + on workspace change. The user can also manual-
  // refresh via the reload button — we don't auto-poll because git
  // diff isn't free, and the user knows when they want fresh state.
  useEffect(() => {
    if (!workspacePath) {
      setFiles(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void readWorkspaceDiff(workspacePath).then((d) => {
      if (!cancelled) {
        setFiles(d);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  const refresh = () => {
    if (!workspacePath) return;
    setLoading(true);
    void readWorkspaceDiff(workspacePath).then((d) => {
      setFiles(d);
      setLoading(false);
    });
  };

  if (!workspacePath) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <GitCompare className="h-5 w-5 text-muted-foreground/60" />
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Open a folder to see uncommitted changes here.
        </p>
      </div>
    );
  }

  if (loading && !files) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" />
        <p className="text-[11.5px] text-muted-foreground">Reading diff…</p>
      </div>
    );
  }

  if (!files || files.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Working tree is clean — no uncommitted changes.
        </p>
        <button
          onClick={refresh}
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>
    );
  }

  const totalAdded = files.reduce((a, f) => a + f.added, 0);
  const totalRemoved = files.reduce((a, f) => a + f.removed, 0);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-2">
        <div className="flex items-baseline gap-2 text-[11px] tabular-nums">
          <span className="text-muted-foreground">{files.length} files</span>
          <span className="text-emerald-600 dark:text-emerald-400">
            +{totalAdded}
          </span>
          <span className="text-primary">−{totalRemoved}</span>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh diff"
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw
            className={cn('h-3 w-3', loading && 'animate-spin')}
          />
        </button>
      </div>
      <ul className="space-y-0.5 p-2">
        {files.map((f) => (
          <DiffRow
            key={f.path}
            file={f}
            open={openFiles.has(f.path)}
            onToggle={() =>
              setOpenFiles((prev) => {
                const next = new Set(prev);
                if (next.has(f.path)) next.delete(f.path);
                else next.add(f.path);
                return next;
              })
            }
          />
        ))}
      </ul>
    </div>
  );
}

function DiffRow({
  file,
  open,
  onToggle,
}: {
  file: FileDiff;
  open: boolean;
  onToggle: () => void;
}) {
  const statusColor =
    file.status === '??'
      ? 'text-muted-foreground'
      : file.status === 'D'
        ? 'text-primary'
        : file.status === 'A' || file.status.includes('A')
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-foreground/85';
  return (
    <li>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <span
          className={cn(
            'shrink-0 font-mono text-[10px] font-semibold tabular-nums',
            statusColor,
          )}
        >
          {file.status || '·'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/85">
          {file.path}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {file.added > 0 && (
            <span className="text-emerald-600 dark:text-emerald-400">
              +{file.added}
            </span>
          )}
          {file.added > 0 && file.removed > 0 && ' '}
          {file.removed > 0 && (
            <span className="text-primary">−{file.removed}</span>
          )}
        </span>
      </button>
      {open && file.patch && <DiffPatch patch={file.patch} />}
      {open && !file.patch && (
        <p className="ml-7 mt-1 text-[10.5px] text-muted-foreground">
          {file.status === '??'
            ? '(untracked file — no diff to show)'
            : '(diff too large to render inline)'}
        </p>
      )}
    </li>
  );
}

function DiffPatch({ patch }: { patch: string }) {
  // Color +/- lines green/red, headers (@@ ... @@) muted. Strips the
  // diff --git / index lines for compactness — those don't help in
  // a sidebar reading flow.
  const lines = patch
    .split('\n')
    .filter(
      (l) =>
        !l.startsWith('diff --git ') &&
        !l.startsWith('index ') &&
        !l.startsWith('--- ') &&
        !l.startsWith('+++ '),
    );
  return (
    <pre className="ml-7 mt-1 max-h-72 overflow-auto rounded border border-border/40 bg-muted/30 px-2 py-1.5 font-mono text-[10.5px] leading-snug">
      {lines.map((l, i) => {
        if (l.startsWith('@@')) {
          return (
            <div key={i} className="text-muted-foreground/80">
              {l}
            </div>
          );
        }
        if (l.startsWith('+')) {
          return (
            <div
              key={i}
              className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            >
              {l}
            </div>
          );
        }
        if (l.startsWith('-')) {
          return (
            <div
              key={i}
              className="bg-primary/10 text-primary"
            >
              {l}
            </div>
          );
        }
        return (
          <div key={i} className="text-foreground/70">
            {l}
          </div>
        );
      })}
    </pre>
  );
}

// ─── Coming-soon placeholder ──────────────────────────────────────

function ComingSoon({
  icon: Icon,
  label,
  hint,
}: {
  icon: ComponentType<{ className?: string }>;
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
