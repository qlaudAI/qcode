import { useState } from 'react';
import { ChevronDown, ExternalLink, GitFork, Copy, Check, FolderGit2 } from 'lucide-react';

import type { Workspace } from '../lib/workspace';

/** Title-bar workspace badge — shows the active thread's workspace
 *  name and, on click, opens a small popover with:
 *    1. The GitLab project link (if the workspace is sandbox-backed
 *       — desktop workspaces omit this row).
 *    2. A "Fork to new chat in this workspace" action that mints a
 *       new thread reusing this workspace_id, so the new chat picks
 *       up the same /workspace state, the same GitLab repo, and the
 *       same prior turn history when the agent runs.
 *
 *  Why this exists: web's auto-provisioned workspaces are invisible
 *  by default. Users start a new chat → server creates a fresh
 *  sandbox → push to gitlab.com/qcode-users/<slug> → user has no
 *  idea their code lives somewhere they can browse or fork from.
 *  The badge surfaces that backing without forcing the desktop's
 *  "open folder" ceremony.
 *
 *  Desktop fall-through: the badge still renders for local-folder
 *  workspaces but drops the GitLab row. Fork action works the same
 *  way (creates a new thread linked to the same folder workspace),
 *  mirroring the sidebar's "new chat in this workspace" affordance. */
export function WorkspaceBadge({
  workspace,
  onFork,
}: {
  workspace: Workspace;
  /** Caller wires this to useCreateThreadMutation + setCurrentId
   *  in App.tsx. We close the popover here, but the navigation is
   *  the caller's responsibility. */
  onFork: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // qcode-web workspaces have gitlabProjectPath set when the server
  // emits qcode_persist with project_path. Desktop workspaces never
  // do — they're folders on disk, not git repos by default.
  const gitlabPath = workspace.gitlabProjectPath ?? null;
  const gitlabUrl = gitlabPath ? `https://gitlab.com/${gitlabPath}` : null;

  async function copyLink() {
    if (!gitlabUrl) return;
    try {
      await navigator.clipboard.writeText(gitlabUrl);
      setCopied(true);
      // Reset after a beat so the user gets the affordance flash
      // without us having to track it across re-mounts.
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silently skip; the link is still visible */
    }
  }

  async function fork() {
    setOpen(false);
    await onFork();
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-tauri-drag-region="false"
        className="no-drag hidden items-center gap-1.5 rounded border border-transparent px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:border-border/60 hover:bg-background/70 hover:text-foreground md:flex"
        title={
          gitlabPath
            ? `Workspace: ${workspace.name} · saved to gitlab.com/${gitlabPath}`
            : `Workspace: ${workspace.name}`
        }
        aria-label="Workspace details"
      >
        <FolderGit2 className="h-3 w-3 shrink-0 text-muted-foreground/80" />
        <span className="max-w-[160px] truncate">{workspace.name}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
      </button>

      {open && (
        <>
          {/* Outside-click scrim — same pattern ModelPicker uses.
           *  z below the popover, above everything else on the page. */}
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="menu"
            className="absolute left-0 z-40 mt-1.5 w-72 overflow-hidden rounded-lg border border-border bg-background shadow-lg"
          >
            <div className="border-b border-border/40 bg-muted/30 px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                Workspace
              </div>
              <div className="mt-0.5 truncate text-sm font-medium text-foreground">
                {workspace.name}
              </div>
            </div>

            {gitlabUrl && (
              <div className="border-b border-border/40 px-3 py-2">
                <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                  Saved to
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <a
                    href={gitlabUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/85 underline-offset-2 hover:underline"
                    title={gitlabUrl}
                  >
                    gitlab.com/{gitlabPath}
                  </a>
                  <button
                    type="button"
                    onClick={copyLink}
                    className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    title="Copy link"
                    aria-label="Copy GitLab link"
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-emerald-500" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                  <a
                    href={gitlabUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    title="Open on gitlab.com"
                    aria-label="Open GitLab project"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground/80">
                  Every turn's changes are committed and pushed here
                  automatically. Clone it locally to keep working on
                  your own machine.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={fork}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground transition-colors hover:bg-muted"
              role="menuitem"
            >
              <GitFork className="h-3.5 w-3.5 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div>Fork to new chat in this workspace</div>
                <div className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
                  Same /workspace, same GitLab repo, fresh
                  conversation. The agent picks up where this chat
                  left off.
                </div>
              </div>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
