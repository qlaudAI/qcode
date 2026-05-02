import { useState } from 'react';
import {
  AlertCircle,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  Eye,
  FilePlus,
  FileSearch,
  FileText,
  FolderTree,
  Globe,
  Keyboard,
  Loader2,
  MousePointerClick,
  Pencil,
  Plug,
  Play,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { BashView } from './tool-output/BashView';
import { BrowserView } from './tool-output/BrowserView';
import { GlobView } from './tool-output/GlobView';
import { GrepView } from './tool-output/GrepView';
import { ListFilesView } from './tool-output/ListFilesView';
import { MetaToolView } from './tool-output/MetaToolView';
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
  // Built-in browser (Playwright MCP). Distinct icons per verb so the
  // timeline reads like a sequence of camera/click/keys moves.
  browser_navigate: Globe,
  browser_snapshot: Eye,
  browser_screenshot: Camera,
  browser_click: MousePointerClick,
  browser_type: Keyboard,
  browser_console: Terminal,
  // qlaud meta-tools — surfaced when tools_mode='dynamic' is on for
  // the request. Sparkles for "discover something new" actions, plug
  // for the credential connection flow, play for the executor.
  qlaud_search_tools: Sparkles,
  qlaud_get_tool_schemas: Wrench,
  qlaud_multi_execute: Play,
  qlaud_manage_connections: Plug,
  // verify runs the project's check command (typecheck/test/lint).
  // Same icon as the "approved" footer state — passes the eye-test
  // when scrolling: green checkmark = "the agent verified its work".
  verify: CheckCircle2,
};

export function ToolCallCard({
  call,
  workspace,
  embedded,
}: {
  call: ToolCallView;
  /** Workspace root path. Used to strip the prefix from tool
   *  inputs that pass absolute paths so the displayed summary
   *  reads `src/lib/tools.ts` instead of the full
   *  `/Users/robeltegegne/dev/qcode/src/lib/tools.ts`. Optional
   *  — falls back to displaying paths verbatim. */
  workspace?: string | null;
  /** True when this card renders INSIDE a ToolBundle. Drops the
   *  outer border + reduces padding so a stretch of bundled
   *  cards reads as a clean list, not a stack of nested boxes. */
  embedded?: boolean;
}) {
  const [userToggled, setUserToggled] = useState(false);
  const [open, setOpenState] = useState(false);
  const Icon = ICONS[call.name] ?? Wrench;
  const summary = summarize(call, workspace ?? null);
  const hasOutput = (call.output?.length ?? 0) > 0;
  // Auto-expand DURING streaming so users see bash progress without
  // clicking; auto-collapse once status flips to done/error to stop
  // bash output walls dominating the chat. Errors stay open so the
  // failure is visible. The user-toggle ref takes over the moment
  // they click, so manual choice persists across re-renders.
  const streaming = call.status === 'running' && hasOutput;
  const errored = call.status === 'error';
  const autoOpen = streaming || errored;
  const effectivelyOpen = userToggled ? open : autoOpen;
  function setOpen(next: boolean) {
    setUserToggled(true);
    setOpenState(next);
  }

  return (
    <div
      className={cn(
        'overflow-hidden bg-background/70 backdrop-blur-sm transition-colors',
        // Embedded inside a ToolBundle: drop the outer border so a
        // stretch of cards reads as a list, not nested boxes. The
        // bundle wrapper provides the surrounding border. Standalone
        // cards keep their own rounded border.
        embedded
          ? 'rounded-md'
          : cn(
              'rounded-lg border',
              call.status === 'error'
                ? 'border-primary/30 bg-primary/5'
                : 'border-border/60',
            ),
        call.status === 'error' && embedded && 'bg-primary/5',
      )}
    >
      <button
        onClick={() => hasOutput && setOpen(!effectivelyOpen)}
        disabled={!hasOutput}
        className={cn(
          'flex w-full items-center gap-2.5 text-left',
          embedded ? 'px-2 py-1' : 'px-3 py-2',
          hasOutput && 'cursor-pointer hover:bg-muted/40',
          !hasOutput && 'cursor-default',
        )}
      >
        <StatusIcon status={call.status} />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="shrink-0 text-[12px] font-medium tabular-nums text-foreground">
              {call.name}
            </span>
            <SummaryRow summary={summary} />
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
    case 'verify':
      return <BashView output={output} isError={call.status === 'error'} />;
    case 'browser_navigate':
    case 'browser_snapshot':
    case 'browser_screenshot':
    case 'browser_click':
    case 'browser_type':
    case 'browser_console':
      return (
        <BrowserView output={output} isError={call.status === 'error'} />
      );
    case 'qlaud_search_tools':
    case 'qlaud_get_tool_schemas':
    case 'qlaud_multi_execute':
    case 'qlaud_manage_connections':
      return (
        <MetaToolView
          name={call.name}
          input={call.input}
          output={output}
          isError={call.status === 'error'}
        />
      );
    default:
      return (
        <pre className="m-0 max-h-72 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/90">
          {output}
        </pre>
      );
  }
}

// ─── Status pip ────────────────────────────────────────────────────

/** Render the summary string. If it carries +N -M diff stats
 *  (separated by a double-space sentinel from summarize()), pull
 *  them out and color them green/red for at-a-glance impact —
 *  Codex-style. Otherwise plain mono text. */
function SummaryRow({ summary }: { summary: string }) {
  const m = /^(.*?)  \+(\d+) -(\d+)$/.exec(summary);
  if (!m) {
    return (
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[11px] font-mono text-muted-foreground">
        {summary}
      </span>
    );
  }
  const [, path, added, removed] = m;
  return (
    <>
      <span className="truncate text-[11px] font-mono text-muted-foreground">
        {path}
      </span>
      <span className="shrink-0 text-[10.5px] tabular-nums">
        <span className="text-emerald-600 dark:text-emerald-400">
          +{added}
        </span>{' '}
        <span className="text-primary">−{removed}</span>
      </span>
    </>
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

// ─── Per-tool one-line summary in the header ──────────────────────

function summarize(call: ToolCallView, workspace: string | null): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  switch (call.name) {
    case 'list_files':
    case 'read_file': {
      const path = typeof input.path === 'string' ? input.path : '…';
      return relativizeForDisplay(path, workspace);
    }
    case 'write_file':
    case 'edit_file': {
      const raw = typeof input.path === 'string' ? input.path : '…';
      const path = relativizeForDisplay(raw, workspace);
      // Surface the +N -M diff stats from the executor's success
      // message right in the header — Codex-style. Saves the user
      // from having to expand the card to see the impact.
      const stats = parseDiffStats(call.output);
      if (!stats) return path;
      return `${path}  ${stats}`;
    }
    case 'glob':
      return typeof input.pattern === 'string' ? input.pattern : '…';
    case 'grep': {
      const p = typeof input.pattern === 'string' ? input.pattern : '…';
      const path = typeof input.path === 'string' ? ` in ${input.path}` : '';
      return p + path;
    }
    case 'bash':
      return typeof input.command === 'string' ? input.command : '…';
    case 'browser_navigate':
      return typeof input.url === 'string' ? input.url : '…';
    case 'browser_snapshot':
    case 'browser_console':
      return '';
    case 'browser_screenshot':
      return input.full_page === true ? 'full page' : 'viewport';
    case 'browser_click':
    case 'browser_type':
      return typeof input.element === 'string' ? input.element : '…';
    case 'qlaud_search_tools':
      return typeof input.intent === 'string' ? input.intent : '…';
    case 'qlaud_get_tool_schemas': {
      const tools = Array.isArray(input.tools) ? input.tools : [];
      return tools.filter((t) => typeof t === 'string').join(', ') || '…';
    }
    case 'qlaud_multi_execute': {
      const calls = Array.isArray(input.calls) ? input.calls : [];
      const names = calls
        .map((c) =>
          c && typeof c === 'object' && 'tool' in c
            ? (c as Record<string, unknown>).tool
            : null,
        )
        .filter((n): n is string => typeof n === 'string');
      return names.length > 0
        ? `${names.length} tool${names.length === 1 ? '' : 's'}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`
        : '…';
    }
    case 'qlaud_manage_connections': {
      const action = typeof input.action === 'string' ? input.action : '?';
      const tool = typeof input.tool === 'string' ? input.tool : '';
      return tool ? `${action} ${tool}` : action;
    }
    case 'verify': {
      // Pull the resolved command + pass/fail from the output's first
      // two lines (set in tools.ts:runVerify). Lets the user scan a
      // bundle and see "verify (package.json): pnpm run check — PASSED"
      // without expanding the card.
      const out = call.output ?? '';
      const m = /^verify \([^)]+\): (.+?)\n(PASSED|FAILED[^\n]*)/.exec(out);
      if (m) {
        const [, cmd, status] = m;
        return `${cmd} — ${status}`;
      }
      return call.status === 'running' ? 'running…' : '…';
    }
    default:
      for (const [, v] of Object.entries(input)) {
        if (typeof v === 'string' && v.length > 0)
          return v.length > 60 ? v.slice(0, 57) + '…' : v;
      }
      return '';
  }
}

/** Pull the diff stats line ("(+N -M)") out of the executor's
 *  success message so the tool-card header can render them next
 *  to the path. Returns null when the output doesn't carry
 *  stats (e.g. browser-mode stub, error path). */
function parseDiffStats(output: string | undefined): string | null {
  if (!output) return null;
  const m = /\(\+(\d+) -(\d+)\)/.exec(output);
  if (!m) return null;
  return `+${m[1]} -${m[2]}`;
}

/** Strip the workspace prefix so `/Users/x/dev/qcode/src/lib/tools.ts`
 *  displays as `src/lib/tools.ts` — same shape my own session
 *  output uses. The model is told to use workspace-relative paths,
 *  but it sometimes echoes absolutes; this normalizes for display
 *  without touching the actual tool input. */
export function relativizeForDisplay(
  path: string,
  workspace: string | null,
): string {
  if (!workspace) return path;
  // Trim trailing slash on workspace, then strip leading workspace
  // path + slash from the path. Falls through to the raw path when
  // there's no overlap (the model passed an out-of-workspace path,
  // which the executor would reject anyway).
  const ws = workspace.replace(/\/+$/, '');
  if (path === ws) return '.';
  if (path.startsWith(ws + '/')) return path.slice(ws.length + 1);
  return path;
}

/** Sum +N -M across a stretch of edits (write_file + edit_file)
 *  for a bundle's aggregate diff stat. Returns null when no edits
 *  in the bundle landed stats (browser-mode stub, all errors). */
export function aggregateDiffStats(
  outputs: Array<string | undefined>,
): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  let any = false;
  for (const out of outputs) {
    if (!out) continue;
    const m = /\(\+(\d+) -(\d+)\)/.exec(out);
    if (!m) continue;
    added += Number.parseInt(m[1] ?? '0', 10);
    removed += Number.parseInt(m[2] ?? '0', 10);
    any = true;
  }
  return any ? { added, removed } : null;
}
