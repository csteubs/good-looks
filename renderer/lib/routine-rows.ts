// The checklist and a Routine, in both directions. docs/ROUTINES.md, REDESIGN §7.1.
//
// §7.1 says "the checklist is unchanged; it is now the open Routine's body",
// and this module is what makes that literally true rather than approximately:
// the Batch view keeps its `order` + `RowOptionsMap` model, its drag handles,
// its engine pills, its master headless toggle — and this translates that model
// to and from `Routine.steps`. Rewriting the checklist against a step array
// would have meant re-testing every one of those behaviours to gain nothing.
//
// THE ASYMMETRY THAT SHAPES ALL OF IT. A checklist row exists for every test in
// the library, ticked or not. A Routine step exists only for a test that is IN
// the job — there is no such thing as an unticked step. So:
//
//   • The ROUTINE is authoritative for what the job contains: which tests, in
//     what order, on which engines, headed or not.
//   • `batchTestOptions` stays as the SCRATCH memory of an unticked row's
//     preferences, which is what it already was. Untick a row that ran on
//     WebKit and tick it again, and the WebKit choice is still there. Without
//     it, unticking would silently discard a choice the user made, and the row
//     would come back on Chromium looking exactly the same as one they had
//     never touched.
//
// Two stores, one authority each, and the split is legible: what the job IS
// lives in the Routine, what the row REMEMBERS lives where it always did. The
// spec keeps those settings keys for a release anyway.
//
// PURE, and tested here rather than through the view, for the reason
// `batch-run-plan.ts` gives: these are the decisions worth asserting, and
// asserting them through React would mean re-testing state plumbing per rule.

import { RUN_BROWSERS } from "./recorder-types";
import { defaultRow, resolveRow } from "./batch-run-plan";
import type { RowDefaults, RowOptionsMap, RowTest } from "./batch-run-plan";
import type { BatchRowOptions, Routine, RoutineStep, RunBrowser } from "./recorder-types";

export interface RoutineRows {
  /** Every test in the library, in the order the checklist should show them. */
  order: string[];
  /** The row each one starts as. */
  rowOptions: RowOptionsMap;
}

/**
 * Open a Routine into the checklist's model.
 *
 * ITS STEPS COME FIRST, IN STEP ORDER, and everything else follows in library
 * order. That is the only arrangement in which the screen reads as the job: a
 * Routine whose four steps are scattered through forty rows is a Routine you
 * cannot see. The remaining rows are still listed rather than hidden, because
 * this is also how a test is ADDED — ticking a row is the gesture, and a
 * separate "add test" picker would be a second vocabulary for one idea.
 *
 * A step whose test is gone is dropped HERE, not rendered as a phantom row: the
 * step is preserved in the store (that is the point of `markTestDeleted`) but
 * this function's output is rows, and there is no test to draw one from. The
 * broken step is surfaced by the editor from `routine.steps` directly.
 */
export function rowsFromRoutine(
  routine: Routine | null,
  tests: readonly RowTest[],
  defaults: RowDefaults,
  remembered: RowOptionsMap = {},
): RoutineRows {
  const byId = new Map(tests.map((t) => [t.id, t]));
  const rowOptions: RowOptionsMap = {};
  const order: string[] = [];
  const placed = new Set<string>();

  for (const step of routine?.steps ?? []) {
    const test = byId.get(step.testId);
    if (!test || placed.has(step.testId)) continue;
    placed.add(step.testId);
    order.push(step.testId);
    rowOptions[step.testId] = {
      selected: true,
      // Filtered THROUGH RUN_BROWSERS so the row's engines are deduped and in
      // canonical order, which is what lets two rows built from different
      // sources compare equal. A step that survives the store always has at
      // least one, but falling back costs a line and the invariant — a row's
      // browsers are never empty — is load-bearing enough to hold here too.
      browsers: enginesOf(step, test, defaults),
      headless: step.headless === true,
    };
  }

  for (const test of tests) {
    if (placed.has(test.id)) continue;
    order.push(test.id);
    // The scratch memory: what this row was set to before it was unticked.
    // `selected` is forced false regardless of what was stored — the Routine is
    // the only thing that decides what is in the job, and a stale `true` here
    // would put a test into a Routine that does not contain it.
    const row = remembered[test.id] ?? defaultRow(test, defaults);
    rowOptions[test.id] = { ...row, selected: false };
  }

  return { order, rowOptions };
}

function enginesOf(step: RoutineStep, test: RowTest, defaults: RowDefaults): RunBrowser[] {
  const wanted = Array.isArray(step.browsers) ? step.browsers : [];
  const browsers = RUN_BROWSERS.filter((b) => wanted.includes(b));
  return browsers.length > 0 ? browsers : defaultRow(test, defaults).browsers;
}

/**
 * The checklist's model back into steps.
 *
 * `previous` is the Routine's current steps, and it is read for ONE thing:
 * `onFailure`. The checklist has no control for a failure policy, so rebuilding
 * from rows alone would reset every step to `continue` the next time anybody
 * ticked a box — quietly turning a "stop the routine if seeding fails" step
 * into one that carries on, which is the failure that policy exists to prevent.
 * A field the editing surface cannot see is a field it must not overwrite.
 */
export function stepsFromRows(
  order: readonly string[],
  rowOptions: RowOptionsMap,
  tests: readonly RowTest[],
  defaults: RowDefaults,
  previous: readonly RoutineStep[] = [],
): RoutineStep[] {
  const byId = new Map(tests.map((t) => [t.id, t]));
  const priorPolicy = new Map(previous.map((s) => [s.testId, s.onFailure]));
  const steps: RoutineStep[] = [];
  const seen = new Set<string>();

  for (const id of order) {
    if (seen.has(id)) continue;
    const test = byId.get(id);
    if (!test) continue;
    const row = resolveRow(test, rowOptions, defaults);
    if (!row.selected) continue;
    seen.add(id);
    steps.push({
      kind: "test",
      testId: id,
      browsers: RUN_BROWSERS.filter((b) => row.browsers.includes(b)),
      headless: row.headless,
      onFailure: priorPolicy.get(id) ?? "continue",
    });
  }
  return steps;
}

/**
 * Do these steps describe the same job?
 *
 * The view commits on every tick, drag and engine click, and a Routine's
 * `updatedAt` is what the list sorts and what a future schedule will compare
 * against. Writing on a change that changed nothing would re-date a job for
 * opening it. Compared FIELD BY FIELD rather than by JSON: key order is not
 * part of the meaning, and two equal jobs serialising differently would defeat
 * the whole check.
 */
export function sameSteps(a: readonly RoutineStep[], b: readonly RoutineStep[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((step, i) => {
    const other = b[i];
    return (
      step.testId === other.testId &&
      step.headless === other.headless &&
      step.onFailure === other.onFailure &&
      step.browsers.length === other.browsers.length &&
      step.browsers.every((br, j) => br === other.browsers[j])
    );
  });
}

/**
 * Steps naming a test the library no longer has, for the editor to render.
 *
 * Returned as STEPS rather than ids because the row has to say what it was —
 * "Login, Chromium + WebKit, deleted" is something a person can act on, and a
 * bare id is something they have to go and look up.
 */
export function brokenSteps(
  routine: Routine | null,
  tests: readonly RowTest[],
): RoutineStep[] {
  const live = new Set(tests.map((t) => t.id));
  return (routine?.steps ?? []).filter((s) => s.testDeleted === true || !live.has(s.testId));
}

/** A row for a test that is not in the Routine — the shape `rowsFromRoutine`
 *  gives an untouched library test. Exported for the view's "select none",
 *  which has to produce the same thing rather than a second opinion of it. */
export function untickedRow(
  test: RowTest,
  defaults: RowDefaults,
  remembered: RowOptionsMap = {},
): BatchRowOptions {
  const row = remembered[test.id] ?? defaultRow(test, defaults);
  return { ...row, selected: false };
}
