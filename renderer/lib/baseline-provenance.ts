// What a pinned baseline IS. REDESIGN §6.6.
//
// The Visual screen asks the user to judge a frame against a baseline and, until
// now, told them nothing whatsoever about the baseline itself. That is the gap
// this closes, and it matters more than it sounds: "these two frames differ" is
// a completely different statement depending on whether the baseline was pinned
// yesterday from the same engine or four months ago from WebKit while the
// current run is Chromium. Without provenance the user cannot tell those apart,
// so every difference looks equally like a regression.
//
// WHAT THE PLAN ASKS FOR AND WHAT THIS APP ACTUALLY KNOWS. §6.6 lists "run,
// commit, browser, viewport, who accepted, when". Three of those six do not
// exist anywhere in this app and are not being invented here:
//
//   • COMMIT — nothing in the product reads the user's repository. A baseline is
//     pinned from a run of a recorded test against a live site; there is no
//     commit in the picture at all.
//   • WHO ACCEPTED — a single-user desktop app with no identity. A "who" field
//     would read back the same name forever.
//   • VIEWPORT — genuinely not on `RunRecord`. A test can carry `viewport` steps
//     that resize mid-run, so there is no single viewport for a run to report,
//     and quoting the first one would be wrong for any test that resizes.
//
// Inventing plausible values for those would be worse than omitting them: this
// panel's whole job is to make a comparison judgeable, and a fabricated
// provenance line makes it less so while looking like it makes it more.
//
// WHAT IT DOES KNOW is the run, when the baseline was pinned, which engine that
// run used, whether it was headless, and — the one nobody would think to ask for
// and everybody needs — WHETHER THAT RUN STILL EXISTS. Retention prunes run
// history; a baseline outlives it. A baseline pinned from a run that has been
// pruned is still a valid baseline and is no longer traceable to anything, and
// that is a fact about how much the comparison can be trusted.

import type { BaselineEntry, RunRecord } from "./recorder-types";

export interface BaselineProvenance {
  /** Epoch ms the baseline was pinned. */
  at: number;
  /** How long ago, in whole days. 0 means today. */
  ageDays: number;
  /** The run it came from, when retention has not pruned it. */
  run: RunRecord | null;
  /** Engine, or null when the run is gone. NOT defaulted to chromium — for a
   *  run that exists an absent `runBrowser` really does mean chromium (every
   *  run predating the picker used it), but for a run that is GONE we know
   *  nothing, and those two must not read alike. */
  browser: string | null;
  headless: boolean | null;
  /** True when the baseline covers only part of the frame. */
  elementScoped: boolean;
}

const DAY_MS = 86_400_000;

/** What can be said about one step's baseline.
 *
 *  `now` is passed in rather than read, so the age is testable without a fake
 *  clock — the same rule §6.1 follows. */
export function baselineProvenance(
  entry: BaselineEntry,
  runs: readonly RunRecord[],
  now: number,
): BaselineProvenance {
  const run = runs.find((r) => r.id === entry.runId) ?? null;
  return {
    at: entry.at,
    ageDays: Math.max(0, Math.floor((now - entry.at) / DAY_MS)),
    run,
    browser: run ? (run.runBrowser ?? "chromium") : null,
    headless: run ? Boolean(run.runHeadless) : null,
    elementScoped: entry.rect !== undefined,
  };
}

/** Old enough that the baseline is worth a second look before believing a diff
 *  against it.
 *
 *  THIRTY DAYS, AND IT IS A PROMPT RATHER THAN A VERDICT. Nothing is wrong with
 *  an old baseline — a stable page should have one — so this does not colour
 *  the line or call anything a problem. It exists because "pinned 4 months ago"
 *  is the single most useful thing to notice when a diff appears and nobody
 *  changed the page, and a date alone does not make anybody do the subtraction. */
export const STALE_BASELINE_DAYS = 30;

export function isStale(p: BaselineProvenance): boolean {
  return p.ageDays >= STALE_BASELINE_DAYS;
}

/** "today" / "yesterday" / "12 days ago". Relative, because the question this
 *  answers is how OLD the baseline is, and a reader given a date has to do the
 *  subtraction themselves — which is exactly the step they skip. */
export function ageLabel(ageDays: number): string {
  if (ageDays <= 0) return "today";
  if (ageDays === 1) return "yesterday";
  return `${ageDays} days ago`;
}

/**
 * The provenance line, as one string.
 *
 * Built here rather than in JSX so the exact sentence is assertable — the whole
 * point of this feature is what it SAYS, and a test that walked spans would
 * pass on a line that read correctly to the DOM and wrongly to a person.
 *
 * When the run is gone the line says so instead of quietly dropping the engine:
 * a provenance line missing a field reads as a rendering bug, and "the run this
 * came from is gone" is information rather than an absence of it.
 */
export function provenanceLine(p: BaselineProvenance): string {
  const parts: string[] = [`Pinned ${ageLabel(p.ageDays)}`];
  if (p.run) {
    parts.push(p.browser ?? "unknown engine");
    if (p.headless) parts.push("headless");
  } else {
    parts.push("run since pruned");
  }
  if (p.elementScoped) parts.push("element only");
  return parts.join(" · ");
}
