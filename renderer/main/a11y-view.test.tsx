// Component tests for the Accessibility view.
//
// What carries meaning here is the board's claims: that rules arrive
// worst-first with honest counts, that "Accept everywhere" names one rule and
// nothing else, that "filed as" appears from any occurrence of a rule, and
// that the Baseline tab's revoke is scoped to one rule on one test. The
// failure mode for most of these is silent — a wrong count or a mis-scoped
// accept renders a perfectly plausible screen.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { A11yRollup, A11yRuleRollup } from "../../shared/a11y-rollup.mjs";
import type { IssueLink, } from "../lib/issue-types";
import type { RunRecord, TestRecord } from "../lib/recorder-types";
import { A11yView, acceptedRules, ruleAnchor, trendSeries, TREND_WINDOW } from "./a11y-view";

const h = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
}));

let rollup: A11yRollup = { checkedRuns: 0, stepsWithNew: 0, byImpact: [], rules: [] };
let tests: TestRecord[] = [];
let runs: RunRecord[] = [];
let links: IssueLink[] = [];

const acceptRule = vi.fn(async (_ruleId: string) => ({ tests: 1, steps: 2 }));
const revokeRule = vi.fn(async (_testId: string, _ruleId: string) => ({ removed: 2 }));
const resetBaseline = vi.fn(async (_testId: string) => ({ cleared: 2 }));

vi.mock("../lib/api", () => ({
  api: {
    a11y: {
      rollup: async () => rollup,
      acceptRule: (...a: [string]) => acceptRule(...a),
      revokeRule: (...a: [string, string]) => revokeRule(...a),
      resetBaseline: (...a: [string]) => resetBaseline(...a),
    },
    tests: { list: async () => tests },
    runs: { list: async () => runs },
    issues: { a11yLinks: async () => links },
  },
}));

function site(over: Partial<A11yRuleRollup["where"][number]> = {}) {
  return {
    testId: "t1",
    testName: "Checkout",
    runId: "r1",
    startedAt: 100,
    stepId: "s1",
    stepLabel: "click Cart",
    index: 0,
    nodes: 2,
    ...over,
  };
}

function rule(over: Partial<A11yRuleRollup> = {}): A11yRuleRollup {
  return {
    id: "color-contrast",
    impact: "serious",
    help: "Elements must meet contrast thresholds",
    steps: 1,
    nodes: 2,
    where: [site()],
    ...over,
  };
}

function seedRollup(rules: A11yRuleRollup[]) {
  rollup = {
    checkedRuns: 2,
    stepsWithNew: rules.reduce((n, r) => n + r.steps, 0),
    byImpact: [
      { impact: "critical", steps: rules.filter((r) => r.impact === "critical").length, rules: 0 },
      { impact: "serious", steps: rules.filter((r) => r.impact === "serious").length, rules: 0 },
      { impact: "moderate", steps: 0, rules: 0 },
      { impact: "minor", steps: 0, rules: 0 },
    ],
    rules,
  };
}

function testRecord(over: Partial<TestRecord> & { id: string; name: string }): TestRecord {
  return {
    url: "https://example.com",
    createdAt: 0,
    updatedAt: 0,
    steps: [],
    scriptPath: "/x.spec.ts",
    ...over,
  } as TestRecord;
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <A11yView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  rollup = { checkedRuns: 0, stepsWithNew: 0, byImpact: [], rules: [] };
  tests = [];
  runs = [];
  links = [];
});

describe("the triage board", () => {
  it("explains itself before any run has checked", async () => {
    renderView();
    expect(await screen.findByText(/no accessibility results yet/i)).toBeTruthy();
  });

  it("says everything is accepted rather than looking broken when clean", async () => {
    rollup = { checkedRuns: 3, stepsWithNew: 0, byImpact: [], rules: [] };
    renderView();
    expect(await screen.findByText(/nothing to triage/i)).toBeTruthy();
    expect(screen.getByText(/accepted baseline/i)).toBeTruthy();
  });

  it("lists rules in the rollup's worst-first order, with per-rule counts", async () => {
    seedRollup([
      rule({ id: "image-alt", impact: "critical", help: "Images need alt text" }),
      rule({
        id: "color-contrast",
        steps: 3,
        nodes: 5,
        where: [site(), site({ testId: "t2", testName: "Login", runId: "r2" }), site({ stepId: "s3" })],
      }),
    ]);
    renderView();
    // findAllBy, not findBy: the selected rule's id renders in the row AND the
    // detail head, and an ambiguous findBy retries to timeout and reports as
    // "never rendered".
    await screen.findAllByText("image-alt");
    const rows = [...document.querySelectorAll(".gl-axe-row")];
    expect(rows.map((r) => r.querySelector(".gl-axe-row-id")?.textContent)).toEqual([
      "image-alt",
      "color-contrast",
    ]);
    // 2 unique tests across 3 sites — a rule on five steps of one test is one
    // thing to fix, and the count must not inflate it.
    expect(rows[1].textContent).toContain("2 tests");
    expect(rows[1].textContent).toContain("3 steps");
    expect(rows[1].textContent).toContain("5 elements");
  });

  it("groups a rule's occurrences by test in the detail pane", async () => {
    seedRollup([
      rule({
        where: [
          site(),
          site({ stepId: "s2", stepLabel: "fill Email", nodes: 1 }),
          site({ testId: "t2", testName: "Login", runId: "r2", stepLabel: "goto /login" }),
        ],
      }),
    ]);
    renderView();
    await screen.findByText("click Cart");
    const groups = [...document.querySelectorAll(".gl-axe-where-test")];
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toContain("Checkout");
    expect(groups[0].querySelectorAll(".gl-axe-where-row")).toHaveLength(2);
    expect(groups[1].textContent).toContain("Login");
  });

  it("exits to the test from an occurrence group", async () => {
    seedRollup([rule()]);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Open Checkout" }));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t1" } });
  });

  it("accepts one rule everywhere, behind a confirm, by rule id", async () => {
    seedRollup([rule()]);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Accept everywhere" }));
    // Nothing fires until the dialog confirms — a misclick must not sign off
    // a suite-wide baseline.
    expect(acceptRule).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Accept rule" }));
    await waitFor(() => expect(acceptRule).toHaveBeenCalledWith("color-contrast"));
  });

  it("badges a rule that has already been filed, from any occurrence", async () => {
    seedRollup([rule()]);
    links = [
      {
        provider: "linear",
        // A DIFFERENT test than the board would anchor to today: the link was
        // made from some occurrence, and must still be found from this one.
        testId: "t-other",
        stepId: "s-other",
        runId: "r-other",
        kind: "a11y",
        ruleId: "color-contrast",
        issueId: "iss-1",
        identifier: "ENG-42",
        url: "https://linear.app/x/issue/ENG-42",
        createdAt: 0,
      } as IssueLink,
    ];
    renderView();
    expect(await screen.findByText("Filed as ENG-42")).toBeTruthy();
  });
});

describe("the baseline tab", () => {
  function openBaseline() {
    renderView();
    return waitFor(() => {
      const btn = screen
        .getAllByRole("button")
        .find((b) => /Baseline & trends/.test(b.textContent ?? ""));
      if (!btn) throw new Error("no tab");
      fireEvent.click(btn);
    });
  }

  it("lists tests with accepted issues, grouped into rules", async () => {
    rollup = { checkedRuns: 1, stepsWithNew: 0, byImpact: [], rules: [] };
    tests = [
      testRecord({
        id: "t1",
        name: "Checkout",
        a11yBaseline: { s1: ["color-contrast|.a", "color-contrast|.b"], s2: ["image-alt|.c"] },
      }),
      testRecord({ id: "t2", name: "Login" }),
    ];
    await openBaseline();
    expect(await screen.findByText("2 rules · 3 elements accepted")).toBeTruthy();
    // A test with nothing accepted has no row to revoke from.
    expect(screen.queryByText("Login")).toBeNull();
  });

  it("revokes one rule for one test, behind a confirm", async () => {
    rollup = { checkedRuns: 1, stepsWithNew: 0, byImpact: [], rules: [] };
    tests = [
      testRecord({ id: "t1", name: "Checkout", a11yBaseline: { s1: ["color-contrast|.a"] } }),
    ];
    await openBaseline();
    fireEvent.click((await screen.findAllByRole("button", { name: "Revoke" }))[0]);
    expect(revokeRule).not.toHaveBeenCalled();
    const confirms = await screen.findAllByRole("button", { name: "Revoke" });
    fireEvent.click(confirms[confirms.length - 1]);
    await waitFor(() => expect(revokeRule).toHaveBeenCalledWith("t1", "color-contrast"));
  });

  it("draws the trend only from runs that completed checks", async () => {
    rollup = { checkedRuns: 1, stepsWithNew: 0, byImpact: [], rules: [] };
    runs = [
      { id: "r1", startedAt: 1, a11yChecks: 4, a11yNewSteps: 2 },
      { id: "r2", startedAt: 2, a11yChecks: 0, a11yNewSteps: 0 },
      { id: "r3", startedAt: 3, a11yChecks: 4, a11yNewSteps: 0 },
      { id: "r4", startedAt: 4, kind: "baseline-update", a11yChecks: 4, a11yNewSteps: 0 },
    ] as RunRecord[];
    await openBaseline();
    await waitFor(() => {
      if (!document.querySelector(".gl-axe-trend")) throw new Error("no strip");
    });
    // r2 never checked and r4 is a baseline event — two bars, not four.
    expect(document.querySelectorAll(".gl-axe-trend-slot")).toHaveLength(2);
    expect(document.querySelectorAll(".gl-axe-trend-bar[data-new]")).toHaveLength(1);
  });

  it("draws no trend from a single checked run", async () => {
    rollup = { checkedRuns: 1, stepsWithNew: 0, byImpact: [], rules: [] };
    runs = [{ id: "r1", startedAt: 1, a11yChecks: 4, a11yNewSteps: 2 }] as RunRecord[];
    await openBaseline();
    await screen.findByText(/no test has accepted issues yet/i);
    expect(document.querySelector(".gl-axe-trend")).toBeNull();
  });
});

describe("the pure pieces", () => {
  it("trendSeries caps at the window, oldest dropped first", () => {
    const many = Array.from({ length: TREND_WINDOW + 5 }, (_, i) => ({
      id: `r${i}`,
      startedAt: i,
      a11yChecks: 1,
      a11yNewSteps: i,
    }));
    const series = trendSeries(many);
    expect(series).toHaveLength(TREND_WINDOW);
    expect(series[0].id).toBe("r5");
  });

  it("acceptedRules counts keys per rule across steps", () => {
    expect(
      acceptedRules({ s1: ["a|.x", "b|.y"], s2: ["a|.z"] }),
    ).toEqual([
      { ruleId: "a", elements: 2 },
      { ruleId: "b", elements: 1 },
    ]);
    expect(acceptedRules(undefined)).toEqual([]);
  });

  it("ruleAnchor skips step-less sites and carries rule scope", () => {
    const r = rule({
      where: [site({ stepId: null }), site({ stepId: "s2", runId: "r9" })],
    });
    expect(ruleAnchor(r)).toEqual({
      kind: "a11y",
      testId: "t1",
      runId: "r9",
      stepId: "s2",
      ruleId: "color-contrast",
      scope: "rule",
    });
    expect(ruleAnchor(rule({ where: [site({ stepId: null })] }))).toBeNull();
  });
});
