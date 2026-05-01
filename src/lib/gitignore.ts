// Minimal git-style ignore matcher.
//
// Hand-rolled to avoid pulling in the `ignore` npm package — the
// package is fine but it's another dep + bundle weight for what
// turns out to be ~80 LOC of regex assembly. Covers the common
// patterns; negation (`!foo`) is intentionally not supported in v0
// because it's rare in real repos and adds complexity that mostly
// pays off for `dist/!keep.txt`-style edge cases.
//
// Patterns we DO handle:
//   #comment          → skipped
//   blank line        → skipped
//   foo               → matches at any depth
//   foo/              → matches a directory at any depth
//   /foo              → matches at the root only
//   *.log             → glob anywhere
//   src/**/*.test.ts  → glob with directory traversal
//
// We always merge in a small base list of "things you'd never want
// scanned" (node_modules, .git, build outputs) so the matcher is
// useful even when a workspace lacks a .gitignore.

const BASE_IGNORES = [
  'node_modules/',
  '.git/',
  '.svn/',
  '.hg/',
  '.next/',
  '.open-next/',
  'dist/',
  'build/',
  'target/',
  'coverage/',
  '.cache/',
  '.turbo/',
  '.vercel/',
  '.wrangler/',
  '.DS_Store',
  // Secrets the user almost certainly didn't intend to share with the
  // model. .gitignore should also catch these, but we apply them
  // unconditionally as a safety net.
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
];

export type IgnoreMatcher = (relPath: string, isDir: boolean) => boolean;

export function buildMatcher(gitignoreText: string | null): IgnoreMatcher {
  const patterns = [...BASE_IGNORES];
  if (gitignoreText) {
    for (const raw of gitignoreText.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#')) continue;
      if (line.startsWith('!')) continue; // negation — see header comment
      patterns.push(line);
    }
  }
  const compiled = patterns.map(compile);
  return (relPath, isDir) => {
    for (const p of compiled) {
      if (p.dirOnly && !isDir) continue;
      if (p.re.test(relPath)) return true;
    }
    return false;
  };
}

type Compiled = { re: RegExp; dirOnly: boolean };

function compile(pattern: string): Compiled {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);

  // Leading slash anchors to the workspace root.
  const rootAnchored = p.startsWith('/');
  if (rootAnchored) p = p.slice(1);

  // Build a regex piece-by-piece. Tokens: **, *, ?, /, literal char.
  let out = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i] ?? '';
    if (c === '*' && p[i + 1] === '*') {
      // ** — match any number of path segments (including zero).
      out += '(?:.*/)?';
      i += 2;
      // Eat trailing slash so `**/foo` doesn't double-up.
      if (p[i] === '/') i++;
    } else if (c === '*') {
      out += '[^/]*';
      i++;
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if ('.+()|[]{}^$\\'.includes(c)) {
      out += '\\' + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }

  // Anchor to the start of the path (always — git treats unanchored
  // patterns as "match anywhere", which we model by allowing a
  // `(?:.*/)?` prefix when the pattern isn't root-anchored).
  const prefix = rootAnchored ? '^' : '^(?:.*/)?';

  // Allow trailing-slash directories to match anywhere underneath
  // (e.g. `node_modules/` should match `apps/foo/node_modules`).
  // We also allow the pattern to match the path exactly OR as a
  // prefix (so a directory pattern hides everything inside it).
  const suffix = dirOnly ? '(?:/.*)?$' : '$';

  return { re: new RegExp(prefix + out + suffix), dirOnly: false };
}
