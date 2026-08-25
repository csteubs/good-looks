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

import { MAX_ROUTINE_MESSAGE } from "../lib/recorder-types";
import type {
  BatchRecord,
  BatchRowOptions,
  RecorderSettings,
  Routine,
  RoutineBranchStep,
  RoutineStep,
  RoutineTestStep,
  RunBrowser,
  TestRecord,
} from "../lib/recorder-types";
// Safe above the vi.mock calls below: Vitest hoists vi.mock above imports, so
// the mocks are registered before this module is evaluated.
import {
  BATCH_CONCURRENCY_CHOICES,
  batchConcurrencyConsequence,
} from "../lib/batch-parallel";
import { ORPHAN_BATCH_OWNER } from "../../shared/routine-migration.mjs";
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

// The open Routine lives in the recorder store, because the RAIL selects it and
// this view edits it. Stubbed with ordinary component state rather than mounting
// the real provider: that provider opens IPC subscriptions and owns the whole
// recording session, none of which this file is about, and the stub reproduces
// exactly what the view used to hold locally.
vi.mock("./recorder-store", async () => {
  const react = await import("react");
  return {
    useRecorder: () => {
      const [openRoutineId, setOpenRoutineId] = react.useState<string | null>(null);
      return { openRoutineId, setOpenRoutineId };
    },
  };
});

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

/** A stored batch, belonging to nothing in particular. */
function batchRecord(batchId: string): BatchRecord {
  return {
    batchId,
    startedAt: Date.parse("2026-08-07T10:00:00Z"),
    finishedAt: Date.parse("2026-08-07T10:03:00Z"),
    currentIndex: -1,
    running: false,
    stopped: false,
    results: [],
    summary: { total: 3, passed: 3, failed: 0, skipped: 0, ok: true, durationMs: 1000 },
  } as unknown as BatchRecord;
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


/** A Routine's steps, narrowed to test steps. Every test below builds a
 *  test-only Routine, so a `group` turning up here is a real defect — this
 *  throws where a `filter` would quietly drop it. */
function testSteps(steps: readonly RoutineStep[]): RoutineTestStep[] {
  return steps.map((s) => {
    if (s.kind !== "test") throw new Error(`expected a test step, got ${s.kind}`);
    return s;
  });
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
      // Started FROM this screen, so it carries the open routine — the view
      // scopes both the live batch and the history to the job on screen.
      routineId: "r-1",
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

describe("BatchView per-row failure policy", () => {
  const policyBtn = (name: string) => screen.queryByLabelText(`What happens if ${name} fails`);

  it("offers the control only on a row that is IN the job", async () => {
    // An unticked row is not a step, and a policy about a step that does not
    // exist has nothing to say. It is also what keeps the row from gaining a
    // ninth cell on the forty rows that are only listed so they can be added.
    routines = [routineRows({ a: {} })];
    renderView();
    await rowNames();

    await waitFor(() => expect(policyBtn("Alpha")).toBeTruthy());
    expect(policyBtn("Beta")).toBeNull();
    // …but the COLUMN stays. Omitting the cell entirely slid every cell after
    // it left by the control's width, so engines and headless jumped between
    // ticked and unticked rows and the checklist stopped reading as a table.
    // jsdom cannot see that; what it can see is that the placeholder is there.
    expect(document.querySelectorAll(".gl-batch-policy-gap")).toHaveLength(2);
  });

  it("defaults to carrying on, and says so", async () => {
    // ROUTINES.md requires this default: anything else would change what every
    // migrated checklist does the first time it runs.
    routines = [routineRows({ a: {} })];
    renderView();
    await rowNames();

    await waitFor(() => expect(policyBtn("Alpha")).toBeTruthy());
    expect(policyBtn("Alpha")?.getAttribute("aria-pressed")).toBe("false");
    expect(policyBtn("Alpha")?.textContent).toContain("Carry on");
  });

  it("writes the policy to the Routine, leaving the rest of the step alone", async () => {
    routines = [routineRows({ a: { browsers: ["webkit"], headless: true }, b: {} })];
    renderView();
    await rowNames();
    await waitFor(() => expect(policyBtn("Alpha")).toBeTruthy());

    fireEvent.click(policyBtn("Alpha")!);

    await waitFor(() =>
      expect(testSteps(routines?.[0].steps ?? []).find((st) => st.testId === "a")?.onFailure).toBe("stopRoutine"),
    );
    const step = testSteps(routines?.[0].steps ?? []).find((st) => st.testId === "a");
    expect(step?.browsers).toEqual(["webkit"]);
    expect(step?.headless).toBe(true);
    // One row, not all of them.
    expect(testSteps(routines?.[0].steps ?? []).find((st) => st.testId === "b")?.onFailure).toBe("continue");
  });

  it("reads back a stored policy rather than resetting it on open", async () => {
    // The regression this replaces a comment about: the checklist used to have
    // no control for the policy, so `stepsFromRows` read it from the Routine's
    // previous steps. Now it round-trips through the view, which is the only
    // way a mount could quietly reset one.
    routines = [
      routineOf([
        {
          kind: "test",
          testId: "a",
          browsers: ["chromium"],
          headless: false,
          onFailure: "stopRoutine",
        },
      ]),
    ];
    renderView();
    await rowNames();

    await waitFor(() =>
      expect(policyBtn("Alpha")?.getAttribute("aria-pressed")).toBe("true"),
    );
    expect(policyBtn("Alpha")?.textContent).toContain("Stop on fail");
  });

  it("writes NOTHING when the view merely mounts", async () => {
    // Same property the headless master has, for the same reason: the view
    // commits on every gesture, so a mount that counts as a gesture re-dates
    // every job you open — and here it would also rewrite a policy.
    routines = [
      routineOf([
        {
          kind: "test",
          testId: "a",
          browsers: ["chromium"],
          headless: false,
          onFailure: "stopRoutine",
        },
      ]),
    ];
    renderView();
    await rowNames();
    await waitFor(() => expect(policyBtn("Alpha")).toBeTruthy());
    expect(routineSave).not.toHaveBeenCalled();
  });

  it("drops the policy when the row is unticked", async () => {
    // Deliberate asymmetry with the engine choice, which survives unticking as
    // scratch. A policy is a statement about a job this test is no longer part
    // of, so re-ticking must not silently re-arm "stop the whole routine".
    routines = [
      routineOf([
        {
          kind: "test",
          testId: "a",
          browsers: ["chromium"],
          headless: false,
          onFailure: "stopRoutine",
        },
        { kind: "test", testId: "b", browsers: ["chromium"], headless: false, onFailure: "continue" },
      ]),
    ];
    renderView();
    await rowNames();
    await waitFor(() => expect(policyBtn("Alpha")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Include Alpha in the batch"));
    await waitFor(() => expect(testSteps(routines?.[0].steps ?? []).map((st) => st.testId)).toEqual(["b"]));

    fireEvent.click(screen.getByLabelText("Include Alpha in the batch"));
    await waitFor(() => expect(routines?.[0].steps).toHaveLength(2));
    expect(testSteps(routines?.[0].steps ?? []).find((st) => st.testId === "a")?.onFailure).toBe("continue");
    // And the screen agrees with the store. This is the half that was broken:
    // the policy left view state only via a re-seed, so re-ticking before the
    // Routine query came back showed "Stop on fail" for a step the stored job
    // did not have — and `sameSteps` then read the pair as unchanged and wrote
    // nothing, so it stayed diverged instead of settling.
    expect(policyBtn("Alpha")?.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("BatchView groups", () => {
  // ONE menu asks what structure a row is part of — a group or a side of a
  // branch — because a row can only be one of them. See the comment on the
  // control in `batch-view.tsx`.
  const groupBtn = (name: string) => screen.queryByLabelText(`Structure for ${name}`);

  it("puts a row in a NEW group in one gesture, because an empty group cannot be saved", async () => {
    // Creating a group and joining one are the same gesture deliberately: the
    // store drops a group with no members, so an "add group" button would make
    // a header that disappeared on the next read.
    routines = [routineRows({ a: {}, b: {} })];
    renderView();
    await rowNames();
    await waitFor(() => expect(groupBtn("Alpha")).toBeTruthy());

    fireEvent.click(groupBtn("Alpha")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /new group/i }));

    await waitFor(() => {
      const group = (routines ?? [])[0].steps.find((st) => st.kind === "group");
      expect(group).toBeTruthy();
      if (group?.kind !== "group") throw new Error("expected a group");
      expect(group.steps.map((c) => c.testId)).toEqual(["a"]);
    });
    // …and the header is on screen, named. Not a redundant read of the store:
    // `groups` is separate view state, and the label is the only part of a
    // group that lives nowhere else on the row.
    expect(await screen.findByLabelText("Name of group Group 1")).toBeTruthy();
  });

  it("adds a second row to the group that already exists", async () => {
    routines = [routineRows({ a: {}, b: {} })];
    renderView();
    await rowNames();
    await waitFor(() => expect(groupBtn("Alpha")).toBeTruthy());

    fireEvent.click(groupBtn("Alpha")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /new group/i }));
    await waitFor(() =>
      expect((routines ?? [])[0].steps.some((st) => st.kind === "group")).toBe(true),
    );

    fireEvent.click(groupBtn("Beta")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Group 1" }));

    await waitFor(() => {
      const group = (routines ?? [])[0].steps.find((st) => st.kind === "group");
      if (group?.kind !== "group") throw new Error("expected a group");
      expect(group.steps.map((c) => c.testId)).toEqual(["a", "b"]);
    });
    // …and the Routine is ONE step now, not two: the group holds both.
    expect((routines ?? [])[0].steps).toHaveLength(1);
  });

  it("takes a row back out, and drops the group when it empties", async () => {
    routines = [routineRows({ a: {} })];
    renderView();
    await rowNames();
    await waitFor(() => expect(groupBtn("Alpha")).toBeTruthy());

    fireEvent.click(groupBtn("Alpha")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /new group/i }));
    await waitFor(() =>
      expect((routines ?? [])[0].steps.some((st) => st.kind === "group")).toBe(true),
    );

    fireEvent.click(groupBtn("Alpha")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "On its own" }));

    await waitFor(() =>
      expect((routines ?? [])[0].steps.every((st) => st.kind === "test")).toBe(true),
    );
  });

  it("renders a header above the group's first member", async () => {
    routines = [
      routineOf([
        {
          kind: "group",
          id: "g-1",
          label: "Seed",
          steps: [
            { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
          ],
        },
      ]),
    ];
    renderView();
    await rowNames();
    await waitFor(() => expect(screen.getByLabelText("Name of group Seed")).toBeTruthy());
    // …and its member row is marked as nested, which is what the indent reads
    // from. Without it the header sits above rows that look like every other
    // row — a label pointing at nothing.
    expect(document.querySelectorAll(".gl-batch-row[data-grouped]")).toHaveLength(1);
  });
});

describe("BatchView waits", () => {
  const afterMenu = (name: string) => screen.queryByLabelText(`After ${name}`);
  const pickAfter = async (name: string, item: RegExp) => {
    fireEvent.click(afterMenu(name)!);
    fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  };

  it("offers the control only on a row that is IN the job", async () => {
    // A pause after a step that does not run is a join with nothing on one
    // side of it.
    routines = [routineRows({ a: {} })];
    renderView();
    await rowNames();
    await waitFor(() => expect(afterMenu("Alpha")).toBeTruthy());
    expect(afterMenu("Beta")).toBeNull();
  });

  it("adds a pause after the row, as a `wait` step in the Routine", async () => {
    routines = [routineRows({ a: {}, b: {} })];
    renderView();
    await rowNames();
    await waitFor(() => expect(afterMenu("Alpha")).toBeTruthy());

    await pickAfter("Alpha", /pause here/i);

    await waitFor(() => {
      const steps = (routines ?? [])[0].steps;
      expect(steps.map((st) => st.kind)).toEqual(["test", "wait", "test"]);
    });
  });

  it("toggles the pause away again rather than stacking a second one", async () => {
    // Two pauses in a row means nothing a single longer one does not, so the
    // control is "is there a wait here" — a question with an answer on screen.
    routines = [routineRows({ a: {}, b: {} })];
    renderView();
    await rowNames();
    await waitFor(() => expect(afterMenu("Alpha")).toBeTruthy());

    await pickAfter("Alpha", /pause here/i);
    await waitFor(() =>
      expect((routines ?? [])[0].steps.some((st) => st.kind === "wait")).toBe(true),
    );
    await pickAfter("Alpha", /pause here/i);
    await waitFor(() =>
      expect((routines ?? [])[0].steps.some((st) => st.kind === "wait")).toBe(false),
    );
  });

  it("renders the pause as its own row, not as a step with an outcome", async () => {
    // Giving it a checkbox, engines and a status chip would promise a result it
    // can never have.
    routines = [
      routineOf([
        { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
        { kind: "wait", id: "w-1", ms: 30_000 },
        { kind: "test", testId: "b", browsers: ["chromium"], headless: false, onFailure: "continue" },
      ]),
    ];
    renderView();
    await rowNames();

    await waitFor(() => expect(document.querySelectorAll(".gl-batch-wait")).toHaveLength(1));
    const row = document.querySelector(".gl-batch-wait")!;
    expect(row.querySelector("input[type=checkbox]")).toBeNull();
    expect(row.querySelector(".gl-batch-status")).toBeNull();
    // It says WHAT it does, which is the only thing on screen that explains why
    // the run appears to stall.
    expect(row.textContent).toContain("everything above finishes first");
  });

  it("changes the pause's length", async () => {
    routines = [
      routineOf([
        { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
        { kind: "wait", id: "w-1", ms: 30_000 },
        { kind: "test", testId: "b", browsers: ["chromium"], headless: false, onFailure: "continue" },
      ]),
    ];
    renderView();
    await rowNames();
    await waitFor(() => expect(document.querySelector(".gl-batch-wait")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /length of the pause after alpha/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "5m" }));

    await waitFor(() => {
      const wait = (routines ?? [])[0].steps.find((st) => st.kind === "wait");
      if (wait?.kind !== "wait") throw new Error("expected a wait");
      expect(wait.ms).toBe(300_000);
    });
  });

  it("writes NOTHING when the view merely mounts", async () => {
    routines = [
      routineOf([
        { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
        { kind: "wait", id: "w-1", ms: 30_000 },
        { kind: "test", testId: "b", browsers: ["chromium"], headless: false, onFailure: "continue" },
      ]),
    ];
    renderView();
    await rowNames();
    await waitFor(() => expect(document.querySelector(".gl-batch-wait")).toBeTruthy());
    expect(routineSave).not.toHaveBeenCalled();
  });
});

describe("BatchView notifies", () => {
  const afterMenu = (name: string) => screen.queryByLabelText(`After ${name}`);
  const pickAfter = async (name: string, item: RegExp) => {
    fireEvent.click(afterMenu(name)!);
    fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  };

  it("adds a message that starts on the LOCAL channel", async () => {
    // Adding a step must never send anything off the machine until the user
    // says so, so a new notify starts on desktop.
    routines = [routineRows({ a: {}, b: {} })];
    renderView();
    await rowNames();
    await waitFor(() => expect(afterMenu("Alpha")).toBeTruthy());

    await pickAfter("Alpha", /say something/i);

    await waitFor(() => {
      const step = (routines ?? [])[0].steps.find((st) => st.kind === "notify");
      if (step?.kind !== "notify") throw new Error("expected a notify");
      expect(step.channel).toBe("desktop");
    });
  });

  it("says out loud whether the message leaves the machine", async () => {
    // The one control on this screen that can send data off the box. The
    // webhook promise is stated where the choice is made, not only in Settings.
    routines = [
      routineOf([
        { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
        { kind: "notify", id: "n-1", channel: "desktop", message: "Done" },
      ]),
    ];
    renderView();
    await rowNames();
    await waitFor(() => expect(document.querySelector(".gl-batch-message")).toBeTruthy());
    expect(document.body.textContent).toContain("stays on this machine");

    fireEvent.click(screen.getByRole("button", { name: /where the message after alpha goes/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Webhook" }));

    await waitFor(() => expect(document.body.textContent).toContain("leaves this machine"));
  });

  it("writes the message the user typed, on blur", async () => {
    routines = [
      routineOf([
        { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
        { kind: "notify", id: "n-1", channel: "desktop", message: "Done" },
      ]),
    ];
    renderView();
    await rowNames();
    const field = await screen.findByLabelText("Text of the message after Alpha");

    fireEvent.change(field, { target: { value: "Seeding finished" } });
    fireEvent.blur(field);

    await waitFor(() => {
      const step = (routines ?? [])[0].steps.find((st) => st.kind === "notify");
      if (step?.kind !== "notify") throw new Error("expected a notify");
      expect(step.message).toBe("Seeding finished");
    });
  });

  it("caps what can be typed at the store's own limit", async () => {
    // The field cannot produce a value the store would have to truncate — the
    // same reason the schedule is an enumeration.
    routines = [
      routineOf([
        { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
        { kind: "notify", id: "n-1", channel: "desktop", message: "Done" },
      ]),
    ];
    renderView();
    await rowNames();
    const field = await screen.findByLabelText("Text of the message after Alpha");
    expect(field.getAttribute("maxlength")).toBe(String(MAX_ROUTINE_MESSAGE));
  });

  it("writes NOTHING when the view merely mounts", async () => {
    routines = [
      routineOf([
        { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
        { kind: "notify", id: "n-1", channel: "webhook", message: "Done" },
      ]),
    ];
    renderView();
    await rowNames();
    await waitFor(() => expect(document.querySelector(".gl-batch-message")).toBeTruthy());
    expect(routineSave).not.toHaveBeenCalled();
  });
});

describe("BatchView branches", () => {
  const structure = (name: string) => screen.queryByLabelText(`Structure for ${name}`);
  const pickStructure = async (name: string, item: RegExp | string) => {
    fireEvent.click(structure(name)!);
    fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  };
  const branchOf = (): RoutineBranchStep => {
    const step = (routines ?? [])[0].steps.find((st) => st.kind === "branch");
    if (step?.kind !== "branch") throw new Error("expected a branch");
    return step;
  };

  it("puts a row on a NEW branch in one gesture, like a group", async () => {
    routines = [routineRows({ a: {}, b: {} })];
    renderView();
    await rowNames();
    await waitFor(() => expect(structure("Alpha")).toBeTruthy());

    await pickStructure("Alpha", /new branch/i);

    await waitFor(() => expect(branchOf().then.map((c) => c.testId)).toEqual(["a"]));
    // The default condition is the conservative one — the "something went
    // wrong" path, not the "all clear" one.
    expect(branchOf().on).toBe("anyFailed");
  });

  it("puts a second row on the OTHER side of the branch that exists", async () => {
    routines = [routineRows({ a: {}, b: {} })];
    renderView();
    await rowNames();
    await waitFor(() => expect(structure("Alpha")).toBeTruthy());

    await pickStructure("Alpha", /new branch/i);
    await waitFor(() => expect(branchOf().then).toHaveLength(1));

    await pickStructure("Beta", "Branch: otherwise");

    await waitFor(() => expect(branchOf().else.map((c) => c.testId)).toEqual(["b"]));
    // ONE step, holding both sides — not two steps side by side.
    expect((routines ?? [])[0].steps).toHaveLength(1);
  });

  it("takes a row off the branch, and drops the branch when both sides empty", async () => {
    routines = [routineRows({ a: {} })];
    renderView();
    await rowNames();
    await waitFor(() => expect(structure("Alpha")).toBeTruthy());

    await pickStructure("Alpha", /new branch/i);
    await waitFor(() => expect(branchOf().then).toHaveLength(1));

    await pickStructure("Alpha", "On its own");

    await waitFor(() =>
      expect((routines ?? [])[0].steps.every((st) => st.kind === "test")).toBe(true),
    );
  });

  it("moving a branch member into a group takes it OFF the branch", async () => {
    // A row can be in a group or on one side of a branch and never both.
    // `stepsFromRows` resolves the overlap by letting the branch claim the row,
    // so a row left in BOTH maps would render under a group header and be saved
    // onto the branch — the screen/disk divergence this view has produced twice.
    routines = [routineRows({ a: {}, b: {} })];
    renderView();
    await rowNames();
    await waitFor(() => expect(structure("Alpha")).toBeTruthy());

    await pickStructure("Alpha", /new branch/i);
    await pickStructure("Beta", "Branch: otherwise");
    await waitFor(() => expect(branchOf().else).toHaveLength(1));

    await pickStructure("Alpha", /new group/i);

    await waitFor(() => {
      const group = (routines ?? [])[0].steps.find((st) => st.kind === "group");
      if (group?.kind !== "group") throw new Error("expected a group");
      expect(group.steps.map((c) => c.testId)).toEqual(["a"]);
    });
    expect(branchOf().then).toHaveLength(0);
    expect(branchOf().else.map((c) => c.testId)).toEqual(["b"]);
    // …AND the screen agrees. `stepsFromRows` resolves the overlap on its own,
    // so the store alone cannot tell you the row was left in both maps — the
    // tell is that the view draws a group header AND a branch "then" header
    // over the same row, showing a structure the saved job does not have.
    expect(document.querySelectorAll(".gl-batch-group")).toHaveLength(1);
    expect(document.querySelectorAll(".gl-batch-branch")).toHaveLength(1);
  });

  it("moving a group member onto a branch takes it out of the group", async () => {
    // The mirror of the case above. Enforced in BOTH directions because a row
    // left in both maps shows one structure and saves into the other whichever
    // way it got there.
    routines = [routineRows({ a: {}, b: {} })];
    renderView();
    await rowNames();
    await waitFor(() => expect(structure("Alpha")).toBeTruthy());

    await pickStructure("Alpha", /new group/i);
    await waitFor(() =>
      expect((routines ?? [])[0].steps.some((st) => st.kind === "group")).toBe(true),
    );

    await pickStructure("Alpha", /new branch/i);

    await waitFor(() => expect(branchOf().then.map((c) => c.testId)).toEqual(["a"]));
    expect((routines ?? [])[0].steps.some((st) => st.kind === "group")).toBe(false);
    expect(document.querySelectorAll(".gl-batch-group")).toHaveLength(0);
    expect(document.querySelectorAll(".gl-batch-branch")).toHaveLength(1);
    // This direction needs no clearing in the handler — `stepsFromRows` gives
    // the branch the row, and `persist` re-derives `groupOf` from the steps it
    // emitted. It is asserted anyway because that is a property of the
    // TRANSLATION, and the day it changes this is the screen that breaks.
  });

  it("drops skipGroup when the row moves onto a branch", async () => {
    // Outside a group that policy has nothing to skip, and a branch side is not
    // a group — the plan hands `skipGroup` a `groupId` a branch member does not
    // have, so it would sit in the control doing nothing. Unlike the group
    // membership, nothing reconciles `policies` on the persist round-trip, so
    // this has to be done where the move happens.
    routines = [
      routineOf([
        {
          kind: "group",
          id: "g-1",
          label: "Seed",
          steps: [
            { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "skipGroup" },
          ],
        },
      ]),
    ];
    renderView();
    await rowNames();
    await waitFor(() =>
      expect(screen.getByLabelText("What happens if Alpha fails").textContent).toContain(
        "Skip group",
      ),
    );

    await pickStructure("Alpha", /new branch/i);

    await waitFor(() => expect(branchOf().then.map((c) => c.testId)).toEqual(["a"]));
    expect(branchOf().then[0].onFailure).toBe("continue");
    expect(screen.getByLabelText("What happens if Alpha fails").textContent).toContain("Carry on");
  });

  it("renders a header per side, and says only one of them runs", async () => {
    routines = [
      routineOf([
        {
          kind: "branch",
          id: "b-1",
          on: "anyFailed",
          then: [
            { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
          ],
          else: [
            { kind: "test", testId: "b", browsers: ["chromium"], headless: false, onFailure: "continue" },
          ],
        },
      ]),
    ];
    renderView();
    await rowNames();

    await waitFor(() => expect(document.querySelectorAll(".gl-batch-branch")).toHaveLength(2));
    // Said out loud, because it is the one thing about a branch that surprises
    // people: both sides are queued and one is always skipped, so the run count
    // above the checklist is a maximum rather than a promise.
    expect(document.body.textContent).toContain("only one side runs");
    expect(document.body.textContent).toContain("Otherwise");
    // …and both member rows are marked as nested, which is what the indent
    // reads from. Without it the headers sit above rows that look like every
    // other row — labels pointing at nothing, same as an un-indented group.
    expect(document.querySelectorAll(".gl-batch-row[data-grouped]")).toHaveLength(2);
  });

  it("flips the condition from the header, and the header says which way", async () => {
    routines = [
      routineOf([
        {
          kind: "branch",
          id: "b-1",
          on: "anyFailed",
          then: [
            { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
          ],
          else: [],
        },
      ]),
    ];
    renderView();
    await rowNames();
    const cond = await screen.findByLabelText("Condition for the branch before Alpha");
    expect(cond.textContent).toBe("If anything failed");

    fireEvent.click(cond);

    await waitFor(() => expect(branchOf().on).toBe("allPassed"));
    expect(
      screen.getByLabelText("Condition for the branch before Alpha").textContent,
    ).toBe("If everything passed");
  });

  it("keeps the condition reachable on a branch with only an ELSE side", async () => {
    // A branch survives with rows on one side — the store drops it only when
    // both are empty. An "Otherwise" header alone names a side without naming
    // what it is otherwise TO, and leaves NO control on screen that can flip
    // the condition back. So the lone header carries it, read NEGATED, because
    // negated is literally what runs.
    routines = [
      routineOf([
        {
          kind: "branch",
          id: "b-1",
          on: "anyFailed",
          then: [],
          else: [
            { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
          ],
        },
      ]),
    ];
    renderView();
    await rowNames();

    const cond = await screen.findByLabelText("Condition for the branch before Alpha");
    expect(cond.textContent).toBe("If everything passed");
    expect(document.body.textContent).toContain("otherwise nothing runs");
    expect(document.body.textContent).not.toContain("only one side runs");
  });

  it("writes NOTHING when the view merely mounts", async () => {
    routines = [
      routineOf([
        {
          kind: "branch",
          id: "b-1",
          on: "allPassed",
          then: [
            { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
          ],
          else: [
            { kind: "test", testId: "b", browsers: ["chromium"], headless: false, onFailure: "continue" },
          ],
        },
      ]),
    ];
    renderView();
    await rowNames();
    await waitFor(() => expect(document.querySelector(".gl-batch-branch")).toBeTruthy());
    expect(routineSave).not.toHaveBeenCalled();
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
    await waitFor(() => expect(testSteps(routines?.[0].steps ?? []).map((st) => st.testId)).toEqual(["b"]));
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
    expect(testSteps(routines?.[0].steps ?? []).map((st) => st.testId)).toEqual(["c", "b", "a"]);
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
    expect([...testSteps((routines ?? [])[0].steps).map((st) => st.testId)].sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
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
      expect(testSteps(routines?.[0].steps ?? []).every((st) => st.headless)).toBe(true);
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
    routineId: "r-1",
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
    routineId: "r-1",
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
      routineId: "r-1",
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
      // Started FROM this screen, so it carries the open routine — the view
      // scopes both the live batch and the history to the job on screen.
      routineId: "r-1",
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
      // Started FROM this screen, so it carries the open routine — the view
      // scopes both the live batch and the history to the job on screen.
      routineId: "r-1",
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

    await waitFor(() => expect(testSteps(routines?.[0].steps ?? []).map((st) => st.testId)).toEqual(["a", "b", "c"]));
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

    await waitFor(() => expect(testSteps(routines?.[0].steps ?? []).map((st) => st.testId)).toEqual(["a"]));
    await waitFor(() =>
      expect(screen.queryByText(/names a test that no longer exists/i)).toBeNull(),
    );
  });

  it("shows only the open routine's past batches", async () => {
    // A history listing every job's runs under one job is the same lie as a
    // checklist showing another Routine's ticks.
    routines = [
      routineOf([], { id: "r-a", name: "Smoke", createdAt: 1 }),
      routineOf([], { id: "r-b", name: "Nightly", createdAt: 2 }),
    ];
    history = [
      { ...batchRecord("mine"), routineId: "r-a" },
      { ...batchRecord("theirs"), routineId: "r-b" },
    ];
    renderView();
    await rowNames();

    await waitFor(() => expect(screen.getByText(/Previous batches/)).toBeTruthy());
    const panel = screen.getByText(/Previous batches/).closest("section");
    expect(within(panel as HTMLElement).getAllByRole("button", { name: /^Aug|^\w+ \d/ }).length)
      .toBeLessThanOrEqual(2);
    // One row, not two: the other routine's batch is not this routine's history.
    expect(within(panel as HTMLElement).queryAllByText(/3 tests/)).toHaveLength(1);
  });

  it("gives a batch with no routine to the MIGRATED one", async () => {
    // Everything run before Routines shipped, plus the MCP's `run_batch`. They
    // are runs of the old implicit checklist, and the migrated Routine IS that
    // checklist — attributing them to every job would show one history under
    // four, and to none would make a user's whole history vanish on upgrade.
    routines = [
      routineOf([], { id: ORPHAN_BATCH_OWNER, name: "Batch", createdAt: 1 }),
      routineOf([], { id: "r-b", name: "Nightly", createdAt: 2 }),
    ];
    history = [batchRecord("old-one")];
    renderView();
    await rowNames();

    const panel = () => screen.getByText(/Previous batches/).closest("section") as HTMLElement;
    await waitFor(() => expect(within(panel()).queryAllByText(/3 tests/)).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /which routine to edit/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Nightly/ }));

    // …and NOT to any other routine.
    await waitFor(() =>
      expect(screen.queryByText(/Previous batches/)).toBeNull(),
    );
  });

  it("ignores a live batch another routine started", async () => {
    // Results are keyed by testId, so a foreign batch would paint its outcomes
    // onto whichever rows this routine shares with it — a row reporting a pass
    // it never had.
    routines = [routineOf([], { id: "r-a", name: "Smoke", createdAt: 1 })];
    renderView();
    await rowNames();

    emit("batch:progress", {
      batchId: "b-elsewhere",
      routineId: "r-b",
      running: true,
      startedAt: 0,
      currentIndex: 0,
      stopped: false,
      results: [{ testId: "a", testName: "Alpha", status: "running" }],
      summary: { total: 1, passed: 0, failed: 0, skipped: 0, ok: false, durationMs: 0 },
    });

    // Idle here. The top strip's ticker is where a fact about the whole app
    // belongs; pressing Run answers "a batch is already running".
    await waitFor(() => expect(screen.queryByText(/Running 1 of 1/)).toBeNull());
    expect(screen.queryByRole("button", { name: /^Stop$/ })).toBeNull();
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

// ── The checklist's master tick ───────────────────────────────────────
//
// #74. SELECT ALL and SELECT NONE were two buttons that between them could not
// answer the question they were about: whether everything was already ticked.
// One tri-state box both reports and changes it. What must survive the rewrite
// is the property the two buttons had — it acts on the VISIBLE tests, so
// selecting all under a tag filter cannot silently untick what is hidden.
describe("BatchView master selection", () => {
  const master = () => screen.getByLabelText(/^Select all/);

  it("reports none, some and all as three distinguishable states", async () => {
    // Three states, three renderings. "some" collapsing onto "all" is the
    // failure that would leave the control reporting nothing useful — it is
    // the state neither button could express.
    settings = { batchOrder: [], batchTestOptions: {} };
    routines = [routineOf([])];
    renderView();
    await rowNames();

    expect(master().getAttribute("data-state")).toBe("unchecked");

    fireEvent.click(screen.getByLabelText("Include Beta in the batch"));
    await waitFor(() => expect(master().getAttribute("data-state")).toBe("indeterminate"));

    fireEvent.click(master());
    await waitFor(() => expect(master().getAttribute("data-state")).toBe("checked"));
    expect(checkedByName()).toEqual({ Alpha: true, Beta: true, Gamma: true });
  });

  it("clears the selection when everything visible is already ticked", async () => {
    routines = [everyTest()];
    renderView();
    await rowNames();
    expect(master().getAttribute("data-state")).toBe("checked");

    fireEvent.click(master());

    await waitFor(() =>
      expect(checkedByName()).toEqual({ Alpha: false, Beta: false, Gamma: false }),
    );
  });

  it("acts on the filtered rows and leaves hidden ticks alone", async () => {
    // The property a rewrite is most likely to lose, and the reason the two
    // buttons said "Select these" under a filter. Ticking what is shown must
    // not replace the whole selection.
    library = [test_("a", "Alpha", ["smoke"]), test_("b", "Beta", ["checkout"])];
    settings = { batchOrder: [], batchTestOptions: {} };
    routines = [
      routineOf([
        { kind: "test", testId: "b", browsers: ["chromium"], headless: false, onFailure: "continue" },
      ]),
    ];
    renderView();
    await rowNames();

    fireEvent.click(await screen.findByRole("button", { name: /^smoke/ }));
    expect(await rowNames()).toEqual(["Alpha"]);
    // Alpha alone is visible and unticked; Beta is ticked and hidden. The box
    // therefore reads "none" — it answers for the rows on screen, not for the
    // library, or clicking it would act on tests the user cannot see.
    expect(master().getAttribute("data-state")).toBe("unchecked");

    fireEvent.click(master());

    await waitFor(() => expect(checkedByName()).toEqual({ Alpha: true }));
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    await waitFor(() => expect(checkedByName()).toEqual({ Alpha: true, Beta: true }));
  });

  it("clears only what is shown, leaving hidden ticks set", async () => {
    // THE DESELECT DIRECTION, which the select case cannot cover: there, the
    // hidden test is already ticked and stays ticked under either
    // implementation, so pointing the click at the whole library instead of the
    // visible rows passes it. Here the click's scope is the whole assertion —
    // aiming it at `orderedTests` unticks Beta, which is the silent loss of
    // hidden selection the two buttons were written to avoid.
    library = [test_("a", "Alpha", ["smoke"]), test_("b", "Beta", ["checkout"])];
    routines = [everyTest()];
    renderView();
    await rowNames();

    fireEvent.click(await screen.findByRole("button", { name: /^smoke/ }));
    expect(await rowNames()).toEqual(["Alpha"]);
    expect(master().getAttribute("data-state")).toBe("checked");

    fireEvent.click(master());

    await waitFor(() => expect(checkedByName()).toEqual({ Alpha: false }));
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    await waitFor(() => expect(checkedByName()).toEqual({ Alpha: false, Beta: true }));
  });

  it("says which set it acts on, and keeps saying the same thing", async () => {
    // The scope moved into the accessible name, where the two buttons carried
    // it in their visible labels ("Select these" under a filter). The name is
    // STABLE across states on purpose: a checkbox renamed by its own state is
    // announced as a different control every time it is clicked.
    library = [test_("a", "Alpha", ["smoke"]), test_("b", "Beta", ["checkout"])];
    routines = [everyTest()];
    renderView();
    await rowNames();
    expect(master().getAttribute("data-state")).toBe("checked");
    expect(master().getAttribute("aria-label")).toBe("Select all: 2 tests");

    fireEvent.click(await screen.findByRole("button", { name: /^smoke/ }));
    await waitFor(() =>
      expect(master().getAttribute("aria-label")).toBe("Select all shown: 1 test"),
    );
  });

  it("puts its visible label inside its accessible name, in both states", async () => {
    // WCAG 2.5.3. A speech-input user says the words they can see, so a name
    // that shares none of them is a control they cannot operate. The two
    // buttons this replaced got it for free — their name WAS their text — and
    // building the name separately is exactly how that gets lost: the first
    // version read "Select these" while announcing "Select all 1 test shown by
    // this filter", which have no words in common at all.
    library = [test_("a", "Alpha", ["smoke"]), test_("b", "Beta", ["checkout"])];
    routines = [everyTest()];
    renderView();
    await rowNames();

    const containsItsLabel = () => {
      const label = master().closest("label") as HTMLElement;
      const visible = (label.textContent ?? "").trim();
      const name = master().getAttribute("aria-label") ?? "";
      return { visible, name, contained: visible.length > 0 && name.includes(visible) };
    };

    expect(containsItsLabel()).toMatchObject({ visible: "Select all", contained: true });

    fireEvent.click(await screen.findByRole("button", { name: /^smoke/ }));
    await waitFor(() =>
      expect(containsItsLabel()).toMatchObject({ visible: "Select all shown", contained: true }),
    );
  });
});

// ── A row is the same shape whether or not it is in the job ───────────
//
// Reported from the running app: ticking a box slid every cell after the marks
// 8px left and each row collapsed from 33px to 27px, so selecting all resized
// the whole checklist. The spacers that exist to prevent that were the wrong
// size — which only `check:batch-row-cells` can see, since jsdom has no layout
// engine and the dom project runs with `css: false`.
//
// What IS visible here is the half that has to be true first: the cell has to
// exist at all. Deleting a `: (<span …/>)` arm leaves a working row that
// silently slides its own columns, and no other test on this screen would fail.
describe("BatchView row shape", () => {
  /** One token per cell, in order: its gl-* class, or the tag for the rest. */
  const shapeOf = (row: Element) =>
    [...row.children].map((c) => {
      const cls = [...c.classList].find((x) => x.startsWith("gl-batch-"));
      return cls ?? c.tagName.toLowerCase();
    });

  it("gives an unticked row a cell in every column a ticked row has", async () => {
    // One of each, in one render, so this compares two rows of the same list
    // rather than two renders that could differ for unrelated reasons.
    settings = { batchOrder: [], batchTestOptions: {} };
    routines = [
      routineOf([
        { kind: "test", testId: "a", browsers: ["chromium"], headless: false, onFailure: "continue" },
      ]),
    ];
    renderView();
    await rowNames();

    const rows = [...document.querySelectorAll(".gl-batch-row")];
    const ticked = rows.find((r) => r.querySelector('[role="checkbox"][data-state="checked"]'));
    const unticked = rows.find((r) => r.querySelector('[role="checkbox"][data-state="unchecked"]'));
    expect(ticked && unticked).toBeTruthy();

    const t = shapeOf(ticked!);
    const u = shapeOf(unticked!);
    expect(u).toHaveLength(t.length);

    // The three cells that swap: control on a ticked row, spacer on an unticked
    // one, in the same position. Anything else must be identical.
    const SWAPS: Record<string, string> = {
      "gl-batch-groupmark": "gl-batch-group-gap",
      "gl-batch-aftermark": "gl-batch-waitmark-gap",
      "gl-batch-policy": "gl-batch-policy-gap",
    };
    expect(t.map((cell) => SWAPS[cell] ?? cell)).toEqual(u);
    // …and all three swaps really are exercised, or this passes vacuously on a
    // row that never had the controls in the first place.
    expect(t.filter((cell) => cell in SWAPS)).toHaveLength(3);
  });
});
