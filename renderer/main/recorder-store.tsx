// Global recorder + runner state, fed by backend push events. Live recording
// steps and run output are ephemeral streams, so they live here rather than in
// React Query (which owns persisted test data).

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { toast } from "@glaze/core/components";

import { api } from "../lib/api";
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
  pageReady: false,
  loading: false,
  loadFailed: false,
};

interface RecorderContextValue {
  state: RecorderState;
  liveSteps: Step[];
  runs: Record<string, RunInfo>;
  start: (url: string, name: string, testId?: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  /** Close the training window without saving (discard steps). */
  discardExit: () => void;
  setAssert: (mode: AssertKind | null, soft?: boolean) => void;
  deleteStep: (id: string) => void;
  insertStep: (step: RawStep, index?: number) => void;
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

export function RecorderProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<RecorderState>(EMPTY_STATE);
  const [liveSteps, setLiveSteps] = React.useState<Step[]>([]);
  const [picked, setPicked] = React.useState<PickedElement | null>(null);
  const [refiningStepId, setRefiningStepId] = React.useState<string | null>(null);
  const [contextAction, setContextAction] = React.useState<ContextAction | null>(null);
  const [debugEntries, setDebugEntries] = React.useState<DebugEntry[]>([]);
  const [runs, setRuns] = React.useState<Record<string, RunInfo>>({});
  // Per-step status for an in-flight trainer replayAll (auto-run on Edit in
  // Trainer), keyed by step index. Cleared when a new run starts.
  const [replayStepStatus, setReplayStepStatus] = React.useState<Record<number, RunStepStatus>>({});
  // Live "Replay from current step" run, streamed from the backend.
  const [replayRun, setReplayRun] = React.useState<ReplayRun | null>(null);
  // True while any replay (single step / from-current) is in flight — drives
  // the "Running" status and locks step editing.
  const [executing, setExecuting] = React.useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  React.useEffect(() => {
    const offState = api.on<RecorderState>("recorder:state", (s) => setState(s));
    // The backend now owns step ordering (insert/reorder/edit), so it broadcasts
    // the whole list after every change and we replace our copy.
    const offSteps = api.on<Step[]>("recorder:steps", (steps) => setLiveSteps(steps ?? []));
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
    const offFinished = api.on<{ testId: string }>("recorder:finished", ({ testId }) => {
      setLiveSteps([]);
      qc.invalidateQueries({ queryKey: ["tests"] });
      qc.invalidateQueries({ queryKey: ["test", testId] });
      qc.invalidateQueries({ queryKey: ["script", testId] });
      navigate({ to: "/test/$id", params: { id: testId } });
    });
    const offOut = api.on<{ runId: string; chunk: string }>("runner:output", ({ runId, chunk }) => {
      setRuns((prev) => {
        const cur = prev[runId] ?? { lines: [], running: true, code: null, stepStatus: {} };
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
        const cur = prev[runId] ?? { lines: [], running: true, code: null, stepStatus: {} };
        const stepStatus = { ...cur.stepStatus };
        if (status === "begin") {
          stepStatus[index] = "running";
        } else {
          stepStatus[index] = ok ? "passed" : "failed";
        }
        return { ...prev, [runId]: { ...cur, stepStatus } };
      });
    });
    const offDone = api.on<{ runId: string; code: number }>("runner:done", ({ runId, code }) => {
      setRuns((prev) => {
        const cur = prev[runId] ?? { lines: [], running: false, code, stepStatus: {} };
        return { ...prev, [runId]: { ...cur, running: false, code } };
      });
    });
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

    return () => {
      offState();
      offSteps();
      offPicked();
      offCaptured();
      offCtx();
      offFinished();
      offOut();
      offStep();
      offDone();
      offDebug();
      offReplayStep();
      offReplayLog();
    };
  }, [navigate, qc]);

  // Load persisted debug logs whenever the active session's test changes, so
  // the panel shows prior replay diagnostics after reopening the trainer.
  React.useEffect(() => {
    if (!state.testId) {
      setDebugEntries([]);
      return;
    }
    api.recorder.getDebugLogs(state.testId).then(setDebugEntries).catch(() => {});
  }, [state.testId]);

  const start = React.useCallback(async (url: string, name: string, testId?: string) => {
    setLiveSteps([]);
    await api.recorder.start(url, name, testId);
  }, []);
  const pause = React.useCallback(() => void api.recorder.pause(), []);
  const resume = React.useCallback(() => void api.recorder.resume(), []);
  const stop = React.useCallback(() => void api.recorder.stop(), []);
  const discardExit = React.useCallback(() => void api.recorder.discardExit(), []);
  const setAssert = React.useCallback(
    (mode: AssertKind | null, soft = false) => void api.recorder.setAssert(mode, soft),
    [],
  );
  // These mutations are echoed back via the recorder:steps broadcast, so there's
  // no optimistic local update — the backend list is the source of truth.
  const deleteStep = React.useCallback((id: string) => void api.recorder.deleteStep(id), []);
  const insertStep = React.useCallback(
    (step: RawStep, index?: number) => void api.recorder.insertStep(step, index),
    [],
  );
  const reorderStep = React.useCallback(
    (id: string, toIndex: number) => void api.recorder.reorderStep(id, toIndex),
    [],
  );
  const updateStep = React.useCallback(
    (id: string, patch: Partial<Step>) => void api.recorder.updateStep(id, patch),
    [],
  );
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
    setRuns((prev) => ({ ...prev, [id]: { lines: [], running: true, code: null, stepStatus: {} } }));
    // headed = not headless — the trainer path is unaffected (separate channel).
    api.runner.run(id, !headless, captureArtifacts, headless, browser).catch(() => {});
  }, []);
  const stopRun = React.useCallback((id: string) => void api.runner.stop(id), []);

  const value: RecorderContextValue = {
    state,
    liveSteps,
    runs,
    start,
    pause,
    resume,
    stop,
    setAssert,
    deleteStep,
    insertStep,
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
