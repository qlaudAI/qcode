// Minimal line-level diff. We use it for the write_file / edit_file
// approval UI — the user sees a unified-diff-style preview before
// approving the change. Pulled in here instead of via the `diff`
// package on npm because we only need the line-LCS variant and that
// package adds ~30 KB for features we don't use.

export type DiffLine = {
  kind: 'context' | 'add' | 'remove';
  text: string;
  /** 1-indexed line numbers. null on the side that doesn't have it. */
  oldLineNo: number | null;
  newLineNo: number | null;
};

/** Compute a line-by-line diff between `before` and `after`. Uses an
 *  LCS algorithm — fine for files up to a few thousand lines. For
 *  bigger files the agent should be using edit_file (which patches
 *  a small region) so we don't worry about scaling here. */
export function computeDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const lcs = lcsTable(a, b);
  const out: DiffLine[] = [];

  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({
        kind: 'context',
        text: a[i] ?? '',
        oldLineNo: i + 1,
        newLineNo: j + 1,
      });
      i++;
      j++;
    } else if (
      j < b.length &&
      (i >= a.length || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))
    ) {
      out.push({
        kind: 'add',
        text: b[j] ?? '',
        oldLineNo: null,
        newLineNo: j + 1,
      });
      j++;
    } else {
      out.push({
        kind: 'remove',
        text: a[i] ?? '',
        oldLineNo: i + 1,
        newLineNo: null,
      });
      i++;
    }
  }

  return out;
}

function lcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const t: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = t[i]!;
      const next = t[i + 1]!;
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return t;
}

/** Quick stats for the approval-card header (e.g. "+12 -3"). */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'remove') removed++;
  }
  return { added, removed };
}
