// A tiny line-based diff (LCS) with no dependencies, used by the AI debug
// "Apply to script" confirm to show what changes before overwriting the test's
// script. Returns an ordered list of hunks keyed by line so the UI can render
// removed (current) and added (corrected) lines in place.

export type DiffLine =
  | { type: "equal"; text: string }
  | { type: "remove"; text: string }
  | { type: "add"; text: string };

/**
 * Compute a line-level diff between `a` (current) and `b` (corrected) using the
 * standard dynamic-programming LCS over lines. O(n*m) is fine for spec files
 * (a few hundred lines at most).
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const ax = a.split("\n");
  const bx = b.split("\n");
  const n = ax.length;
  const m = bx.length;

  // dp[i][j] = length of the LCS of ax[i:] and bx[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ax[i] === bx[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ax[i] === bx[j]) {
      out.push({ type: "equal", text: ax[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "remove", text: ax[i] });
      i++;
    } else {
      out.push({ type: "add", text: bx[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: "remove", text: ax[i++] });
  }
  while (j < m) {
    out.push({ type: "add", text: bx[j++] });
  }
  return out;
}

/** Quick summary counts for a diff header. */
export function diffSummary(diff: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of diff) {
    if (d.type === "add") added++;
    else if (d.type === "remove") removed++;
  }
  return { added, removed };
}
