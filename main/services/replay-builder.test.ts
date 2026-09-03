// `buildReplay`'s correlation of the capture manifest against Step[], for the
// one field the tabs work added: which TAB a step acted on.
//
// The capture fixture stamps a later tab's index onto a manifest entry as
// `page` (absent on the first tab, so an older manifest reads unchanged); the
// replay carries it as `tab` so the Visual tab can say a screenshot is of tab
// 2 rather than leaving the reader to notice the page changed. The join runs
// in the same pass as the screenshot and rect, and this pins that a step on
// the first tab carries nothing and a step on the second carries 1.

import { describe, expect, it, vi } from "vitest";

import type { ArtifactStepEntry } from "./artifact-store.js";
import type { Step } from "../recorder/types.js";

let manifestSteps: ArtifactStepEntry[] = [];

vi.mock("./artifact-store.js", () => ({
  artifactStore: {
    readManifest: () => ({ testId: "t1", runId: "r1", steps: manifestSteps }),
  },
}));
vi.mock("./baseline-store.js", () => ({ baselineStore: { entry: () => null } }));

const { buildReplay } = await import("./replay-builder.js");

const entry = (over: Partial<ArtifactStepEntry> & { index: number; action: string }): ArtifactStepEntry => ({
  target: "page",
  ok: true,
  ts: 1,
  ...over,
});

describe("buildReplay carries which tab a step acted on", () => {
  it("marks a step whose manifest entry names a later tab, and leaves the first tab unmarked", () => {
    manifestSteps = [
      entry({ index: 0, action: "goto" }),
      entry({ index: 1, action: "click" }),
      // The OK click ran on the tab the link opened.
      entry({ index: 2, action: "click", page: 1 }),
    ];
    const steps = [
      { id: "s0", type: "goto", url: "http://x/" },
      { id: "s1", type: "click", locator: { k: "testid", v: "help-link" } },
      { id: "s2", type: "click", locator: { k: "testid", v: "ok" } },
    ] as Step[];
    const replay = buildReplay({
      testId: "t1",
      runId: "r1",
      testName: "tabs",
      status: "passed",
      startedAt: 1,
      finishedAt: 2,
      steps,
      statuses: { 0: "passed", 1: "passed", 2: "passed" },
    });
    expect(replay.steps.map((s) => s.tab)).toEqual([undefined, undefined, 1]);
    // Alongside the rest of the entry's evidence, from the same correlation.
    expect(replay.steps[2].actionIndex).toBe(2);
    expect(replay.steps[2].screenshot).toBe("2.png");
  });

  it("reads a manifest predating tabs exactly as before", () => {
    manifestSteps = [entry({ index: 0, action: "goto" }), entry({ index: 1, action: "click" })];
    const replay = buildReplay({
      testId: "t1",
      runId: "r1",
      testName: "tabs",
      status: "passed",
      startedAt: 1,
      finishedAt: 2,
      steps: [
        { id: "s0", type: "goto", url: "http://x/" },
        { id: "s1", type: "click", locator: { k: "testid", v: "go" } },
      ] as Step[],
      statuses: {},
    });
    for (const s of replay.steps) expect(s).not.toHaveProperty("tab");
  });
});
