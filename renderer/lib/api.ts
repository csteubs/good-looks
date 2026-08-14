// Typed wrappers over the exposed window.glazeAPI IPC bridge. Renderer code
// never touches ipcRenderer directly.

import type {
  Annotation,
  AssertKind,
  Dataset,
  DebugCaptureSession,
  FlakeReport,
  HealEntry,
  HealListEntry,
  ScriptChangeEntry,
  ScriptChangeListEntry,
  ScriptChangeSource,
  SecretStatus,
  TestVariable,
  AiDebugSession,
  DebugEntry,
  RunLogs,
  StepStructure,
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
  Routine,
  BatchState,
  CookieSpec,
  LiveCookie,
  RunBrowser,
  RunComparison,
  RunNoticeKind,
  RunReplay,
  RunReplaySummary,
  VisualMask,
  Step,
  TestRecord,
  TestSpeed,
} from "./recorder-types";
import type { BranchStatus, BranchSummary, PullRequestSummary } from "./branch-types";
import type {
  ConnectionStatus,
  CreatedIssue,
  DefectSource,
  IssueContainer,
  IssueDefaults,
  IssueDraft,
  IssueLabel,
  IssueLink,
  IssueSubContainer,
  ProviderChoice,
  ProviderId,
  ProviderVocabulary,
} from "./issue-types";
import type { TriageResult } from "../../shared/triage.mjs";
import type { EmitterId } from "../../shared/emitters.mjs";
import type { EmitResult } from "./recorder-types";
import type {
  StepDurationRow,
  StepHealthRow,
  TestDurationTrend,
} from "../../shared/metrics-query.mjs";
import type { CostBreakdown, DivergentStep } from "../../shared/step-insights.mjs";
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
  /** Names of tests that navigate relatively with no base URL to resolve
   *  against — each one fails on its first `goto` until somebody supplies one.
   *  Mirrors the backend `ImportResult`. */
  needsBaseUrl: string[];
  /** Config features the source project relied on that this app does not
   *  reproduce (`webServer`, `globalSetup`, `storageState`). */
  unsupported: string[];
}

interface Ipc {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on(channel: string, cb: (...args: unknown[]) => void): () => void;
}

function ipc(): Ipc {
  return (window as unknown as { glazeAPI: { glaze: { ipc: Ipc } } }).glazeAPI.glaze.ipc;
}

export const api = {
  /** Docking of the trainer panel beside the training browser. Both return the
   *  resulting state — docking can be refused when the display is too small. */
  trainerPanel: {
    dock: () => ipc().invoke<{ docked: boolean }>("trainerPanel:dock"),
    undock: () => ipc().invoke<{ docked: boolean }>("trainerPanel:undock"),
    /** The current state, for a panel that just mounted. The push announcing a
     *  refused dock is sent before this window's page exists, so a panel that
     *  opened undocked can only find out by asking. */
    getState: () =>
      ipc().invoke<{ docked: boolean; reason: string | null }>("trainerPanel:getState"),
  },
  recorder: {
    start: (
      url: string,
      name: string,
      testId?: string,
      viewport?: { width: number; height: number } | null,
    ) => ipc().invoke<RecorderState>("recorder:start", { url, name, testId, viewport }),
    pause: () => ipc().invoke<RecorderState>("recorder:pause"),
    resume: () => ipc().invoke<RecorderState>("recorder:resume"),
    setAssert: (mode: AssertKind | null, soft = false) =>
      ipc().invoke<RecorderState>("recorder:setAssert", { mode, soft }),
    /** Open a URL assertion prefilled with the training page's live URL. Called
     *  from the training browser's URL strip. */
    assertUrl: (kind: AssertKind) =>
      ipc().invoke<RecorderState>("recorder:assertUrl", { kind }),
    getTrainingUrl: () =>
      ipc().invoke<{ url: string; loading: boolean }>("recorder:getTrainingUrl"),
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
    /** How many elements a locator matches on the live page right now. -1 when
     *  the count could not be taken — never 0, which would read as "nothing
     *  matches" and send the user hunting for a mistake that is not there. */
    countMatches: (locator: Locator) =>
      ipc().invoke<number>("recorder:countMatches", { locator }),
    stop: () => ipc().invoke<void>("recorder:stop"),
    discardExit: () => ipc().invoke<void>("recorder:discardExit"),
    getState: () => ipc().invoke<RecorderState>("recorder:getState"),
    /** Current session steps. A window opening mid-session missed the initial
     *  `recorder:steps` push, so it has to ask. */
    getSteps: () => ipc().invoke<Step[]>("recorder:getSteps"),
    getSettings: () => ipc().invoke<RecorderSettings>("recorder:getSettings"),
    setSettings: (update: Partial<RecorderSettings>) =>
      ipc().invoke<RecorderSettings>("recorder:setSettings", update),
    // Live cookies in the training browser. Each mutation returns the fresh
    // list so the panel can't drift from the session.
    listCookies: () => ipc().invoke<LiveCookie[]>("recorder:listCookies"),
    setCookie: (cookie: CookieSpec) =>
      ipc().invoke<LiveCookie[]>("recorder:setCookie", { cookie }),
    deleteCookie: (cookie: CookieSpec) =>
      ipc().invoke<LiveCookie[]>("recorder:deleteCookie", { cookie }),
    clearCookies: () => ipc().invoke<LiveCookie[]>("recorder:clearCookies"),
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
    /** Copy a test — steps, script and settings, none of its history. Returns
     *  the new record, whose name is `<original> [n]`. */
    duplicate: (id: string) => ipc().invoke<TestRecord>("tests:duplicate", { id }),
    /** `origin` says who made the change, for the script-change journal. Absent
     *  means a manual edit the user watched land — the behaviour every caller
     *  had before the journal existed. */
    updateScript: (id: string, source: string, origin?: ScriptChangeSource) =>
      ipc().invoke<TestRecord>("tests:updateScript", { id, source, origin }),
    /** `regenerate` rebuilds the .spec.ts from these steps even when it was
     *  hand-edited / imported / model-written. Without it such a test keeps its
     *  script and is marked diverged — the steps are saved, the run is not
     *  affected. Ignored for generated tests, which always regenerate. */
    updateSteps: (id: string, steps: Step[], opts?: { regenerate?: boolean }) =>
      ipc().invoke<TestRecord>("tests:updateSteps", {
        id,
        steps,
        regenerate: opts?.regenerate === true,
      }),
    /** Silence the "steps and script disagree" banner. The record stays
     *  diverged — this only says the user has seen it, until the next
     *  divergence is established. Pass `false` to bring the banner back. */
    dismissDiverged: (id: string, dismissed = true) =>
      ipc().invoke<TestRecord>("tests:dismissDiverged", { id, dismissed }),
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
    setRecordLogs: (id: string, recordLogs: boolean) =>
      ipc().invoke<TestRecord>("tests:setRecordLogs", { id, recordLogs }),
    setHeadless: (id: string, runHeadless: boolean) =>
      ipc().invoke<TestRecord>("tests:setHeadless", { id, runHeadless }),
    setBrowser: (id: string, runBrowser: RunBrowser) =>
      ipc().invoke<TestRecord>("tests:setBrowser", { id, runBrowser }),
    /** Per-test Playwright timeout override in ms. Pass null to clear and fall
     *  back to the global Settings default. */
    setTestTimeout: (id: string, testTimeoutMs: number | null) =>
      ipc().invoke<TestRecord>("tests:setTestTimeout", { id, testTimeoutMs }),
    /** Base URL an imported spec's relative navigations resolve against. Pass
     *  null (or an empty string) to clear it. The backend validates and
     *  normalizes; it throws on anything that isn't an http(s) address. */
    setBaseUrl: (id: string, baseUrl: string | null) =>
      ipc().invoke<TestRecord>("tests:setBaseUrl", { id, baseUrl }),
    setTags: (id: string, tags: string[]) =>
      ipc().invoke<TestRecord>("tests:setTags", { id, tags }),
    /** Remove a tag from every test that carries it (case-insensitive, hidden
     *  tests included). Returns the canonical tag and how many records actually
     *  changed — which can EXCEED what the UI counted, since the library the
     *  renderer sees excludes hidden tests. */
    deleteTag: (tag: string) =>
      ipc().invoke<{ tag: string; removed: number }>("tests:deleteTag", { tag }),
    /** Move a test into a folder in the library rail, or out of every folder
     *  with `""`. One group per test — see `TestRecord.group` for why that is
     *  not the same field as `tags`. */
    setGroup: (id: string, group: string) =>
      ipc().invoke<TestRecord>("tests:setGroup", { id, group }),
    /** Rename a group across every test that carries it, in one write. `to: ""`
     *  DELETES the group by moving its members to the top level — there is no
     *  group record to remove. Returns how many records changed, which can
     *  exceed what the rail counted, since it does not see hidden tests. */
    renameGroup: (from: string, to: string) =>
      ipc().invoke<{ from: string; to: string; changed: number }>("tests:renameGroup", {
        from,
        to,
      }),
    setHidden: (id: string, hidden: boolean) =>
      ipc().invoke<TestRecord | null>("tests:setHidden", { id, hidden }),
    setA11yChecks: (id: string, a11yChecks: boolean) =>
      ipc().invoke<TestRecord>("tests:setA11yChecks", { id, a11yChecks }),
    setVariables: (id: string, variables: TestVariable[]) =>
      ipc().invoke<TestRecord>("tests:setVariables", { id, variables }),
    // One-way: a secret's value crosses renderer→backend and never comes back.
    setSecret: (id: string, name: string, value: string) =>
      ipc().invoke<SecretStatus>("tests:setSecret", { id, name, value }),
    clearSecret: (id: string, name: string) =>
      ipc().invoke<SecretStatus>("tests:clearSecret", { id, name }),
    secretStatus: (id: string) => ipc().invoke<SecretStatus[]>("tests:secretStatus", { id }),
    setDatasets: (id: string, datasets: Dataset[]) =>
      ipc().invoke<TestRecord>("tests:setDatasets", { id, datasets }),
    setFlow: (id: string, isFlow: boolean, flowParams: string[]) =>
      ipc().invoke<TestRecord>("tests:setFlow", { id, isFlow, flowParams }),
    listFlows: (fromId?: string) =>
      ipc().invoke<{ id: string; name: string; flowParams: string[] }[]>("tests:listFlows", {
        fromId,
      }),
    importFiles: () => ipc().invoke<ImportResult>("tests:importFiles"),
    importGit: (url: string) => ipc().invoke<ImportResult>("tests:importGit", { url }),
  },
  debug: {
    /** Capture every open app window now. */
    capture: () => ipc().invoke<DebugCaptureSession>("debug:capture"),
    dir: () => ipc().invoke<string>("debug:dir"),
    shortcut: () => ipc().invoke<string>("debug:shortcut"),
  },
  a11y: {
    acceptStep: (testId: string, runId: string, stepId: string) =>
      ipc().invoke<RunReplay | null>("a11y:acceptStep", { testId, runId, stepId }),
    acceptRun: (testId: string, runId: string) =>
      ipc().invoke<RunReplay | null>("a11y:acceptRun", { testId, runId }),
    resetBaseline: (testId: string) =>
      ipc().invoke<{ cleared: number }>("a11y:resetBaseline", { testId }),
  },
  heals: {
    list: (testId: string) => ipc().invoke<HealEntry[]>("heals:list", { testId }),
    listAll: () => ipc().invoke<HealListEntry[]>("heals:listAll"),
    pending: (testId: string) => ipc().invoke<HealEntry[]>("heals:pending", { testId }),
    /** Apply a heal to the stored test. `locator` overrides the engine's pick. */
    accept: (id: string, locator?: Locator) =>
      ipc().invoke<HealEntry | null>("heals:accept", { id, locator }),
    revert: (id: string) => ipc().invoke<HealEntry | null>("heals:revert", { id }),
    clearSettled: (testId: string) =>
      ipc().invoke<{ removed: number }>("heals:clearSettled", { testId }),
    /** Delete one journal entry. The test itself is left as the heal left it. */
    remove: (id: string) => ipc().invoke<{ removed: number }>("heals:remove", { id }),
    /** Clear settled heals across every test; pending ones are kept. */
    clearAllSettled: () => ipc().invoke<{ removed: number }>("heals:clearAllSettled"),
  },
  /** Whole-script changes — an AI-debug fix, or a hand edit in the Script tab.
   *  The heal journal's sibling; the two are merged in the Heals surfaces. */
  scriptChanges: {
    list: (testId: string) =>
      ipc().invoke<ScriptChangeEntry[]>("scriptChanges:list", { testId }),
    listAll: () => ipc().invoke<ScriptChangeListEntry[]>("scriptChanges:listAll"),
    pending: (testId: string) =>
      ipc().invoke<ScriptChangeEntry[]>("scriptChanges:pending", { testId }),
    /** Keep the change. Status only: the script was written when the entry was
     *  recorded, so unlike a heal there is nothing left to apply. */
    accept: (id: string) =>
      ipc().invoke<ScriptChangeEntry | null>("scriptChanges:accept", { id }),
    /** Write the previous spec back and re-parse the steps from it. */
    revert: (id: string) =>
      ipc().invoke<ScriptChangeEntry | null>("scriptChanges:revert", { id }),
    clearSettled: (testId: string) =>
      ipc().invoke<{ removed: number }>("scriptChanges:clearSettled", { testId }),
    /** Delete one record — and with it the last copy of the previous script. */
    remove: (id: string) => ipc().invoke<{ removed: number }>("scriptChanges:remove", { id }),
    clearAllSettled: () => ipc().invoke<{ removed: number }>("scriptChanges:clearAllSettled"),
  },
  batch: {
    run: (
      testIds: string[],
      opts?: {
        captureArtifacts?: boolean;
        runHeadless?: boolean;
        browser?: RunBrowser;
        datasetIds?: string[];
        allDatasets?: boolean;
        /** How many tests to run at once. Omitted or 1 = one at a time. */
        concurrency?: number;
        /** Per-test engines and headedness from the Batch view's rows. A test
         *  listed here runs once per engine; one omitted falls back to the
         *  batch-wide `browser`/`runHeadless` above. */
        perTest?: { testId: string; browsers: RunBrowser[]; headless: boolean }[];
      },
    ) =>
      ipc().invoke<{ batchId: string; alreadyRunning: boolean }>("batch:run", {
        testIds,
        captureArtifacts: opts?.captureArtifacts,
        runHeadless: opts?.runHeadless,
        browser: opts?.browser,
        datasetIds: opts?.datasetIds,
        allDatasets: opts?.allDatasets,
        concurrency: opts?.concurrency,
        perTest: opts?.perTest,
      }),
    stop: () => ipc().invoke<void>("batch:stop"),
    status: () => ipc().invoke<BatchState | null>("batch:status"),
    list: () => ipc().invoke<BatchRecord[]>("batch:list"),
    get: (batchId: string) => ipc().invoke<BatchRecord | null>("batch:get", { batchId }),
    remove: (batchId: string) => ipc().invoke<{ removed: number }>("batch:delete", { batchId }),
    clearHistory: () => ipc().invoke<{ removed: number }>("batch:clearHistory"),
  },
  /** Saved, named jobs. docs/ROUTINES.md.
   *
   *  `save` RETURNS the stored Routine, and callers should render that rather
   *  than what they sent: the store rebuilds the payload — dropping a step with
   *  no valid engine, collapsing two steps naming one test — so the two can
   *  differ, and the returned one is the job that will actually run. `null`
   *  means nothing usable was in it, or the index is full. */
  routines: {
    list: () => ipc().invoke<Routine[]>("routines:list"),
    get: (id: string) => ipc().invoke<Routine | null>("routines:get", { id }),
    save: (routine: Routine) => ipc().invoke<Routine | null>("routines:save", { routine }),
    remove: (id: string) => ipc().invoke<{ removed: number }>("routines:delete", { id }),
    /** Occurrences missed while the app was closed. REPORTS only — the
     *  renderer offers them, and `runMissed` / `dismissMissed` are the two
     *  answers. Declining still settles the occurrence, or the prompt returns
     *  on every launch forever. */
    missed: () => ipc().invoke<Routine[]>("routines:missed"),
    runMissed: (id: string) =>
      ipc().invoke<{ routineId: string; outcome: string; reason?: string }>("routines:runMissed", {
        id,
      }),
    dismissMissed: (id: string) =>
      ipc().invoke<{ dismissed: boolean }>("routines:dismissMissed", { id }),
    /** Run it. `skipped` lists steps that could not run — a deleted test, or
     *  one with no valid engine — and is a NOTE, not a failure: the batch still
     *  did most of what was asked. A Routine that can run nothing throws
     *  instead, with the sentence saying which kind of nothing. */
    run: (id: string) =>
      ipc().invoke<{
        batchId: string;
        alreadyRunning: boolean;
        skipped: string[];
        plannedRuns: number;
      }>("routines:run", { id }),
  },
  alerts: {
    setWebhookUrl: (url: string) =>
      ipc().invoke<{ hasUrl: boolean; host: string | null }>("alerts:setWebhookUrl", { url }),
    clearWebhookUrl: () =>
      ipc().invoke<{ hasUrl: boolean; host: string | null }>("alerts:clearWebhookUrl"),
    status: () => ipc().invoke<{ hasUrl: boolean; host: string | null }>("alerts:status"),
    test: () => ipc().invoke<{ ok: boolean }>("alerts:test"),
  },
  issues: {
    /** Local and cheap — never touches the network. Pair with `verify` when the
     *  question is "does the key still work?" rather than "is one saved?". */
    status: () => ipc().invoke<ConnectionStatus>("issues:status"),
    /** The provider's own words for its concepts, so views don't hardcode them. */
    vocabulary: () => ipc().invoke<ProviderVocabulary>("issues:vocabulary"),
    /** Every tracker this app can file into, for the settings picker. Carries
     *  each one's vocabulary, so no renderer holds a table of product names. */
    providers: () => ipc().invoke<ProviderChoice[]>("issues:providers"),
    /** Change which tracker issues go to. Resolves with the NEW provider's
     *  status, which is usually a different connection entirely — the caller
     *  has to reload its lists, not patch a name. */
    setActiveProvider: (provider: ProviderId) =>
      ipc().invoke<ConnectionStatus>("issues:setActiveProvider", { provider }),
    /** Save a key and immediately prove it. Resolves with the resulting status
     *  rather than throwing on a bad key — a rejected key is a state the pane
     *  renders, not an exception it catches. */
    connect: (key: string) => ipc().invoke<ConnectionStatus>("issues:connect", { key }),
    verify: () => ipc().invoke<ConnectionStatus>("issues:verify"),
    disconnect: () => ipc().invoke<ConnectionStatus>("issues:disconnect"),
    /** Throws when there is no key or the provider refuses — the caller is a
     *  list that has nothing to show, so the failure has to be visible. */
    listContainers: () => ipc().invoke<IssueContainer[]>("issues:listContainers"),
    /** `containerId` narrows the list where the provider scopes it — GitHub's
     *  milestones and labels are per-repository and it returns nothing without
     *  one, while Linear answers workspace-wide and ignores it. Pass whatever
     *  container is selected; null is a valid "none chosen yet". */
    listSubContainers: (containerId: string | null) =>
      ipc().invoke<IssueSubContainer[]>("issues:listSubContainers", { containerId }),
    listLabels: (containerId: string | null) =>
      ipc().invoke<IssueLabel[]>("issues:listLabels", { containerId }),
    /** The pre-filled issue for one defect. Null when its evidence is gone —
     *  a pruned run, a re-recorded step — which the dialog reports rather than
     *  opening onto an empty form. */
    buildDraft: (source: DefectSource) =>
      ipc().invoke<IssueDraft | null>("issues:buildDraft", { source }),
    /** File it. `attachmentFiles` names which images the user kept; the bytes
     *  are re-read backend-side, so nothing image-shaped travels this way. */
    createIssue: (params: {
      source: DefectSource;
      title: string;
      body: string;
      attachmentFiles: string[];
      containerId: string;
      subContainerId: string | null;
      labelIds: string[];
    }) => ipc().invoke<CreatedIssue>("issues:createIssue", params),
    /** Every issue already filed against a test, so a list badges itself in one
     *  read rather than one call per row. */
    linksForTest: (testId: string) => ipc().invoke<IssueLink[]>("issues:linksForTest", { testId }),
    /** Report a recurrence onto the existing issue instead of filing a second. */
    commentRecurrence: (source: DefectSource, attachmentFiles: string[]) =>
      ipc().invoke<IssueLink>("issues:commentRecurrence", { source, attachmentFiles }),
    getDefaults: () => ipc().invoke<IssueDefaults>("issues:getDefaults"),
    /** Omit a field to leave it alone; pass null to clear it. */
    setDefaults: (patch: Partial<IssueDefaults>) =>
      ipc().invoke<IssueDefaults>("issues:setDefaults", patch),
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
    flake: () => ipc().invoke<FlakeReport>("runs:flake"),
    searchLogs: (query: string) =>
      ipc().invoke<LogSearchResult[]>("runs:searchLogs", { query }),
    resetStats: () => ipc().invoke<{ removed: number }>("runs:resetStats"),
    deleteAll: () => ipc().invoke<{ removed: number }>("runs:deleteAll"),
    deleteRange: (fromMs: number, toMs: number) =>
      ipc().invoke<{ removed: number }>("runs:deleteRange", { fromMs, toMs }),
    logsDir: () => ipc().invoke<string>("runs:logsDir"),
    /** Site or runner, for one failed run. Null when metrics are unavailable or
     *  the run has no rows yet — "no opinion" rather than an error. */
    triage: (id: string) => ipc().invoke<TriageResult | null>("runs:triage", { id }),
    captureOverhead: (testId?: string) =>
      ipc().invoke<CaptureOverheadSummary>("runs:captureOverhead", { testId }),
  },
  /** The metrics views. Every response carries `available`, because "metrics
   *  are off on this runtime" and "you have no history" must not render alike. */
  metrics: {
    stepHealth: (testId?: string) =>
      ipc().invoke<{ available: boolean; rows: StepHealthRow[] }>("metrics:stepHealth", { testId }),
    slowness: (testId?: string) =>
      ipc().invoke<{
        available: boolean;
        rows: StepDurationRow[];
        slowed: StepDurationRow[];
        cost: CostBreakdown;
        /** The named test's own duration trend (C §6.3). Null when no test was
         *  named — the suite-wide call has no single test to trend. */
        testTrend: TestDurationTrend | null;
      }>("metrics:slowness", { testId }),
    divergence: (testId?: string) =>
      ipc().invoke<{ available: boolean; steps: DivergentStep[] }>("metrics:divergence", {
        testId,
      }),
  },
  artifacts: {
    list: () => ipc().invoke<RunReplaySummary[]>("artifacts:list"),
    getReplay: (testId: string, runId: string) =>
      ipc().invoke<RunReplay | null>("artifacts:getReplay", { testId, runId }),
    /** Wave off one of a run's findings banners. Unlike the accept calls, this
     *  changes nothing about the finding or about future runs — it records that
     *  the user has seen it, on this run only. */
    dismissNotice: (testId: string, runId: string, kind: RunNoticeKind) =>
      ipc().invoke<RunReplay | null>("artifacts:dismissNotice", { testId, runId, kind }),
    restoreNotice: (testId: string, runId: string, kind: RunNoticeKind) =>
      ipc().invoke<RunReplay | null>("artifacts:restoreNotice", { testId, runId, kind }),
    readShot: (testId: string, runId: string, file: string) =>
      ipc().invoke<string | null>("artifacts:readShot", { testId, runId, file }),
    /** Recorded console + network for one run (null when it recorded none).
     *  Secrets are redacted backend-side before this returns. */
    getLogs: (testId: string, runId: string) =>
      ipc().invoke<RunLogs | null>("artifacts:getLogs", { testId, runId }),
    hasLogs: (testId: string, runId: string) =>
      ipc().invoke<{ hasLogs: boolean }>("artifacts:hasLogs", { testId, runId }),
    /** The page structure Auto-Heal recorded around steps it could not rescue.
     *  Rebuilt from page-authored input backend-side before this returns. */
    getStructure: (testId: string, runId: string) =>
      ipc().invoke<StepStructure[]>("artifacts:getStructure", { testId, runId }),
    hasStructure: (testId: string, runId: string) =>
      ipc().invoke<{ hasStructure: boolean }>("artifacts:hasStructure", { testId, runId }),
    usage: () => ipc().invoke<ArtifactUsage>("artifacts:usage"),
    pruneNow: () => ipc().invoke<RetentionResult>("artifacts:pruneNow"),
  },
  // REDESIGN §6.5. A verb, not a getter — there is deliberately no channel that
  // returns the emitted text. See `main/services/report-emitter.ts`.
  report: {
    emit: (emitter: EmitterId, stamp: string, testId?: string) =>
      ipc().invoke<EmitResult>("report:emit", { emitter, stamp, testId }),
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
    /** Whether a request is still streaming — used to re-adopt a session after
     *  a renderer reload without stranding it as permanently "thinking". */
    isActive: (requestId: string) =>
      ipc().invoke<{ active: boolean }>("llm:isActive", { requestId }),
    // Anthropic API key management (key stays backend-side).
    setApiKey: (key: string) => ipc().invoke<{ hasKey: boolean }>("llm:setApiKey", { key }),
    clearApiKey: () => ipc().invoke<{ hasKey: boolean }>("llm:clearApiKey"),
    hasApiKey: () => ipc().invoke<{ hasKey: boolean }>("llm:hasApiKey"),
    // LM Studio API token (token stays backend-side, same as the Anthropic key).
    setLmStudioToken: (token: string) =>
      ipc().invoke<{ hasToken: boolean }>("llm:setLmStudioToken", { token }),
    clearLmStudioToken: () => ipc().invoke<{ hasToken: boolean }>("llm:clearLmStudioToken"),
    hasLmStudioToken: () => ipc().invoke<{ hasToken: boolean }>("llm:hasLmStudioToken"),
  },
  /** Persisted AI debug sessions. The stream itself never survives a restart —
   *  only its output does; see main/services/ai-debug-store.ts. */
  aiDebug: {
    list: () => ipc().invoke<AiDebugSession[]>("aiDebug:list"),
    save: (session: AiDebugSession) =>
      ipc().invoke<AiDebugSession | null>("aiDebug:save", { session }),
    remove: (key: string) => ipc().invoke<{ removed: number }>("aiDebug:remove", { key }),
    clear: () => ipc().invoke<{ removed: number }>("aiDebug:clear"),
    /** Fire-and-forget: the backend gates on notifyOnAiDebugDone itself. */
    notifyDone: (p: { testName: string; status: "done" | "error" }) =>
      ipc().invoke<{ ok: boolean }>("aiDebug:notifyDone", p),
  },
  /** The branch switcher — a testing tool for whoever is building this app.
   *
   *  Every call here is gated on `status().available`, which is false in the
   *  browser preview and in a packaged build. Nothing in this namespace has a
   *  degraded mode: there is no way to check out a branch without a backend. */
  branches: {
    status: () => ipc().invoke<BranchStatus>("branches:status"),
    listPulls: () => ipc().invoke<PullRequestSummary[]>("branches:listPulls"),
    listBranches: (refresh = false) =>
      ipc().invoke<BranchSummary[]>("branches:listBranches", { refresh }),
    /** Resolves as the app is about to relaunch — so a caller should expect the
     *  window to disappear rather than expect to render a success state. */
    switch: (branch: string) => ipc().invoke<{ appPath: string }>("branches:switch", { branch }),
    home: () => ipc().invoke<{ appPath: string }>("branches:home"),
    setToken: (token: string) => ipc().invoke<{ hasToken: boolean }>("branches:setToken", { token }),
    clearToken: () => ipc().invoke<{ hasToken: boolean }>("branches:clearToken"),
  },
  /** What the Documentation pane cannot read out of a document: where this
   *  install's MCP server actually is. `exists` is answered from disk rather
   *  than assumed, because the server is part of the SOURCE tree and a packaged
   *  build does not carry it — see `main/services/mcp-install.ts`. */
  docs: {
    mcpServer: () =>
      ipc().invoke<{ path: string | null; exists: boolean; command: string }>("docs:mcpServer"),
  },
  /** Subscribe to a backend push event. Returns an unsubscribe function. */
  on<T>(channel: string, cb: (payload: T) => void): () => void {
    return ipc().on(channel, (...args: unknown[]) => cb(args[1] as T));
  },
};
