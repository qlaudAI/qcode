import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Plus, Settings, Sparkles, Wallet } from 'lucide-react';

import {
  clearAuth,
  getKey,
  getProfile,
  setProfile as persistProfile,
  startSignIn,
  type Profile,
} from './lib/auth';
import { fetchBalance } from './lib/billing';
import { startDeepLinkListener } from './lib/deep-link';
import { getSettings, patchSettings } from './lib/settings';
import { useShortcuts, type MenuId } from './lib/shortcuts';
import {
  createThread,
  deleteThread as deleteThreadStorage,
  getThread,
  listThreads,
  saveThread,
  type ThreadSummary,
} from './lib/threads';
import {
  getCurrentWorkspace,
  openFolderPicker,
  setCurrentWorkspace,
  type Workspace,
} from './lib/workspace';
import type { Message } from './lib/qlaud-client';
import { ChatSurface } from './ui/ChatSurface';
import { FileTree } from './ui/FileTree';
import { ModelPicker } from './ui/ModelPicker';
import { SettingsDrawer } from './ui/SettingsDrawer';
import { SignInGate } from './ui/SignInGate';
import { ThreadList } from './ui/ThreadList';

export function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getKey()));
  const [profile, setProfile] = useState<Profile | null>(() => getProfile());
  const [model, setModel] = useState<string>(() => getSettings().defaultModel);
  const [workspace, setWorkspace] = useState<Workspace | null>(() =>
    getCurrentWorkspace(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Persist when the user picks a new default. We update the user's
  // current view immediately (setModel) and stash the choice as the
  // default for future "New chat" sessions. The title-bar dropdown
  // doubles as both per-session switcher and global default-setter
  // — picking a model is a strong signal of intent.
  const onModelChange = useCallback((slug: string) => {
    setModel(slug);
    patchSettings({ defaultModel: slug });
  }, []);

  const handleSignOut = useCallback(async () => {
    await clearAuth();
    setCurrentWorkspace(null);
    setAuthed(false);
    setProfile(null);
    setWorkspace(null);
    setSettingsOpen(false);
  }, []);

  // Threads. The sidebar lists summaries; the chat surface gets the
  // active thread's full history. Switching threads remounts
  // ChatSurface (cheap — no in-flight request to abort here since the
  // old chat's busy state lived inside its own component).
  const [threads, setThreads] = useState<ThreadSummary[]>(() => listThreads());
  const [currentId, setCurrentId] = useState<string | null>(
    () => listThreads()[0]?.id ?? null,
  );
  const currentThread = currentId ? getThread(currentId) : null;

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

  // Thread mutations. We keep the localStorage layer authoritative
  // and re-derive the in-memory list after each change so summaries
  // (titles, updatedAt) stay in lockstep.
  const refreshThreads = useCallback(() => {
    setThreads(listThreads());
  }, []);

  const newThread = useCallback(() => {
    const t = createThread(model);
    refreshThreads();
    setCurrentId(t.id);
  }, [model, refreshThreads]);

  const switchThread = useCallback((id: string) => {
    setCurrentId(id);
  }, []);

  const removeThread = useCallback(
    (id: string) => {
      deleteThreadStorage(id);
      const next = listThreads();
      setThreads(next);
      if (currentId === id) {
        setCurrentId(next[0]?.id ?? null);
      }
    },
    [currentId],
  );

  // Persist the active thread's history every time the chat surface
  // hands us a new turn. Auto-titles on first user message.
  const persistTurn = useCallback(
    (history: Message[]) => {
      const id = currentId;
      if (!id) return;
      const existing = getThread(id);
      if (!existing) return;
      saveThread({ ...existing, model, history });
      refreshThreads();
    },
    [currentId, model, refreshThreads],
  );

  // Single source of truth for native-menu + keyboard shortcuts.
  const onMenu = useCallback(
    async (id: MenuId) => {
      switch (id) {
        case 'new_chat':
          newThread();
          break;
        case 'open_folder': {
          const w = await openFolderPicker();
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
          // Phase 2 stub. No-op so the shortcut doesn't fire silently
          // into the void; swap this for setOpen(true) when the
          // palette lands.
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
    return <SignInGate onSignIn={() => startSignIn()} />;
  }

  return (
    <div className="flex h-dvh flex-col text-foreground">
      <Titlebar
        model={model}
        onModelChange={onModelChange}
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
            const w = await openFolderPicker();
            if (w) setWorkspace(w);
          }}
          onNewChat={newThread}
          onPickThread={switchThread}
          onDeleteThread={removeThread}
        />
        <main className="flex flex-1 flex-col bg-background/85 backdrop-blur-sm">
          <ChatSurface
            key={currentId ?? 'empty'}
            initialHistory={currentThread?.history ?? []}
            onTurnComplete={(history) => {
              if (!currentId) {
                // First turn → conjure a thread on demand. Catches
                // the post-sign-in case where the user types before
                // explicitly clicking New Chat.
                const t = createThread(model);
                saveThread({ ...t, history });
                refreshThreads();
                setCurrentId(t.id);
              } else {
                persistTurn(history);
              }
              void refreshBalance();
            }}
            model={model}
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
    </div>
  );
}

// ─── Title bar ──────────────────────────────────────────────────────

function Titlebar({
  model,
  onModelChange,
  profile,
  workspaceName,
  onRefreshBalance,
  onOpenSettings,
}: {
  model: string;
  onModelChange: (slug: string) => void;
  onRefreshBalance: () => void;
  profile: Profile | null;
  workspaceName?: string;
  onOpenSettings: () => void;
}) {
  return (
    <header className="titlebar flex h-11 items-center justify-between border-b border-border/40 bg-background/40 px-3 backdrop-blur-md">
      {/* pl-16 leaves clearance for macOS traffic-light buttons. */}
      <div className="flex items-center gap-2 pl-16">
        <div className="grid h-5 w-5 place-items-center rounded bg-primary text-primary-foreground shadow-sm">
          <Sparkles className="h-3 w-3" />
        </div>
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
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Open a folder to start. qcode reads only what you point it at —
              your filesystem stays private until you say otherwise.
            </p>
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
