// One-shot environment probe at workspace open.
//
// Without this, the model's first move on every fresh thread tends to
// be 4-5 bash calls along the lines of `node --version`, `which bun`,
// `git --version`, `which rg`. They're cheap, but they bloat the
// transcript, cost tokens, and add latency before the model can
// actually do useful work.
//
// We probe once per workspace per qcode session, cache the result,
// and inject it into the system prompt as a compact "Environment"
// block so the model already knows what's installed and at what
// version. CC ships a similar static block in its system prompt.
//
// Implementation note: probes run through the persistent bash
// session (lib/bash-session.ts) so PATH and shell init are honored —
// otherwise tools managed by nvm/fnm/asdf/mise that live in
// `~/.local/bin` or shell-init-time exports wouldn't show up.
// One pipelined command, parsed by sentinel.

import { runBashSession } from './bash-session';
import { ripgrepSource } from '../ripgrep';
import { getPlatform, isTauri } from '../tauri';

export type EnvSnapshot = {
  platform: 'macos' | 'linux' | 'windows' | 'unknown';
  arch: string;
  osVersion: string;
  workspace: string;
  /** Map from tool name to its --version output (first non-empty line)
   *  or null when the tool isn't installed / not on PATH. */
  tools: Record<string, string | null>;
  /** Where ripgrep came from. 'sidecar' = bundled with qcode;
   *  'system' = user's PATH; null = neither (slow JS walker active). */
  rg: 'sidecar' | 'system' | null;
  /** Git context for the workspace, when it's a git repo. Captured
   *  once per session (cached); stale only matters if the user
   *  switches branches mid-session — they can hit /reset to refresh. */
  git: {
    branch: string;
    /** True when there are uncommitted changes (`git status --porcelain`
     *  returned anything). The agent uses this to decide whether to
     *  warn before destructive operations or recommend committing
     *  first. */
    dirty: boolean;
    /** Last 3 commit subject lines, newest first. Gives the model
     *  recent-context awareness without bloating the prompt. */
    recentCommits: string[];
    /** `git remote get-url origin` value when present — lets the
     *  model link issues / PRs to the right repo without asking. */
    remote: string | null;
  } | null;
};

const PROBES = [
  { tool: 'node', cmd: 'node --version' },
  { tool: 'bun', cmd: 'bun --version' },
  { tool: 'pnpm', cmd: 'pnpm --version' },
  { tool: 'npm', cmd: 'npm --version' },
  { tool: 'python3', cmd: 'python3 --version' },
  { tool: 'git', cmd: 'git --version' },
  { tool: 'cargo', cmd: 'cargo --version' },
  { tool: 'go', cmd: 'go version' },
  { tool: 'docker', cmd: 'docker --version' },
];

const cache = new Map<string, Promise<EnvSnapshot>>();

export async function probeEnv(workspace: string): Promise<EnvSnapshot> {
  const cached = cache.get(workspace);
  if (cached) return cached;
  const p = doProbe(workspace);
  cache.set(workspace, p);
  return p;
}

export function clearEnvCache(workspace: string): void {
  cache.delete(workspace);
}

async function doProbe(workspace: string): Promise<EnvSnapshot> {
  const platform = await getPlatform();
  const tools: Record<string, string | null> = {};
  let arch = '';
  let osVersion = '';

  if (isTauri()) {
    try {
      const osMod = await import('@tauri-apps/plugin-os');
      arch = osMod.arch();
      osVersion = osMod.version();
    } catch {
      // best-effort; missing osMod just leaves these blank
    }

    // One pipelined command — each probe followed by a unique
    // sentinel so we can attribute the output even when one of the
    // earlier ones writes ambiguous text. Errors swallowed via
    // `2>/dev/null || true` so a missing tool doesn't bail the
    // entire chain.
    const lines = PROBES.map(
      (p) =>
        `( ${p.cmd} 2>/dev/null || true ); echo "__QCODE_PROBE_END_${p.tool}__"`,
    ).join('\n');
    try {
      const result = await runBashSession({
        workspace,
        command: lines,
        timeoutMs: 10_000,
      });
      const stdout = result.stdout;
      for (const p of PROBES) {
        const re = new RegExp(
          `([\\s\\S]*?)\\n?__QCODE_PROBE_END_${p.tool}__`,
          'm',
        );
        const m = stdout.match(re);
        if (!m) continue;
        const captured = (m[1] ?? '').trim();
        // Trim subsequent probes' output that might have crept in
        // before the sentinel.
        const firstLine = captured.split('\n')[0]?.trim() ?? '';
        tools[p.tool] = firstLine || null;
        // Each match consumes its prefix; remove it so the next
        // probe matches against the remaining tail.
        // (Using a non-stateful re via explicit slicing.)
      }
    } catch {
      // Probe failed entirely — leave tools empty; the system
      // prompt section will be skipped.
    }
  }

  const rg = await ripgrepSource();
  const git = isTauri() ? await probeGit(workspace) : null;
  return { platform, arch, osVersion, workspace, tools, rg, git };
}

/** Probe git context in a single pipelined bash call so the cost is
 *  one round-trip, not four. Sentinels separate each probe's output
 *  so we attribute lines correctly even when one of them errors out
 *  (e.g. no remote configured). Returns null when the workspace
 *  isn't a git repo. */
async function probeGit(
  workspace: string,
): Promise<EnvSnapshot['git']> {
  const cmd = [
    'git rev-parse --is-inside-work-tree 2>/dev/null || echo NOT_GIT',
    'echo __QCODE_GIT_BRANCH__',
    'git branch --show-current 2>/dev/null',
    'echo __QCODE_GIT_DIRTY__',
    'git status --porcelain 2>/dev/null | head -1',
    'echo __QCODE_GIT_LOG__',
    'git log -3 --pretty=format:%s 2>/dev/null',
    'echo __QCODE_GIT_REMOTE__',
    'git remote get-url origin 2>/dev/null || echo',
  ].join('\n');
  let stdout: string;
  try {
    const r = await runBashSession({ workspace, command: cmd, timeoutMs: 5_000 });
    stdout = r.stdout;
  } catch {
    return null;
  }
  if (!/__QCODE_GIT_BRANCH__/.test(stdout)) return null;
  const head = stdout.split('__QCODE_GIT_BRANCH__')[0] ?? '';
  if (head.includes('NOT_GIT')) return null;

  const after = stdout.split('__QCODE_GIT_BRANCH__')[1] ?? '';
  const [branchSection, dirtySection, logSection, remoteSection] =
    after.split(/__QCODE_GIT_DIRTY__|__QCODE_GIT_LOG__|__QCODE_GIT_REMOTE__/);
  const branch = (branchSection ?? '').trim() || 'HEAD';
  const dirty = !!(dirtySection ?? '').trim();
  const recentCommits = (logSection ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('__'));
  const remote = ((remoteSection ?? '').trim() || null) as string | null;
  return { branch, dirty, recentCommits, remote };
}

/** Compose the system-prompt section. Returns empty string when the
 *  probe yielded nothing — keeps callers from gating on truthiness. */
export function envSystemSection(env: EnvSnapshot | null): string {
  if (!env || env.platform === 'unknown') return '';
  const lines: string[] = [];
  const platformLabel =
    env.platform === 'macos'
      ? 'macOS'
      : env.platform === 'linux'
        ? 'Linux'
        : env.platform === 'windows'
          ? 'Windows'
          : env.platform;
  const platformLine =
    `${platformLabel}` +
    (env.osVersion ? ` ${env.osVersion}` : '') +
    (env.arch ? ` (${env.arch})` : '');
  lines.push(`Platform: ${platformLine}`);
  lines.push(`Workspace: ${env.workspace}`);

  const installedTools = Object.entries(env.tools).filter(
    ([, v]) => v && v.length > 0,
  );
  if (installedTools.length > 0) {
    const tools = installedTools.map(([name, v]) => `${name} ${v}`).join('  ');
    lines.push(`Detected tools: ${tools}`);
  }
  const missing = Object.entries(env.tools)
    .filter(([, v]) => !v)
    .map(([name]) => name);
  if (missing.length > 0) {
    lines.push(`Not on PATH: ${missing.join(', ')}`);
  }
  if (env.rg === 'sidecar') {
    lines.push('ripgrep: bundled (use freely for fast file search via grep/glob)');
  } else if (env.rg === 'system') {
    lines.push('ripgrep: system (fast file search active)');
  }

  if (env.git) {
    const gitBits: string[] = [`branch ${env.git.branch}`];
    if (env.git.dirty) gitBits.push('uncommitted changes present');
    else gitBits.push('clean working tree');
    if (env.git.remote) gitBits.push(`origin ${env.git.remote}`);
    lines.push(`Git: ${gitBits.join(' · ')}`);
    if (env.git.recentCommits.length > 0) {
      lines.push('Recent commits:');
      for (const c of env.git.recentCommits) lines.push(`  · ${c}`);
    }
    lines.push(
      'Git practice: when the user asks to "commit", "ship", or "push": stage with `git add <files>` (NOT `-A` — avoid sweeping in untracked secrets), write a present-tense subject under 72 chars, body in imperative voice. Match the recent-commit style above. Use `git status` + `git diff --stat` to verify scope before committing. NEVER force-push without explicit ask. NEVER `git commit --amend` on already-pushed commits unless the user confirms.',
    );
  }

  return `\n\n## Environment\n${lines.join('\n')}`;
}
