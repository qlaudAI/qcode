// Tiny fuzzy matcher. Lower-bound subsequence search with a score
// that rewards consecutive matches + matches at start-of-segment
// (so `auth` ranks `src/auth.ts` higher than `src/dashboard/auth.ts`).
// Good enough for command-palette UX without pulling in fuse.js
// (~15 KB) or fzf-for-js.

export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let score = 0;
  let qi = 0;
  let tInRunStart = -1;
  let prevWasMatch = false;
  let prevWasSep = true; // start of string counts as separator

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    const tc = t[ti] ?? '';
    if (tc === q[qi]) {
      // Bonuses:
      //  +5 — match at start of segment (after / . - _ space)
      //  +3 — consecutive match (run-length bonus to prefer "auth"
      //       hitting "auth" over scattered chars)
      //  +1 — base match
      let pts = 1;
      if (prevWasSep) pts += 5;
      if (prevWasMatch) pts += 3;
      if (qi === 0) tInRunStart = ti;
      score += pts;
      qi++;
      prevWasMatch = true;
    } else {
      prevWasMatch = false;
    }
    prevWasSep = isSep(tc);
  }
  if (qi < q.length) return null; // didn't consume all query chars
  // Penalize early matches that drag through unrelated suffix.
  if (tInRunStart > 0) score -= Math.min(tInRunStart / 2, 3);
  return score;
}

function isSep(ch: string): boolean {
  return ch === '/' || ch === '.' || ch === '-' || ch === '_' || ch === ' ';
}
