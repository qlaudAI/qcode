import { useCallback, useEffect, useState } from 'react';
import {
  ChevronRight,
  Download,
  Folder,
  FolderOpen,
  Menu,
  PanelRight,
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
  getRemoteThreadMessages,
  titleFromPrompt,
  updateThreadMetadata,
  type RemoteThreadHistory,
  type ThreadSummary,
} from './lib/threads';
import {
  dedupeByThread,
  searchThreads,
  type SearchHit,
} from './lib/search';
import { generateThreadTitle } from './lib/title-gen';
import {
  getCurrentWorkspace,
  openFolderPicker,
  setCurrentWorkspace,
  type Workspace,
} from './lib/workspace';
import { ChatSurface } from './ui/ChatSurface';
import { type RightRailView } from './ui/RightRail';
import { CommandPalette } from './ui/CommandPalette';
import { FileTree } from './ui/FileTree';
import { ModelPicker } from './ui/ModelPicker';
import { SettingsDrawer } from './ui/SettingsDrawer';
import { SignInGate } from './ui/SignInGate';
import { ThreadList } from './ui/ThreadList';

// Extract a thread id from the URL path. qlaud thread ids are
// UUIDs (8-4-4-4-12 hex), so we accept either a bare segment that
// matches that shape or any non-empty path segment when running
// on Tauri (where the URL is app-internal and we control the
// shape). Returns null on the root path or anything malformed.
function parseThreadIdFromPath(): string | null {
  if (typeof window === 'undefined') return null;
  const segment = window.location.pathname.replace(/^\/+/, '').split('/')[0];
  if (!segment) return null;
  // Accept the qlaud UUID shape strictly so we don't try to
  // interpret /auth or /sign-in or other future routes as threads.
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      segment,
    )
  ) {
    return segment;
  }
  return null;
}

export function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getKey()));
  const [model, setModel] = useState<string>(() => getSettings().defaultModel);
  const [mode, setMode] = useState<AgentMode>(() => getSettings().mode);
  const [workspace, setWorkspace] = useState<Workspace | null>(() =>
    getCurrentWorkspace(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Sidebar visibility — works for both mobile and desktop now.
  //   Mobile (< md): off-canvas drawer that slides in over the chat.
  //                  Auto-closes on thread pick so the chat surface
  //                  takes full width after navigation.
  //   Desktop (md+): in-flow column that animates width to 0 when
  //                  closed (collapses, doesn't overlay). User
  //                  toggles via a chevron button in the titlebar
  //                  matching the right-rail close X pattern.
  // Default open on desktop, closed on mobile. Persisted across
  // reloads so people who collapse it stay collapsed.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      const saved = localStorage.getItem('qcode:sidebarOpen');
      if (saved !== null) return saved === '1';
    } catch {
      /* localStorage unavailable */
    }
    return true; // default open
  });
  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem('qcode:sidebarOpen', sidebarOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [sidebarOpen]);
  // Mobile: close drawer after sidebar action (folder pick, thread
  // pick, new chat) so the chat surface takes full width. Desktop:
  // leave the sidebar open — collapsing on every click would feel
  // janky for someone navigating between chats.
  const closeSidebarIfMobile = useCallback(() => {
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 767px)').matches
    ) {
      setSidebarOpen(false);
    }
  }, []);
  // Right rail — single side panel that hosts multiple workbench
  // views (Tasks, Plan, Files, Terminal, Preview, Diff). All views
  // share the same panel width so the chat surface always has the
  // same real estate; users pick what to look at via the dropdown
  // in the titlebar. null = panel hidden. Mirrors Codex's right
  // rail.
  const [rightRailView, setRightRailView] =
    useState<RightRailView | null>(null);
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
      const w = await openFolderPicker();
      // Picker resolved to a workspace — if there's an active thread,
      // start a new chat so the just-picked folder doesn't get
      // grafted onto a thread that was created against a different
      // workspace. Threads are tied to their workspace; the user
      // wanting a different folder = wanting a different chat.
      if (w) setCurrentId(null);
      return w;
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
    // Boot priority: URL path > cached-first-thread > null.
    // On web, /{threadId} survives refresh + back/forward + shared
    // links. On Tauri the URL is internal but the same parsing is
    // safe (no path = falls through to cache).
    const fromUrl = parseThreadIdFromPath();
    if (fromUrl) return fromUrl;
    return threadsQuery.data?.[0]?.id ?? null;
  });

  // Two-way URL sync. When currentId changes (user clicks a thread,
  // newThread fires, switchThread, or the deleted-thread fallback
  // runs), reflect it in the address bar — refresh stays put,
  // shared links open the same conversation. Browser back/forward
  // (popstate) feeds the URL value back into currentId so history
  // navigation works as a thread-switcher on the web.
  useEffect(() => {
    const desired = currentId ? `/${currentId}` : '/';
    if (window.location.pathname !== desired) {
      window.history.replaceState(null, '', desired);
    }
  }, [currentId]);
  useEffect(() => {
    function onPop() {
      const id = parseThreadIdFromPath();
      setCurrentId(id);
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // If the active thread vanished from the remote (deleted on another
  // device), fall back to whatever the list says is most recent.
  // This is a derived sync — Query data → local pointer state. Cheap
  // and idempotent.
  // Trigger on dataUpdatedAt (always changes per refetch) AND data
  // (covers the structural-sharing case where Query keeps the same
  // array reference because the rows happen to be deep-equal).
  // Without dataUpdatedAt, a cross-device delete that produced an
  // identical-looking list would never re-run this check and the
  // active currentId could point at a thread that's been deleted
  // server-side — next send fails with not_found.
  useEffect(() => {
    if (!threadsQuery.data) return;
    if (currentId && !threadsQuery.data.some((t) => t.id === currentId)) {
      setCurrentId(threadsQuery.data[0]?.id ?? null);
    }
  }, [threadsQuery.data, threadsQuery.dataUpdatedAt, currentId]);

  // Workspace-change invalidator. When the user opens a different
  // folder, the threads list's metadata (workspace_path / name)
  // is stale until the next reconcile — drives the brief flash
  // where projects-section briefly shows the wrong folder. Force
  // a refetch immediately so the user lands on the right project
  // group within one round-trip instead of waiting for staleTime.
  //
  // exact:true is critical — Query does PREFIX matching by default,
  // so `queryKey: ['threads']` would also invalidate every
  // `['threads', :id, 'messages']` query. That tanked the active
  // chat's history on every folder open (messages refetched and
  // overwrote the streaming blocks). Scope it to just the list.
  useEffect(() => {
    if (!authed) return;
    void queryClient.invalidateQueries({
      queryKey: qk.threads,
      exact: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.path]);

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

  const switchThread = useCallback(
    (id: string) => {
      setCurrentId(id);
      // Tie workspace to the thread. The thread's workspacePath is
      // canonical — every send POSTs paths against it, every diff
      // resolves against it, every bash runs in it. Letting the
      // active workspace drift away from the loaded thread leads to
      // "the agent wrote to /test/app while the UI's workspace was
      // /other and the file tree showed nothing" confusion the user
      // was hitting in practice. Now: pick a thread, get its workspace.
      const list = queryClient.getQueryData<ThreadSummary[]>(qk.threads);
      const t = list?.find((x) => x.id === id);
      if (t?.workspacePath && t.workspacePath !== workspace?.path) {
        const ws: Workspace = {
          path: t.workspacePath,
          name: t.workspaceName ?? t.workspacePath.split('/').pop() ?? 'project',
        };
        setWorkspace(ws);
        setCurrentWorkspace(ws);
      } else if (!t?.workspacePath && workspace) {
        // Thread has no workspace (pure chat) — clear active so
        // file/bash tools fail loudly instead of silently writing
        // into the previously-open folder.
        setWorkspace(null);
        setCurrentWorkspace(null);
      }
    },
    [workspace?.path],
  );

  // Optimistic delete via Query mutation — sidebar updates the
  // moment the user clicks; cache rolls back if the network errors.
  // Server-side is already a soft-delete (sets deletedAt; row stays
  // for audit + accidental-undo until a retention cron hard-deletes).
  // Subsequent GET /v1/threads filters by isNull(deletedAt), so the
  // refetch on settle never resurrects the row.
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
      // Clear the engine-mode sessionId mapping for this thread so
      // (a) settings storage doesn't leak entries forever, and
      // (b) if a stale UI somehow reopens the deleted threadId we
      // don't keep trying to rehydrate via its old session_id.
      // Best-effort, fire-and-forget — the import is async because
      // the engine module is desktop-only (Tauri shell).
      void (async () => {
        try {
          const { clearClaudeSessionId } = await import(
            './lib/engines/claude-code'
          );
          clearClaudeSessionId(id);
        } catch {
          // legacy / web — module not loaded, nothing to clear
        }
      })();
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

  // ChatSurface reports back when a turn lands. Title strategy:
  //   1. Synchronous: derive a quick title from the user's first
  //      prompt to drop the "New chat" placeholder instantly.
  //   2. Async, gated: only call the LLM-summarizer on the FIRST
  //      turn AND on log-spaced turn counts (3, 7, 15, 30, 60).
  //      Conversations evolve gradually; refreshing the title on
  //      every turn was wasteful + caused visible churn.
  //   3. Persist via PATCH /v1/threads/:id metadata so the title
  //      survives across devices, cache wipes, and the qcode-web
  //      tab — without local cache being load-bearing.
  // Skipped when titleSource === 'user' (manual rename in the
  // future).
  const onTurnLanded = useCallback(
    (info: {
      userText: string | null;
      threadId: string;
      assistantSeq: number | null;
    }) => {
      const list =
        queryClient.getQueryData<ThreadSummary[]>(qk.threads) ?? [];
      const existing = list.find((s) => s.id === info.threadId);
      const patch: Partial<ThreadSummary> = { updatedAt: Date.now() };
      const hadDefaultTitle = existing?.title === 'New chat' || !existing?.title;
      if (hadDefaultTitle && info.userText) {
        patch.title = titleFromPrompt(info.userText);
        patch.titleSource = 'auto';
      }
      patchThread(info.threadId, patch);
      void invalidateBalance();

      if (existing?.titleSource === 'user') return;

      // Turn-count from the assistant's seq: turn 1 = seq 2, turn
      // 2 = seq 4, etc. (user prompts are odd, assistant responses
      // even). Falls back to "treat as first turn" when seq is
      // null (legacy worker — better to over-regen once than to
      // never regen).
      const turnCount = info.assistantSeq
        ? Math.ceil(info.assistantSeq / 2)
        : 1;
      const REGEN_AT = new Set([1, 3, 7, 15, 30, 60, 120]);
      // Always regen when we still have the placeholder title —
      // covers the case where an earlier regen failed (network).
      const shouldRegen = hadDefaultTitle || REGEN_AT.has(turnCount);
      if (!shouldRegen) return;

      void (async () => {
        // Cached messages query already holds the latest server
        // history (we read from it everywhere); no extra fetch
        // needed in the common case.
        const cached = queryClient.getQueryData<RemoteThreadHistory>(
          qk.threadMessages(info.threadId),
        );
        let messages = cached?.messages ?? [];
        if (!messages.length) {
          // Engine-mode threads (claude-code) persist server-side
          // under claude's session_id, NOT the qcode threadId. The
          // legacy fetch by threadId returns empty for those, so
          // title-gen silently never fires for engine threads.
          // Mirror the rehydrate fallback used in ChatSurface:
          // try the session_id first if we have one mapped, fall
          // back to threadId.
          const { getClaudeSessionId } = await import(
            './lib/engines/claude-code'
          );
          const sessionId = getClaudeSessionId(info.threadId);
          const fetchKey = sessionId || info.threadId;
          messages = (await getRemoteThreadMessages(fetchKey)).messages;
        }
        if (!messages.length) return;
        const generated = await generateThreadTitle(messages);
        if (!generated) return;
        // Bail if user manually edited between kickoff + now.
        const fresh =
          queryClient.getQueryData<ThreadSummary[]>(qk.threads) ?? [];
        const row = fresh.find((s) => s.id === info.threadId);
        if (row?.titleSource === 'user') return;
        patchThread(info.threadId, {
          title: generated,
          titleSource: 'auto',
        });
        // Persist server-side fire-and-forget. Failure is harmless
        // (local cache still has the new title); next attempt
        // will retry. The PATCH only updates metadata.title; the
        // workspace_path/name fields server-side are preserved
        // by the merge in handlePatchThread.
        void updateThreadMetadata(info.threadId, { title: generated }).catch(
          (e) => {
            console.warn(
              `[title-gen] PATCH /v1/threads/${info.threadId} failed:`,
              e,
            );
          },
        );
      })();
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
        case 'rail_tasks':
        case 'rail_plan':
        case 'rail_files':
        case 'rail_terminal':
        case 'rail_preview':
        case 'rail_diff': {
          // Strip the rail_ prefix to get the RightRailView slug.
          // Toggle: pressing the same shortcut twice closes the rail.
          const view = id.slice('rail_'.length) as RightRailView;
          setRightRailView((prev) => (prev === view ? null : view));
          break;
        }
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
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        rightRailView={rightRailView}
        onPickRightRailView={(v) =>
          setRightRailView((prev) => (prev === v ? null : v))
        }
      />

      <div className="relative flex flex-1 overflow-hidden">
        {/* Scrim — only renders + intercepts taps when the drawer is
         *  open on narrow widths. md+ never sees it. */}
        {sidebarOpen && (
          <button
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
            className="absolute inset-0 z-30 bg-black/30 backdrop-blur-sm md:hidden"
          />
        )}
        {/* Mobile: off-canvas drawer that overlays content (z-40 +
         *  absolute). Desktop md+: in-flow column that animates its
         *  WIDTH to 0 when collapsed, so chat surface gets the
         *  reclaimed space. translate-x and width animate together
         *  for a clean slide-out feel. */}
        <div
          className={cn(
            'absolute inset-y-0 left-0 z-40 w-72 max-w-[85vw] transform transition-transform duration-200 md:static md:max-w-none md:transition-[width,transform] md:duration-200',
            sidebarOpen
              ? 'translate-x-0 md:w-64'
              : '-translate-x-full md:w-0 md:overflow-hidden md:-translate-x-full',
          )}
        >
          <Sidebar
            workspace={workspace}
            threads={threads}
            currentThreadId={currentId}
            onClose={() => setSidebarOpen(false)}
            onOpenFolder={async () => {
              closeSidebarIfMobile();
              const w = await tryOpenFolder();
              if (w) setWorkspace(w);
            }}
            onNewChat={() => {
              closeSidebarIfMobile();
              void newThread();
            }}
            onPickThread={(id) => {
              closeSidebarIfMobile();
              switchThread(id);
            }}
            onDeleteThread={removeThread}
          />
        </div>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background/85 backdrop-blur-sm">
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
            rightRailView={rightRailView}
            onCloseRightRail={() => setRightRailView(null)}
            workspacePath={workspace?.path}
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
  rightRailView,
  onPickRightRailView,
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
  rightRailView?: RightRailView | null;
  onPickRightRailView?: (v: RightRailView) => void;
}) {
  return (
    <header
      data-tauri-drag-region
      className="titlebar relative z-50 flex h-11 items-center justify-between border-b border-border/40 bg-background/40 px-3 backdrop-blur-md"
    >
      {/* pl-16 leaves clearance for macOS traffic-light buttons.
       *  On mobile/web we lose the traffic-lights and pick up a
       *  hamburger that toggles the off-canvas sidebar.
       *
       *  data-tauri-drag-region propagates from the header so
       *  empty space inside this div drags the window. Interactive
       *  children that should NOT drag (buttons, links) have to
       *  opt out explicitly via data-tauri-drag-region={false}. */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 md:pl-16"
      >
        {onToggleSidebar && (
          // Visible on every breakpoint now — desktop users get the
          // same toggle the mobile drawer uses to re-open a
          // collapsed sidebar. Mirrors the right-rail toggle pattern.
          <button
            type="button"
            aria-label="Toggle sidebar"
            onClick={onToggleSidebar}
            className="no-drag grid h-8 w-8 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Menu className="h-4 w-4" />
          </button>
        )}
        {/* Canonical qlaud monogram — dark q with red period accent.
            Same source as qlaud.ai/icon.svg. The wordmark + alpha
            badge that used to sit beside it has been dropped: the
            mark alone reads as the qlaud product surface, the
            "alpha" disclaimer lives in the footer / settings. */}
        <QlaudMark className="h-5 w-5 rounded shadow-sm" />
        <span className="hidden text-sm font-semibold tracking-tight sm:inline">
          qcode
        </span>
        {workspaceName && (
          <>
            <span className="mx-2 hidden text-muted-foreground/60 md:inline">/</span>
            <span className="hidden truncate text-xs text-muted-foreground md:inline">
              {workspaceName}
            </span>
          </>
        )}
      </div>

      {/* Explicit drag target for the empty middle space. Tauri 2's
       *  data-tauri-drag-region heuristic is finicky on macOS when
       *  combined with transparent: true + titleBarStyle: Overlay —
       *  users report the window not moving even though drag-region
       *  is wired on the header. This element calls startDragging()
       *  directly on mousedown which bypasses the heuristic and
       *  always works. flex-1 makes it expand to fill all middle
       *  space between the left controls and the right controls. */}
      <div
        className="h-full flex-1 cursor-grab active:cursor-grabbing"
        data-tauri-drag-region
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          // Lazy import — desktop-only API, web build doesn't have it.
          void (async () => {
            try {
              const { getCurrentWindow } = await import(
                '@tauri-apps/api/window'
              );
              await getCurrentWindow().startDragging();
            } catch {
              // not running in Tauri (web build) — drag is irrelevant
            }
          })();
        }}
      />

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
        {onPickRightRailView && (
          <RightRailMenu
            active={rightRailView ?? null}
            onPick={onPickRightRailView}
          />
        )}
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
  onClose,
}: {
  workspace: Workspace | null;
  threads: ThreadSummary[];
  currentThreadId: string | null;
  onOpenFolder: () => void;
  onNewChat: () => void;
  onPickThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  /** Optional close-button handler — when provided renders an X
   *  in the top-right of the sidebar that hides the panel. Mirrors
   *  the right-rail's close affordance. */
  onClose?: () => void;
}) {
  // Two-tier filter:
  //   1. Instant: title-substring match runs on every keystroke for
  //      sub-frame feedback. Auto-generated titles often miss what
  //      the user actually remembers about the thread, but it's
  //      free and fast.
  //   2. Semantic: 250ms after the user stops typing, hit qlaud's
  //      /v1/search endpoint which embeds the query and runs k-NN
  //      against every indexed turn (user + final-assistant). The
  //      hits ride alongside title-matches, deduped by thread_id,
  //      score-sorted. This is what makes "find that conversation
  //      where we discussed X" actually work.
  const [filter, setFilter] = useState('');
  const filterTrimmed = filter.trim();
  const filterLc = filterTrimmed.toLowerCase();
  const [semanticHits, setSemanticHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!filterTrimmed) {
      setSemanticHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const ac = new AbortController();
    const timer = setTimeout(() => {
      void searchThreads(filterTrimmed, { signal: ac.signal, limit: 20 }).then(
        (hits) => {
          setSemanticHits(dedupeByThread(hits));
          setSearching(false);
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      ac.abort();
      setSearching(false);
    };
  }, [filterTrimmed]);

  // Compose visible threads:
  //  - When no filter: all threads, default order.
  //  - With filter: union of (title substring matches) ∪ (semantic
  //    hits resolved to threads), sorted with semantic-hit threads
  //    first by score, title-matches after by recency. Excerpts
  //    from semantic hits attach as a per-thread "snippet" so the
  //    user gets a content preview, not just a row.
  const matches = (t: ThreadSummary) =>
    !filterLc || t.title.toLowerCase().includes(filterLc);
  let visibleThreads: ThreadSummary[];
  let snippetByThread: Map<string, string> | null = null;
  if (!filterLc) {
    visibleThreads = threads;
  } else {
    const titleMatches = threads.filter(matches);
    const titleMatchIds = new Set(titleMatches.map((t) => t.id));
    const semanticThreads = semanticHits
      .map((h) => threads.find((t) => t.id === h.thread_id))
      .filter((t): t is ThreadSummary => !!t && !titleMatchIds.has(t.id));
    visibleThreads = [...semanticThreads, ...titleMatches];
    snippetByThread = new Map(
      semanticHits.map((h) => [h.thread_id, h.snippet]),
    );
  }

  return (
    <aside className="flex h-full w-full flex-col border-r border-border/40 bg-muted/30 backdrop-blur-sm">
      {/* Close button mirrors the right-rail's X. Sits at the very
       *  top-right of the sidebar; hidden when no onClose handler
       *  is wired (e.g. an embedded use). */}
      {onClose && (
        <div className="flex justify-end px-2 pt-2">
          <button
            type="button"
            aria-label="Close sidebar"
            onClick={onClose}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className={cn('space-y-2 px-3', onClose ? 'pt-1' : 'pt-3')}>
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
        <WorkspacesSection
          threads={visibleThreads}
          currentThreadId={currentThreadId}
          activeWorkspacePath={workspace?.path ?? null}
          onPick={onPickThread}
          onDelete={onDeleteThread}
          snippetByThread={snippetByThread}
        />
        <div>
          <div className="flex items-baseline justify-between px-2 pb-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            <span>Chats</span>
            {searching && (
              <span className="text-[9px] normal-case tracking-normal text-muted-foreground/70">
                Searching…
              </span>
            )}
          </div>
          <ThreadList
            threads={visibleThreads.filter((t) => !t.workspacePath)}
            currentId={currentThreadId}
            onPick={onPickThread}
            onDelete={onDeleteThread}
            snippetByThread={snippetByThread}
          />
          {filterLc && !searching && visibleThreads.length === 0 && (
            <p className="px-2 py-2 text-[11px] leading-relaxed text-muted-foreground">
              No matches for &ldquo;{filter}&rdquo;. Tip: try keywords
              from the conversation, not just the title.
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
        // 16px on mobile to dodge iOS Safari's focus-zoom; collapses
        // to 12.5px at sm where the keyboard isn't a concern.
        className="ml-2 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-[12.5px]"
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
function WorkspacesSection({
  threads,
  currentThreadId,
  activeWorkspacePath,
  onPick,
  onDelete,
  snippetByThread,
}: {
  threads: ThreadSummary[];
  currentThreadId: string | null;
  activeWorkspacePath: string | null;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  snippetByThread?: Map<string, string> | null;
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
        Workspaces
      </div>
      <ul className="space-y-2">
        {sorted.map(([path, g]) => (
          <WorkspaceGroup
            key={path}
            name={g.name}
            threads={g.threads}
            isActive={path === activeWorkspacePath}
            currentThreadId={currentThreadId}
            onPick={onPick}
            onDelete={onDelete}
            snippetByThread={snippetByThread}
          />
        ))}
      </ul>
    </div>
  );
}

function WorkspaceGroup({
  name,
  threads,
  isActive,
  currentThreadId,
  onPick,
  onDelete,
  snippetByThread,
}: {
  name: string;
  threads: ThreadSummary[];
  isActive: boolean;
  currentThreadId: string | null;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  snippetByThread?: Map<string, string> | null;
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
            snippetByThread={snippetByThread}
          />
        </div>
      </div>
    </li>
  );
}

// Titlebar dropdown that picks which view the right rail shows.
// Codex's pattern: one button (PanelRight icon), opens a small menu
// with all the workbench surfaces — Tasks, Plan, Files, Terminal,
// Preview, Diff. Each entry is a single click; clicking the active
// one again closes the panel. Keyboard shortcuts mirror Codex
// (⇧⌘P, ⇧⌘D, etc.) via useShortcuts in the host.
function RightRailMenu({
  active,
  onPick,
}: {
  active: RightRailView | null;
  onPick: (v: RightRailView) => void;
}) {
  const [open, setOpen] = useState(false);
  // Close on outside click — single-click open is the lightest
  // affordance; we don't want a heavier portal-based menu.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const target = e.target as Element | null;
      if (!target?.closest('[data-rightrail-menu]')) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const entries: Array<{
    view: RightRailView;
    label: string;
    hint?: string;
  }> = [
    { view: 'tasks', label: 'Tasks' },
    { view: 'plan', label: 'Plan' },
    { view: 'files', label: 'Files', hint: '⇧⌘F' },
    { view: 'terminal', label: 'Terminal', hint: '⌃`' },
    { view: 'preview', label: 'Preview', hint: '⇧⌘P' },
    { view: 'diff', label: 'Diff', hint: '⇧⌘D' },
  ];

  return (
    <div className="relative" data-rightrail-menu>
      <button
        aria-label="Toggle right panel"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'grid h-7 w-7 place-items-center rounded transition-colors',
          active
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
        title="Open workbench panel"
      >
        <PanelRight className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-50 w-52 overflow-hidden rounded-lg border border-border/60 bg-background/95 shadow-xl backdrop-blur-md"
        >
          <ul className="py-1">
            {entries.map((e) => (
              <li key={e.view}>
                <button
                  role="menuitem"
                  onClick={() => {
                    onPick(e.view);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] transition-colors',
                    active === e.view
                      ? 'bg-muted/60 text-foreground'
                      : 'text-foreground/85 hover:bg-muted/40',
                  )}
                >
                  <span>{e.label}</span>
                  {e.hint && (
                    <span className="text-[10.5px] tabular-nums text-muted-foreground">
                      {e.hint}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
