// The frame a step SHOWS when it captured none of its own.
//
// Only page actions produce a screenshot — `replay-builder.ts`'s
// `captureMethod` is the authority, and it returns null for scrolls,
// assertions, waits, `page.keyboard.press`, and `if`/`endif`. A run of fifteen
// steps therefore routinely has gaps in the middle of it, and the replay
// viewer used to answer every one of them with an empty box: scrubbing 4 → 5 →
// 6 → 7 blanked the screen twice on the way between two frames that differ by
// almost nothing. The picture is the entire point of this screen, and losing it
// mid-scrub is the one thing it must not do.
//
// So a gap shows the nearest EARLIER captured frame instead — the last known
// visual state — and this module decides which one and says why.
//
// THE LABEL IS NOT DECORATION, and it is the reason this is a module rather
// than four lines inline. Everything in a `CRT` on this screen is evidence: the
// user is being asked "does this look right?", and a frame from a different
// step presented without qualification is the app answering that question with
// the wrong picture. Worse, the reasons a step has no frame are not
// interchangeable — "this step never captures" (a scroll), "this step's capture
// failed", and "this step never ran" support completely different readings of
// the same image — so the note is derived from the step rather than written
// once and reused.
//
// AND WHAT IS SHOWN IS THE PAGE *BEFORE* THIS STEP. Screenshots are viewport
// only (nothing in this app passes `fullPage`), so a `scroll to (0, 670)` step
// carries the PRE-scroll viewport. Every note therefore ends by saying that
// what this step did is not in the picture; a carried frame that let someone
// believe otherwise would be worse than the empty box it replaced.

import type { ReplayStep } from "./recorder-types";

/** Why the selected step has no frame of its own. */
export type CarriedReason =
  /** Its type captures nothing — a scroll, an assertion, a wait, if/endif. */
  | "not-captured"
  /** It is the step the run died on. Capture happens AFTER an action resolves,
   *  so a step that threw never reaches it and has no manifest entry either —
   *  which is why this cannot be inferred from `actionIndex` and is asked
   *  before it. */
  | "failed"
  /** The capture fixture attempted a screenshot for it and the shot failed. */
  | "capture-failed"
  /** It never ran: the run halted at an earlier step. */
  | "not-run";

export interface CarriedFrame {
  /** Step[] index the frame was actually captured at. */
  fromIndex: number;
  /** Filename within the run dir, e.g. "3.png". */
  file: string;
  /** How many steps back that is. Always >= 1. */
  distance: number;
  reason: CarriedReason;
}

/**
 * Why `step` has no frame.
 *
 * ORDER MATTERS, three times over. `if`/`endif` are recorded with status
 * "skipped" by `buildReplay` — control flow is not a step that runs — so
 * testing status first would report "this step didn't run" about a branch that
 * did. The FAILING step is asked next and cannot be inferred from anything
 * else: the capture fixture screenshots only after an action RESOLVES, so a
 * click that threw has no manifest entry and no `actionIndex`, and would fall
 * through to "this step captures no frame of its own" — said about a click, on
 * the one step of a failed run anybody is looking at. And `actionIndex` is the
 * tell for a failed CAPTURE: `buildReplay` records it whenever a manifest entry
 * matched, whether or not the shot succeeded.
 *
 * That tell is only trustworthy inside `carriedFrameFor`, which is the only
 * caller: on an a11y-only run the fixture writes entries with `ok: false` for
 * every action because no screenshot was ever attempted, and this would call
 * each one a failure. It cannot arise here, because a carried frame requires an
 * earlier step to have captured one — which proves screenshots were on.
 */
function reasonFor(step: ReplayStep): CarriedReason {
  if (step.type === "if" || step.type === "endif") return "not-captured";
  if (step.status === "failed") return "failed";
  if (step.status === "skipped" || step.status === "unknown") return "not-run";
  if (step.actionIndex !== undefined) return "capture-failed";
  return "not-captured";
}

/**
 * The nearest earlier captured frame for the step at `index`, or null when
 * there is nothing to carry.
 *
 * Null in three cases, all of which must keep the existing empty state rather
 * than invent a picture: the index is out of range, the step has its own frame
 * (nothing to carry), and no earlier step captured one — a run that never
 * captured, or a gap before the first screenshot, where there is no "last known
 * state" to fall back to.
 */
export function carriedFrameFor(steps: ReplayStep[], index: number): CarriedFrame | null {
  const step = steps[index];
  if (!step || step.screenshot) return null;
  for (let i = index - 1; i >= 0; i--) {
    const file = steps[i].screenshot;
    if (!file) continue;
    return { fromIndex: i, file, distance: index - i, reason: reasonFor(step) };
  }
  return null;
}

/** The marker's lead, naming the frame's real owner. 1-based, like every step
 *  number the user sees. */
export function carriedFrom(carried: CarriedFrame): string {
  return `Carried from step ${carried.fromIndex + 1}`;
}

/** Why this step has no frame, and — in every branch — that what the step did
 *  is not in the picture. See the header: viewport-only screenshots mean the
 *  carried frame is the page BEFORE this step, and a scroll step is the case
 *  where that is most easily misread. */
export function carriedNote(carried: CarriedFrame): string {
  switch (carried.reason) {
    case "failed":
      return "This step failed, so nothing was captured — this is the last frame before it.";
    case "capture-failed":
      return "This step's screenshot failed — anything it changed on screen isn't shown.";
    case "not-run":
      return "This step didn't run — this is the last frame captured before it.";
    default:
      return "This step captures no frame of its own — anything it changed on screen isn't shown.";
  }
}
