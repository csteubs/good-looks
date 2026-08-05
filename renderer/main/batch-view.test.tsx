// Component tests for the Batch view.
//
// This is the first component test in the app, and the Batch view is the right
// place to start: it's where four independent pieces of state interact —
// user-defined order, tag filter, selection, and run state — and the
// interactions are exactly what the pure helpers can't prove on their own.
// `check:batch-order` shows moveToTarget reorders an array correctly; only a
// rendered component can show that dragging a row actually reorders the list
// the user sees, and that selection survives a filter change.
//
// The api module is mocked rather than the IPC bridge, so tests state intent
// ("the library contains these tests") instead of channel plumbing.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { RecorderSettings, TestRecord } from "../lib/recorder-types";
// Safe above the vi.mock calls below: Vitest hoists vi.mock above imports, so
// the mocks are registered before this module is evaluated.
import { BatchView } from "./batch-view";

// ── Mocks ────────────────────────────────────────────────────────────
const setSettings = vi.fn(async (_update: Partial<RecorderSettings>) => ({}) as RecorderSettings);
const batchRun = vi.fn(async (_testIds: string[]) => ({ batchId: "b1", alreadyRunning: false }));

let library: TestRecord[] = [];
let settings: Partial<RecorderSettings> = {};

vi.mock("../lib/api", () => ({
  api: {
    tests: { list: async () => library },
    recorder: {
      getSettings: async () => settings as RecorderSettings,
      setSettings: (u: Partial<RecorderSettings>) => setSettings(u),
    },
    batch: {
      list: async () => [],
      status: async () => null,
      run: (ids: string[]) => batchRun(ids),
      stop: async () => {},
      clearHistory: async () => ({ removed: 0 }),
    },
    on: () => () => {},
  },
}));

// Router is only used for "click a test name to open it"; a stub keeps the test
// focused on batch behavior rather than routing.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

function test_(id: string, name: string, tags?: string[]): TestRecord {
  return {
    id,
    name,
    url: "https://example.com",
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    scriptPath: `/tmp/${id}.spec.ts`,
    ...(tags ? { tags } : {}),
  } as TestRecord;
}

function renderView(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={qc}>
      <BatchView />
    </QueryClientProvider>,
  );
  return qc;
}

/** Checked state per test name, as the checklist currently shows it. */
function checkedByName(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const box of screen.getAllByLabelText(/^Include /)) {
    const name = (box.getAttribute("aria-label") ?? "")
      .replace("Include ", "")
      .replace(" in the batch", "");
    out[name] = box.getAttribute("data-state") === "checked";
  }
  return out;
}

/** Test names in the order they appear in the checklist. */
async function rowNames(): Promise<string[]> {
  const grips = await screen.findAllByLabelText(/^Drag to reorder /);
  return grips.map((g) => (g.getAttribute("aria-label") ?? "").replace("Drag to reorder ", ""));
}

beforeEach(() => {
  vi.clearAllMocks();
  library = [test_("a", "Alpha"), test_("b", "Beta"), test_("c", "Gamma")];
  settings = { batchOrder: [], defaultRunBrowser: "chromium" };
});

describe("BatchView ordering", () => {
  it("lists tests in library order when nothing is stored", async () => {
    renderView();
    expect(await rowNames()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("applies a stored custom order", async () => {
    settings = { batchOrder: ["c", "a", "b"], defaultRunBrowser: "chromium" };
    renderView();
    expect(await rowNames()).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  it("puts a test added since the order was saved at the END", async () => {
    // A curated suite must not reshuffle just because a test was recorded.
    settings = { batchOrder: ["c", "b", "a"], defaultRunBrowser: "chromium" };
    library = [...library, test_("d", "Delta")];
    renderView();
    expect(await rowNames()).toEqual(["Gamma", "Beta", "Alpha", "Delta"]);
  });

  it("still shows every test when the stored order references a deleted one", async () => {
    settings = { batchOrder: ["zzz", "c"], defaultRunBrowser: "chromium" };
    renderView();
    const names = await rowNames();
    expect(names).toHaveLength(3);
    expect(new Set(names)).toEqual(new Set(["Alpha", "Beta", "Gamma"]));
  });

  it("reorders the rendered list when a row is dragged onto another", async () => {
    renderView();
    expect(await rowNames()).toEqual(["Alpha", "Beta", "Gamma"]);

    const grips = await screen.findAllByLabelText(/^Drag to reorder /);
    // Drag "Gamma" (index 2) onto "Alpha" (index 0).
    fireEvent.dragStart(grips[2]);
    fireEvent.dragEnter(grips[0].closest("div")!);
    fireEvent.dragEnd(grips[2]);

    expect(await rowNames()).toEqual(["Gamma", "Alpha", "Beta"]);
    // …and it's persisted, or the order would vanish on the next visit.
    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ batchOrder: ["c", "a", "b"] }));
  });
});

describe("BatchView selection and filtering", () => {
  it("selects every test by default", async () => {
    renderView();
    await rowNames();
    const boxes = screen.getAllByLabelText(/^Include /);
    expect(boxes).toHaveLength(3);
    for (const b of boxes) expect(b.getAttribute("data-state")).toBe("checked");
  });

  it("keeps a test selected across a tag-filter change", async () => {
    // The regression the pure helpers can't catch: selection is stored by id
    // precisely so switching filters doesn't silently drop ticked tests.
    library = [test_("a", "Alpha", ["smoke"]), test_("b", "Beta", ["checkout"])];
    renderView();
    await rowNames();

    // Narrow to "smoke", then back to All.
    fireEvent.click(await screen.findByRole("button", { name: /^smoke/ }));
    expect(await rowNames()).toEqual(["Alpha"]);
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));

    const boxes = screen.getAllByLabelText(/^Include /);
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(b.getAttribute("data-state")).toBe("checked");
  });

  it("groups tags case-insensitively into one chip", async () => {
    library = [test_("a", "Alpha", ["smoke"]), test_("b", "Beta", ["Smoke"])];
    renderView();
    await rowNames();
    // One chip covering both, not two chips of one each.
    expect(await screen.findByRole("button", { name: /smoke · 2/i })).toBeTruthy();
  });

  it("runs the tests in the order shown, not library order", async () => {
    // The bug this guards: reordering rows visually while running the old order.
    settings = { batchOrder: ["c", "b", "a"], defaultRunBrowser: "chromium" };
    renderView();
    expect(await rowNames()).toEqual(["Gamma", "Beta", "Alpha"]);

    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));

    expect(batchRun).toHaveBeenCalledTimes(1);
    expect(batchRun.mock.calls[0][0]).toEqual(["c", "b", "a"]);
  });
});

// ── A test recorded after the view was opened ────────────────────────
// The reported bug: record a test, open Batch, and it isn't in the run even
// with the "All" filter showing. The row was there — it just arrived unticked,
// because selection was seeded exactly once, and "Run all" only runs what's
// ticked. Both paths below produce that: the library changing while the view
// is mounted, and mounting against a cache that is one test behind.
describe("BatchView newly created tests", () => {
  it("ticks a test recorded while the Batch view is open", async () => {
    const qc = renderView();
    expect(await rowNames()).toEqual(["Alpha", "Beta", "Gamma"]);

    library = [test_("d", "Delta"), ...library];
    await qc.invalidateQueries({ queryKey: ["tests"] });

    await waitFor(() => expect(screen.getAllByLabelText(/^Include /)).toHaveLength(4));
    expect(checkedByName()).toEqual({ Alpha: true, Beta: true, Gamma: true, Delta: true });
  });

  it("runs the new test too, rather than silently leaving it out", async () => {
    const qc = renderView();
    await rowNames();
    library = [test_("d", "Delta"), ...library];
    await qc.invalidateQueries({ queryKey: ["tests"] });
    await waitFor(() => expect(screen.getAllByLabelText(/^Include /)).toHaveLength(4));

    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    expect(batchRun.mock.calls[0][0]).toEqual(["a", "b", "c", "d"]);
  });

  it("ticks a test that only appears in the refetch after a stale first list", async () => {
    // How this actually happens in the app: the sidebar has already fetched the
    // library, so Batch mounts with that cached list and refetches behind it.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await qc.prefetchQuery({ queryKey: ["tests"], queryFn: async () => library });
    library = [test_("d", "Delta"), ...library];
    await qc.invalidateQueries({ queryKey: ["tests"] });

    renderView(qc);
    await waitFor(() => expect(screen.getAllByLabelText(/^Include /)).toHaveLength(4));
    expect(checkedByName()).toEqual({ Alpha: true, Beta: true, Gamma: true, Delta: true });
  });

  it("leaves a deliberately unticked test alone when a new one arrives", async () => {
    // The reason selection was seeded once: a refresh must not resurrect a
    // choice the user has just made.
    const qc = renderView();
    await rowNames();
    fireEvent.click(screen.getByLabelText("Include Beta in the batch"));
    expect(checkedByName().Beta).toBe(false);

    library = [test_("d", "Delta"), ...library];
    await qc.invalidateQueries({ queryKey: ["tests"] });

    await waitFor(() => expect(screen.getAllByLabelText(/^Include /)).toHaveLength(4));
    expect(checkedByName()).toEqual({ Alpha: true, Beta: false, Gamma: true, Delta: true });
  });

  it("does not re-tick anything when the library merely refetches unchanged", async () => {
    const qc = renderView();
    await rowNames();
    fireEvent.click(screen.getByLabelText("Include Beta in the batch"));

    // A new array with the same ids — what every refetch produces.
    library = library.map((t) => ({ ...t }));
    await qc.invalidateQueries({ queryKey: ["tests"] });
    await waitFor(() => expect(checkedByName().Alpha).toBe(true));

    expect(checkedByName().Beta).toBe(false);
  });
});

describe("BatchView reset order", () => {
  it("offers Reset order only once a custom order is in effect", async () => {
    renderView();
    await rowNames();
    expect(screen.queryByRole("button", { name: "Reset order" })).toBeNull();
  });

  it("shows Reset order for a custom order and clears it", async () => {
    settings = { batchOrder: ["c", "a", "b"], defaultRunBrowser: "chromium" };
    renderView();
    await rowNames();

    const reset = await screen.findByRole("button", { name: "Reset order" });
    fireEvent.click(reset);

    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ batchOrder: [] }));
  });
});

// ── Layout: nothing is stranded below the fold ───────────────────────
// Same fix as Stats — the page ScrollArea used h-full inside a flex column, so
// its last child sat below the window. The sizing classes are asserted at
// source level in check:scroll-layout (jsdom has no layout engine and the SDK's
// ScrollArea exposes no stable DOM marker); these pin what IS observable here.
describe("BatchView layout", () => {
  it("shows the run controls, the checklist and the summary together", async () => {
    library = [test_("a", "Alpha"), test_("b", "Beta")];
    renderView();
    await rowNames();
    expect(screen.getByRole("button", { name: /^Run/ })).toBeTruthy();
    expect(screen.getAllByLabelText(/^Include /)).toHaveLength(2);
    expect(screen.getByText(/Tests run one at a time/i)).toBeTruthy();
  });

  it("keeps the last row's controls present with a long library", async () => {
    // A long list is what pushed content past the fold in the first place.
    library = Array.from({ length: 40 }, (_, i) => test_(`t${i}`, `Test ${i}`));
    renderView();
    const names = await rowNames();
    expect(names).toHaveLength(40);
    // The final row still carries its own controls rather than being clipped.
    const grips = screen.getAllByLabelText(/^Drag to reorder /);
    expect(grips[grips.length - 1].getAttribute("aria-label")).toContain("Test 39");
  });
});

describe("BatchView empty state", () => {
  it("explains itself when the library is empty", async () => {
    library = [];
    renderView();
    expect(await screen.findByText(/No tests to run/i)).toBeTruthy();
  });
});

// Keep `within` referenced for future row-scoped assertions without tripping
// the unused-import lint rule.
void within;
