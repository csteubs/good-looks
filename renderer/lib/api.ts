// Typed wrappers over the exposed window.glazeAPI IPC bridge. Renderer code
// never touches ipcRenderer directly.

import type { AssertKind, RecorderState, TestRecord } from "./recorder-types";

interface Ipc {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on(channel: string, cb: (...args: unknown[]) => void): () => void;
}

function ipc(): Ipc {
  return (window as unknown as { glazeAPI: { glaze: { ipc: Ipc } } }).glazeAPI.glaze.ipc;
}

export const api = {
  recorder: {
    start: (url: string, name: string, testId?: string) =>
      ipc().invoke<RecorderState>("recorder:start", { url, name, testId }),
    pause: () => ipc().invoke<RecorderState>("recorder:pause"),
    resume: () => ipc().invoke<RecorderState>("recorder:resume"),
    setAssert: (mode: AssertKind | null) =>
      ipc().invoke<RecorderState>("recorder:setAssert", { mode }),
    deleteStep: (stepId: string) =>
      ipc().invoke<RecorderState>("recorder:deleteStep", { stepId }),
    stop: () => ipc().invoke<void>("recorder:stop"),
    getState: () => ipc().invoke<RecorderState>("recorder:getState"),
  },
  tests: {
    list: () => ipc().invoke<TestRecord[]>("tests:list"),
    get: (id: string) => ipc().invoke<TestRecord | null>("tests:get", { id }),
    getScript: (id: string) => ipc().invoke<string>("tests:getScript", { id }),
    remove: (id: string) => ipc().invoke<void>("tests:delete", { id }),
    rename: (id: string, name: string) =>
      ipc().invoke<TestRecord>("tests:rename", { id, name }),
    updateScript: (id: string, source: string) =>
      ipc().invoke<TestRecord>("tests:updateScript", { id, source }),
  },
  runner: {
    run: (id: string, headed: boolean) =>
      ipc().invoke<{ runId: string }>("runner:run", { id, headed }),
    stop: (runId: string) => ipc().invoke<void>("runner:stop", { runId }),
  },
  /** Subscribe to a backend push event. Returns an unsubscribe function. */
  on<T>(channel: string, cb: (payload: T) => void): () => void {
    return ipc().on(channel, (...args: unknown[]) => cb(args[1] as T));
  },
};
