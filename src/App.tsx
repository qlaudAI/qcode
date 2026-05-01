import { useEffect, useState } from 'react';
import { Sparkles, Plus, ArrowUp, Settings, Wallet } from 'lucide-react';

import { cn } from './lib/cn';
import { DEFAULT_MODEL, MODELS } from './lib/models';
import {
  clearAuth,
  getKey,
  getProfile,
  startSignIn,
  type Profile,
} from './lib/auth';
import { ModelPicker } from './ui/ModelPicker';
import { SignInGate } from './ui/SignInGate';

export function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getKey()));
  const [profile, setProfile] = useState<Profile | null>(() => getProfile());
  const [model, setModel] = useState<string>(DEFAULT_MODEL);

  // Watch storage events so the deep-link callback (writes to local
  // storage from a sibling window/process) flips us into authed state.
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
        {/* The pl-16 leaves room for macOS traffic-light buttons. */}
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

// ─── Sidebar (thread switcher) ─────────────────────────────────────

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
        <div className="mt-2 space-y-1">
          {[].map((_t, i) => (
            <button
              key={i}
              className="block w-full truncate rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            />
          ))}
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No conversations yet.
          </p>
        </div>
      </div>

      <div className="border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground">
        v0.1.0-alpha · powered by qlaud
      </div>
    </aside>
  );
}

// ─── Chat surface ──────────────────────────────────────────────────

function ChatSurface({ model }: { model: string }) {
  const m = MODELS.find((x) => x.slug === model);
  const [input, setInput] = useState('');

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
          <Sparkles className="h-5 w-5" />
        </div>
        <h2 className="mt-6 text-2xl font-semibold tracking-tight">
          What should we build?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Connected to{' '}
          <span className="font-medium text-foreground">
            {m?.label ?? model}
          </span>
          {' · '}
          {m?.provider}
        </p>

        <div className="mt-10 grid w-full max-w-2xl gap-2 text-left">
          {[
            'Open the qcode repo and explain the agentic loop',
            'Refactor the auth flow into a hook',
            'Find and fix any flaky tests',
            'Run the test suite and triage failures',
          ].map((s) => (
            <button
              key={s}
              onClick={() => setInput(s)}
              className="rounded-lg border border-border bg-background px-4 py-3 text-sm text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <Composer value={input} onChange={setInput} model={model} />
    </div>
  );
}

function Composer({
  value,
  onChange,
  model,
}: {
  value: string;
  onChange: (v: string) => void;
  model: string;
}) {
  const m = MODELS.find((x) => x.slug === model);
  return (
    <div className="border-t border-border/60 px-4 py-4">
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            'rounded-2xl border border-border bg-background shadow-sm transition-shadow',
            'focus-within:border-foreground/20 focus-within:shadow-md',
          )}
        >
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Describe what you want to build…"
            rows={2}
            className="block w-full resize-none rounded-2xl bg-transparent px-4 py-3 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between border-t border-border/40 px-3 py-2">
            <span className="text-[11px] text-muted-foreground">
              {m?.label ?? model} · ⌘↵ to send
            </span>
            <button
              disabled={!value.trim()}
              className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              aria-label="Send"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
