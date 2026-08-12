// Tests for the recorder store.
//
// Every view in the app reads from this one store, so a bug here is a bug
// everywhere at once — and it's driven entirely by backend PUSH EVENTS, which
// makes it the hardest thing in the app to reason about by reading. The tests
// dispatch real events through a fake `api.on` bus and assert the state the
// components would then see.
//
// The properties that matter are the ones that break silently: run output
// arriving for a run the store never started (which happens during a batch),
// and the replay console assembling itself correctly from a stream of
// start/step/done events that can be interleaved or cut short.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { RecorderState, Step } from "../lib/recorder-types";
// Safe above the vi.mock below: Vitest hoists vi.mock above imports.
import { RecorderProvider, REPLAY_FLASH_MS, useRecorder } from "./recorder-store";

// ── A controllable push-event bus standing in for the IPC bridge ─────
type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

function emit(channel: string, payload: unknown) {
  act(() => {
    for (const h of handlers.get(channel) ?? []) h(payload);
  });
}

/** What `recorder:getSteps` resolves to. Mutable so a test can stand in for a
 *  session that was already under way when this window opened. */
let fetchedSteps: Step[] = [];

vi.mock("../lib/api", () => ({
  api: {
    on: (channel: string, cb: Handler) => {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(cb);
      return () => handlers.get(channel)!.delete(cb);
    },
    recorder: {
      getState: async () => baseState(),
      // A window that opens mid-session missed the initial `recorder:steps`
      // push, so the store ASKS on mount. Served from a mutable fixture so a
      // test can decide what was already recorded before this window existed.
      getSteps: async () => fetchedSteps,
      getDebugLogs: async () => [],
      start: async () => baseState(),
      pause: async () => baseState(),
      resume: async () => baseState(),
      stop: async () => {},
      setAssert: async () => baseState(),
      deleteStep: async () => baseState(),
      insertStep: (step: unknown) => {
        inserted.push(step);
        // Deliberately NOT auto-resolving when `holdInserts` is set: proving
        // that the store inserts one at a time means observing that it has not
        // sent the second call while the first is still in flight, which is
        // invisible if every call settles immediately.
        if (!holdInserts) return Promise.resolve(baseState());
        return new Promise((resolve) => {
          releaseInsert.push(() => resolve(baseState()));
        });
      },
      reorderStep: async () => baseState(),
      updateStep: async () => baseState(),
      applyHeal: async () => baseState(),
      setCursor: async () => baseState(),
      replayStep: async () => ({ ok: true }),
      replayFromStart: async () => ({ ok: true, stoppedAtIndex: -1 }),
      replayAll: async () => ({ ok: true, failedAtIndex: -1 }),
      replayFromCurrent: async () => ({ ok: true, ranCount: 0, passedCount: 0, failedAtIndex: -1 }),
      clearDebugLog: async () => [],
      startRefine: async () => baseState(),
      endRefine: async () => baseState(),
      discardExit: async () => {},
    },
    runner: { run: async () => ({ runId: "t1" }), stop: async () => {}, replayRun: async () => ({ runId: "t1" }) },
  },
}));

function baseState(): RecorderState {
  return {
    recording: false,
    paused: false,
    assertMode: null,
    stepCount: 0,
    testId: null,
    url: null,
    name: null,
    editing: false,
    assertSoft: false,
    cursor: 0,
    refineMode: false,
    pageReady: false,
  } as RecorderState;
}

let actionsUnderTest: {
  insertGeneratedSteps: (steps: never[]) => Promise<void>;
  deleteStep: (id: string) => void;
  run: (id: string) => void;
} | null = null;

/** Renders the store's state as text so tests can assert on it. */
function Probe() {
  const {
    state,
    liveSteps,
    stepsLoaded,
    newStepIds,
    runs,
    replayRun,
    replayFlash,
    replayStepStatus,
    insertGeneratedSteps,
    deleteStep,
    run,
    runEpoch,
    lastAddedStepId,
  } = useRecorder();
  // Stashed for the tests that need to invoke an action rather than observe
  // state; a button per action would drown the markup the other suites read.
  actionsUnderTest = { insertGeneratedSteps, deleteStep, run };
  return (
    <div>
      <span data-testid="recording">{String(state.recording)}</span>
      <span data-testid="steps">{liveSteps.map((s) => s.id).join(",")}</span>
      <span data-testid="steps-loaded">{String(stepsLoaded)}</span>
      <span data-testid="new-steps">{[...newStepIds].sort().join(",")}</span>
      <span data-testid="last-added">{String(lastAddedStepId)}</span>
      <span data-testid="run-epoch">{String(runEpoch)}</span>
      <span data-testid="run-lines">{(runs["t1"]?.lines ?? []).join("|")}</span>
      <span data-testid="run-running">{String(runs["t1"]?.running ?? "none")}</span>
      <span data-testid="run-code">{String(runs["t1"]?.code ?? "none")}</span>
      <span data-testid="replay-ran">{String(replayRun?.ran ?? "none")}</span>
      <span data-testid="replay-steps">
        {(replayRun?.steps ?? []).map((s) => `${s.stepLabel}:${s.ok}`).join("|")}
      </span>
      <span data-testid="replay-flash">
        {Object.entries(replayFlash)
          .map(([i, v]) => `${i}:${v}`)
          .sort()
          .join("|")}
      </span>
      <span data-testid="replay-status">
        {Object.entries(replayStepStatus)
          .map(([i, v]) => `${i}:${v}`)
          .sort()
          .join("|")}
      </span>
    </div>
  );
}

function renderStore() {
  // The provider uses react-query internally, so it needs a client even though
  // these tests drive it entirely through push events.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RecorderProvider>
        <Probe />
      </RecorderProvider>
    </QueryClientProvider>,
  );
}

const text = (id: string) => screen.getByTestId(id).textContent;

/** Every `recorder:insertStep` the store sent, in the order it sent them. */
let inserted: unknown[] = [];
/** When true, inserts hang until the test releases them one by one. */
let holdInserts = false;
let releaseInsert: Array<() => void> = [];

beforeEach(() => {
  handlers.clear();
  fetchedSteps = [];
  inserted = [];
  holdInserts = false;
  releaseInsert = [];
  actionsUnderTest = null;
});

describe("catching up on a session already under way", () => {
  // The trainer panel window is created AFTER `recorder:start` has broadcast the
  // step list, so it never receives that push. Without an explicit fetch it
  // shows an empty step list for a test that has twelve steps, and — because
  // the insert cursor points between rows that are not there — silently records
  // into the wrong position. A push is not a substitute for being able to ask.

  it("starts out not holding the step list", () => {
    // Before anything resolves, the store must not claim to have steps.
    renderStore();
    expect(text("steps")).toBe("");
  });

  it("fetches the steps it missed", async () => {
    fetchedSteps = [
      { id: "s1", type: "goto", timestamp: 0 } as Step,
      { id: "s2", type: "click", timestamp: 0 } as Step,
    ];
    renderStore();
    await act(async () => {});
    expect(text("steps")).toBe("s1,s2");
    expect(text("steps-loaded")).toBe("true");
  });

  it("still prefers a later push over the fetched snapshot", async () => {
    // The fetch is a catch-up, not a source of truth. The backend owns
    // ordering, so whatever it broadcasts next wins.
    fetchedSteps = [{ id: "old", type: "click", timestamp: 0 } as Step];
    renderStore();
    await act(async () => {});
    expect(text("steps")).toBe("old");
    act(() => {
      emit("recorder:steps", [{ id: "new", type: "click", timestamp: 0 }]);
    });
    expect(text("steps")).toBe("new");
  });

  it("marks the list loaded when a push arrives first", () => {
    // The main window's ordinary path: the push beats the fetch.
    renderStore();
    act(() => {
      emit("recorder:steps", [{ id: "a", type: "click", timestamp: 0 }]);
    });
    expect(text("steps-loaded")).toBe("true");
  });
});

describe("recorder state events", () => {
  it("adopts pushed recorder state", () => {
    renderStore();
    emit("recorder:state", { ...baseState(), recording: true });
    expect(text("recording")).toBe("true");
  });

  it("replaces the whole step list — the backend owns ordering", () => {
    renderStore();
    emit("recorder:steps", [{ id: "a" }, { id: "b" }] as Step[]);
    expect(text("steps")).toBe("a,b");

    // A reorder arrives as a fresh list, not a patch. Merging would resurrect
    // deleted steps.
    emit("recorder:steps", [{ id: "b" }, { id: "a" }] as Step[]);
    expect(text("steps")).toBe("b,a");
  });

  it("treats a null step list as empty rather than crashing", () => {
    renderStore();
    emit("recorder:steps", null);
    expect(text("steps")).toBe("");
  });
});

describe("run output", () => {
  it("accumulates output for a run it started", () => {
    renderStore();
    emit("runner:output", { runId: "t1", chunk: "line one\n" });
    emit("runner:output", { runId: "t1", chunk: "line two\n" });
    expect(text("run-lines")).toBe("line one\n|line two\n");
  });

  it("accepts output for a run the store never started", () => {
    // This is what a BATCH does: the backend runs tests the renderer didn't
    // invoke. Dropping those chunks would leave the detail view blank while a
    // batch is running.
    renderStore();
    emit("runner:output", { runId: "t1", chunk: "from a batch\n" });
    expect(text("run-lines")).toBe("from a batch\n");
    expect(text("run-running")).toBe("true");
  });

  it("marks a run finished with its exit code", () => {
    renderStore();
    emit("runner:output", { runId: "t1", chunk: "x" });
    emit("runner:done", { runId: "t1", code: 1 });
    expect(text("run-running")).toBe("false");
    expect(text("run-code")).toBe("1");
  });

  it("handles done for a run with no prior output", () => {
    renderStore();
    emit("runner:done", { runId: "t1", code: 0 });
    expect(text("run-running")).toBe("false");
    expect(text("run-code")).toBe("0");
  });

  it("refetches the run history when the backend says it changed", () => {
    // The bug this pins: a failing test re-run until it passed kept a RED dot
    // in the sidebar. Nothing was broken about the run or the record — the
    // ["runs"] cache the dot is drawn from simply had no reason to refetch, so
    // it kept serving the list from when the window opened. The `runs:changed`
    // push existed the whole time; its only subscribers were two ROUTE
    // components, so on every other route nobody was listening. Entirely
    // silent: the run panel right next to it showed the pass.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    render(
      <QueryClientProvider client={qc}>
        <RecorderProvider>
          <Probe />
        </RecorderProvider>
      </QueryClientProvider>,
    );
    invalidate.mockClear();

    emit("runs:changed", {});

    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["runs"]));
  });
});

describe("replay console assembly", () => {
  it("builds a run from start/step/done events", () => {
    renderStore();
    emit("recorder:replayLog", { phase: "start", startIndex: 0, total: 2 });
    emit("recorder:replayLog", {
      phase: "step",
      index: 0,
      stepLabel: "click Submit",
      ok: true,
      logs: [],
    });
    emit("recorder:replayLog", {
      phase: "step",
      index: 1,
      stepLabel: "fill Email",
      ok: false,
      error: "Element not found",
      logs: [],
    });
    emit("recorder:replayLog", { phase: "done", ran: 2, passed: 1, failedAtIndex: 1 });

    expect(text("replay-ran")).toBe("2");
    expect(text("replay-steps")).toBe("click Submit:true|fill Email:false");
  });

  it("starts a fresh run rather than appending to the previous one", () => {
    // Otherwise a second replay shows the first run's steps too.
    renderStore();
    emit("recorder:replayLog", { phase: "start", startIndex: 0, total: 1 });
    emit("recorder:replayLog", { phase: "step", index: 0, stepLabel: "first", ok: true, logs: [] });
    emit("recorder:replayLog", { phase: "done", ran: 1, passed: 1, failedAtIndex: -1 });

    emit("recorder:replayLog", { phase: "start", startIndex: 0, total: 1 });
    emit("recorder:replayLog", { phase: "step", index: 0, stepLabel: "second", ok: true, logs: [] });

    expect(text("replay-steps")).toBe("second:true");
  });

  it("survives step events with no preceding start", () => {
    // Events can be missed if the view mounts mid-run; dropping them is fine,
    // crashing is not.
    renderStore();
    expect(() =>
      emit("recorder:replayLog", { phase: "step", index: 0, stepLabel: "orphan", ok: true, logs: [] }),
    ).not.toThrow();
  });

  it("carries an Auto-Heal suggestion onto its step", () => {
    // The Console renders the heal menu from this; losing it silently removes
    // the feature from the UI.
    renderStore();
    emit("recorder:replayLog", { phase: "start", startIndex: 0, total: 1 });
    emit("recorder:replayLog", {
      phase: "step",
      index: 0,
      stepLabel: "click Submit",
      ok: false,
      error: "Element not found",
      logs: [],
      heal: { candidates: [{ locator: { k: "testid", v: "b" } }], attempts: 1, ok: false },
    });
    expect(text("replay-steps")).toContain("click Submit:false");
  });
});

describe("marking AI-generated steps as new", () => {
  // The Generate Steps dialog inserts a whole flow into a list the user is
  // already looking at. The store is what decides which of the resulting rows
  // the trainer glows, and every way of getting it wrong is silent: mark
  // nothing and the insertion is invisible, mark everything and the highlight
  // means nothing, mark them and never clear and the list stays lit forever.

  const RAW = [
    { type: "click", locator: { k: "text", v: "Sign in" } },
    { type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.test" },
  ] as never[];

  /** What the backend's list looks like once the two RAW steps have landed —
   *  backend-minted ids, exactly as `insertStep` produces them. */
  const AFTER: Step[] = [
    { id: "old", type: "goto", url: "https://example.com", timestamp: 0 } as Step,
    { id: "new1", type: "click", locator: { k: "text", v: "Sign in" }, timestamp: 1 } as Step,
    { id: "new2", type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.test", timestamp: 2 } as Step,
  ];

  async function withExistingStep() {
    fetchedSteps = [AFTER[0]];
    renderStore();
    await act(async () => {});
    expect(text("steps")).toBe("old");
  }

  it("marks what landed, and not the step that was already there", async () => {
    await withExistingStep();
    fetchedSteps = AFTER;

    await act(async () => {
      await actionsUnderTest!.insertGeneratedSteps(RAW);
    });

    expect(text("steps")).toBe("old,new1,new2");
    expect(text("new-steps")).toBe("new1,new2");
  });

  it("does not send the next insert until the previous one has landed", async () => {
    // Each insert lands at the session cursor and moves it on by one. Fired
    // concurrently, where each step ends up is decided by whichever IPC call
    // the backend services first — a generated flow whose steps run in the
    // wrong order, with nothing on screen saying so.
    await withExistingStep();
    fetchedSteps = AFTER;
    holdInserts = true;

    let done = false;
    await act(async () => {
      void actionsUnderTest!.insertGeneratedSteps(RAW).then(() => {
        done = true;
      });
    });

    // First one sent, second one held back behind it.
    expect(inserted).toEqual([RAW[0]]);
    expect(done).toBe(false);

    await act(async () => {
      releaseInsert[0]();
    });
    expect(inserted).toEqual([RAW[0], RAW[1]]);

    await act(async () => {
      releaseInsert[1]();
    });
    await act(async () => {});
    expect(done).toBe(true);
  });

  it("marks only what the backend actually kept", async () => {
    // Backend normalization can reject a step the model produced. Marking all
    // of `steps` on the strength of having SENT them would leave the highlight
    // pointing at rows that don't exist.
    await withExistingStep();
    fetchedSteps = [AFTER[0], AFTER[1]];

    await act(async () => {
      await actionsUnderTest!.insertGeneratedSteps(RAW);
    });

    expect(text("new-steps")).toBe("new1");
  });

  it("marks nothing when the backend kept nothing", async () => {
    await withExistingStep();
    fetchedSteps = [AFTER[0]];

    await act(async () => {
      await actionsUnderTest!.insertGeneratedSteps(RAW);
    });

    expect(text("new-steps")).toBe("");
  });

  it("clears the marks as soon as the user edits the list by hand", async () => {
    // A highlight that outlives the moment stops being information. Once the
    // user is editing, the rows are theirs.
    await withExistingStep();
    fetchedSteps = AFTER;
    await act(async () => {
      await actionsUnderTest!.insertGeneratedSteps(RAW);
    });
    expect(text("new-steps")).toBe("new1,new2");

    await act(async () => {
      actionsUnderTest!.deleteStep("new1");
    });

    expect(text("new-steps")).toBe("");
  });

  it("clears the marks and bumps the epoch when a run starts", async () => {
    // "Run test" is the natural end of the "look what the AI changed" moment:
    // stale green outlines over a failing run would vouch for the AI's work.
    // The epoch is what OTHER views (holding their own new-step sets) watch to
    // clear at the same moment.
    await withExistingStep();
    fetchedSteps = AFTER;
    await act(async () => {
      await actionsUnderTest!.insertGeneratedSteps(RAW);
    });
    expect(text("new-steps")).toBe("new1,new2");
    expect(text("run-epoch")).toBe("0");

    await act(async () => {
      actionsUnderTest!.run("t1");
    });

    expect(text("new-steps")).toBe("");
    expect(text("run-epoch")).toBe("1");
  });

  it("marks nothing for steps the user recorded on the page", async () => {
    // The common case by far. A captured step arrives on the same
    // `recorder:steps` push as a generated one, so nothing about the push
    // itself distinguishes them — only the deliberate call does.
    await withExistingStep();

    emit("recorder:steps", [...fetchedSteps, AFTER[1]]);

    expect(text("steps")).toBe("old,new1");
    expect(text("new-steps")).toBe("");
  });
});

describe("the ephemeral replay flash", () => {
  // The flash is the row-level answer to "did the step I just replayed pass?".
  // It is deliberately SEPARATE from `replayStepStatus`, which persists so a
  // finished run stays readable — and that separation is the thing to get
  // wrong: fold them together and either the flash never fades or the finished
  // run's check marks vanish two seconds after it ends.

  it("marks a step that passed, and one that failed", () => {
    renderStore();

    emit("recorder:replayStep", { index: 0, status: "end", ok: true });
    emit("recorder:replayStep", { index: 1, status: "end", ok: false });

    expect(text("replay-flash")).toBe("0:pass|1:fail");
  });

  it("clears the flash after REPLAY_FLASH_MS, leaving the run status behind", () => {
    vi.useFakeTimers();
    try {
      renderStore();
      emit("recorder:replayStep", { index: 0, status: "end", ok: true });
      expect(text("replay-flash")).toBe("0:pass");

      // One tick short: still showing. Pinned so a change to the duration has
      // to be deliberate rather than absorbed by a generous assertion.
      act(() => {
        vi.advanceTimersByTime(REPLAY_FLASH_MS - 1);
      });
      expect(text("replay-flash")).toBe("0:pass");

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(text("replay-flash")).toBe("");
      // The persistent status is untouched — the check mark on the row outlives
      // the outline, which is the whole reason these are two pieces of state.
      expect(text("replay-status")).toBe("0:passed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a first replay's timer cut a second one short", () => {
    // Replay a step, watch it pass, immediately replay it again. The first
    // run's expiry timer is still pending and fires mid-way through the second
    // flash; without cancelling it the outline vanishes about a second early,
    // which reads as the highlight being unreliable rather than as a bug.
    vi.useFakeTimers();
    try {
      renderStore();
      emit("recorder:replayStep", { index: 0, status: "end", ok: true });

      act(() => {
        vi.advanceTimersByTime(REPLAY_FLASH_MS - 500);
      });
      emit("recorder:replayStep", { index: 0, status: "begin", ok: true });
      emit("recorder:replayStep", { index: 0, status: "end", ok: false });
      expect(text("replay-flash")).toBe("0:fail");

      // The moment the FIRST timer would have fired.
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(text("replay-flash")).toBe("0:fail");

      act(() => {
        vi.advanceTimersByTime(REPLAY_FLASH_MS - 500);
      });
      expect(text("replay-flash")).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a stale flash the moment the same step starts running again", () => {
    // A row cannot be both "running" and "passed a moment ago" — the green
    // outline under a spinner says the result is in when it isn't.
    vi.useFakeTimers();
    try {
      renderStore();
      emit("recorder:replayStep", { index: 0, status: "end", ok: true });
      emit("recorder:replayStep", { index: 0, status: "begin", ok: true });

      expect(text("replay-flash")).toBe("");
      expect(text("replay-status")).toBe("0:running");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("which step just arrived", () => {
  // `lastAddedStepId` is what lets a trainer scroll to the row that changed.
  // It matters because of where a captured step LANDS: the insert cursor sits
  // where the browser is, so continuing an existing test writes new steps into
  // the middle of the list, off-screen from a view that follows the bottom.
  // Getting this wrong is silent in the worst direction — the trainer looks
  // like it recorded nothing.

  it("points at nothing until a step actually arrives", async () => {
    // The first list of a session is the TEST showing up, not steps being
    // added. Pointing at its last row would scroll on every session open and
    // claim something was captured when nothing was.
    renderStore();
    emit("recorder:steps", [
      { id: "a", type: "goto" },
      { id: "b", type: "click" },
    ] as Step[]);
    expect(text("last-added")).toBe("null");
  });

  it("points at a step inserted in the MIDDLE of the list, not the end", () => {
    renderStore();
    emit("recorder:steps", [{ id: "a" }, { id: "b" }, { id: "c" }] as Step[]);
    emit("recorder:steps", [{ id: "a" }, { id: "new" }, { id: "b" }, { id: "c" }] as Step[]);
    expect(text("last-added")).toBe("new");
  });

  it("points at the last of several that arrive together", () => {
    // An AI batch lands as one push. The last one is the end of what was
    // added, which is what a reader wants to be looking at.
    renderStore();
    emit("recorder:steps", [{ id: "a" }] as Step[]);
    emit("recorder:steps", [{ id: "a" }, { id: "x" }, { id: "y" }] as Step[]);
    expect(text("last-added")).toBe("y");
  });

  it("keeps pointing at the last arrival when a later push only REMOVES", () => {
    // A delete is not an arrival. Clearing the pointer here would be harmless
    // but re-pointing it would scroll the view somewhere nobody asked to go.
    renderStore();
    emit("recorder:steps", [{ id: "a" }] as Step[]);
    emit("recorder:steps", [{ id: "a" }, { id: "new" }] as Step[]);
    emit("recorder:steps", [{ id: "new" }] as Step[]);
    expect(text("last-added")).toBe("new");
  });

  it("forgets the arrival when the session finishes", () => {
    // The next session's list is a different test. A stale pointer into it
    // would either miss (harmless) or hit an unrelated step (not).
    renderStore();
    emit("recorder:steps", [{ id: "a" }] as Step[]);
    emit("recorder:steps", [{ id: "a" }, { id: "new" }] as Step[]);
    expect(text("last-added")).toBe("new");
    emit("recorder:finished", { testId: "t1" });
    expect(text("last-added")).toBe("null");
    // And the FIRST list of the next session is an arrival-free load again.
    emit("recorder:steps", [{ id: "p" }, { id: "q" }] as Step[]);
    expect(text("last-added")).toBe("null");
  });
});
