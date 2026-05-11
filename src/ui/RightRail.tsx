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
  Cloud,
  CloudUpload,
  ExternalLink,
  File as FileIcon,
  FileText,
  Film,
  GitCompare,
  Image as ImageIcon,
  ListTodo,
  Loader2,
  Music,
  Play,
  RefreshCw,
  RotateCw,
  Terminal as TerminalIcon,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { isTauri, openExternal, openLocalPath } from '../lib/tauri';

import { cn } from '../lib/cn';
import { readWorkspaceDiff, type FileDiff } from '../lib/git-info';
import { getRuntime } from '../lib/runtime';
import { useQcodeMeQuery, useQcodeUsageQuery } from '../lib/queries';
import {
  bucketByDay,
  bucketByMonth,
  bucketByWeek,
} from '../lib/qcode-usage';
import { useWorkspaceRevision } from '../lib/workspace-revision';
import { FileTree } from './FileTree';
import type { ToolCallView } from './legacy/ToolCallCard';

export type RightRailView =
  | 'tasks'
  | 'plan'
  | 'files'
  | 'terminal'
  | 'preview'
  | 'diff'
  | 'media'
  | 'usage';

// The render-block shape is mirrored from ChatSurface so the rail
// can run as a leaf component without circular imports. We only
// need the tool/text variants for now; expand on demand.
type ToolBlock = { type: 'tool'; call: ToolCallView };
type AnyBlock = ToolBlock | { type: string; [k: string]: unknown };

export type RightRailProps = {
  view: RightRailView;
  blocks: AnyBlock[];
  workspacePath?: string | null;
  /** Active qcode thread id. Threaded through so views that need
   *  per-thread server data — currently MediaView fetching cloud
   *  artifacts via /v1/threads/:tid/artifacts — can scope their
   *  query. Other views ignore. */
  threadId?: string | null;
  onClose?: () => void;
};

export function RightRail({
  view,
  blocks,
  workspacePath,
  threadId,
  onClose,
}: RightRailProps) {
  const tools = blocks
    .filter((b): b is ToolBlock => b.type === 'tool')
    .filter((b) => b.call.name !== 'todo_write');

  // Resizable width on desktop. User drags the left edge to make
  // the rail bigger when working with media / files / preview that
  // benefit from more horizontal room. Persisted to localStorage so
  // their preferred width sticks across sessions. Mobile keeps the
  // bottom-sheet pattern unchanged (no resize there).
  const [railWidth, setRailWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 288;
    const saved = window.localStorage.getItem('qcode.rightRail.width');
    const n = saved ? Number.parseInt(saved, 10) : NaN;
    return Number.isFinite(n) && n >= 240 && n <= 1200 ? n : 288;
  });
  const [isResizing, setIsResizing] = useState(false);

  // Drag-resize handler. Captures pointer on the divider, follows
  // pointermove until pointerup. Width = viewport-right - cursor-x,
  // clamped to a sane range so the user can't drag the chat down
  // to a 50px stripe. Persisted on release so we don't thrash
  // localStorage on every move.
  function onResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsResizing(true);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const next = Math.max(
        240,
        Math.min(1200, window.innerWidth - ev.clientX),
      );
      setRailWidth(next);
    };
    const onUp = () => {
      setIsResizing(false);
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        /* already released — nbd */
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // Persist final value once on release, not 60 times/sec
      // during the drag.
      try {
        // Capture latest from the closure-scoped state via a synchronous
        // read of the DOM (cheaper than a setState callback dance).
        const finalRect = target.parentElement?.getBoundingClientRect();
        if (finalRect) {
          window.localStorage.setItem(
            'qcode.rightRail.width',
            String(Math.round(finalRect.width)),
          );
        }
      } catch {
        /* localStorage unavailable (private mode etc.) — non-fatal */
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <>
      {/* Mobile scrim — taps close the sheet. md+ never sees this. */}
      <button
        aria-label="Close panel"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm md:hidden"
      />
      <aside
        style={{
          // Inline width applies on md+ only — mobile is 100vw via
          // the inset-x-0 class. The CSS class below sets w-full on
          // mobile and lets inline style win on desktop.
          ...(typeof window !== 'undefined' && window.innerWidth >= 768
            ? { width: railWidth }
            : {}),
        }}
        className={cn(
          // Mobile: bottom-anchored sheet that takes 75dvh, slides up
          // over the chat. Desktop md+: in-flow column on the right
          // (resizable, default 288px) with the chat surface to the
          // left. md:relative is the positioning context for the
          // absolute drag handle.
          'fixed inset-x-0 bottom-0 z-50 flex h-[75dvh] flex-col rounded-t-xl border-t border-border/40 bg-background/95 backdrop-blur-md',
          'md:static md:relative md:h-auto md:shrink-0 md:rounded-none md:border-l md:border-t-0 md:bg-background/60',
        )}
      >
        {/* Resize handle — desktop only. 4px-wide hot-zone on the
         *  left edge that captures pointer for a drag. Stretches
         *  full height. Subtle hover state hints at resizability;
         *  no permanent visible affordance to keep the surface
         *  clean. */}
        <div
          onPointerDown={onResizeStart}
          className={cn(
            'absolute inset-y-0 left-0 z-10 hidden w-1 cursor-col-resize transition-colors hover:bg-primary/20 md:block',
            isResizing && 'bg-primary/30',
          )}
          title="Drag to resize"
          aria-label="Resize panel"
        />
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
          {view === 'preview' && <PreviewView blocks={blocks} />}
          {view === 'media' && (
            <MediaView workspacePath={workspacePath} threadId={threadId} />
          )}
          {view === 'usage' && <UsageView />}
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

// ─── Preview ──────────────────────────────────────────────────────
//
// Live iframe of the URL the agent is currently working with. Auto-
// fills from the most recent browser_navigate tool call so a typical
// flow (agent boots dev server → browser_navigate localhost:3001 →
// user pops the Preview tab) shows the page without typing anything.
// Manual URL bar lets the user point at any local server qcode hasn't
// touched yet (e.g. they ran `pnpm dev` themselves on a custom port).
//
// Why iframe: zero new permissions, works for any localhost URL the
// dev server allows in CSP. Limitations are honest — sites that send
// X-Frame-Options: DENY won't load (most prod sites). For local dev
// the dev server typically allows iframing same-origin, so this just
// works for what it's actually for.

// Matches dev-server "ready" banners across frameworks: Vite's
// "Local: http://localhost:5173", Next's "ready on
// http://localhost:3000", Astro/Remix/Nuxt/Storybook variants. Same
// regex ChatSurface uses for its sticky activity bar — kept inline
// here to avoid a circular import (RightRail is imported from
// ChatSurface).
const DEV_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})?(?:\/[^\s'"<>)]*)?/g;

/** Tiny dropdown chip rendered in the Preview toolbar when more
 *  than zero URLs have been detected in the agent's bash output
 *  this session. Click reveals the list, click an item to switch
 *  the iframe to it. Zero ports detected → component doesn't
 *  render (PreviewView gates on detectedUrls.length > 0). */
function DetectedUrlsDropdown({
  urls,
  currentUrl,
  onPick,
}: {
  urls: string[];
  currentUrl: string;
  onPick: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click — standard popover behavior. Skipped
  // when `open=false` to avoid attaching a no-op listener.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded border border-border/60 bg-background px-1.5 py-1 text-[10.5px] font-medium text-foreground/80 hover:border-foreground/30 hover:text-foreground"
        title={`${urls.length} URL${urls.length === 1 ? '' : 's'} detected from agent's bash output`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <span className="tabular-nums">{urls.length}</span>
        <ChevronRight
          className={cn(
            'h-2.5 w-2.5 transition-transform',
            open ? 'rotate-90' : '',
          )}
        />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-[280px] overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          <div className="border-b border-border/40 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Running in this session
          </div>
          <div className="max-h-[240px] overflow-y-auto py-1">
            {urls.map((u) => {
              const isActive = u === currentUrl;
              return (
                <button
                  key={u}
                  onClick={() => {
                    onPick(u);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] font-mono transition-colors',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground/85 hover:bg-muted',
                  )}
                  title={u}
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      isActive ? 'bg-primary' : 'bg-muted-foreground/40',
                    )}
                  />
                  <span className="truncate">{u}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// If `u` looks like a localhost dev-server URL, return the port the
// agent's process is listening on. Used by PreviewView to ask the
// runtime for a public-facing URL via exposePort — on sandbox this
// returns an `<port>-sandbox-<id>-<token>.sbx.qlaud.app` URL the
// user's browser can actually reach; on tauri it round-trips back
// to localhost (the user already has direct network access). Both
// runtimes go through the same code path so the iframe doesn't have
// to branch on `isTauri()` at the call site.
function localhostPort(u: string): number | null {
  try {
    const parsed = new URL(u);
    if (
      parsed.hostname !== 'localhost' &&
      parsed.hostname !== '127.0.0.1' &&
      parsed.hostname !== '0.0.0.0' &&
      parsed.hostname !== '::1'
    ) {
      return null;
    }
    if (parsed.port) {
      const p = Number.parseInt(parsed.port, 10);
      return Number.isFinite(p) ? p : null;
    }
    // Implicit port — http=80, https=443. Dev servers practically
    // always set an explicit port so this branch is mostly defensive.
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

function PreviewView({ blocks }: { blocks: AnyBlock[] }) {
  // Two sources for what to load in the iframe, in priority order:
  //   1. lastNavigatedUrl — the agent explicitly called
  //      browser_navigate(url). User/agent intent is direct.
  //   2. lastDevServerUrl — a bash tool's output contained a
  //      "Local: http://..." / "ready on http://..." banner.
  //      Picked up automatically when the agent runs `pnpm dev`,
  //      Vite/Next/Astro/etc., on whatever port they grabbed.
  // Either one updating triggers the iframe to load the new URL,
  // unless the user has typed something different in the URL bar.
  const lastNavigatedUrl = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (
        b &&
        b.type === 'tool' &&
        (b as ToolBlock).call.name === 'browser_navigate'
      ) {
        const input = (b as ToolBlock).call.input as { url?: unknown };
        if (typeof input.url === 'string') return input.url;
      }
    }
    return '';
  }, [blocks]);

  const lastDevServerUrl = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (!b || b.type !== 'tool') continue;
      const tb = b as ToolBlock;
      // Case-insensitive: legacy agent emits 'bash' / 'verify',
      // claude CLI engine emits 'Bash' (capital). Without the
      // lowercase normalization the engine-mode preview pane
      // never picks up dev-server boots from bash output.
      const name = tb.call.name.toLowerCase();
      if (name !== 'bash' && name !== 'verify') continue;
      const out = (tb.call as { output?: string }).output;
      if (!out) continue;
      const matches = Array.from(out.matchAll(DEV_URL_RE));
      if (matches.length === 0) continue;
      // Last match in this output wins — dev servers print "Local:"
      // and "Network:" lines; "Local:" comes first so taking the
      // last-but-most-specific match still works (we trim trailing
      // punctuation either way).
      const last = matches[matches.length - 1]?.[0];
      if (last) return last.replace(/[.,;)]+$/, '');
    }
    return '';
  }, [blocks]);

  // Every URL the agent's bash commands have ever printed in this
  // session — not just the most recent one. The agent already
  // tells us exactly what's running in this workspace via the
  // tool calls it makes (every `bun dev` / `npm start` / `python
  // -m http.server` etc. emits a "Local: http://..." or "Listening
  // on http://..." banner that lands in the bash block's output).
  // Walking the blocks once gives us the source of truth: what
  // THIS conversation has spun up, in order. No system-wide port
  // sniffing, no platform-specific shell-outs, no polling — just
  // re-derive when blocks change. Naturally workspace-scoped
  // because the agent ran in the workspace.
  const detectedUrls = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const b of blocks) {
      if (!b || b.type !== 'tool') continue;
      const tb = b as ToolBlock;
      const name = tb.call.name.toLowerCase();
      if (name !== 'bash' && name !== 'verify') continue;
      const out = (tb.call as { output?: string }).output;
      if (!out) continue;
      for (const m of out.matchAll(DEV_URL_RE)) {
        const u = (m[0] ?? '').replace(/[.,;)]+$/, '');
        if (!u || seen.has(u)) continue;
        seen.add(u);
        ordered.push(u);
      }
    }
    return ordered;
  }, [blocks]);

  // Effective auto-source: explicit navigate beats inferred dev
  // URL beats nothing.
  const autoSource = lastNavigatedUrl || lastDevServerUrl;

  const [url, setUrl] = useState(autoSource || 'http://localhost:3000');
  const [loadedUrl, setLoadedUrl] = useState(autoSource);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Runtime is selected once per mount — selection logic lives in
  // ../lib/runtime (Tauri vs sandbox vs web-noop). Memoizing here
  // means port-mapping effects don't re-run when the parent
  // re-renders (every block stream tick would otherwise refresh
  // the dep array via a new object identity).
  const runtime = useMemo(() => getRuntime(), []);

  // Port → public URL cache. Populated by exposePort calls below.
  // On sandbox, exposePort hits the worker (~100-300ms); on tauri
  // it resolves synchronously with a localhost URL. Caching here
  // keeps the iframe from re-querying every reload, and means
  // switching between detected URLs on the same port is instant.
  const [portMappings, setPortMappings] = useState<Map<number, string>>(
    () => new Map(),
  );

  // Track in-flight exposePort calls in a ref (not state) — flipping
  // it doesn't need to trigger a render, and we want the dedupe
  // check to be synchronous within a single tick. Without this,
  // two effects firing back-to-back (e.g., loadedUrl changes twice
  // quickly) would each fire their own request for the same port.
  const inFlightPortsRef = useRef<Set<number>>(new Set());

  // When loadedUrl is a localhost URL we don't yet have a public
  // mapping for, ask the runtime to expose the port. The mapping
  // lands in state, the iframeSrc memo picks it up, and the iframe
  // src updates without any further plumbing.
  useEffect(() => {
    if (!loadedUrl) return;
    const port = localhostPort(loadedUrl);
    if (port === null) return;
    if (portMappings.has(port)) return;
    if (inFlightPortsRef.current.has(port)) return;
    inFlightPortsRef.current.add(port);
    let cancelled = false;
    (async () => {
      try {
        const result = await runtime.exposePort(port);
        if (cancelled) return;
        setPortMappings((prev) => {
          if (prev.has(port)) return prev;
          const next = new Map(prev);
          next.set(port, result.url);
          return next;
        });
      } catch (e) {
        // exposePort can fail when the sandbox container is still
        // booting or the worker is unreachable. The iframe falls
        // back to a clear empty state; don't toast — the agent
        // typically prints the URL again on the next dev-server
        // restart and the effect will retry.
        console.warn(
          'PreviewView: exposePort failed for port',
          port,
          e,
        );
      } finally {
        inFlightPortsRef.current.delete(port);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadedUrl, runtime, portMappings]);

  // True iff we're showing a localhost URL on the sandbox runtime
  // and haven't yet received the public mapping. The iframe area
  // renders a small spinner in this state — without it, the iframe
  // would briefly try to load the raw localhost URL against the
  // user's machine, which is guaranteed to fail in the cloud
  // playground.
  const isPendingPortMapping = useMemo(() => {
    if (!loadedUrl) return false;
    if (runtime.kind !== 'sandbox') return false;
    const port = localhostPort(loadedUrl);
    if (port === null) return false;
    return !portMappings.has(port);
  }, [loadedUrl, runtime.kind, portMappings]);

  // Auto-load when the agent navigates OR a dev server boots on a
  // detected port. Keeps the panel in sync with what's actually
  // running without forcing the user to retype the URL.
  useEffect(() => {
    if (autoSource && autoSource !== loadedUrl) {
      setUrl(autoSource);
      setLoadedUrl(autoSource);
    }
  }, [autoSource, loadedUrl]);

  function load() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setLoadedUrl(trimmed);
  }

  function reload() {
    if (!iframeRef.current) return;
    // Re-set src to force a reload; .reload() on contentWindow can
    // throw on cross-origin even for localhost in some cases.
    const current = loadedUrl;
    setLoadedUrl('');
    setTimeout(() => setLoadedUrl(current), 0);
  }

  // Build the URL the iframe actually loads from `loadedUrl`. Three
  // cases:
  //
  //   A. Non-localhost URL (e.g. https://example.com). Use as-is +
  //      cache-bust query.
  //
  //   B. Localhost URL with a public mapping cached. Graft the
  //      user's path/query/hash onto the public origin so deep
  //      links the agent navigated to ("Local: http://localhost:
  //      3000/dashboard") survive the rewrite. The public URL is
  //      reachable from the user's browser; the original localhost
  //      one isn't (in sandbox mode the dev server is in a CF
  //      container, not on the user's machine).
  //
  //   C. Localhost URL, sandbox runtime, mapping not yet available.
  //      Return '' and let the JSX below render a spinner. We
  //      explicitly do NOT try to load the raw localhost URL — it
  //      would just hit nothing-listening on the user's host.
  //
  //   D. Localhost URL, tauri runtime, mapping not yet available
  //      (rare: exposePort resolves synchronously). Apply the
  //      legacy macOS-IPv6-vs-IPv4 normalization (force 127.0.0.1)
  //      and cache-bust — same behavior as the pre-runtime-routing
  //      preview pane on desktop.
  const iframeSrc = useMemo(() => {
    if (!loadedUrl) return '';
    let parsed: URL;
    try {
      parsed = new URL(loadedUrl);
    } catch {
      return loadedUrl;
    }

    const port = localhostPort(loadedUrl);
    if (port !== null) {
      const mapped = portMappings.get(port);
      if (mapped) {
        // Case B — graft path/query/hash onto the public origin.
        try {
          const out = new URL(mapped);
          out.pathname = parsed.pathname;
          out.search = parsed.search;
          out.hash = parsed.hash;
          out.searchParams.set('_qcode', String(Date.now()));
          return out.toString();
        } catch {
          return mapped;
        }
      }
      if (runtime.kind === 'sandbox') {
        // Case C — pending mapping, JSX shows the spinner.
        return '';
      }
      // Case D — tauri fallback.
      if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
    }

    // Case A (or D continuation) — cache-bust and ship.
    parsed.searchParams.set('_qcode', String(Date.now()));
    return parsed.toString();
  }, [loadedUrl, portMappings, runtime.kind]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-border/40 px-2 py-1.5">
        {detectedUrls.length > 0 && (
          <DetectedUrlsDropdown
            urls={detectedUrls}
            currentUrl={loadedUrl}
            onPick={(u) => {
              setUrl(u);
              setLoadedUrl(u);
            }}
          />
        )}
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              load();
            }
          }}
          placeholder="http://localhost:3000"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-w-0 flex-1 rounded border border-border/60 bg-background px-2 py-1 font-mono text-[11px] outline-none focus:ring-2 focus:ring-primary/30"
        />
        <button
          onClick={load}
          aria-label="Load URL"
          className="grid h-7 w-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Load"
        >
          <Play className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={reload}
          aria-label="Reload preview"
          disabled={!loadedUrl}
          className="grid h-7 w-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title="Reload"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        {loadedUrl && (
          <a
            href={loadedUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in browser"
            className="grid h-7 w-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Open in default browser"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
      {loadedUrl ? (
        isPendingPortMapping ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/70" />
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              Exposing port through the sandbox…
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <iframe
              ref={iframeRef}
              src={iframeSrc}
              className="min-h-0 w-full flex-1 border-0 bg-white"
              // Allow same-origin so cookies/storage work for localhost
              // dev. Don't allow scripts to escape the frame (default
              // sandbox). For dev servers this covers the typical case.
              sandbox="allow-same-origin allow-scripts allow-forms"
              referrerPolicy="no-referrer"
            />
            {/* Sandbox-mode footer hint. The CF Sandbox container
             *  sleeps after ~10 min idle; when the user revisits a
             *  thread, the dev server they spun up earlier may be
             *  dead. The iframe can't reliably surface that to us
             *  (no-cors hides the upstream 502; onError is unreliable
             *  for sub-document failures). Cheaper UX win: a quiet
             *  one-line breadcrumb that tells the user what to do
             *  when the iframe stays blank, without trying to detect
             *  the state and getting it wrong. Tauri/desktop runtime
             *  doesn't have this idle problem — the dev server is
             *  on their own machine — so we only show it on sandbox. */}
            {runtime.kind === 'sandbox' && (
              <div className="border-t border-border/40 bg-muted/30 px-2 py-1 text-[10.5px] leading-snug text-muted-foreground">
                If the preview stays blank, the sandbox dev server may
                have idled out — ask the agent to restart it (e.g.
                <span className="ml-0.5 font-mono">{' '}bun dev</span>)
                and reload above.
              </div>
            )}
          </div>
        )
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <Play className="h-5 w-5 text-muted-foreground/60" />
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            Type a URL above and press Enter, or ask the agent to{' '}
            <span className="font-mono">browser_navigate</span> to a
            URL — the preview will sync automatically.
          </p>
        </div>
      )}
    </div>
  );
}

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
  const workspaceRev = useWorkspaceRevision();

  // Fetch on mount + on workspace change + when the agent has done
  // anything that might have modified files. No background poll —
  // git diff is cheap but not free; revision-driven refresh is
  // both fresher and lighter.
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
  }, [workspacePath, workspaceRev]);

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


// ─── Media (workspace artifacts) ─────────────────────────────────
//
// Catalogs every image, audio, and video file in the user's
// workspace so they can find what the agent generated, what they
// uploaded, and what was already in the project — all in one place.
// The qlaud-media skill saves to <workspace>/.qcode/media/<date>/
// per the canonical convention; that folder gets a dedicated
// "Generated by qcode" section at the top, separate from project
// assets (so a workspace with 200 .png assets in /public doesn't
// drown out the 3 hero images the agent just created).
//
// Click a file → opens in the OS default app (Preview for images,
// Music for mp3, QuickTime for mp4, etc.) via openExternal.
//
// Scope decisions:
//   - No inline thumbnails. Tauri's asset protocol isn't enabled
//     in this build; data: URIs would bloat the rail with megabytes
//     for large images. Shipping just type-icon + filename + size
//     is cleaner and faster than a half-thumbnail solution.
//   - Recursive scan caps at 1000 entries (most workspaces hit
//     this only with a large public/ asset folder). Beyond that
//     the rail starts truncating.
//   - Skips node_modules, .git, dist/build/target — same hidden
//     list FileTree honors.

const MEDIA_EXTENSIONS = {
  image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']),
  audio: new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'opus']),
  video: new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v']),
};

// MEDIA_HIDDEN_DIRS retired with the readDir-based walk — the new
// `find` shell-out in scanWorkspaceMedia does -prune at the find
// level, which is faster (no dir descent at all) and matches the
// noise list inline.

type MediaKind = 'image' | 'audio' | 'video';

type MediaItem = {
  /** Absolute path on disk — what we hand to openExternal. Empty
   *  string for cloud-only items that don't exist locally. */
  absPath: string;
  /** Workspace-relative path — what we render. For cloud-only items,
   *  this is the original_name from the artifact metadata. */
  relPath: string;
  /** File name only (last segment of relPath). */
  name: string;
  kind: MediaKind;
  /** Size in bytes. Null when stat failed (or cloud entry without
   *  byte_size hint). */
  size: number | null;
  /** mtime (ms). Null when stat failed. Used to sort newest first. */
  mtime: number | null;
  /** True when the file lives under .qcode/media/ — the canonical
   *  qcode-generated artifacts folder. Used to bucket the row into
   *  the "Generated by qcode" section. */
  isGenerated: boolean;
  /** Where this item came from. 'local' = workspace scan, 'cloud' =
   *  qlaud /v1/threads/:tid/artifacts ledger, 'both' = same artifact
   *  exists in both places (deduped on filename match). */
  origin: 'local' | 'cloud' | 'both';
  /** When origin includes 'cloud': the qlaud download URL the user
   *  can fetch from any device. */
  cloudUrl?: string;
};

function classifyMedia(name: string): MediaKind | null {
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  if (MEDIA_EXTENSIONS.image.has(ext)) return 'image';
  if (MEDIA_EXTENSIONS.audio.has(ext)) return 'audio';
  if (MEDIA_EXTENSIONS.video.has(ext)) return 'video';
  return null;
}

async function scanWorkspaceMedia(root: string): Promise<MediaItem[]> {
  // Shell out to `find` rather than walking via Tauri's readDir.
  //
  // Why: Tauri 2's plugin-fs readDir has surfaced cases on macOS
  // where it silently omits entries starting with '.' — same way
  // `ls` (without -a) does. The agent saves to .qcode/media/, so
  // a hidden-dir-skipping walk silently returns "No media" while
  // the files clearly exist on disk. find on the other hand walks
  // EVERY entry like `ls -a`, including dotted dirs. We also get
  // size + mtime in one fork (via -printf or stat) instead of N+1
  // separate stat calls per file.
  //
  // Format: TAB-separated absolute_path \t size_bytes \t mtime_seconds.
  // GNU find supports -printf directly; BSD find (macOS default)
  // doesn't, so we use -exec stat per file for portability. Stat's
  // -f format differs between BSD and GNU; we detect via uname.
  //
  // -prune the noise dirs early so find doesn't waste time
  // descending into node_modules / .git / etc. Limit at 1000
  // hits via head -n.
  const MAX = 1000;
  const exts = [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif',
    'mp4', 'mov', 'webm', 'mkv', 'm4v',
    'mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac',
    'pdf',
  ];
  const orPattern = exts.map((e) => `-iname "*.${e}"`).join(' -o ');
  const pruneNoise =
    `\\( -name node_modules -o -name .git -o -name .next ` +
    `-o -name .open-next -o -name dist -o -name build -o -name target ` +
    `-o -name coverage -o -name .cache -o -name .turbo \\) -prune -o`;
  // BSD vs GNU stat format selection. Use '|' as separator instead
  // of '\t' — BSD stat on macOS does NOT expand \t in the format
  // string (output gets literal backslash-t instead of an actual
  // tab), which silently broke the JS parser. '|' passes through
  // both BSD and GNU stat unmodified, and media filenames don't
  // contain it (regex-safe for png/jpg/mp4/etc).
  const statBsd = `stat -f "%N|%z|%m" "$0"`;
  const statGnu = `stat -c "%n|%s|%Y" "$0"`;
  const cmd =
    `cd "${root}" 2>/dev/null && ` +
    `if stat --version >/dev/null 2>&1; then STAT='${statGnu}'; else STAT='${statBsd}'; fi && ` +
    `find . ${pruneNoise} \\( -type f \\( ${orPattern} \\) \\) -print0 2>/dev/null | ` +
    `head -c 200000 | xargs -0 -n 1 -I '{}' sh -c "$STAT" '{}' 2>/dev/null | head -n ${MAX}`;

  let stdout = '';
  try {
    // Route through the runtime so this works on both Tauri (local
    // bash session) and sandbox (worker /exec → CF Sandbox SDK).
    // Same find+stat pipeline either way; the BSD/GNU detection
    // inside `cmd` covers Tauri-on-macOS, while the container is
    // Linux so the GNU branch lights up automatically there.
    const r = await getRuntime().exec(cmd, {
      cwd: root,
      timeoutMs: 8_000,
    });
    stdout = r.stdout;
  } catch {
    return [];
  }

  const out: MediaItem[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [pathRaw, sizeRaw, mtimeRaw] = line.split('|');
    if (!pathRaw) continue;
    // Path is `./relative/from/root` because we cd'd in. Normalize.
    const rel = pathRaw.replace(/^\.\//, '');
    const name = rel.split('/').pop() ?? rel;
    const kind = classifyMedia(name);
    if (!kind) continue;
    const sizeNum = sizeRaw ? Number(sizeRaw) : NaN;
    const mtimeNum = mtimeRaw ? Number(mtimeRaw) : NaN;
    out.push({
      absPath: `${root}/${rel}`,
      relPath: rel,
      name,
      kind,
      size: Number.isFinite(sizeNum) ? sizeNum : null,
      // BSD %m and GNU %Y both return seconds since epoch; convert
      // to ms to match what `new Date(...).getTime()` produced
      // before so the "newest first" sort works the same.
      mtime: Number.isFinite(mtimeNum) ? mtimeNum * 1000 : null,
      isGenerated: rel.startsWith('.qcode/media/'),
      origin: 'local',
    });
  }
  return out;
}

// Cloud-side fetch for artifacts the agent uploaded via the
// /v1/artifacts/* flow under this thread. Returns MediaItem[] in
// the same shape as scanWorkspaceMedia so the merge step can fold
// both lists trivially. Empty array on missing key (web users not
// signed in), missing thread, or any network/parse failure — the
// view surfaces a partial result rather than failing entirely.
async function fetchCloudArtifacts(threadId: string): Promise<MediaItem[]> {
  const { getKey } = await import('../lib/auth');
  const apiKey = getKey();
  if (!apiKey) return [];
  const base =
    (import.meta.env.VITE_QLAUD_BASE as string | undefined) ??
    'https://api.qlaud.ai';
  let res: Response;
  try {
    res = await fetch(
      `${base}/v1/threads/${encodeURIComponent(threadId)}/artifacts`,
      { headers: { 'x-api-key': apiKey } },
    );
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let parsed: { data?: Array<Record<string, unknown>> };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    return [];
  }
  const out: MediaItem[] = [];
  for (const a of parsed.data ?? []) {
    const kindRaw = String(a.kind ?? '');
    const kind: MediaKind | null =
      kindRaw === 'image' || kindRaw === 'audio' || kindRaw === 'video'
        ? kindRaw
        : null;
    if (!kind) continue;
    const name = String(a.original_name ?? 'artifact');
    out.push({
      absPath: '',
      relPath: name,
      name,
      kind,
      size: typeof a.byte_size === 'number' ? a.byte_size : null,
      mtime: typeof a.uploaded_at === 'number' ? a.uploaded_at : null,
      isGenerated: true,
      origin: 'cloud',
      cloudUrl: `${base}${a.download_url}`,
    });
  }
  return out;
}

// Merge local + cloud item lists. Dedupe on filename (close enough —
// names are descriptive in the canonical media folder, collisions
// across origins almost always mean the SAME artifact synced both
// ways). When both origins have the same name: keep the local entry
// (cheaper to open, no network) but tag it origin: 'both' so the row
// shows both indicators. Cloud-only entries get origin: 'cloud' for
// the chip.
function mergeLocalAndCloud(
  local: MediaItem[],
  cloud: MediaItem[],
): MediaItem[] {
  const byName = new Map<string, MediaItem>();
  for (const it of local) byName.set(it.name, it);
  for (const c of cloud) {
    const existing = byName.get(c.name);
    if (existing) {
      // Both origins have this artifact — keep local but flag both.
      byName.set(c.name, {
        ...existing,
        origin: 'both',
        cloudUrl: c.cloudUrl,
      });
    } else {
      byName.set(c.name, c);
    }
  }
  return Array.from(byName.values());
}

function MediaView({
  workspacePath,
  threadId,
}: {
  workspacePath?: string | null;
  threadId?: string | null;
}) {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Tick whenever the agent does something that may have written
  // new files to the workspace — re-runs the scan so the user
  // sees "agent just generated this" without manual refresh.
  const workspaceRev = useWorkspaceRevision();

  useEffect(() => {
    let cancelled = false;
    // Don't blank-out items on a revision-tick refresh — keep the
    // current view visible and merge in new entries when the scan
    // completes. Only fully clear on workspace/thread change.
    setError(null);

    // Two parallel fetches — local fs scan + qlaud cloud ledger —
    // merged on completion. Either side can be empty (no
    // workspace, no thread, web mode without a workspace, etc.) and
    // the other still renders. Failures on one side surface as
    // partial results, not a blocking error, so the user always
    // sees what we have.
    const localPromise = workspacePath
      ? scanWorkspaceMedia(workspacePath).catch(() => [] as MediaItem[])
      : Promise.resolve([] as MediaItem[]);

    const cloudPromise = threadId
      ? fetchCloudArtifacts(threadId).catch(() => [] as MediaItem[])
      : Promise.resolve([] as MediaItem[]);

    void Promise.all([localPromise, cloudPromise]).then(
      ([local, cloud]) => {
        if (cancelled) return;
        setItems(mergeLocalAndCloud(local, cloud));
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'scan failed');
        setItems([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspacePath, threadId, reloadKey, workspaceRev]);

  // Bucket: generated (newest first) → project (newest first within
  // each kind). The split surfaces qcode's own output above the
  // ambient assets in the project, which is what the user is
  // looking for 90% of the time.
  const buckets = useMemo(() => {
    if (!items) return null;
    const generated = items
      .filter((i) => i.isGenerated)
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    const project = items
      .filter((i) => !i.isGenerated)
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    return { generated, project };
  }, [items]);

  // Pure-cloud mode (no workspace open) — show only cloud entries
  // when there's a thread. If neither workspace nor thread is set,
  // there's nothing to show.
  if (!workspacePath && !threadId) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <ImageIcon className="h-5 w-5 text-muted-foreground/60" />
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Open a folder to see local media, or start a chat to see
          cloud-synced artifacts.
        </p>
      </div>
    );
  }

  if (items === null) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-[11.5px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {workspacePath ? 'Scanning workspace…' : 'Loading cloud artifacts…'}
      </div>
    );
  }

  if (error) {
    return (
      <p className="px-4 py-6 text-[11.5px] leading-relaxed text-rose-600 dark:text-rose-400">
        Couldn&rsquo;t scan media — {error}.
      </p>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 px-4 py-6 text-[11.5px] leading-relaxed text-muted-foreground">
        <p>
          No media yet. When the agent generates an image, narrates audio,
          or renders video, it lands in{' '}
          <span className="font-mono text-foreground/80">
            .qcode/media/
          </span>{' '}
          and shows here.
        </p>
        <p className="text-muted-foreground/80">
          Anything you drop into the project (PNG, JPG, MP3, MP4 …) shows
          up too.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-2">
      {buckets!.generated.length > 0 && (
        <MediaBucket
          label="Generated by qcode"
          items={buckets!.generated}
          tone="primary"
          threadId={threadId}
          onUploaded={() => setReloadKey((k) => k + 1)}
        />
      )}
      {buckets!.project.length > 0 && (
        <MediaBucket
          label={
            buckets!.generated.length > 0 ? 'Project assets' : 'Workspace media'
          }
          items={buckets!.project}
          tone="muted"
          threadId={threadId}
          onUploaded={() => setReloadKey((k) => k + 1)}
        />
      )}
      <button
        type="button"
        onClick={() => setReloadKey((k) => k + 1)}
        className="mt-1 flex items-center justify-center gap-1.5 self-stretch rounded-md border border-border/40 bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground"
      >
        <RotateCw className="h-3 w-3" />
        Rescan
      </button>
    </div>
  );
}

function MediaBucket({
  label,
  items,
  tone,
  threadId,
  onUploaded,
}: {
  label: string;
  items: MediaItem[];
  tone: 'primary' | 'muted';
  /** Active thread id — passed to upload calls so uploaded
   *  artifacts show up under the right conversation. Null in
   *  pure-cloud mode where no thread is open. */
  threadId?: string | null;
  /** Notify the parent MediaView a successful upload landed so it
   *  refetches the artifact list and the row flips to origin:'both'. */
  onUploaded?: () => void;
}) {
  // Group by kind for the header counts.
  const counts = useMemo(() => {
    const c = { image: 0, audio: 0, video: 0 } as Record<MediaKind, number>;
    for (const i of items) c[i.kind]++;
    return c;
  }, [items]);
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 px-1">
        <span
          className={cn(
            'text-[10px] font-semibold uppercase tracking-[0.13em]',
            tone === 'primary' ? 'text-primary/85' : 'text-muted-foreground/80',
          )}
        >
          {label}
        </span>
        <span className="text-[9.5px] tabular-nums text-muted-foreground/60">
          {items.length}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[9.5px] text-muted-foreground/60">
          {counts.image > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <ImageIcon className="h-2.5 w-2.5" />
              {counts.image}
            </span>
          )}
          {counts.audio > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <Music className="h-2.5 w-2.5" />
              {counts.audio}
            </span>
          )}
          {counts.video > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <Film className="h-2.5 w-2.5" />
              {counts.video}
            </span>
          )}
        </span>
      </div>
      <ul className="space-y-0.5">
        {items.map((it) => (
          <MediaRow
            key={it.absPath || it.relPath}
            item={it}
            threadId={threadId ?? null}
            onUploaded={onUploaded}
          />
        ))}
      </ul>
    </div>
  );
}

function MediaRow({
  item,
  threadId,
  onUploaded,
}: {
  item: MediaItem;
  threadId: string | null;
  onUploaded?: () => void;
}) {
  const Icon =
    item.kind === 'image'
      ? ImageIcon
      : item.kind === 'audio'
        ? Music
        : item.kind === 'video'
          ? Film
          : FileIcon;

  // Tauri 2 asset protocol turns absolute filesystem paths into
  // http://asset.localhost/<encoded-path> URLs the WebView can load
  // directly. Configured in src-tauri/tauri.conf.json security.
  // assetProtocol.scope=["**"]. Falls back to empty string on web
  // build (no Tauri runtime); rows still render the type icon.
  //
  // Drive the URL through Tauri's `convertFileSrc()` instead of
  // hand-rolling the prefix. Why: the rolled prefix worked on macOS
  // (http://asset.localhost/<path>) but Tauri's WebView on
  // Windows/Linux uses different schemes (https://asset.localhost/…
  // and asset://localhost/… respectively) plus a different encoding
  // (encodeURIComponent — slashes become %2F). convertFileSrc emits
  // the right shape per platform; thumbnails were silently broken on
  // every non-mac install before this. The prior comment claimed we
  // were avoiding a require() — convertFileSrc is a pure JS helper
  // (no native bridge), so the dynamic-import cost is one ~1KB chunk
  // shared with the rest of the tauri/api/core surface.
  const [previewSrc, setPreviewSrc] = useState('');
  useEffect(() => {
    let cancelled = false;
    if (!item.absPath || !isTauri()) {
      setPreviewSrc('');
      return;
    }
    void (async () => {
      try {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        if (cancelled) return;
        setPreviewSrc(convertFileSrc(item.absPath));
      } catch (err) {
        // Asset protocol module failed to load — log + fall back to
        // the empty thumbnail (icon-only row). Same as the !isTauri
        // branch above; rendering doesn't break.
        console.error('[media] convertFileSrc failed', item.absPath, err);
        if (!cancelled) setPreviewSrc('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.absPath]);
  // Click target depends on origin:
  //   • local-only: openLocalPath(absPath) → OS default app (macOS:
  //     Preview / QuickTime / Music; Linux: xdg-open; Windows: start).
  //     Note: NOT openExternal — tauri-plugin-shell's open() rejects
  //     bare filesystem paths against a URL-only validation regex, so
  //     a click here was silently no-op'ing in v172 (alpha.171 had a
  //     similar issue under different cover). openLocalPath shells
  //     out via `sh -c 'open "$0"'`, which the shell:allow-execute
  //     capability already permits.
  //   • cloud-only: openExternal(cloudUrl) → opens the qlaud download
  //     URL in the user's browser (signed/authed; the download
  //     endpoint reads the api key on the request).
  //   • both: prefer local (cheaper, no network).
  const onClick = () => {
    if (item.origin === 'cloud' && item.cloudUrl) {
      void openExternal(item.cloudUrl);
      return;
    }
    if (item.absPath) {
      void openLocalPath(item.absPath).catch((err) => {
        // Surface failures in the devtools so a regression here
        // doesn't go unnoticed (the previous silent-failure mode is
        // exactly what made the v172 bug invisible to users).
        console.error('[media] openLocalPath failed', item.absPath, err);
      });
    }
  };

  // Upload-to-cloud state. Local-only rows get a small cloud-up
  // button on hover; clicking pushes the file via /v1/artifacts
  // and triggers a refetch so the row visually flips to "synced."
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const canUpload = item.origin === 'local' && !!item.absPath;
  const uploadLabel = uploading
    ? 'Uploading…'
    : item.origin === 'both'
      ? 'Synced to cloud — opens locally on click'
      : item.origin === 'cloud'
        ? 'Cloud-only — opens via qlaud cloud'
        : 'Save to qlaud cloud (sync to web)';

  async function doUpload(e: React.MouseEvent) {
    e.stopPropagation();
    if (!canUpload || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      const { uploadArtifactToCloud } = await import('../lib/artifact-upload');
      await uploadArtifactToCloud({
        absPath: item.absPath,
        name: item.name,
        threadId,
      });
      onUploaded?.();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'upload failed');
      // Auto-clear the error after 4s so the row goes back to
      // showing the upload button (in case the user wants to retry).
      setTimeout(() => setUploadError(null), 4000);
    } finally {
      setUploading(false);
    }
  }
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/50"
        title={item.relPath}
      >
        {/* Inline thumbnail when we have a local path + Tauri asset
         *  protocol available. Falls back to the type icon for cloud-
         *  only entries or when convertFileSrc resolution failed. */}
        {item.kind === 'image' && previewSrc ? (
          <img
            src={previewSrc}
            alt=""
            loading="lazy"
            className="h-10 w-10 shrink-0 rounded-md object-cover ring-1 ring-border/40"
            onError={(e) => {
              // Asset protocol failed (file moved, permission denied);
              // hide the broken image and let the icon below take over.
              e.currentTarget.style.display = 'none';
            }}
          />
        ) : item.kind === 'video' && previewSrc ? (
          <video
            src={previewSrc}
            preload="metadata"
            muted
            playsInline
            className="h-10 w-10 shrink-0 rounded-md object-cover ring-1 ring-border/40"
            onMouseEnter={(e) => {
              e.currentTarget.play().catch(() => {
                /* autoplay blocked — fine, click the row to open. */
              });
            }}
            onMouseLeave={(e) => {
              e.currentTarget.pause();
              e.currentTarget.currentTime = 0;
            }}
          />
        ) : item.kind === 'audio' && previewSrc ? (
          // Audio gets a compact play indicator + waveform-ish badge
          // (no thumbnail to render). Click row → opens in OS player.
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-violet-500/10 ring-1 ring-violet-500/20"
            aria-hidden
          >
            <Music className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          </span>
        ) : (
          <Icon
            className={cn(
              'h-3.5 w-3.5 shrink-0',
              item.kind === 'image' && 'text-emerald-600 dark:text-emerald-400',
              item.kind === 'audio' && 'text-violet-600 dark:text-violet-400',
              item.kind === 'video' && 'text-amber-600 dark:text-amber-400',
            )}
            aria-hidden
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[12px] text-foreground/90">
              {item.name}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              {/* Cloud sync affordance:
               *   - Local-only: hover-revealed CloudUpload button (click
               *     to push to qlaud cloud → row flips to 'both').
               *   - Both: solid Cloud icon (synced).
               *   - Cloud-only: outlined Cloud icon (not on this device).
               *   - Uploading: spinner.
               *   - Upload error: red ! with the message in title. */}
              {uploading ? (
                <Loader2
                  className="h-3 w-3 animate-spin text-sky-500"
                  aria-label="Uploading"
                />
              ) : uploadError ? (
                <span
                  className="cursor-help text-[10px] text-rose-600 dark:text-rose-400"
                  title={`Upload failed: ${uploadError}`}
                  aria-label={uploadError}
                >
                  !
                </span>
              ) : item.origin === 'both' ? (
                <Cloud
                  className="h-3 w-3 fill-sky-500/20 text-sky-600 dark:text-sky-400"
                  aria-label="Synced to cloud"
                />
              ) : item.origin === 'cloud' ? (
                <Cloud
                  className="h-3 w-3 text-sky-600 dark:text-sky-400"
                  aria-label="Cloud only"
                />
              ) : canUpload ? (
                <button
                  type="button"
                  onClick={doUpload}
                  className="hidden h-4 w-4 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-sky-500/10 hover:text-sky-600 group-hover:flex"
                  title={uploadLabel}
                  aria-label="Save to qlaud cloud"
                >
                  <CloudUpload className="h-3 w-3" />
                </button>
              ) : null}
              <span className="text-[10px] tabular-nums text-muted-foreground/70">
                {item.size != null ? formatBytes(item.size) : ''}
              </span>
            </div>
          </div>
          <span className="block truncate text-[10.5px] leading-tight text-muted-foreground/70">
            {item.relPath}
          </span>
        </div>
        <FileText
          className="hidden h-3 w-3 shrink-0 text-muted-foreground/50 group-hover:block"
          aria-hidden
        />
      </button>
    </li>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ─── Usage view ───────────────────────────────────────────────────
//
// Centralized "what have I used" panel for qcode users. Shows:
//   - Plan badge + reset countdown
//   - Day / Week / Month toggle
//   - Spend + request count for the selected window
//   - Per-tier daily progress bars (always today, since limits are
//     daily — week/month don't have per-tier limits to compare to)
//   - Top models by spend
//   - Bar chart of cost by bucket
//
// Pulls from /v1/qcode/me (today's tier breakdown, plan info) and
// /v1/qcode/usage (30-day daily history for week/month rebucketing).
// Both are React Query'd in App.tsx + queries.ts so the data is
// already cached when the view mounts.
type UsageRange = 'day' | 'week' | 'month';

function UsageView() {
  const [range, setRange] = useState<UsageRange>('day');
  const meQ = useQcodeMeQuery(true);
  const usageQ = useQcodeUsageQuery(30, true);

  if (meQ.isLoading || usageQ.isLoading) {
    return (
      <div className="flex h-32 items-center justify-center text-[11px] text-muted-foreground">
        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
        Loading usage…
      </div>
    );
  }
  const me = meQ.data ?? null;
  const usage = usageQ.data ?? null;

  if (!me) {
    return (
      <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">
        Sign in to see your usage.
      </div>
    );
  }

  const buckets = computeBuckets(usage, range);
  const totals = computeRangeTotals(usage, range, me);
  const topModels = (usage?.by_model ?? []).slice(0, 5);

  // Single-bar period status — replaces the eight-tier-bucket
  // breakdown that used to live here. Pulls the same numbers the
  // title-bar SpendBar reads, just rendered fuller for the Usage
  // tab context: bigger bar, period-resets countdown, plan badge.
  const planUsedUsd = me.usage.used_usd;
  const planBudgetUsd = me.usage.budget_usd;
  const planPercent = me.usage.percent;
  const periodResetsText = me.plan.period_resets_at
    ? formatResetCountdown(me.plan.period_resets_at)
    : 'lifetime trial';

  return (
    <div className="flex h-full flex-col gap-3 px-3 py-3">
      {/* Plan header */}
      <div className="flex items-center justify-between rounded-md border border-border/40 bg-background/60 px-2.5 py-2">
        <div>
          <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
            Plan
          </div>
          <div className="text-[12.5px] font-semibold text-foreground">
            {me.plan.benefits.displayName}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Resets
          </div>
          <div className="text-[11px] tabular-nums text-foreground/85">
            {periodResetsText}
          </div>
        </div>
      </div>

      {/* Period-to-date usage bar — single number, single comparison.
       *  Replaces the eight tier-buckets that used to live here. */}
      <section>
        <div className="mb-1.5 flex items-center justify-between text-[11px]">
          <span className="font-medium text-foreground/85">
            This period
          </span>
          <span className="tabular-nums text-muted-foreground">
            ${planUsedUsd.toFixed(2)} / ${planBudgetUsd.toFixed(2)}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full transition-all',
              planPercent >= 100
                ? 'bg-foreground'
                : planPercent >= 90
                  ? 'bg-rose-500'
                  : planPercent >= 70
                    ? 'bg-amber-500'
                    : 'bg-primary',
            )}
            style={{ width: `${Math.min(100, planPercent)}%` }}
          />
        </div>
      </section>

      {/* Day / Week / Month toggle */}
      <div className="flex rounded-md border border-border/60 bg-background/60 p-0.5 text-[11px]">
        {(['day', 'week', 'month'] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRange(r)}
            className={cn(
              'flex-1 rounded px-2 py-1 font-medium capitalize transition-colors',
              range === r
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {r}
          </button>
        ))}
      </div>

      {/* Headline totals for the selected range */}
      <div className="grid grid-cols-2 gap-2">
        <Stat
          label={`${rangeLabel(range)} spend`}
          value={`$${(totals.cost_micros / 1_000_000).toFixed(2)}`}
        />
        <Stat
          label={`${rangeLabel(range)} requests`}
          value={totals.request_count.toLocaleString()}
        />
      </div>

      {/* Bucket chart */}
      {buckets.length > 0 && (
        <section>
          <SectionLabel>
            Cost by{' '}
            {range === 'day' ? 'day' : range === 'week' ? 'week' : 'month'}
          </SectionLabel>
          <BucketChart buckets={buckets} />
        </section>
      )}

      {/* Top models */}
      {topModels.length > 0 && (
        <section>
          <SectionLabel>Top models (last 30 days)</SectionLabel>
          <div className="space-y-1">
            {topModels.map((m) => (
              <div
                key={m.model_slug}
                className="flex items-center justify-between text-[11px]"
              >
                <span className="truncate font-mono text-foreground/85">
                  {m.model_slug}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  ${(m.cost_micros / 1_000_000).toFixed(2)} ·{' '}
                  {m.request_count}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-background/60 px-2.5 py-2">
      <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-[14px] font-semibold tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

// TierBar component retired — the credit-model rewrite replaces
// the eight per-tier bars with a single period-to-date $-bar
// rendered inline above. Component dropped wholesale; the inline
// bar in UsageView is its replacement.

function BucketChart({
  buckets,
}: {
  buckets: import('../lib/qcode-usage').UsageBucket[];
}) {
  // Tiny bar chart. Max-cost in the window is the 100% reference;
  // empty windows render as a single faint label row so the user
  // knows there's no spend (rather than thinking the chart broke).
  const max = Math.max(...buckets.map((b) => b.cost_micros), 1);
  return (
    <div className="space-y-1">
      {buckets.map((b) => {
        const pct = (b.cost_micros / max) * 100;
        return (
          <div key={b.start_ms} className="flex items-center gap-2 text-[10.5px]">
            <span className="w-16 shrink-0 truncate text-muted-foreground">
              {b.label}
            </span>
            <div className="relative h-3 flex-1 overflow-hidden rounded bg-muted/60">
              <div
                className="h-full bg-primary/70"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right tabular-nums text-foreground/85">
              ${(b.cost_micros / 1_000_000).toFixed(2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Bucket / range helpers ───────────────────────────────────────

function computeBuckets(
  usage: import('../lib/qcode-usage').QcodeUsage | null,
  range: UsageRange,
): import('../lib/qcode-usage').UsageBucket[] {
  if (!usage) return [];
  if (range === 'day') return bucketByDay(usage).slice(-14); // last 14 days fits the rail
  if (range === 'week') return bucketByWeek(usage);
  return bucketByMonth(usage);
}

function computeRangeTotals(
  usage: import('../lib/qcode-usage').QcodeUsage | null,
  range: UsageRange,
  _me: import('../lib/qcode-me').QcodeMe,
): { cost_micros: number; request_count: number } {
  if (!usage) return { cost_micros: 0, request_count: 0 };
  if (range === 'day') {
    const todayUtc = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    );
    const todayBucket = usage.by_day.find((d) => d.day_ms === todayUtc);
    return {
      cost_micros: todayBucket?.cost_micros ?? 0,
      request_count: todayBucket?.request_count ?? 0,
    };
  }
  if (range === 'week') {
    const oneWeekAgo = Date.now() - 7 * 86_400_000;
    return usage.by_day
      .filter((d) => d.day_ms >= oneWeekAgo)
      .reduce(
        (acc, d) => ({
          cost_micros: acc.cost_micros + d.cost_micros,
          request_count: acc.request_count + d.request_count,
        }),
        { cost_micros: 0, request_count: 0 },
      );
  }
  // Month = current calendar month
  const monthStart = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    1,
  );
  return usage.by_day
    .filter((d) => d.day_ms >= monthStart)
    .reduce(
      (acc, d) => ({
        cost_micros: acc.cost_micros + d.cost_micros,
        request_count: acc.request_count + d.request_count,
      }),
      { cost_micros: 0, request_count: 0 },
    );
}

function rangeLabel(r: UsageRange): string {
  return r === 'day' ? 'Today' : r === 'week' ? 'This week' : 'This month';
}

/** Format a "resets in X" countdown for the plan period anchor.
 *  Days for >1d, hours for sub-day. The credit-model rewrite
 *  retired the daily UTC midnight reset — periods now anchor to
 *  Stripe's billing cycle, so the countdown is from the user's
 *  actual renewal date passed in via /v1/qcode/me.plan.period_resets_at. */
function formatResetCountdown(periodResetsAt: number): string {
  const ms = periodResetsAt - Date.now();
  if (ms <= 0) return 'now';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
