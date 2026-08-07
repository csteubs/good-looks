// Global recorder + runner state, fed by backend push events. Live recording
// steps and run output are ephemeral streams, so they live here rather than in
// React Query (which owns persisted test data).

import * as React from "react";

import { toast } from "@glaze/core/components";

import { api } from "../lib/api";
import { newStepIds as computeNewStepIds } from "../lib/diff-steps";
import type {
  DebugCaptureSession,
  AssertKind,
  ContextAction,
  DebugEntry,
  DebugLogLine,
  HealSuggestion,
  Locator,
  PickedElement,
  RawStep,
  RecorderState,
  ReplayLogEvent,
  RunBrowser,
  Step,
} from "../lib/recorder-types";

export type RunStepStatus = "running" | "passed" | "failed";

/** How long a replayed step's pass/fail outline stays on its row.
 *
 *  Deliberately the same 2500ms as the per-row replay tint in step-row.tsx, so
 *  the outline and the background clear together — two ephemeral highlights on
 *  one row expiring a beat apart reads as a rendering glitch. */
export const REPLAY_FLASH_MS = 2500;

/** One step's result within a live "Replay from current step" run. */
export interface ReplayConsoleStep {
  index: number;
  stepLabel: string;
  ok: boolean;
  error?: string;
  logs: DebugLogLine[];
  /** Auto-Heal result for this step, if the engine ran. */
  heal?: HealSuggestion;
}

/** Live state of a "Replay from current step" run, driven by recorder:replayLog. */
export interface ReplayRun {
  running: boolean;
  startIndex: number;
  total: number;
  ran: number;
  passed: number;
  failedAtIndex: number;
  steps: ReplayConsoleStep[];
  startedAt: number;
  finishedAt: number | null;
  error?: string;
}

export interface RunInfo {
  lines: string[];
  running: boolean;
  code: number | null;
  /** Per-step run status, keyed by step index (0-based). */
  stepStatus: Record<number, RunStepStatus>;
  /** Artifact id for this execution, once it finishes. Distinct from the map
   *  key, which is the TEST id — every run of a test shares that. */
  recordId?: string;
  /** When this execution STARTED. Identifies the run from the first moment,
   *  where recordId only arrives at the end — so anything keyed on "which run
   *  is this" is stable for the whole run instead of changing under it. */
  startedAt: number;
}

const EMPTY_STATE: RecorderState = {
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
  replaying: false,
  pageReady: false,
  loading: false,
  loadFailed: false,
};

interface RecorderContextValue {
  state: RecorderState;
  liveSteps: Step[];
  /** True once THIS window holds the session's step list.
   *
   *  `recorder:steps` is a push whose first fire happens inside `recorder:start`,
   *  so a window created later in the session (the docked panel) never sees it.
   *  Controls must stay inert until the list is actually here — acting on a step
   *  list you have not received yet edits the wrong position, or nothing. */
  stepsLoaded: boolean;
  /** Ids of steps the AI just added to the list (Generate Steps), so the step
   *  rows can glow. Empty for steps the user added by hand: they know what they
   *  just typed, and highlighting it would be noise. */
  newStepIds: Set<string>;
  runs: Record<string, RunInfo>;
  /** `viewport` is the New Recording dialog's window-size preset; omitted (or
   *  null) keeps the trainer's default window size. Ignored when `testId` names
   *  an existing test — that session opens at the size the test recorded. */
  start: (
    url: string,
    name: string,
    testId?: string,
    viewport?: { width: number; height: number } | null,
  ) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  /** Close the training window without saving (discard steps). */
  discardExit: () => void;
  setAssert: (mode: AssertKind | null, soft?: boolean) => void;
  deleteStep: (id: string) => void;
  insertStep: (step: RawStep, index?: number) => void;
  /** Insert a batch of AI-generated steps and mark what landed as new, so the
   *  step list can glow it. Separate from `insertStep` because only this path
   *  produces steps the user did not write themselves. */
  insertGeneratedSteps: (steps: RawStep[]) => Promise<void>;
  reorderStep: (id: string, toIndex: number) => void;
  updateStep: (id: string, patch: Partial<Step>) => void;
  /** Apply a user-chosen Auto-Heal candidate locator to a step. */
  applyHeal: (stepId: string, locator: Locator) => void;
  setCursor: (index: number) => void;
  replayStep: (id: string) => Promise<DebugEntry>;
  replayFromStart: () => Promise<{
    ok: boolean;
    stoppedAtIndex: number;
    error?: string;
  }>;
  /** Replay every step in order (auto-run on Edit in Trainer), highlighting each. */
  replayAll: () => Promise<{ ok: boolean; failedAtIndex: number; error?: string }>;
  /** Replay slowly from `startIndex` through the end, streaming each step's
   *  output live to the debug panel's Console tab. */
  replayFromCurrent: (startIndex: number) => Promise<{
    ok: boolean;
    ranCount: number;
    passedCount: number;
    failedAtIndex: number;
    error?: string;
  }>;
  /** Live state of the most recent "Replay from current step" run (or null). */
  replayRun: ReplayRun | null;
  /** True while ANY replay is executing (single step, from-current, etc.) — the
   *  trainer shows "Running" and locks step editing while this is true. */
  executing: boolean;
  /** Per-step status for an in-flight replay, keyed by step index. */
  replayStepStatus: Record<number, RunStepStatus>;
  /** Ephemeral pass/fail outline for a step that JUST finished replaying, keyed
   *  by step index. Distinct from `replayStepStatus`, which persists until the
   *  next run so the finished run stays readable: this is the flash that says
   *  "this one, just now" and clears itself a couple of seconds later. */
  replayFlash: Record<number, "pass" | "fail">;
  /** Persisted per-step debug entries (latest attempt per step), for the debug panel. */
  debugEntries: DebugEntry[];
  /** Remove one step's debug entry (persists via backend). */
  clearDebugEntry: (id: string) => void;
  picked: PickedElement | null;
  /** id of the step currently being refined (Refine Selector), or null */
  refiningStepId: string | null;
  startRefine: (stepId?: string | null) => void;
  endRefine: () => void;
  clearPicked: () => void;
  /** The most recent right-click test-tools action from the training browser
   *  (assertion/wait/refine/add-step), with the picked element + prefills.
   *  The trainer opens the Add-step dialog from this; null when idle. */
  contextAction: ContextAction | null;
  clearContextAction: () => void;
  run: (id: string, captureArtifacts?: boolean, headless?: boolean, browser?: RunBrowser) => void;
  stopRun: (id: string) => void;
}

const RecorderContext = React.createContext<RecorderContextValue | null>(null);

export function useRecorder(): RecorderContextValue {
  const ctx = React.useContext(RecorderContext);
  if (!ctx) throw new Error("useRecorder must be used within RecorderProvider");
  return ctx;
}

/**
 * What to do when a recording finishes.
 *
 * Injected rather than done here, because the provider now mounts in TWO
 * windows: the main window, which navigates to the finished test and
 * invalidates its queries, and the trainer panel, which has no router to
 * navigate and no test list to invalidate. Calling `useNavigate` in the
 * provider would throw outright in the panel — a router hook is not optional at
 * runtime just because the value is unused.
 */
export type OnRecordingFinished = (testId: string) => void;

export function RecorderProvider({
  children,
  onFinished,
}: {
  children: React.ReactNode;
  onFinished?: OnRecordingFinished;
}) {
  const [state, setState] = React.useState<RecorderState>(EMPTY_STATE);
  const [liveSteps, setLiveSteps] = React.useState<Step[]>([]);
  const [stepsLoaded, setStepsLoaded] = React.useState(false);
  const [newStepIds, setNewStepIds] = React.useState<Set<string>>(() => new Set());
  // Mirror of liveSteps for the callbacks below. They are created once (empty
  // dep arrays, so the trainer's props don't rebuild on every captured step),
  // which means reading `liveSteps` from their closure would read the list as
  // it was when the provider first rendered — i.e. empty.
  const liveStepsRef = React.useRef<Step[]>([]);
  liveStepsRef.current = liveSteps;
  const [picked, setPicked] = React.useState<PickedElement | null>(null);
  const [refiningStepId, setRefiningStepId] = React.useState<string | null>(null);
  const [contextAction, setContextAction] = React.useState<ContextAction | null>(null);
  const [debugEntries, setDebugEntries] = React.useState<DebugEntry[]>([]);
  const [runs, setRuns] = React.useState<Record<string, RunInfo>>({});
  // Per-step status for an in-flight trainer replayAll (auto-run on Edit in
  // Trainer), keyed by step index. Cleared when a new run starts.
  const [replayStepStatus, setReplayStepStatus] = React.useState<Record<number, RunStepStatus>>({});
  // Ephemeral pass/fail outline, keyed by step index. Every entry owns a timer
  // that removes it; the timers are held so they can be cancelled, because a
  // step replayed twice in quick succession would otherwise have the FIRST
  // run's timer clear the second run's flash early.
  const [replayFlash, setReplayFlash] = React.useState<Record<number, "pass" | "fail">>({});
  const flashTimers = React.useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  React.useEffect(() => {
    const timers = flashTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);
  // Live "Replay from current step" run, streamed from the backend.
  const [replayRun, setReplayRun] = React.useState<ReplayRun | null>(null);
  // True while any replay (single step / from-current) is in flight — drives
  // the "Running" status and locks step editing.
  const [executing, setExecuting] = React.useState(false);
  // Held in a ref so a caller passing an inline arrow doesn't retear down and
  // re-subscribe every push listener on each render.
  const finishedRef = React.useRef(onFinished);
  finishedRef.current = onFinished;

  React.useEffect(() => {
    const offState = api.on<RecorderState>("recorder:state", (s) => setState(s));
    // The backend now owns step ordering (insert/reorder/edit), so it broadcasts
    // the whole list after every change and we replace our copy.
    const offSteps = api.on<Step[]>("recorder:steps", (steps) => {
      setLiveSteps(steps ?? []);
      setStepsLoaded(true);
    });
    const offPicked = api.on<PickedElement>("recorder:picked", (p) => setPicked(p));
    // The debug-screenshot shortcut fires with no visible effect otherwise —
    // you press a key and nothing happens, which is indistinguishable from the
    // shortcut not being registered at all. (It once WASN'T, and this is how
    // that presented.) The toast names the windows so you know it caught the
    // one you meant.
    const offCaptured = api.on<DebugCaptureSession>("debug:captured", (session) => {
      if (session.error) toast.error(session.error);
      else {
        const names = session.shots.map((s) => s.window).join(", ");
        toast.success(
          `Screenshot saved — ${session.shots.length} ${session.shots.length === 1 ? "window" : "windows"}: ${names}`,
        );
      }
    });
    // Right-click test-tools menu in the training browser: the backend resolves
    // the element under the cursor and pushes the chosen action; the trainer
    // opens the Add-step dialog prefilled from it.
    const offCtx = api.on<ContextAction>("recorder:contextAction", (a) => setContextAction(a));
    // A navigation that tried to leave the training window. Surfaced rather
    // than logged quietly: when this protection fails the damage happens in
    // ANOTHER application, where the app can neither see nor undo it — so the
    // one time it engages, the user should know it did.
    const offBlocked = api.on<{ url: string; reason: string }>(
      "recorder:navigationBlocked",
      ({ url, reason }) => {
        toast.warning(
          `Kept inside the training window: ${url || "a navigation"} (${reason})`,
        );
      },
    );
    const offFinished = api.on<{ testId: string }>("recorder:finished", ({ testId }) => {
      setLiveSteps([]);
      setStepsLoaded(false);
      finishedRef.current?.(testId);
    });
    const offOut = api.on<{ runId: string; chunk: string }>("runner:output", ({ runId, chunk }) => {
      setRuns((prev) => {
        const cur = prev[runId] ?? { lines: [], running: true, code: null, stepStatus: {}, startedAt: Date.now() };
        return { ...prev, [runId]: { ...cur, lines: [...cur.lines, chunk] } };
      });
    });
    const offStep = api.on<{
      runId: string;
      index: number;
      status: "begin" | "end";
      ok: boolean;
    }>("runner:step", ({ runId, index, status, ok }) => {
      setRuns((prev) => {
        const cur = prev[runId] ?? { lines: [], running: true, code: null, stepStatus: {}, startedAt: Date.now() };
        const stepStatus = { ...cur.stepStatus };
        if (status === "begin") {
          stepStatus[index] = "running";
        } else {
          stepStatus[index] = ok ? "passed" : "failed";
        }
        return { ...prev, [runId]: { ...cur, stepStatus } };
      });
    });
    const offDone = api.on<{ runId: string; code: number; recordId?: string }>(
      "runner:done",
      ({ runId, code, recordId }) => {
        setRuns((prev) => {
          const cur = prev[runId] ?? { lines: [], running: false, code, stepStatus: {}, startedAt: Date.now() };
          return { ...prev, [runId]: { ...cur, running: false, code, recordId } };
        });
      },
    );
    const offDebug = api.on<{ testId: string; entries: DebugEntry[] }>(
      "recorder:debugLogs",
      ({ entries }) => setDebugEntries(entries ?? []),
    );
    const offReplayStep = api.on<{
      index: number;
      status: "begin" | "end";
      ok: boolean;
    }>("recorder:replayStep", ({ index, status, ok }) => {
      setReplayStepStatus((prev) => ({
        ...prev,
        [index]: status === "begin" ? "running" : ok ? "passed" : "failed",
      }));
      // The flash is keyed off "end" rather than the replay's start: a step can
      // legitimately take seconds (a conditional wait runs up to its timeout),
      // and a flash timed from the start would already be gone by the time the
      // step it describes actually finished.
      if (status === "begin") {
        const pending = flashTimers.current.get(index);
        if (pending) {
          clearTimeout(pending);
          flashTimers.current.delete(index);
        }
        setReplayFlash((prev) => {
          if (!(index in prev)) return prev;
          const next = { ...prev };
          delete next[index];
          return next;
        });
        return;
      }
      setReplayFlash((prev) => ({ ...prev, [index]: ok ? "pass" : "fail" }));
      const timer = setTimeout(() => {
        flashTimers.current.delete(index);
        setReplayFlash((prev) => {
          if (!(index in prev)) return prev;
          const next = { ...prev };
          delete next[index];
          return next;
        });
      }, REPLAY_FLASH_MS);
      flashTimers.current.set(index, timer);
    });
    // Live "Replay from current step" streaming: build the run model up as each
    // phase arrives so the Console tab can show output as the test runs.
    const offReplayLog = api.on<ReplayLogEvent>("recorder:replayLog", (ev) => {
      if (ev.phase === "start") {
        setReplayRun({
          running: true,
          startIndex: ev.startIndex,
          total: ev.total,
          ran: 0,
          passed: 0,
          failedAtIndex: -1,
          steps: [],
          startedAt: Date.now(),
          finishedAt: null,
        });
      } else if (ev.phase === "step") {
        setReplayRun((prev) =>
          prev
            ? {
                ...prev,
                ran: prev.ran + 1,
                passed: prev.passed + (ev.ok ? 1 : 0),
                steps: [
                  ...prev.steps,
                  {
                    index: ev.index,
                    stepLabel: ev.stepLabel,
                    ok: ev.ok,
                    error: ev.error,
                    logs: ev.logs,
                    heal: ev.heal,
                  },
                ],
              }
            : prev,
        );
      } else {
        setReplayRun((prev) =>
          prev
            ? {
                ...prev,
                running: false,
                ran: ev.ran,
                passed: ev.passed,
                failedAtIndex: ev.failedAtIndex,
                finishedAt: Date.now(),
                error: ev.error,
              }
            : prev,
        );
      }
    });

    api.recorder.getState().then(setState).catch(() => {});
    // Ask, rather than only listening. The initial `recorder:steps` push fires
    // during `recorder:start`; a window opened after that (the docked panel is
    // created once the page is ready) would otherwise show an empty step list
    // until the user happened to mutate something.
    api.recorder
      .getSteps()
      .then((steps) => {
        setLiveSteps(steps ?? []);
        setStepsLoaded(true);
      })
      .catch(() => {});

    return () => {
      offState();
      offSteps();
      offPicked();
      offCaptured();
      offCtx();
      offBlocked();
      offFinished();
      offOut();
      offStep();
      offDone();
      offDebug();
      offReplayStep();
      offReplayLog();
    };
    // Subscribe once. `onFinished` is read through a ref precisely so it cannot
    // appear here — a changing callback would tear down and re-subscribe every
    // push listener, and a step captured during that gap is simply lost.
  }, []);

  // Load persisted debug logs whenever the active session's test changes, so
  // the panel shows prior replay diagnostics after reopening the trainer.
  React.useEffect(() => {
    if (!state.testId) {
      setDebugEntries([]);
      return;
    }
    api.recorder.getDebugLogs(state.testId).then(setDebugEntries).catch(() => {});
  }, [state.testId]);

  const start = React.useCallback(
    async (
      url: string,
      name: string,
      testId?: string,
      viewport?: { width: number; height: number } | null,
    ) => {
      setLiveSteps([]);
      // A new session's list has nothing to do with the last one's highlight.
      setNewStepIds(new Set());
      await api.recorder.start(url, name, testId, viewport);
    },
    [],
  );
  const pause = React.useCallback(() => void api.recorder.pause(), []);
  const resume = React.useCallback(() => void api.recorder.resume(), []);
  const stop = React.useCallback(() => void api.recorder.stop(), []);
  const discardExit = React.useCallback(() => void api.recorder.discardExit(), []);
  const setAssert = React.useCallback(
    (mode: AssertKind | null, soft = false) => void api.recorder.setAssert(mode, soft),
    [],
  );
  // Any hand mutation of the list retires the "the AI added these" highlight:
  // once the user is editing, the claim is no longer about a change made behind
  // their back, and the tracked ids may not even be in the list any more.
  const clearNewSteps = React.useCallback(() => {
    setNewStepIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  // These mutations are echoed back via the recorder:steps broadcast, so there's
  // no optimistic local update — the backend list is the source of truth.
  const deleteStep = React.useCallback(
    (id: string) => {
      clearNewSteps();
      void api.recorder.deleteStep(id);
    },
    [clearNewSteps],
  );
  const insertStep = React.useCallback(
    (step: RawStep, index?: number) => {
      clearNewSteps();
      void api.recorder.insertStep(step, index);
    },
    [clearNewSteps],
  );
  const reorderStep = React.useCallback(
    (id: string, toIndex: number) => {
      clearNewSteps();
      void api.recorder.reorderStep(id, toIndex);
    },
    [clearNewSteps],
  );
  const updateStep = React.useCallback(
    (id: string, patch: Partial<Step>) => {
      clearNewSteps();
      void api.recorder.updateStep(id, patch);
    },
    [clearNewSteps],
  );

  const insertGeneratedSteps = React.useCallback(async (steps: RawStep[]) => {
    const before = liveStepsRef.current;
    // Sequential, not `forEach`: each insert lands at the session cursor and
    // advances it, so firing them concurrently leaves the order up to whichever
    // IPC call the backend happens to service first.
    for (const step of steps) {
      await api.recorder.insertStep(step);
    }
    // Re-read rather than waiting for the `recorder:steps` push. The push and
    // the invoke reply are different channels with no ordering guarantee
    // between them, and the diff needs the settled list — if it ran a beat
    // early it would mark only the first of the inserted steps.
    const after = await api.recorder.getSteps().catch(() => null);
    if (!after) return;
    setLiveSteps(after);
    setStepsLoaded(true);
    // Normalization backend-side can drop a step the model produced, so this
    // diffs what actually landed instead of assuming all of `steps` did.
    setNewStepIds(computeNewStepIds(before, after));
  }, []);
  const applyHeal = React.useCallback(
    (stepId: string, locator: Locator) => void api.recorder.applyHeal(stepId, locator),
    [],
  );
  const setCursor = React.useCallback((index: number) => void api.recorder.setCursor(index), []);
  const replayStep = React.useCallback(async (id: string) => {
    setExecuting(true);
    try {
      const entry = await api.recorder.replayStep(id);
      // The backend pushes the full list via recorder:debugLogs, but update
      // locally too so the panel reacts before the push round-trips.
      setDebugEntries((prev) => {
        const next = prev.filter((e) => e.stepId !== entry.stepId);
        next.push(entry);
        return next;
      });
      return entry;
    } finally {
      setExecuting(false);
    }
  }, []);
  const replayFromStart = React.useCallback(async () => {
    setExecuting(true);
    try {
      const res = await api.recorder.replayFromStart();
      // The backend persists + pushes per-step entries during the run; refresh
      // from the store so the panel reflects every replayed step.
      if (state.testId) {
        api.recorder.getDebugLogs(state.testId).then(setDebugEntries).catch(() => {});
      }
      return res;
    } finally {
      setExecuting(false);
    }
  }, [state.testId]);
  const replayAll = React.useCallback(async () => {
    setExecuting(true);
    setReplayStepStatus({});
    try {
      const res = await api.recorder.replayAll();
      if (state.testId) {
        api.recorder.getDebugLogs(state.testId).then(setDebugEntries).catch(() => {});
      }
      return res;
    } finally {
      setExecuting(false);
    }
  }, [state.testId]);
  const replayFromCurrent = React.useCallback(async (startIndex: number) => {
    // Reset row highlighting for a fresh run; the live console is reset by the
    // backend's "start" replayLog event.
    setExecuting(true);
    setReplayStepStatus({});
    try {
      const res = await api.recorder.replayFromCurrent(startIndex);
      if (state.testId) {
        api.recorder.getDebugLogs(state.testId).then(setDebugEntries).catch(() => {});
      }
      return res;
    } finally {
      setExecuting(false);
    }
  }, [state.testId]);
  const clearDebugEntry = React.useCallback((id: string) => {
    api.recorder.clearDebugLog(id).then(setDebugEntries).catch(() => {});
  }, []);
  const startRefine = React.useCallback((stepId: string | null = null) => {
    setRefiningStepId(stepId);
    void api.recorder.startRefine();
  }, []);
  const endRefine = React.useCallback(() => {
    setRefiningStepId(null);
    void api.recorder.endRefine();
  }, []);
  const clearPicked = React.useCallback(() => setPicked(null), []);
  const run = React.useCallback((id: string, captureArtifacts?: boolean, headless?: boolean, browser?: RunBrowser) => {
    setRuns((prev) => ({
      ...prev,
      [id]: { lines: [], running: true, code: null, stepStatus: {}, startedAt: Date.now() },
    }));
    // headed = not headless — the trainer path is unaffected (separate channel).
    api.runner.run(id, !headless, captureArtifacts, headless, browser).catch(() => {});
  }, []);
  const stopRun = React.useCallback((id: string) => void api.runner.stop(id), []);

  const value: RecorderContextValue = {
    state,
    liveSteps,
    stepsLoaded,
    newStepIds,
    runs,
    start,
    pause,
    resume,
    stop,
    setAssert,
    deleteStep,
    insertStep,
    insertGeneratedSteps,
    reorderStep,
    updateStep,
    applyHeal,
    setCursor,
    replayStep,
    replayFromStart,
    replayAll,
    replayFromCurrent,
    replayRun,
    executing,
    replayStepStatus,
    replayFlash,
    debugEntries,
    clearDebugEntry,
    picked,
    refiningStepId,
    startRefine,
    endRefine,
    clearPicked,
    contextAction,
    clearContextAction: () => setContextAction(null),
    discardExit,
    run,
    stopRun,
  };

  return <RecorderContext.Provider value={value}>{children}</RecorderContext.Provider>;
}
