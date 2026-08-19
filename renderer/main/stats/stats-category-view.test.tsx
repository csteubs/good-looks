// A category dashboard and the leaf below it.
//
// What this file exists to prove is the DRILL, which is the feature's whole
// premise: board → category → facet → out to the real object, with the trail
// above it staying true. The router is mocked at `useNavigate`/`useParams`, the
// pattern `library-sidebar.test.tsx` and `ai-debug-chip.test.tsx` already use —
// mounting a real router here would test TanStack rather than this screen.
//
// The other half of the premise is the line in docs/plans/stats-categories.md
// §6: Stats REPORTS, the operational views ACT. `check:stats-categories` proves
// no mutation is even imported here; what this file proves is the positive
// half — that every leaf offers a way out to the thing it names.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: { category: "stability" } as { category?: string; facet?: string },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
  useParams: () => h.params,
}));

vi.mock("../../lib/api", () => ({
  api: {
    // The Outcomes branch queries the reason vocabulary for its failures
    // breakdown; empty, so the panel stays out of these routing assertions —
    // outcomes-dashboard.test.tsx covers the panel itself.
    failureReasons: { list: async () => ({ builtin: [], custom: [] }) },
    runs: {
      list: async () => [
        // `a11yChecks` is what makes this run COUNT as measured for the a11y
        // category — a run with the toggle on that completed no checks is a
        // fault, not a clean result — and `a11yNewSteps` is what its headline
        // counts. Both are needed for the category head to say anything.
        {
          id: "r1",
          testId: "t1",
          status: "passed",
          kind: "run",
          startedAt: 1,
          a11yChecks: 4,
          a11yNewSteps: 1,
        },
      ],
      flake: async () => ({
        tests: [
          {
            testId: "t1",
            testName: "Checkout",
            runs: 10,
            passed: 5,
            failed: 5,
            transitions: 4,
            flakeRate: 0.4,
            verdict: "flaky",
            failingDatasets: [],
            steps: [],
            healedRuns: 0,
          },
          {
            testId: "t2",
            testName: "Login",
            runs: 8,
            passed: 4,
            failed: 4,
            transitions: 1,
            flakeRate: 0.1,
            verdict: "changed-since",
            failingDatasets: [],
            steps: [],
            healedRuns: 0,
          },
        ],
        clusters: [],
        analysedTests: 2,
        windowRuns: 18,
        windowCap: 200,
      }),
      captureOverhead: async () => null,
      // Lifetime run counts. Null, so the Outcomes dashboard falls back to the
      // fixture runs — the counting itself is covered in
      // outcomes-dashboard.test.tsx, and this file is about routing.
      totals: async () => null,
    },
    heals: {
      listAll: async () => [
        {
          id: "h1",
          testId: "t9",
          testName: "Search",
          stepId: "s1",
          stepIndex: 2,
          stepLabel: "click Filter",
          source: "run",
          appliedLocator: { k: "testid", v: "filter" },
          candidates: [],
          applied: true,
          status: "pending",
          at: 1,
        },
      ],
    },
    // The five categories that gained a dashboard on 2026-08-14. Each answers
    // with the smallest fixture that lights its screen up — the arithmetic is
    // covered per dashboard, and a rich fixture here would make the routing
    // assertions harder to read for no gain.
    artifacts: {
      list: async () => [
        {
          testId: "t1",
          runId: "rep1",
          testName: "Checkout",
          status: "passed",
          startedAt: 5,
          finishedAt: 6,
          stepCount: 4,
          failedIndex: null,
          changedSteps: 2,
        },
      ],
    },
    metrics: {
      stepHealth: async () => ({
        available: true,
        rows: [
          {
            stepId: "s1",
            label: "click Submit",
            type: "click",
            testId: "t1",
            testName: "Checkout",
            runs: 10,
            failed: 2,
            failRate: 0.2,
            heals: 0,
            healFailures: 0,
            visualChanges: 0,
            a11yNew: 0,
            pageErrors: 0,
            timedRuns: 10,
            minMs: 10,
            maxMs: 20,
            lastSeenAt: 5,
          },
        ],
      }),
      slowness: async () => ({
        available: true,
        rows: [],
        slowed: [
          {
            stepId: "s1",
            label: "click Submit",
            type: "click",
            testId: "t1",
            testName: "Checkout",
            recentRuns: 5,
            previousRuns: 5,
            recentP50Ms: 4000,
            recentP95Ms: 5000,
            previousP50Ms: 2000,
            changeRatio: 2,
          },
        ],
        cost: {
          runs: 4,
          totalMs: 1000,
          captureMs: 100,
          a11yMs: 100,
          instrumentedMs: 200,
          instrumentedShare: 0.2,
          shots: 3,
          bySpeed: [],
        },
      }),
    },
    a11y: {
      rollup: async () => ({
        checkedRuns: 1,
        stepsWithNew: 1,
        byImpact: [
          { impact: "critical", steps: 0, rules: 0 },
          { impact: "serious", steps: 1, rules: 1 },
          { impact: "moderate", steps: 0, rules: 0 },
          { impact: "minor", steps: 0, rules: 0 },
        ],
        rules: [
          {
            id: "color-contrast",
            impact: "serious",
            help: "Elements must have sufficient colour contrast",
            steps: 1,
            nodes: 1,
            where: [
              {
                testId: "t1",
                testName: "Checkout",
                runId: "r1",
                startedAt: 1,
                stepId: "s1",
                stepLabel: "click Submit",
                index: 0,
                nodes: 1,
              },
            ],
          },
        ],
      }),
    },
  },
}));

import { StatsCategoryView } from "./stats-category-view";

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StatsCategoryView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.navigate.mockClear();
  h.params = { category: "stability" };
});

describe("the dashboard", () => {
  it("breaks the category down into drillable facets", async () => {
    renderView();
    // Wait for ROWS, not for the panel — the panel renders before the query
    // resolves and would read as "no data".
    expect(await screen.findByText("Flaky")).toBeTruthy();
    expect(screen.getByText("Broke recently")).toBeTruthy();
  });

  it("drills into a facet with a real navigation", async () => {
    renderView();
    fireEvent.click((await screen.findByText("Flaky")).closest("button")!);
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/stats/$category/$facet",
      params: { category: "stability", facet: "flaky" },
    });
  });

  it("omits verdicts nobody has", async () => {
    // A list where most rows say "nothing to report" is a list people stop
    // reading — the same argument the divergence panel makes for hiding its
    // `insufficient` rows.
    renderView();
    await screen.findByText("Flaky");
    expect(screen.queryByText("Consistently failing")).toBeNull();
  });

});

// ── Every category the board can open, opens ──────────────────────────
//
// THIS IS THE ROUTING TEST, and it is deliberately about ROUTING rather than
// about any dashboard's content: each `BUILT` id must reach its own screen and
// none of them may land on the "isn't built yet" fallback. That fallback is
// still in the file as an honest last resort, and the failure this guards
// against is silent — a tile becomes clickable, the route resolves, the
// category is real, and the user clicks through to a sentence saying come back
// later. `check:stats-categories` pins the same property at source level; this
// pins it as rendered.
describe("every built category opens its own dashboard", () => {
  const OPENS: [string, RegExp][] = [
    ["outcomes", /pass \/ fail over time/i],
    ["stability", /by verdict/i],
    ["heals", /by state/i],
    ["a11y", /by severity/i],
    ["visual", /by state/i],
    ["speed", /where the time goes/i],
    ["steps", /by finding/i],
  ];

  for (const [category, marker] of OPENS) {
    it(`opens ${category}`, async () => {
      h.params = { category };
      renderView();
      expect(await screen.findByText(marker)).toBeTruthy();
      expect(screen.queryByText(/isn’t built yet/i)).toBeNull();
    });
  }
});

describe("the new dashboards, through the route", () => {
  it("drills a11y into a severity and lists its rules", async () => {
    h.params = { category: "a11y" };
    renderView();
    fireEvent.click((await screen.findByText("Serious")).closest("button")!);
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/stats/$category/$facet",
      params: { category: "a11y", facet: "serious" },
    });

    h.params = { category: "a11y", facet: "serious" };
    renderView();
    expect(await screen.findByText(/colour contrast \(color-contrast\)/i)).toBeTruthy();
  });

  it("sends Visual to the view that can accept a baseline", async () => {
    h.params = { category: "visual" };
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /open visual/i }));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/visual" });
  });

  it("exits a slow step to its test", async () => {
    h.params = { category: "speed", facet: "slower" };
    renderView();
    const row = (await screen.findByText("click Submit")).closest(".gl-exit")!;
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /open test/i }));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t1" } });
  });

  it("exits a failing step to its test", async () => {
    h.params = { category: "steps", facet: "failing" };
    renderView();
    const row = (await screen.findByText("click Submit")).closest(".gl-exit")!;
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /open test/i }));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t1" } });
  });

  it("says 'carries', not 'carry', when exactly one step does", async () => {
    // THE HEAD USED TO ASSEMBLE ITS OWN SENTENCE from the headline and the
    // registry's `unit`, which is a fixed plural — so a category with exactly
    // one finding read "1 steps carry violations you haven’t accepted". Found
    // by looking at the screen, which is the only place it was visible.
    h.params = { category: "a11y" };
    renderView();
    expect(await screen.findByText(/1 step carries violations/i)).toBeTruthy();
    expect(screen.queryByText(/1 steps carry/i)).toBeNull();
  });

  it("carries the headline its own tile computed", async () => {
    // One summariser, two surfaces. The Visual tile says "2 steps changed
    // against their baseline"; the category head must say the same thing, or
    // the board and the screen under it describe different suites.
    h.params = { category: "visual" };
    renderView();
    await screen.findByText(/by state/i);
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText(/1 test captured/i)).toBeTruthy();
  });
});

describe("the leaf", () => {
  beforeEach(() => {
    h.params = { category: "stability", facet: "flaky" };
  });

  it("lists the tests with that verdict, and nothing else", async () => {
    renderView();
    expect(await screen.findByText("Checkout")).toBeTruthy();
    expect(screen.queryByText("Login")).toBeNull();
  });

  it("carries the verdict's own explanation, not just its name", async () => {
    renderView();
    // The copy is exported from flake-panel and asserted there too, so the two
    // screens cannot drift into explaining the same verdict differently.
    expect(await screen.findByText(/coin toss/i)).toBeTruthy();
  });

  it("EXITS to the real object on every row", async () => {
    // The failure mode of a drill-down is a beautifully broken-down number you
    // cannot act on.
    renderView();
    const row = (await screen.findByText("Checkout")).closest(".gl-exit")!;
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /open test/i }));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t1" } });
  });

  it("explains an unknown facet instead of rendering an empty list", async () => {
    h.params = { category: "stability", facet: "nonsense" };
    renderView();
    expect(await screen.findByText(/not a stability verdict/i)).toBeTruthy();
  });
});

describe("Auto-Heal", () => {
  it("counts by state and sends you to Heals to act", async () => {
    h.params = { category: "heals" };
    renderView();
    expect(await screen.findByText("Waiting on you")).toBeTruthy();

    // The analytics/operations line, on screen: accept and revert are not here.
    fireEvent.click(screen.getByRole("button", { name: /open heals/i }));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/heals" });
  });

  it("names the test a heal belongs to, and survives that test being deleted", async () => {
    h.params = { category: "heals", facet: "pending" };
    renderView();
    const row = (await screen.findByText("click Filter")).closest(".gl-exit")!;
    expect(within(row as HTMLElement).getByText(/Search/)).toBeTruthy();
  });
});

describe("an unknown category", () => {
  it("explains itself rather than crashing", async () => {
    // Route params are strings out of history. This is reachable.
    h.params = { category: "__proto__" };
    renderView();
    await waitFor(() => expect(screen.getByText(/no such category/i)).toBeTruthy());
    expect(screen.getByText(/is not one of the Stats categories/i)).toBeTruthy();
  });
});
