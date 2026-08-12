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
  BatchRecord,
  BatchRowOptions,
  RecorderSettings,
  Routine,
  RoutineStep,
  RunBrowser,
  TestRecord,
} from "../lib/recorder-types";
// Safe above the vi.mock calls below: Vitest hoists vi.mock above imports, so
// the mocks are registered before this module is evaluated.
import {
  BATCH_CONCURRENCY_CHOICES,
  batchConcurrencyConsequence,
} from "../lib/batch-parallel";
import { toastTexts } from "../__tests__/sonner-stub";
import { BatchView } from "./batch-view";

// ── Mocks ────────────────────────────────────────────────────────────
const setSettings = vi.fn(async (_update: Partial<RecorderSettings>) => ({}) as RecorderSettings);
const getLog = vi.fn(async (_runId: string) => "expect(received).toBeVisible() — boom");
const batchRun = vi.fn(
  async (_testIds: string[], _opts?: Record<string, unknown>) => ({
    batchId: "b1",
    alreadyRunning: false,
  }),
);
// Routines. The view is ONE Routine's editor now, so the Routine — not
// `batchTestOptions` — is what decides which rows are ticked. `routineSave`
// echoes its input back the way the real store does (returning what was
// STORED, not what was sent), and mutates `routines` so a second render sees
// the write: a mock that accepted saves and forgot them would let every
// "persists across X" assertion pass vacuously.
const routineRun = vi.fn(async (_id: string) => ({
  batchId: "b1",
  alreadyRunning: false,
  skipped: [] as string[],
  plannedRuns: 1,
}));
const routineSave = vi.fn(async (r: Routine) => {
  const all = [...(routines ?? (routines = [everyTest()]))];
  const i = all.findIndex((x) => x.id === r.id);
  // `updatedAt` moves on every save, as the real store's does — the view keys
  // its re-seed on it, so a mock that left it alone would hide that.
  const stored = { ...r, updatedAt: r.updatedAt + 1 };
  if (i >= 0) all[i] = stored;
  else all.push(stored);
  routines = all;
  return stored;
});
const routineRemove = vi.fn(async (id: string) => {
  const all = routines ?? (routines = [everyTest()]);
  const before = all.length;
  routines = all.filter((r) => r.id !== id);
  return { removed: before - (routines?.length ?? 0) };
});

let library: TestRecord[] = [];
// `null` means "the default": one Routine holding the whole library, which is
// what a user who has used this view before has saved. Resolved INSIDE the mock
// like `library` is, so a test can reassign `library` first and still get a
// Routine built from it — building it in beforeEach would freeze the default
// library into every test that replaces it.
let routines: Routine[] | null = null;
let settings: Partial<RecorderSettings> = {};
// Stored batch history, same idiom as `library`: resolved inside the mock so a
// test can reassign it before the view mounts.
let history: BatchRecord[] = [];
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
    runs: { getLog: (id: string) => getLog(id) },
    routines: {
      // A FRESH ARRAY EVERY CALL, like the real store — it re-reads the file.
      // Handing back the same array that `save` mutated in place makes the
      // cached data referentially equal to the new data, so React never
      // re-renders and every "the edit survives" assertion fails for a reason
      // that has nothing to do with the view.
      list: async () => [...(routines ?? (routines = [everyTest()]))],
      get: async (id: string) => (routines ?? []).find((r) => r.id === id) ?? null,
      save: (r: Routine) => routineSave(r),
      remove: (id: string) => routineRemove(id),
      run: (id: string) => routineRun(id),
    },
    batch: {
      list: async () => history,
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

/** One Routine containing the whole library — the state a user who has used
 *  this view before has saved, and what `allSelected()` used to stand for
 *  before the Routine became the authority on selection. */
function routineOf(
  steps: RoutineStep[],
  over: Partial<Routine> = {},
): Routine {
  return {
    id: "r-1",
    name: "Batch",
    createdAt: 1,
    updatedAt: 1,
    steps,
    defaults: { captureArtifacts: false, concurrency: 1 },
    ...over,
  };
}

/** A Routine expressed the way `batchTestOptions` used to be: which tests are
 *  in the job, on what engines, headed or not. Lets each test below state the
 *  intent it always stated, against the store that now decides it. */
function routineRows(
  rows: Record<string, { browsers?: RunBrowser[]; headless?: boolean }>,
): Routine {
  return routineOf(
    Object.entries(rows).map(([testId, r]) => ({
      kind: "test" as const,
      testId,
      browsers: r.browsers ?? (["chromium"] as RunBrowser[]),
      headless: r.headless ?? false,
      onFailure: "continue" as const,
    })),
  );
}

function everyTest(browsers: RunBrowser[] = ["chromium"], headless = false): Routine {
  return routineOf(
    library.map((t) => ({
      kind: "test" as const,
      testId: t.id,
      browsers,
      headless,
      onFailure: "continue" as const,
    })),
  );
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
  routines = null;
  history = [];
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
    // A row that is not in the routine — which is what "untouched" means now.
    routines = [routineOf([])];
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

  it("hydrates rows from the open routine rather than the defaults", async () => {
    settings = { batchOrder: [], defaultRunBrowser: "chromium" };
    routines = [routineRows({ a: { browsers: ["firefox", "webkit"], headless: true } })];
    renderView();
    await rowNames();
    expect(enginesFor("Alpha")).toEqual({ Chromium: false, Firefox: true, WebKit: true });
    expect(screen.getByLabelText("Run Alpha headless").getAttribute("aria-pressed")).toBe("true");
  });

  it("runs the SAVED routine, whose steps carry each test's engines", async () => {
    // The per-test payload is built backend-side from the record now (see
    // shared/routine-plan.mjs), so what this view is responsible for is that
    // the record says the right thing and that Run names it. Asserting a
    // payload the renderer no longer builds would pin fiction.
    settings = { batchOrder: [] };
    routines = [
      routineRows({
        a: { browsers: ["chromium", "webkit"], headless: true },
        b: { browsers: ["firefox"] },
      }),
    ];
    renderView();
    await rowNames();

    fireEvent.click(runButton());

    expect(routineRun.mock.calls[0][0]).toBe("r-1");
    expect(routines[0].steps).toEqual([
      { kind: "test", testId: "a", browsers: ["chromium", "webkit"], headless: true, onFailure: "continue" },
      { kind: "test", testId: "b", browsers: ["firefox"], headless: false, onFailure: "continue" },
    ]);
  });

  it("reports runs, not just tests, once a row has two engines", async () => {
    // A silent 3× is exactly the surprise worth naming in the toolbar.
    settings = { batchOrder: [] };
    routines = [
      routineRows({
        a: { browsers: ["chromium", "firefox", "webkit"] },
        b: { browsers: ["chromium"] },
      }),
    ];
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

  it("shows the open routine's steps in the routine's order", async () => {
    // The order lives on the JOB now. `batchOrder` still arranges the rows the
    // routine does not contain — see the next test.
    settings = { batchOrder: [], defaultRunBrowser: "chromium" };
    routines = [routineRows({ c: {}, a: {}, b: {} })];
    renderView();
    expect(await rowNames()).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  it("arranges the rows the routine does NOT contain by the stored order", async () => {
    settings = { batchOrder: ["c", "a"], defaultRunBrowser: "chromium" };
    routines = [routineRows({ b: {} })];
    renderView();
    expect(await rowNames()).toEqual(["Beta", "Gamma", "Alpha"]);
  });

  it("puts a test added since the order was saved at the TOP of the rest", async () => {
    // It used to be appended. On a library of any size that put a
    // just-recorded test off the bottom of the list, which reads as it not
    // having been created — the same complaint the selection fix addressed
    // from the other direction. The sidebar is newest-first; Batch disagreeing
    // with it was the confusing part. It leads the rows the routine does not
    // contain, not the whole list: the job itself comes first now.
    settings = { batchOrder: ["c", "b", "a"], defaultRunBrowser: "chromium" };
    library = [test_("d", "Delta"), ...library];
    routines = [routineOf([])];
    renderView();
    expect(await rowNames()).toEqual(["Delta", "Gamma", "Beta", "Alpha"]);
  });

  it("leaves the curated order below the new test untouched", async () => {
    // The reason new tests were appended in the first place: adding one must
    // not reshuffle a suite someone arranged by hand.
    settings = { batchOrder: ["c", "b", "a"], defaultRunBrowser: "chromium" };
    library = [test_("d", "Delta"), ...library];
    routines = [routineOf([])];
    renderView();
    expect((await rowNames()).slice(1)).toEqual(["Gamma", "Beta", "Alpha"]);
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
    routines = [routineOf([])];
    renderView();
    await rowNames();
    expect(checkedByName()).toEqual({ Alpha: false, Beta: false, Gamma: false });
  });

  it("persists a tick to the ROUTINE, so it survives the next session", async () => {
    // The tick puts a test INTO the job, so the job is what has to record it.
    settings = { batchOrder: [], batchTestOptions: {} };
    routines = [routineOf([])];
    renderView();
    await rowNames();

    fireEvent.click(screen.getByLabelText("Include Beta in the batch"));

    await waitFor(() => expect(checkedByName().Beta).toBe(true));
    await waitFor(() => expect(routines?.[0].steps.map((st) => st.testId)).toEqual(["b"]));
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

  it("stores the steps in the order shown, not library order", async () => {
    // The bug this guards: reordering rows visually while running the old
    // order. What runs is the stored routine, so the assertion is on what got
    // stored — the translation from steps to a queue is covered in
    // routine-plan.test.ts.
    settings = { batchOrder: [], defaultRunBrowser: "chromium" };
    routines = [routineRows({ c: {}, b: {}, a: {} })];
    renderView();
    expect(await rowNames()).toEqual(["Gamma", "Beta", "Alpha"]);

    fireEvent.click(runButton());

    expect(routineRun).toHaveBeenCalledTimes(1);
    expect(routines?.[0].steps.map((st) => st.testId)).toEqual(["c", "b", "a"]);
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

  it("does NOT silently add the new test to the job", async () => {
    const qc = renderView();
    await rowNames();
    library = [test_("d", "Delta"), ...library];
    await qc.invalidateQueries({ queryKey: ["tests"] });
    await waitFor(() => expect(screen.getAllByLabelText(/^Include /)).toHaveLength(4));

    fireEvent.click(runButton());
    expect(routineRun).toHaveBeenCalledTimes(1);
    expect([...(routines ?? [])[0].steps.map((st) => st.testId)].sort()).toEqual(["a", "b", "c"]);
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
    await waitFor(() =>
      expect(checkedByName()).toEqual({ Alpha: true, Beta: false, Gamma: true, Delta: false }),
    );
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

  it("drops the scratch row for a test that no longer exists, on the next write", async () => {
    // Otherwise the map grows for the life of the app, and a re-imported test
    // would inherit a choice nobody remembers making. Pruned ON WRITE now
    // rather than by an effect watching for drift: stateless, so it cannot
    // loop, which is why this ticks something rather than only refetching.
    const qc = renderView();
    await rowNames();
    setSettings.mockClear();

    library = library.filter((t) => t.id !== "b");
    await qc.invalidateQueries({ queryKey: ["tests"] });
    await waitFor(() => expect(screen.getAllByLabelText(/^Include /)).toHaveLength(2));

    fireEvent.click(screen.getByLabelText("Include Alpha in the batch"));

    await waitFor(() => {
      const rowWrites = setSettings.mock.calls.filter((c) => "batchTestOptions" in c[0]);
      expect(rowWrites.length).toBeGreaterThan(0);
      const saved = rowWrites[rowWrites.length - 1][0] as Partial<RecorderSettings>;
      expect(Object.keys(saved.batchTestOptions ?? {}).sort()).toEqual(["a", "c"]);
    });
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
    // Both are the ROUTINE's now: headedness per step, capture on its defaults.
    // Waited for rather than read straight away — these are two independent
    // writes, and the point of the assertion is that the second does not undo
    // the first, which only means anything once both have landed.
    await waitFor(() => expect(routineRun).toHaveBeenCalled());
    await waitFor(() => {
      expect(routines?.[0].defaults.captureArtifacts).toBe(true);
      expect(routines?.[0].steps.every((st) => st.headless)).toBe(true);
    });
  });
});

describe("BatchView parallel runs", () => {
  // The picker itself cannot be driven here: the SDK's Select is
  // native-menu-backed, so its options never enter the DOM. Every test below
  // therefore SEEDS the choice through settings (which is also how a user's
  // saved default arrives) and asserts on the displayed value and on what
  // reaches api.batch.run — the two things that actually matter.
  /** The routine's stored lane count — where the choice lives now. */
  const savedLanes = () => routines?.[0].defaults.concurrency;

  it("defaults to off, and runs one at a time", async () => {
    renderView();
    await rowNames();
    const trigger = screen.getByRole("button", { name: /how many tests to run at once/i });
    await waitFor(() => expect(trigger.textContent).toContain("Off"));

    fireEvent.click(runButton());
    await waitFor(() => expect(routineRun).toHaveBeenCalled());
    expect(savedLanes()).toBe(1);
    expect(screen.getByText(/tests run one at a time/i)).toBeTruthy();
  });

  it("shows the ROUTINE's saved lane count", async () => {
    // Not the global default: a saved job that forgot how many lanes it runs in
    // is a saved job in name only.
    routines = [{ ...everyTest(), defaults: { captureArtifacts: false, concurrency: 2 } }];
    renderView();
    await rowNames();
    const trigger = screen.getByRole("button", { name: /how many tests to run at once/i });
    await waitFor(() => expect(trigger.textContent).toContain("2 at once"));

    fireEvent.click(runButton());
    await waitFor(() => expect(routineRun).toHaveBeenCalled());
    expect(savedLanes()).toBe(2);
  });

  it("falls back to the global default for a user with no routine yet", async () => {
    settings = { batchOrder: [], defaultRunBrowser: "chromium", defaultBatchConcurrency: 2 };
    routines = [];
    renderView();
    const trigger = await screen.findByRole("button", {
      name: /how many tests to run at once/i,
    });
    await waitFor(() => expect(trigger.textContent).toContain("2 at once"));
  });

  it("says how many run at a time once parallel is on", async () => {
    routines = [{ ...everyTest(), defaults: { captureArtifacts: false, concurrency: 2 } }];
    renderView();
    await rowNames();
    await waitFor(() => expect(screen.getByText(/2 tests run at a time/i)).toBeTruthy());
    expect(screen.queryByText(/tests run one at a time/i)).toBeNull();
  });

  // "All at once" is capped by how many tests there ARE — with three in the
  // library the note must promise three, not the hard ceiling.
  it("never promises more parallelism than there are tests", async () => {
    routines = [{ ...everyTest(), defaults: { captureArtifacts: false, concurrency: 16 } }];
    renderView();
    await rowNames();
    const trigger = screen.getByRole("button", { name: /how many tests to run at once/i });
    await waitFor(() => expect(trigger.textContent).toContain("All at once"));
    expect(await screen.findByText(/3 tests run at a time/i)).toBeTruthy();
  });
});

describe("BatchView concurrency menu", () => {
  // THIS IS THE COVERAGE §8.2 PROMISED. The picker was the SDK's `Select`,
  // which is backed by a real macOS menu — its options never enter the DOM, so
  // for its whole life the only thing testable here was the displayed value and
  // what reached IPC. The redesign draws its own menu, because a native menu
  // item is a string and the whole point is the SECOND line. So for the first
  // time the choice can be made the way a user makes it.
  it("opens, lists every choice, and applies the one that is picked", async () => {
    renderView();
    await rowNames();
    const trigger = screen.getByRole("button", { name: /how many tests to run at once/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent ?? "");
    expect(items).toHaveLength(BATCH_CONCURRENCY_CHOICES.length);

    fireEvent.click(screen.getByRole("menuitem", { name: /4 at once/ }));
    // Closes on choosing — a menu that stays open reads as though the choice
    // did not take.
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /how many tests to run at once/i }).textContent,
      ).toContain("4 at once"),
    );
  });

  it("states the cost of every choice, in the menu, while choosing", async () => {
    // The reason this menu exists at all. "8" cannot say that a laptop will
    // thrash and report failures it caused — a failure that looks exactly like
    // a flaky suite from the run report. The copy is not a tooltip and not a
    // disclosure: it renders unconditionally.
    renderView();
    await rowNames();
    fireEvent.click(screen.getByRole("button", { name: /how many tests to run at once/i }));
    for (const choice of BATCH_CONCURRENCY_CHOICES) {
      expect(screen.getByText(batchConcurrencyConsequence(choice)), String(choice)).toBeTruthy();
    }
  });

  it("closes on Escape without applying anything", async () => {
    renderView();
    await rowNames();
    const trigger = screen.getByRole("button", { name: /how many tests to run at once/i });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
    expect(trigger.textContent).toContain("Off");
  });

  it("closes on a pointer-down elsewhere", async () => {
    // `pointerdown`, not `click`: a click fires after the pointer comes back up,
    // so a menu that closes on click is still covering the thing being pressed.
    renderView();
    await rowNames();
    fireEvent.click(screen.getByRole("button", { name: /how many tests to run at once/i }));
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
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

describe("BatchView finished-batch verdict", () => {
  // A batch that finished with SOME passes and SOME failures is a different
  // situation from one where nothing passed, and both used to be red. The tone
  // is the whole signal here — the words "2 failed" are identical in both — so
  // these read `data-tone`, which is what the chip derives its colour from.
  // Asserting the colour itself would prove nothing: the dom project runs with
  // `css: false`, so there is no cascade to ask.

  /** A batch:done payload with the given counts. */
  const done = (passed: number, failed: number, stopped = false) => ({
    batchId: "b1",
    running: false,
    startedAt: 0,
    currentIndex: -1,
    stopped,
    results: [],
    summary: {
      total: passed + failed,
      passed,
      failed,
      skipped: 0,
      ok: failed === 0,
      durationMs: 1000,
    },
  });

  /** The verdict chip in the finished-batch panel, found via the panel's own
   *  heading so the history chips below cannot answer for it. */
  function verdictChip(title: string): HTMLElement {
    const panel = screen.getByText(title).closest("section");
    if (!panel) throw new Error(`no panel around "${title}"`);
    const chip = panel.querySelector('[data-gl="status-chip"]');
    if (!chip) throw new Error(`no status chip in the "${title}" panel`);
    return chip as HTMLElement;
  }

  it("goes AMBER when two of three failed and one passed", async () => {
    renderView();
    await rowNames();
    emit("batch:done", done(1, 2));

    const chip = await waitFor(() => verdictChip("Batch finished with failures"));
    expect(chip.getAttribute("data-tone")).toBe("amber");
    expect(chip.textContent).toBe("2 failed");
  });

  it("stays RED when nothing passed at all", async () => {
    // The distinction the amber exists for: three failures and no passes is a
    // suite that isn't running, not a suite with a bug in it.
    renderView();
    await rowNames();
    emit("batch:done", done(0, 3));

    const chip = await waitFor(() => verdictChip("Batch failed"));
    expect(chip.getAttribute("data-tone")).toBe("red");
  });

  it("stays PHOSPHOR when everything passed", async () => {
    renderView();
    await rowNames();
    emit("batch:done", done(3, 0));

    const chip = await waitFor(() => verdictChip("Batch passed"));
    expect(chip.getAttribute("data-tone")).toBe("phos");
    expect(chip.textContent).toBe("3 passed");
  });

  it("claims no verdict for a batch the user stopped mid-flight", async () => {
    // Two had already failed when Stop was pressed. Tinting that amber would
    // report a mixed RESULT for a run that never finished.
    renderView();
    await rowNames();
    emit("batch:done", done(1, 2, true));

    const chip = await waitFor(() => verdictChip("Batch stopped"));
    expect(chip.getAttribute("data-tone")).toBe("neutral");
    expect(chip.textContent).toBe("Stopped");
  });
});

describe("BatchView history verdicts", () => {
  const record = (batchId: string, passed: number, failed: number): BatchRecord =>
    ({
      batchId,
      startedAt: 0,
      stopped: false,
      results: [],
      summary: {
        total: passed + failed,
        passed,
        failed,
        skipped: 0,
        ok: failed === 0,
        durationMs: 1000,
      },
    }) as unknown as BatchRecord;

  it("tells a partly-failing past batch apart from a totally-failing one", async () => {
    // Scanning history is where this matters most: the two rows say "1 failed"
    // and "3 failed", and without the tone the difference between "one flaky
    // test" and "the suite never started" is a number you have to do maths on.
    history = [record("mixed", 2, 1), record("total", 0, 3)];
    renderView();
    await rowNames();

    const rows = await screen.findAllByRole("button", { expanded: false });
    const chips = rows
      .map((r) => r.querySelector('[data-gl="status-chip"]'))
      .filter((c): c is Element => c !== null);

    const tones = chips.map((c) => c.getAttribute("data-tone"));
    expect(tones).toContain("amber");
    expect(tones).toContain("red");
  });
});

describe("BatchView log drill-through", () => {
  // BatchTestResult.runRecordId was persisted from the day batches got history,
  // but nothing in the renderer ever read it — the row said "Failed" and the
  // only route to the why was a detour through Stats. The badge is now the
  // shortcut, and these pin both the door and the frame it must NOT appear in.

  it("opens the run's console output from a finished row's badge", async () => {
    renderView();
    await rowNames();

    emit("batch:progress", {
      batchId: "b1",
      running: false,
      startedAt: 0,
      currentIndex: 3,
      stopped: false,
      results: [
        {
          testId: "a",
          testName: "Alpha",
          status: "failed",
          browser: "chromium",
          runRecordId: "r-77",
          durationMs: 120,
        },
      ],
    });

    fireEvent.click(await screen.findByLabelText("Open console output for Alpha"));

    // The dialog is the Stats LogInspector, fed by THIS run's id — the wrong id
    // here would show a plausible but unrelated log, silently.
    await waitFor(() => expect(getLog).toHaveBeenCalledWith("r-77"));
    expect(await screen.findByText(/Raw console output for this run/i)).toBeTruthy();
    expect(await screen.findByText(/boom/)).toBeTruthy();
  });

  it("keeps the badge inert while running or when no run record exists", async () => {
    renderView();
    await rowNames();

    emit("batch:progress", {
      batchId: "b1",
      running: true,
      startedAt: 0,
      currentIndex: 1,
      stopped: false,
      results: [
        // Still running: there is no settled log to open yet.
        { testId: "a", testName: "Alpha", status: "running", browser: "chromium" },
        // Finished but recorded before runRecordId existed (or the record
        // write failed): the badge must not be a dead button.
        { testId: "b", testName: "Beta", status: "failed", browser: "chromium" },
      ],
    });

    expect(await screen.findByText(/^Running$/)).toBeTruthy();
    expect(await screen.findByText(/^Failed$/)).toBeTruthy();
    expect(screen.queryByLabelText(/Open console output/)).toBeNull();
  });
});

describe("BatchView headed parallel warning", () => {
  /** A library big enough that "all at once" exceeds the 10-window threshold. */
  const bigLibrary = () =>
    Array.from({ length: 14 }, (_, i) => test_(`t${i}`, `Test ${i}`));

  beforeEach(() => {
    library = bigLibrary();
    settings = { batchOrder: [], defaultRunBrowser: "chromium" };
    // The lane count is the ROUTINE's now, so seeding the global default would
    // be overridden by the open job and every assertion below would be about a
    // one-at-a-time run.
    routines = [{ ...everyTest(), defaults: { captureArtifacts: false, concurrency: 16 } }];
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
    expect(routineRun).not.toHaveBeenCalled();
  });

  it("runs it anyway when confirmed, at the number it warned about", async () => {
    renderView();
    await rowNames();
    fireEvent.click(runButton());

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /run anyway/i }));

    await waitFor(() => expect(routineRun).toHaveBeenCalled());
    // The lane count reaching the runner is clamped backend-side against the
    // distinct tests (see shared/routine-plan.mjs); what this view owns is the
    // number it WARNED about, which is the one on the dialog above.
    expect(routineRun.mock.calls[0][0]).toBe("r-1");
  });

  it("starts nothing when the warning is dismissed", async () => {
    renderView();
    await rowNames();
    fireEvent.click(runButton());

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(routineRun).not.toHaveBeenCalled();
  });

  // The whole reason the threshold is on headedness: nothing appears on screen,
  // so there is nothing to warn about however wide the batch is.
  it("never asks for a headless batch, however wide", async () => {
    renderView();
    await rowNames();
    fireEvent.click(screen.getByLabelText(/run every test in this batch headless/i));

    fireEvent.click(runButton());

    await waitFor(() => expect(routineRun).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  // A big selection run a few at a time is the safe case. Nagging about it
  // would train people to click straight through the dialog that matters.
  it("does not ask when a big library runs only a few at a time", async () => {
    routines = [{ ...everyTest(), defaults: { captureArtifacts: false, concurrency: 4 } }];
    renderView();
    await rowNames();

    fireEvent.click(runButton());

    await waitFor(() => expect(routineRun).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByText(/4 tests run at a time/i)).toBeTruthy();
  });

  it("does not ask for a headed batch that runs one at a time", async () => {
    routines = [{ ...everyTest(), defaults: { captureArtifacts: false, concurrency: 1 } }];
    renderView();
    await rowNames();

    fireEvent.click(runButton());

    await waitFor(() => expect(routineRun).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("BatchView reset order", () => {
  it("offers Reset order only once a custom order is in effect", async () => {
    renderView();
    await rowNames();
    expect(screen.queryByRole("button", { name: "Reset order" })).toBeNull();
  });

  it("shows Reset order for a custom order and puts the JOB back in library order", async () => {
    // Clearing the scratch order alone would leave the button visible and
    // inert: the routine's steps lead the list, so its own order is what has to
    // change. A control that does nothing is worse than no control.
    settings = { batchOrder: [], defaultRunBrowser: "chromium" };
    routines = [routineRows({ c: {}, a: {}, b: {} })];
    renderView();
    expect(await rowNames()).toEqual(["Gamma", "Alpha", "Beta"]);

    fireEvent.click(await screen.findByRole("button", { name: "Reset order" }));

    await waitFor(() => expect(routines?.[0].steps.map((st) => st.testId)).toEqual(["a", "b", "c"]));
    expect(await rowNames()).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});

// ── The Routine editor ───────────────────────────────────────────────
// REDESIGN §7.1 / docs/ROUTINES.md. This screen is one Routine's editor now,
// and everything below is a way the translation could quietly describe a
// different job from the one on screen.
describe("BatchView as a Routine editor", () => {
  it("opens the first saved routine and names it", async () => {
    routines = [
      routineOf([], { id: "r-a", name: "Smoke", createdAt: 1 }),
      routineOf([], { id: "r-b", name: "Nightly", createdAt: 2 }),
    ];
    renderView();
    const picker = await screen.findByRole("button", { name: /which routine to edit/i });
    await waitFor(() => expect(picker.textContent).toContain("Smoke"));
    expect((await screen.findByLabelText("Routine name")).getAttribute("value")).toBe("Smoke");
  });

  it("switches the checklist when another routine is opened", async () => {
    routines = [
      routineOf([{ kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" }], { id: "r-a", name: "Smoke", createdAt: 1 }),
      routineOf([{ kind: "test", testId: "c", browsers: ["webkit"], headless: true, onFailure: "continue" }], { id: "r-b", name: "Nightly", createdAt: 2 }),
    ];
    renderView();
    await rowNames();
    await waitFor(() => expect(checkedByName()).toEqual({ Alpha: true, Beta: false, Gamma: false }));

    fireEvent.click(screen.getByRole("button", { name: /which routine to edit/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Nightly/ }));

    // The whole point of the feature: two configurations of the same library
    // that could not previously coexist.
    await waitFor(() => expect(checkedByName()).toEqual({ Alpha: false, Beta: false, Gamma: true }));
    expect(enginesFor("Gamma")).toEqual({ Chromium: false, Firefox: false, WebKit: true });
  });

  it("renames on Enter and abandons the edit on Escape", async () => {
    routines = [routineOf([], { id: "r-a", name: "Smoke" })];
    renderView();
    const field = await screen.findByLabelText("Routine name");

    fireEvent.change(field, { target: { value: "Smoke suite" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(routines?.[0].name).toBe("Smoke suite"));

    fireEvent.change(field, { target: { value: "half-typed" } });
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() =>
      expect((screen.getByLabelText("Routine name") as HTMLInputElement).value).toBe("Smoke suite"),
    );
    expect(routines?.[0].name).toBe("Smoke suite");
  });

  it("refuses to save an empty name, and puts the old one back", async () => {
    // An empty name is not a rename, it is a half-finished one — and a job with
    // no name is a row in the picker that cannot be pointed at.
    routines = [routineOf([], { id: "r-a", name: "Smoke" })];
    renderView();
    const field = await screen.findByLabelText("Routine name");

    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.blur(field);

    await waitFor(() =>
      expect((screen.getByLabelText("Routine name") as HTMLInputElement).value).toBe("Smoke"),
    );
    expect(routineSave).not.toHaveBeenCalled();
  });

  it("does not write the routine merely because the view mounted", async () => {
    // Opening a job must not re-date it: `updatedAt` is what the picker sorts
    // by and what a schedule will one day compare against.
    routines = [everyTest()];
    renderView();
    await rowNames();
    await waitFor(() => expect(screen.getAllByLabelText(/^Include /)).toHaveLength(3));
    expect(routineSave).not.toHaveBeenCalled();
  });

  it("creates a new routine EMPTY and opens it", async () => {
    // Pre-filling would make the first thing a new job does be something the
    // user has to undo.
    routines = [routineOf([], { id: "r-a", name: "Smoke" })];
    renderView();
    await rowNames();

    fireEvent.click(screen.getByRole("button", { name: /which routine to edit/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New routine…/ }));

    await waitFor(() => expect(routines).toHaveLength(2));
    expect(routines?.[1].steps).toEqual([]);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /which routine to edit/i }).textContent,
      ).toContain("New routine"),
    );
    expect(checkedByName()).toEqual({ Alpha: false, Beta: false, Gamma: false });
  });

  it("deletes a routine only after confirming, and falls back to another", async () => {
    routines = [
      routineOf([], { id: "r-a", name: "Smoke", createdAt: 1 }),
      routineOf([], { id: "r-b", name: "Nightly", createdAt: 2 }),
    ];
    renderView();
    await rowNames();

    fireEvent.click(screen.getByRole("button", { name: /which routine to edit/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete "Smoke"/ }));

    const dialog = await screen.findByRole("alertdialog");
    // The tests are right there under the dialog with tick boxes beside them —
    // it has to say they are not going anywhere.
    expect(within(dialog).getByText(/tests in it are untouched/i)).toBeTruthy();
    expect(routineRemove).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /delete routine/i }));

    await waitFor(() => expect(routines?.map((r) => r.id)).toEqual(["r-b"]));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /which routine to edit/i }).textContent,
      ).toContain("Nightly"),
    );
  });

  it("reports steps whose tests are gone, and removes them on request", async () => {
    // The store keeps them so a saved job never silently shrinks; the checklist
    // cannot draw a row for a test that does not exist, so without this the job
    // is one step longer than the screen and nothing says so.
    routines = [
      routineOf([
        { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
        { kind: "test", testId: "gone", browsers: ["chromium"], headless: false, onFailure: "continue", testDeleted: true },
      ]),
    ];
    renderView();
    await rowNames();

    expect(await screen.findByText(/one step names a test that no longer exists/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Remove it$/ }));

    await waitFor(() => expect(routines?.[0].steps.map((st) => st.testId)).toEqual(["a"]));
    await waitFor(() =>
      expect(screen.queryByText(/names a test that no longer exists/i)).toBeNull(),
    );
  });

  it("says what to do when there are no routines at all", async () => {
    // The state the migration leaves anyone who never ticked a row. An empty
    // screen with no way forward would read as the feature being broken.
    routines = [];
    renderView();
    expect(await screen.findByText(/no routines yet/i)).toBeTruthy();
  });

  it("tells you when a run skipped steps rather than saying nothing", async () => {
    // A note, not a failure — but silence is what would make the feature
    // untrustworthy.
    routineRun.mockResolvedValueOnce({
      batchId: "b1",
      alreadyRunning: false,
      skipped: ["gone", "also-gone"],
      plannedRuns: 1,
    });
    renderView();
    await rowNames();

    fireEvent.click(runButton());

    await waitFor(() =>
      expect(toastTexts().map((t) => t.title).join(" ")).toContain("2 steps skipped"),
    );
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
