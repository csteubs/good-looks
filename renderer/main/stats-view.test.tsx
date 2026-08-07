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

import type { RunRecord } from "../lib/recorder-types";
import { StatsView } from "./stats-view";

let runs: RunRecord[] = [];

vi.mock("../lib/api", () => ({
  api: {
    runs: {
      list: async () => runs,
      searchLogs: async () => [],
      captureOverhead: async () => null,
      getLog: async () => "",
      logsDir: async () => "/tmp",
      resetStats: async () => ({ removed: 0 }),
      deleteAll: async () => ({ removed: 0 }),
      deleteRange: async () => ({ removed: 0 }),
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
  const table = screen.getByRole("table");
  return within(table).getAllByRole("row").slice(1) as HTMLElement[];
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
});

describe("run history table", () => {
  it("lists runs", async () => {
    runs = [run({ id: "r1" }), run({ id: "r2", testName: "Beta", status: "failed" })];
    renderView();
    expect(await bodyRows()).toHaveLength(2);
    expect(screen.getByText("Beta")).toBeTruthy();
  });

  it("puts the Browser column between Status and Started", async () => {
    // Column ORDER is the requirement, not just presence — asserting only that
    // a "Browser" header exists would pass with it appended at the far right.
    runs = [run({ id: "r1" })];
    renderView();
    await bodyRows();
    const headers = within(screen.getByRole("table"))
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
    fireEvent.click(screen.getByRole("radio", { name: "Failed" }));
    await expectRows(2);
  });

  it("does NOT change the summary cards when filtering", async () => {
    // Deliberate: the cards describe the whole history, so narrowing the table
    // must never silently redefine "pass rate".
    renderView();
    await bodyRows();
    const totalBefore = screen.getByText("Total runs").parentElement?.textContent;

    fireEvent.click(screen.getByRole("radio", { name: "Failed" }));
    await expectRows(2);

    expect(screen.getByText("Total runs").parentElement?.textContent).toBe(totalBefore);
  });

  it("shows a Clear control only while a filter is active", async () => {
    renderView();
    await bodyRows();
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Failed" }));
    expect(await screen.findByRole("button", { name: /clear/i })).toBeTruthy();
  });

  it("explains an empty result instead of showing a blank table", async () => {
    runs = [run({ id: "r1", status: "passed" })];
    renderView();
    await bodyRows();
    fireEvent.click(screen.getByRole("radio", { name: "Failed" }));
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

    fireEvent.click(screen.getByRole("radio", { name: "Passed" }));
    const rows = await expectRows(1);
    expect(within(rows[0]).queryByText("Pinned")).toBeNull();
  });
});

describe("pagination", () => {
  it("shows at most 50 rows and pages the rest", async () => {
    runs = Array.from({ length: 120 }, (_, i) => run({ id: `r${i}`, testName: `Test ${i}` }));
    renderView();
    await expectRows(50);
    expect(screen.getByText(/page 1 of 3/i)).toBeTruthy();
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
    expect(await screen.findByText(/page 2 of 3/i)).toBeTruthy();
    // Page 2 holds the 51st row onward.
    expect(screen.getByText("Test 50")).toBeTruthy();
    expect(screen.queryByText("Test 0")).toBeNull();
  });

  it("lands on real rows when a filter narrows the list under you", async () => {
    // THE interaction: without clamping, page 3 of a 120-row table becomes an
    // empty table the moment a filter cuts it to 10 rows.
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
    expect(await screen.findByText(/page 3 of 3/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Failed" }));

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

  it("shows the filters, the table and the pager at the same time", async () => {
    // All three must coexist: a layout that hides any one of them is the bug.
    renderView();
    await bodyRows(1);
    expect(screen.getByRole("radio", { name: "All" })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("button", { name: /next page/i })).toBeTruthy();
  });

  it("keeps the pager reachable on the last page too", async () => {
    renderView();
    await bodyRows(1);
    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(await screen.findByText(/page 3 of 3/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /previous page/i })).toBeTruthy();
  });
});

describe("empty state", () => {
  it("explains itself with no runs at all", async () => {
    renderView();
    expect(await screen.findByText(/no runs yet/i)).toBeTruthy();
  });
});
