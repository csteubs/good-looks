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
    runs: {
      list: async () => [
        { id: "r1", testId: "t1", status: "passed", kind: "run", startedAt: 1 },
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

  it("states what a category shows when its dashboard is not built yet", async () => {
    h.params = { category: "visual" };
    renderView();
    // Reachable by typing the route, so it explains rather than rendering an
    // empty screen.
    expect(await screen.findByText(/isn’t built yet/i)).toBeTruthy();
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
