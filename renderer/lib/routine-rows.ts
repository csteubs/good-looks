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
import { applyOrder } from "./batch-order";
import { defaultRow, resolveRow } from "./batch-run-plan";
import type { RowDefaults, RowOptionsMap, RowTest } from "./batch-run-plan";
import type {
  BatchRowOptions,
  FailurePolicy,
  Routine,
  RoutineGroupStep,
  RoutineStep,
  RoutineTestStep,
  RoutineWaitStep,
  RunBrowser,
} from "./recorder-types";

/** What a step's failure does to the rest of the job, keyed by test id.
 *
 *  A THIRD MAP RATHER THAN A FIELD ON THE ROW, and the split is the one this
 *  module already draws: `rowOptions` is the checklist's model, and an unticked
 *  row's copy of it is SCRATCH that survives in `batchTestOptions`. A failure
 *  policy is not scratch — it is part of what the job IS, so it belongs to the
 *  Routine and only to the Routine. Putting it on the row would have persisted
 *  a policy for tests that are not in the job, in a settings key the spec says
 *  to delete a release from now. */
export type PolicyMap = Record<string, FailurePolicy>;

/**
 * The next failure policy when the row's control is clicked.
 *
 * A CYCLE, not a menu, because there are two or three states and a menu for
 * three is heavier than the thing it selects. The cycle DEPENDS on whether the
 * row is in a group: `skipGroup` outside one has no rest-of-group to skip, so
 * offering it would be offering a setting that does nothing — the run degrades
 * it to `continue`, and a control whose value the run quietly ignores is worse
 * than a control that never offered it.
 *
 * An unrecognised stored value lands on `continue` for the same reason
 * `failurePolicy` normalises: this is what the click produces next, and it must
 * not depend on a value the app could not have written.
 */
export function nextPolicy(current: FailurePolicy | undefined, inGroup: boolean): FailurePolicy {
  if (current === "stopRoutine") return inGroup ? "skipGroup" : "continue";
  if (current === "skipGroup") return "continue";
  return "stopRoutine";
}

/** What the row's policy control says. Exported so the view and its test agree
 *  on one spelling rather than two. */
export const POLICY_LABELS: Record<FailurePolicy, string> = {
  continue: "Carry on",
  stopRoutine: "Stop on fail",
  skipGroup: "Skip group",
};

/**
 * How many TESTS a Routine holds, counting inside its groups.
 *
 * `steps.length` is not this number and stopped being it the moment groups
 * landed: a group is one entry holding many. The rail said "1 test" for a
 * Routine of two the first time this was rendered, which is the whole reason
 * this is a named function rather than a `.length` at the call site.
 */
export function testCount(routine: { steps: readonly RoutineStep[] } | null | undefined): number {
  return (routine?.steps ?? []).reduce((n, s) => {
    if (s.kind === "group") return n + s.steps.length;
    // A `wait` is not a test. Counting one would make the rail promise a run
    // that never happens — the same class of lie as the group case above,
    // which is why this is a switch rather than an `=== "group"` ternary.
    return n + (s.kind === "test" ? 1 : 0);
  }, 0);
}

/** A group, without its members — who belongs to it lives in `GroupOf`, keyed
 *  the same way `PolicyMap` is. Kept apart from the membership map so a group
 *  survives having its last member unticked long enough for the user to put
 *  another one in; the STORE drops an empty group, which is the right place for
 *  that rule because it is about what can be saved, not about what can be
 *  edited. */
export interface RoutineGroup {
  id: string;
  label: string;
}

/** Which group each test in the job belongs to. Absent = top level. */
export type GroupOf = Record<string, string>;

/** A pause, pinned to the row it follows.
 *
 *  `after` is a TEST ID rather than an index, for the reason the whole module
 *  keeps `order` flat: an index would have to be rewritten on every drag, and a
 *  wait that drifted one row when something above it moved would silently gate
 *  a different set of steps. `""` means the wait leads — it runs before
 *  anything. */
export interface RoutineWait {
  id: string;
  ms: number;
  after: string;
}

export interface RoutineRows {
  /** Every test in the library, in the order the checklist should show them. */
  order: string[];
  /** The row each one starts as. */
  rowOptions: RowOptionsMap;
  /** The failure policy of each test that is IN the Routine. A test absent
   *  here has none, which is not the same as having `continue`: it is not in
   *  the job at all. */
  policies: PolicyMap;
  /** The Routine's groups, in the order they appear in it. */
  groups: RoutineGroup[];
  /** Which group each grouped test belongs to. */
  groupOf: GroupOf;
  /** The Routine's `wait` steps, each pinned to the row it follows. */
  waits: RoutineWait[];
}

/**
 * The test a step at `index` follows, for pinning a `wait` back to a row.
 *
 * Walks BACKWARDS and reaches into a group for its last member, because that is
 * the row actually drawn above the wait — pinning to the group would name
 * something `order` does not contain, and the wait would render nowhere.
 * Returns `""` when nothing precedes it, which is what marks a leading wait.
 */
export function lastTestIdBefore(steps: readonly RoutineStep[], index: number): string {
  for (let i = index - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === "group") {
      const last = s.steps[s.steps.length - 1];
      if (last) return last.testId;
      continue;
    }
    if (s.kind === "test") return s.testId;
  }
  return "";
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
  /** The library's own arrangement, `batchOrder`. Scratch, like `remembered`
   *  and for the same reason: a Routine's order covers the tests IN it, so
   *  without this a row dragged while unticked would snap back to library order
   *  on the next reload — a rearrangement silently undone, which is worse than
   *  one that was never offered. */
  libraryOrder: readonly string[] = [],
): RoutineRows {
  const byId = new Map(tests.map((t) => [t.id, t]));
  const rowOptions: RowOptionsMap = {};
  const policies: PolicyMap = {};
  const groups: RoutineGroup[] = [];
  const groupOf: GroupOf = {};
  const waits: RoutineWait[] = [];
  const order: string[] = [];
  const placed = new Set<string>();

  // FLATTENED, exactly as `routineRunPlan` flattens it, and for the same
  // reason: `order` is the one list the checklist draws, and a group is
  // structure over that order rather than a second ordering of it. The nesting
  // is redrawn from `groupOf` at render time, so drag-to-reorder keeps working
  // on a flat list and a member dragged out of its group's run of rows simply
  // stops being contiguous — which `stepsFromRows` then reads as leaving it.
  const flat: { step: RoutineTestStep; groupId: string }[] = [];
  for (const step of routine?.steps ?? []) {
    if (step.kind === "wait") {
      // A wait is NOT A ROW. It has no test to draw one from, so it is carried
      // as its own list and rendered between rows — the same shape a group
      // header takes, and for the same reason: `order` stays a flat list of
      // test ids so drag-to-reorder never has to learn about anything else.
      // Pinned to the step BEFORE it, read from `flat` rather than from `order`
      // — `order` is not built until the loop below, so reading it here would
      // pin every wait to "" and quietly turn them all into leading ones.
      waits.push({ id: step.id, ms: step.ms, after: flat[flat.length - 1]?.step.testId ?? "" });
      continue;
    }
    if (step.kind === "group") {
      groups.push({ id: step.id, label: step.label });
      for (const child of step.steps) flat.push({ step: child, groupId: step.id });
      continue;
    }
    flat.push({ step, groupId: "" });
  }

  for (const { step, groupId } of flat) {
    const test = byId.get(step.testId);
    if (!test || placed.has(step.testId)) continue;
    placed.add(step.testId);
    order.push(step.testId);
    if (groupId) groupOf[step.testId] = groupId;
    // Read back as stored, NOT normalised. The runner normalises what it acts
    // on (see `failurePolicy` in shared/routine-plan.mjs); an editor that
    // quietly rewrote a value it did not understand would re-date the Routine
    // and discard whatever a future release wrote there.
    policies[step.testId] = step.onFailure ?? "continue";
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

  // Everything not in the Routine, arranged by `applyOrder` — the SAME rule the
  // checklist has always used, rather than a second one written here. That rule
  // carries two behaviours worth keeping: a stored id the library no longer has
  // is ignored, and a test recorded SINCE the order was saved leads rather than
  // trailing (on a library of any size, a just-recorded test off the bottom
  // reads as not having been created at all).
  const rest = applyOrder(
    tests.filter((t) => !placed.has(t.id)),
    [...libraryOrder],
  );
  for (const test of rest) {
    placed.add(test.id);
    order.push(test.id);
    // The scratch memory: what this row was set to before it was unticked.
    // `selected` is forced false regardless of what was stored — the Routine is
    // the only thing that decides what is in the job, and a stale `true` here
    // would put a test into a Routine that does not contain it.
    const row = remembered[test.id] ?? defaultRow(test, defaults);
    rowOptions[test.id] = { ...row, selected: false };
  }

  // A group whose every member was dropped (its tests are gone from the
  // library) is dropped too. It cannot be rendered — there is no row to nest
  // under it — and the store would refuse to keep it anyway.
  const live = new Set(Object.values(groupOf));
  // A wait pinned to a test the library no longer has is re-pinned to "" —
  // leading — rather than dropped. Dropping it would silently shorten a job;
  // leaving it pointing at a row that is not drawn would render it nowhere,
  // which looks the same as dropping it and is harder to notice.
  const drawn = new Set(order);
  return {
    order,
    rowOptions,
    policies,
    groups: groups.filter((g) => live.has(g.id)),
    groupOf,
    waits: waits.map((w) => (w.after === "" || drawn.has(w.after) ? w : { ...w, after: "" })),
  };
}

function enginesOf(step: RoutineTestStep, test: RowTest, defaults: RowDefaults): RunBrowser[] {
  const wanted = Array.isArray(step.browsers) ? step.browsers : [];
  const browsers = RUN_BROWSERS.filter((b) => wanted.includes(b));
  return browsers.length > 0 ? browsers : defaultRow(test, defaults).browsers;
}

/**
 * The checklist's model back into steps.
 *
 * `policies` is the third map, and it used to be `previous` — the Routine's own
 * steps, read for the one field the checklist had no control for. The rule then
 * was that a field the editing surface cannot see is a field it must not
 * overwrite; now the surface CAN see it, so the policy round-trips like every
 * other choice and there is one authority for it instead of two.
 *
 * A policy for a test that is not ticked is DROPPED rather than kept, and that
 * is deliberate asymmetry with `rowOptions`: an unticked row's engines are
 * scratch worth remembering, but a policy is a statement about a job this test
 * is no longer part of. Keeping it would mean re-ticking a row silently
 * re-arming "stop the whole routine if this fails".
 */
export function stepsFromRows(
  order: readonly string[],
  rowOptions: RowOptionsMap,
  tests: readonly RowTest[],
  defaults: RowDefaults,
  policies: PolicyMap = {},
  groups: readonly RoutineGroup[] = [],
  groupOf: GroupOf = {},
  waits: readonly RoutineWait[] = [],
): RoutineStep[] {
  const byId = new Map(tests.map((t) => [t.id, t]));
  const labels = new Map(groups.map((g) => [g.id, g.label]));
  const steps: RoutineStep[] = [];
  const seen = new Set<string>();
  // Waits by the row they follow. A row can carry more than one — nothing stops
  // two pauses in a row, and collapsing them silently would lose time the user
  // asked for.
  const waitsAfter = new Map<string, RoutineWait[]>();
  for (const w of waits) {
    const list = waitsAfter.get(w.after);
    if (list) list.push(w);
    else waitsAfter.set(w.after, [w]);
  }
  const emitWaitsAfter = (id: string): void => {
    for (const w of waitsAfter.get(id) ?? []) steps.push({ kind: "wait", id: w.id, ms: w.ms });
  };
  // A LEADING wait is emitted before anything, including before the group its
  // first member opens. `""` is the only key that can mean this, because a
  // Routine's first step has no predecessor to be pinned to.
  emitWaitsAfter("");
  // A group is emitted at the position of its FIRST member and collects every
  // later member into itself. That is what turns the checklist's flat order
  // back into nesting without a second ordering to keep in sync — and it means
  // a member dragged away from its siblings does not tear the group in two, it
  // just moves within it. Rendering nests the same way, so the two agree.
  const open = new Map<string, RoutineGroupStep>();

  for (const id of order) {
    if (seen.has(id)) continue;
    const test = byId.get(id);
    if (!test) continue;
    const row = resolveRow(test, rowOptions, defaults);
    if (!row.selected) continue;
    seen.add(id);
    const step: RoutineTestStep = {
      kind: "test",
      testId: id,
      browsers: RUN_BROWSERS.filter((b) => row.browsers.includes(b)),
      headless: row.headless,
      onFailure: policies[id] ?? "continue",
    };
    // A membership naming a group that is not in `groups` is treated as no
    // membership rather than inventing one. The store would drop a group with
    // no label anyway, and a step silently sorted into a group nobody can see
    // is a `skipGroup` that takes out rows for a reason not on screen.
    const groupId = groupOf[id];
    if (!groupId || !labels.has(groupId)) {
      steps.push(step);
      emitWaitsAfter(id);
      continue;
    }
    const existing = open.get(groupId);
    if (existing) {
      existing.steps.push(step);
      // A wait pinned to a row INSIDE a group lands after the group, not inside
      // it: a group holds test steps only (v1), and the barrier's meaning —
      // everything before it finishes — is the same either way. Emitting it
      // inside would be a shape the store drops, so the screen and the stored
      // job would disagree.
      emitWaitsAfter(id);
      continue;
    }
    const group: RoutineGroupStep = {
      kind: "group",
      id: groupId,
      label: labels.get(groupId) ?? "",
      steps: [step],
    };
    open.set(groupId, group);
    steps.push(group);
    emitWaitsAfter(id);
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
    if (step.kind !== other.kind) return false;
    // Recursive for a group, so renaming one or moving a test between two
    // counts as a change. Comparing only the members would call a rename
    // "unchanged" and never write it; comparing only the label would miss a
    // test moving between groups, which changes what `skipGroup` takes out.
    if (step.kind === "group") {
      const o = other as RoutineGroupStep;
      return step.id === o.id && step.label === o.label && sameSteps(step.steps, o.steps);
    }
    // A wait's LENGTH is part of what the job is: changing 30s to 5m is an edit
    // worth a write, and comparing only the id would call it unchanged.
    if (step.kind === "wait") {
      const o = other as RoutineWaitStep;
      return step.id === o.id && step.ms === o.ms;
    }
    const o = other as RoutineTestStep;
    return (
      step.testId === o.testId &&
      step.headless === o.headless &&
      step.onFailure === o.onFailure &&
      step.browsers.length === o.browsers.length &&
      step.browsers.every((br, j) => br === o.browsers[j])
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
): RoutineTestStep[] {
  const live = new Set(tests.map((t) => t.id));
  // Reaches INSIDE groups. A broken step nested in one is exactly as invisible
  // as a broken step at the top level — more so, since the group still renders
  // and simply runs one test fewer than it lists.
  const flat = (routine?.steps ?? []).flatMap<RoutineTestStep>((s) =>
    s.kind === "group" ? s.steps : s.kind === "test" ? [s] : [],
  );
  return flat.filter((s) => s.testDeleted === true || !live.has(s.testId));
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
