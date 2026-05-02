import { useCallback, useEffect, useState } from 'react';
import { Download, FolderOpen, Plus, Settings, Wallet } from 'lucide-react';
import { QlaudMark } from './ui/QlaudMark';

import {
  clearAuth,
  getKey,
  getProfile,
  setProfile as persistProfile,
  startSignIn,
  type Profile,
} from './lib/auth';
import { isTauri, WebNotSupportedError } from './lib/tauri';
import { fetchBalance } from './lib/billing';
import { startDeepLinkListener } from './lib/deep-link';
import {
  getSettings,
  patchSettings,
  type AgentMode,
} from './lib/settings';
import { useShortcuts, type MenuId } from './lib/shortcuts';
import {
  createRemoteThread,
  deleteRemoteThread,
  listRemoteThreads,
  purgeEmptyRemoteThreads,
  loadCachedSummaries,
  patchCachedSummary,
  removeCachedSummary,
  saveCachedSummaries,
  titleFromPrompt,
  upsertCachedSummary,
  type ThreadSummary,
} from './lib/threads';
import {
  getCurrentWorkspace,
  openFolderPicker,
  setCurrentWorkspace,
  type Workspace,
} from './lib/workspace';
import { ChatSurface } from './ui/ChatSurface';
import { CommandPalette } from './ui/CommandPalette';
import { FileTree } from './ui/FileTree';
import { ModelPicker } from './ui/ModelPicker';
import { SettingsDrawer } from './ui/SettingsDrawer';
import { SignInGate } from './ui/SignInGate';
import { ThreadList } from './ui/ThreadList';

export function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getKey()));
  const [profile, setProfile] = useState<Profile | null>(() => getProfile());
  const [model, setModel] = useState<string>(() => getSettings().defaultModel);
  const [mode, setMode] = useState<AgentMode>(() => getSettings().mode);
  const [workspace, setWorkspace] = useState<Workspace | null>(() =>
    getCurrentWorkspace(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Set true when the user clicked something that requires the
  // desktop app (folder picker, etc.) on the web build. Renders an
  // inline notice with a download CTA instead of failing silently.
  const [webNotice, setWebNotice] = useState(false);

  /** Call this instead of openFolderPicker() directly. On web it
   *  flips the notice on and returns null; on desktop it just opens
   *  the picker like before. Lets every "open folder" button across
   *  the app share the same UX without repeating try/catch. */
  const tryOpenFolder = useCallback(async (): Promise<Workspace | null> => {
    try {
      return await openFolderPicker();
    } catch (e) {
      if (e instanceof WebNotSupportedError) {
        setWebNotice(true);
        return null;
      }
      throw e;
    }
  }, []);

  // Persist when the user picks a new default. We update the user's
  // current view immediately (setModel) and stash the choice as the
  // default for future "New chat" sessions. The title-bar dropdown
  // doubles as both per-session switcher and global default-setter
  // — picking a model is a strong signal of intent.
  const onModelChange = useCallback((slug: string) => {
    setModel(slug);
    patchSettings({ defaultModel: slug });
  }, []);

  const onModeChange = useCallback((next: AgentMode) => {
    setMode(next);
    patchSettings({ mode: next });
  }, []);

  const handleSignOut = useCallback(async () => {
    await clearAuth();
    setCurrentWorkspace(null);
    setAuthed(false);
    setProfile(null);
    setWorkspace(null);
    setSettingsOpen(false);
  }, []);

  // Threads. qlaud owns the canonical history at /v1/threads; we
  // hold a localStorage cache of summaries so the sidebar renders
  // before the network round-trip lands. ChatSurface fetches the
  // active thread's messages via GET /v1/threads/:id/messages on
  // mount and re-renders from there.
  const [threads, setThreads] = useState<ThreadSummary[]>(() =>
    loadCachedSummaries(),
  );
  const [currentId, setCurrentId] = useState<string | null>(
    () => loadCachedSummaries()[0]?.id ?? null,
  );

  // Reconcile the cache against qlaud on first authed render. Remote
  // wins on conflict — if a thread was deleted on another device,
  // our local cache loses its row. Newly-created remote threads get
  // a synthesized title (qlaud doesn't store one yet).
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    void (async () => {
      try {
        // Best-effort cleanup of orphans before listing — keeps the
        // sidebar clean even when sends previously failed mid-flight
        // (CORS, network, capability gaps) and left empty threads
        // behind. Safe to call every load; server returns 0 when
        // nothing matches.
        await purgeEmptyRemoteThreads();
        const remote = await listRemoteThreads();
        if (cancelled) return;
        const cache = loadCachedSummaries();
        const cacheById = new Map(cache.map((s) => [s.id, s]));
        const merged: ThreadSummary[] = remote.map((r) => {
          const cached = cacheById.get(r.id);
          return {
            id: r.id,
            title: cached?.title ?? 'New chat',
            model: cached?.model ?? model,
            createdAt: r.created_at,
            updatedAt: r.last_active_at,
          };
        });
        saveCachedSummaries(merged);
        setThreads(merged);
        // If our active id no longer exists remotely, fall back to
        // the most recent thread (or null).
        if (currentId && !merged.some((t) => t.id === currentId)) {
          setCurrentId(merged[0]?.id ?? null);
        }
      } catch {
        // Network blip on boot — keep the cached view, retry implicit
        // on next render that triggers the effect.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // Pull live balance from qlaud and merge into the cached profile so
  // the title-bar spend bar shows fresh numbers. Idempotent — safe to
  // call from anywhere (boot, post-turn, manual refresh click).
  const refreshBalance = useCallback(async () => {
    if (!getKey()) return;
    const info = await fetchBalance();
    if (!info) return;
    setProfile((p) => {
      const next: Profile = {
        email: p?.email ?? '',
        user_id: p?.user_id ?? '',
        balance_usd: info.balanceUsd,
      };
      persistProfile(next);
      return next;
    });
  }, []);

  // Deep-link listener: qcode://auth?k=… from the qlaud sign-in flow.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    startDeepLinkListener(() => {
      setAuthed(true);
      setProfile(getProfile());
      void refreshBalance();
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, [refreshBalance]);

  // Boot: pull a fresh balance on the first authed render so the
  // spend bar isn't sitting at $0 while the cache hydrates.
  useEffect(() => {
    if (authed) void refreshBalance();
  }, [authed, refreshBalance]);

  // Cross-tab storage sync (vite-dev convenience).
  useEffect(() => {
    function onStorage() {
      setAuthed(Boolean(getKey()));
      setProfile(getProfile());
      setWorkspace(getCurrentWorkspace());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Thread mutations. qlaud is authoritative; we mutate the cache
  // optimistically and reconcile on the next list call.
  const refreshThreads = useCallback(() => {
    setThreads(loadCachedSummaries());
  }, []);

  const newThread = useCallback(async () => {
    try {
      const t = await createRemoteThread();
      const summary: ThreadSummary = {
        id: t.id,
        title: 'New chat',
        model,
        createdAt: t.created_at,
        updatedAt: t.last_active_at,
      };
      setThreads(upsertCachedSummary(summary));
      setCurrentId(t.id);
    } catch {
      // Network failure — leave the user on whatever they had.
      // The composer will surface the error on first send if the
      // problem persists.
    }
  }, [model]);

  const switchThread = useCallback((id: string) => {
    setCurrentId(id);
  }, []);

  const removeThread = useCallback(
    async (id: string) => {
      // Optimistic prune — drop from cache + list immediately, then
      // delete server-side. If the delete fails the next refresh
      // will resurrect the row.
      const next = removeCachedSummary(id);
      setThreads(next);
      if (currentId === id) {
        setCurrentId(next[0]?.id ?? null);
      }
      try {
        await deleteRemoteThread(id);
      } catch {
        // Tolerated — see comment above.
      }
    },
    [currentId],
  );

  // Lazy thread provisioning. ChatSurface calls this before its
  // first send when no thread is active — gives us a real qlaud
  // thread id to address. Mirrors the legacy "first turn → conjure
  // a thread" path but delegates the round-trip out of the
  // composer's hot path.
  const ensureThreadId = useCallback(async (): Promise<string> => {
    if (currentId) return currentId;
    const t = await createRemoteThread();
    const summary: ThreadSummary = {
      id: t.id,
      title: 'New chat',
      model,
      createdAt: t.created_at,
      updatedAt: t.last_active_at,
    };
    setThreads(upsertCachedSummary(summary));
    setCurrentId(t.id);
    return t.id;
  }, [currentId, model]);

  // ChatSurface reports back when a turn lands. We use that to
  // refresh the cached summary's updatedAt and (if the title is
  // still the "New chat" placeholder) seed a real title from the
  // user's prompt. Canonical history lives on qlaud — we don't
  // replay or re-persist it locally.
  const onTurnLanded = useCallback(
    (info: { userText: string | null; threadId: string }) => {
      const cache = loadCachedSummaries();
      const existing = cache.find((s) => s.id === info.threadId);
      if (!existing) return;
      const patch: Partial<ThreadSummary> = { updatedAt: Date.now() };
      if (existing.title === 'New chat' && info.userText) {
        patch.title = titleFromPrompt(info.userText);
      }
      setThreads(patchCachedSummary(info.threadId, patch));
    },
    [],
  );

  // Single source of truth for native-menu + keyboard shortcuts.
  const onMenu = useCallback(
    async (id: MenuId) => {
      switch (id) {
        case 'new_chat':
          void newThread();
          break;
        case 'open_folder': {
          const w = await tryOpenFolder();
          if (w) setWorkspace(w);
          break;
        }
        case 'preferences':
          setSettingsOpen(true);
          break;
        case 'sign_out':
          await clearAuth();
          setCurrentWorkspace(null);
          setAuthed(false);
          setProfile(null);
          setWorkspace(null);
          break;
        case 'command_palette':
          setPaletteOpen(true);
          break;
        case 'model_picker':
          // Phase 2: focus the picker programmatically.
          break;
      }
    },
    [newThread],
  );
  useShortcuts(onMenu);

  if (!authed) {
    return <SignInGate onSignIn={startSignIn} />;
  }

  return (
    <div className="flex h-dvh flex-col text-foreground">
      <Titlebar
        model={model}
        onModelChange={onModelChange}
        mode={mode}
        onModeChange={onModeChange}
        profile={profile}
        workspaceName={workspace?.name}
        onRefreshBalance={refreshBalance}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          workspace={workspace}
          threads={threads}
          currentThreadId={currentId}
          onOpenFolder={async () => {
            const w = await tryOpenFolder();
            if (w) setWorkspace(w);
          }}
          onNewChat={newThread}
          onPickThread={switchThread}
          onDeleteThread={removeThread}
        />
        <main className="flex min-h-0 flex-1 flex-col bg-background/85 backdrop-blur-sm">
          <ChatSurface
            threadId={currentId}
            ensureThreadId={ensureThreadId}
            onTurnLanded={(info) => {
              onTurnLanded(info);
              void refreshBalance();
            }}
            model={model}
            mode={mode}
            hasWorkspace={!!workspace}
            onOpenFolder={async () => {
              const w = await tryOpenFolder();
              if (w) setWorkspace(w);
            }}
          />
        </main>
      </div>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        email={profile?.email ?? null}
        onSignOut={handleSignOut}
        onClearedThreads={refreshThreads}
      />

      <WebNotSupportedModal open={webNotice} onClose={() => setWebNotice(false)} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        workspace={workspace}
        onOpenFolder={async () => {
          const w = await tryOpenFolder();
          if (w) setWorkspace(w);
        }}
        onNewChat={newThread}
        onSwitchModel={onModelChange}
        onOpenSettings={() => setSettingsOpen(true)}
        onRefreshBalance={refreshBalance}
        onSignOut={handleSignOut}
      />
    </div>
  );
}

// ─── Title bar ──────────────────────────────────────────────────────

function Titlebar({
  model,
  onModelChange,
  mode,
  onModeChange,
  profile,
  workspaceName,
  onRefreshBalance,
  onOpenSettings,
}: {
  model: string;
  onModelChange: (slug: string) => void;
  mode: AgentMode;
  onModeChange: (m: AgentMode) => void;
  onRefreshBalance: () => void;
  profile: Profile | null;
  workspaceName?: string;
  onOpenSettings: () => void;
}) {
  return (
    <header className="titlebar relative z-50 flex h-11 items-center justify-between border-b border-border/40 bg-background/40 px-3 backdrop-blur-md">
      {/* pl-16 leaves clearance for macOS traffic-light buttons. */}
      <div className="flex items-center gap-2 pl-16">
        {/* Canonical qlaud monogram — dark q with red period accent.
            Same source as qlaud.ai/icon.svg. */}
        <QlaudMark className="h-5 w-5 rounded shadow-sm" />
        <span className="text-sm font-semibold tracking-tight">qcode</span>
        <span className="ml-1 rounded-full border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
          alpha
        </span>
        {workspaceName && (
          <>
            <span className="mx-2 text-muted-foreground/60">/</span>
            <span className="text-xs text-muted-foreground">
              {workspaceName}
            </span>
          </>
        )}
      </div>

      <div className="no-drag flex items-center gap-2">
        <ModeToggle value={mode} onChange={onModeChange} />
        <ModelPicker value={model} onChange={onModelChange} />
        <SpendBar profile={profile} onRefresh={onRefreshBalance} />
        <button
          aria-label="Settings"
          className="grid h-7 w-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={onOpenSettings}
          title={profile?.email ? `Settings · signed in as ${profile.email}` : 'Settings'}
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}

function SpendBar({
  profile,
  onRefresh,
}: {
  profile: Profile | null;
  onRefresh: () => void;
}) {
  if (!profile) return null;
  const balance = profile.balance_usd ?? 0;
  const low = balance < 0.5;
  return (
    <button
      onClick={onRefresh}
      className={
        'flex items-center gap-1.5 rounded border bg-background/70 px-2 py-1 text-[11px] tabular-nums transition-colors ' +
        (low
          ? 'border-primary/30 text-primary hover:border-primary/50'
          : 'border-border/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground')
      }
      title={low ? 'Low balance — click to refresh, then top up at qlaud.ai' : 'Click to refresh'}
    >
      <Wallet className="h-3 w-3" />
      ${balance.toFixed(2)}
    </button>
  );
}

// ─── Mode toggle ───────────────────────────────────────────────────
//
// Two-state segmented pill for Agent vs Plan. Visually distinct
// when in Plan so the user always knows write tools are off.

function ModeToggle({
  value,
  onChange,
}: {
  value: AgentMode;
  onChange: (next: AgentMode) => void;
}) {
  const isPlan = value === 'plan';
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      className={
        'flex items-center rounded-full border p-0.5 ' +
        (isPlan
          ? 'border-amber-500/40 bg-amber-500/5'
          : 'border-border/60 bg-background/70')
      }
      title={
        isPlan
          ? 'Plan mode — read-only tools only. The model proposes; you switch to Agent to execute.'
          : 'Agent mode — full toolkit. Write/edit/bash require approval.'
      }
    >
      <Segment
        active={value === 'agent'}
        onClick={() => onChange('agent')}
        label="Agent"
      />
      <Segment
        active={isPlan}
        onClick={() => onChange('plan')}
        label="Plan"
        amber
      />
    </div>
  );
}

function Segment({
  active,
  onClick,
  label,
  amber,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  amber?: boolean;
}) {
  return (
    <button
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={
        'rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors ' +
        (active
          ? amber
            ? 'bg-amber-500/15 text-amber-700'
            : 'bg-foreground text-background'
          : 'text-muted-foreground hover:text-foreground')
      }
    >
      {label}
    </button>
  );
}

// ─── Sidebar ────────────────────────────────────────────────────────

function Sidebar({
  workspace,
  threads,
  currentThreadId,
  onOpenFolder,
  onNewChat,
  onPickThread,
  onDeleteThread,
}: {
  workspace: Workspace | null;
  threads: ThreadSummary[];
  currentThreadId: string | null;
  onOpenFolder: () => void;
  onNewChat: () => void;
  onPickThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
}) {
  return (
    <aside className="flex w-64 flex-col border-r border-border/40 bg-muted/30 backdrop-blur-sm">
      <div className="space-y-2 px-3 pt-3">
        <button
          onClick={onNewChat}
          className="flex w-full items-center justify-between rounded-md border border-border bg-background/80 px-3 py-2 text-sm font-medium transition-colors hover:border-foreground/30"
        >
          <span className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            New chat
          </span>
          <Kbd>⌘N</Kbd>
        </button>
        <button
          onClick={onOpenFolder}
          className="flex w-full items-center justify-between rounded-md border border-border bg-background/80 px-3 py-2 text-sm font-medium transition-colors hover:border-foreground/30"
        >
          <span className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4" />
            {workspace ? 'Switch folder' : 'Open folder'}
          </span>
          <Kbd>⌘O</Kbd>
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-3 pt-4">
        <div>
          <div className="px-2 pb-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Conversations
          </div>
          <ThreadList
            threads={threads}
            currentId={currentThreadId}
            onPick={onPickThread}
            onDelete={onDeleteThread}
          />
        </div>

        {workspace ? (
          <div>
            <div className="px-2 pb-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              {workspace.name}
            </div>
            <FileTree rootPath={workspace.path} />
          </div>
        ) : (
          <div className="px-2">
            <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              Workspace
            </div>
            {isTauri() ? (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Open a folder to start. qcode reads only what you point it at —
                your filesystem stays private until you say otherwise.
              </p>
            ) : (
              <div className="mt-2 rounded-md border border-border/60 bg-muted/30 p-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Web mode is chat-only — browsers can&rsquo;t read local
                  folders. Get the desktop app to open a workspace, run
                  shell commands, and edit files.
                </p>
                <a
                  href="https://qlaud.ai/qcode"
                  target="_blank"
                  rel="noopener"
                  className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-primary hover:underline"
                >
                  <Download className="h-3 w-3" />
                  Download qcode →
                </a>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-border/40 px-3 py-2 text-[10px] text-muted-foreground">
        v0.1.0-alpha · powered by qlaud
      </div>
    </aside>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border/60 bg-background px-1.5 py-0.5 font-sans text-[10px] tabular-nums text-muted-foreground">
      {children}
    </kbd>
  );
}

// Surfaces when the user hits something the web build can't do
// (folder picker today; future entries: native file watch, OS
// keychain, etc.). The previous behavior was a window.prompt() that
// looked broken because no path the user typed was actually
// readable. This explains why and points to the desktop app.
function WebNotSupportedModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="mx-4 w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
          <Download className="h-5 w-5" />
        </div>
        <h2 className="mt-4 text-lg font-semibold tracking-tight">
          Get the desktop app for full power
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Browsers can&rsquo;t read arbitrary local folders, so qcode on the web is
          chat-only. Download the desktop app to open a workspace, run shell
          commands, edit files, and use the full agent loop.
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <a
            href="https://qlaud.ai/qcode"
            target="_blank"
            rel="noopener"
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Download className="h-4 w-4" />
            Download qcode
          </a>
          <button
            onClick={onClose}
            className="inline-flex flex-1 items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium hover:border-foreground/30"
          >
            Continue on web
          </button>
        </div>
      </div>
    </div>
  );
}
