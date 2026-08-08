// How many tests a batch runs at once, and when to ask first.
//
// Pure and separate from batch-view because the picker CANNOT be driven in a
// test: the SDK's Select is native-menu-backed, so its options never enter the
// DOM (see CLAUDE.md). Testing the warning through the UI would mean testing
// the one control jsdom can't touch — so the decision lives here, where it can
// be asserted directly, and the view only renders it.
//
// The threshold is on the number of browsers that will actually be OPEN AT
// ONCE, not on how many tests were selected: 40 tests at "4 at once" never
// shows more than four windows, while "all at once" with 14 shows fourteen.
// Warning on the selection would nag about the safe case and stay quiet about
// the loud one.

import { HEADED_PARALLEL_WARN, MAX_BATCH_CONCURRENCY } from "./recorder-types";

/** The picker's value. A number is a fixed ceiling; "all" means "as many as
 *  there are tests", which is still capped by MAX_BATCH_CONCURRENCY. */
export type BatchConcurrencyChoice = number | "all";

/** Options offered by the Batch toolbar, in order. 1 is "Off" — one at a time,
 *  which is what every batch did before this existed and remains the default. */
export const BATCH_CONCURRENCY_CHOICES: BatchConcurrencyChoice[] = [1, 2, 4, 8, "all"];

export function batchConcurrencyLabel(choice: BatchConcurrencyChoice): string {
  if (choice === "all") return "All at once";
  if (choice === 1) return "Off";
  return `${choice} at once`;
}

/**
 * How many tests this batch will actually start at once.
 *
 * `distinctTests` is the number of DISTINCT tests selected, because entries for
 * the same test are serialized by the runner (a dataset sweep queues one test
 * many times and its rows still run one after another). Mirrors
 * `clampBatchConcurrency` on the backend, which has the final say — if these
 * disagree, the dialog warns about a number that never happens.
 */
export function resolveConcurrency(
  choice: BatchConcurrencyChoice,
  distinctTests: number,
): number {
  const ceiling = Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, Math.floor(distinctTests) || 1));
  if (choice === "all") return ceiling;
  if (!Number.isFinite(choice)) return 1;
  return Math.max(1, Math.min(ceiling, Math.floor(choice)));
}

/**
 * Should the Batch view ask before starting?
 *
 * Only for HEADED runs: a headless batch costs CPU, a headed one opens a real
 * window per test and each takes focus as it launches, so past a certain point
 * the machine stops being usable until the suite finishes. Strictly greater
 * than the threshold — the ask is "more than 10", so exactly 10 goes straight
 * through.
 */
export function needsHeadedParallelWarning(opts: {
  concurrency: number;
  runHeadless: boolean;
}): boolean {
  if (opts.runHeadless) return false;
  return opts.concurrency > HEADED_PARALLEL_WARN;
}

/** Restore a stored default (a plain number from settings) as a picker value.
 *
 *  Snaps DOWN to an offered option rather than returning the number as-is: the
 *  settings file is editable by hand, and a Select whose value isn't one of its
 *  own items renders as blank — which reads as "no default set" while a default
 *  is very much set. Snapping down also never silently raises the count. */
export function choiceFromSetting(value: number | undefined): BatchConcurrencyChoice {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 1) return 1;
  if (value >= MAX_BATCH_CONCURRENCY) return "all";
  const numeric = BATCH_CONCURRENCY_CHOICES.filter((c): c is number => typeof c === "number");
  let best = 1;
  for (const c of numeric) if (c <= value) best = c;
  return best;
}

/** A picker value as the number stored in settings. "All at once" persists as
 *  the cap, so restoring it lands back on "all" via choiceFromSetting. */
export function settingFromChoice(choice: BatchConcurrencyChoice): number {
  return choice === "all" ? MAX_BATCH_CONCURRENCY : choice;
}
