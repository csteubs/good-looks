// The two rule-grained baseline ops the Accessibility view added.
//
// `acceptRuleA11y` is the one with a sharp edge: it must pin ONLY the named
// rule's keys. The step/run accepts sign off everything a step reported, and
// reusing their key collection here would make "accept color-contrast
// everywhere" quietly accept every other rule sharing a step with it — the
// silent over-acceptance this feature exists to avoid. `revokeA11yRule` is the
// inverse edge: remove one rule's keys and nothing else.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const tests = new Map<string, Record<string, unknown>>();
  const replays = new Map<string, unknown>();
  const written: string[] = [];
  let runList: unknown[] = [];
  return {
    tests,
    replays,
    written,
    getRuns: () => runList,
    setRuns: (r: unknown[]) => {
      runList = r;
    },
  };
});

vi.mock("./test-store.js", () => ({
  testStore: {
    get: (id: string) => h.tests.get(id) ?? null,
    save: (rec: { id: string }) => {
      h.tests.set(rec.id, rec);
    },
  },
}));
vi.mock("./artifact-store.js", () => ({
  artifactStore: {
    readReplay: (t: string, r: string) => h.replays.get(`${t}:${r}`) ?? null,
    writeReplay: (t: string, r: string, replay: unknown) => {
      h.replays.set(`${t}:${r}`, replay);
      h.written.push(`${t}:${r}`);
    },
  },
}));
vi.mock("./run-history-store.js", () => ({
  runHistoryStore: { list: () => h.getRuns() },
}));

import { acceptRuleA11y, revokeA11yRule } from "./a11y-baseline-ops.js";

type Step = {
  stepId: string;
  a11y?: {
    violations: { id: string; impact: string; help: string; nodes: string[] }[];
    newKeys: string[];
    acceptedCount: number;
  };
};

function contrast(nodes: string[]) {
  return { id: "color-contrast", impact: "serious", help: "Contrast", nodes };
}
function imageAlt(nodes: string[]) {
  return { id: "image-alt", impact: "critical", help: "Alt text", nodes };
}

function seedRun(testId: string, runId: string, startedAt: number, steps: Step[]) {
  h.setRuns([
    ...(h.getRuns() as unknown[]),
    { id: runId, testId, startedAt, a11yChecks: 1 },
  ]);
  h.replays.set(`${testId}:${runId}`, { testId, runId, steps });
}

beforeEach(() => {
  h.tests.clear();
  h.replays.clear();
  h.written.length = 0;
  h.setRuns([]);
});

describe("acceptRuleA11y", () => {
  it("pins only the named rule's keys, across every affected test", () => {
    for (const t of ["t1", "t2"]) h.tests.set(t, { id: t });
    seedRun("t1", "r1", 100, [
      {
        stepId: "s1",
        a11y: {
          violations: [contrast([".a"]), imageAlt([".b"])],
          newKeys: ["color-contrast|.a", "image-alt|.b"],
          acceptedCount: 0,
        },
      },
    ]);
    seedRun("t2", "r2", 100, [
      {
        stepId: "s9",
        a11y: {
          violations: [contrast([".c", ".d"])],
          newKeys: ["color-contrast|.c", "color-contrast|.d"],
          acceptedCount: 0,
        },
      },
    ]);

    const res = acceptRuleA11y("color-contrast");
    expect(res).toEqual({ tests: 2, steps: 2 });

    // The baseline holds ONLY the rule's keys — image-alt is untouched.
    expect((h.tests.get("t1") as { a11yBaseline: Record<string, string[]> }).a11yBaseline).toEqual({
      s1: ["color-contrast|.a"],
    });
    expect((h.tests.get("t2") as { a11yBaseline: Record<string, string[]> }).a11yBaseline).toEqual({
      s9: ["color-contrast|.c", "color-contrast|.d"],
    });

    // The replays are patched in place: the other rule stays flagged.
    const t1 = h.replays.get("t1:r1") as { steps: Step[] };
    expect(t1.steps[0].a11y?.newKeys).toEqual(["image-alt|.b"]);
    expect(t1.steps[0].a11y?.acceptedCount).toBe(1);
    const t2 = h.replays.get("t2:r2") as { steps: Step[] };
    expect(t2.steps[0].a11y?.newKeys).toEqual([]);
    expect(t2.steps[0].a11y?.acceptedCount).toBe(2);
    expect(h.written.sort()).toEqual(["t1:r1", "t2:r2"]);
  });

  it("reads each test's LATEST checked run, like the rollup it serves", () => {
    h.tests.set("t1", { id: "t1" });
    seedRun("t1", "r-old", 100, [
      {
        stepId: "s1",
        a11y: {
          violations: [contrast([".old"])],
          newKeys: ["color-contrast|.old"],
          acceptedCount: 0,
        },
      },
    ]);
    seedRun("t1", "r-new", 200, [
      {
        stepId: "s1",
        a11y: {
          violations: [contrast([".new"])],
          newKeys: ["color-contrast|.new"],
          acceptedCount: 0,
        },
      },
    ]);

    acceptRuleA11y("color-contrast");
    // Only the newer run's key is pinned and only its replay rewritten.
    expect((h.tests.get("t1") as { a11yBaseline: Record<string, string[]> }).a11yBaseline).toEqual({
      s1: ["color-contrast|.new"],
    });
    expect(h.written).toEqual(["t1:r-new"]);
    const old = h.replays.get("t1:r-old") as { steps: Step[] };
    expect(old.steps[0].a11y?.newKeys).toEqual(["color-contrast|.old"]);
  });

  it("does nothing for a rule that fires nowhere", () => {
    h.tests.set("t1", { id: "t1" });
    seedRun("t1", "r1", 100, [
      {
        stepId: "s1",
        a11y: {
          violations: [contrast([".a"])],
          newKeys: ["color-contrast|.a"],
          acceptedCount: 0,
        },
      },
    ]);
    expect(acceptRuleA11y("no-such-rule")).toEqual({ tests: 0, steps: 0 });
    expect(h.written).toEqual([]);
    expect((h.tests.get("t1") as { a11yBaseline?: unknown }).a11yBaseline).toBeUndefined();
  });
});

describe("revokeA11yRule", () => {
  it("removes only the named rule's keys and prunes emptied steps", () => {
    h.tests.set("t1", {
      id: "t1",
      a11yBaseline: {
        s1: ["color-contrast|.a", "image-alt|.b"],
        s2: ["color-contrast|.c"],
      },
    });
    expect(revokeA11yRule("t1", "color-contrast")).toEqual({ removed: 2 });
    expect((h.tests.get("t1") as { a11yBaseline: Record<string, string[]> }).a11yBaseline).toEqual({
      s1: ["image-alt|.b"],
    });
  });

  it("drops the baseline entirely when the last rule is revoked", () => {
    h.tests.set("t1", { id: "t1", a11yBaseline: { s1: ["image-alt|.b"] } });
    expect(revokeA11yRule("t1", "image-alt")).toEqual({ removed: 1 });
    expect((h.tests.get("t1") as { a11yBaseline?: unknown }).a11yBaseline).toBeUndefined();
  });

  it("answers zero for a rule that was never accepted, without a save", () => {
    const rec = { id: "t1", a11yBaseline: { s1: ["image-alt|.b"] }, updatedAt: 7 };
    h.tests.set("t1", rec);
    expect(revokeA11yRule("t1", "color-contrast")).toEqual({ removed: 0 });
    expect((h.tests.get("t1") as { updatedAt: number }).updatedAt).toBe(7);
  });

  it("answers zero for an unknown test", () => {
    expect(revokeA11yRule("nope", "color-contrast")).toEqual({ removed: 0 });
  });
});
