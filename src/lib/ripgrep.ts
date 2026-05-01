// Optional ripgrep acceleration for the grep + glob tools.
//
// The hand-rolled walker in tools.ts works fine for small repos, but
// on a 10K-file monorepo it can take seconds where ripgrep returns
// in milliseconds. ripgrep is also installed almost everywhere a
// developer's machine has Tauri running (it ships with VS Code,
// fzf, etc. and is in Homebrew/scoop/apt by default for many distros).
//
// Strategy: detect once per session. If `rg --version` succeeds, route
// runGlob and runGrep through ripgrep. Otherwise fall back to the
// existing JS walker. The model sees the same input/output shape
// either way — the tool description doesn't change, only the
// underlying speed.
//
// .gitignore handling is a bonus: ripgrep respects .gitignore + .ignore
// by default, so we drop our matcher entirely when rg drives the search.
// That keeps behavior consistent (rg's gitignore is the canonical one
// users expect) and saves the matcher round-trip.

import { getPlatform, isTauri } from './tauri';

type RgSource = 'sidecar' | 'system' | null;
let detectionCache: Promise<RgSource> | null = null;

async function makeRgCommand(
  args: string[],
  cwd?: string,
): Promise<import('@tauri-apps/plugin-shell').Command<string>> {
  const { Command } = await import('@tauri-apps/plugin-shell');
  // Prefer the bundled sidecar — it's the version we tested against
  // and ships at a known path. System rg falls back when the sidecar
  // isn't present (older alpha builds, dev mode without bundling).
  const source = await detectRipgrep();
  if (source === 'sidecar') {
    return Command.sidecar('binaries/rg', args, cwd ? { cwd } : undefined);
  }
  return Command.create('rg', args, cwd ? { cwd } : undefined);
}

async function detectRipgrep(): Promise<RgSource> {
  if (!isTauri()) return null;
  if (detectionCache) return detectionCache;
  detectionCache = (async () => {
    const { Command } = await import('@tauri-apps/plugin-shell');
    // Try the bundled sidecar first.
    try {
      const r = await Command.sidecar('binaries/rg', ['--version']).execute();
      if (r.code === 0) return 'sidecar' as const;
    } catch {
      // Sidecar missing in this build — fall through.
    }
    // Then system PATH.
    try {
      const r = await Command.create('rg', ['--version']).execute();
      if (r.code === 0) return 'system' as const;
    } catch {
      // Neither available — caller falls back to JS walker.
    }
    return null;
  })();
  return detectionCache;
}

/** Cheap runtime detection. True if rg is available either as the
 *  bundled sidecar or on the user's PATH. Cached. */
export async function hasRipgrep(): Promise<boolean> {
  return (await detectRipgrep()) !== null;
}

/** Where the active rg came from — 'sidecar' (bundled), 'system'
 *  (user's PATH), or null (not available). UI uses this to show
 *  "bundled" vs "from PATH" in Settings. */
export async function ripgrepSource(): Promise<RgSource> {
  return detectRipgrep();
}

/** Reset for tests / re-detection after install. Not currently called
 *  in the normal flow but exported so a "Refresh" command could
 *  invalidate the cache. */
export function resetRipgrepDetection(): void {
  detectionCache = null;
}

/** One-line install command for the user's platform. Settings UI
 *  shows this with a copy button when ripgrep is missing. Returns
 *  null when we can't make a confident recommendation (Linux distros
 *  vary too much; the Linux hint links the user to ripgrep's docs
 *  instead of guessing apt vs dnf vs pacman). */
export async function ripgrepInstallHint(): Promise<{
  command: string | null;
  url: string;
} | null> {
  const platform = await getPlatform();
  if (platform === 'macos') {
    return { command: 'brew install ripgrep', url: 'https://github.com/BurntSushi/ripgrep#installation' };
  }
  if (platform === 'windows') {
    return {
      command: 'winget install BurntSushi.ripgrep.MSVC',
      url: 'https://github.com/BurntSushi/ripgrep#installation',
    };
  }
  if (platform === 'linux') {
    // No single command works across distros — surface the URL so
    // the user picks the right package manager themselves.
    return {
      command: null,
      url: 'https://github.com/BurntSushi/ripgrep#installation',
    };
  }
  return null;
}

export type RgGlobResult = { files: string[]; truncated: boolean };

/** List files matching a glob pattern, workspace-relative paths only.
 *  ripgrep treats the pattern as a glob via -g. We use --files to
 *  list every non-ignored file and then -g to filter. Identical
 *  semantics to our walker but ~10-50× faster on big repos. */
export async function rgGlob(opts: {
  workspace: string;
  pattern: string;
  max: number;
}): Promise<RgGlobResult> {
  // --files emits one path per matching file (relative to cwd).
  // -g GLOB filters to paths matching the glob.
  // --hidden includes dotfiles the user might want (e.g. .github/),
  //   still respecting .gitignore / .ignore.
  const args = ['--files', '--hidden', '-g', opts.pattern];
  const cmd = await makeRgCommand(args, opts.workspace);
  const out = await cmd.execute();
  if (out.code !== 0 && out.code !== 1) {
    // 0 = matches found; 1 = no matches; anything else is real error.
    throw new Error(`ripgrep glob failed (${out.code}): ${out.stderr.slice(0, 200)}`);
  }
  const all = out.stdout.split('\n').filter((s) => s.length > 0);
  if (all.length <= opts.max) return { files: all, truncated: false };
  return { files: all.slice(0, opts.max), truncated: true };
}

export type RgGrepHit = { path: string; line: number; content: string };
export type RgGrepResult = { hits: RgGrepHit[]; truncated: boolean };

/** Content search. Returns line-level hits in the same format the
 *  existing grep tool emits (path:line:content). */
export async function rgGrep(opts: {
  workspace: string;
  rootRel: string; // workspace-relative root, '.' for whole workspace
  pattern: string;
  fileGlob: string | null;
  caseInsensitive: boolean;
  max: number;
  maxFileBytes: number;
}): Promise<RgGrepResult> {
  const args = [
    '-n', // line numbers
    '--no-heading',
    '--color=never',
    `--max-filesize=${opts.maxFileBytes}`,
    `--max-count=${opts.max}`, // per-file cap; we still trim globally below
  ];
  if (opts.caseInsensitive) args.push('-i');
  if (opts.fileGlob) args.push('-g', opts.fileGlob);
  // Hidden-but-not-ignored, mirroring rgGlob.
  args.push('--hidden');
  args.push('--', opts.pattern, opts.rootRel);

  const cmd = await makeRgCommand(args, opts.workspace);
  const out = await cmd.execute();
  if (out.code !== 0 && out.code !== 1) {
    throw new Error(`ripgrep grep failed (${out.code}): ${out.stderr.slice(0, 200)}`);
  }

  const lines = out.stdout.split('\n').filter((s) => s.length > 0);
  const hits: RgGrepHit[] = [];
  for (const raw of lines) {
    if (hits.length >= opts.max) break;
    const parsed = parseRgLine(raw);
    if (parsed) hits.push(parsed);
  }
  const truncated = hits.length >= opts.max && lines.length > opts.max;
  return { hits, truncated };
}

/** Parse one line of `rg -n` output: "path:line:content".
 *  The colon is the only separator we care about; content can
 *  itself contain colons (URLs, etc.) so we only split on the first
 *  two. Returns null on malformed lines. */
function parseRgLine(line: string): RgGrepHit | null {
  const i1 = line.indexOf(':');
  if (i1 === -1) return null;
  const i2 = line.indexOf(':', i1 + 1);
  if (i2 === -1) return null;
  const path = line.slice(0, i1);
  const lineNumStr = line.slice(i1 + 1, i2);
  const lineNum = Number.parseInt(lineNumStr, 10);
  if (!Number.isFinite(lineNum)) return null;
  const content = line.slice(i2 + 1);
  return { path, line: lineNum, content };
}
