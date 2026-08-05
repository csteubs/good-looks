// Component tests for the Heals view.
//
// Three things are worth pinning, in descending order of how quietly they'd
// break:
//
//   1. Pagination. 50 per page, and — the case that actually bites — a page
//      number that outlives its list. Accepting the last heal on the last page
//      shrinks the list under you, and an unclamped page renders an empty list
//      beside rows that plainly exist. That exact bug is why paginate.ts is
//      pure and check:paginate exists; this makes sure the view uses it rather
//      than reimplementing it.
//   2. Master/detail. Clicking a row has to show THAT heal — an off-by-one
//      between the paged slice and the selection would show a neighbouring one,
//      which looks plausible and is wrong.
//   3. A heal outliving its test. The record survives a delete, and rendering a
//      bare uuid at that point is useless.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { HealListEntry } from "../lib/recorder-types";
import { PAGE_SIZE } from "../lib/paginate";
import { HealsView } from "./heals-view";

let journal: HealListEntry[] = [];
const accept = vi.fn(async (_id: string, _locator?: unknown) => null);
const revert = vi.fn(async (_id: string) => null);

vi.mock("../lib/api", () => ({
  api: {
    heals: {
      listAll: async () => journal,
      accept: (id: string, locator?: unknown) => accept(id, locator),
      revert: (id: string) => revert(id),
    },
  },
}));

function heal(partial: Partial<HealListEntry> = {}): HealListEntry {
  return {
    id: "h1",
    testId: "t1",
    testName: "Checkout",
    stepId: "s1",
    stepIndex: 0,
    stepLabel: 'getByTestId("submit-v1").click()',
    source: "run",
    runId: "r1",
    originalLocator: { k: "testid", v: "submit-v1" },
    appliedLocator: { k: "testid", v: "submit-v2" },
    candidates: [],
    applied: true,
    status: "pending",
    at: 1_700_000_000_000,
    ...partial,
  };
}

/** `n` heals, newest first, as the backend returns them. */
function manyHeals(n: number): HealListEntry[] {
  return Array.from({ length: n }, (_, i) =>
    heal({
      id: `h${i}`,
      stepLabel: `step ${i}`,
      testName: `Test ${i}`,
      at: 1_700_000_000_000 - i * 1000,
    }),
  );
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <HealsView />
    </QueryClientProvider>,
  );
  return qc;
}

/** The list pane's rows. Scoped to the list so the detail pane's own controls
 *  can't be mistaken for rows. */
function rowLabels(): string[] {
  return screen
    .getAllByRole("button")
    .map((b) => b.textContent ?? "")
    .filter((t) => t.includes("step "));
}

beforeEach(() => {
  vi.clearAllMocks();
  journal = [];
});

describe("HealsView", () => {
  it("explains itself when nothing has been healed", async () => {
    renderView();
    expect(await screen.findByText(/No heals yet/i)).toBeTruthy();
  });

  it("shows at most 50 heals per page", async () => {
    journal = manyHeals(120);
    renderView();
    await screen.findByText("step 0");
    expect(rowLabels()).toHaveLength(PAGE_SIZE);
    expect(PAGE_SIZE).toBe(50);
  });

  it("pages through the rest, newest first", async () => {
    journal = manyHeals(120);
    renderView();
    await screen.findByText("step 0");
    expect(screen.queryByText("step 50")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    await screen.findByText("step 50");
    expect(screen.queryByText("step 0")).toBeNull();
    expect(rowLabels()).toHaveLength(PAGE_SIZE);

    fireEvent.click(screen.getByRole("button", { name: /previous page/i }));
    await screen.findByText("step 0");
  });

  it("reports the range and total, the same as Stats", async () => {
    journal = manyHeals(120);
    renderView();
    await screen.findByText("step 0");
    expect(screen.getByText("1–50 of 120 heals")).toBeTruthy();
    expect(screen.getByText(/Page 1 of 3/)).toBeTruthy();
  });

  it("hides the pager when everything fits on one page", async () => {
    journal = manyHeals(5);
    renderView();
    await screen.findByText("step 0");
    expect(screen.queryByRole("button", { name: /next page/i })).toBeNull();
  });

  it("clamps a page that outlives its list", async () => {
    // The case that actually bites: you're on page 3, the list shrinks (a heal
    // was accepted, or a test was deleted), and an unclamped page renders
    // nothing beside rows that clearly exist.
    journal = manyHeals(120);
    const qc = renderView();
    await screen.findByText("step 0");
    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    await screen.findByText("step 100");

    journal = manyHeals(20);
    await qc.invalidateQueries({ queryKey: ["heals"] });

    // Falls back to real rows rather than an empty list.
    await waitFor(() => expect(screen.getByText("step 0")).toBeTruthy());
    expect(rowLabels().length).toBeGreaterThan(0);
  });

  it("prompts for a selection before one is made", async () => {
    journal = manyHeals(3);
    renderView();
    expect(await screen.findByText(/Select a heal/i)).toBeTruthy();
  });

  it("shows the details of the heal you clicked", async () => {
    journal = [
      heal({ id: "a", stepLabel: "step a", appliedLocator: { k: "testid", v: "aaa" } }),
      heal({ id: "b", stepLabel: "step b", appliedLocator: { k: "testid", v: "bbb" } }),
    ];
    renderView();
    fireEvent.click(await screen.findByText("step b"));

    await screen.findByText("now");
    // The clicked one, not its neighbour.
    expect(screen.getByText(/getByTestId\("bbb"\)/)).toBeTruthy();
    expect(screen.queryByText(/getByTestId\("aaa"\)/)).toBeNull();
  });

  it("shows both locators, so the change can be judged", async () => {
    journal = [heal()];
    renderView();
    fireEvent.click(await screen.findByText('getByTestId("submit-v1").click()'));
    await screen.findByText("was");
    expect(screen.getByText("now")).toBeTruthy();
    expect(screen.getAllByText(/submit-v1/).length).toBeGreaterThan(0);
    expect(screen.getByText(/submit-v2/)).toBeTruthy();
  });

  it("says whether the stored test was actually changed", async () => {
    journal = [heal({ applied: false })];
    renderView();
    fireEvent.click(await screen.findByText('getByTestId("submit-v1").click()'));
    expect(await screen.findByText("Suggestion only")).toBeTruthy();
    // And labels the action by what it will do.
    expect(screen.getByRole("button", { name: /apply/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeTruthy();
  });

  it("accepts and reverts the selected heal", async () => {
    journal = [heal({ id: "h9" })];
    renderView();
    fireEvent.click(await screen.findByText('getByTestId("submit-v1").click()'));
    fireEvent.click(await screen.findByRole("button", { name: /keep/i }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith("h9", undefined));

    fireEvent.click(screen.getByRole("button", { name: /revert/i }));
    await waitFor(() => expect(revert).toHaveBeenCalledWith("h9"));
  });

  it("can apply a different candidate than the engine picked", async () => {
    journal = [
      heal({
        candidates: [
          { locator: { k: "testid", v: "submit-v2" }, description: "b", score: 1, matchedPastRun: false },
          { locator: { k: "role", role: "button", name: "Place order" }, description: "b", score: 0.8, matchedPastRun: true },
        ],
      }),
    ];
    renderView();
    fireEvent.click(await screen.findByText('getByTestId("submit-v1").click()'));
    fireEvent.click(await screen.findByRole("button", { name: /use this/i }));
    await waitFor(() =>
      expect(accept).toHaveBeenCalledWith("h1", { k: "role", role: "button", name: "Place order" }),
    );
  });

  it("names a deleted test rather than showing a bare id", async () => {
    // A heal outlives the test it came from. "(deleted test)" is information;
    // a uuid is not.
    journal = [heal({ testName: null })];
    renderView();
    const row = await screen.findByText("(deleted test)");
    expect(row).toBeTruthy();
    fireEvent.click(row);
    expect(await screen.findByText(/has been deleted/i)).toBeTruthy();
  });

  it("counts pending heals in the toolbar", async () => {
    journal = [
      heal({ id: "a" }),
      heal({ id: "b", status: "accepted" }),
      heal({ id: "c", status: "reverted" }),
    ];
    renderView();
    expect(await screen.findByText(/3 heals recorded · 1 needing review/i)).toBeTruthy();
  });

  it("offers no accept or revert on a settled heal", async () => {
    journal = [heal({ status: "accepted" })];
    renderView();
    fireEvent.click(await screen.findByText('getByTestId("submit-v1").click()'));
    await screen.findByText("now");
    expect(screen.queryByRole("button", { name: /keep|apply/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /revert|dismiss/i })).toBeNull();
  });
});

describe("HealsView list rows", () => {
  it("marks the selected row for assistive tech, not just visually", async () => {
    journal = manyHeals(3);
    renderView();
    const row = await screen.findByText("step 1");
    fireEvent.click(row);
    const button = row.closest("button");
    expect(button?.getAttribute("aria-current")).toBe("true");
    // And only that one.
    expect(screen.getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "true"))
      .toHaveLength(1);
  });
});
