// Reducing a raw failure message to something groupable.
//
// Pure (see the admission rule in run-pacing.mjs). Moved out of
// flake-analysis.ts because `runs.error_signature` is a metrics-DB column: the
// rollup has to compute it at ingest, since the run log it comes from is capped
// at 1000 runs and pruned out from under any later reader.
//
// The plan scheduled this move for Phase 4, when the MCP would need the flake
// report. Phase 2 needed it first — the plan's own rule is that engines move
// when a caller needs them, and one did.
//
// Two runs failing the same way rarely produce byte-identical text: timeouts
// carry durations, selectors carry generated ids, paths carry a run id. Without
// normalization every failure is its own cluster and clustering does nothing.
// Over-normalizing is the opposite risk — collapsing two genuinely different
// failures into one — so this only removes what is known to vary run-to-run
// while the failure stays the same.

export function errorSignature(raw) {
  if (!raw) return "";
  return (
    raw
      .replace(/\r/g, "")
      .split("\n")[0]
      .trim()
      // Absolute paths differ per machine and per run directory.
      .replace(/(\/[\w.@-]+)+\/([\w.-]+)/g, "<path>")
      // Timeouts: "Timeout 30000ms exceeded" is the same failure at any duration.
      .replace(/\b\d+\s*ms\b/gi, "<ms>")
      .replace(/\b\d+(\.\d+)?\s*s\b/gi, "<s>")
      // Generated ids, hashes and uuids.
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
      .replace(/\b[0-9a-f]{16,}\b/gi, "<hash>")
      // Bare numbers last, so the more specific rules above get first refusal.
      .replace(/\b\d+\b/g, "<n>")
      .replace(/\s+/g, " ")
      .slice(0, 200)
  );
}

/**
 * The first line of a run log that looks like the failure.
 *
 * A Playwright log is mostly progress lines; the error is somewhere in the
 * middle, and the run record does not store it separately. Scanning for it here
 * keeps that knowledge in one place instead of in every consumer.
 *
 * Returns "" when nothing matches rather than guessing. An error signature
 * invented from a progress line clusters unrelated runs together, which is
 * worse than having no signature at all — a cluster is read as "these twenty
 * runs failed the same way".
 *
 * The caller must strip ANSI first. Playwright colours its failures, and the
 * escape sequences land INSIDE the message ("Error: \e[31mTimed out…"), so an
 * unstripped line yields a signature full of control characters that no other
 * run matches unless it happened to be coloured identically.
 */
const ERROR_LINE = /^\s*(?:\d+\)\s*)?(?:Error|TimeoutError|AssertionError|[\w.]*Error:|Timeout\b|expect\()/;

/**
 * Lines that START with "Error" and are not the error.
 *
 * "Error Context: test-results/…" is Playwright's pointer to the trace file,
 * emitted in the attachments section AFTER the failure. It matched first for
 * 109 of 207 failing runs on the development machine, so the most common
 * "failure" in the whole history was a file path — one cluster swallowing every
 * genuinely distinct failure that had no other matching line.
 */
const NOT_AN_ERROR = /^Error Context:/;

export function firstErrorLine(log) {
  if (!log) return "";
  for (const line of log.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (NOT_AN_ERROR.test(trimmed)) continue;
    if (ERROR_LINE.test(trimmed)) return trimmed.slice(0, 500);
  }
  return "";
}
