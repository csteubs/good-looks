// Global recorder + runner state, fed by backend push events. Live recording
// steps and run output are ephemeral streams, so they live here rather than in
// React Query (which owns persisted test data).

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { api } from "../lib/api";
import type { AssertKind, RecorderState, Step } from "../lib/recorder-types";

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
};

interface RecorderContextValue {
  state: RecorderState;
  liveSteps: Step[];
  runs: Record<string, RunInfo>;
  start: (url: string, name: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setAssert: (mode: AssertKind | null) => void;
  deleteStep: (id: string) => void;
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
  const [runs, setRuns] = React.useState<Record<string, RunInfo>>({});
  const navigate = useNavigate();
  const qc = useQueryClient();

  React.useEffect(() => {
    const offState = api.on<RecorderState>("recorder:state", (s) => setState(s));
    const offStep = api.on<Step>("recorder:step", (step) =>
      setLiveSteps((prev) => [...prev, step]),
    );
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
      offStep();
      offFinished();
      offOut();
      offDone();
    };
  }, [navigate, qc]);

  const start = React.useCallback(async (url: string, name: string) => {
    setLiveSteps([]);
    await api.recorder.start(url, name);
  }, []);
  const pause = React.useCallback(() => void api.recorder.pause(), []);
  const resume = React.useCallback(() => void api.recorder.resume(), []);
  const stop = React.useCallback(() => void api.recorder.stop(), []);
  const setAssert = React.useCallback(
    (mode: AssertKind | null) => void api.recorder.setAssert(mode),
    [],
  );
  const deleteStep = React.useCallback((id: string) => {
    void api.recorder.deleteStep(id);
    setLiveSteps((prev) => prev.filter((s) => s.id !== id));
  }, []);
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
    run,
    stopRun,
  };

  return <RecorderContext.Provider value={value}>{children}</RecorderContext.Provider>;
}
