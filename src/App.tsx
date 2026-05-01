import { useEffect, useState } from 'react';
import { Sparkles, Plus, Settings, Wallet } from 'lucide-react';

import { DEFAULT_MODEL } from './lib/models';
import {
  clearAuth,
  getKey,
  getProfile,
  startSignIn,
  type Profile,
} from './lib/auth';
import { startDeepLinkListener } from './lib/deep-link';
import { ChatSurface } from './ui/ChatSurface';
import { ModelPicker } from './ui/ModelPicker';
import { SignInGate } from './ui/SignInGate';

export function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getKey()));
  const [profile, setProfile] = useState<Profile | null>(() => getProfile());
  const [model, setModel] = useState<string>(DEFAULT_MODEL);

  // Tauri deep-link listener. When the qlaud sign-in page redirects
  // back to qcode://auth?k=…, the host emits an event that we
  // capture here, persist to localStorage, and flip into authed.
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

  // Cross-window storage sync: useful in vite-dev mode when the
  // sign-in callback lands in a sibling tab.
  useEffect(() => {
    function onStorage() {
      setAuthed(Boolean(getKey()));
      setProfile(getProfile());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  if (!authed) {
    return <SignInGate onSignIn={() => startSignIn()} />;
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <Titlebar
        model={model}
        onModelChange={setModel}
        profile={profile}
        onSignOut={() => {
          clearAuth();
          setAuthed(false);
          setProfile(null);
        }}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex flex-1 flex-col">
          <ChatSurface model={model} />
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
  onSignOut,
}: {
  model: string;
  onModelChange: (slug: string) => void;
  profile: Profile | null;
  onSignOut: () => void;
}) {
  return (
    <header className="titlebar flex h-11 items-center justify-between border-b border-border/60 px-3">
      <div className="flex items-center gap-2 pl-16">
        <div className="grid h-5 w-5 place-items-center rounded bg-primary text-primary-foreground">
          <Sparkles className="h-3 w-3" />
        </div>
        <span className="text-sm font-semibold tracking-tight">qcode</span>
        <span className="ml-1 rounded-full border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
          alpha
        </span>
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
      className="flex items-center gap-1.5 rounded border border-border/60 bg-background px-2 py-1 text-[11px] tabular-nums text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
      title="Click to top up"
    >
      <Wallet className="h-3 w-3" />
      ${balance.toFixed(2)}
    </button>
  );
}

// ─── Sidebar (thread switcher, stub) ───────────────────────────────

function Sidebar() {
  return (
    <aside className="flex w-60 flex-col border-r border-border/60 bg-muted/20">
      <div className="px-3 pt-3">
        <button className="flex w-full items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm font-medium transition-colors hover:border-foreground/30">
          <span className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            New chat
          </span>
          <span className="text-[10px] text-muted-foreground">⌘N</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3 pt-4">
        <div className="px-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          Recent
        </div>
        <p className="mt-2 px-2 py-3 text-xs text-muted-foreground">
          No conversations yet.
        </p>
      </div>

      <div className="border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground">
        v0.1.0-alpha · powered by qlaud
      </div>
    </aside>
  );
}
