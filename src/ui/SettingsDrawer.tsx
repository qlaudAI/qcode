import { useEffect, useState } from 'react';
import {
  ExternalLink,
  Github,
  KeyRound,
  LogOut,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { MODELS } from '../lib/models';
import {
  getSettings,
  patchSettings,
  type Settings,
} from '../lib/settings';
import { clearAllThreads } from '../lib/threads';
import { openExternal } from '../lib/tauri';

// Slide-in drawer from the right. macOS preferences-style: a column
// of grouped sections, soft blur backdrop. Closing happens on Esc,
// clicking the scrim, or the X button.

type Props = {
  open: boolean;
  onClose: () => void;
  email: string | null;
  onSignOut: () => void;
  onClearedThreads: () => void;
};

export function SettingsDrawer({
  open,
  onClose,
  email,
  onSignOut,
  onClearedThreads,
}: Props) {
  const [settings, setSettings] = useState<Settings>(() => getSettings());

  // Re-hydrate when the drawer opens — covers cross-tab edits in
  // vite-dev where another tab might have saved.
  useEffect(() => {
    if (open) setSettings(getSettings());
  }, [open]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings(patchSettings({ [key]: value } as Partial<Settings>));
  }

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-40 bg-black/10 transition-opacity duration-200',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <aside
        role="dialog"
        aria-label="Settings"
        className={cn(
          'fixed right-0 top-0 z-50 h-dvh w-[420px] max-w-[90vw] border-l border-border/60 bg-background shadow-[0_8px_32px_rgba(0,0,0,0.12)] transition-transform duration-200',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <header className="flex h-12 items-center justify-between border-b border-border/60 px-4">
          <h2 className="text-sm font-semibold tracking-tight">Settings</h2>
          <button
            aria-label="Close settings"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="h-[calc(100dvh-3rem)] overflow-y-auto">
          <Section title="Account">
            <Row
              label="Signed in as"
              value={email || '—'}
              icon={<KeyRound className="h-3.5 w-3.5" />}
            />
            <button
              onClick={onSignOut}
              className="flex w-full items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm transition-colors hover:border-foreground/30"
            >
              <span className="flex items-center gap-2">
                <LogOut className="h-3.5 w-3.5 text-muted-foreground" />
                Sign out
              </span>
              <span className="text-[11px] text-muted-foreground">
                Clears keychain
              </span>
            </button>
          </Section>

          <Section title="Defaults">
            <FieldLabel>Default model for new chats</FieldLabel>
            <select
              value={settings.defaultModel}
              onChange={(e) => update('defaultModel', e.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30"
            >
              {MODELS.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.label} · {m.provider}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              You can still switch the model per-conversation from the title bar.
            </p>
          </Section>

          <Section title="Updates">
            <Toggle
              label="Auto-check for updates on launch"
              checked={settings.autoUpdate}
              onChange={(v) => update('autoUpdate', v)}
            />
            <p className="text-[11px] text-muted-foreground">
              Updates are signed and verified by your local Tauri public key.
              Only signed releases install.
            </p>
          </Section>

          <Section title="Conversations">
            <DangerButton
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label="Clear all conversations"
              hint="Deletes every saved chat from this device. Cannot be undone."
              onConfirm={() => {
                clearAllThreads();
                onClearedThreads();
              }}
            />
          </Section>

          <Section title="Privacy">
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              qcode never sends your code anywhere except qlaud, and only when a
              model call needs context. Tool calls (read_file, edit_file, bash)
              run locally on your machine. There is no telemetry, no usage
              analytics, and no error reporting beacon.
            </p>
          </Section>

          <Section title="About">
            <Row
              label="Version"
              value="0.1.0-alpha.4"
              icon={<Sparkles className="h-3.5 w-3.5" />}
            />
            <button
              onClick={() => openExternal('https://github.com/qlaudAI/qcode')}
              className="flex w-full items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm transition-colors hover:border-foreground/30"
            >
              <span className="flex items-center gap-2">
                <Github className="h-3.5 w-3.5 text-muted-foreground" />
                GitHub repository
              </span>
              <ExternalLink className="h-3 w-3 text-muted-foreground" />
            </button>
            <button
              onClick={() => openExternal('https://docs.qlaud.ai/qcode')}
              className="flex w-full items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm transition-colors hover:border-foreground/30"
            >
              <span className="flex items-center gap-2">
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                Documentation
              </span>
              <ExternalLink className="h-3 w-3 text-muted-foreground" />
            </button>
          </Section>
        </div>
      </aside>
    </>
  );
}

// ─── Building blocks ───────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2 border-b border-border/40 px-4 py-4 last:border-b-0">
      <h3 className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/30 px-3 py-2 text-sm">
      <span className="flex items-center gap-2 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="truncate font-mono text-[12px] text-foreground">
        {value}
      </span>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[12.5px] font-medium text-foreground">
      {children}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm transition-colors hover:border-foreground/30"
    >
      <span>{label}</span>
      <span
        className={cn(
          'relative h-4 w-7 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-muted',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-3 w-3 rounded-full bg-background shadow transition-transform',
            checked ? 'left-3.5' : 'left-0.5',
          )}
        />
      </span>
    </button>
  );
}

function DangerButton({
  icon,
  label,
  hint,
  onConfirm,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <button
      onClick={() => {
        if (confirming) {
          onConfirm();
          setConfirming(false);
        } else {
          setConfirming(true);
          setTimeout(() => setConfirming(false), 3000);
        }
      }}
      className={cn(
        'flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors',
        confirming
          ? 'border-primary/50 bg-primary/5 text-primary'
          : 'border-border bg-background hover:border-primary/40',
      )}
    >
      <span className="flex items-center gap-2">
        {icon}
        {confirming ? 'Click again to confirm' : label}
      </span>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </button>
  );
}
