// Typed wrappers over the exposed window.glazeAPI IPC bridge. Renderer code
// never touches ipcRenderer directly.

import type {
  Annotation,
  AssertKind,
  DebugEntry,
  LogSearchResult,
  Locator,
  RawStep,
  RecorderSettings,
  RecorderState,
  RunRecord,
  ArtifactUsage,
  BaselineEntry,
  CaptureOverheadSummary,
  RetentionResult,
  BatchRecord,
  BatchState,
  RunBrowser,
  RunComparison,
  RunReplay,
  RunReplaySummary,
  VisualMask,
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
      ipc().invoke<DebugEntry>("recorder:replayStep", { stepId }),
    replayFromStart: () =>
      ipc().invoke<{ ok: boolean; stoppedAtIndex: number; error?: string }>(
        "recorder:replayFromStart",
      ),
    replayAll: () =>
      ipc().invoke<{ ok: boolean; failedAtIndex: number; error?: string }>(
        "recorder:replayAll",
      ),
    replayFromCurrent: (startIndex: number) =>
      ipc().invoke<{
        ok: boolean;
        ranCount: number;
        passedCount: number;
        failedAtIndex: number;
        error?: string;
      }>("recorder:replayFromCurrent", { startIndex }),
    getDebugLogs: (testId: string) =>
      ipc().invoke<DebugEntry[]>("recorder:getDebugLogs", { testId }),
    clearDebugLog: (stepId: string) =>
      ipc().invoke<DebugEntry[]>("recorder:clearDebugLog", { stepId }),
    startRefine: () => ipc().invoke<RecorderState>("recorder:startRefine"),
    endRefine: () => ipc().invoke<RecorderState>("recorder:endRefine"),
    stop: () => ipc().invoke<void>("recorder:stop"),
    discardExit: () => ipc().invoke<void>("recorder:discardExit"),
    getState: () => ipc().invoke<RecorderState>("recorder:getState"),
    getSettings: () => ipc().invoke<RecorderSettings>("recorder:getSettings"),
    setSettings: (update: Partial<RecorderSettings>) =>
      ipc().invoke<RecorderSettings>("recorder:setSettings", update),
    applyHeal: (stepId: string, locator: Locator) =>
      ipc().invoke<RecorderState>("recorder:applyHeal", { stepId, locator }),
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
    updateSteps: (id: string, steps: Step[]) =>
      ipc().invoke<TestRecord>("tests:updateSteps", { id, steps }),
    createFromPrompt: (params: {
      name: string;
      url: string;
      speed?: TestSpeed;
      source: string;
    }) => ipc().invoke<TestRecord>("tests:createFromPrompt", params),
    setSpeed: (id: string, speed: TestSpeed) =>
      ipc().invoke<TestRecord>("tests:setSpeed", { id, speed }),
    setCaptureArtifacts: (id: string, captureArtifacts: boolean) =>
      ipc().invoke<TestRecord>("tests:setCaptureArtifacts", { id, captureArtifacts }),
    setHeadless: (id: string, runHeadless: boolean) =>
      ipc().invoke<TestRecord>("tests:setHeadless", { id, runHeadless }),
    setBrowser: (id: string, runBrowser: RunBrowser) =>
      ipc().invoke<TestRecord>("tests:setBrowser", { id, runBrowser }),
    setTags: (id: string, tags: string[]) =>
      ipc().invoke<TestRecord>("tests:setTags", { id, tags }),
    setHidden: (id: string, hidden: boolean) =>
      ipc().invoke<TestRecord | null>("tests:setHidden", { id, hidden }),
    importFiles: () => ipc().invoke<ImportResult>("tests:importFiles"),
    importGit: (url: string) => ipc().invoke<ImportResult>("tests:importGit", { url }),
  },
  batch: {
    run: (
      testIds: string[],
      opts?: { captureArtifacts?: boolean; runHeadless?: boolean; browser?: RunBrowser },
    ) =>
      ipc().invoke<{ batchId: string; alreadyRunning: boolean }>("batch:run", {
        testIds,
        captureArtifacts: opts?.captureArtifacts,
        runHeadless: opts?.runHeadless,
        browser: opts?.browser,
      }),
    stop: () => ipc().invoke<void>("batch:stop"),
    status: () => ipc().invoke<BatchState | null>("batch:status"),
    list: () => ipc().invoke<BatchRecord[]>("batch:list"),
    get: (batchId: string) => ipc().invoke<BatchRecord | null>("batch:get", { batchId }),
    remove: (batchId: string) => ipc().invoke<{ removed: number }>("batch:delete", { batchId }),
    clearHistory: () => ipc().invoke<{ removed: number }>("batch:clearHistory"),
  },
  alerts: {
    setWebhookUrl: (url: string) =>
      ipc().invoke<{ hasUrl: boolean; host: string | null }>("alerts:setWebhookUrl", { url }),
    clearWebhookUrl: () =>
      ipc().invoke<{ hasUrl: boolean; host: string | null }>("alerts:clearWebhookUrl"),
    status: () => ipc().invoke<{ hasUrl: boolean; host: string | null }>("alerts:status"),
    test: () => ipc().invoke<{ ok: boolean }>("alerts:test"),
  },
  runner: {
    run: (
      id: string,
      headed: boolean,
      captureArtifacts?: boolean,
      runHeadless?: boolean,
      browser?: RunBrowser,
    ) =>
      ipc().invoke<{ runId: string }>("runner:run", {
        id,
        headed,
        captureArtifacts,
        runHeadless,
        browser,
      }),
    stop: (runId: string) => ipc().invoke<void>("runner:stop", { runId }),
    replayRun: (testId: string, runId: string, runHeadless?: boolean) =>
      ipc().invoke<{ runId: string }>("runner:replayRun", { testId, runId, runHeadless }),
    compareRuns: (testId: string, baseRunId: string, replayRunId: string) =>
      ipc().invoke<RunComparison | null>("runner:compareRuns", { testId, baseRunId, replayRunId }),
  },
  runs: {
    list: () => ipc().invoke<RunRecord[]>("runs:list"),
    getLog: (id: string) => ipc().invoke<string>("runs:getLog", { id }),
    searchLogs: (query: string) =>
      ipc().invoke<LogSearchResult[]>("runs:searchLogs", { query }),
    resetStats: () => ipc().invoke<{ removed: number }>("runs:resetStats"),
    deleteAll: () => ipc().invoke<{ removed: number }>("runs:deleteAll"),
    deleteRange: (fromMs: number, toMs: number) =>
      ipc().invoke<{ removed: number }>("runs:deleteRange", { fromMs, toMs }),
    logsDir: () => ipc().invoke<string>("runs:logsDir"),
    captureOverhead: (testId?: string) =>
      ipc().invoke<CaptureOverheadSummary>("runs:captureOverhead", { testId }),
  },
  artifacts: {
    list: () => ipc().invoke<RunReplaySummary[]>("artifacts:list"),
    getReplay: (testId: string, runId: string) =>
      ipc().invoke<RunReplay | null>("artifacts:getReplay", { testId, runId }),
    readShot: (testId: string, runId: string, file: string) =>
      ipc().invoke<string | null>("artifacts:readShot", { testId, runId, file }),
    usage: () => ipc().invoke<ArtifactUsage>("artifacts:usage"),
    pruneNow: () => ipc().invoke<RetentionResult>("artifacts:pruneNow"),
  },
  visual: {
    getThreshold: (testId: string) =>
      ipc().invoke<number>("visual:getThreshold", { testId }),
    setThreshold: (testId: string, threshold: number) =>
      ipc().invoke<number>("visual:setThreshold", { testId, threshold }),
    acceptRun: (testId: string, runId: string) =>
      ipc().invoke<RunReplay | null>("visual:acceptRun", { testId, runId }),
    acceptStep: (testId: string, runId: string, stepId: string) =>
      ipc().invoke<RunReplay | null>("visual:acceptStep", { testId, runId, stepId }),
    baselineShot: (testId: string, stepId: string) =>
      ipc().invoke<string | null>("visual:baselineShot", { testId, stepId }),
    getMasks: (testId: string) => ipc().invoke<VisualMask[]>("visual:getMasks", { testId }),
    listBaselines: (testId: string) =>
      ipc().invoke<BaselineEntry[]>("visual:listBaselines", { testId }),
    clearBaseline: (testId: string, stepId: string) =>
      ipc().invoke<boolean>("visual:clearBaseline", { testId, stepId }),
    getElementSteps: (testId: string) =>
      ipc().invoke<string[]>("visual:getElementSteps", { testId }),
    setElementStep: (testId: string, stepId: string, element: boolean) =>
      ipc().invoke<string[]>("visual:setElementStep", { testId, stepId, element }),
    setMasks: (testId: string, masks: VisualMask[]) =>
      ipc().invoke<VisualMask[]>("visual:setMasks", { testId, masks }),
  },
  annotations: {
    list: (testId: string, runId: string) =>
      ipc().invoke<Annotation[]>("annotations:list", { testId, runId }),
    upsert: (testId: string, runId: string, stepId: string, text: string) =>
      ipc().invoke<Annotation | null>("annotations:upsert", { testId, runId, stepId, text }),
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
    // Anthropic API key management (key stays backend-side).
    setApiKey: (key: string) => ipc().invoke<{ hasKey: boolean }>("llm:setApiKey", { key }),
    clearApiKey: () => ipc().invoke<{ hasKey: boolean }>("llm:clearApiKey"),
    hasApiKey: () => ipc().invoke<{ hasKey: boolean }>("llm:hasApiKey"),
  },
  /** Subscribe to a backend push event. Returns an unsubscribe function. */
  on<T>(channel: string, cb: (payload: T) => void): () => void {
    return ipc().on(channel, (...args: unknown[]) => cb(args[1] as T));
  },
};
