import { describe, expect, it } from "vitest";

import {
  applyHeadlessToAll,
  buildRunPlan,
  pruneRowOptions,
  resolveRow,
  resultKeyOf,
  rowOptionsAreStale,
  rowStatus,
  selectionState,
  setRow,
  setSelection,
  toggleRowBrowser,
  type RowOptionsMap,
} from "./batch-run-plan";

const NO_DEFAULTS = {};

describe("resolveRow", () => {
  it("starts a test the view has never seen UNTICKED", () => {
    // The behaviour change users notice first. A newly recorded test used to
    // arrive ticked and join the next "Run all" without being asked.
    expect(resolveRow({ id: "a" }, {}, NO_DEFAULTS).selected).toBe(false);
  });

  it("pre-selects the test's own engine over the global default", () => {
    const row = resolveRow({ id: "a", runBrowser: "webkit" }, {}, { defaultRunBrowser: "firefox" });
    expect(row.browsers).toEqual(["webkit"]);
  });

  it("falls back to the global default when the test has no engine of its own", () => {
    expect(resolveRow({ id: "a" }, {}, { defaultRunBrowser: "firefox" }).browsers).toEqual([
      "firefox",
    ]);
  });

  it("falls back to chromium when nothing is configured at all", () => {
    expect(resolveRow({ id: "a" }, {}, NO_DEFAULTS).browsers).toEqual(["chromium"]);
  });

  it("takes headedness from the global default", () => {
    expect(resolveRow({ id: "a" }, {}, { defaultRunHeadless: true }).headless).toBe(true);
    expect(resolveRow({ id: "a" }, {}, { defaultRunHeadless: false }).headless).toBe(false);
  });

  it("prefers a stored row over every default", () => {
    const stored: RowOptionsMap = {
      a: { selected: true, browsers: ["firefox"], headless: true },
    };
    const row = resolveRow({ id: "a", runBrowser: "webkit" }, stored, {
      defaultRunBrowser: "chromium",
      defaultRunHeadless: false,
    });
    expect(row).toEqual({ selected: true, browsers: ["firefox"], headless: true });
  });
});

describe("toggleRowBrowser", () => {
  it("adds an engine", () => {
    expect(toggleRowBrowser(["chromium"], "webkit")).toEqual(["chromium", "webkit"]);
  });

  it("removes an engine when others remain", () => {
    expect(toggleRowBrowser(["chromium", "firefox"], "chromium")).toEqual(["firefox"]);
  });

  it("REFUSES to remove the last engine", () => {
    // An empty array is a ticked test that produces no queue entries: the batch
    // silently runs fewer tests than the toolbar promised, with no error and no
    // skipped row to explain it.
    expect(toggleRowBrowser(["firefox"], "firefox")).toEqual(["firefox"]);
  });

  it("normalises to RUN_BROWSERS order regardless of click order", () => {
    let browsers = toggleRowBrowser(["webkit"], "chromium");
    browsers = toggleRowBrowser(browsers, "firefox");
    expect(browsers).toEqual(["chromium", "firefox", "webkit"]);
  });

  it("never duplicates an engine already present", () => {
    expect(toggleRowBrowser(["chromium", "firefox"], "webkit")).toEqual([
      "chromium",
      "firefox",
      "webkit",
    ]);
  });
});

describe("setRow", () => {
  it("materialises a row from the defaults before patching it", () => {
    const next = setRow({}, { id: "a", runBrowser: "webkit" }, {}, { selected: true });
    expect(next.a).toEqual({ selected: true, browsers: ["webkit"], headless: false });
  });

  it("does not mutate the map it was given", () => {
    const stored: RowOptionsMap = {};
    setRow(stored, { id: "a" }, {}, { selected: true });
    expect(stored).toEqual({});
  });

  it("keeps the previous engines when a caller patches browsers to empty", () => {
    const stored: RowOptionsMap = {
      a: { selected: true, browsers: ["firefox"], headless: false },
    };
    const next = setRow(stored, { id: "a" }, {}, { browsers: [] });
    expect(next.a.browsers).toEqual(["firefox"]);
  });
});

describe("setSelection", () => {
  it("ticks only the tests it was given, leaving the rest alone", () => {
    const stored = setSelection({}, [{ id: "a" }, { id: "b" }], {}, true);
    const next = setSelection(stored, [{ id: "a" }], {}, false);
    expect(next.a.selected).toBe(false);
    expect(next.b.selected).toBe(true);
  });
});

describe("selectionState", () => {
  // What the checklist's master tick draws. The three states have to be
  // distinguishable, because "some" is the only one that tells the user there
  // are ticks they cannot currently see the whole of.
  const TESTS = [{ id: "a" }, { id: "b" }];

  it("is none when a test has never been touched", () => {
    // A row with no stored entry falls back to the defaults, which start
    // UNTICKED — so an untouched library must not draw a ticked master.
    expect(selectionState({}, TESTS, NO_DEFAULTS)).toBe("none");
  });

  it("is all only when every test handed to it is ticked", () => {
    const half = setSelection({}, [{ id: "a" }], NO_DEFAULTS, true);
    expect(selectionState(half, TESTS, NO_DEFAULTS)).toBe("some");
    expect(selectionState(setSelection(half, TESTS, NO_DEFAULTS, true), TESTS, NO_DEFAULTS)).toBe(
      "all",
    );
  });

  it("answers over the tests it was given, not over the map", () => {
    // The property the filter case depends on: under a tag filter the visible
    // list is a subsequence, and a master computed over everything stored would
    // say "some" while every row on screen was ticked.
    const stored = setSelection({}, [{ id: "a" }], NO_DEFAULTS, true);
    expect(selectionState(stored, [{ id: "a" }], NO_DEFAULTS)).toBe("all");
    expect(selectionState(stored, TESTS, NO_DEFAULTS)).toBe("some");
  });

  it("is none for an empty list", () => {
    // A tag that matches nothing. "all" over zero tests would draw a ticked box
    // above an empty checklist.
    expect(selectionState({}, [], NO_DEFAULTS)).toBe("none");
  });
});

describe("applyHeadlessToAll", () => {
  it("overwrites rows the user had already set", () => {
    const stored: RowOptionsMap = {
      a: { selected: true, browsers: ["chromium"], headless: false },
    };
    expect(applyHeadlessToAll(stored, [{ id: "a" }], {}, true).a.headless).toBe(true);
  });

  it("MATERIALISES rows for tests that have no stored entry", () => {
    // Without this the master silently fails to apply to exactly the rows the
    // user never touched — which look identical on screen to the ones it did
    // apply to, because both were showing the same default.
    const next = applyHeadlessToAll({}, [{ id: "a" }, { id: "b" }], {}, true);
    expect(next.a.headless).toBe(true);
    expect(next.b.headless).toBe(true);
  });

  it("leaves engines and selection untouched", () => {
    const stored: RowOptionsMap = {
      a: { selected: true, browsers: ["firefox", "webkit"], headless: false },
    };
    const next = applyHeadlessToAll(stored, [{ id: "a" }], {}, true);
    expect(next.a.selected).toBe(true);
    expect(next.a.browsers).toEqual(["firefox", "webkit"]);
  });
});

describe("pruneRowOptions", () => {
  it("drops entries for tests that no longer exist", () => {
    const stored: RowOptionsMap = {
      a: { selected: true, browsers: ["chromium"], headless: false },
      gone: { selected: true, browsers: ["chromium"], headless: false },
    };
    expect(Object.keys(pruneRowOptions(stored, ["a"]))).toEqual(["a"]);
  });

  it("reports staleness only when an id has no matching test", () => {
    const stored: RowOptionsMap = {
      a: { selected: true, browsers: ["chromium"], headless: false },
    };
    expect(rowOptionsAreStale(stored, ["a", "b"])).toBe(false);
    expect(rowOptionsAreStale(stored, ["b"])).toBe(true);
  });
});

describe("buildRunPlan", () => {
  const tests = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("includes only ticked tests, in the order given", () => {
    const stored: RowOptionsMap = {
      c: { selected: true, browsers: ["chromium"], headless: false },
      a: { selected: true, browsers: ["chromium"], headless: false },
      b: { selected: false, browsers: ["chromium"], headless: false },
    };
    expect(buildRunPlan(tests, stored, {}).testIds).toEqual(["a", "c"]);
  });

  it("counts one run per engine, not one per test", () => {
    const stored: RowOptionsMap = {
      a: { selected: true, browsers: ["chromium", "firefox", "webkit"], headless: false },
      b: { selected: true, browsers: ["chromium", "webkit"], headless: false },
      c: { selected: true, browsers: ["firefox"], headless: false },
    };
    const plan = buildRunPlan(tests, stored, {});
    expect(plan.testIds).toHaveLength(3);
    expect(plan.plannedRuns).toBe(6);
  });

  it("carries each row's engines and headedness into perTest", () => {
    const stored: RowOptionsMap = {
      a: { selected: true, browsers: ["firefox", "webkit"], headless: true },
    };
    expect(buildRunPlan(tests, stored, {}).perTest).toEqual([
      { testId: "a", browsers: ["firefox", "webkit"], headless: true },
    ]);
  });

  it("reports allHeadless false when a single selected row is headed", () => {
    const stored: RowOptionsMap = {
      a: { selected: true, browsers: ["chromium"], headless: true },
      b: { selected: true, browsers: ["chromium"], headless: false },
    };
    expect(buildRunPlan(tests, stored, {}).allHeadless).toBe(false);
  });

  it("ignores a headed row that is NOT selected", () => {
    // The warning is about windows that will actually open.
    const stored: RowOptionsMap = {
      a: { selected: true, browsers: ["chromium"], headless: true },
      b: { selected: false, browsers: ["chromium"], headless: false },
    };
    expect(buildRunPlan(tests, stored, {}).allHeadless).toBe(true);
  });

  it("plans nothing when the library has never been touched", () => {
    const plan = buildRunPlan(tests, {}, {});
    expect(plan.testIds).toEqual([]);
    expect(plan.plannedRuns).toBe(0);
  });

  it("uses each test's own engine for rows the user only ticked", () => {
    let stored: RowOptionsMap = {};
    const library = [{ id: "a", runBrowser: "webkit" as const }, { id: "b" }];
    stored = setSelection(stored, library, { defaultRunBrowser: "firefox" }, true);
    expect(buildRunPlan(library, stored, { defaultRunBrowser: "firefox" }).perTest).toEqual([
      { testId: "a", browsers: ["webkit"], headless: false },
      { testId: "b", browsers: ["firefox"], headless: false },
    ]);
  });
});

describe("resultKeyOf", () => {
  it("distinguishes two engines of the same test", () => {
    const a = resultKeyOf({ testId: "t", browser: "chromium" });
    const b = resultKeyOf({ testId: "t", browser: "webkit" });
    expect(a).not.toBe(b);
  });

  it("distinguishes two dataset rows on the same engine", () => {
    const a = resultKeyOf({ testId: "t", browser: "chromium", datasetId: "d1" });
    const b = resultKeyOf({ testId: "t", browser: "chromium", datasetId: "d2" });
    expect(a).not.toBe(b);
  });

  it("keys a result with no engine (a pre-fan-out history record) stably", () => {
    expect(resultKeyOf({ testId: "t" })).toBe(resultKeyOf({ testId: "t" }));
  });
});

describe("rowStatus", () => {
  it("returns null for a row with no results yet", () => {
    expect(rowStatus([])).toBeNull();
  });

  it("leads with running even when another engine has already passed", () => {
    // An early pass on a row still in flight reads as finished.
    expect(rowStatus([{ status: "passed" }, { status: "running" }])).toBe("running");
  });

  it("leads with failed over passed and skipped", () => {
    expect(rowStatus([{ status: "passed" }, { status: "failed" }, { status: "skipped" }])).toBe(
      "failed",
    );
  });

  it("reports passed only when every result passed", () => {
    expect(rowStatus([{ status: "passed" }, { status: "passed" }])).toBe("passed");
  });

  it("prefers a settled result over a pending one", () => {
    expect(rowStatus([{ status: "pending" }, { status: "passed" }])).toBe("passed");
  });
});
