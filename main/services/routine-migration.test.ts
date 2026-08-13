// Turning today's implicit Batch into a named Routine. docs/ROUTINES.md.
//
// LIVES HERE RATHER THAN BESIDE `shared/routine-migration.mjs`, for the reason
// CLAUDE.md gives: vitest's `node` project globs `main/**/*.test.ts`, so a test
// under `shared/` matches NEITHER project and passes by never running. Same
// placement as `emitters.test.ts`.
//
// WHAT IS WORTH ASSERTING HERE. A store that is wrong is empty and obvious; a
// migration that is wrong silently changes what somebody's suite does, and they
// find out on the first scheduled run. Every case below is one where the module
// could produce a perfectly well-formed Routine that runs the wrong thing —
// which is why they are cases about CONTENT, not about shape.
//
// The selection case is the one with history: the first draft had it backwards.

import { describe, it, expect } from "vitest";

import type { BatchRowOptions, RecorderSettings } from "../recorder/types.js";
import {
  batchBelongsToRoutine,
  FAILURE_POLICIES,
  MIGRATED_ROUTINE_ID,
  ORPHAN_BATCH_OWNER,
  MIGRATED_CONCURRENCY,
  MIGRATED_NAME,
  normalizeConcurrency,
  routineFromBatchSettings,
  stepsFromBatchSettings,
} from "../../shared/routine-migration.mjs";

/** A stored row, as `normalizeBatchTestOptions` writes it. Loosely typed on
 *  purpose — half the cases below are settings files no writer of ours would
 *  produce, and a helper that only accepts a valid row cannot express them. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { selected: true, browsers: ["chromium"], headless: false, ...over };
}

/** The same row where the caller needs it to satisfy `RecorderSettings`. */
function typedRow(over: Partial<BatchRowOptions> = {}): BatchRowOptions {
  return { selected: true, browsers: ["chromium"], headless: false, ...over };
}

function settings(over: Partial<RecorderSettings> = {}): Partial<RecorderSettings> {
  return {
    batchOrder: [],
    batchTestOptions: {},
    defaultCaptureArtifacts: false,
    defaultBatchConcurrency: 1,
    ...over,
  };
}

describe("selection", () => {
  it("does not carry a test that has no stored row", () => {
    // THE BUG THIS FILE EXISTS FOR. `defaultRow` in batch-run-plan.ts returns
    // `selected: false`, so a test with no entry is one the user never ticked.
    // Reading an absent entry as a working default — which is what the first
    // draft did — migrates a Routine containing every test in the library, for
    // every user who ever opened the Batch view.
    const steps = stepsFromBatchSettings(["t-a", "t-b"], {}, ["t-a", "t-b"]);
    expect(steps).toEqual([]);
  });

  it("does not carry a row the user deliberately unticked", () => {
    const steps = stepsFromBatchSettings(
      ["t-a", "t-b"],
      { "t-a": row(), "t-b": row({ selected: false }) },
      ["t-a", "t-b"],
    );
    expect(steps.map((s) => s.testId)).toEqual(["t-a"]);
  });

  it("treats a truthy non-true `selected` as unticked", () => {
    // A hand-edited settings file can hold `"true"`, and a string is truthy.
    // The row's own normalizer is `=== true` for the same reason.
    const steps = stepsFromBatchSettings(["t-a"], { "t-a": row({ selected: "true" }) }, ["t-a"]);
    expect(steps).toEqual([]);
  });
});

describe("order", () => {
  it("follows batchOrder, not the options map's key order", () => {
    // A Routine whose steps come out in `Object.keys` order looks identical in
    // a list and runs a different suite.
    const options = { "t-c": row(), "t-a": row(), "t-b": row() };
    const steps = stepsFromBatchSettings(["t-b", "t-c", "t-a"], options, ["t-a", "t-b", "t-c"]);
    expect(steps.map((s) => s.testId)).toEqual(["t-b", "t-c", "t-a"]);
  });

  it("keeps a selected test the order never mentioned, at the end", () => {
    // The two keys drift: an id can be written into options by a row that was
    // never dragged. Dropping it would silently shrink the suite.
    const steps = stepsFromBatchSettings(["t-a"], { "t-a": row(), "t-drifted": row() }, [
      "t-a",
      "t-drifted",
    ]);
    expect(steps.map((s) => s.testId)).toEqual(["t-a", "t-drifted"]);
  });

  it("produces one step for a test listed twice in the order", () => {
    // Two steps naming one test can never execute concurrently (the runner
    // serialises a test into a single lane), so a duplicate here would draw a
    // job that does not run the way it reads.
    const steps = stepsFromBatchSettings(["t-a", "t-a"], { "t-a": row() }, ["t-a"]);
    expect(steps).toHaveLength(1);
  });
});

describe("tests that no longer exist", () => {
  it("drops a selected row whose test is gone", () => {
    // At the one moment the Routine is created, a broken step reads as the
    // migration having failed. A test deleted AFTER this is a different story.
    const steps = stepsFromBatchSettings(["t-a", "t-ghost"], { "t-a": row(), "t-ghost": row() }, [
      "t-a",
    ]);
    expect(steps.map((s) => s.testId)).toEqual(["t-a"]);
  });

  it("filters nothing when the caller does not say what exists", () => {
    const steps = stepsFromBatchSettings(["t-ghost"], { "t-ghost": row() }, null);
    expect(steps.map((s) => s.testId)).toEqual(["t-ghost"]);
  });
});

describe("what each step carries", () => {
  it("keeps engines and headedness per row", () => {
    // Per row rather than globally, because that is how they are stored and a
    // saved job is supposed to be stable against a later change to a test's
    // own defaults (ROUTINES.md open question 1).
    const steps = stepsFromBatchSettings(
      ["t-a", "t-b"],
      {
        "t-a": row({ browsers: ["firefox", "webkit"], headless: true }),
        "t-b": row({ browsers: ["chromium"], headless: false }),
      },
      ["t-a", "t-b"],
    );
    expect(steps[0]).toMatchObject({ browsers: ["firefox", "webkit"], headless: true });
    expect(steps[1]).toMatchObject({ browsers: ["chromium"], headless: false });
  });

  it("never produces a step with no engines", () => {
    // An empty array is a ticked test that queues nothing, so the Routine
    // silently runs fewer tests than it lists.
    const steps = stepsFromBatchSettings(["t-a"], { "t-a": row({ browsers: [] }) }, ["t-a"]);
    expect(steps[0].browsers).toEqual(["chromium"]);
  });

  it("drops a non-string engine rather than carrying it into a run", () => {
    const steps = stepsFromBatchSettings(["t-a"], { "t-a": row({ browsers: [7, "webkit"] }) }, [
      "t-a",
    ]);
    expect(steps[0].browsers).toEqual(["webkit"]);
  });

  it("sets every step's failure policy to continue", () => {
    // Batch's current unwritten behaviour: a failing test never aborts it. Any
    // other default changes what the migrated job does on its first run.
    const steps = stepsFromBatchSettings(["t-a", "t-b"], { "t-a": row(), "t-b": row() }, [
      "t-a",
      "t-b",
    ]);
    expect(steps.map((s) => s.onFailure)).toEqual(["continue", "continue"]);
    expect(FAILURE_POLICIES[0]).toBe("continue");
  });
});

describe("the migrated Routine", () => {
  it("is null when nothing was ticked", () => {
    // A user who never ticked a row should not find a saved job named "Batch"
    // with no steps in it — that is an artefact of the upgrade appearing in
    // their library as if they had made it.
    expect(routineFromBatchSettings(settings(), ["t-a"], 1_000)).toBeNull();
  });

  it("is null for settings that are missing entirely", () => {
    expect(routineFromBatchSettings(undefined, ["t-a"], 1_000)).toBeNull();
  });

  it("carries the batch's own name, steps and defaults", () => {
    const routine = routineFromBatchSettings(
      settings({
        batchOrder: ["t-a"],
        batchTestOptions: { "t-a": typedRow() },
        defaultCaptureArtifacts: true,
        defaultBatchConcurrency: 4,
      }),
      ["t-a"],
      1_234,
    );
    expect(routine).not.toBeNull();
    expect(routine!.name).toBe(MIGRATED_NAME);
    expect(routine!.createdAt).toBe(1_234);
    expect(routine!.updatedAt).toBe(1_234);
    expect(routine!.steps.map((s) => s.testId)).toEqual(["t-a"]);
    expect(routine!.defaults).toEqual({ captureArtifacts: true, concurrency: 4 });
  });
});

describe("which routine a batch belongs to", () => {
  it("matches on the stamped routine", () => {
    expect(batchBelongsToRoutine({ routineId: "r-a" }, "r-a")).toBe(true);
    expect(batchBelongsToRoutine({ routineId: "r-a" }, "r-b")).toBe(false);
  });

  it("gives a batch with no routine to the MIGRATED one, and only to it", () => {
    // Every batch run before Routines shipped, and every one the MCP's
    // `run_batch` starts. Attributing them to EVERY routine shows one history
    // under four jobs as if each had run it; to NONE makes a user's whole
    // history vanish from the screen the day they upgrade.
    expect(batchBelongsToRoutine({}, ORPHAN_BATCH_OWNER)).toBe(true);
    expect(batchBelongsToRoutine({}, "r-b")).toBe(false);
    expect(ORPHAN_BATCH_OWNER).toBe(MIGRATED_ROUTINE_ID);
  });

  it("treats an empty stamp as no stamp rather than as a routine", () => {
    // A hand-edited or half-written record. `"" === ""` would otherwise make
    // it belong to a routine whose id is the empty string, which cannot exist.
    expect(batchBelongsToRoutine({ routineId: "" }, ORPHAN_BATCH_OWNER)).toBe(true);
  });

  it("belongs to nothing when no routine is open", () => {
    expect(batchBelongsToRoutine({ routineId: "r-a" }, null)).toBe(false);
    expect(batchBelongsToRoutine({}, undefined)).toBe(false);
  });

  it("survives a batch that is not one", () => {
    expect(batchBelongsToRoutine(null, "r-a")).toBe(false);
  });
});

describe("concurrency", () => {
  it("carries a stored lane count through untouched", () => {
    // NO SECOND CEILING. The first draft clamped to 1–8, which would quietly
    // halve a user's twelve lanes — a migration changing what the job does.
    // `recorderSettingsStore.read()` already clamps at its own boundary.
    expect(normalizeConcurrency(12)).toBe(12);
  });

  it("falls back rather than flooring a value that is not a lane count", () => {
    // `Math.round(null)` is 0 and then the floor, which is how a corrupt file
    // turns into a silent one-at-a-time run.
    expect(normalizeConcurrency(0)).toBe(MIGRATED_CONCURRENCY);
    expect(normalizeConcurrency(-3)).toBe(MIGRATED_CONCURRENCY);
    expect(normalizeConcurrency("4")).toBe(MIGRATED_CONCURRENCY);
    expect(normalizeConcurrency(null)).toBe(MIGRATED_CONCURRENCY);
    expect(normalizeConcurrency(undefined)).toBe(MIGRATED_CONCURRENCY);
    expect(normalizeConcurrency(NaN)).toBe(MIGRATED_CONCURRENCY);
    expect(normalizeConcurrency(Infinity)).toBe(MIGRATED_CONCURRENCY);
  });

  it("floors a fractional lane count", () => {
    expect(normalizeConcurrency(3.9)).toBe(3);
  });
});

describe("hostile settings files", () => {
  it("survives an options map that is not an object", () => {
    expect(stepsFromBatchSettings(["t-a"], "nope", ["t-a"])).toEqual([]);
    expect(stepsFromBatchSettings(["t-a"], null, ["t-a"])).toEqual([]);
  });

  it("survives an order that is not an array", () => {
    const steps = stepsFromBatchSettings("t-a", { "t-a": row() }, ["t-a"]);
    expect(steps.map((s) => s.testId)).toEqual(["t-a"]);
  });

  it("ignores a non-string id in the order", () => {
    const steps = stepsFromBatchSettings([7, "t-a"], { "t-a": row() }, ["t-a"]);
    expect(steps.map((s) => s.testId)).toEqual(["t-a"]);
  });

  it("ignores a row that is not an object", () => {
    expect(stepsFromBatchSettings(["t-a"], { "t-a": "selected" }, ["t-a"])).toEqual([]);
  });
});
