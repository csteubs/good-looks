// What a gap in the filmstrip shows, and what it says about itself.
//
// The bug this covers is silent by construction: every branch here renders a
// perfectly good screenshot, and getting it wrong means the viewer shows the
// user a picture of a DIFFERENT step while they decide whether the page looks
// right. Nothing throws, nothing is empty, and the frame is real — so the only
// thing that can catch it is an assertion on which frame was chosen and on what
// the marker claims about it.

import { describe, expect, it } from "vitest";

import { carriedFrameFor, carriedFrom, carriedNote } from "./carried-frame";
import type { ReplayStep } from "./recorder-types";

function step(over: Partial<ReplayStep> & { index: number }): ReplayStep {
  return {
    stepId: `s${over.index + 1}`,
    label: `step ${over.index + 1}`,
    type: "click",
    status: "passed",
    screenshot: null,
    ...over,
  };
}

/** The shape from the report that prompted this: 4 captured, 5 and 6 not, 7
 *  captured again. */
function gapRun(): ReplayStep[] {
  return [
    step({ index: 0, screenshot: "0.png" }),
    step({ index: 1, screenshot: "1.png", actionIndex: 1 }),
    step({ index: 2, type: "assert", status: "passed" }),
    step({ index: 3, type: "scroll", status: "passed" }),
    step({ index: 4, screenshot: "2.png", actionIndex: 2 }),
  ];
}

describe("which frame is carried", () => {
  it("reaches back past a run of uncaptured steps to the last real frame", () => {
    // Step 4 (index 3) is two steps past the last capture. The NEAREST earlier
    // frame is the last known state; walking to the first one, or giving up
    // after one hop, both put the wrong picture on screen.
    const carried = carriedFrameFor(gapRun(), 3);
    expect(carried).toMatchObject({ fromIndex: 1, file: "1.png", distance: 2 });
  });

  it("carries nothing for a step that has its own frame", () => {
    expect(carriedFrameFor(gapRun(), 4)).toBeNull();
  });

  it("carries nothing before the first capture", () => {
    // A gap with nothing behind it has no "last known state", and inventing one
    // from a LATER step would show the user the future.
    const steps = [step({ index: 0, type: "assert" }), step({ index: 1, screenshot: "0.png" })];
    expect(carriedFrameFor(steps, 0)).toBeNull();
  });

  it("carries nothing on a run that captured nothing at all", () => {
    const steps = [step({ index: 0 }), step({ index: 1 })];
    expect(carriedFrameFor(steps, 1)).toBeNull();
  });

  it("carries nothing for an index off the end", () => {
    expect(carriedFrameFor(gapRun(), 99)).toBeNull();
  });

  it("names the source step 1-based, as the rest of the screen numbers them", () => {
    // `fromIndex` is 1 and the user is told "step 2". An off-by-one here sends
    // someone to the wrong frame to check the claim.
    const carried = carriedFrameFor(gapRun(), 3)!;
    expect(carriedFrom(carried)).toBe("Carried from step 2");
  });
});

describe("what the marker claims", () => {
  it("says a step that captures nothing captures nothing", () => {
    const carried = carriedFrameFor(gapRun(), 3)!;
    expect(carried.reason).toBe("not-captured");
    expect(carriedNote(carried)).toContain("captures no frame of its own");
  });

  it("calls a failed shot a failure, not a step that doesn't capture", () => {
    // `actionIndex` is the tell: the fixture wrote a manifest entry for this
    // step, so a screenshot WAS attempted and did not survive. Reading it as
    // "this type captures nothing" would tell the user their scroll step is
    // working as designed while their captures are silently failing.
    const steps = [
      step({ index: 0, screenshot: "0.png" }),
      step({ index: 1, type: "click", status: "passed", actionIndex: 1 }),
    ];
    const carried = carriedFrameFor(steps, 1)!;
    expect(carried.reason).toBe("capture-failed");
    expect(carriedNote(carried)).toContain("screenshot failed");
  });

  it("calls a step that never ran a step that never ran", () => {
    const steps = [
      step({ index: 0, screenshot: "0.png" }),
      step({ index: 1, status: "failed" }),
      step({ index: 2, status: "skipped" }),
    ];
    const carried = carriedFrameFor(steps, 2)!;
    expect(carried.reason).toBe("not-run");
    expect(carriedNote(carried)).toContain("didn't run");
  });

  it("calls the failing step a failure, not a step that doesn't capture", () => {
    // The step of a failed run that everybody actually looks at, and the one
    // this is easiest to get wrong on: capture happens AFTER an action
    // resolves, so a click that threw has no manifest entry and no
    // `actionIndex` — identical, field for field, to a scroll. Reading it as
    // "this type captures nothing" tells someone their failing click is
    // behaving normally.
    const steps = [
      step({ index: 0, screenshot: "0.png" }),
      step({ index: 1, type: "click", status: "failed" }),
    ];
    const carried = carriedFrameFor(steps, 1)!;
    expect(carried.reason).toBe("failed");
    expect(carriedNote(carried)).toContain("This step failed");
  });

  it("does not call an if/endif a step that never ran", () => {
    // `buildReplay` records control flow as "skipped" — it is not a step that
    // executes. Status alone would report "this step didn't run" about a branch
    // that ran perfectly well.
    const steps = [
      step({ index: 0, screenshot: "0.png" }),
      step({ index: 1, type: "if", status: "skipped" }),
    ];
    const carried = carriedFrameFor(steps, 1)!;
    expect(carried.reason).toBe("not-captured");
  });

  it("always says the step's own effect is missing from the picture", () => {
    // The load-bearing caveat, and the one a reader is most likely to get wrong
    // on a scroll step: screenshots are viewport-only, so a carried frame is
    // the page BEFORE this step. Two of the three notes say so outright; the
    // third says the step never ran, which says it another way.
    const notes = (["not-captured", "failed", "capture-failed", "not-run"] as const).map((reason) =>
      carriedNote({ fromIndex: 0, file: "0.png", distance: 1, reason }),
    );
    for (const note of notes) {
      expect(note).toMatch(/isn't shown|before it/);
    }
  });
});
