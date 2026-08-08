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

import type {
  BatchRowOptions,
  RecorderSettings,
  RunBrowser,
  TestRecord,
} from "../lib/recorder-types";
// Safe above the vi.mock calls below: Vitest hoists vi.mock above imports, so
// the mocks are registered before this module is evaluated.
import { BatchView } from "./batch-view";

// ── Mocks ────────────────────────────────────────────────────────────
const setSettings = vi.fn(async (_update: Partial<RecorderSettings>) => ({}) as RecorderSettings);
const batchRun = vi.fn(
  async (_testIds: string[], _opts?: Record<string, unknown>) => ({
    batchId: "b1",
    alreadyRunning: false,
  }),
);

let library: TestRecord[] = [];
let settings: Partial<RecorderSettings> = {};
// Live backend pushes, so a test can put the view into a mid-batch state
// without a backend. Keyed by channel, same shape as the real api.on.
const listeners = new Map<string, ((payload: unknown) => void)[]>();

vi.mock("../lib/api", () => ({
  api: {
    tests: { list: async () => library },
    recorder: {
      // batchTestOptions defaults to "every test ticked on one engine" — the
      // state a user who has used this view before has stored. Most tests below
      // are about something other than selection and just need a runnable
      // batch; the ones that care about the empty-storage default pass
      // `batchTestOptions: {}` explicitly. Resolved HERE rather than in
      // beforeEach so a test can reassign `library` first.
      getSettings: async () =>
        ({
          ...settings,
          batchTestOptions: settings.batchTestOptions ?? allSelected(),
        }) as RecorderSettings,
      setSettings: (u: Partial<RecorderSettings>) => setSettings(u),
    },
    batch: {
      list: async () => [],
      status: async () => null,
      run: (ids: string[], opts?: Record<string, unknown>) => batchRun(ids, opts),
      stop: async () => {},
      clearHistory: async () => ({ removed: 0 }),
    },
    on: (channel: string, fn: (payload: unknown) => void) => {
      const forChannel = listeners.get(channel) ?? [];
      forChannel.push(fn);
      listeners.set(channel, forChannel);
      return () => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((f) => f !== fn),
        );
      };
    },
  },
}));

/** Push a backend event the way the IPC bridge would. */
function emit(channel: string, payload: unknown): void {
  for (const fn of listeners.get(channel) ?? []) fn(payload);
}

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

/** Every library test ticked, on the given engines. */
function allSelected(browsers: RunBrowser[] = ["chromium"]): Record<string, BatchRowOptions> {
  const out: Record<string, BatchRowOptions> = {};
  for (const t of library) out[t.id] = { selected: true, browsers, headless: false };
  return out;
}

/** Whether each engine toggle on a row is on, by engine label. Reads
 *  aria-pressed rather than a class name: that's what a screen reader
 *  announces, and a class assertion would just pin today's styling. */
function enginesFor(testName: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const b of ["Chromium", "Firefox", "WebKit"]) {
    const btn = screen.queryByLabelText(`Run ${testName} on ${b}`);
    if (btn) out[b] = btn.getAttribute("aria-pressed") === "true";
  }
  return out;
}

/** The toolbar's Run button. Named precisely because the rows now carry
 *  "Run <name> on <engine>" toggles, and a loose /^Run/ matches all of them —
 *  which reports as "found multiple elements", not as the wrong button. */
function runButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Run (all|\d+)$/ });
}

/** The most recent settings write. No Array.prototype.at — this project
 *  targets ES2020. */
function lastRowWrite(): Partial<RecorderSettings> {
  const calls = setSettings.mock.calls;
  return calls[calls.length - 1][0];
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
  listeners.clear();
  library = [test_("a", "Alpha"), test_("b", "Beta"), test_("c", "Gamma")];
  settings = { batchOrder: [], defaultRunBrowser: "chromium" };
});

describe("BatchView per-row engines", () => {
  it("offers all three engines on every row", async () => {
    settings = { batchOrder: [], batchTestOptions: {} };
    renderView();
    await rowNames();
    expect(enginesFor("Alpha")).toEqual({ Chromium: true, Firefox: false, WebKit: false });
  });

  it("pre-selects the test's OWN engine over the global default", async () => {
    library = [{ ...test_("a", "Alpha"), runBrowser: "webkit" } as TestRecord, test_("b", "Beta")];
    settings = { batchOrder: [], defaultRunBrowser: "firefox", batchTestOptions: {} };
    renderView();
    await rowNames();
    expect(enginesFor("Alpha")).toEqual({ Chromium: false, Firefox: false, WebKit: true });
    expect(enginesFor("Beta")).toEqual({ Chromium: false, Firefox: true, WebKit: false });
  });

  it("adds an engine and persists the whole row", async () => {
    settings = { batchOrder: [], batchTestOptions: {} };
    renderView();
    await rowNames();

    fireEvent.click(screen.getByLabelText("Run Alpha on WebKit"));

    await waitFor(() => expect(enginesFor("Alpha").WebKit).toBe(true));
    const saved = lastRowWrite() as Partial<RecorderSettings>;
    expect(saved.batchTestOptions?.a.browsers).toEqual(["chromium", "webkit"]);
  });

  it("REFUSES to turn off a row's last engine", async () => {
    // A ticked test with no engine produces no queue entries: the batch
    // silently runs fewer tests than the toolbar promised.
    settings = { batchOrder: [], batchTestOptions: {} };
    renderView();
    await rowNames();

    fireEvent.click(screen.getByLabelText("Run Alpha on Chromium"));

    await waitFor(() => expect(screen.getByLabelText("Run Alpha on Chromium")).toBeTruthy());
    expect(enginesFor("Alpha").Chromium).toBe(true);
  });

  it("hydrates rows from stored options rather than the defaults", async () => {
    settings = {
      batchOrder: [],
      defaultRunBrowser: "chromium",
      batchTestOptions: {
        a: { selected: true, browsers: ["firefox", "webkit"], headless: true },
      },
    };
    renderView();
    await rowNames();
    expect(enginesFor("Alpha")).toEqual({ Chromium: false, Firefox: true, WebKit: true });
    expect(screen.getByLabelText("Run Alpha headless").getAttribute("aria-pressed")).toBe("true");
  });

  it("sends one perTest entry per test, carrying its engines", async () => {
    settings = {
      batchOrder: [],
      batchTestOptions: {
        a: { selected: true, browsers: ["chromium", "webkit"], headless: true },
        b: { selected: true, browsers: ["firefox"], headless: false },
        c: { selected: false, browsers: ["chromium"], headless: false },
      },
    };
    renderView();
    await rowNames();

    fireEvent.click(runButton());

    expect(batchRun.mock.calls[0][0]).toEqual(["a", "b"]);
    expect(batchRun.mock.calls[0][1]?.perTest).toEqual([
      { testId: "a", browsers: ["chromium", "webkit"], headless: true },
      { testId: "b", browsers: ["firefox"], headless: false },
    ]);
  });

  it("reports runs, not just tests, once a row has two engines", async () => {
    // A silent 3× is exactly the surprise worth naming in the toolbar.
    settings = {
      batchOrder: [],
      batchTestOptions: {
        a: { selected: true, browsers: ["chromium", "firefox", "webkit"], headless: false },
        b: { selected: true, browsers: ["chromium"], headless: false },
      },
    };
    renderView();
    await rowNames();
    expect(await screen.findByText(/2 of 3 selected · 4 runs/)).toBeTruthy();
  });

  it("shows two engines of one test as two distinct outcomes", async () => {
    // The bug this guards: keying results by testId alone collapses them to
    // whichever arrived last, so the row reports one engine's outcome as if it
    // were all of them.
    settings = {
      batchOrder: [],
      batchTestOptions: {
        a: { selected: true, browsers: ["chromium", "webkit"], headless: false },
      },
    };
    renderView();
    await rowNames();

    emit("batch:progress", {
      batchId: "b1",
      running: true,
      startedAt: 0,
      currentIndex: 1,
      stopped: false,
      results: [
        { testId: "a", testName: "Alpha", status: "passed", browser: "chromium" },
        { testId: "a", testName: "Alpha", status: "failed", browser: "webkit" },
      ],
    });

    // Worst-first: the failure is what needs attention, and a row showing
    // "passed" while one engine failed is the silent version of this bug.
    expect(await screen.findByText(/^Failed$/)).toBeTruthy();
  });
});

describe("BatchView per-row headless", () => {
  it("toggles one row without touching the others", async () => {
    settings = { batchOrder: [], batchTestOptions: {} };
    renderView();
    await rowNames();

    fireEvent.click(screen.getByLabelText("Run Alpha headless"));

    await waitFor(() =>
      expect(screen.getByLabelText("Run Alpha headless").getAttribute("aria-pressed")).toBe("true"),
    );
    expect(screen.getByLabelText("Run Beta headless").getAttribute("aria-pressed")).toBe("false");
  });

  it("master Headless overwrites every row in ONE write", async () => {
    settings = { batchOrder: [], batchTestOptions: {} };
    renderView();
    await rowNames();
    setSettings.mockClear();

    fireEvent.click(screen.getByLabelText(/run every test in this batch headless/i));

    await waitFor(() =>
      expect(screen.getByLabelText("Run Alpha headless").getAttribute("aria-pressed")).toBe("true"),
    );
    const rowWrites = setSettings.mock.calls.filter((c) => "batchTestOptions" in c[0]);
    expect(rowWrites).toHaveLength(1);
    const saved = rowWrites[0][0] as Partial<RecorderSettings>;
    // Materialised for every test, including ones the user never touched —
    // otherwise the master silently skips exactly those rows, which look
    // identical on screen to the ones it did apply to.
    expect(Object.keys(saved.batchTestOptions ?? {}).sort()).toEqual(["a", "b", "c"]);
    for (const row of Object.values(saved.batchTestOptions ?? {})) {
      expect(row.headless).toBe(true);
    }
  });

  it("writes NOTHING when the view merely mounts", async () => {
    // The silent-wipe regression: the init effect sets runHeadless from
    // defaultRunHeadless on every mount, so applying the master from an effect
    // instead of the event handler would erase every saved row choice on each
    // visit, with the UI looking correct throughout.
    settings = {
      batchOrder: [],
      defaultRunHeadless: true,
      batchTestOptions: {
        a: { selected: true, browsers: ["chromium"], headless: false },
      },
    };
    renderView();
    await rowNames();

    await waitFor(() =>
      expect(screen.getByLabelText("Run Alpha headless").getAttribute("aria-pressed")).toBe(
        "false",
      ),
    );
    expect(setSettings.mock.calls.filter((c) => "batchTestOptions" in c[0])).toHaveLength(0);
  });
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

  it("puts a test added since the order was saved at the TOP", async () => {
    // It used to be appended. On a library of any size that put a
    // just-recorded test off the bottom of the list, which reads as it not
    // having been created — the same complaint the selection fix addressed
    // from the other direction. The sidebar is newest-first; Batch disagreeing
    // with it was the confusing part.
    settings = { batchOrder: ["c", "b", "a"], defaultRunBrowser: "chromium" };
    library = [test_("d", "Delta"), ...library];
    renderView();
    expect(await rowNames()).toEqual(["Delta", "Gamma", "Beta", "Alpha"]);
  });

  it("leaves the curated order below the new test untouched", async () => {
    // The reason new tests were appended in the first place: adding one must
    // not reshuffle a suite someone arranged by hand.
    settings = { batchOrder: ["c", "b", "a"], defaultRunBrowser: "chromium" };
    library = [test_("d", "Delta"), ...library];
    renderView();
    expect((await rowNames()).slice(1)).toEqual(["Gamma", "Beta", "Alpha"]);
  });

  it("persists the new test's position rather than letting it drop next render", async () => {
    // The view rewrites a drifted order. Leading the list is only worth
    // anything if that placement is what gets written back — otherwise the test
    // leads once and drops on the next render, which is worse than consistently
    // trailing.
    settings = { batchOrder: ["c", "b", "a"], defaultRunBrowser: "chromium" };
    library = [test_("d", "Delta"), ...library];
    renderView();
    await rowNames();
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ batchOrder: ["d", "c", "b", "a"] }),
      ),
    );
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
  it("restores the stored selection", async () => {
    renderView();
    await rowNames();
    const boxes = screen.getAllByLabelText(/^Include /);
    expect(boxes).toHaveLength(3);
    for (const b of boxes) expect(b.getAttribute("data-state")).toBe("checked");
  });

  it("starts every test UNTICKED when nothing has been stored", async () => {
    // The reversal: a test used to be ticked the moment it existed, so "Run
    // all" swept up recordings the user had never opted into.
    settings = { batchOrder: [], batchTestOptions: {} };
    renderView();
    await rowNames();
    expect(checkedByName()).toEqual({ Alpha: false, Beta: false, Gamma: false });
  });

  it("persists a tick, so it survives the next session", async () => {
    settings = { batchOrder: [], batchTestOptions: {} };
    renderView();
    await rowNames();

    fireEvent.click(screen.getByLabelText("Include Beta in the batch"));

    await waitFor(() => expect(checkedByName().Beta).toBe(true));
    const saved = lastRowWrite() as Partial<RecorderSettings>;
    expect(saved.batchTestOptions?.b.selected).toBe(true);
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

    fireEvent.click(runButton());

    expect(batchRun).toHaveBeenCalledTimes(1);
    expect(batchRun.mock.calls[0][0]).toEqual(["c", "b", "a"]);
  });
});

// ── A test recorded after the view was opened ────────────────────────
// This block used to pin the OPPOSITE contract: a new test was ticked the
// moment it appeared, so "Run all" swept up recordings nobody had opted into.
// Now a new test arrives unticked and its row shows its own engine, ready to be
// ticked. What still has to hold is that everything else is left exactly as the
// user left it — a new arrival must not disturb an in-progress selection, and a
// plain refetch must not disturb anything at all.
describe("BatchView newly created tests", () => {
  it("leaves a test recorded while the view is open UNTICKED", async () => {
    const qc = renderView();
    expect(await rowNames()).toEqual(["Alpha", "Beta", "Gamma"]);

    library = [test_("d", "Delta"), ...library];
    await qc.invalidateQueries({ queryKey: ["tests"] });

    await waitFor(() => expect(screen.getAllByLabelText(/^Include /)).toHaveLength(4));
    expect(checkedByName()).toEqual({ Alpha: true, Beta: true, Gamma: true, Delta: false });
  });

  it("does NOT silently add the new test to the run", async () => {
    const qc = renderView();
    await rowNames();
    library = [test_("d", "Delta"), ...library];
    await qc.invalidateQueries({ queryKey: ["tests"] });
    await waitFor(() => expect(screen.getAllByLabelText(/^Include /)).toHaveLength(4));

    fireEvent.click(runButton());
    expect([...batchRun.mock.calls[0][0]].sort()).toEqual(["a", "b", "c"]);
    expect(batchRun.mock.calls[0][0]).not.toContain("d");
  });

  it("shows the new test's own default engine, ready to be ticked", async () => {
    const qc = renderView();
    await rowNames();
    library = [{ ...test_("d", "Delta"), runBrowser: "webkit" } as TestRecord, ...library];
    await qc.invalidateQueries({ queryKey: ["tests"] });

    await waitFor(() => expect(screen.getAllByLabelText(/^Include /)).toHaveLength(4));
    expect(enginesFor("Delta")).toEqual({ Chromium: false, Firefox: false, WebKit: true });
  });

  it("leaves a deliberately unticked test alone when a new one arrives", async () => {
    const qc = renderView();
    await rowNames();
    fireEvent.click(screen.getByLabelText("Include Beta in the batch"));
    await waitFor(() => expect(checkedByName().Beta).toBe(false));

    library = [test_("d", "Delta"), ...library];
    await qc.invalidateQueries({ queryKey: ["tests"] });

    await waitFor(() => expect(screen.getAllByLabelText(/^Include /)).toHaveLength(4));
    expect(checkedByName()).toEqual({ Alpha: true, Beta: false, Gamma: true, Delta: false });
  });

  it("does not re-tick anything when the library merely refetches unchanged", async () => {
    const qc = renderView();
    await rowNames();
    fireEvent.click(screen.getByLabelText("Include Beta in the batch"));
    await waitFor(() => expect(checkedByName().Beta).toBe(false));

    // A new array with the same ids — what every refetch produces.
    library = library.map((t) => ({ ...t }));
    await qc.invalidateQueries({ queryKey: ["tests"] });
    await waitFor(() => expect(checkedByName().Alpha).toBe(true));

    expect(checkedByName().Beta).toBe(false);
  });

  it("drops stored rows for a test that no longer exists", async () => {
    // Otherwise the map grows for the life of the app, and a re-imported test
    // would inherit a choice nobody remembers making.
    const qc = renderView();
    await rowNames();
    setSettings.mockClear();

    library = library.filter((t) => t.id !== "b");
    await qc.invalidateQueries({ queryKey: ["tests"] });

    await waitFor(() => expect(screen.getAllByLabelText(/^Include /)).toHaveLength(2));
    const rowWrites = setSettings.mock.calls.filter((c) => "batchTestOptions" in c[0]);
    const saved = rowWrites[rowWrites.length - 1][0] as Partial<RecorderSettings>;
    expect(Object.keys(saved.batchTestOptions ?? {}).sort()).toEqual(["a", "c"]);
  });
});

describe("BatchView run options", () => {
  it("lets a batch run headless AND capture screenshots", async () => {
    // These used to be mutually exclusive. Headless Chromium screenshots
    // exactly as well, and for a batch it's the more useful combination —
    // capturing a whole suite without a browser window stealing focus once per
    // test in it.
    renderView();
    await rowNames();

    fireEvent.click(screen.getByLabelText(/run every test in this batch headless/i));
    const capture = screen.getByLabelText(/capture screenshots/i);
    expect(capture.getAttribute("data-disabled") ?? capture.getAttribute("disabled")).toBeNull();
    fireEvent.click(capture);

    fireEvent.click(runButton());
    const opts = batchRun.mock.calls[0][1] as { runHeadless?: boolean; captureArtifacts?: boolean };
    expect(opts.runHeadless).toBe(true);
    expect(opts.captureArtifacts).toBe(true);
  });
});

describe("BatchView parallel runs", () => {
  // The picker itself cannot be driven here: the SDK's Select is
  // native-menu-backed, so its options never enter the DOM. Every test below
  // therefore SEEDS the choice through settings (which is also how a user's
  // saved default arrives) and asserts on the displayed value and on what
  // reaches api.batch.run — the two things that actually matter.
  const runOpts = () => batchRun.mock.calls[0]?.[1] as { concurrency?: number } | undefined;

  it("defaults to off, and runs one at a time", async () => {
    renderView();
    await rowNames();
    const trigger = screen.getByRole("combobox", { name: /how many tests to run at once/i });
    await waitFor(() => expect(trigger.textContent).toContain("Off"));

    fireEvent.click(runButton());
    await waitFor(() => expect(batchRun).toHaveBeenCalled());
    expect(runOpts()?.concurrency).toBe(1);
    expect(screen.getByText(/tests run one at a time/i)).toBeTruthy();
  });

  it("shows a saved default and sends it with the batch", async () => {
    settings = { batchOrder: [], defaultRunBrowser: "chromium", defaultBatchConcurrency: 2 };
    renderView();
    await rowNames();
    const trigger = screen.getByRole("combobox", { name: /how many tests to run at once/i });
    await waitFor(() => expect(trigger.textContent).toContain("2 at once"));

    fireEvent.click(runButton());
    await waitFor(() => expect(batchRun).toHaveBeenCalled());
    expect(runOpts()?.concurrency).toBe(2);
  });

  it("says how many run at a time once parallel is on", async () => {
    settings = { batchOrder: [], defaultRunBrowser: "chromium", defaultBatchConcurrency: 2 };
    renderView();
    await rowNames();
    await waitFor(() => expect(screen.getByText(/2 tests run at a time/i)).toBeTruthy());
    expect(screen.queryByText(/tests run one at a time/i)).toBeNull();
  });

  // "All at once" is capped by how many tests there ARE — with three in the
  // library it must ask for three, not the hard ceiling.
  it("never asks for more parallelism than there are tests", async () => {
    settings = { batchOrder: [], defaultRunBrowser: "chromium", defaultBatchConcurrency: 16 };
    renderView();
    await rowNames();
    const trigger = screen.getByRole("combobox", { name: /how many tests to run at once/i });
    await waitFor(() => expect(trigger.textContent).toContain("All at once"));

    fireEvent.click(runButton());
    await waitFor(() => expect(batchRun).toHaveBeenCalled());
    expect(runOpts()?.concurrency).toBe(3);
  });
});

describe("BatchView live progress", () => {
  /** A batch:progress payload with the given per-test statuses. */
  const progress = (statuses: string[]) => ({
    batchId: "b1",
    running: true,
    startedAt: 0,
    // Deliberately the value the BACKEND would send. Nothing in the view may
    // depend on it — with several tests in flight there is no "current" one.
    currentIndex: statuses.indexOf("running"),
    stopped: false,
    results: statuses.map((status, i) => ({
      testId: ["a", "b", "c"][i],
      testName: ["Alpha", "Beta", "Gamma"][i],
      status,
    })),
    summary: { total: 3, passed: 0, failed: 0, skipped: 0, ok: false, durationMs: 0 },
  });

  it("keeps the familiar wording while one test runs at a time", async () => {
    renderView();
    await rowNames();
    emit("batch:progress", progress(["passed", "running", "pending"]));
    await waitFor(() => expect(screen.getByText(/Running 2 of 3/)).toBeTruthy());
  });

  it("reports how many are in flight rather than an ordinal", async () => {
    // "Running 1 of 3" while three are running is simply false — and it was
    // what currentIndex + 1 produced.
    renderView();
    await rowNames();
    emit("batch:progress", progress(["running", "running", "running"]));
    await waitFor(() => expect(screen.getByText(/0 of 3 done · 3 running/)).toBeTruthy());
    expect(screen.queryByText(/Running 1 of 3/)).toBeNull();
  });

  it("counts finished tests, not the position of the first running one", async () => {
    // currentIndex here is 2, so an ordinal reading would say "Running 3 of 3"
    // with one still queued and two done.
    renderView();
    await rowNames();
    emit("batch:progress", progress(["passed", "failed", "running"]));
    await waitFor(() => expect(screen.getByText(/Running 3 of 3/)).toBeTruthy());

    emit("batch:progress", progress(["passed", "running", "running"]));
    await waitFor(() => expect(screen.getByText(/1 of 3 done · 2 running/)).toBeTruthy());
  });
});

describe("BatchView headed parallel warning", () => {
  /** A library big enough that "all at once" exceeds the 10-window threshold. */
  const bigLibrary = () =>
    Array.from({ length: 14 }, (_, i) => test_(`t${i}`, `Test ${i}`));

  beforeEach(() => {
    library = bigLibrary();
    settings = { batchOrder: [], defaultRunBrowser: "chromium", defaultBatchConcurrency: 16 };
  });

  it("asks before opening more than ten visible browsers, and starts nothing yet", async () => {
    renderView();
    await rowNames();

    fireEvent.click(runButton());

    const dialog = await screen.findByRole("alertdialog");
    // The count has to be the real one — 14 windows, not "16" (the cap) and not
    // the raw picker value.
    expect(within(dialog).getByText(/open 14 browser windows at once\?/i)).toBeTruthy();
    // Nothing may start while the question is on screen.
    expect(batchRun).not.toHaveBeenCalled();
  });

  it("runs it anyway when confirmed, at the number it warned about", async () => {
    renderView();
    await rowNames();
    fireEvent.click(runButton());

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /run anyway/i }));

    await waitFor(() => expect(batchRun).toHaveBeenCalled());
    const opts = batchRun.mock.calls[0][1] as { concurrency?: number; runHeadless?: boolean };
    expect(opts.concurrency).toBe(14);
    expect(opts.runHeadless).toBe(false);
  });

  it("starts nothing when the warning is dismissed", async () => {
    renderView();
    await rowNames();
    fireEvent.click(runButton());

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(batchRun).not.toHaveBeenCalled();
  });

  // The whole reason the threshold is on headedness: nothing appears on screen,
  // so there is nothing to warn about however wide the batch is.
  it("never asks for a headless batch, however wide", async () => {
    renderView();
    await rowNames();
    fireEvent.click(screen.getByLabelText(/run every test in this batch headless/i));

    fireEvent.click(runButton());

    await waitFor(() => expect(batchRun).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect((batchRun.mock.calls[0][1] as { concurrency?: number }).concurrency).toBe(14);
  });

  // A big selection run a few at a time is the safe case. Nagging about it
  // would train people to click straight through the dialog that matters.
  it("does not ask when a big library runs only a few at a time", async () => {
    settings = { batchOrder: [], defaultRunBrowser: "chromium", defaultBatchConcurrency: 4 };
    renderView();
    await rowNames();

    fireEvent.click(runButton());

    await waitFor(() => expect(batchRun).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect((batchRun.mock.calls[0][1] as { concurrency?: number }).concurrency).toBe(4);
  });

  it("does not ask for a headed batch that runs one at a time", async () => {
    settings = { batchOrder: [], defaultRunBrowser: "chromium", defaultBatchConcurrency: 1 };
    renderView();
    await rowNames();

    fireEvent.click(runButton());

    await waitFor(() => expect(batchRun).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
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
    expect(runButton()).toBeTruthy();
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
