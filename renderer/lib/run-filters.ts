// Run-history filtering for the Stats view.
//
// Pure predicate + option helpers, kept out of stats-view.tsx so they can be
// exercised by `npm run check:run-filters` without pulling in React or the
// design system. Filtering is entirely client-side over the already-loaded
// RunRecord[] — no extra IPC round trip.

import { RUN_BROWSERS, type RunBrowser, type RunRecord } from "./recorder-types";

/** Baseline-update rows are their own status rather than passed/failed. */
export type StatusFilter = "all" | "passed" | "failed" | "baseline";

/** Mirrors the badges shown in the table's Tags column: the display mode
 *  ("headed"/"headless"), whether the run captured screenshots, or a specific
 *  browser engine. One axis, so a run is filtered by mode OR engine, not both
 *  — the common questions ("which runs were headless?", "did the Firefox runs
 *  pass?") each need only one.
 *
 *  "headed" is the mode, NOT the engine — engines are the RunBrowser values. */
export type TagFilter = "all" | "headed" | "headless" | "captured" | RunBrowser;

/** Runs recorded before the browser picker all ran on chromium. */
export function runBrowserOf(r: RunRecord): RunBrowser {
  return r.runBrowser ?? "chromium";
}

export interface RunFilters {
  status: StatusFilter;
  tag: TagFilter;
  /** a testId, or "all" */
  test: string;
}

/** "all" is the neutral value on every axis. */
export const NO_FILTERS: RunFilters = { status: "all", tag: "all", test: "all" };

export function filtersActive(f: RunFilters): boolean {
  return f.status !== "all" || f.tag !== "all" || f.test !== "all";
}

/**
 * Does a run satisfy every active filter axis? A run passes when each axis is
 * either "all" or matches.
 *
 * Baseline-update rows carry no browser/headless/capture tags, so any tag
 * filter excludes them — and they are reachable only via status "baseline",
 * never via "passed"/"failed" (their `status` field is incidental).
 */
export function runMatchesFilters(r: RunRecord, f: RunFilters): boolean {
  const isBaseline = r.kind === "baseline-update";

  if (f.status === "baseline") {
    if (!isBaseline) return false;
  } else if (f.status !== "all") {
    if (isBaseline || r.status !== f.status) return false;
  }

  if (f.tag !== "all") {
    if (isBaseline) return false;
    if (f.tag === "headless" && !r.runHeadless) return false;
    if (f.tag === "headed" && r.runHeadless) return false;
    if (f.tag === "captured" && !r.captureArtifacts) return false;
    if ((RUN_BROWSERS as string[]).includes(f.tag) && runBrowserOf(r) !== f.tag) return false;
  }

  if (f.test !== "all" && r.testId !== f.test) return false;

  return true;
}

/** Distinct tests present in the history, name-sorted, for the test filter. */
export function testFilterOptions(runs: RunRecord[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const r of runs) if (!byId.has(r.testId)) byId.set(r.testId, r.testName);
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
