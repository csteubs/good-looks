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
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { HealListEntry, ScriptChangeListEntry } from "../lib/recorder-types";
import { PAGE_SIZE } from "../lib/paginate";
import { HealsView } from "./heals-view";

let journal: HealListEntry[] = [];
let changes: ScriptChangeListEntry[] = [];
const accept = vi.fn(async (_id: string, _locator?: unknown) => null);
const revert = vi.fn(async (_id: string) => null);
const remove = vi.fn(async (_id: string) => ({ removed: 1 }));
const clearAllSettled = vi.fn(async () => ({ removed: 2 }));
const acceptChange = vi.fn(async (_id: string) => null);
const revertChange = vi.fn(async (_id: string) => null);
const removeChange = vi.fn(async (_id: string) => ({ removed: 1 }));
const clearAllSettledChanges = vi.fn(async () => ({ removed: 0 }));

vi.mock("../lib/api", () => ({
  api: {
    heals: {
      listAll: async () => journal,
      accept: (id: string, locator?: unknown) => accept(id, locator),
      revert: (id: string) => revert(id),
      remove: (id: string) => remove(id),
      clearAllSettled: () => clearAllSettled(),
    },
    scriptChanges: {
      listAll: async () => changes,
      accept: (id: string) => acceptChange(id),
      revert: (id: string) => revertChange(id),
      remove: (id: string) => removeChange(id),
      clearAllSettled: () => clearAllSettledChanges(),
    },
  },
}));

function scriptChange(partial: Partial<ScriptChangeListEntry> = {}): ScriptChangeListEntry {
  return {
    id: "sc1",
    testId: "t1",
    testName: "Checkout",
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
  changes = [];
});

describe("HealsView", () => {
  it("explains itself when nothing has been healed", async () => {
    renderView();
    expect(await screen.findByText(/Nothing yet/i)).toBeTruthy();
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
    expect(screen.getByText("1–50 of 120 records")).toBeTruthy();
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
    expect(await screen.findByText(/Select a record/i)).toBeTruthy();
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
    // The words are the design's four (B2), and they are shorter than the
    // "Suggestion only" / "Applied to the test" they replaced because the chip
    // is a FIXED WIDTH — the column's one edge is the contract, and a chip that
    // sizes to its own sentence is what breaks it.
    journal = [heal({ applied: false })];
    renderView();
    fireEvent.click(await screen.findByText('getByTestId("submit-v1").click()'));
    // The row and the detail both carry the chip; both must agree.
    await waitFor(() => expect(screen.getAllByText("Suggested").length).toBeGreaterThan(0));
    expect(screen.queryByText("Applied")).toBeNull();
    // And labels the action by what it will do.
    expect(screen.getByRole("button", { name: /apply/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeTruthy();
  });

  it("gives each of the four states its own chip, and only two of them a hue", async () => {
    // ONLY TWO OF THE FOUR ARE OUTCOMES. `Accepted` is a result and `Applied`
    // is the one that should catch the eye — the stored test has already
    // changed and nobody has looked. `Suggested` is the open item (cyan is the
    // palette's "live / focus"), and `Reverted` is settled with nothing to
    // report, so it takes no tone at all.
    //
    // Asserted on `data-tone` rather than on colour: the dom project runs with
    // `css: false`, so a computed-style check reads "" for every one of them
    // and would pass against a column drawn entirely in green.
    journal = [
      heal({ id: "a", status: "pending", applied: true }),
      heal({ id: "b", status: "pending", applied: false }),
      heal({ id: "c", status: "accepted" }),
      heal({ id: "d", status: "reverted" }),
    ];
    renderView();
    await screen.findByText("Applied");

    const tones = new Map(
      [...document.querySelectorAll('[data-gl="status-chip"]')].map((el) => [
        el.textContent ?? "",
        (el as HTMLElement).dataset.tone,
      ]),
    );
    expect(tones.get("Applied")).toBe("amber");
    expect(tones.get("Suggested")).toBe("cyan");
    expect(tones.get("Accepted")).toBe("phos");
    expect(tones.get("Reverted")).toBe("neutral");
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
    expect(await screen.findByText(/3 records · 1 needing review/i)).toBeTruthy();
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

describe("HealsView deleting records", () => {
  /** Open the confirmation behind `name` and return once its dialog is up. */
  async function openConfirm(name: RegExp) {
    fireEvent.click(await screen.findByRole("button", { name }));
    return await screen.findByRole("alertdialog");
  }

  /** Press the Delete inside the open dialog, not the trigger that opened it —
   *  both are labelled "Delete", and clicking the trigger again would close the
   *  dialog and silently assert nothing. */
  function confirmDelete(dialog: HTMLElement) {
    const button = within(dialog)
      .getAllByRole("button")
      .find((b) => /^delete$/i.test(b.textContent ?? ""));
    expect(button).toBeTruthy();
    fireEvent.click(button as HTMLElement);
  }

  it("deletes the selected heal, and only after confirming", async () => {
    journal = [heal({ id: "h7" })];
    renderView();
    fireEvent.click(await screen.findByText('getByTestId("submit-v1").click()'));

    const dialog = await openConfirm(/^delete$/i);
    // Opening the dialog must not delete anything by itself.
    expect(remove).not.toHaveBeenCalled();
    confirmDelete(dialog);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("h7"));
  });

  it("backs out cleanly when the confirmation is cancelled", async () => {
    journal = [heal({ id: "h7" })];
    renderView();
    fireEvent.click(await screen.findByText('getByTestId("submit-v1").click()'));

    const dialog = await openConfirm(/^delete$/i);
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(remove).not.toHaveBeenCalled();
  });

  it("warns that deleting an applied, unreviewed heal throws away the undo", async () => {
    // The dangerous case. The step has ALREADY been changed on disk and this
    // record holds the locator it replaced, so deleting it leaves the change in
    // place with no way back. A generic "can't be undone" wouldn't say that.
    journal = [heal({ applied: true, status: "pending" })];
    renderView();
    fireEvent.click(await screen.findByText('getByTestId("submit-v1").click()'));
    const dialog = await openConfirm(/^delete$/i);
    expect(within(dialog).getByText(/no way to undo it/i)).toBeTruthy();
  });

  it("doesn't cry wolf over a heal that changed nothing", async () => {
    // Under "suggest" mode the stored test was never touched, so deleting the
    // record costs nothing. Reusing the scary copy here is how a warning stops
    // being read at all.
    journal = [heal({ applied: false, status: "pending" })];
    renderView();
    fireEvent.click(await screen.findByText('getByTestId("submit-v1").click()'));
    const dialog = await openConfirm(/^delete$/i);
    expect(within(dialog).getByText(/never applied/i)).toBeTruthy();
    expect(within(dialog).queryByText(/no way to undo it/i)).toBeNull();
  });

  it("offers delete on a settled heal, which review buttons no longer are", async () => {
    journal = [heal({ status: "accepted" })];
    renderView();
    fireEvent.click(await screen.findByText('getByTestId("submit-v1").click()'));
    await screen.findByText("now");
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeTruthy();
    const dialog = await openConfirm(/^delete$/i);
    expect(within(dialog).getByText(/removes the record only/i)).toBeTruthy();
  });

  it("drops the selection when its record is deleted", async () => {
    // The detail pane is driven by the selected id. Left set, it goes on
    // describing a heal that no longer exists — offering Delete, Keep and
    // Revert on a record that is gone — until the refetch lands.
    journal = [heal({ id: "h7" })];
    renderView();
    fireEvent.click(await screen.findByText('getByTestId("submit-v1").click()'));
    await screen.findByText("now");

    confirmDelete(await openConfirm(/^delete$/i));
    await waitFor(() => expect(remove).toHaveBeenCalled());
    expect(await screen.findByText(/Select a record/i)).toBeTruthy();
  });

  it("clears settled history in bulk, keeping what still needs review", async () => {
    journal = [
      heal({ id: "a", status: "pending" }),
      heal({ id: "b", status: "accepted" }),
      heal({ id: "c", status: "reverted" }),
    ];
    renderView();
    const dialog = await openConfirm(/clear history/i);
    // The count is the user's only preview of what a bulk delete will take.
    expect(within(dialog).getByText(/delete 2 settled records\?/i)).toBeTruthy();
    expect(within(dialog).getByText(/needing review are kept/i)).toBeTruthy();
    confirmDelete(dialog);
    await waitFor(() => expect(clearAllSettled).toHaveBeenCalled());
  });

  it("hides Clear history when there is no settled history to clear", async () => {
    journal = [heal({ id: "a", status: "pending" })];
    renderView();
    await screen.findByText('getByTestId("submit-v1").click()');
    expect(screen.queryByRole("button", { name: /clear history/i })).toBeNull();
  });

  it("never offers a way to bulk-delete heals that still need review", async () => {
    // A pending heal is the only stored copy of the locator its step used to
    // have. One click that took those with it would destroy the undo for
    // changes already made to tests — the thing the journal exists to prevent.
    journal = [heal({ id: "a", status: "pending" }), heal({ id: "b", status: "accepted" })];
    renderView();
    const dialog = await openConfirm(/clear history/i);
    expect(within(dialog).getByText(/delete 1 settled record\?/i)).toBeTruthy();
    expect(within(dialog).queryByText(/all heals|everything/i)).toBeNull();
  });
});

describe("HealsView — script changes", () => {
  /** Same helper as the block above, which scopes its own. */
  async function openConfirm(name: RegExp) {
    fireEvent.click(await screen.findByRole("button", { name }));
    return await screen.findByRole("alertdialog");
  }

  it("lists them beside heals, interleaved by time rather than grouped by kind", async () => {
    // The question this screen answers is "what has been changing my tests".
    // Two lists sorted separately would make the user read both to answer it.
    journal = [heal({ id: "h-old", stepLabel: "step old", at: 1000 })];
    changes = [scriptChange({ id: "sc-new", at: 3000 })];
    renderView();

    await screen.findByText(/AI Debug - claude-sonnet-4/i);
    const rows = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((t) => t.includes("step old") || t.includes("Script"));
    expect(rows[0]).toContain("Script");
    expect(rows[1]).toContain("step old");
  });

  it("names the model that wrote the fix", async () => {
    changes = [scriptChange({ model: "llama3.1:70b" })];
    renderView();
    expect(await screen.findByText(/AI Debug - llama3\.1:70b/i)).toBeTruthy();
  });

  it("degrades to a bare label when the entry has no model", async () => {
    // Sessions stored before the model was stamped have none, and "AI Debug -
    // undefined" is worse than saying less.
    changes = [scriptChange({ model: undefined })];
    renderView();
    const labels = await screen.findAllByText(/AI Debug/i);
    expect(labels.every((l) => !/undefined/.test(l.textContent ?? ""))).toBe(true);
  });

  it("calls a hand edit a hand edit", async () => {
    changes = [scriptChange({ origin: "manual", model: undefined, reviewed: true, status: "accepted" })];
    renderView();
    expect(await screen.findByText(/Edited by hand/i)).toBeTruthy();
    expect(screen.queryByText(/AI Debug/i)).toBeNull();
  });

  it("shows the diff in the detail pane, so the change can be judged", async () => {
    changes = [scriptChange({ before: "keep\ndrop\n", after: "keep\nadd\n" })];
    renderView();
    fireEvent.click(await screen.findByText(/Script ·/));

    // The diff itself, not just a count — the count can be right while the
    // stored sources are the wrong pair.
    await waitFor(() => expect(screen.getByText(/drop/)).toBeTruthy());
    expect(screen.getByText(/add/)).toBeTruthy();
  });

  it("warns that an unreviewed change is already in the test", async () => {
    changes = [scriptChange({ status: "pending", reviewed: false })];
    renderView();
    fireEvent.click(await screen.findByText(/Script ·/));
    expect(await screen.findByText(/rewritten without review/i)).toBeTruthy();
  });

  it("keeps and reverts through the script-change API, not the heal one", async () => {
    // The two journals are separate stores; crossing them would report success
    // and settle nothing.
    changes = [scriptChange({ id: "sc-x" })];
    renderView();
    fireEvent.click(await screen.findByText(/Script ·/));

    fireEvent.click(await screen.findByRole("button", { name: /^keep$/i }));
    await waitFor(() => expect(acceptChange).toHaveBeenCalledWith("sc-x"));
    fireEvent.click(screen.getByRole("button", { name: /^revert$/i }));
    await waitFor(() => expect(revertChange).toHaveBeenCalledWith("sc-x"));
    expect(accept).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
  });

  it("still offers Revert on a settled change — the record is the only copy", async () => {
    changes = [scriptChange({ status: "accepted", reviewed: true })];
    renderView();
    fireEvent.click(await screen.findByText(/Script ·/));
    await screen.findByRole("button", { name: /^revert$/i });
    // Settled, so the review decision is gone but the undo is not.
    expect(screen.queryByRole("button", { name: /^keep$/i })).toBeNull();
  });

  it("refuses to offer an undo it does not have", async () => {
    // A truncated entry stored no sources, so a Revert that went ahead would
    // write an empty spec over a working test.
    changes = [scriptChange({ truncated: true, before: "", after: "" })];
    renderView();
    fireEvent.click(await screen.findByText(/Script ·/));
    const revertBtn = await screen.findByRole("button", { name: /^revert$/i });
    expect((revertBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("says a deleted record is the last copy of the previous script", async () => {
    changes = [scriptChange()];
    renderView();
    fireEvent.click(await screen.findByText(/Script ·/));
    const dialog = await openConfirm(/^delete$/i);
    expect(within(dialog).getByText(/only copy of the script/i)).toBeTruthy();
  });

  it("counts both journals in the header and the bulk clear", async () => {
    journal = [heal({ id: "h1", status: "accepted" })];
    changes = [scriptChange({ id: "sc1", status: "pending" })];
    renderView();
    expect(await screen.findByText(/2 records · 1 needing review/i)).toBeTruthy();

    const dialog = await openConfirm(/clear history/i);
    fireEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    // Both stores, one button: a "Clear history" that emptied half the list
    // reads as a control that didn't work.
    await waitFor(() => expect(clearAllSettled).toHaveBeenCalled());
    expect(clearAllSettledChanges).toHaveBeenCalled();
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
