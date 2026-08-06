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
import { RecorderProvider, useRecorder } from "./recorder-store";

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
      insertStep: async () => baseState(),
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

/** Renders the store's state as text so tests can assert on it. */
function Probe() {
  const { state, liveSteps, stepsLoaded, runs, replayRun } = useRecorder();
  return (
    <div>
      <span data-testid="recording">{String(state.recording)}</span>
      <span data-testid="steps">{liveSteps.map((s) => s.id).join(",")}</span>
      <span data-testid="steps-loaded">{String(stepsLoaded)}</span>
      <span data-testid="run-lines">{(runs["t1"]?.lines ?? []).join("|")}</span>
      <span data-testid="run-running">{String(runs["t1"]?.running ?? "none")}</span>
      <span data-testid="run-code">{String(runs["t1"]?.code ?? "none")}</span>
      <span data-testid="replay-ran">{String(replayRun?.ran ?? "none")}</span>
      <span data-testid="replay-steps">
        {(replayRun?.steps ?? []).map((s) => `${s.stepLabel}:${s.ok}`).join("|")}
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

beforeEach(() => {
  handlers.clear();
  fetchedSteps = [];
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
