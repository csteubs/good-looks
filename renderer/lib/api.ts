// Typed wrappers over the exposed window.glazeAPI IPC bridge. Renderer code
// never touches ipcRenderer directly.

import type {
  AssertKind,
  RawStep,
  RecorderSettings,
  RecorderState,
  Step,
  TestRecord,
  TestSpeed,
} from "./recorder-types";
import type {
  LlmChatParams,
  LlmConfig,
  LlmModel,
  LlmProvider,
  LlmProviderStatus,
} from "./llm-types";

export interface ImportResult {
  imported: number;
  names: string[];
  ids: string[];
}

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
    setAssert: (mode: AssertKind | null, soft = false) =>
      ipc().invoke<RecorderState>("recorder:setAssert", { mode, soft }),
    deleteStep: (stepId: string) =>
      ipc().invoke<RecorderState>("recorder:deleteStep", { stepId }),
    insertStep: (step: RawStep, index?: number) =>
      ipc().invoke<RecorderState>("recorder:insertStep", { step, index }),
    reorderStep: (stepId: string, toIndex: number) =>
      ipc().invoke<RecorderState>("recorder:reorderStep", { stepId, toIndex }),
    updateStep: (stepId: string, patch: Partial<Step>) =>
      ipc().invoke<RecorderState>("recorder:updateStep", { stepId, patch }),
    setCursor: (index: number) =>
      ipc().invoke<RecorderState>("recorder:setCursor", { index }),
    replayStep: (stepId: string) =>
      ipc().invoke<{ ok: boolean; error?: string }>("recorder:replayStep", { stepId }),
    stop: () => ipc().invoke<void>("recorder:stop"),
    getState: () => ipc().invoke<RecorderState>("recorder:getState"),
    getSettings: () => ipc().invoke<RecorderSettings>("recorder:getSettings"),
    setSettings: (update: Partial<RecorderSettings>) =>
      ipc().invoke<RecorderSettings>("recorder:setSettings", update),
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
    createFromPrompt: (params: {
      name: string;
      url: string;
      speed?: TestSpeed;
      source: string;
    }) => ipc().invoke<TestRecord>("tests:createFromPrompt", params),
    setSpeed: (id: string, speed: TestSpeed) =>
      ipc().invoke<TestRecord>("tests:setSpeed", { id, speed }),
    setHidden: (id: string, hidden: boolean) =>
      ipc().invoke<TestRecord | null>("tests:setHidden", { id, hidden }),
    importFiles: () => ipc().invoke<ImportResult>("tests:importFiles"),
    importGit: (url: string) => ipc().invoke<ImportResult>("tests:importGit", { url }),
  },
  runner: {
    run: (id: string, headed: boolean) =>
      ipc().invoke<{ runId: string }>("runner:run", { id, headed }),
    stop: (runId: string) => ipc().invoke<void>("runner:stop", { runId }),
  },
  llm: {
    getConfig: () => ipc().invoke<LlmConfig>("llm:getConfig"),
    setConfig: (update: Partial<LlmConfig>) => ipc().invoke<LlmConfig>("llm:setConfig", update),
    status: (provider: LlmProvider) =>
      ipc().invoke<LlmProviderStatus>("llm:status", { provider }),
    detect: () => ipc().invoke<LlmProviderStatus[]>("llm:detect"),
    listModels: (provider: LlmProvider) =>
      ipc().invoke<LlmModel[]>("llm:listModels", { provider }),
    chat: (params: LlmChatParams) => ipc().invoke<{ requestId: string }>("llm:chat", params),
    cancel: (requestId: string) => ipc().invoke<void>("llm:cancel", { requestId }),
  },
  /** Subscribe to a backend push event. Returns an unsubscribe function. */
  on<T>(channel: string, cb: (payload: T) => void): () => void {
    return ipc().on(channel, (...args: unknown[]) => cb(args[1] as T));
  },
};
