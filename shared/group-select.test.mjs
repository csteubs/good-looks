// Resolving a group's membership.
//
// This is the function that decides what "Run group" actually runs, and every
// way of getting it wrong is quiet: resolve too few and a suite silently stops
// covering something, resolve too many and a click runs the whole library.
// Both look like a working group in the sidebar.

import { describe, expect, it } from "vitest";

import { countGroupTests, resolveGroupTests } from "./group-select.mjs";

const LIBRARY = [
  { id: "a", tags: ["Smoke", "Checkout"] },
  { id: "b", tags: ["smoke"] },
  { id: "c", tags: ["Nightly"] },
  { id: "d" },
];

describe("resolveGroupTests", () => {
  it("resolves tests named outright", () => {
    expect(resolveGroupTests({ testIds: ["a", "d"] }, LIBRARY).map((t) => t.id)).toEqual(["a", "d"]);
  });

  it("resolves tests by tag, ignoring case", () => {
    // "Smoke" and "smoke" are the same tag everywhere else in the app; a group
    // that missed one would drop a test for a reason invisible on screen.
    expect(resolveGroupTests({ tags: ["SMOKE"] }, LIBRARY).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("unions the two rules without repeating a test that matches both", () => {
    const ids = resolveGroupTests({ testIds: ["a"], tags: ["smoke"] }, LIBRARY).map((t) => t.id);
    expect(ids).toEqual(["a", "b"]);
  });

  it("returns tests in library order, not in the order they were named", () => {
    // The batch runs in this order, and the Batch view lists it. An order that
    // depended on how the group was edited would shuffle under the user.
    expect(resolveGroupTests({ testIds: ["d", "a"] }, LIBRARY).map((t) => t.id)).toEqual(["a", "d"]);
  });

  it("ignores an id whose test has been deleted", () => {
    // The reason membership is resolved rather than stored: a stale id must
    // resolve to nothing, not to a run the runner then fails to start.
    expect(resolveGroupTests({ testIds: ["a", "gone"] }, LIBRARY).map((t) => t.id)).toEqual(["a"]);
  });

  it("resolves EMPTY for a group that names nothing", () => {
    // The dangerous default. "No rules" must never mean "everything" — that
    // turns one careless click into a full-suite run.
    expect(resolveGroupTests({}, LIBRARY)).toEqual([]);
    expect(resolveGroupTests({ testIds: [], tags: [] }, LIBRARY)).toEqual([]);
  });

  it("resolves empty for a tag nothing carries", () => {
    expect(resolveGroupTests({ tags: ["nope"] }, LIBRARY)).toEqual([]);
  });

  it("survives a null group and a null library", () => {
    expect(resolveGroupTests(null, LIBRARY)).toEqual([]);
    expect(resolveGroupTests({ testIds: ["a"] }, null)).toEqual([]);
  });

  it("skips malformed library entries rather than throwing", () => {
    const messy = [null, { noId: true }, { id: "a", tags: ["smoke"] }];
    expect(resolveGroupTests({ tags: ["smoke"] }, messy).map((t) => t.id)).toEqual(["a"]);
  });

  it("ignores a non-string tag on a test", () => {
    const messy = [{ id: "a", tags: [null, 7, "smoke"] }];
    expect(resolveGroupTests({ tags: ["smoke"] }, messy).map((t) => t.id)).toEqual(["a"]);
  });

  it("matches a tag written with surrounding whitespace", () => {
    expect(resolveGroupTests({ tags: ["  smoke  "] }, LIBRARY).map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("countGroupTests", () => {
  it("counts what would run", () => {
    expect(countGroupTests({ tags: ["smoke"] }, LIBRARY)).toBe(2);
  });

  it("counts an empty group as zero, matching what resolve returns", () => {
    // The sidebar disables Run on 0. If these two ever disagreed, the button
    // would be enabled for a group with nothing in it.
    expect(countGroupTests({}, LIBRARY)).toBe(0);
  });
});
