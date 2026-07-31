// Global recorder + runner state, fed by backend push events. Live recording
// steps and run output are ephemeral streams, so they live here rather than in
// React Query (which owns persisted test data).

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { api } from "../lib/api";
import type { AssertKind, PickedElement, RawStep, RecorderState, Step } from "../lib/recorder-types";

export interface RunInfo {
  lines: string[];
  running: boolean;
  code: number | null;
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
};

interface RecorderContextValue {
  state: RecorderState;
  liveSteps: Step[];
  runs: Record<string, RunInfo>;
  start: (url: string, name: string, testId?: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setAssert: (mode: AssertKind | null, soft?: boolean) => void;
  deleteStep: (id: string) => void;
  insertStep: (step: RawStep, index?: number) => void;
  reorderStep: (id: string, toIndex: number) => void;
  updateStep: (id: string, patch: Partial<Step>) => void;
  setCursor: (index: number) => void;
  replayStep: (id: string) => Promise<{ ok: boolean; error?: string }>;
  picked: PickedElement | null;
  /** id of the step currently being refined (Refine Selector), or null */
  refiningStepId: string | null;
  startRefine: (stepId?: string | null) => void;
  endRefine: () => void;
  clearPicked: () => void;
  run: (id: string) => void;
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
  const [runs, setRuns] = React.useState<Record<string, RunInfo>>({});
  const navigate = useNavigate();
  const qc = useQueryClient();

  React.useEffect(() => {
    const offState = api.on<RecorderState>("recorder:state", (s) => setState(s));
    // The backend now owns step ordering (insert/reorder/edit), so it broadcasts
    // the whole list after every change and we replace our copy.
    const offSteps = api.on<Step[]>("recorder:steps", (steps) => setLiveSteps(steps ?? []));
    const offPicked = api.on<PickedElement>("recorder:picked", (p) => setPicked(p));
    const offFinished = api.on<{ testId: string }>("recorder:finished", ({ testId }) => {
      setLiveSteps([]);
      qc.invalidateQueries({ queryKey: ["tests"] });
      qc.invalidateQueries({ queryKey: ["test", testId] });
      qc.invalidateQueries({ queryKey: ["script", testId] });
      navigate({ to: "/test/$id", params: { id: testId } });
    });
    const offOut = api.on<{ runId: string; chunk: string }>("runner:output", ({ runId, chunk }) => {
      setRuns((prev) => {
        const cur = prev[runId] ?? { lines: [], running: true, code: null };
        return { ...prev, [runId]: { ...cur, lines: [...cur.lines, chunk] } };
      });
    });
    const offDone = api.on<{ runId: string; code: number }>("runner:done", ({ runId, code }) => {
      setRuns((prev) => {
        const cur = prev[runId] ?? { lines: [], running: false, code };
        return { ...prev, [runId]: { ...cur, running: false, code } };
      });
    });

    api.recorder.getState().then(setState).catch(() => {});

    return () => {
      offState();
      offSteps();
      offPicked();
      offFinished();
      offOut();
      offDone();
    };
  }, [navigate, qc]);

  const start = React.useCallback(async (url: string, name: string, testId?: string) => {
    setLiveSteps([]);
    await api.recorder.start(url, name, testId);
  }, []);
  const pause = React.useCallback(() => void api.recorder.pause(), []);
  const resume = React.useCallback(() => void api.recorder.resume(), []);
  const stop = React.useCallback(() => void api.recorder.stop(), []);
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
  const setCursor = React.useCallback((index: number) => void api.recorder.setCursor(index), []);
  const replayStep = React.useCallback((id: string) => api.recorder.replayStep(id), []);
  const startRefine = React.useCallback((stepId: string | null = null) => {
    setRefiningStepId(stepId);
    void api.recorder.startRefine();
  }, []);
  const endRefine = React.useCallback(() => {
    setRefiningStepId(null);
    void api.recorder.endRefine();
  }, []);
  const clearPicked = React.useCallback(() => setPicked(null), []);
  const run = React.useCallback((id: string) => {
    setRuns((prev) => ({ ...prev, [id]: { lines: [], running: true, code: null } }));
    api.runner.run(id, true).catch(() => {});
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
    setCursor,
    replayStep,
    picked,
    refiningStepId,
    startRefine,
    endRefine,
    clearPicked,
    run,
    stopRun,
  };

  return <RecorderContext.Provider value={value}>{children}</RecorderContext.Provider>;
}
