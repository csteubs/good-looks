// The trainer's multi-selection and the extraction rule. Every failure here is
// silent: a wrong range still highlights something, and a bad extraction
// builds a flow whose generated block is unbalanced.

import { describe, expect, it } from "vitest";

import {
  emptySelection,
  extractableRange,
  pruneSelection,
  selectionAfterClick,
} from "./step-selection";

const steps = (types: string[]) => types.map((type, i) => ({ id: `s${i}`, type }));

describe("selectionAfterClick", () => {
  const list = steps(["goto", "click", "fill", "click", "assert"]);

  it("plain click selects one row and anchors it", () => {
    const next = selectionAfterClick(emptySelection(), list, "s2");
    expect(next).toEqual({ ids: ["s2"], anchorId: "s2" });
  });

  it("toggle adds and removes, keeping ids in LIST order", () => {
    let sel = selectionAfterClick(emptySelection(), list, "s3");
    sel = selectionAfterClick(sel, list, "s1", { toggle: true });
    // Clicked s3 then s1, but the ids read down the list — extraction keeps
    // the recording's order, whatever order the clicks came in.
    expect(sel.ids).toEqual(["s1", "s3"]);
    sel = selectionAfterClick(sel, list, "s3", { toggle: true });
    expect(sel.ids).toEqual(["s1"]);
  });

  it("removing the anchor hands the anchor to the last remaining row", () => {
    let sel = selectionAfterClick(emptySelection(), list, "s1");
    sel = selectionAfterClick(sel, list, "s3", { toggle: true });
    expect(sel.anchorId).toBe("s3");
    sel = selectionAfterClick(sel, list, "s3", { toggle: true });
    expect(sel.anchorId).toBe("s1");
  });

  it("shift selects the whole run between the anchor and the click, both directions", () => {
    let sel = selectionAfterClick(emptySelection(), list, "s1");
    sel = selectionAfterClick(sel, list, "s3", { shift: true });
    expect(sel.ids).toEqual(["s1", "s2", "s3"]);
    expect(sel.anchorId).toBe("s1");
    sel = selectionAfterClick(sel, list, "s0", { shift: true });
    expect(sel.ids).toEqual(["s0", "s1"]);
  });

  it("shift with no anchor degrades to a plain click", () => {
    const next = selectionAfterClick(emptySelection(), list, "s2", { shift: true });
    expect(next).toEqual({ ids: ["s2"], anchorId: "s2" });
  });
});

describe("pruneSelection", () => {
  it("drops ids the rebroadcast list no longer holds", () => {
    const before = steps(["goto", "click", "fill"]);
    let sel = selectionAfterClick(emptySelection(), before, "s1");
    sel = selectionAfterClick(sel, before, "s2", { toggle: true });
    const after = steps(["goto", "fill"]).map((s, i) => ({ ...s, id: i === 0 ? "s0" : "s2" }));
    const pruned = pruneSelection(sel, after);
    expect(pruned.ids).toEqual(["s2"]);
    expect(pruned.anchorId).toBe("s2");
  });

  it("returns the same object when nothing changed, so React sees no update", () => {
    const list = steps(["goto", "click"]);
    const sel = selectionAfterClick(emptySelection(), list, "s1");
    expect(pruneSelection(sel, list)).toBe(sel);
  });
});

describe("extractableRange", () => {
  it("accepts a contiguous, balanced run", () => {
    const list = steps(["goto", "click", "fill", "assert"]);
    expect(extractableRange(list, ["s1", "s2"])).toEqual({ ok: true, start: 1, end: 2 });
  });

  it("refuses a gapped selection", () => {
    const list = steps(["goto", "click", "fill", "assert"]);
    const verdict = extractableRange(list, ["s1", "s3"]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/contiguous/);
  });

  it("refuses a selection that splits an if / end if block, in both directions", () => {
    const list = steps(["goto", "if", "click", "endif", "assert"]);
    // The `if` without its `endif`...
    expect(extractableRange(list, ["s1", "s2"]).ok).toBe(false);
    // ...and the `endif` without its `if`.
    expect(extractableRange(list, ["s2", "s3"]).ok).toBe(false);
    // The whole block is fine.
    expect(extractableRange(list, ["s1", "s2", "s3"]).ok).toBe(true);
  });

  it("accepts a nested runFlow inside the selection — flows nest", () => {
    const list = steps(["goto", "runFlow", "click"]);
    expect(extractableRange(list, ["s1", "s2"]).ok).toBe(true);
  });

  it("refuses an empty selection and one naming missing steps", () => {
    const list = steps(["goto", "click"]);
    expect(extractableRange(list, []).ok).toBe(false);
    expect(extractableRange(list, ["s1", "ghost"]).ok).toBe(false);
  });
});
