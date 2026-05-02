import { useCallback, useEffect, useState } from 'react';
import {
  ChevronRight,
  Download,
  Folder,
  FolderOpen,
  Menu,
  Plus,
  Search as SearchIcon,
  Settings,
  Wallet,
  X as XIcon,
} from 'lucide-react';
import { cn } from './lib/cn';
import { QlaudMark } from './ui/QlaudMark';

import {
  clearAuth,
  getKey,
  startSignIn,
} from './lib/auth';
import { isTauri, WebNotSupportedError } from './lib/tauri';
import { posthog } from './lib/analytics';
import { startDeepLinkListener } from './lib/deep-link';
import {
  getSettings,
  patchSettings,
  type AgentMode,
} from './lib/settings';
import { useShortcuts, type MenuId } from './lib/shortcuts';
import {
  clearAllQueries,
  invalidateBalance,
  patchThread,
  qk,
  queryClient,
  useAccountQuery,
  useBalanceQuery,
  useCreateThreadMutation,
  useDeleteThreadMutation,
  useThreadsQuery,
} from './lib/queries';
import {
  titleFromPrompt,
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
  const [model, setModel] = useState<string>(() => getSettings().defaultModel);
  const [mode, setMode] = useState<AgentMode>(() => getSettings().mode);
  const [workspace, setWorkspace] = useState<Workspace | null>(() =>
    getCurrentWorkspace(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Mobile sidebar visibility. On md+ breakpoints the sidebar is
  // always visible (the layout uses flex). On narrow widths it
  // becomes an off-canvas drawer the user toggles via the hamburger
  // in the titlebar; auto-closes on thread pick so the chat surface
  // takes full width after navigation.
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
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
    posthog.capture('model_picked', { model: slug });
  }, []);

  const onModeChange = useCallback((next: AgentMode) => {
    setMode(next);
    patchSettings({ mode: next });
    posthog.capture('mode_toggled', { mode: next });
  }, []);

  const handleSignOut = useCallback(async () => {
    posthog.capture('signed_out');
    posthog.reset();
    await clearAuth();
    setCurrentWorkspace(null);
    setAuthed(false);
    setWorkspace(null);
    setSettingsOpen(false);
    // Wipe server-state caches — no stale data leaks if a different
    // account signs in next.
    clearAllQueries();
  }, []);

  // ─── Server state ─────────────────────────────────────────────
  // All of this used to be hand-rolled useEffects (boot reconcile,
  // refreshAccount, refreshBalance). Now Query owns it: cache hydrates
  // from localStorage on boot for instant paint, refetches in the
  // background, and refetches automatically on focus / reconnect.
  // No more "is the data fresh?" bug surface.

  const threadsQuery = useThreadsQuery({
    authed,
    workspace,
    fallbackModel: model,
  });
  const threads = threadsQuery.data ?? [];

  const accountQuery = useAccountQuery(authed);
  const balanceQuery = useBalanceQuery(authed);

  // Single derived profile — what every consumer that used to read
  // from useState(profile) now reads. No persisted middle layer:
  // Query is the source of truth.
  const profile = authed
    ? {
        email: accountQuery.data?.email ?? '',
        user_id: accountQuery.data?.user_id ?? '',
        balance_usd: balanceQuery.data?.balanceUsd ?? undefined,
      }
    : null;

  const [currentId, setCurrentId] = useState<string | null>(() => {
    // Seed from the cached threads list so refreshing the app lands
    // on the same conversation. Falls through to null when the cache
    // is empty (first run or post sign-out).
    const cachedFirst = threadsQuery.data?.[0]?.id;
    return cachedFirst ?? null;
  });

  // If the active thread vanished from the remote (deleted on another
  // device), fall back to whatever the list says is most recent.
  // This is a derived sync — Query data → local pointer state. Cheap
  // and idempotent.
  useEffect(() => {
    if (!threadsQuery.data) return;
    if (currentId && !threadsQuery.data.some((t) => t.id === currentId)) {
      setCurrentId(threadsQuery.data[0]?.id ?? null);
    }
  }, [threadsQuery.data, currentId]);

  // Deep-link listener: qcode://auth?k=… from the qlaud sign-in flow.
  // Once a key lands in the keychain, flipping `authed` is enough —
  // every `useXxxQuery(authed)` hook above will fire its query on
  // the same render. No manual refresh* fan-out needed.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    startDeepLinkListener(() => {
      setAuthed(true);
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

  // PostHog identify — runs whenever account data lands.
  useEffect(() => {
    if (authed && profile?.user_id) {
      posthog.identify(profile.user_id, { email: profile.email });
    }
  }, [authed, profile?.user_id, profile?.email]);

  // Cross-tab storage sync (vite-dev convenience). Just flips authed —
  // queries refetch on the same render.
  useEffect(() => {
    function onStorage() {
      setAuthed(Boolean(getKey()));
      setWorkspace(getCurrentWorkspace());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Manual refetch handles for legacy props that took an imperative
  // refresh callback. Internally these are just Query invalidations —
  // the next consumer rerenders against the new data.
  const refreshThreads = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.threads });
  }, []);
  const refreshBalance = useCallback(() => {
    void invalidateBalance();
  }, []);
  const refreshAccount = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.account });
  }, []);

  // "New chat" is purely a UI clear — no network, no cache mutation.
  // The remote thread is created lazily by ensureThreadId() on the
  // first send. This stops the sidebar from filling with "New chat"
  // rows every time the user clicks the button without sending,
  // which was happening because every click POSTed /v1/threads
  // (a real thread on qlaud's side) and the sidebar showed all of
  // them. Now: clicking creates nothing; the first message creates
  // a thread with the user's prompt as its seed title.
  const newThread = useCallback(async () => {
    setCurrentId(null);
  }, []);

  const switchThread = useCallback((id: string) => {
    setCurrentId(id);
  }, []);

  // Optimistic delete via Query mutation — sidebar updates the
  // moment the user clicks; cache rolls back if the network errors.
  const deleteMutation = useDeleteThreadMutation({
    onSuccess: (id) => {
      if (currentId === id) {
        const list = queryClient.getQueryData<ThreadSummary[]>(qk.threads);
        setCurrentId(list?.[0]?.id ?? null);
      }
    },
  });
  const removeThread = useCallback(
    (id: string) => {
      deleteMutation.mutate(id);
    },
    [deleteMutation],
  );

  // Lazy thread provisioning. ChatSurface calls this before its
  // first send when no thread is active — the mutation handles the
  // optimistic insert + cache reconciliation; we just return the id.
  const createMutation = useCreateThreadMutation();
  const ensureThreadId = useCallback(async (): Promise<string> => {
    if (currentId) return currentId;
    const result = await createMutation.mutateAsync({ workspace, model });
    setCurrentId(result.summary.id);
    return result.summary.id;
  }, [currentId, model, workspace, createMutation]);

  // ChatSurface reports back when a turn lands. Patch the title (if
  // still the "New chat" placeholder), bump updatedAt, and invalidate
  // balance so the spend bar reflects this turn's spend.
  const onTurnLanded = useCallback(
    (info: { userText: string | null; threadId: string }) => {
      const list =
        queryClient.getQueryData<ThreadSummary[]>(qk.threads) ?? [];
      const existing = list.find((s) => s.id === info.threadId);
      const patch: Partial<ThreadSummary> = { updatedAt: Date.now() };
      if (existing?.title === 'New chat' && info.userText) {
        patch.title = titleFromPrompt(info.userText);
      }
      patchThread(info.threadId, patch);
      void invalidateBalance();
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
          setWorkspace(null);
          clearAllQueries();
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
        onToggleSidebar={() => setMobileSidebarOpen((v) => !v)}
      />

      <div className="relative flex flex-1 overflow-hidden">
        {/* Scrim — only renders + intercepts taps when the drawer is
         *  open on narrow widths. md+ never sees it. */}
        {mobileSidebarOpen && (
          <button
            aria-label="Close sidebar"
            onClick={() => setMobileSidebarOpen(false)}
            className="absolute inset-0 z-30 bg-black/30 backdrop-blur-sm md:hidden"
          />
        )}
        <div
          className={cn(
            // Mobile: off-canvas drawer that slides in over the chat
            // surface. md+: in-flow column (transform reset to 0).
            'absolute inset-y-0 left-0 z-40 w-72 max-w-[85vw] transform transition-transform duration-200 md:static md:w-64 md:max-w-none md:translate-x-0 md:transition-none',
            mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <Sidebar
            workspace={workspace}
            threads={threads}
            currentThreadId={currentId}
            onOpenFolder={async () => {
              setMobileSidebarOpen(false);
              const w = await tryOpenFolder();
              if (w) setWorkspace(w);
            }}
            onNewChat={() => {
              setMobileSidebarOpen(false);
              void newThread();
            }}
            onPickThread={(id) => {
              setMobileSidebarOpen(false);
              switchThread(id);
            }}
            onDeleteThread={removeThread}
          />
        </div>
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
            workspaceName={workspace?.name}
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
        onRefreshAccount={refreshAccount}
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
  onToggleSidebar,
}: {
  model: string;
  onModelChange: (slug: string) => void;
  mode: AgentMode;
  onModeChange: (m: AgentMode) => void;
  onRefreshBalance: () => void;
  profile: { email: string; user_id: string; balance_usd?: number } | null;
  workspaceName?: string;
  onOpenSettings: () => void;
  onToggleSidebar?: () => void;
}) {
  return (
    <header className="titlebar relative z-50 flex h-11 items-center justify-between border-b border-border/40 bg-background/40 px-3 backdrop-blur-md">
      {/* pl-16 leaves clearance for macOS traffic-light buttons.
       *  On mobile/web we lose the traffic-lights and pick up a
       *  hamburger that toggles the off-canvas sidebar. */}
      <div className="flex items-center gap-2 md:pl-16">
        {onToggleSidebar && (
          <button
            type="button"
            aria-label="Toggle sidebar"
            onClick={onToggleSidebar}
            className="no-drag grid h-8 w-8 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
          >
            <Menu className="h-4 w-4" />
          </button>
        )}
        {/* Canonical qlaud monogram — dark q with red period accent.
            Same source as qlaud.ai/icon.svg. */}
        <QlaudMark className="h-5 w-5 rounded shadow-sm" />
        <span className="text-sm font-semibold tracking-tight">qcode</span>
        <span className="ml-1 rounded-full border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
          alpha
        </span>
        {workspaceName && (
          <>
            <span className="mx-2 hidden text-muted-foreground/60 sm:inline">/</span>
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">
              {workspaceName}
            </span>
          </>
        )}
      </div>

      <div className="no-drag flex items-center gap-1.5 sm:gap-2">
        {/* Hide mode toggle + spend bar on the smallest widths so the
         *  titlebar doesn't wrap. Both still reachable: mode via
         *  composer pill, balance via Settings. */}
        <div className="hidden sm:block">
          <ModeToggle value={mode} onChange={onModeChange} />
        </div>
        <ModelPicker value={model} onChange={onModelChange} />
        <div className="hidden sm:block">
          <SpendBar profile={profile} onRefresh={onRefreshBalance} />
        </div>
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
  profile: { email: string; user_id: string; balance_usd?: number } | null;
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
  // Local filter — narrows BOTH the projects section and the chats
  // section as the user types. Empty string = pass-through. Match
  // is case-insensitive substring on the title for now (cheap, no
  // index needed since titles are already in memory). Cmd-K still
  // opens the global palette for actions + files; this is the
  // sidebar-scoped "find a conversation" affordance.
  const [filter, setFilter] = useState('');
  const filterLc = filter.trim().toLowerCase();
  const matches = (t: ThreadSummary) =>
    !filterLc || t.title.toLowerCase().includes(filterLc);
  const visibleThreads = threads.filter(matches);

  return (
    <aside className="flex w-64 flex-col border-r border-border/40 bg-muted/30 backdrop-blur-sm">
      <div className="space-y-2 px-3 pt-3">
        <button
          onClick={onNewChat}
          className="flex w-full items-center justify-between rounded-md border border-border bg-background/80 px-3 py-2 text-sm font-medium transition-colors hover:border-foreground/30 hover:bg-background"
        >
          <span className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            New chat
          </span>
          <Kbd>⌘N</Kbd>
        </button>
        <button
          onClick={onOpenFolder}
          className="flex w-full items-center justify-between rounded-md border border-border bg-background/80 px-3 py-2 text-sm font-medium transition-colors hover:border-foreground/30 hover:bg-background"
        >
          <span className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4" />
            {workspace ? 'Switch folder' : 'Open folder'}
          </span>
          <Kbd>⌘O</Kbd>
        </button>
        {/* Filter input. Hidden when there are <3 threads — for an
         *  empty/near-empty list there's nothing to find. Visible
         *  the moment the sidebar gets meaningful, which mirrors
         *  how Codex / Linear / Slack reveal their search row. */}
        {threads.length >= 3 && (
          <SidebarFilter value={filter} onChange={setFilter} />
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-3 pt-4">
        <ProjectsSection
          threads={visibleThreads}
          currentThreadId={currentThreadId}
          activeWorkspacePath={workspace?.path ?? null}
          onPick={onPickThread}
          onDelete={onDeleteThread}
        />
        <div>
          <div className="px-2 pb-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Chats
          </div>
          <ThreadList
            threads={visibleThreads.filter((t) => !t.workspacePath)}
            currentId={currentThreadId}
            onPick={onPickThread}
            onDelete={onDeleteThread}
          />
          {filterLc && visibleThreads.length === 0 && (
            <p className="px-2 py-2 text-[11px] leading-relaxed text-muted-foreground">
              No matches for &ldquo;{filter}&rdquo;.
            </p>
          )}
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

// Compact search/filter input for the sidebar. Press Esc to clear,
// Backspace on an empty value bails focus back to the chat. Stays
// thin and quiet by default; primary border on focus mirrors the
// composer's focus styling so the surfaces feel like one app.
function SidebarFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="group relative flex items-center rounded-md border border-border bg-background/60 px-2.5 py-1.5 transition-colors focus-within:border-foreground/30 focus-within:bg-background">
      <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-focus-within:text-foreground/70" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onChange('');
          }
        }}
        placeholder="Find a conversation"
        className="ml-2 min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground"
      />
      {value && (
        <button
          aria-label="Clear filter"
          onClick={() => onChange('')}
          className="ml-1 grid h-4 w-4 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <XIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// Bucket workspace-tagged threads by workspace path. The currently
// open workspace floats to the top + auto-expands; other projects
// collapse so the sidebar doesn't drown in old folders. "Chats"
// (no workspace) render in their own section below — see Sidebar.
function ProjectsSection({
  threads,
  currentThreadId,
  activeWorkspacePath,
  onPick,
  onDelete,
}: {
  threads: ThreadSummary[];
  currentThreadId: string | null;
  activeWorkspacePath: string | null;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  // Group by workspacePath. Only threads with a path land here;
  // workspace-less threads are filtered out by the caller.
  const groups = new Map<
    string,
    { name: string; threads: ThreadSummary[] }
  >();
  for (const t of threads) {
    if (!t.workspacePath) continue;
    const g = groups.get(t.workspacePath);
    if (g) g.threads.push(t);
    else
      groups.set(t.workspacePath, {
        name: t.workspaceName ?? t.workspacePath.split('/').pop() ?? 'project',
        threads: [t],
      });
  }
  if (groups.size === 0) return null;

  // Sort groups: active workspace first, then by most-recent thread.
  const sorted = [...groups.entries()].sort(([aPath, a], [bPath, b]) => {
    if (aPath === activeWorkspacePath) return -1;
    if (bPath === activeWorkspacePath) return 1;
    const aMax = Math.max(...a.threads.map((t) => t.updatedAt));
    const bMax = Math.max(...b.threads.map((t) => t.updatedAt));
    return bMax - aMax;
  });

  return (
    <div>
      <div className="px-2 pb-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
        Projects
      </div>
      <ul className="space-y-2">
        {sorted.map(([path, g]) => (
          <ProjectGroup
            key={path}
            name={g.name}
            threads={g.threads}
            isActive={path === activeWorkspacePath}
            currentThreadId={currentThreadId}
            onPick={onPick}
            onDelete={onDelete}
          />
        ))}
      </ul>
    </div>
  );
}

function ProjectGroup({
  name,
  threads,
  isActive,
  currentThreadId,
  onPick,
  onDelete,
}: {
  name: string;
  threads: ThreadSummary[];
  isActive: boolean;
  currentThreadId: string | null;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  // Active project auto-expanded. Other projects collapse — the
  // user clicks the header to expand and pick an old conversation.
  const [open, setOpen] = useState(isActive);
  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
  // Open folder + chevron-down for the active group; closed folder +
  // chevron-right for collapsed. Visual grammar matches Codex /
  // VSCode tree views the user already has muscle memory for.
  const FolderIcon = open ? FolderOpen : Folder;
  return (
    <li>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] font-medium transition-colors',
          isActive
            ? 'text-foreground hover:bg-muted/60'
            : 'text-foreground/80 hover:bg-muted/50',
        )}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
        <FolderIcon
          className={cn(
            'h-3 w-3 shrink-0 transition-colors',
            isActive ? 'text-primary' : 'text-muted-foreground',
          )}
        />
        <span className="truncate">{name}</span>
        {isActive && (
          <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0 text-[9px] font-medium uppercase tracking-wider text-primary">
            Open
          </span>
        )}
        <span
          className={cn(
            'ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground transition-opacity',
            open ? 'opacity-50' : 'opacity-100',
          )}
        >
          {threads.length}
        </span>
      </button>
      {/* Animated reveal — grid-rows trick avoids the height:auto
       *  transition issue and keeps content from rendering when
       *  collapsed (no a11y noise from offscreen-but-rendered rows). */}
      <div
        className={cn(
          'grid transition-all duration-200',
          open ? 'mt-0.5 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="overflow-hidden pl-3">
          <ThreadList
            threads={sorted}
            currentId={currentThreadId}
            onPick={onPick}
            onDelete={onDelete}
          />
        </div>
      </div>
    </li>
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
