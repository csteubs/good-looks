// Tests for the line differ used by the run-comparison view.

import { describe, expect, it } from "vitest";

import { diffLines, diffSummary } from "./line-diff";

const text = (d: ReturnType<typeof diffLines>) => d.map((l) => `${l.type[0]}:${l.text}`).join("|");

describe("diffLines", () => {
  it("reports identical text as all equal", () => {
    const d = diffLines("a\nb", "a\nb");
    expect(d.every((l) => l.type === "equal")).toBe(true);
  });

  it("detects a pure addition", () => {
    expect(text(diffLines("a", "a\nb"))).toBe("e:a|a:b");
  });

  it("detects a pure removal", () => {
    expect(text(diffLines("a\nb", "a"))).toBe("e:a|r:b");
  });

  it("keeps common lines around a change rather than replacing everything", () => {
    // The point of using an LCS: a one-line edit in the middle should not
    // render as "removed the whole file, added a new one".
    const d = diffLines("a\nb\nc", "a\nX\nc");
    expect(d.filter((l) => l.type === "equal").map((l) => l.text)).toEqual(["a", "c"]);
    expect(d.some((l) => l.type === "remove" && l.text === "b")).toBe(true);
    expect(d.some((l) => l.type === "add" && l.text === "X")).toBe(true);
  });

  it("handles an empty side", () => {
    expect(diffLines("", "a").some((l) => l.type === "add")).toBe(true);
    expect(diffLines("a", "").some((l) => l.type === "remove")).toBe(true);
  });

  it("never loses a line: every input line appears in the output", () => {
    const a = "one\ntwo\nthree\nfour";
    const b = "one\ntwo point five\nthree\nfive";
    const d = diffLines(a, b);
    const kept = d.filter((l) => l.type !== "add").map((l) => l.text);
    const produced = d.filter((l) => l.type !== "remove").map((l) => l.text);
    expect(kept).toEqual(a.split("\n"));
    expect(produced).toEqual(b.split("\n"));
  });
});

describe("diffSummary", () => {
  it("counts additions and removals", () => {
    expect(diffSummary(diffLines("a\nb", "a\nc\nd"))).toEqual({ added: 2, removed: 1 });
  });

  it("counts nothing for identical text", () => {
    expect(diffSummary(diffLines("same", "same"))).toEqual({ added: 0, removed: 0 });
  });
});
