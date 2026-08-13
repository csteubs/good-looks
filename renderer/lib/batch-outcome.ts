// What a FINISHED batch adds up to — one verdict for a whole suite run.
//
// This is deliberately not the same rule as `rowStatus` in batch-run-plan.ts,
// and the difference is the point. A ROW is one test: worst-first is right
// there, because a test that failed on webkit is a broken test no matter how
// chromium did. A BATCH is a set of tests, and "some passed, some failed" is a
// genuinely different situation from "nothing passed" — the first is a suite
// with a problem in it, the second is a suite that is not running at all
// (a bad base URL, a dead fixture, an expired login). Collapsing both to red
// meant the two looked identical at the one moment you most want them apart:
// the moment the batch finishes.
//
// Pure and separate from batch-view for the reason batch-parallel.ts is: the
// rule is the part worth asserting, and asserting it through the view would
// mean re-testing React state plumbing on every case.
//
// SKIPPED IS NOT AN OUTCOME HERE. A skipped test reported nothing, so it can
// neither make a batch mixed nor keep it clean; it only ever appears in the
// counts. `stopped` outranks everything for the same reason `running` does in
// rowStatus — a batch the user halted has no verdict to give, and tinting the
// partial results green or amber claims one.

// `ToneName` is `keyof typeof TONE`, so naming a tone that does not exist is a
// type error here — which is the whole reason the map below is typed rather
// than a bag of strings.
import type { ToneName } from "../theme/tokens";

/** The four things a batch the user is looking at can be. */
export type BatchOutcome =
  /** Halted by hand. Not a verdict — the remaining tests never ran. */
  | "stopped"
  /** Nothing failed. */
  | "passed"
  /** Some failed AND some passed. The case this module exists for. */
  | "mixed"
  /** Something failed and NOTHING passed. */
  | "failed";

/** The shape both a live `BatchState` and a stored `BatchRecord` share. Narrow
 *  on purpose, so a test can build a two-key literal instead of a whole
 *  record. */
export interface BatchOutcomeInput {
  stopped?: boolean;
  summary: { passed: number; failed: number };
}

export function batchOutcome({ stopped, summary }: BatchOutcomeInput): BatchOutcome {
  if (stopped) return "stopped";
  if (summary.failed === 0) return "passed";
  // Reached only when something failed, so this is the mixed/total split.
  return summary.passed > 0 ? "mixed" : "failed";
}

/** Tone per outcome. `null` is the neutral chip — a real state that is not a
 *  result, which is exactly what a stopped batch is. */
const OUTCOME_TONE: Record<BatchOutcome, ToneName | null> = {
  stopped: null,
  passed: "phos",
  mixed: "amber",
  failed: "red",
};

export function batchOutcomeTone(outcome: BatchOutcome): ToneName | null {
  return OUTCOME_TONE[outcome];
}

/** The heading over a finished batch. */
const OUTCOME_TITLE: Record<BatchOutcome, string> = {
  stopped: "Batch stopped",
  passed: "Batch passed",
  mixed: "Batch finished with failures",
  failed: "Batch failed",
};

export function batchOutcomeTitle(outcome: BatchOutcome): string {
  return OUTCOME_TITLE[outcome];
}

/** The chip's WORDS.
 *
 *  Kept to two tokens on purpose: every StatusChip is exactly `--gl-status-w`
 *  wide and does not grow, so "2 failed · 1 passed" does not become a wider
 *  chip — it becomes a clipped one. The full counts are already spelled out in
 *  the note beneath the panel and in the toolbar; the chip's job is the colour
 *  and the headline number. */
export function batchOutcomeLabel(input: BatchOutcomeInput): string {
  const outcome = batchOutcome(input);
  if (outcome === "stopped") return "Stopped";
  if (outcome === "passed") return `${input.summary.passed} passed`;
  return `${input.summary.failed} failed`;
}
