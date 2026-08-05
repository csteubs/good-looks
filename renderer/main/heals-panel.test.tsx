// Component tests for the heal review panel.
//
// The panel's whole job is to make an invisible change visible. So the tests
// are about what it SAYS, not what it renders prettily: whether the stored test
// was already changed, what the locator used to be, and that both directions
// out of a pending heal are one click away.
//
// The distinction between "Applied to the test" and "Suggestion only" is the
// load-bearing one. Getting it backwards would tell a user their test is
// untouched when it isn't — which is worse than not showing the heal at all.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { HealEntry, TestRecord } from "../lib/recorder-types";
import { HealsPanel } from "./heals-panel";

let journal: HealEntry[] = [];
const accept = vi.fn(async (_id: string, _locator?: unknown) => null);
const revert = vi.fn(async (_id: string) => null);
const clearSettled = vi.fn(async (_testId: string) => ({ removed: 0 }));

vi.mock("../lib/api", () => ({
  api: {
    heals: {
      list: async () => journal,
      accept: (id: string, locator?: unknown) => accept(id, locator),
      revert: (id: string) => revert(id),
      clearSettled: (testId: string) => clearSettled(testId),
    },
  },
}));

function heal(partial: Partial<HealEntry> = {}): HealEntry {
  return {
    id: "h1",
    testId: "t1",
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

const test1 = {
  id: "t1",
  name: "Checkout",
  url: "https://example.com",
  createdAt: 1,
  updatedAt: 1,
  steps: [],
  scriptPath: "/tmp/t1.spec.ts",
} as TestRecord;

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <HealsPanel test={test1} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  journal = [];
});

describe("HealsPanel", () => {
  it("explains itself when there is nothing to review", async () => {
    renderPanel();
    expect(await screen.findByText(/Nothing to review/i)).toBeTruthy();
  });

  it("shows both the old and the new locator", async () => {
    // Without the original there is no way to judge whether the heal was right,
    // and no way back.
    journal = [heal()];
    renderPanel();
    // The old locator appears in the step label too, so this query is
    // deliberately getAllBy: an ambiguous findBy retries until timeout and then
    // reports "never rendered", which reads as the wrong bug entirely.
    await screen.findByText("was");
    expect(screen.getAllByText(/submit-v1/).length).toBeGreaterThan(0);
    expect(screen.getByText(/submit-v2/)).toBeTruthy();
    // Both directions are labelled, so it's readable without decoding which
    // line is which.
    expect(screen.getByText("was")).toBeTruthy();
    expect(screen.getByText("now")).toBeTruthy();
  });

  it("says plainly when the stored test has already been changed", async () => {
    journal = [heal({ applied: true })];
    renderPanel();
    expect(await screen.findByText("Applied to the test")).toBeTruthy();
    // And warns above the list, because this is the case the user did not ask for.
    expect(screen.getByText(/already been changed by/i)).toBeTruthy();
  });

  it("says when a heal is only a suggestion", async () => {
    journal = [heal({ applied: false })];
    renderPanel();
    expect(await screen.findByText("Suggestion only")).toBeTruthy();
    // No alarm banner: nothing happened to the saved test.
    expect(screen.queryByText(/already been changed by/i)).toBeNull();
  });

  it("labels the action by what it will actually do", async () => {
    // An applied heal is kept or reverted; a suggestion is applied or dismissed.
    // Same two buttons, opposite meanings — mislabelling them would have the
    // user "revert" something that was never applied.
    journal = [heal({ applied: false })];
    renderPanel();
    expect(await screen.findByRole("button", { name: /apply/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeTruthy();
  });

  it("accepts a heal", async () => {
    journal = [heal()];
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /keep/i }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith("h1", undefined));
  });

  it("reverts a heal", async () => {
    journal = [heal()];
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /revert/i }));
    await waitFor(() => expect(revert).toHaveBeenCalledWith("h1"));
  });

  it("offers the other candidates, and can accept one instead", async () => {
    journal = [
      heal({
        candidates: [
          { locator: { k: "testid", v: "submit-v2" }, description: "b", score: 1, matchedPastRun: false },
          { locator: { k: "role", role: "button", name: "Place order" }, description: "b", score: 0.8, matchedPastRun: true },
        ],
      }),
    ];
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /1 other candidate/i }));
    fireEvent.click(await screen.findByRole("button", { name: /use this/i }));
    await waitFor(() =>
      expect(accept).toHaveBeenCalledWith("h1", { k: "role", role: "button", name: "Place order" }),
    );
  });

  it("does not offer the already-applied locator as an alternative", async () => {
    // It's already what the step points at; listing it again reads as a second
    // option when it is the current one.
    journal = [
      heal({
        candidates: [
          { locator: { k: "testid", v: "submit-v2" }, description: "b", score: 1, matchedPastRun: false },
        ],
      }),
    ];
    renderPanel();
    await screen.findByText("now");
    expect(screen.queryByRole("button", { name: /other candidate/i })).toBeNull();
  });

  it("separates settled history from the review queue", async () => {
    journal = [heal({ id: "h1" }), heal({ id: "h2", status: "accepted" })];
    renderPanel();
    expect(await screen.findByText("History")).toBeTruthy();
    expect(screen.getByText("Accepted")).toBeTruthy();
    // A settled entry offers no buttons — the decision is made.
    expect(screen.getAllByRole("button", { name: /keep/i })).toHaveLength(1);
  });

  it("distinguishes a run heal from a trainer heal", async () => {
    // They mean different things: one happened while you were watching, the
    // other happened on its own.
    journal = [heal({ id: "h1", source: "run" }), heal({ id: "h2", source: "trainer" })];
    renderPanel();
    expect(await screen.findByText("During a run")).toBeTruthy();
    expect(screen.getByText("In the trainer")).toBeTruthy();
  });
});
