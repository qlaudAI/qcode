import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Plus, Settings, Sparkles, Wallet } from 'lucide-react';

import {
  clearAuth,
  getKey,
  getProfile,
  startSignIn,
  type Profile,
} from './lib/auth';
import { startDeepLinkListener } from './lib/deep-link';
import { DEFAULT_MODEL } from './lib/models';
import { useShortcuts, type MenuId } from './lib/shortcuts';
import {
  getCurrentWorkspace,
  openFolderPicker,
  setCurrentWorkspace,
  type Workspace,
} from './lib/workspace';
import { ChatSurface } from './ui/ChatSurface';
import { FileTree } from './ui/FileTree';
import { ModelPicker } from './ui/ModelPicker';
import { SignInGate } from './ui/SignInGate';

export function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getKey()));
  const [profile, setProfile] = useState<Profile | null>(() => getProfile());
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [workspace, setWorkspace] = useState<Workspace | null>(() =>
    getCurrentWorkspace(),
  );
  const [chatNonce, setChatNonce] = useState(0);

  // Deep-link listener: qcode://auth?k=… from the qlaud sign-in flow.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    startDeepLinkListener(() => {
      setAuthed(true);
      setProfile(getProfile());
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

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

  // Single source of truth for native-menu + keyboard shortcuts.
  const onMenu = useCallback(
    async (id: MenuId) => {
      switch (id) {
        case 'new_chat':
          // Forces a fresh ChatSurface mount, dumping prior history.
          setChatNonce((n) => n + 1);
          break;
        case 'open_folder': {
          const w = await openFolderPicker();
          if (w) setWorkspace(w);
          break;
        }
        case 'preferences':
          // TODO(phase-2): open the settings pane in a side drawer.
          // For now, surface the dashboard as the closest equivalent.
          window.open('https://qlaud.ai/dashboard', '_blank', 'noopener');
          break;
        case 'sign_out':
          await clearAuth();
          setCurrentWorkspace(null);
          setAuthed(false);
          setProfile(null);
          setWorkspace(null);
          break;
        case 'command_palette':
          // Phase 2 stub. Visible no-op so the shortcut doesn't drop
          // silently; once the palette ships, swap this for setOpen(true).
          break;
        case 'model_picker':
          // Phase 2: focus the picker programmatically. For now, no-op.
          break;
      }
    },
    [],
  );
  useShortcuts(onMenu);

  if (!authed) {
    return <SignInGate onSignIn={() => startSignIn()} />;
  }

  return (
    <div className="flex h-dvh flex-col text-foreground">
      <Titlebar
        model={model}
        onModelChange={setModel}
        profile={profile}
        workspaceName={workspace?.name}
        onSignOut={async () => {
          await clearAuth();
          setCurrentWorkspace(null);
          setAuthed(false);
          setProfile(null);
          setWorkspace(null);
        }}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          workspace={workspace}
          onOpenFolder={async () => {
            const w = await openFolderPicker();
            if (w) setWorkspace(w);
          }}
          onNewChat={() => setChatNonce((n) => n + 1)}
        />
        <main className="flex flex-1 flex-col bg-background/85 backdrop-blur-sm">
          <ChatSurface key={chatNonce} model={model} />
        </main>
      </div>
    </div>
  );
}

// ─── Title bar ──────────────────────────────────────────────────────

function Titlebar({
  model,
  onModelChange,
  profile,
  workspaceName,
  onSignOut,
}: {
  model: string;
  onModelChange: (slug: string) => void;
  profile: Profile | null;
  workspaceName?: string;
  onSignOut: () => void;
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
        <SpendBar profile={profile} />
        <button
          aria-label="Settings"
          className="grid h-7 w-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={onSignOut}
          title={profile?.email ? `${profile.email} — click to sign out` : 'Sign out'}
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}

function SpendBar({ profile }: { profile: Profile | null }) {
  if (!profile) return null;
  const balance = profile.balance_usd ?? 0;
  return (
    <button
      className="flex items-center gap-1.5 rounded border border-border/60 bg-background/70 px-2 py-1 text-[11px] tabular-nums text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
      title="Click to top up"
    >
      <Wallet className="h-3 w-3" />
      ${balance.toFixed(2)}
    </button>
  );
}

// ─── Sidebar ────────────────────────────────────────────────────────

function Sidebar({
  workspace,
  onOpenFolder,
  onNewChat,
}: {
  workspace: Workspace | null;
  onOpenFolder: () => void;
  onNewChat: () => void;
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

      <div className="flex-1 overflow-y-auto px-2 pb-3 pt-4">
        {workspace ? (
          <>
            <div className="px-2 pb-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              {workspace.name}
            </div>
            <FileTree rootPath={workspace.path} />
          </>
        ) : (
          <div className="px-2 pt-2">
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
