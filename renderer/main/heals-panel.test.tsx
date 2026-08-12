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

import type { HealEntry, ScriptChangeEntry, TestRecord } from "../lib/recorder-types";
import { HealsPanel } from "./heals-panel";

let journal: HealEntry[] = [];
let changes: ScriptChangeEntry[] = [];
const accept = vi.fn(async (_id: string, _locator?: unknown) => null);
const revert = vi.fn(async (_id: string) => null);
const clearSettled = vi.fn(async (_testId: string) => ({ removed: 0 }));
const acceptChange = vi.fn(async (_id: string) => null);
const revertChange = vi.fn(async (_id: string) => null);
const clearSettledChanges = vi.fn(async (_testId: string) => ({ removed: 0 }));

vi.mock("../lib/api", () => ({
  api: {
    heals: {
      list: async () => journal,
      accept: (id: string, locator?: unknown) => accept(id, locator),
      revert: (id: string) => revert(id),
      clearSettled: (testId: string) => clearSettled(testId),
    },
    scriptChanges: {
      list: async () => changes,
      accept: (id: string) => acceptChange(id),
      revert: (id: string) => revertChange(id),
      clearSettled: (testId: string) => clearSettledChanges(testId),
    },
  },
}));

function scriptChange(partial: Partial<ScriptChangeEntry> = {}): ScriptChangeEntry {
  return {
    id: "sc1",
    testId: "t1",
    origin: "ai-debug",
    model: "claude-sonnet-4",
    reviewed: false,
    before: "one\ntwo\n",
    after: "one\nthree\n",
    addedLines: 1,
    removedLines: 1,
    status: "pending",
    at: 1_700_000_000_000,
    ...partial,
  };
}

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
  changes = [];
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
    expect(screen.getByText(/already been made to this test without review/i)).toBeTruthy();
  });

  it("says when a heal is only a suggestion", async () => {
    journal = [heal({ applied: false })];
    renderPanel();
    expect(await screen.findByText("Suggestion only")).toBeTruthy();
    // No alarm banner: nothing happened to the saved test.
    expect(screen.queryByText(/already been made to this test without review/i)).toBeNull();
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

describe("HealsPanel — script changes", () => {
  it("files an auto-applied AI fix under review and a hand edit under history", async () => {
    // THE SPLIT THE WHOLE FEATURE TURNS ON, and it is not AI-vs-manual: it is
    // whether the user saw the change before it landed. Getting it backwards
    // either nags them to approve their own edit or lets a fix nobody read
    // sit in history looking settled.
    changes = [
      scriptChange({ id: "auto", reviewed: false, status: "pending" }),
      scriptChange({ id: "hand", origin: "manual", model: undefined, reviewed: true, status: "accepted" }),
    ];
    renderPanel();

    await screen.findByText(/AI Debug - claude-sonnet-4/i);
    const review = screen.getByText("Needs review").closest("div")?.parentElement;
    const history = screen.getByText("History").closest("div")?.parentElement;
    expect(review?.textContent).toContain("AI Debug - claude-sonnet-4");
    expect(history?.textContent).toContain("Edited by hand");
  });

  it("names the model on an AI change", async () => {
    changes = [scriptChange({ model: "llama3.1:70b" })];
    renderPanel();
    expect(await screen.findByText(/AI Debug - llama3\.1:70b/i)).toBeTruthy();
  });

  it("does not print 'undefined' when the entry has no model", async () => {
    changes = [scriptChange({ model: undefined })];
    renderPanel();
    const label = await screen.findByText(/AI Debug/i);
    expect(label.textContent).not.toMatch(/undefined/);
  });

  it("warns above the list when a change landed without review", async () => {
    // Same banner as an applied heal's: two routes to one hazard — the stored
    // test changed and nobody looked — so one warning, not two competing ones.
    changes = [scriptChange({ reviewed: false, status: "pending" })];
    renderPanel();
    expect(
      await screen.findByText(/already been made to this test without review/i),
    ).toBeTruthy();
  });

  it("stays quiet about a change the user made themselves", async () => {
    changes = [
      scriptChange({ origin: "manual", model: undefined, reviewed: true, status: "accepted" }),
    ];
    renderPanel();
    await screen.findByText(/Edited by hand/i);
    expect(screen.queryByText(/without review/i)).toBeNull();
  });

  it("interleaves with heals by time rather than listing them apart", async () => {
    journal = [heal({ id: "h-old", at: 1000 })];
    changes = [scriptChange({ id: "sc-new", at: 3000 })];
    renderPanel();
    await screen.findByText(/AI Debug/i);

    const rows = Array.from(document.querySelectorAll(".gl-heal-row")).map(
      (r) => r.textContent ?? "",
    );
    expect(rows[0]).toContain("AI Debug");
    expect(rows[1]).toContain("submit-v1");
  });

  it("shows the diff on demand rather than by default", async () => {
    // A corrected spec can be the whole file, and rows expanded by default
    // would push the rest of the review queue off screen.
    changes = [scriptChange({ before: "keep\ndrop\n", after: "keep\nadd\n" })];
    renderPanel();
    await screen.findByText(/AI Debug/i);
    expect(screen.queryByText(/drop/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /show diff/i }));
    await waitFor(() => expect(screen.getByText(/drop/)).toBeTruthy());
    expect(screen.getByText(/add/)).toBeTruthy();
  });

  it("keeps and reverts through the script-change API, not the heal one", async () => {
    changes = [scriptChange({ id: "sc-x" })];
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /^keep$/i }));
    await waitFor(() => expect(acceptChange).toHaveBeenCalledWith("sc-x"));

    fireEvent.click(screen.getByRole("button", { name: /^revert$/i }));
    await waitFor(() => expect(revertChange).toHaveBeenCalledWith("sc-x"));
    expect(accept).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
  });

  it("still offers Revert in history — the record is the only copy of the old script", async () => {
    changes = [scriptChange({ id: "sc-old", status: "accepted", reviewed: true })];
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /^revert$/i }));
    await waitFor(() => expect(revertChange).toHaveBeenCalledWith("sc-old"));
  });

  it("disables Revert on an entry that stored no sources", async () => {
    changes = [scriptChange({ truncated: true, before: "", after: "" })];
    renderPanel();
    const button = (await screen.findByRole("button", {
      name: /^revert$/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("clears both journals from one button", async () => {
    journal = [heal({ status: "accepted" })];
    changes = [scriptChange({ status: "accepted", reviewed: true })];
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /clear history/i }));
    await waitFor(() => expect(clearSettled).toHaveBeenCalledWith("t1"));
    expect(clearSettledChanges).toHaveBeenCalledWith("t1");
  });
});
