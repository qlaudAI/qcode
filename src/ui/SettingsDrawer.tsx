import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  Github,
  KeyRound,
  LogOut,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { useMcpServersQuery, useTextModels } from '../lib/queries';
import { ripgrepInstallHint, ripgrepSource } from '../lib/ripgrep';
import {
  getSettings,
  patchSettings,
  type Settings,
} from '../lib/settings';
import {
  clearCachedSummaries,
  deleteRemoteThread,
  loadCachedSummaries,
} from '../lib/threads';
import { isTauri, openExternal } from '../lib/tauri';

// Slide-in drawer from the right. macOS preferences-style: a column
// of grouped sections, soft blur backdrop. Closing happens on Esc,
// clicking the scrim, or the X button.

type Props = {
  open: boolean;
  onClose: () => void;
  email: string | null;
  onSignOut: () => void;
  onClearedThreads: () => void;
  /** Re-fetch /v1/account. Triggered automatically on open so the
   *  email row never gets stuck at "—" because the boot-time call
   *  raced sign-in or hit a transient network error. */
  onRefreshAccount?: () => Promise<void> | void;
};

export function SettingsDrawer({
  open,
  onClose,
  email,
  onSignOut,
  onClearedThreads,
  onRefreshAccount,
}: Props) {
  const [settings, setSettings] = useState<Settings>(() => getSettings());
  // Live model list — same source the title-bar picker reads from
  // so the Settings dropdowns never disagree with what's selectable.
  // useTextModels falls back to bundled MODELS when the catalog
  // hasn't loaded yet, so this is safe before the network lands.
  const models = useTextModels();

  // Re-hydrate when the drawer opens — covers cross-tab edits in
  // vite-dev where another tab might have saved. Also kick off an
  // /v1/account refresh so the "Signed in as" row catches up if the
  // boot-time call missed (e.g. webview cache, race with sign-in).
  useEffect(() => {
    if (open) {
      setSettings(getSettings());
      void onRefreshAccount?.();
    }
  }, [open, onRefreshAccount]);

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
              {models.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.label} · {m.provider}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              You can still switch the model per-conversation from the title bar.
            </p>

            <FieldLabel>Default mode for new chats</FieldLabel>
            <select
              value={settings.mode}
              onChange={(e) =>
                update('mode', e.target.value as 'agent' | 'plan')
              }
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="agent">Agent — full toolkit (write, edit, bash)</option>
              <option value="plan">Plan — read-only, propose changes in prose</option>
            </select>
            <p className="text-[11px] text-muted-foreground">
              The title-bar Agent / Plan toggle overrides this for the
              current session.
            </p>

            <FieldLabel>
              {isTauri() ? 'Background model' : 'Subagent model'}
            </FieldLabel>
            <select
              value={settings.subagentModel ?? '__parent__'}
              onChange={(e) =>
                update(
                  'subagentModel',
                  e.target.value === '__parent__' ? null : e.target.value,
                )
              }
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="__parent__">Same as default (no override)</option>
              {models.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.label} · {m.provider} · {m.tier}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              {isTauri() ? (
                <>
                  Drives Claude Code&rsquo;s background calls — title
                  generation, summarization, internal planning helpers.
                  Pairing your main pick with a cheap model here (e.g.
                  Sonnet + Haiku, GPT-5.4 + GPT-5.4 mini) saves ~3–5×
                  on those tokens with no quality hit on the main agent.
                </>
              ) : (
                <>
                  The <span className="font-mono">task</span> tool spawns
                  a subagent for bounded scout work (find files, summarize
                  a module). Pick a cheap model here to keep subagent
                  fan-out from running up the bill — the parent stays on
                  whatever you picked above.
                </>
              )}
            </p>
          </Section>

          <Section title="Appearance">
            <FieldLabel>Theme</FieldLabel>
            <div className="flex gap-1.5 rounded-md border border-border bg-background p-1">
              {(['system', 'light', 'dark'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => update('theme', t)}
                  className={cn(
                    'flex-1 rounded px-2 py-1 text-[12px] font-medium capitalize transition-colors',
                    settings.theme === t
                      ? 'bg-foreground text-background'
                      : 'text-foreground/70 hover:bg-muted',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground/80">System</span>{' '}
              follows your OS dark-mode preference (and tracks live
              if you flip it). <span className="font-medium text-foreground/80">Light</span>{' '}
              and <span className="font-medium text-foreground/80">Dark</span>{' '}
              lock the palette regardless of the OS setting.
            </p>
          </Section>

          {/* Engine picker — hidden on desktop. With alpha.110
           *  closing every qlaud /v1/messages translation gap,
           *  Claude Code is the single engine and works for all 12
           *  catalog models. There's no useful choice to expose.
           *  Web doesn't get a picker either — it always routes
           *  through qlaud's /v1/threads/:id/messages (server-side
           *  LLM, browser as thin client). The Engine setting still
           *  exists in localStorage for downgrade safety; it's just
           *  no longer user-configurable. */}

          <Section title="Auto-approve">
            <div className="flex gap-1.5 rounded-md border border-border bg-background p-1">
              {(
                [
                  { value: 'yolo', label: 'YOLO' },
                  { value: 'smart', label: 'Smart' },
                  { value: 'strict', label: 'Strict' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => update('autoApprove', opt.value)}
                  className={cn(
                    'flex-1 rounded px-2 py-1 text-[12px] font-medium transition-colors',
                    settings.autoApprove === opt.value
                      ? 'bg-foreground text-background'
                      : 'text-foreground/70 hover:bg-muted',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground/80">YOLO</span>{' '}
              auto-approves every write + every shell command — even
              ones outside the safe whitelist. Use when you trust the
              agent and rely on git as your undo. Hard deny-list (
              <span className="font-mono">rm -rf /</span>,{' '}
              <span className="font-mono">sudo</span>,{' '}
              <span className="font-mono">curl | sh</span>) still
              applies. <span className="font-medium text-foreground/80">Smart</span>{' '}
              (default) auto-approves workspace writes + safe-bash
              whitelist (<span className="font-mono">ls</span>,{' '}
              <span className="font-mono">pnpm test</span>,{' '}
              <span className="font-mono">git status</span>); prompts
              for anything destructive or background jobs.{' '}
              <span className="font-medium text-foreground/80">Strict</span>{' '}
              prompts for every write and every command.
            </p>
          </Section>

          <Section title="Auto-commit">
            <Toggle
              label="Commit each agent turn to git"
              checked={settings.autoCommit}
              onChange={(v) => update('autoCommit', v)}
            />
            <p className="text-[11px] text-muted-foreground">
              When on, qcode runs <span className="font-mono">git add -A &amp;&amp; git commit</span> on
              your current branch after every agent turn that wrote
              files. Author is set to{' '}
              <span className="font-mono">qcode &lt;bot@qlaud.ai&gt;</span>{' '}
              so you can filter agent commits from manual ones. Skipped
              when the working tree was already dirty before the turn
              (won't mix your WIP), during merges/rebases, or on
              detached HEAD. <strong>Never pushes</strong> — that
              stays your call.
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

          <Section title="Search performance">
            <RipgrepStatus />
          </Section>

          {/* Connectors toggle — drives qcode-legacy's qlaud_runtime
           *  meta-tools loop. With Claude Code as the desktop engine,
           *  MCP servers are configured natively in
           *  ~/.claude/settings.json; this toggle does nothing on
           *  desktop. We hide it there to avoid suggesting it has an
           *  effect. Web (qcode-legacy path) still uses it. */}
          {!isTauri() && (
            <Section title="Connectors">
              <Toggle
                label="Use qlaud connectors (MCP)"
                checked={settings.enableConnectors}
                onChange={(v) => update('enableConnectors', v)}
              />
              {/* Active-connector readout — only fetches when the
               *  toggle is on, so toggling off doesn't burn a network
               *  call. Shows the user what's actually loaded into
               *  their agent's tool surface on the next send. */}
              <McpConnectorStatus enabled={settings.enableConnectors} />
              <p className="text-[11px] text-muted-foreground">
                Lets the model discover + call MCP servers you connected on{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void openExternal('https://qlaud.ai/tools');
                  }}
                  className="text-foreground/85 underline decoration-border hover:decoration-foreground/60"
                >
                  qlaud.ai/tools
                </a>
                . When enabled, qcode adds 4 discovery tools alongside the
                7 local ones — same approval flow for any write action.
              </p>
            </Section>
          )}

          <Section title="Conversations">
            <DangerButton
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label="Clear all conversations"
              hint="Deletes every saved chat from this device. Cannot be undone."
              onConfirm={async () => {
                // Delete every remote thread we know about, then
                // wipe the local cache. Failures per-row are
                // tolerated (a stale row left server-side will get
                // pruned the next time the user explicitly deletes
                // it; the cache is already gone).
                const ids = loadCachedSummaries().map((s) => s.id);
                await Promise.allSettled(
                  ids.map((id) => deleteRemoteThread(id)),
                );
                clearCachedSummaries();
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
  onConfirm: () => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <button
      onClick={() => {
        if (confirming) {
          void onConfirm();
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

// Active-connector readout for the Connectors section. Fetches
// /v1/mcp-servers only when the toggle is on, so toggling off does
// not pay a network round-trip for data that's about to be ignored.
// Shows the user a quick "what's loaded?" answer without leaving
// qcode — registration / disconnect still happen at qlaud.ai/tools,
// but the visibility loop closes here.
//
// Display states:
//   - toggle off       → nothing (the toggle copy already explains it)
//   - loading          → "Checking your connectors…"
//   - error            → muted error chip (don't block the section)
//   - 0 registered     → CTA-shaped link to register
//   - N registered     → "N active" + name chips, max 6 visible,
//                        overflow collapsed into "+K more"
function McpConnectorStatus({ enabled }: { enabled: boolean }) {
  const { data, isLoading, error } = useMcpServersQuery(enabled);
  if (!enabled) return null;
  if (isLoading) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Checking your connectors…
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Couldn&rsquo;t reach qlaud right now — your connectors will still
        attach on the next send if registration is current.
      </p>
    );
  }
  const servers = data ?? [];
  if (servers.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border/70 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        No connectors registered yet. Browse{' '}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            void openExternal('https://qlaud.ai/tools');
          }}
          className="font-medium text-foreground/85 underline decoration-border hover:decoration-foreground/60"
        >
          qlaud.ai/tools
        </a>{' '}
        to add Linear, GitHub, Stripe, and 100+ others.
      </div>
    );
  }
  const MAX_CHIPS = 6;
  const visible = servers.slice(0, MAX_CHIPS);
  const overflow = servers.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium text-foreground/80">
        {servers.length} active:
      </span>
      {visible.map((s) => (
        <span
          key={s.id}
          className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-foreground/85"
          title={`${s.name} — ${s.tools_cached} tools`}
        >
          {chipLabel(s.name)}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground"
          title={servers
            .slice(MAX_CHIPS)
            .map((s) => s.name)
            .join(', ')}
        >
          +{overflow} more
        </span>
      )}
    </div>
  );
}

// Server names look like "qlaud-mcp/linear" (catalog slug pattern)
// or whatever the user passed when registering a raw URL. Trim the
// catalog prefix so chips read cleanly: "linear" not "qlaud-mcp/linear".
// Title-case the result so "github" renders as "Github" — close enough
// to the brand for a chip without a full lookup table.
function chipLabel(rawName: string): string {
  const stripped = rawName.replace(/^qlaud-mcp\//, '').replace(/[-_]/g, ' ');
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

// Detection-state pill + per-platform install hint for ripgrep.
// When `rg` is on PATH, the existing JS walker for glob/grep gets
// replaced by ripgrep — 10-50× faster on large repos. Most users
// already have it (VS Code ships it) but we still nudge the
// missing case so they're not silently stuck on the slow path.
function RipgrepStatus() {
  const [source, setSource] = useState<
    'sidecar' | 'system' | null | 'pending'
  >('pending');
  const [hint, setHint] = useState<{
    command: string | null;
    url: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([ripgrepSource(), ripgrepInstallHint()]).then(
      ([s, h]) => {
        if (cancelled) return;
        setSource(s);
        setHint(h);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  if (source === 'pending') {
    return (
      <p className="text-[12px] text-muted-foreground">Detecting ripgrep…</p>
    );
  }
  if (source === 'sidecar' || source === 'system') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
        <Zap className="h-3.5 w-3.5 text-emerald-600" />
        <span className="text-[12px] text-foreground/85">
          {source === 'sidecar'
            ? 'ripgrep bundled — fast path always on.'
            : 'ripgrep on PATH — fast path on. (qcode also bundles a copy starting in alpha.12+ so you can uninstall yours if you want.)'}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
        <div className="flex-1 text-[12px] text-foreground/85">
          ripgrep not detected. Falling back to a slower JS walker for
          glob/grep — fine on small repos, noticeably slower on big
          ones (typically 10-50× the search time).
        </div>
      </div>
      {hint?.command && (
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded border border-border/60 bg-background/70 px-2 py-1 font-mono text-[11px] text-foreground/85">
            {hint.command}
          </code>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(hint.command!);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                // clipboard blocked — fall through silently
              }
            }}
            className="grid h-6 w-6 place-items-center rounded border border-border bg-background text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            aria-label="Copy install command"
            title="Copy"
          >
            {copied ? (
              <Check className="h-3 w-3 text-emerald-600" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
      )}
      {hint?.url && (
        <button
          onClick={() => void openExternal(hint.url)}
          className="self-start text-[11px] text-muted-foreground underline decoration-border hover:decoration-foreground/60 hover:text-foreground"
        >
          {hint.command
            ? 'or install via another package manager'
            : 'pick the right package manager for your distro'}{' '}
          ↗
        </button>
      )}
      <p className="mt-0.5 text-[10.5px] text-muted-foreground">
        After installing, reopen qcode for detection to refresh.
      </p>
    </div>
  );
}
