// Persistent bottom status strip — VS Code / Cursor-style. Surfaces
// the at-a-glance state that's annoying to look up: active workspace,
// git branch, model, mode, qlaud connection, app version. Tight
// vertical footprint (24px) so it doesn't eat chat real estate.
//
// Scope decisions:
//
//   - Read-only. No interactive controls beyond "click branch chip
//     to copy", "click version to open release notes". Everything
//     mutable (model, mode) lives in the title bar where users
//     already reach for it. Putting duplicate controls in two places
//     teaches users which is canonical, which is wasted training.
//
//   - Idempotent re-renders. Each chip pulls its own data via the
//     same hooks/queries used elsewhere — no prop drilling for a
//     surface that just observes.
//
//   - Pure-chat / no-workspace: workspace + branch chips collapse
//     gracefully. Model + mode + connection + version stay visible
//     so the bar still has weight.

import { useEffect, useState } from 'react';
import {
  CircleDot,
  Folder,
  GitBranch,
  Wifi,
  WifiOff,
  Wrench,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { useGitBranch } from '../lib/git-branch';
import { useTextModels } from '../lib/queries';
import type { AgentMode } from '../lib/settings';
import { openExternal } from '../lib/tauri';
import type { Workspace } from '../lib/workspace';

type Props = {
  workspace: Workspace | null;
  model: string;
  mode: AgentMode;
  /** App version — read from import.meta.env at the top of App.tsx
   *  and threaded down so this component doesn't have its own
   *  Vite-specific runtime read. */
  appVersion: string;
};

export function StatusBar({ workspace, model, mode, appVersion }: Props) {
  const branch = useGitBranch(workspace?.path ?? null);
  const online = useOnlineStatus();
  const models = useTextModels();
  const modelEntry = models.find((m) => m.slug === model);
  return (
    <footer
      role="contentinfo"
      className="flex h-6 shrink-0 items-center gap-3 border-t border-border/40 bg-muted/30 px-3 text-[11px] text-muted-foreground backdrop-blur-sm"
    >
      {/* Left cluster — workspace context */}
      <div className="flex min-w-0 items-center gap-3">
        {workspace ? (
          <>
            <Chip icon={Folder} title={workspace.path}>
              <span className="max-w-[160px] truncate text-foreground/85">
                {workspace.name}
              </span>
            </Chip>
            {branch && (
              <Chip
                icon={GitBranch}
                title={`Click to copy: ${branch}`}
                onClick={() => {
                  void navigator.clipboard.writeText(branch);
                }}
                className="cursor-pointer transition-colors hover:text-foreground"
              >
                <span className="max-w-[140px] truncate font-mono">{branch}</span>
              </Chip>
            )}
          </>
        ) : (
          <Chip icon={Folder} title="No workspace open">
            <span className="text-muted-foreground/70">no workspace</span>
          </Chip>
        )}
      </div>

      {/* Spacer — push the right cluster to the edge */}
      <div className="ml-auto" />

      {/* Right cluster — runtime state + identity */}
      <div className="flex shrink-0 items-center gap-3">
        <Chip icon={Wrench} title={`Model: ${modelEntry?.label ?? model}`}>
          <span className="text-foreground/85">
            {modelEntry?.label ?? model}
          </span>
        </Chip>
        <ModeChip mode={mode} />
        <ConnectionChip online={online} />
        <button
          type="button"
          onClick={() => {
            void openExternal(
              'https://github.com/qlaudAI/qcode/releases',
            );
          }}
          title="View release notes"
          className="text-muted-foreground/80 transition-colors hover:text-foreground"
        >
          v{appVersion}
        </button>
      </div>
    </footer>
  );
}

// Generic chip — icon + content. Shared visual language across the
// bar so all the cells read as part of one strip rather than
// individually-styled blobs.
function Chip({
  icon: Icon,
  children,
  title,
  onClick,
  className,
}: {
  icon: typeof Folder;
  children: React.ReactNode;
  title?: string;
  onClick?: () => void;
  className?: string;
}) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      className={cn(
        'flex min-w-0 items-center gap-1.5 leading-none',
        className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground/70" />
      {children}
    </Tag>
  );
}

// Mode chip — Agent vs Plan. Plan mode has a distinct posture
// (read-only tools, prose-only) so a small visual cue keeps users
// oriented when they switch and forget.
function ModeChip({ mode }: { mode: AgentMode }) {
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider leading-none',
        mode === 'plan'
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
          : 'bg-primary/10 text-primary',
      )}
      title={
        mode === 'plan'
          ? 'Plan mode — read-only tools'
          : 'Agent mode — full toolkit'
      }
    >
      <CircleDot className="h-2.5 w-2.5" />
      {mode}
    </span>
  );
}

// Connection chip — online means the qlaud edge is reachable. The
// browser's `navigator.onLine` is best-effort (it only flips on
// network-stack-level events) but it's enough to surface the obvious
// "you're offline" state. False positives (online flag set, qlaud
// itself down) shouldn't render a green dot — the distinction is
// what the user sees when sends start failing, and we let those
// errors carry the specifics.
function ConnectionChip({ online }: { online: boolean }) {
  if (!online) {
    return (
      <Chip
        icon={WifiOff}
        title="Offline — sends will fail until you reconnect"
        className="text-rose-600 dark:text-rose-400"
      >
        offline
      </Chip>
    );
  }
  return (
    <Chip icon={Wifi} title="Online — qlaud reachable">
      <span className="sr-only">online</span>
      <span aria-hidden className="text-emerald-600/80 dark:text-emerald-400/80">
        ●
      </span>
    </Chip>
  );
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  // Tauri's webview reports `online` correctly via the navigator
  // object; nothing extra needed there. (Future expansion: ping-
  // based qlaud reachability check to distinguish "network up,
  // qlaud down" from a true offline.)
  return online;
}
