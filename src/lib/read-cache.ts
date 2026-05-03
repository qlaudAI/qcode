// Read-before-Edit gate. Tracks every successful read of a workspace
// file so write_file/edit_file can refuse to mutate a file the agent
// hasn't seen recently — preventing the most common class of edit
// bugs ("agent edited based on stale knowledge of the file").
//
// Lifted from Claude Code's FileStateCache pattern: LRU-bounded map,
// keyed by normalized absolute path, valued by {content, timestamp,
// offset, limit, isPartialView}. The gate has two checks:
//
//   1. Presence + non-partial: file must have been Read; partial reads
//      (offset/limit set) don't qualify because the agent doesn't know
//      what's outside the read window.
//   2. Freshness: if the disk mtime is newer than the cached read
//      timestamp, the file changed under us — refuse the edit unless
//      the cached content STILL matches what's on disk (Windows fs
//      sometimes touches mtime without changing content).
//
// Both write_file and edit_file consult this gate; both UPDATE the
// cache after a successful write so chained operations work without
// requiring a re-Read between them.
//
// Cache is module-scoped (not per-workspace) because the agent works
// on one workspace at a time and clearing on workspace switch is a
// belt-and-suspenders defense — the path keys are absolute, so cross-
// workspace collisions can't happen anyway.

const MAX_ENTRIES = 100;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB total content cap

type ReadEntry = {
  /** Full file content as the agent saw it. Empty string = empty file
   *  (legitimate; not "absent"). */
  content: string;
  /** ms since epoch of the read — compared against fs mtime to detect
   *  external changes. Use Date.now() at read time, not the file's
   *  mtime, so a re-read of an unchanged file refreshes freshness. */
  timestamp: number;
  /** Line offset of a partial read (1-based). undefined for full reads. */
  offset?: number;
  /** Line limit of a partial read. undefined for full reads. */
  limit?: number;
  /** True for reads that don't qualify as "the agent knows this file"
   *  — partial reads, auto-injected file content. Edits against
   *  isPartialView entries are rejected the same as un-read files. */
  isPartialView?: boolean;
};

const ENTRIES = new Map<string, ReadEntry>();
let totalBytes = 0;

export type ReadGateError = {
  /** `not_read`: never read or marked partial. `stale`: read but
   *  modified externally since. UI maps these to specific copy. */
  code: 'not_read' | 'stale';
  message: string;
};

/** Normalize a path so cache lookups are consistent regardless of
 *  the input form (./foo vs foo, doubled slashes, trailing slash).
 *  Pure — no fs calls. */
export function normalizePath(p: string): string {
  let s = p.trim();
  // Collapse repeated separators, drop trailing slash (except root).
  s = s.replace(/[/\\]+/g, '/').replace(/\/$/, '');
  return s || '/';
}

/** Record a successful read. Called by runReadFile after the file
 *  loaded cleanly. Overwrites any prior entry — the latest read is
 *  always the source of truth. */
export function recordRead(args: {
  path: string;
  content: string;
  offset?: number;
  limit?: number;
  isPartialView?: boolean;
}): void {
  const key = normalizePath(args.path);
  const prior = ENTRIES.get(key);
  if (prior) totalBytes -= prior.content.length;
  const entry: ReadEntry = {
    content: args.content,
    timestamp: Date.now(),
    offset: args.offset,
    limit: args.limit,
    isPartialView:
      args.isPartialView ?? (args.offset !== undefined || args.limit !== undefined),
  };
  ENTRIES.set(key, entry);
  totalBytes += entry.content.length;
  evictIfOver();
}

/** Record a successful write/edit. Caches the new content as if the
 *  agent had just re-read the file, so subsequent edits don't need a
 *  Read in between. Identical shape to recordRead but isPartialView
 *  is always false (we wrote the whole resulting state). */
export function recordWrite(args: { path: string; content: string }): void {
  recordRead({
    path: args.path,
    content: args.content,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
  });
}

/** The gate. Called from write_file/edit_file's validateInput before
 *  any disk write. Returns null on pass, ReadGateError on fail.
 *
 *  `currentMtimeMs` is the fs.stat().mtime of the file on disk RIGHT
 *  NOW. Caller passes 0 when the file doesn't exist yet (creating a
 *  new file is allowed without a prior read). */
export function checkReadBeforeWrite(args: {
  path: string;
  /** Current file content on disk (or empty string when creating new).
   *  Used as a fallback when mtime drifts but content didn't change —
   *  Windows fs and some FUSE mounts touch mtime spuriously. */
  currentContent: string | null;
  currentMtimeMs: number;
}): ReadGateError | null {
  // New-file creation: no prior read required.
  if (args.currentContent === null) return null;

  const key = normalizePath(args.path);
  const entry = ENTRIES.get(key);
  if (!entry || entry.isPartialView) {
    return {
      code: 'not_read',
      message:
        'File has not been read yet. Read it first before writing to it. (Run read_file on this path; the cached read is what makes the edit safe.)',
    };
  }

  // Newer mtime: file was modified externally. Allow only when the
  // current disk content STILL matches the cached read (mtime drift
  // without content change — common on Windows / network mounts).
  if (args.currentMtimeMs > entry.timestamp) {
    if (args.currentContent === entry.content) {
      return null; // mtime drifted but content matched; safe to edit
    }
    return {
      code: 'stale',
      message:
        'File has been modified since you last read it (likely by the user or a linter). Re-read it before writing — the edit you have in mind may target lines that have moved.',
    };
  }
  return null;
}

/** Diagnostic: read state for a path. Used by tests + a possible
 *  future "/cache" command. Do not use to gate logic — go through
 *  checkReadBeforeWrite. */
export function inspectRead(path: string): ReadEntry | null {
  return ENTRIES.get(normalizePath(path)) ?? null;
}

/** Drop everything. Called on workspace switch or sign-out. */
export function clearAllReads(): void {
  ENTRIES.clear();
  totalBytes = 0;
}

function evictIfOver(): void {
  if (ENTRIES.size <= MAX_ENTRIES && totalBytes <= MAX_BYTES) return;
  // Evict oldest by insertion order. Map iteration is insertion-
  // ordered in JS, so the first key is the oldest.
  while (
    (ENTRIES.size > MAX_ENTRIES || totalBytes > MAX_BYTES) &&
    ENTRIES.size > 0
  ) {
    const oldestKey = ENTRIES.keys().next().value;
    if (oldestKey === undefined) break;
    const entry = ENTRIES.get(oldestKey);
    if (entry) totalBytes -= entry.content.length;
    ENTRIES.delete(oldestKey);
  }
}
