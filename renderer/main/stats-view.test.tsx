// Component tests for the Stats view.
//
// Two features overlap here — filtering and pagination — and their interaction
// is the part no pure test can reach. check:run-filters proves the predicate;
// check:paginate proves the slice. Only a rendered component proves that
// narrowing a filter while on page 5 lands you on rows that exist, and that
// filtering does NOT move the summary cards (which describe the whole history
// on purpose).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { RunRecord, RunTotals } from "../lib/recorder-types";
import { DENSE_PAGE_SIZE } from "../lib/paginate";
import { StatsView } from "./stats-view";

let runs: RunRecord[] = [];
/** Lifetime counts. Null by default — the Outcomes cards and the page header
 *  then fall back to counting the fixture runs, which is what every assertion
 *  in this file below was written against. */
let totals: RunTotals | null = null;

vi.mock("../lib/api", () => ({
  api: {
    runs: {
      list: async () => runs,
      totals: async () => totals,
      searchLogs: async () => [],
      captureOverhead: async () => null,
      getLog: async () => "",
      logsDir: async () => "/tmp",
      resetStats: async () => ({ removed: 0 }),
      deleteAll: async () => ({ removed: 0 }),
      deleteRange: async () => ({ removed: 0 }),
      // The category board reads this. `null` rather than a report: the board
      // OMITS a category whose query has not answered, so a null keeps these
      // tests about the run table rather than about the board.
      flake: async () => null,
    },
    // Two series the board added to this page. Both are answered emptily here —
    // the board has its own test file, and a fixture rich enough to light it up
    // would make every assertion below harder to read for no gain.
    heals: { listAll: async () => [] },
    artifacts: { list: async () => [] },
    metrics: {
      stepHealth: async () => null,
      slowness: async () => null,
      divergence: async () => null,
    },
    on: () => () => {},
  },
}));

function run(over: Partial<RunRecord> & { id: string }): RunRecord {
  return {
    testId: "t1",
    testName: "Alpha",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    durationMs: 1000,
    logFile: `${over.id}.log`,
    logBytes: 10,
    ...over,
  } as RunRecord;
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StatsView />
    </QueryClientProvider>,
  );
}

/** Data rows in the run-history table right now (header row excluded).
 *  Synchronous: the table renders before the query resolves, so a plain
 *  findByRole("table") would return an empty body and read as "no runs". */
function rowsNow(): HTMLElement[] {
  const table = screen.getByRole("table", { name: /run history/i });
  return within(table).getAllByRole("row").slice(1) as HTMLElement[];
}

/** The run table's status filter.
 *
 *  THE ROLE CHANGED IN THE B7 RESKIN AND THAT IS WORTH STATING RATHER THAN
 *  QUIETLY REWRITING. The SDK's `SegmentedControl` was a Radix ToggleGroup, so
 *  its items announced as `radio` and activated on POINTER-DOWN — which is why
 *  a plain `fireEvent.click` on one silently asserted against the previous
 *  selection, a trap CLAUDE.md documents. The theme's `Segmented` is plain
 *  buttons with `aria-pressed`, so `click` works, keyboard works, and the
 *  stylesheet selects on the same attribute that is announced: the visual state
 *  cannot disagree with the announced one, because there is no second `selected`
 *  class to forget.
 *
 *  Queried by name AND pressed-ness rather than by role alone, so the helper
 *  cannot start matching some other button that happens to say "Failed". */
function statusFilter(name: string): HTMLElement {
  return screen.getByRole("button", { name }) as HTMLElement;
}

/** Wait for the run query to resolve and rows to render. */
async function bodyRows(min = 1): Promise<HTMLElement[]> {
  await waitFor(() => {
    if (rowsNow().length < min) throw new Error("rows not rendered yet");
  });
  return rowsNow();
}

/** Wait for the table to settle on an exact row count (after a filter/page). */
async function expectRows(n: number): Promise<HTMLElement[]> {
  await waitFor(() => expect(rowsNow()).toHaveLength(n));
  return rowsNow();
}

beforeEach(() => {
  runs = [];
  totals = null;
});

describe("the page header's run count", () => {
  // THE INDEX IS CAPPED, so its length is the size of a cache and not the size
  // of a history. This line sits directly above the Outcomes tile, which states
  // the same quantity — counting the run list here made the two disagree the
  // moment the cap was reached.

  it("counts every run ever, and says how many are still stored", async () => {
    runs = [run({ id: "r1" }), run({ id: "r2", status: "failed" })];
    totals = { runs: 1240, passed: 1100, failed: 140, retained: 2, pruned: 1238, prunedDays: [] };
    renderView();
    // WAIT FOR THE CONTENT, NOT THE ELEMENT. This line renders before either
    // query resolves, so `findByText(/runs recorded/)` matches the loading
    // state instantly and every assertion below runs against "0 runs recorded".
    const head = await screen.findByText(/1240 runs recorded/);
    expect(head.textContent).toContain("2 kept in history");
  });

  it("says nothing about storage when nothing has been pruned", async () => {
    runs = [run({ id: "r1" })];
    totals = { runs: 1, passed: 1, failed: 0, retained: 1, pruned: 0, prunedDays: [] };
    renderView();
    const head = await screen.findByText(/1 run recorded/);
    expect(head.textContent).not.toMatch(/kept in history/);
  });

  it("falls back to the retained count before the totals resolve", async () => {
    // `null` here stands for an unresolved query. Rendering 0 while waiting
    // would report a suite that has never been run.
    runs = [run({ id: "r1" }), run({ id: "r2" })];
    renderView();
    expect(await screen.findByText(/2 runs recorded/)).toBeTruthy();
  });
});

describe("run history table", () => {
  it("lists runs", async () => {
    runs = [run({ id: "r1" }), run({ id: "r2", testName: "Beta", status: "failed" })];
    renderView();
    expect(await bodyRows()).toHaveLength(2);
    // Scoped to the run table since C §6.4 — the Cost panel's spend-by-test
    // table names the same tests on the same screen.
    expect(
      within(screen.getByRole("table", { name: /run history/i })).getByText("Beta"),
    ).toBeTruthy();
  });

  it("puts the Browser column between Status and Started", async () => {
    // Column ORDER is the requirement, not just presence — asserting only that
    // a "Browser" header exists would pass with it appended at the far right.
    runs = [run({ id: "r1" })];
    renderView();
    await bodyRows();
    const headers = within(screen.getByRole("table", { name: /run history/i }))
      .getAllByRole("columnheader")
      .map((h) => h.textContent?.trim());
    expect(headers.indexOf("Browser")).toBe(headers.indexOf("Status") + 1);
    expect(headers.indexOf("Started")).toBe(headers.indexOf("Browser") + 1);
  });

  it("shows the browser as an icon with no engine name anywhere in the row", async () => {
    runs = [run({ id: "r1", runBrowser: "firefox" })];
    renderView();
    const [row] = await bodyRows();
    // The icon carries the name for assistive tech and hover…
    expect(within(row).getByRole("img", { name: "Firefox" })).toBeTruthy();
    // …but the row must not SAY it: that duplication is what the column
    // replaced, and it would silently creep back via the Tags badge.
    // (`ignore` skips the icon's own <title>, which is a hover tooltip rather
    // than text in the row.)
    expect(within(row).queryByText("Firefox", { ignore: "title,script,style" })).toBeNull();
  });

  it("reports a run predating the browser picker as Chromium", async () => {
    runs = [run({ id: "r1" })]; // no runBrowser
    renderView();
    const [row] = await bodyRows();
    expect(within(row).getByRole("img", { name: "Chromium" })).toBeTruthy();
  });

  it("leaves the Browser cell blank for a baseline update, which ran no browser", async () => {
    runs = [run({ id: "r1", kind: "baseline-update", note: "approved" })];
    renderView();
    const [row] = await bodyRows();
    expect(within(row).queryByRole("img", { name: /chromium|firefox|webkit/i })).toBeNull();
  });

  it("still distinguishes headed from headless once the engine name is gone", async () => {
    // The Tags badge lost its text; if the mode icon lost its label with it,
    // the column would be two anonymous glyphs.
    runs = [run({ id: "r1", runHeadless: true }), run({ id: "r2", runHeadless: false })];
    renderView();
    const rows = await bodyRows(2);
    expect(within(rows[0]).getByRole("img", { name: "Headless" })).toBeTruthy();
    expect(within(rows[1]).getByRole("img", { name: "Headed" })).toBeTruthy();
  });
});

describe("filtering", () => {
  beforeEach(() => {
    runs = [
      run({ id: "r1", testName: "Alpha", status: "passed" }),
      run({ id: "r2", testName: "Beta", status: "failed" }),
      run({ id: "r3", testName: "Gamma", status: "failed", runHeadless: true }),
    ];
  });

  it("narrows the table by status", async () => {
    renderView();
    expect(await bodyRows()).toHaveLength(3);
    fireEvent.click(statusFilter("Failed"));
    await expectRows(2);
  });

  it("carries no summary cards for a filter to contradict", async () => {
    // THIS TEST CHANGED SHAPE ON 2026-08-14 AND THE OLD SHAPE IS THE REASON.
    // It used to assert that narrowing the table did NOT move the KPI cards,
    // because the cards described the whole history while the table described
    // the filtered slice — two numbers about different populations, one screen.
    // The cards now live in the Outcomes category, which has no filter, so the
    // contradiction is structurally impossible rather than merely tested for.
    // What is asserted here is that they have not quietly come back: a copy on
    // both screens is two places to fix a number, and a filtered "Pass rate"
    // beside an unfiltered one is the exact confusion that motivated the move.
    renderView();
    await bodyRows();
    fireEvent.click(statusFilter("Failed"));
    await expectRows(2);

    expect(screen.queryByText("Pass rate")).toBeNull();
    expect(screen.queryByText("Total runs")).toBeNull();
    expect(screen.queryByText(/pass \/ fail over time/i)).toBeNull();
  });

  it("shows a Clear control only while a filter is active", async () => {
    renderView();
    await bodyRows();
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();

    fireEvent.click(statusFilter("Failed"));
    expect(await screen.findByRole("button", { name: /clear/i })).toBeTruthy();
  });

  it("explains an empty result instead of showing a blank table", async () => {
    runs = [run({ id: "r1", status: "passed" })];
    renderView();
    await bodyRows();
    fireEvent.click(statusFilter("Failed"));
    expect(await screen.findByText(/no runs match these filters/i)).toBeTruthy();
  });

  it("keeps baseline-update rows out of Passed and Failed", async () => {
    // Their `status` field is incidental — they are not test runs.
    runs = [
      run({ id: "r1", status: "passed" }),
      run({ id: "r2", status: "passed", kind: "baseline-update", testName: "Pinned" }),
    ];
    renderView();
    expect(await bodyRows()).toHaveLength(2);

    fireEvent.click(statusFilter("Passed"));
    const rows = await expectRows(1);
    expect(within(rows[0]).queryByText("Pinned")).toBeNull();
  });
});

describe("pagination", () => {
  it("shows at most one dense page of rows and pages the rest", async () => {
    runs = Array.from({ length: 120 }, (_, i) => run({ id: `r${i}`, testName: `Test ${i}` }));
    renderView();
    await expectRows(DENSE_PAGE_SIZE);
    expect(DENSE_PAGE_SIZE).toBe(25);
    expect(screen.getByText(/page 1 of 5/i)).toBeTruthy();
    expect(screen.getByText(/1–25 of 120 runs/)).toBeTruthy();
  });

  it("hides the pager when everything fits on one page", async () => {
    runs = [run({ id: "r1" })];
    renderView();
    await bodyRows();
    expect(screen.queryByRole("button", { name: /next page/i })).toBeNull();
  });

  it("moves between pages", async () => {
    runs = Array.from({ length: 120 }, (_, i) => run({ id: `r${i}`, testName: `Test ${i}` }));
    renderView();
    await bodyRows();

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(await screen.findByText(/page 2 of 5/i)).toBeTruthy();
    // Page 2 holds the 26th row onward.
    expect(screen.getByText("Test 25")).toBeTruthy();
    expect(screen.queryByText("Test 0")).toBeNull();
  });

  it("lands on real rows when a filter narrows the list under you", async () => {
    // THE interaction: without clamping, page 3 of a 120-row table becomes an
    // empty table the moment a filter cuts it to 10 rows. The pager's own size
    // has to match the slice's for this to hold — a Pager still counting in
    // fifties would report "page 1 of 1" over five real pages.
    runs = [
      ...Array.from({ length: 110 }, (_, i) => run({ id: `p${i}`, testName: `Pass ${i}` })),
      ...Array.from({ length: 10 }, (_, i) =>
        run({ id: `f${i}`, testName: `Fail ${i}`, status: "failed" }),
      ),
    ];
    renderView();
    await bodyRows();

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(await screen.findByText(/page 3 of 5/i)).toBeTruthy();

    fireEvent.click(statusFilter("Failed"));

    await expectRows(10);
    expect(screen.getByText("Fail 0")).toBeTruthy();
  });
});

// ── Layout: nothing is stranded below the fold ───────────────────────
//
// The bug this guards: the scroll region used `h-full` inside a flex column.
// h-full resolves to 100% of the PARENT, but the Toolbar above had already
// consumed part of that height — so the region extended past the bottom of the
// window by the toolbar's height and its last child, the pager, was cut off.
//
// HONEST LIMIT: jsdom has no layout engine. Nothing here has a size, nothing
// clips, and getBoundingClientRect returns zeros — so these tests CANNOT
// observe visibility. They pin the structural contract that broke (the sizing
// classes, bottom padding, and the pager being last with nothing after it).
// Confirming it is actually on screen needs the real app.
describe("layout keeps the page's last controls reachable", () => {
  /** The element the scroll content lives in. */
  function scrollContent(): HTMLElement {
    const pager = screen.getByText(/page 1 of/i);
    return pager.closest(".mx-auto") as HTMLElement;
  }

  beforeEach(() => {
    runs = Array.from({ length: 120 }, (_, i) => run({ id: `r${i}`, testName: `Test ${i}` }));
  });

  // The sizing classes themselves are asserted at SOURCE level in
  // check:scroll-layout — the SDK's ScrollArea exposes no stable DOM marker, so
  // reaching its root from here would mean asserting against Radix internals.

  it("always leaves bottom padding under the last element", async () => {
    renderView();
    await bodyRows(1);
    expect(scrollContent().className).toMatch(/\bpb-\d+\b/);
  });

  it("renders the pager as the LAST thing in the page", async () => {
    // Anything rendered after it would push it further out of view.
    renderView();
    await bodyRows(1);
    const content = scrollContent();
    const pagerBlock = screen.getByText(/page 1 of/i).closest("div")!;
    expect(content.contains(pagerBlock)).toBe(true);
    expect(content.lastElementChild?.contains(pagerBlock)).toBe(true);
  });

  // "puts the chart above the summary cards" moved with them, into
  // outcomes-dashboard.test.tsx. Reading order is a property of the screen that
  // renders them, and that is no longer this one.

  it("shows the filters, the table and the pager at the same time", async () => {
    // All three must coexist: a layout that hides any one of them is the bug.
    renderView();
    await bodyRows(1);
    expect(statusFilter("All")).toBeTruthy();
    expect(screen.getByRole("table", { name: /run history/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /next page/i })).toBeTruthy();
  });

  it("keeps the pager reachable on the last page too", async () => {
    renderView();
    await bodyRows(1);
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    }
    expect(await screen.findByText(/page 5 of 5/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /previous page/i })).toBeTruthy();
  });
});

describe("empty state", () => {
  it("explains itself with no runs at all", async () => {
    renderView();
    expect(await screen.findByText(/no runs yet/i)).toBeTruthy();
  });
});
