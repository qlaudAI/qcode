// Per-turn auto-commit. When the user has autoCommit on, qcode
// captures whether the working tree was clean at turn start and,
// at turn end, commits the agent's changes on the user's current
// branch with a synthesized message. The author is set to
// `qcode <bot@qlaud.ai>` so `git log --author='^(?!qcode)' --perl-regexp`
// (or just visual inspection) cleanly separates manual vs. agent work.
//
// Why no auto-stash for pre-existing dirty trees: stashing the user's
// in-progress work and popping it after introduces a class of failures
// (pop conflicts, stash entries leaking into git stash list, dropped
// stashes if pop fails). The honest path is to NOT auto-commit when
// the tree wasn't clean — the user already had their hand on the
// wheel; we don't take it.
//
// Why no auto-push: pushing is a remote action with social weight
// (forks people's CI, can trigger reviews, can be force-pushed). The
// user retains control of every push. Auto-commit only.

import { isTauri } from './tauri';

const COMMIT_AUTHOR = 'qcode <bot@qlaud.ai>';

export type Snapshot = {
  /** Was the workspace a git repo at the start of this turn? */
  isGitRepo: boolean;
  /** Did `git status --porcelain` return empty before the turn? Auto-
   *  commit only fires when this is true; otherwise we'd mix the
   *  user's WIP into the agent's commit. */
  cleanAtStart: boolean;
  /** Was the repo in a special state (merge / rebase / cherry-pick /
   *  bisect / detached HEAD) at start? Skip auto-commit either way. */
  specialState: boolean;
};

export type CheckpointResult =
  | { kind: 'committed'; sha: string; message: string; filesChanged: number }
  | { kind: 'skipped'; reason: string };

/** Read whether the workspace can take an auto-commit cleanly. Cheap
 *  — three short shell calls. Cached only by the caller; we don't
 *  cache here so re-running between turns sees fresh state. */
export async function snapshot(workspace: string): Promise<Snapshot> {
  if (!isTauri()) {
    return { isGitRepo: false, cleanAtStart: false, specialState: false };
  }
  try {
    const { exists } = await import('@tauri-apps/plugin-fs');
    const gitDir = `${workspace}/.git`;
    if (!(await exists(gitDir))) {
      return { isGitRepo: false, cleanAtStart: false, specialState: false };
    }
    // Special-state files inside .git that mean a merge/rebase/cherry-
    // pick/bisect is in progress. Auto-committing during any of these
    // confuses git's state machine and we'd inherit the bug.
    const specialFiles = [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'BISECT_LOG',
      'rebase-merge',
      'rebase-apply',
    ];
    let specialState = false;
    for (const f of specialFiles) {
      if (await exists(`${gitDir}/${f}`)) {
        specialState = true;
        break;
      }
    }
    if (specialState) {
      return { isGitRepo: true, cleanAtStart: false, specialState: true };
    }
    // Detached HEAD: HEAD points at a SHA, not a ref. We catch that
    // here so the commit step doesn't blindly create a dangling
    // commit on a SHA the user can't easily get back to.
    const head = await readGitHead(workspace);
    if (head.detached) {
      return { isGitRepo: true, cleanAtStart: false, specialState: true };
    }
    const dirty = await runGitPorcelain(workspace);
    return {
      isGitRepo: true,
      cleanAtStart: dirty === '',
      specialState: false,
    };
  } catch {
    return { isGitRepo: false, cleanAtStart: false, specialState: false };
  }
}

/** Commit the agent's changes from this turn, given the start-of-turn
 *  snapshot. No-op + reason returned when the preconditions weren't
 *  met. Caller decides what to render in the UI. */
export async function commitTurn(args: {
  workspace: string;
  snapshot: Snapshot;
  /** Short, user-visible summary of what the turn did. First line is
   *  the commit subject; we'll prefix it with `qcode: ` for filtering. */
  summary: string;
  /** Optional body — files-changed list, model, thread id. Goes after
   *  a blank line in the commit message. */
  body?: string;
}): Promise<CheckpointResult> {
  if (!isTauri()) return { kind: 'skipped', reason: 'browser-mode' };
  const { isGitRepo, cleanAtStart, specialState } = args.snapshot;
  if (!isGitRepo) return { kind: 'skipped', reason: 'not a git repo' };
  if (specialState) {
    return { kind: 'skipped', reason: 'merge/rebase/detached state' };
  }
  if (!cleanAtStart) {
    return {
      kind: 'skipped',
      reason: 'working tree was already dirty before this turn',
    };
  }

  // Quick check: did anything actually change? If the agent took a
  // pure-read turn (or all writes failed), don't bother making a
  // zero-diff commit. `git status --porcelain` returns empty on a
  // truly clean tree.
  const dirtyAfter = await runGitPorcelain(args.workspace);
  if (dirtyAfter === '') {
    return { kind: 'skipped', reason: 'no file changes this turn' };
  }
  const filesChanged = dirtyAfter
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean).length;

  const subject = sanitizeSubject(args.summary);
  const message = args.body
    ? `qcode: ${subject}\n\n${args.body}`
    : `qcode: ${subject}`;

  // Stage all (including untracked + deletions). The path-jail in
  // tools.ts already prevented edits outside workspace, so `git add -A`
  // here is scoped to the open folder by virtue of cwd. Author is
  // overridden so manual log filtering works without changing the
  // user's git config.
  const { Command } = await import('@tauri-apps/plugin-shell');
  const add = await Command.create('bash', ['-c', 'git add -A'], {
    cwd: args.workspace,
  }).execute();
  if (add.code !== 0) {
    return { kind: 'skipped', reason: `git add failed: ${add.stderr.trim()}` };
  }
  // -m takes the message verbatim; pass via env-var-style heredoc
  // through bash to avoid shell-escaping the user-provided summary.
  // GIT_AUTHOR_NAME/EMAIL override this commit's author without
  // mutating the user's `git config user.name`.
  const escaped = message.replace(/'/g, "'\\''");
  const commitCmd = [
    "GIT_AUTHOR_NAME='qcode'",
    "GIT_AUTHOR_EMAIL='bot@qlaud.ai'",
    "GIT_COMMITTER_NAME='qcode'",
    "GIT_COMMITTER_EMAIL='bot@qlaud.ai'",
    `git commit -m '${escaped}' --author='${COMMIT_AUTHOR}'`,
  ].join(' ');
  const commit = await Command.create('bash', ['-c', commitCmd], {
    cwd: args.workspace,
  }).execute();
  if (commit.code !== 0) {
    return {
      kind: 'skipped',
      reason: `git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`,
    };
  }
  // Read back the just-created sha so the UI can render a clickable
  // chip. rev-parse HEAD is the cheapest way; --short=8 matches the
  // length the composer's branch chip uses.
  const sha = await Command.create('bash', ['-c', 'git rev-parse --short=8 HEAD'], {
    cwd: args.workspace,
  })
    .execute()
    .then((r) => r.stdout.trim())
    .catch(() => '');

  return {
    kind: 'committed',
    sha,
    message: subject,
    filesChanged,
  };
}

// ─── Internals ────────────────────────────────────────────────────

async function runGitPorcelain(workspace: string): Promise<string> {
  const { Command } = await import('@tauri-apps/plugin-shell');
  const r = await Command.create('bash', ['-c', 'git status --porcelain'], {
    cwd: workspace,
  })
    .execute()
    .catch(() => null);
  if (!r || r.code !== 0) return '';
  return r.stdout.trim();
}

async function readGitHead(workspace: string): Promise<{ detached: boolean }> {
  try {
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const head = (await readTextFile(`${workspace}/.git/HEAD`)).trim();
    return { detached: !head.startsWith('ref: ') };
  } catch {
    return { detached: false };
  }
}

/** Trim and de-newline a free-form summary into a single commit
 *  subject. Caps at 72 chars (git convention). Empty input falls
 *  back to a generic label so we never produce an empty subject. */
function sanitizeSubject(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  const fallback = 'agent turn';
  const subject = oneLine || fallback;
  return subject.length > 72 ? subject.slice(0, 69) + '...' : subject;
}
