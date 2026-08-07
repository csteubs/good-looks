// Tests for the step diff behind the "newly added step" highlight.
//
// The stakes here are that a wrong answer is SILENT and inverted from what the
// user needs: too few marks and an AI-applied change lands invisibly, which is
// the whole failure the highlight exists to prevent; too many and the list
// lights up like a christmas tree and stops meaning anything. Neither throws,
// neither fails a type-check, and both look plausible on screen.
//
// The single most important property is the first block: ids change on every
// apply, so anything that leaks id into the comparison marks the entire list.

import { describe, it, expect } from "vitest";

import { diffSteps, newStepIds, stepSignature } from "./diff-steps";
import type { Step, StepType } from "./recorder-types";

let seq = 0;
/** A step with a fresh, deliberately meaningless id — the way the spec parser
 *  produces them. */
function step(partial: Partial<Step> & { type: StepType }): Step {
  seq += 1;
  return { id: `id-${seq}`, timestamp: seq, ...partial } as Step;
}

const CLICK = { k: "role", role: "button", name: "Submit" } as const;
const OTHER = { k: "role", role: "button", name: "Cancel" } as const;

/** Re-mint every id, as `tests:updateScript` re-parsing the spec does. */
function reparse(steps: Step[]): Step[] {
  return steps.map((s) => ({ ...s, id: `re-${(seq += 1)}`, timestamp: seq }));
}

describe("identity is content, not id", () => {
  it("finds nothing new when the same steps come back with fresh ids", () => {
    // THE load-bearing case. `makeStep` in spec-parser.ts calls randomUUID()
    // for every step on every parse, so after an apply that changed one line
    // all N ids differ. Diffing by id would mark all N steps as added.
    const before = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "click", locator: CLICK }),
      step({ type: "assert", assert: "visible", locator: CLICK }),
    ];
    expect(diffSteps(before, reparse(before))).toEqual({ addedIndexes: [], removedCount: 0 });
  });

  it("ignores timestamp differences", () => {
    const a = step({ type: "click", locator: CLICK });
    const b = { ...a, id: "different", timestamp: a.timestamp + 5000 };
    expect(stepSignature(a)).toBe(stepSignature(b));
  });
});

describe("additions", () => {
  it("marks a step appended to the end", () => {
    const base = [step({ type: "goto", url: "https://example.com" })];
    const after = [...reparse(base), step({ type: "click", locator: CLICK })];
    expect(diffSteps(base, after)).toEqual({ addedIndexes: [1], removedCount: 0 });
  });

  it("marks a step inserted at the front", () => {
    const base = [step({ type: "click", locator: CLICK })];
    const after = [step({ type: "goto", url: "https://example.com" }), ...reparse(base)];
    expect(diffSteps(base, after)).toEqual({ addedIndexes: [0], removedCount: 0 });
  });

  it("marks a step inserted in the middle", () => {
    const first = step({ type: "goto", url: "https://example.com" });
    const last = step({ type: "click", locator: CLICK });
    const after = [
      ...reparse([first]),
      step({ type: "wait", waitMs: 500 }),
      ...reparse([last]),
    ];
    expect(diffSteps([first, last], after)).toEqual({ addedIndexes: [1], removedCount: 0 });
  });

  it("marks several additions at once", () => {
    const base = [step({ type: "goto", url: "https://example.com" })];
    const after = [
      ...reparse(base),
      step({ type: "click", locator: CLICK }),
      step({ type: "assert", assert: "visible", locator: CLICK }),
    ];
    expect(diffSteps(base, after).addedIndexes).toEqual([1, 2]);
  });

  it("marks everything when the list started empty", () => {
    const after = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "click", locator: CLICK }),
    ];
    expect(diffSteps([], after)).toEqual({ addedIndexes: [0, 1], removedCount: 0 });
  });
});

describe("removals", () => {
  it("counts a deleted step and marks nothing new", () => {
    // Deletions get no styling at all — there is no row left to style, and the
    // step count is what communicates them.
    const first = step({ type: "goto", url: "https://example.com" });
    const second = step({ type: "click", locator: CLICK });
    expect(diffSteps([first, second], reparse([first]))).toEqual({
      addedIndexes: [],
      removedCount: 1,
    });
  });

  it("counts every step when the list is emptied", () => {
    const before = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "click", locator: CLICK }),
    ];
    expect(diffSteps(before, [])).toEqual({ addedIndexes: [], removedCount: 2 });
  });

  it("reports nothing for two empty lists", () => {
    expect(diffSteps([], [])).toEqual({ addedIndexes: [], removedCount: 0 });
  });
});

describe("substitutions", () => {
  it("marks the replacement, and only the replacement", () => {
    // A swapped selector is the single most common AI fix. The resulting step
    // is one the user has not seen, so it glows; its neighbours must not.
    const first = step({ type: "goto", url: "https://example.com" });
    const last = step({ type: "assert", assert: "visible", locator: CLICK });
    const before = [first, step({ type: "click", locator: CLICK }), last];
    const after = [
      ...reparse([first]),
      step({ type: "click", locator: OTHER }),
      ...reparse([last]),
    ];
    const diff = diffSteps(before, after);
    expect(diff.addedIndexes).toEqual([1]);
    expect(diff.removedCount).toBe(1);
  });

  it("keeps the count stable across a substitution", () => {
    const before = [step({ type: "click", locator: CLICK })];
    const after = [step({ type: "click", locator: OTHER })];
    expect(after.length).toBe(before.length);
    expect(diffSteps(before, after).addedIndexes).toEqual([0]);
  });
});

describe("reordering is not an addition", () => {
  it("marks nothing when a step moves", () => {
    // Without the move-suppression pass the LCS reports the moved step as one
    // removal plus one addition, and dragging a row would claim the AI added
    // it. This is the assertion that pins that pass.
    const a = step({ type: "goto", url: "https://example.com" });
    const b = step({ type: "click", locator: CLICK });
    const c = step({ type: "assert", assert: "visible", locator: CLICK });
    const after = reparse([c, a, b]);
    expect(diffSteps([a, b, c], after).addedIndexes).toEqual([]);
  });

  it("marks nothing when the whole list is reversed", () => {
    const a = step({ type: "goto", url: "https://example.com" });
    const b = step({ type: "click", locator: CLICK });
    const c = step({ type: "wait", waitMs: 100 });
    expect(diffSteps([a, b, c], reparse([c, b, a])).addedIndexes).toEqual([]);
  });

  it("still marks a genuine addition made in the same pass as a move", () => {
    const a = step({ type: "goto", url: "https://example.com" });
    const b = step({ type: "click", locator: CLICK });
    const fresh = step({ type: "assert", assert: "visible", locator: OTHER });
    const after = [...reparse([b]), fresh, ...reparse([a])];
    // b and a moved; only `fresh` is new.
    const diff = diffSteps([a, b], after);
    expect(diff.addedIndexes.map((i) => after[i].id)).toEqual([fresh.id]);
  });
});

describe("duplicate steps", () => {
  it("does not mark identical existing copies", () => {
    const one = step({ type: "click", locator: CLICK });
    const two = step({ type: "click", locator: CLICK });
    expect(diffSteps([one, two], reparse([one, two])).addedIndexes).toEqual([]);
  });

  it("marks the extra copy when a duplicate is added", () => {
    const one = step({ type: "click", locator: CLICK });
    const after = [...reparse([one]), step({ type: "click", locator: CLICK })];
    expect(diffSteps([one], after).addedIndexes).toEqual([1]);
  });

  it("marks an added copy even when an identical one moved in the same pass", () => {
    // Move-suppression cancels each addition against at most ONE matching
    // removal. A plain `Set.has` would swallow this second copy: the moved
    // step's signature would excuse both, and the genuinely new duplicate
    // would never light up.
    //
    // WHICH of the two identical rows is called the new one is not asserted,
    // because it isn't knowable — the copies are indistinguishable by
    // definition, and the LCS is free to align either one. The count is the
    // real contract: exactly one row glows, not zero and not both.
    const a = step({ type: "goto", url: "https://example.com" });
    const dup = step({ type: "click", locator: CLICK });
    const after = [...reparse([dup]), ...reparse([a]), step({ type: "click", locator: CLICK })];
    const diff = diffSteps([a, dup], after);
    expect(diff.addedIndexes).toHaveLength(1);
    expect(stepSignature(after[diff.addedIndexes[0]])).toBe(stepSignature(dup));
  });
});

describe("signature covers the fields a user can see", () => {
  // Each pair differs in exactly one field. If the signature ignores that
  // field, the edited step reads as unchanged and its highlight never appears —
  // silently, since nothing else in the app consults the signature.
  const cases: Array<[string, Step, Step]> = [
    ["type", step({ type: "click", locator: CLICK }), step({ type: "check", locator: CLICK })],
    ["locator", step({ type: "click", locator: CLICK }), step({ type: "click", locator: OTHER })],
    ["value", step({ type: "fill", value: "a" }), step({ type: "fill", value: "b" })],
    ["url", step({ type: "goto", url: "https://a.test" }), step({ type: "goto", url: "https://b.test" })],
    ["text", step({ type: "assert", assert: "text", text: "a" }), step({ type: "assert", assert: "text", text: "b" })],
    ["assert kind", step({ type: "assert", assert: "visible" }), step({ type: "assert", assert: "hidden" })],
    ["cond", step({ type: "if", cond: "visible" }), step({ type: "if", cond: "hidden" })],
    ["count", step({ type: "assert", assert: "count", count: 1 }), step({ type: "assert", assert: "count", count: 2 })],
    ["waitMs", step({ type: "wait", waitMs: 100 }), step({ type: "wait", waitMs: 200 })],
    ["soft", step({ type: "assert", assert: "visible" }), step({ type: "assert", assert: "visible", soft: true })],
    ["disabled", step({ type: "click", locator: CLICK }), step({ type: "click", locator: CLICK, disabled: true })],
    [
      "continueOnFailure",
      step({ type: "click", locator: CLICK }),
      step({ type: "click", locator: CLICK, continueOnFailure: true }),
    ],
    ["attr", step({ type: "assert", assert: "attribute", attr: "href" }), step({ type: "assert", assert: "attribute", attr: "src" })],
    ["viewport size", step({ type: "viewport", width: 800, height: 600 }), step({ type: "viewport", width: 1024, height: 600 })],
    [
      "cookie",
      step({ type: "cookie", cookieAction: "set", cookie: { name: "a" } }),
      step({ type: "cookie", cookieAction: "set", cookie: { name: "b" } }),
    ],
    [
      "cookie action",
      step({ type: "cookie", cookieAction: "set", cookie: { name: "a" } }),
      step({ type: "cookie", cookieAction: "delete", cookie: { name: "a" } }),
    ],
    ["captureVar", step({ type: "capture", captureVar: "a" }), step({ type: "capture", captureVar: "b" })],
    ["captureFrom", step({ type: "capture", captureVar: "a", captureFrom: "text" }), step({ type: "capture", captureVar: "a", captureFrom: "value" })],
    ["flowId", step({ type: "runFlow", flowId: "a" }), step({ type: "runFlow", flowId: "b" })],
    [
      "flowArgs",
      step({ type: "runFlow", flowId: "a", flowArgs: { x: "1" } }),
      step({ type: "runFlow", flowId: "a", flowArgs: { x: "2" } }),
    ],
    // The two conditional-wait fields. A field missing from the signature is a
    // MISSED highlight, not a wrong one: the step changes, the list stays quiet,
    // and an AI-applied edit lands with nothing marking it.
    [
      "waitUntil",
      step({ type: "wait", waitUntil: "visible", locator: CLICK }),
      step({ type: "wait", waitUntil: "hidden", locator: CLICK }),
    ],
    [
      "timeoutMs",
      step({ type: "wait", waitUntil: "visible", locator: CLICK, timeoutMs: 5000 }),
      step({ type: "wait", waitUntil: "visible", locator: CLICK, timeoutMs: 30000 }),
    ],
    // A conditional wait and the plain element wait it replaced compile to
    // different calls, so they must not read as the same step either.
    [
      "a conditional wait from a plain one",
      step({ type: "wait", locator: CLICK }),
      step({ type: "wait", waitUntil: "hidden", locator: CLICK }),
    ],
  ];

  for (const [field, a, b] of cases) {
    it(`distinguishes ${field}`, () => {
      expect(stepSignature(a)).not.toBe(stepSignature(b));
      expect(diffSteps([a], [b]).addedIndexes).toEqual([0]);
    });
  }

  it("treats flowArgs as order-independent", () => {
    const a = step({ type: "runFlow", flowId: "f", flowArgs: { x: "1", y: "2" } });
    const b = step({ type: "runFlow", flowId: "f", flowArgs: { y: "2", x: "1" } });
    expect(stepSignature(a)).toBe(stepSignature(b));
  });
});

describe("newStepIds", () => {
  it("returns the ids from the AFTER list", () => {
    // The ids that matter are the ones the views will render with — the before
    // list's ids no longer exist anywhere after a re-parse.
    const base = [step({ type: "goto", url: "https://example.com" })];
    const fresh = step({ type: "click", locator: CLICK });
    const after = [...reparse(base), fresh];
    expect(newStepIds(base, after)).toEqual(new Set([fresh.id]));
  });

  it("is empty when nothing changed", () => {
    const base = [step({ type: "click", locator: CLICK })];
    expect(newStepIds(base, reparse(base)).size).toBe(0);
  });

  it("is empty for a pure deletion", () => {
    const first = step({ type: "goto", url: "https://example.com" });
    const before = [first, step({ type: "click", locator: CLICK })];
    expect(newStepIds(before, reparse([first])).size).toBe(0);
  });
});
