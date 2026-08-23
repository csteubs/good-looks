/**
 * Handler Registration
 *
 * Register all your IPC handlers here
 */

import * as path from "path";
import { fileURLToPath } from "url";

import { appHandlers } from "./app.js";
import { getSettingsWindow, openSettingsWindow } from "../windows/settings-window.js";
import {
  dock as dockTrainerPanel,
  getTrainerPanelDockState,
  isTrainerPanelDocked,
  undock as undockTrainerPanel,
} from "../windows/trainer-panel-window.js";
import { mcpServerInfo } from "../services/mcp-install.js";
import { recorderService } from "../services/recorder-service.js";
import { batchRunner } from "../services/batch-runner.js";
import { batchHistoryStore } from "../services/batch-history-store.js";
import { routineStore } from "../services/routine-store.js";
import { routineScheduler } from "../services/routine-scheduler.js";
import { failurePolicy, routineBlockedReason, routineRunPlan } from "../../shared/routine-plan.mjs";
import { webhookUrlStore } from "../services/webhook-url-store.js";
import { postWebhook } from "../services/alert-service.js";
import { issueTrackerService } from "../services/issue-tracker/issue-tracker-service.js";
import { isProviderId } from "../services/issue-tracker/provider-registry.js";
import { openTrace, playwrightRunner } from "../services/playwright-runner.js";
import { runHistoryStore } from "../services/run-history-store.js";
import { emitReport } from "../services/report-emitter.js";
import { artifactStore } from "../services/artifact-store.js";
import { baselineStore } from "../services/baseline-store.js";
import { acceptRunBaseline, acceptStepBaseline } from "../services/visual-baseline-ops.js";
import {
  acceptRuleA11y,
  acceptRunA11y,
  acceptStepA11y,
  resetA11yBaseline,
  revokeA11yRule,
} from "../services/a11y-baseline-ops.js";
import { rollupA11y, selectLatestA11yRuns } from "../../shared/a11y-rollup.mjs";
import {
  dismissRunNotice,
  isRunNoticeKind,
  restoreRunNotice,
} from "../services/run-notice-ops.js";
import { sendToMain } from "../services/app-window.js";
import { applyUiScaleToAllWindows } from "../services/ui-scale.js";
import { annotationStore } from "../services/annotation-store.js";
import { testStore } from "../services/test-store.js";
import { bindFlowStep, flowCallBindings } from "../services/script-generator.js";
import { duplicateTest } from "../services/duplicate-test.js";
import { importService } from "../services/import-service.js";
import { importDatasetCsvFile } from "../services/dataset-csv.js";
import { stageUploadFile } from "../services/upload-store.js";
import { clearSessionState, sessionStateInfo } from "../services/session-state-store.js";
import { normalizeBaseUrl } from "../services/imported-config.js";
import {
  DEFAULT_ORIGIN_VARIABLE,
  originOf,
  originsIn,
  parameteriseOrigin,
} from "../services/origin-variable.js";
import { testSecretsStore } from "../services/test-secrets-store.js";
import { healJournalStore } from "../services/heal-journal-store.js";
import {
  normalizeScriptChangeOrigin,
  scriptChangeStore,
  type ScriptChangeJournal,
} from "../services/script-change-store.js";
import { refreshSecretSnapshot } from "../services/secret-redaction.js";
import { shopifySignatureStore } from "../services/shopify-signature-store.js";
import { parseSpecDetailed } from "../services/spec-parser.js";
import { checkTestScript } from "../services/script-check.js";
import { livePageService } from "../services/live-page-service.js";
import { tsService } from "../services/ts-service/client.js";
import { glazeRuntimeSource } from "../services/glaze-runtime-source.js";
import { SCRIPT_CHANGED_ON_DISK } from "../../shared/script-save.mjs";
import { activeProviderEndpoint, llmService } from "../services/llm-service.js";
import { proxyPasswordStore } from "../services/proxy-password-store.js";
import {
  refreshProxy,
  verifyAppConnectivity,
  verifyTestConnectivity,
} from "../services/proxy-service.js";
import { llmConfigStore, type LlmConfigPatch } from "../services/llm-config-store.js";
import { aiDebugStore } from "../services/ai-debug-store.js";
import { aiDebugHistoryStore } from "../services/ai-debug-history-store.js";
import { recorderDebugStore } from "../services/recorder-debug-store.js";
import { anthropicKeyStore } from "../services/anthropic-key-store.js";
import { lmStudioTokenStore } from "../services/lm-studio-token-store.js";
import { branchSwitcher } from "../services/branch-switcher.js";
import {
  clampTestTimeoutMs,
  isTestTimeoutMs,
  MAX_TEST_TIMEOUT_MS,
  MIN_TEST_TIMEOUT_MS,
  recorderSettingsStore,
} from "../services/recorder-settings-store.js";
import { notifyAiDebugOutcome } from "../services/ai-debug-notifier.js";
import { insightReportStore } from "../services/insight-report-store.js";
import { insightsService } from "../services/insights/insights-service.js";
import { insightsSlackUrlStore } from "../services/insights/insights-slack-url-store.js";
import { exportInsightReportPdf } from "../services/insight-report-pdf.js";
import { summarizeCaptureOverhead } from "../services/capture-overhead.js";
import { applyRetention } from "../services/retention.js";
import { compareRuns } from "../services/run-comparison.js";
import { analyseFlake } from "../services/flake-analysis.js";
import { metricsStore } from "../services/metrics-store.js";
import { failureReasonStore } from "../services/failure-reason-store.js";
import * as overlayRuleStore from "../services/overlay-rule-store.js";
import { DEFAULT_FAILURE_REASONS, resolveFailureReason } from "../../shared/failure-reasons.mjs";
import {
  stepBrowserMatrix,
  stepDurations,
  testDurationTrend,
  stepHealth,
  suiteCost,
} from "../../shared/metrics-query.mjs";
import { costBreakdown, divergentSteps, slowdowns } from "../../shared/step-insights.mjs";
import {
  captureWindows,
  debugDir,
  DEBUG_CAPTURE_ACCELERATOR,
  newCaptureId,
  syncRequestWatcher,
} from "../services/debug-capture.js";
import { ANALYSIS_WINDOW, analysisWindow, gatherRunDetails } from "../services/flake-source.js";
import {
  clampBatchConcurrency,
  DEFAULT_VISUAL_THRESHOLD,
  isRunBrowser,
  isTestSpeed,
  isValidVariableName,
  MAX_BATCH_TEST_OPTIONS,
  normalizeDatasets,
  buildStepStructures,
  normalizeLocator,
  normalizeStep,
  normalizeGroup,
  normalizeTags,
  normalizeVariables,
  RUN_BROWSERS,
} from "../recorder/types.js";
import type { AiDebugSession, AssertKind, CookieSpec, Locator, RawStep, RecorderSettings, RunBrowser, Step, TestRecord, TestSpeed, VisualMask } from "../recorder/types.js";
import type { LlmRole, LlmConfig, LlmMessage, LlmProvider } from "../services/llm/types.js";
import type { EmitterId } from "../../shared/emitters.mjs";

import { ipcMain, logger } from "@shell/backend";

/** A role name off the wire, or undefined — the service then resolves chat. */
function asRole(v: unknown): LlmRole | undefined {
  return v === "chat" || v === "instant" || v === "autocomplete" ? v : undefined;
}

function asProvider(v: unknown): LlmProvider {
  if (v === "ollama" || v === "lmstudio" || v === "anthropic") return v;
  throw new Error("Invalid LLM provider: " + String(v));
}

function asMessages(v: unknown): LlmMessage[] {
  if (!Array.isArray(v)) throw new Error("messages must be an array");
  return v.map((m) => {
    const role = (m as { role?: unknown })?.role;
    const content = (m as { content?: unknown })?.content;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new Error("Invalid message role: " + String(role));
    }
    if (typeof content !== "string") throw new Error("Message content must be a string");
    return { role, content };
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function registerHandlers(): void {
  logger.info("handlers", "Registering IPC handlers...");

  // Register app handlers using ipcMain API
  ipcMain.handle("app:getInfo", async (_event) => {
    return await appHandlers.getInfo();
  });

  // Return the .glaze project path (used for deep links back to the host)
  // __dirname = build/main, so two levels up is the app root
  ipcMain.handle("app:getProjectPath", async () => {
    return path.join(__dirname, "..", "..");
  });

  // Settings window handlers
  // `pane` is optional and deep-links a FRESH window onto one pane — see
  // `openSettingsWindow`, which validates it before it reaches a URL.
  ipcMain.handle("window:openSettings", async (_event, pane?: string) => {
    await openSettingsWindow(pane);
  });

  ipcMain.handle("window:closeSettings", async (_event) => {
    getSettingsWindow()?.close();
  });

  // Where this install's MCP server is. Read-only, and it answers "not here"
  // rather than throwing — the pane renders both outcomes.
  ipcMain.handle("docs:mcpServer", async () => mcpServerInfo());

  // ── Recorder handlers ───────────────────────────────────────────────
  ipcMain.handle(
    "recorder:start",
    async (
      _e,
      params: {
        url: string;
        name?: string;
        testId?: string;
        viewport?: { width: number; height: number } | null;
        runBrowser?: RunBrowser;
      },
    ) => recorderService.start(params),
  );
  ipcMain.handle("recorder:pause", async () => recorderService.pause());
  ipcMain.handle("recorder:resume", async () => recorderService.resume());
  ipcMain.handle(
    "recorder:setAssert",
    async (_e, params: { mode: AssertKind | null; soft?: boolean }) =>
      recorderService.setAssertMode(params?.mode ?? null, !!params?.soft),
  );
  ipcMain.handle("recorder:deleteStep", async (_e, params: { stepId: string }) =>
    recorderService.deleteStep(params.stepId),
  );
  ipcMain.handle("recorder:insertStep", async (_e, params: { step: RawStep; index?: number }) =>
    recorderService.insertStep(params.step, params.index),
  );
  ipcMain.handle(
    "recorder:reorderStep",
    async (_e, params: { stepId: string; toIndex: number }) =>
      recorderService.reorderStep(params.stepId, params.toIndex),
  );
  ipcMain.handle(
    "recorder:updateStep",
    async (_e, params: { stepId: string; patch: Partial<Step> }) =>
      recorderService.updateStep(params.stepId, params.patch),
  );
  // Declare a variable mid-session. Unvalidated on this side on purpose: the
  // service throws a message the trainer shows verbatim, and duplicating the
  // rule here is how the two would come to disagree about what a valid name is.
  ipcMain.handle(
    "recorder:addVariable",
    async (_e, params: { name: unknown; kind?: unknown; value?: unknown }) =>
      recorderService.addVariable(params ?? { name: undefined }),
  );
  // Extract selected session steps into a new flow test. Unvalidated on this
  // side for the reason addVariable is: the service throws sentences the
  // trainer's dialog shows verbatim, from the same shared rule the button used.
  ipcMain.handle(
    "recorder:extractFlow",
    async (_e, params: { stepIds: unknown; name: unknown }) =>
      recorderService.extractFlow(params?.stepIds, params?.name),
  );
  // Inline flow editing: open a runFlow row's flow for recording, commit and
  // close it, and move the insert cursor within it.
  ipcMain.handle("recorder:enterFlowScope", async (_e, params: { stepId: unknown }) =>
    recorderService.enterFlowScope(params?.stepId),
  );
  ipcMain.handle("recorder:exitFlowScope", async () => recorderService.exitFlowScope());
  ipcMain.handle("recorder:setFlowCursor", async (_e, params: { index: number }) =>
    recorderService.setFlowCursor(Number(params?.index) || 0),
  );
  ipcMain.handle(
    "recorder:applyHeal",
    async (_e, params: { stepId: string; locator: Locator }) =>
      recorderService.applyHeal(params.stepId, params.locator),
  );
  ipcMain.handle("recorder:setCursor", async (_e, params: { index: number }) =>
    recorderService.setCursor(params.index),
  );
  // AI-proposed steps, run against the live page one at a time and inserted
  // only once each has actually worked. `steps` is `unknown[]` on purpose: it
  // came from a model, and the service normalizes it through the same boundary
  // every other arrival goes through.
  ipcMain.handle(
    "recorder:verifySteps",
    async (_e, params: { steps: unknown[]; label?: unknown }) =>
      recorderService.verifyAndInsertSteps(
        Array.isArray(params?.steps) ? params.steps : [],
        typeof params?.label === "string" && params.label.trim() ? params.label.trim() : undefined,
      ),
  );
  ipcMain.handle("recorder:replayStep", async (_e, params: { stepId: string }) =>
    recorderService.replayStep(params.stepId),
  );
  ipcMain.handle("recorder:replayFromStart", async () => recorderService.replayFromStart());
  ipcMain.handle("recorder:replayAll", async () => recorderService.replayAll());
  ipcMain.handle("recorder:replayFromCurrent", async (_e, params: { startIndex: number }) =>
    recorderService.replayFromCurrent(params.startIndex),
  );
  ipcMain.handle("recorder:getDebugLogs", async (_e, params: { testId: string }) =>
    recorderService.getDebugLogs(params.testId),
  );
  ipcMain.handle("recorder:clearDebugLog", async (_e, params: { stepId: string }) =>
    recorderService.clearDebugLog(params.stepId),
  );
  // ── Live cookies in the trainer ─────────────────────────────────────
  // Act on the training browser's session immediately. Recording a cookie
  // change as a test step is separate (recorder:insertStep with a cookie step).
  ipcMain.handle("recorder:listCookies", async () => recorderService.listCookies());
  ipcMain.handle("recorder:setCookie", async (_e, params: { cookie: CookieSpec }) => {
    await recorderService.setCookie(params.cookie);
    return recorderService.listCookies();
  });
  ipcMain.handle("recorder:deleteCookie", async (_e, params: { cookie: CookieSpec }) => {
    await recorderService.deleteCookie(params.cookie);
    return recorderService.listCookies();
  });
  ipcMain.handle("recorder:clearCookies", async () => {
    await recorderService.clearCookies();
    return recorderService.listCookies();
  });

  // The training browser's URL strip: read the live URL, and open a URL
  // assertion prefilled with it. Both are called from `recorder-chrome.html`,
  // which runs in a view inside the training browser rather than in a window.
  ipcMain.handle("recorder:getTrainingUrl", async () => recorderService.getTrainingUrl());
  ipcMain.handle("recorder:assertUrl", async (_e, params: { kind: AssertKind }) =>
    recorderService.assertUrl(params.kind),
  );
  ipcMain.handle("recorder:startRefine", async () => recorderService.startRefine());
  ipcMain.handle("recorder:endRefine", async () => recorderService.endRefine());
  // The element-context picker's live readout. `params` is page-derived data
  // that came out to the renderer and is going back in, so it is normalized on
  // the way through like any other IPC-borne locator — see `countMatches`.
  ipcMain.handle("recorder:countMatches", async (_e, params: { locator?: unknown }) =>
    recorderService.countMatches(params?.locator),
  );
  ipcMain.handle("recorder:stop", async () => {
    recorderService.stop();
  });
  ipcMain.handle("recorder:discardExit", async () => {
    recorderService.discardExit();
  });
  ipcMain.handle("recorder:getState", async () => recorderService.getState());
  ipcMain.handle("recorder:getSteps", async () => recorderService.getSteps());
  // Trainer panel docking. Dock state lives in the backend because it moves
  // real windows and docking can be REFUSED (a display too small to hold both);
  // the panel reflects what actually happened rather than assuming it worked.
  ipcMain.handle("trainerPanel:dock", async () => {
    dockTrainerPanel();
    return { docked: isTrainerPanelDocked() };
  });
  ipcMain.handle("trainerPanel:undock", async () => {
    undockTrainerPanel("user");
    return { docked: isTrainerPanelDocked() };
  });
  // The panel's FIRST dock state cannot arrive by push: it is decided while the
  // panel window is still loading its page, so the `trainerPanel:undocked` that
  // announces a refused dock is emitted into a renderer that does not exist yet.
  // Asking on mount is the only way a panel that opened undocked can know.
  ipcMain.handle("trainerPanel:getState", async () => getTrainerPanelDockState());

  ipcMain.handle("recorder:getSettings", async () => recorderSettingsStore.get());
  ipcMain.handle(
    "recorder:setSettings",
    async (_e, params: Partial<RecorderSettings>) => {
      const next = recorderSettingsStore.set(params ?? {});
      // Bring the debug watcher into line immediately. Deferring to the next
      // launch would make the toggle look broken to the person who just used it.
      syncRequestWatcher();
      // Same immediacy for the proxy: the cached app-traffic dispatchers and
      // the default session's rules embed these settings, so they refresh the
      // moment any proxy key changes. Fire-and-forget with its own logging —
      // a settings save must not fail because Chromium was slow to re-point.
      if (
        params &&
        ("proxyTraffic" in params ||
          "proxySource" in params ||
          "proxyUrl" in params ||
          "proxyUsername" in params ||
          "proxySslVerify" in params)
      ) {
        void refreshProxy();
      }
      // The same argument, twice more, for the two appearance settings.
      //
      // Zoom is applied here in the backend because that is the only place it
      // exists; the typeface is a renderer concern, so it goes out as a push.
      // Both are broadcast unconditionally rather than only when the value
      // changed — the patch is a partial and comparing it against the previous
      // settings to decide would be more code than re-applying an identical
      // number, which costs nothing.
      applyUiScaleToAllWindows();
      sendToMain("settings:appearanceChanged", {
        uiScale: next.uiScale,
        uiTypeface: next.uiTypeface,
      });
      // And the same argument once more, for everything else on this object.
      //
      // THE MAIN WINDOW CANNOT NOTICE THIS ON ITS OWN. It reads settings
      // through react-query, whose focus refetch listens to `visibilitychange`
      // only — and moving between two BrowserWindows of the same app never
      // changes a window's visibility. The views that appeared to stay fresh
      // were getting it from remount on route change; Stats does not, because
      // Stats is the view the user is standing on while they correct the CI
      // price in the other window. Payload-free on purpose: the listener
      // re-fetches, so there stays exactly one path from stored settings to
      // rendered ones.
      sendToMain("settings:changed", null);
      return next;
    },
  );

  // ── Test library handlers ───────────────────────────────────────────
  ipcMain.handle("tests:list", async () => testStore.list());
  ipcMain.handle("tests:get", async (_e, params: { id: string }) => testStore.get(params.id));
  ipcMain.handle("tests:getScript", async (_e, params: { id: string }) =>
    testStore.readScript(params.id),
  );
  // Delete a test and everything it left behind.
  //
  // The line this draws: anything that NAMES the test goes, and anything that
  // holds its CONTENT goes. What stays is the arithmetic — run records survive
  // as tombstones (`RunRecord.testDeleted`) so the pass rate, the daily chart
  // and the capture-overhead figures don't lurch when a test is removed. Those
  // numbers answer "what has this machine done", and having them rewrite
  // history on a delete is what makes people stop trusting them.
  //
  // Adding a per-test store? It belongs in this list. A store that isn't here
  // fails silently: nothing errors, the test is gone from the library, and its
  // leftovers surface weeks later under a name nobody recognises.
  ipcMain.handle("tests:delete", async (_e, params: { id: string }) => {
    // A test other tests still CALL cannot be deleted — their specs inline its
    // steps, and the day after the delete every one of them regenerates with a
    // "flow not found" comment where the steps were. Blocked with the caller
    // names rather than cascaded: silently rewriting N other tests on a delete
    // is a bigger surprise than a refusal. Unwrap or remove the calls first.
    const callers = testStore.callersOf(params.id);
    if (callers.length > 0) {
      const names = callers.map((t) => `“${t.name}”`).join(", ");
      throw new Error(
        `This test is used as a flow by ${callers.length === 1 ? "" : `${callers.length} tests: `}${names}. ` +
          "Remove or unwrap those flow calls first.",
      );
    }
    testStore.remove(params.id);
    // Drop any captured visual-testing artifacts + pinned baselines for this test.
    artifactStore.deleteTest(params.id);
    baselineStore.deleteTest(params.id);
    annotationStore.deleteTest(params.id);
    // Deleting a test must not leave its credentials encrypted on disk forever
    // with nothing left in the UI to remove them with.
    await testSecretsStore.clearTest(params.id);
    await refreshSecretSnapshot();
    healJournalStore.deleteTest(params.id);
    scriptChangeStore.deleteTest(params.id);
    // Tombstone the history: records kept for the aggregates, raw logs deleted.
    runHistoryStore.markTestDeleted(params.id);
    batchHistoryStore.markTestDeleted(params.id);
    // A saved Routine keeps the step and shows it broken, rather than losing
    // it: silently shrinking a job somebody built is the same class of bug as
    // the batch running fewer tests than it said. Unlike the Batch settings
    // below, this is not housekeeping — the step stays until the user removes
    // it. See ROUTINES.md open question 4.
    routineStore.markTestDeleted(params.id);
    // Really deleted — the model's answers quote the script and the run output,
    // and with the test gone there is no route left to reach or remove them.
    aiDebugStore.deleteTest(params.id);
    // The HISTORY of those sessions is tombstoned instead, like run records
    // directly above: it holds no quotes, only the fact that a diagnosis
    // happened and what it cost. Deleting it would make every lifetime total on
    // the Stats board walk backwards when a test is removed.
    aiDebugHistoryStore.markTestDeleted(params.id);
    recorderDebugStore.clear(params.id);
    // Stale ids in the Batch view's stored order and per-row options. Both
    // tolerate an unknown id, so this is housekeeping rather than a fix — but
    // without it a re-imported test could inherit a choice nobody remembers.
    const settings = recorderSettingsStore.get();
    const batchOrder = settings.batchOrder.filter((id) => id !== params.id);
    const batchTestOptions = { ...settings.batchTestOptions };
    delete batchTestOptions[params.id];
    if (batchOrder.length !== settings.batchOrder.length || params.id in settings.batchTestOptions) {
      recorderSettingsStore.set({ batchOrder, batchTestOptions });
    }
    // Stats and Stability read run history, not the library, so without this
    // they keep showing the deleted test until something else invalidates them.
    sendToMain("runs:changed", {});
  });
  // Copy a test: everything that describes it, nothing it has recorded.
  //
  // The record's own split lives in `duplicate-test.ts` behind an allowlist.
  // Secrets are copied HERE rather than there, for the same reason the delete
  // handler clears them here: the secret store is async and every write to it
  // has to be followed by refreshing the redaction snapshot, or the copy's
  // password is a value redaction has never been told about and it reaches the
  // next run log in plaintext.
  ipcMain.handle("tests:duplicate", async (_e, params: { id: string }) => {
    const rec = duplicateTest(params.id);
    await testSecretsStore.copyTest(params.id, rec.id);
    await refreshSecretSnapshot();
    return rec;
  });

  ipcMain.handle("tests:rename", async (_e, params: { id: string; name: string }) => {
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    rec.name = params.name.trim() || rec.name;
    rec.updatedAt = Date.now();
    // A hand-edited script is no longer regenerated from steps, so a rename
    // must not clobber it — just update the title metadata.
    if (!rec.scriptEdited) {
      rec.scriptPath = testStore.regenerateScript(rec);
    }
    testStore.save(rec);
    return rec;
  });

  ipcMain.handle("tests:setSpeed", async (_e, params: { id: string; speed: unknown }) => {
    const speed = params.speed;
    // Derived from TEST_SPEEDS rather than spelled out, so a speed added to the
    // union can never be accepted by the settings store and rejected here.
    if (!isTestSpeed(speed)) {
      throw new Error("Invalid speed: " + String(speed));
    }
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    rec.speed = speed;
    rec.updatedAt = Date.now();
    testStore.save(rec);
    return rec;
  });

  // Persist the per-test "Capture screenshots" toggle so it's remembered
  // between sessions. Absent → use the global default from RecorderSettings.
  ipcMain.handle(
    "tests:setCaptureArtifacts",
    async (_e, params: { id: string; captureArtifacts: boolean }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      rec.captureArtifacts = params.captureArtifacts;
      rec.updatedAt = Date.now();
      testStore.save(rec);
      return rec;
    },
  );

  // Per-test "Record console & network" toggle. Kept separate from the capture
  // toggle on purpose: this one persists page-controlled text and request URLs.
  ipcMain.handle(
    "tests:setRecordLogs",
    async (_e, params: { id: string; recordLogs: boolean }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      rec.recordLogs = params.recordLogs;
      rec.updatedAt = Date.now();
      testStore.save(rec);
      return rec;
    },
  );

  // Per-test "Run headless" preference, remembered between sessions. Absent →
  // use the global default from RecorderSettings. Only affects test runs.
  ipcMain.handle(
    "tests:setHeadless",
    async (_e, params: { id: string; runHeadless: boolean }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      rec.runHeadless = params.runHeadless;
      rec.updatedAt = Date.now();
      testStore.save(rec);
      return rec;
    },
  );

  // Per-test browser-engine preference, remembered between sessions. Absent →
  // use the global default from RecorderSettings. Only affects test runs; the
  // trainer uses the app's own WebView.
  ipcMain.handle("tests:setBrowser", async (_e, params: { id: string; runBrowser: string }) => {
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    if (!isRunBrowser(params.runBrowser)) {
      throw new Error("Unknown browser: " + params.runBrowser);
    }
    rec.runBrowser = params.runBrowser;
    rec.updatedAt = Date.now();
    testStore.save(rec);
    return rec;
  });

  // Per-test Playwright timeout override. null clears the override so the
  // global Settings default applies again. Absent on the record means the same.
  ipcMain.handle(
    "tests:setTestTimeout",
    async (_e, params: { id: string; testTimeoutMs: number | null }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      if (params.testTimeoutMs === null || params.testTimeoutMs === undefined) {
        delete rec.testTimeoutMs;
      } else if (isTestTimeoutMs(params.testTimeoutMs)) {
        rec.testTimeoutMs = clampTestTimeoutMs(params.testTimeoutMs);
      } else {
        throw new Error(
          "Invalid test timeout: " +
            String(params.testTimeoutMs) +
            " (expected ms between " +
            MIN_TEST_TIMEOUT_MS +
            " and " +
            MAX_TEST_TIMEOUT_MS +
            ")",
        );
      }
      rec.updatedAt = Date.now();
      testStore.save(rec);
      return rec;
    },
  );

  // The base URL an imported spec's relative navigations resolve against. null
  // clears it, which is also what a record without one means.
  //
  // Validated here rather than trusted: this arrives as `unknown` from the
  // renderer like everything else, and it ends up in the environment of a
  // Playwright process. `normalizeBaseUrl` is the same gate the config parser
  // hands its findings through, so a value typed in and a value read off disk
  // are held to one standard.
  ipcMain.handle("tests:setBaseUrl", async (_e, params: { id: string; baseUrl: string | null }) => {
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    const raw = params.baseUrl;
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
      delete rec.baseUrl;
    } else {
      const normalized = normalizeBaseUrl(raw);
      if (!normalized) {
        throw new Error(
          "Invalid base URL: " + String(raw) + " (expected a full http:// or https:// address)",
        );
      }
      rec.baseUrl = normalized;
    }
    rec.updatedAt = Date.now();
    testStore.save(rec);
    return rec;
  });

  // Per-test grouping labels. The backend normalizes (trim/dedupe/cap/sort) so
  // there's one source of truth — the renderer posts raw strings and renders
  // whatever comes back.
  ipcMain.handle("tests:setTags", async (_e, params: { id: string; tags: unknown }) => {
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    rec.tags = normalizeTags(params.tags);
    rec.updatedAt = Date.now();
    testStore.save(rec);
    return rec;
  });

  // Delete a tag from the whole library at once. Deliberately NOT a renderer
  // loop over `tests:setTags`: that rewrites tests.json once per test and can
  // strand the tag on half of them if one call fails partway through.
  //
  // The incoming name goes through `normalizeTags` too, so canonical form still
  // has exactly one definition — a renderer that sent a number or an untrimmed
  // string can't reach the store with it.
  ipcMain.handle("tests:deleteTag", async (_e, params: { tag: unknown }) => {
    const [tag] = normalizeTags([params?.tag]);
    if (!tag) throw new Error("A tag is required.");
    return { tag, removed: testStore.removeTag(tag) };
  });

  // Which folder a test lives in, in the library rail (REDESIGN §7.2).
  // Normalized backend-side like the tags above, so "what is a valid group
  // name" has exactly one definition. An empty result UNGROUPS rather than
  // erroring: "move to no group" is a thing the menu offers, and the rail
  // draws groups from the names its tests carry — a name it cannot render
  // would be a test that disappeared from the list.
  ipcMain.handle("tests:setGroup", async (_e, params: { id: string; group: unknown }) => {
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    const group = normalizeGroup(params.group);
    // Deleted rather than stored empty, so "ungrouped" is one condition
    // everywhere — see `renameGroup`.
    if (group) rec.group = group;
    else delete rec.group;
    rec.updatedAt = Date.now();
    testStore.save(rec);
    return rec;
  });

  // Rename a group across the whole library at once. Deliberately NOT a
  // renderer loop over `tests:setGroup`, for the reason `tests:deleteTag` is
  // not one: that rewrites tests.json once per test and can strand half the
  // library under the old name, which the rail would draw as two folders.
  //
  // `to: ""` is how the group is DELETED — there is no group record to remove,
  // so deleting one is moving its members to the top level.
  ipcMain.handle(
    "tests:renameGroup",
    async (_e, params: { from: unknown; to: unknown }) => {
      const from = normalizeGroup(params?.from);
      if (!from) throw new Error("A group is required.");
      const to = normalizeGroup(params?.to);
      return { from, to, changed: testStore.renameGroup(from, to) };
    },
  );

  // ── Variables, secrets and datasets ──────────────────────────────────────
  //
  // Normalization is backend-only, matching tests:setTags: the renderer posts
  // raw input and renders whatever comes back, so the two sides cannot disagree
  // about what a valid variable name is. That matters more here than for tags —
  // a name that isn't a JS identifier would emit a spec that doesn't parse.
  /**
   * Turn a test's baked-in site address into a variable it can be re-pointed by.
   *
   * BACKEND-ONLY, and atomic on purpose. The rewrite touches both the steps and
   * the variables, and the spec is regenerated from the pair — doing it as two
   * IPC calls from the renderer would leave a window where the steps reference
   * `${SITE_URL}` and nothing declares it, which generates a spec that navigates
   * to the literal text `${SITE_URL}/cart`.
   *
   * The origin is REBUILT through `originOf` rather than trusted: it arrives
   * from the renderer and ends up as a variable value in generated source.
   */
  ipcMain.handle(
    "tests:parameteriseOrigin",
    async (_e, params: { id: string; origin: unknown; name?: unknown }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      // A hand-edited script is the source of truth and is never regenerated,
      // so rewriting the steps would silently change nothing that runs. Refuse
      // rather than report a rewrite the run will not honour.
      if (rec.scriptEdited) {
        throw new Error(
          "This test's script has been edited by hand, so its steps no longer drive the run. Edit the script directly.",
        );
      }
      const origin = typeof params.origin === "string" ? originOf(params.origin) : null;
      if (!origin || origin !== params.origin) {
        throw new Error("That is not a site address this can rewrite.");
      }
      const name =
        typeof params.name === "string" && params.name.trim()
          ? params.name.trim()
          : DEFAULT_ORIGIN_VARIABLE;
      const out = parameteriseOrigin(rec.steps, rec.variables ?? [], origin, name);
      if (out.rewritten === 0) {
        throw new Error(`Nothing in this test points at ${origin}.`);
      }
      rec.steps = out.steps;
      rec.variables = out.variables;
      rec.updatedAt = Date.now();
      rec.scriptPath = testStore.regenerateScript(rec);
      testStore.save(rec);
      return { test: rec, rewritten: out.rewritten, reusedVariable: out.reusedVariable, name };
    },
  );

  /** Which site addresses a test's steps refer to, and how many fields carry
   *  each — so the picker can name the number of edits about to happen. */
  ipcMain.handle("tests:originsIn", async (_e, params: { id: string }) => {
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    // The test's own URL is the hint: "the site address" means the site this
    // test is about, not whichever host its steps happen to mention most.
    return originsIn(rec.steps, originOf(rec.url ?? ""));
  });

  ipcMain.handle(
    "tests:setVariables",
    async (_e, params: { id: string; variables: unknown }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      const next = normalizeVariables(params.variables);
      // A secret dropped from the list should not leave its value on disk.
      const keptSecrets = new Set(next.filter((v) => v.kind === "secret").map((v) => v.name));
      for (const name of await testSecretsStore.names(params.id)) {
        if (!keptSecrets.has(name)) await testSecretsStore.clear(params.id, name);
      }
      await refreshSecretSnapshot();
      rec.variables = next;
      rec.updatedAt = Date.now();
      // Regenerate so the spec's `const V` header matches the declared set. A
      // hand-edited script is the source of truth and is left alone.
      if (!rec.scriptEdited) rec.scriptPath = testStore.regenerateScript(rec);
      testStore.save(rec);
      return rec;
    },
  );

  // Store a secret's value. One-way by design: there is no handler that reads a
  // secret back out, so a compromised renderer has nothing to ask for.
  ipcMain.handle(
    "tests:setSecret",
    async (_e, params: { id: string; name: string; value: string }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      if (!isValidVariableName(params.name)) {
        throw new Error("Invalid variable name: " + String(params.name));
      }
      if (typeof params.value !== "string" || params.value === "") {
        throw new Error("A secret's value cannot be empty.");
      }
      await testSecretsStore.set(params.id, params.name, params.value);
      await refreshSecretSnapshot();
      return { name: params.name, hasValue: true };
    },
  );

  ipcMain.handle("tests:clearSecret", async (_e, params: { id: string; name: string }) => {
    await testSecretsStore.clear(params.id, params.name);
    await refreshSecretSnapshot();
    return { name: params.name, hasValue: false };
  });

  /** Which of a test's secrets have values stored — names only, never values. */
  ipcMain.handle("tests:secretStatus", async (_e, params: { id: string }) => {
    const stored = new Set(await testSecretsStore.names(params.id));
    const rec = testStore.get(params.id);
    return (rec?.variables ?? [])
      .filter((v) => v.kind === "secret")
      .map((v) => ({ name: v.name, hasValue: stored.has(v.name) }));
  });

  /** Login-session settings. `useSessionFrom` must name a real, different
   *  test — a self-reference would deadlock the mental model (run me to get
   *  the state I need to run). Clearing either is passing null. */
  ipcMain.handle(
    "tests:setSession",
    async (_e, params: { id: string; saveSession?: unknown; useSessionFrom?: unknown }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      if (params.saveSession !== undefined) {
        rec.saveSession = params.saveSession === true ? true : undefined;
      }
      if (params.useSessionFrom !== undefined) {
        if (params.useSessionFrom === null || params.useSessionFrom === "") {
          rec.useSessionFrom = undefined;
        } else if (
          typeof params.useSessionFrom === "string" &&
          params.useSessionFrom !== params.id &&
          testStore.get(params.useSessionFrom)
        ) {
          rec.useSessionFrom = params.useSessionFrom;
        } else {
          throw new Error("Pick a different, existing test to start from.");
        }
      }
      rec.updatedAt = Date.now();
      testStore.save(rec);
      return rec;
    },
  );

  /** The saved-state status line: when it was saved and whether it is still
   *  fresh enough to be used. Null = never saved. */
  ipcMain.handle("tests:sessionState", async (_e, params: { id: string }) =>
    sessionStateInfo(params.id),
  );

  ipcMain.handle("tests:clearSessionState", async (_e, params: { id: string }) => {
    clearSessionState(params.id);
    return sessionStateInfo(params.id);
  });

  ipcMain.handle("tests:setDatasets", async (_e, params: { id: string; datasets: unknown }) => {
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    rec.datasets = normalizeDatasets(params.datasets);
    rec.updatedAt = Date.now();
    testStore.save(rec);
    return rec;
  });

  ipcMain.handle("tests:importDatasetCsv", async (_e, params: { id: string }) =>
    importDatasetCsvFile(params.id),
  );

  /** Stage a file for an upload step: picker → copy into the live session's
   *  uploads dir → the scripts-relative path the step stores. Session-scoped
   *  because the composer only exists inside one, and the session has a test
   *  id from the moment it starts — an unsaved recording can stage too. */
  ipcMain.handle("recorder:stageUpload", async () => {
    const id = recorderService.sessionTestId();
    if (!id) throw new Error("No recording session is running.");
    return stageUploadFile(id);
  });

  /** Mark a test as a reusable flow, and declare the parameters it accepts. */
  ipcMain.handle(
    "tests:setFlow",
    async (_e, params: { id: string; isFlow: boolean; flowParams?: unknown }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      rec.isFlow = params.isFlow === true;
      const names = Array.isArray(params.flowParams)
        ? params.flowParams.filter(isValidVariableName)
        : [];
      // Deduped and capped the same way the variables they project onto are.
      rec.flowParams = rec.isFlow ? [...new Set(names)].slice(0, 50) : [];
      // A parameter IS a variable plus membership in flowParams — its default
      // value is the variable's value, so a parameter with no variable would
      // have no editable default and its `${name}` references would emit as
      // literal text in the flow's own spec. Declare the missing ones.
      const have = new Set((rec.variables ?? []).map((v) => v.name));
      const missing = rec.flowParams.filter((n) => !have.has(n));
      if (missing.length > 0) {
        rec.variables = normalizeVariables([
          ...(rec.variables ?? []),
          ...missing.map((n) => ({ name: n, kind: "plain" as const, value: "" })),
        ]);
      }
      rec.updatedAt = Date.now();
      // The declared set may have grown, which changes the flow's own `const V`
      // header — and testStore.save regenerates every caller's spec after it.
      if (!rec.scriptEdited) rec.scriptPath = testStore.regenerateScript(rec);
      testStore.save(rec);
      return rec;
    },
  );

  /** Tests usable as flows from `fromId`, excluding itself. Cycles are refused
   *  at generation time too, but keeping a test from listing itself is the
   *  difference between "can't do that" and never offering it.
   *
   *  `paramDefaults` carries each parameter's default value (its variable's
   *  value) so the composer can show what an unoverridden call will use. */
  ipcMain.handle("tests:listFlows", async (_e, params: { fromId?: string }) => {
    return testStore
      .list()
      .filter((t) => t.isFlow && t.id !== params.fromId)
      .map((t) => ({
        id: t.id,
        name: t.name,
        flowParams: t.flowParams ?? [],
        // The default each parameter falls back to when a caller leaves it
        // blank — the flow's own variable value. Sent along so the composer can
        // show it as the placeholder; a secret has no stored value, so its
        // default reads as empty here without touching the secret store.
        paramDefaults: Object.fromEntries(
          (t.flowParams ?? []).map((p) => [
            p,
            (t.variables ?? []).find((v) => v.name === p)?.value ?? "",
          ]),
        ),
      }));
  });

  /** Which tests call this flow directly — the reverse index the library has
   *  no stored form of. Computed by scanning steps (through hidden tests too:
   *  a hidden caller still has a spec on disk that inlines the flow). */
  ipcMain.handle("tests:flowUsage", async (_e, params: { id: string }) => {
    return testStore.callersOf(params.id).map((t) => ({ id: t.id, name: t.name }));
  });

  /** Replace one `runFlow` step with the flow's steps, bound exactly as the
   *  generator would bind them — the exported helpers ARE the generator's, so
   *  unwrapping cannot mean something different from running.
   *
   *  One level only: a nested `runFlow` inside the flow stays a call. Fresh
   *  ids on every copied step (two steps sharing an id would confuse every
   *  id-keyed feature: selection, heals, replay flashes), and the call site's
   *  disabled/continue-on-failure propagate to the whole block, the same rule
   *  `expandSteps` applies. */
  ipcMain.handle("tests:unwrapFlow", async (_e, params: { id: string; stepId: string }) => {
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    const at = rec.steps.findIndex((s) => s.id === params.stepId);
    if (at < 0) throw new Error("Step not found: " + params.stepId);
    const call = rec.steps[at];
    if (call.type !== "runFlow" || !call.flowId) {
      throw new Error("That step is not a flow call.");
    }
    if (call.flowId === rec.id) throw new Error("A test cannot unwrap itself.");
    const flow = testStore.get(call.flowId);
    if (!flow) {
      throw new Error("This flow can't be found — it may have been deleted.");
    }
    if (flow.steps.length === 0) {
      throw new Error(`“${flow.name}” has no steps to unwrap.`);
    }
    const { randomUUID } = await import("crypto");
    const args = flowCallBindings(flow, call.flowArgs);
    const now = Date.now();
    const inline = flow.steps.map((s) => {
      const bound = bindFlowStep(s, args);
      const copy: Step = { ...bound, id: randomUUID(), timestamp: now };
      if (call.disabled) copy.disabled = true;
      if (call.continueOnFailure) copy.continueOnFailure = true;
      return copy;
    });
    rec.steps = [...rec.steps.slice(0, at), ...inline, ...rec.steps.slice(at + 1)];
    rec.updatedAt = now;
    if (!rec.scriptEdited) rec.scriptPath = testStore.regenerateScript(rec);
    testStore.save(rec);
    return rec;
  });

  // ── Heal journal ─────────────────────────────────────────────────────────
  //
  // Auto-Heal changes what a test targets. Accepting or reverting is the point
  // of the journal, so both live here rather than being folded into a generic
  // step update — a heal has an original locator to go back to, and only these
  // handlers know it.
  ipcMain.handle("heals:list", async (_e, params: { testId: string }) =>
    healJournalStore.list(params.testId),
  );
  /** Every heal across every test, for the Heals view.
   *
   *  The test NAME is attached here rather than looked up in the renderer: a
   *  heal outlives the test it came from, and an entry that renders as a bare
   *  uuid after a delete is worse than one that says the test is gone. */
  ipcMain.handle("heals:listAll", async () => {
    const names = new Map(testStore.list().map((t) => [t.id, t.name]));
    return healJournalStore.listAll().map((entry) => ({
      ...entry,
      testName: names.get(entry.testId) ?? null,
    }));
  });
  ipcMain.handle("heals:pending", async (_e, params: { testId: string }) =>
    healJournalStore.pending(params.testId),
  );

  /** Apply a journaled heal to the stored test and mark it accepted.
   *
   *  Idempotent by design: an entry already accepted just re-applies the same
   *  locator, so a double-click can't half-apply anything. */
  ipcMain.handle("heals:accept", async (_e, params: { id: string; locator?: unknown }) => {
    const entry = healJournalStore.get(params.id);
    if (!entry) throw new Error("Heal not found: " + params.id);
    const rec = testStore.get(entry.testId);
    if (!rec) throw new Error("Test not found: " + entry.testId);
    // The user may pick a different candidate from the menu rather than the one
    // the engine proposed.
    const chosen = (params.locator as Locator | undefined) ?? entry.appliedLocator;
    const idx = rec.steps.findIndex((s) => s.id === entry.stepId);
    if (idx < 0) throw new Error("That step no longer exists.");
    rec.steps[idx] = { ...rec.steps[idx], locator: chosen };
    rec.updatedAt = Date.now();
    if (!rec.scriptEdited) rec.scriptPath = testStore.regenerateScript(rec);
    testStore.save(rec);
    return healJournalStore.setStatus(params.id, "accepted");
  });

  /** Put a step's locator back to what it was before the heal. */
  ipcMain.handle("heals:revert", async (_e, params: { id: string }) => {
    const entry = healJournalStore.get(params.id);
    if (!entry) throw new Error("Heal not found: " + params.id);
    // Under "suggest" the stored test was never changed, so reverting is just
    // dismissing the suggestion — there is nothing to undo.
    if (entry.applied && entry.originalLocator) {
      const rec = testStore.get(entry.testId);
      const idx = rec ? rec.steps.findIndex((s) => s.id === entry.stepId) : -1;
      if (rec && idx >= 0) {
        rec.steps[idx] = { ...rec.steps[idx], locator: entry.originalLocator };
        rec.updatedAt = Date.now();
        if (!rec.scriptEdited) rec.scriptPath = testStore.regenerateScript(rec);
        testStore.save(rec);
      }
    }
    return healJournalStore.setStatus(params.id, "reverted");
  });

  ipcMain.handle("heals:clearSettled", async (_e, params: { testId: string }) =>
    healJournalStore.clearSettled(params.testId),
  );

  /** Delete one journal entry. Purely a record delete — the test is left exactly
   *  as the heal left it, which is why the UI has to say so before asking. */
  ipcMain.handle("heals:remove", async (_e, params: { id: string }) =>
    healJournalStore.remove(params.id),
  );

  /** Clear settled heals across every test, for the Heals view. Separate from
   *  `heals:clearSettled` rather than a testId-optional version of it: a missing
   *  param would then silently mean "wipe everything". */
  ipcMain.handle("heals:clearAllSettled", async () => healJournalStore.clearAllSettled());

  // Hide a test from the sidebar without deleting its record or script file.
  ipcMain.handle(
    "tests:setHidden",
    async (_e, params: { id: string; hidden: boolean }) => {
      testStore.setHidden(params.id, params.hidden);
      return testStore.get(params.id);
    },
  );

  /** Write a new spec over a test's script and re-parse its steps.
   *
   *  ONE body, two callers — `tests:updateScript` and `scriptChanges:revert` —
   *  because a revert has to land exactly the way the change it undoes did. Two
   *  copies would drift, and the direction they'd drift in is a revert that
   *  restores the file but leaves the Steps tab describing the fix.
   *
   *  `journal` is what tells them apart: a revert must NOT record a change of
   *  its own, or undoing a change would create a second entry to undo. */
  const writeTestScript = (
    id: string,
    source: string,
    journal: ScriptChangeJournal | null,
  ) => {
    const rec = testStore.get(id);
    if (!rec) throw new Error("Test not found: " + id);
    // Read the outgoing script BEFORE the write — this is the only moment the
    // previous spec still exists anywhere, and it is the entire undo.
    let before = "";
    if (journal) {
      try {
        before = testStore.readScript(id);
      } catch {
        // A record whose file is missing still gets its change recorded, just
        // with nothing to revert to. Losing the journal entry as well would be
        // the worse of the two failures.
        before = "";
      }
    }
    rec.scriptPath = testStore.writeScript(rec.id, source);
    rec.scriptEdited = true;
    // Re-parse the steps from the new script so the Steps tab reflects the
    // edited spec (e.g. after applying an AI-suggested fix). Imported tests
    // (sourceDir set) stay script-only and keep their verbatim file as the
    // source of truth, so we don't overwrite their parsed steps.
    //
    // A record whose steps CALL FLOWS is the other exception: the spec-parser
    // has no runFlow vocabulary (the call is inlined at generation time, so
    // the file holds the flow's steps, not the call), and re-parsing would
    // silently replace the reference with a flattened copy — every later flow
    // edit then stops reaching this test, with nothing on screen saying so.
    // The steps are kept and marked diverged instead; regenerating from steps
    // is the way back into agreement.
    const callsFlows = rec.steps.some((s) => s.type === "runFlow");
    if (callsFlows && !rec.sourceDir) {
      rec.stepsDiverged = true;
      rec.stepsDivergedReason = "parse";
      rec.stepsDivergedDismissed = undefined;
      logger.warn("handlers", "Script edited on a test that calls flows — steps kept, not re-parsed", {
        id: rec.id,
      });
    }
    if (!rec.sourceDir && !callsFlows) {
      try {
        const { steps, skipped } = parseSpecDetailed(source);
        rec.steps = steps;
        rec.stepsDiverged = skipped > 0;
        rec.stepsDivergedReason = skipped > 0 ? "parse" : undefined;
        // This is the event the dismissal is scoped to: an applied script (an
        // AI-debug fix, typically) whose statements don't all come back as
        // steps. The user acknowledged the LAST divergence, not this one, so
        // re-arm the warning. Clearing it on the `skipped === 0` branch too
        // keeps a stale `true` from silencing the next real one.
        rec.stepsDivergedDismissed = undefined;
        if (skipped > 0) {
          logger.warn("handlers", "Script has statements the parser couldn't map to steps", {
            id: rec.id,
            skipped,
          });
        }
      } catch (err) {
        logger.warn("handlers", "Failed to re-parse steps from updated script", {
          id: rec.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    rec.updatedAt = Date.now();
    testStore.save(rec);
    if (journal) {
      // The journal must never cost the user their edit. A failure to record
      // degrades to "no history", exactly as the metrics DB degrades to "no
      // metrics" — the write to the script already succeeded.
      try {
        scriptChangeStore.record({ testId: rec.id, before, after: source, ...journal });
      } catch (err) {
        logger.warn("handlers", "Could not journal a script change", {
          id: rec.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return rec;
  };

  /** Refuse a write to a test whose recording session is open. The trainer
   *  regenerates the spec from the session's steps when it finishes
   *  (`recorderService.finalize`) and resets `scriptEdited`, so a script or
   *  step list written underneath it is discarded minutes later with nothing
   *  on screen saying so. The detail view cannot show this state — it is
   *  unmounted while a session is live — which is why the refusal is here. */
  const refuseIfRecording = (id: string): void => {
    if (recorderService.sessionTestId() === id) {
      throw new Error(
        "A recording session for this test is open. Finish it in the trainer before saving the script — the trainer regenerates the script when it stops.",
      );
    }
  };

  ipcMain.handle(
    "tests:updateScript",
    async (_e, params: { id: string; source: string; origin?: unknown; base?: unknown }) => {
      refuseIfRecording(params.id);
      // `base` is the script the editor STARTED from. When it no longer
      // matches the file, something else wrote in between — an AI fix landing
      // unattended, a flow edit regenerating this caller, a heal, an external
      // editor — and saving would overwrite that with a draft built on the
      // old text. Compared as text, not by a revision number: a number has to
      // be bumped by every writer, and the writers that bypass the record
      // (`regenerateCallers` rewrites spec files only) are exactly the ones a
      // counter misses. The text is the fact.
      if (typeof params.base === "string") {
        let current = "";
        try {
          current = testStore.readScript(params.id);
        } catch {
          current = "";
        }
        if (current !== params.base) {
          throw new Error(SCRIPT_CHANGED_ON_DISK);
        }
      }
      return writeTestScript(
        params.id,
        params.source,
        normalizeScriptChangeOrigin(params.origin),
      );
    },
  );

  /** A statement's text for comparing one script's misses with another's:
   *  trimmed, without the trailing `;` the parser's skip branch consumes and
   *  its step branches leave behind. */
  const statementText = (src: string, r: { from: number; to: number }): string =>
    src.slice(r.from, r.to).trim().replace(/;\s*$/, "");

  // ── The Script IDE's live page ─────────────────────────────────────────
  //
  // A Playwright browser the editor owns (live-page-service.ts). Every
  // locator crossing here is a MODEL the service rebuilds through
  // normalizeLocator before it spells and evaluates it — the same boundary
  // a recorded step crosses.
  ipcMain.handle("livePage:status", async () => livePageService.status());
  ipcMain.handle(
    "livePage:open",
    async (_e, params: { url: unknown; browser?: unknown }) => {
      const url = typeof params?.url === "string" ? params.url : "";
      if (!/^https?:\/\//i.test(url)) throw new Error("The live page needs an http(s) address.");
      const browser = isRunBrowser(params?.browser) ? params.browser : "chromium";
      return livePageService.open(url, browser);
    },
  );
  ipcMain.handle("livePage:close", async () => livePageService.close());
  ipcMain.handle("livePage:countMany", async (_e, params: { locators: unknown }) =>
    livePageService.countMany(Array.isArray(params?.locators) ? params.locators : []),
  );
  ipcMain.handle("livePage:highlight", async (_e, params: { locator: unknown }) =>
    livePageService.highlight(params?.locator ?? null),
  );
  ipcMain.handle("livePage:pick", async () => livePageService.pick());
  ipcMain.handle("livePage:cancelPick", async () => livePageService.cancelPick());

  // The TypeScript service (ts-service/client.ts): a utilityProcess the
  // Script tab asks for diagnostics, completions, hover and inspections.
  // Documents are keyed by the renderer's id (the test id); the generated
  // runtime helper is attached here so a spec importing it type-checks.
  const docId = (v: unknown): string => {
    if (typeof v !== "string" || !v) throw new Error("A document id is required.");
    return v.slice(0, 200);
  };
  const offset = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  ipcMain.handle("ts:status", async () => tsService.status());
  ipcMain.handle("ts:ensure", async () => tsService.ensure());
  ipcMain.handle("ts:update", async (_e, params: { id: unknown; text: unknown }) => {
    const text = typeof params?.text === "string" ? params.text : "";
    await tsService.update(docId(params?.id), text, glazeRuntimeSource);
  });
  ipcMain.handle("ts:close", async (_e, params: { id: unknown }) => tsService.close(docId(params?.id)));
  ipcMain.handle("ts:diagnostics", async (_e, params: { id: unknown }) => tsService.diagnostics(docId(params?.id)));
  ipcMain.handle("ts:completions", async (_e, params: { id: unknown; offset: unknown }) =>
    tsService.completions(docId(params?.id), offset(params?.offset)),
  );
  ipcMain.handle("ts:hover", async (_e, params: { id: unknown; offset: unknown }) =>
    tsService.hover(docId(params?.id), offset(params?.offset)),
  );
  ipcMain.handle("ts:format", async (_e, params: { id: unknown }) => tsService.format(docId(params?.id)));
  ipcMain.handle("ts:inspections", async (_e, params: { id: unknown }) =>
    tsService.inspections(docId(params?.id), recorderSettingsStore.get().inspections),
  );

  /** What saving `source` over this test's script WOULD do, without doing it:
   *  the steps the parser would read back, where it read each from, where it
   *  could not, and which of those misses are NEW against the stored script.
   *  The Script IDE draws its parse-coverage gutter from the ranges and asks
   *  for confirmation only over `newlySkipped` — an imported spec or a hand-
   *  written block that was already unmapped does not prompt on every save.
   *  `tracked` says whether a save would re-parse the steps at all: an
   *  imported test and a test that calls flows keep their steps (see
   *  writeTestScript), so for them the gutter is information, not a warning. */
  ipcMain.handle(
    "tests:previewScript",
    async (_e, params: { id: string; source: unknown }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      const source = typeof params.source === "string" ? params.source : "";
      const draft = parseSpecDetailed(source);
      const tracked = !rec.sourceDir && !rec.steps.some((s) => s.type === "runFlow");
      let storedSkipped = new Set<string>();
      try {
        const stored = testStore.readScript(rec.id);
        const parsed = parseSpecDetailed(stored);
        storedSkipped = new Set(parsed.skippedRanges.map((r) => statementText(stored, r)));
      } catch {
        storedSkipped = new Set();
      }
      const newlySkipped = draft.skippedRanges
        .map((r) => statementText(source, r))
        .filter((text) => !storedSkipped.has(text));
      return {
        tracked,
        steps: draft.steps.length,
        skipped: draft.skipped,
        stepRanges: draft.stepRanges,
        skippedRanges: draft.skippedRanges,
        newlySkipped,
        // The parsed steps themselves, aligned with stepRanges: the live
        // page's match counts are asked per step's locator.
        stepList: draft.steps,
      };
    },
  );

  /** Does a DRAFT of a test's script load under the real Playwright CLI?
   *  Writes nothing the user keeps: the Script tab asks this before it saves,
   *  and shows the answer against the draft's lines. See script-check.ts. */
  ipcMain.handle("tests:checkScript", async (_e, params: { id: string; source: unknown }) => {
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    return checkTestScript(rec, typeof params.source === "string" ? params.source : "");
  });

  // ── Script-change journal ────────────────────────────────────────────────
  //
  // The sibling of the heal journal, for changes to the whole spec rather than
  // to one step's locator: an AI-debug fix, or a hand edit in the Script tab.
  // Kept in its own store — see script-change-store.ts for why it must not be
  // folded into heal-journal.json — and merged with the heals in the renderer,
  // which is where they are both just "things that changed this test".
  ipcMain.handle("scriptChanges:list", async (_e, params: { testId: string }) =>
    scriptChangeStore.list(params.testId),
  );

  /** Every script change across every test, for the Heals view. The test NAME
   *  is attached here for the same reason `heals:listAll` does it: a record
   *  outlives the test it came from, and a bare uuid after a delete is worse
   *  than saying the test is gone. */
  ipcMain.handle("scriptChanges:listAll", async () => {
    const names = new Map(testStore.list().map((t) => [t.id, t.name]));
    return scriptChangeStore.listAll().map((entry) => ({
      ...entry,
      testName: names.get(entry.testId) ?? null,
    }));
  });

  ipcMain.handle("scriptChanges:pending", async (_e, params: { testId: string }) =>
    scriptChangeStore.pending(params.testId),
  );

  /** Keep the change. Status only — unlike a heal, the script was already
   *  written when the entry was recorded, so there is nothing to apply. */
  ipcMain.handle("scriptChanges:accept", async (_e, params: { id: string }) => {
    const entry = scriptChangeStore.get(params.id);
    if (!entry) throw new Error("Script change not found: " + params.id);
    return scriptChangeStore.setStatus(params.id, "accepted");
  });

  /** Put the previous script back.
   *
   *  Goes through the same `writeTestScript` the change itself did, so the
   *  Steps tab is re-parsed from the restored spec rather than left describing
   *  the change that was just undone — and journals NOTHING, or every undo
   *  would create a new entry to undo. */
  ipcMain.handle("scriptChanges:revert", async (_e, params: { id: string }) => {
    const entry = scriptChangeStore.get(params.id);
    if (!entry) throw new Error("Script change not found: " + params.id);
    // An entry whose sources were too large to keep is a record, not an undo.
    // Refusing here is what stops the UI ever writing an empty spec over a
    // real one; the row disables its button too, and both are load-bearing.
    if (entry.truncated) {
      throw new Error("That change was too large to store, so it can't be undone.");
    }
    writeTestScript(entry.testId, entry.before, null);
    return scriptChangeStore.setStatus(params.id, "reverted");
  });

  ipcMain.handle("scriptChanges:clearSettled", async (_e, params: { testId: string }) =>
    scriptChangeStore.clearSettled(params.testId),
  );

  /** Delete one record. The test keeps whatever the change left it as — which
   *  makes this the one action that throws the previous script away for good,
   *  so the UI has to say so before asking. */
  ipcMain.handle("scriptChanges:remove", async (_e, params: { id: string }) =>
    scriptChangeStore.remove(params.id),
  );

  ipcMain.handle("scriptChanges:clearAllSettled", async () =>
    scriptChangeStore.clearAllSettled(),
  );

  /** Wave off the "steps and script disagree" warning for this test. Note what
   *  it does NOT do: `stepsDiverged` stays true, because the two really are out
   *  of sync and everything else that reads it (the run comparison, the MCP)
   *  must keep saying so. This only silences the banner, and only until the next
   *  divergence is established. */
  ipcMain.handle(
    "tests:dismissDiverged",
    async (_e, params: { id: string; dismissed?: unknown }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      // `=== false` is the only way to un-dismiss; anything else dismisses.
      rec.stepsDivergedDismissed = params?.dismissed === false ? undefined : true;
      rec.updatedAt = Date.now();
      testStore.save(rec);
      return rec;
    },
  );

  // Update the steps of a saved test directly (no trainer browser). Used by the
  // "Edit Steps" mode: add / rearrange / remove steps in the detail view, then
  // regenerate the spec from the new step list.
  //
  // When the script is NOT generated from the steps — hand-edited, imported, or
  // written by the model from a prompt — saving steps cannot quietly change what
  // runs, so the caller has to say which it wants. `regenerate` rebuilds the spec
  // from the steps (discarding whatever the step list can't represent); without
  // it the steps are stored and the record is marked diverged, because the Steps
  // tab now describes something the runner will never execute. Saying nothing was
  // the old behaviour and it read as an edit that worked.
  ipcMain.handle(
    "tests:updateSteps",
    async (_e, params: { id: string; steps: Step[]; regenerate?: boolean }) => {
      refuseIfRecording(params.id);
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      // The second way a step list reaches the generator, so it gets the same
      // treatment as the capture queue. A step that can't be normalized is
      // dropped rather than failing the save — the alternative is an edit that
      // silently does nothing because one row was malformed.
      rec.steps = Array.isArray(params.steps)
        ? params.steps.map(normalizeStep).filter((s): s is Step => s !== null)
        : [];
      // An imported test is never regenerated, however the renderer asks: its
      // spec is a verbatim file whose sibling modules were copied in alongside
      // it, and a generated one would carry neither those imports nor anything
      // else the parser couldn't classify — with the original already gone.
      // `=== true` because this crosses the IPC boundary: a truthy string must
      // not authorize overwriting the user's script.
      const regenerate =
        !rec.scriptEdited || (params.regenerate === true && !rec.sourceDir);
      if (regenerate) {
        rec.scriptPath = testStore.regenerateScript(rec);
        rec.stepsDiverged = false;
        rec.stepsDivergedReason = undefined;
        rec.stepsDivergedDismissed = undefined;
        // The spec is generated from these steps again, so "edited manually" is
        // no longer true — leaving it set would keep asking about edits that no
        // longer exist, and would block the next step edit from applying.
        rec.scriptEdited = false;
      } else {
        rec.stepsDiverged = true;
        rec.stepsDivergedReason = "unapplied";
        // A fresh save that the script won't carry is a fresh divergence, even
        // if one was already dismissed: the previous acknowledgement was about
        // different edits.
        rec.stepsDivergedDismissed = undefined;
      }
      rec.updatedAt = Date.now();
      testStore.save(rec);
      return rec;
    },
  );

  // Create a new test from an LLM-generated spec (prompt-driven generation).
  // The model writes spec source rather than steps, so the spec is parsed back
  // into the app's Step[] model — same translation the import path does — or
  // the test opens with no Steps tab at all and reads as "generation produced
  // nothing I can inspect". `scriptEdited` stays true for the import path's
  // reason: the model's verbatim file is the runnable artifact and must not be
  // regenerated from the (lossy) parsed steps on a rename.
  ipcMain.handle(
    "tests:createFromPrompt",
    async (
      _e,
      params: {
        name: string;
        url: string;
        speed?: TestSpeed;
        source: string;
        runBrowser?: RunBrowser;
      },
    ) => {
      const { randomUUID } = await import("crypto");
      const id = randomUUID();
      const now = Date.now();
      const name = params.name.trim() || "Generated test";
      // A spec that won't parse is still a perfectly good test — it just shows
      // Script only, exactly as before. Never fail the creation over it.
      let steps: Step[] = [];
      let stepsDiverged = false;
      try {
        const parsed = parseSpecDetailed(params.source);
        steps = parsed.steps;
        stepsDiverged = parsed.skipped > 0;
        if (parsed.skipped > 0) {
          logger.warn("handlers", "Generated spec has statements the parser couldn't map to steps", {
            id,
            skipped: parsed.skipped,
          });
        }
      } catch (err) {
        logger.warn("handlers", "Failed to parse steps from generated script", {
          id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      const rec: TestRecord = {
        id,
        name,
        url: params.url.trim(),
        createdAt: now,
        updatedAt: now,
        steps,
        stepsDiverged,
        stepsDivergedReason: stepsDiverged ? "parse" : undefined,
        scriptPath: testStore.writeScript(id, params.source),
        scriptEdited: true,
        speed: params.speed ?? "fast",
        captureArtifacts: recorderSettingsStore.get().defaultCaptureArtifacts,
        // Absent unless the dialog's picker was moved off the global default —
        // the model's own rule for this field, and what keeps the Settings
        // default live for a test that made no choice.
        ...(isRunBrowser(params.runBrowser) ? { runBrowser: params.runBrowser } : {}),
      };
      testStore.save(rec);
      logger.info("handlers", "Created test from prompt", { id, name, steps: steps.length });
      return rec;
    },
  );

  // ── Import handlers ─────────────────────────────────────────────────
  ipcMain.handle("tests:importFiles", async () => importService.importFromFiles());
  ipcMain.handle(
    "tests:importGit",
    async (_e, params: { url: string; ref?: string; runBrowser?: RunBrowser }) =>
      importService.importFromGit(
        params?.url ?? "",
        params?.ref ?? undefined,
        isRunBrowser(params?.runBrowser) ? params.runBrowser : undefined,
      ),
  );
  ipcMain.handle("tests:repairImports", async (_e, params: { id: string }) => {
    const copied = importService.repairImports(params.id);
    return { copied };
  });

  // ── Local LLM handlers (Ollama / LM Studio) ─────────────────────────
  ipcMain.handle("llm:getConfig", async () => llmConfigStore.get());
  ipcMain.handle(
    "llm:setConfig",
    async (_e, params: { provider?: unknown; model?: unknown; baseUrls?: unknown; roles?: unknown }) => {
      const update: LlmConfigPatch = {};
      if (params?.provider !== undefined) update.provider = asProvider(params.provider);
      if (params?.model !== undefined) {
        update.model = params.model === null ? null : String(params.model);
      }
      if (params?.baseUrls && typeof params.baseUrls === "object") {
        update.baseUrls = params.baseUrls as LlmConfig["baseUrls"];
      }
      // Handed through raw: the store rebuilds every slot and refuses what it
      // must (a hosted autocomplete), and `null` clears a slot.
      if (params?.roles && typeof params.roles === "object") {
        update.roles = params.roles as LlmConfigPatch["roles"];
      }
      return llmConfigStore.set(update);
    },
  );
  ipcMain.handle("llm:status", async (_e, params: { provider?: unknown }) =>
    llmService.status(asProvider(params?.provider)),
  );
  ipcMain.handle("llm:detect", async () => llmService.detect());
  ipcMain.handle("llm:listModels", async (_e, params: { provider?: unknown }) =>
    llmService.listModels(asProvider(params?.provider)),
  );
  ipcMain.handle(
    "llm:chat",
    async (
      _e,
      params: { messages?: unknown; role?: unknown; provider?: unknown; model?: unknown; temperature?: unknown },
    ) => {
      // The resolved provider and model come back with the id: both default to
      // the configured values, which only this side knows, and a caller that
      // read them from settings later would read whatever is selected THEN.
      return llmService.chat({
        messages: asMessages(params?.messages),
        role: asRole(params?.role),
        provider: params?.provider === undefined ? undefined : asProvider(params.provider),
        model: params?.model === undefined ? undefined : String(params.model),
        temperature: typeof params?.temperature === "number" ? params.temperature : undefined,
      });
    },
  );
  /** One awaited JSON-shaped answer from the instant slot (or the role
   *  named). The shape is the caller's schema; the service parses and retries
   *  once, and a renderer never sees text it has to scrape. */
  ipcMain.handle(
    "llm:json",
    async (_e, params: { messages?: unknown; schema?: unknown; role?: unknown; timeoutMs?: unknown }) => {
      const schema = params?.schema && typeof params.schema === "object" ? (params.schema as object) : null;
      if (!schema) throw new Error("llm:json needs a JSON schema.");
      return llmService.completeJson(
        { messages: asMessages(params?.messages), role: asRole(params?.role) ?? "instant", schema },
        { timeoutMs: typeof params?.timeoutMs === "number" ? Math.min(120_000, Math.max(1_000, params.timeoutMs)) : 30_000 },
      );
    },
  );
  /** Fill-in-the-middle from the autocomplete slot — the ghost text. Short,
   *  local only (the store refuses a hosted slot; the service refuses again). */
  ipcMain.handle(
    "llm:fim",
    async (_e, params: { prefix?: unknown; suffix?: unknown; maxTokens?: unknown }) =>
      llmService.fim(
        {
          prefix: typeof params?.prefix === "string" ? params.prefix : "",
          suffix: typeof params?.suffix === "string" ? params.suffix : "",
          maxTokens: typeof params?.maxTokens === "number" ? params.maxTokens : undefined,
        },
        { timeoutMs: 8_000 },
      ),
  );
  ipcMain.handle("llm:cancel", async (_e, params: { requestId?: unknown }) => {
    llmService.cancel(String(params?.requestId ?? ""));
  });
  ipcMain.handle("llm:isActive", async (_e, params: { requestId?: unknown }) => ({
    active: llmService.isActive(String(params?.requestId ?? "")),
  }));

  // Anthropic API key — stored encrypted; the key itself never leaves the backend.
  ipcMain.handle("llm:setApiKey", async (_e, params: { key?: unknown }) => {
    const key = typeof params?.key === "string" ? params.key : "";
    await anthropicKeyStore.setKey(key);
    return { hasKey: true };
  });
  ipcMain.handle("llm:clearApiKey", async () => {
    await anthropicKeyStore.clear();
    return { hasKey: false };
  });
  ipcMain.handle("llm:hasApiKey", async () => ({ hasKey: await anthropicKeyStore.hasKey() }));

  // LM Studio API token — same contract as the Anthropic key: write-only from
  // the renderer, which can read back only whether one is stored.
  ipcMain.handle("llm:setLmStudioToken", async (_e, params: { token?: unknown }) => {
    const token = typeof params?.token === "string" ? params.token : "";
    await lmStudioTokenStore.setToken(token);
    return { hasToken: true };
  });
  ipcMain.handle("llm:clearLmStudioToken", async () => {
    await lmStudioTokenStore.clear();
    return { hasToken: false };
  });
  ipcMain.handle("llm:hasLmStudioToken", async () => ({
    hasToken: await lmStudioTokenStore.hasToken(),
  }));

  // ── Proxy (Settings → Proxy) ─────────────────────────────────────────
  // The password: same contract as the Anthropic key — write-only from the
  // renderer, which can read back only whether one is stored. Set/clear also
  // refresh the live proxy state, because the cached dispatchers embed it.
  ipcMain.handle("proxy:setPassword", async (_e, params: { password?: unknown }) => {
    const password = typeof params?.password === "string" ? params.password : "";
    await proxyPasswordStore.set(password);
    await refreshProxy();
    return { hasPassword: true };
  });
  ipcMain.handle("proxy:clearPassword", async () => {
    await proxyPasswordStore.clear();
    await refreshProxy();
    return { hasPassword: false };
  });
  ipcMain.handle("proxy:hasPassword", async () => ({
    hasPassword: await proxyPasswordStore.has(),
  }));
  // Validation, mabl-style: one button per traffic class. App connectivity
  // checks the endpoint the app actually talks to (the active AI provider);
  // test connectivity checks a user-typed URL through a session configured
  // exactly as the training browser's would be. Neither throws — a failed
  // check is the ANSWER, and the dialog renders it.
  ipcMain.handle("proxy:verifyApp", async () => {
    const { url } = activeProviderEndpoint();
    return verifyAppConnectivity(url);
  });
  ipcMain.handle("proxy:verifyTest", async (_e, params: { url?: unknown }) => {
    const url = typeof params?.url === "string" ? params.url.trim() : "";
    return verifyTestConnectivity(url);
  });

  // ── Branch switcher (a testing tool, Electron-only) ─────────────────
  // Build another branch of THIS app and relaunch onto it. See
  // services/branch-switcher.ts for why it cannot exist outside the Electron
  // app, and scripts/switch-branch.mjs for the build itself.
  //
  // `branches:status` is the gate every other channel here sits behind, and it
  // never throws: the view has to be able to render the reason the feature is
  // unavailable, and a rejected status call would render as a broken view.
  ipcMain.handle("branches:status", async () => branchSwitcher.status());
  ipcMain.handle("branches:listPulls", async () => branchSwitcher.pullRequests());
  ipcMain.handle("branches:listBranches", async (_e, params: { refresh?: unknown }) =>
    branchSwitcher.branches(params?.refresh === true),
  );
  // Resolves as the relaunch is scheduled; this process is gone a moment later.
  // Progress arrives on the `branches:progress` channel while it runs.
  ipcMain.handle("branches:switch", async (_e, params: { branch?: unknown }) => {
    const branch = typeof params?.branch === "string" ? params.branch : "";
    return branchSwitcher.switchToBranch(branch);
  });
  ipcMain.handle("branches:home", async () => branchSwitcher.returnToCheckout());
  // Write-only from the renderer, same contract as the Anthropic key and the
  // LM Studio token: it can save one and ask whether one exists, never read it.
  ipcMain.handle("branches:setToken", async (_e, params: { token?: unknown }) => {
    const token = typeof params?.token === "string" ? params.token : "";
    await branchSwitcher.setToken(token);
    return { hasToken: true };
  });
  ipcMain.handle("branches:clearToken", async () => {
    await branchSwitcher.clearToken();
    return { hasToken: false };
  });

  // ── AI debug sessions (minimized "Debug with AI" jobs) ──────────────
  // Persisted so a diagnosis survives a restart. The job itself cannot — see
  // ai-debug-store.ts — so a session stored as "streaming" is reconciled to
  // "interrupted" at startup rather than restored as live.
  ipcMain.handle("aiDebug:list", async () => aiDebugStore.list());
  ipcMain.handle("aiDebug:save", async (_e, params: { session?: unknown }) => {
    const session = params?.session as AiDebugSession | undefined;
    if (!session || typeof session.key !== "string" || !session.key) return null;
    return aiDebugStore.save(session);
  });
  ipcMain.handle("aiDebug:remove", async (_e, params: { key?: unknown }) =>
    aiDebugStore.remove(String(params?.key ?? "")),
  );
  // CLEARS BOTH STORES. The menu item this sits behind says "Delete AI debug
  // history", and a user asking for that does not expect the app to keep a
  // shadow index of what they deleted — even one holding no content. The Stats
  // board's AI Debug category goes back to "not measured", which is the honest
  // reading afterwards.
  ipcMain.handle("aiDebug:clear", async () => {
    const { removed } = aiDebugStore.clear();
    const history = aiDebugHistoryStore.clear();
    return { removed, historyRemoved: history.removed };
  });

  // ── AI debug history (the aggregate behind Stats → AI Debug) ────────
  // Facts about attempts, with no content in them — see
  // main/services/ai-debug-history-store.ts for why that is what lets these
  // rows outlive both the twenty-session cap and the test itself.
  ipcMain.handle("aiDebug:history", async () => aiDebugHistoryStore.list());
  // ONE INGEST, called twice per attempt (sent, then settled). The record is
  // rebuilt field by field on the way in rather than spread, so a renderer
  // holding a fuller object cannot smuggle content into a store whose whole
  // premise is that it holds none.
  ipcMain.handle("aiDebug:record", async (_e, params: { record?: unknown }) => {
    const saved = aiDebugHistoryStore.record(params?.record);
    // Pushed rather than left to a refetch-on-mount, because the reader this
    // is for is somebody STANDING on the Stats board while a minimized job
    // finishes — and the whole point of minimizing is to go and look at
    // something else. The one subscriber is `RecorderProvider`, mounted for the
    // session; a route component subscribing here would be the "refresh this if
    // the user happens to be looking" bug `run-derived-cache.ts` documents.
    if (saved) sendToMain("aiDebug:historyChanged", {});
    return saved;
  });
  // Completion lives in the RENDERER's session store (the LLM stream terminates
  // there), so the desktop notification is renderer-triggered. The setting gate
  // stays HERE: the renderer fires unconditionally and this handler decides,
  // so a renderer bug can't spam banners the user turned off.
  ipcMain.handle("aiDebug:notifyDone", async (_e, params: { testName?: unknown; status?: unknown }) => {
    const testName = typeof params?.testName === "string" && params.testName ? params.testName : "a test";
    const status = params?.status === "error" ? "error" : "done";
    notifyAiDebugOutcome({ testName, status }, recorderSettingsStore.get().notifyOnAiDebugDone);
    return { ok: true };
  });

  // ── AI insights (the scheduled report) ──────────────────────────────
  // Generation itself lives in the MAIN process (insights-service.ts) — the
  // renderer only reads reports and asks for one. Mutations push
  // `insights:changed` so the rail's unread dot updates from any route; the
  // one subscriber is `RecorderProvider`, for the run-derived-cache reason.
  ipcMain.handle("insights:list", async () => insightReportStore.list());
  ipcMain.handle("insights:get", async (_e, params: { id?: unknown }) =>
    insightReportStore.get(String(params?.id ?? "")),
  );
  ipcMain.handle("insights:status", async () => insightsService.status());
  ipcMain.handle("insights:generateNow", async () => insightsService.generateNow());
  // PDF export is a VERB answering with a path and a byte count — the same
  // shape as report:emit, and for the same reason: the renderer never holds
  // the produced bytes. Null = the user cancelled the save dialog.
  ipcMain.handle("insights:exportPdf", async (_e, params: { id?: unknown }) => {
    const report = insightReportStore.get(String(params?.id ?? ""));
    if (!report) throw new Error("That report no longer exists.");
    return exportInsightReportPdf(report);
  });
  ipcMain.handle("insights:markRead", async (_e, params: { id?: unknown }) => {
    const changed = insightReportStore.markRead(String(params?.id ?? ""));
    if (changed) sendToMain("insights:changed", null);
    return { changed };
  });
  ipcMain.handle("insights:delete", async (_e, params: { id?: unknown }) => {
    const removed = insightReportStore.delete(String(params?.id ?? ""));
    if (removed) sendToMain("insights:changed", null);
    return { removed };
  });
  ipcMain.handle("insights:clearAll", async () => {
    const removed = insightReportStore.clearAll();
    if (removed > 0) sendToMain("insights:changed", null);
    return { removed };
  });

  // ── Alert (outgoing webhook) handlers ───────────────────────────────
  // The URL is a bearer credential, so it only ever travels renderer→backend.
  // The renderer can read back whether one exists and its host, never the URL.
  // ── Shopify crawler signatures ──────────────────────────────────────
  //
  // `list` returns STATUS ONLY — host, expiry, state. The header values never
  // cross IPC in either direction after being saved, the same contract the
  // webhook URL has: the renderer can learn that a signature exists and whether
  // it still works, and nothing more.
  ipcMain.handle("shopify:list", async () => shopifySignatureStore.list());
  ipcMain.handle(
    "shopify:add",
    async (
      _e,
      params: { host: string; signatureInput: string; signature: string; signatureAgent?: string },
    ) => {
      const status = await shopifySignatureStore.upsert({
        host: params.host ?? "",
        signatureInput: params.signatureInput ?? "",
        signature: params.signature ?? "",
        signatureAgent: params.signatureAgent,
      });
      // The values become redactable the moment they exist, not at the next run
      // start — a webhook or a log written in between would otherwise carry them.
      await refreshSecretSnapshot();
      // Signatures are edited in the SETTINGS window and read in the main one,
      // and a background BrowserWindow's `visibilityState` stays "visible" — so
      // React Query's refetch-on-focus never fires and the main window would
      // keep showing the state from before the fix. Same push the recorder
      // settings use, for the same reason (see `useSettingsFreshness`).
      sendToMain("settings:changed", null);
      return status;
    },
  );
  ipcMain.handle("shopify:remove", async (_e, params: { id: string }) => {
    await shopifySignatureStore.remove(params.id ?? "");
    await refreshSecretSnapshot();
    sendToMain("settings:changed", null);
    return shopifySignatureStore.list();
  });

  ipcMain.handle("alerts:setWebhookUrl", async (_e, params: { url: string }) => {
    await webhookUrlStore.setUrl(params.url ?? "");
    return webhookUrlStore.status();
  });
  ipcMain.handle("alerts:clearWebhookUrl", async () => {
    await webhookUrlStore.clear();
    return webhookUrlStore.status();
  });
  ipcMain.handle("alerts:status", async () => webhookUrlStore.status());
  // Deliberately surfaces failures instead of swallowing them like sendAlert —
  // the whole point of a test button is to find out that it doesn't work.
  ipcMain.handle("alerts:test", async () => {
    const url = await webhookUrlStore.getUrl();
    if (!url) throw new Error("No webhook URL is configured.");
    await postWebhook(url, {
      text: "✅ Good Looks! test alert — your webhook is configured correctly.",
      event: "run",
      status: "passed",
      detail: { test: true },
      source: "Good Looks!",
    });
    return { ok: true };
  });

  // ── Insights → Slack ────────────────────────────────────────────────
  // The channel that receives new insights reports. Same credential contract
  // as the alert webhook: the URL travels renderer→backend only, and only
  // {hasUrl, host} ever comes back.
  ipcMain.handle("insightsSlack:setUrl", async (_e, params: { url?: unknown }) => {
    await insightsSlackUrlStore.setUrl(String(params?.url ?? ""));
    return insightsSlackUrlStore.status();
  });
  ipcMain.handle("insightsSlack:clearUrl", async () => {
    await insightsSlackUrlStore.clear();
    return insightsSlackUrlStore.status();
  });
  ipcMain.handle("insightsSlack:status", async () => insightsSlackUrlStore.status());
  // Rethrows like alerts:test — the point of a test button is to find out.
  ipcMain.handle("insightsSlack:test", async () => {
    const url = await insightsSlackUrlStore.getUrl();
    if (!url) throw new Error("No Slack webhook URL is configured.");
    await postWebhook(url, {
      text: "📈 Good Looks! test message — new insights reports will be posted here.",
      event: "insights",
      status: "passed",
      detail: { test: true },
      source: "Good Looks!",
    });
    return { ok: true };
  });

  // ── Issue tracker handlers ──────────────────────────────────────────
  // Same credential contract as the webhook above: the key travels
  // renderer→backend only, and the renderer can learn whether one is stored and
  // who it belongs to — never the key itself.
  //
  // `status` is local and cheap; `verify` is the one that touches the network.
  // Keeping them separate is what lets the pane say "saved" while offline
  // instead of "broken".
  ipcMain.handle("issues:status", async () => issueTrackerService.status());
  ipcMain.handle("issues:vocabulary", async () => issueTrackerService.vocabulary());
  ipcMain.handle("issues:connect", async (_e, params: { key?: unknown }) => {
    const key = typeof params?.key === "string" ? params.key : "";
    return issueTrackerService.connect(key);
  });
  ipcMain.handle("issues:verify", async () => issueTrackerService.verify());
  ipcMain.handle("issues:disconnect", async () => issueTrackerService.disconnect());
  // Which trackers exist and which one is in use. The renderer is told rather
  // than knowing: a picker built from a hardcoded list in the settings pane is
  // one that silently disagrees with the registry the day a provider is added.
  ipcMain.handle("issues:providers", async () => issueTrackerService.providers());
  ipcMain.handle("issues:setActiveProvider", async (_e, params: { provider?: unknown }) => {
    // Validated against the registry, never cast. This string indexes it
    // directly, and it arrives from a renderer.
    if (!isProviderId(params?.provider)) throw new Error("That is not a tracker this app supports.");
    issueTrackerService.setActiveProvider(params.provider);
    return issueTrackerService.status();
  });
  ipcMain.handle("issues:listContainers", async () => issueTrackerService.listContainers());
  // `containerId` is optional and null is a real value — it means "nothing
  // selected yet", which Linear answers anyway and GitHub cannot. Absent and
  // null are therefore the same request, unlike `setDefaults` below.
  ipcMain.handle("issues:listSubContainers", async (_e, params: { containerId?: unknown }) =>
    issueTrackerService.listSubContainers(
      typeof params?.containerId === "string" ? params.containerId : null,
    ),
  );
  ipcMain.handle("issues:listLabels", async (_e, params: { containerId?: unknown }) =>
    issueTrackerService.listLabels(
      typeof params?.containerId === "string" ? params.containerId : null,
    ),
  );
  // The source becomes a filesystem path, so it is rebuilt rather than trusted
  // — see `normalizeSource`. A coordinate that does not survive that, or no
  // longer resolves on disk, answers null: the dialog says the evidence is gone
  // rather than opening onto an empty form.
  ipcMain.handle("issues:buildDraft", async (_e, params: { source?: unknown }) => {
    const source = issueTrackerService.normalizeSource(params?.source);
    return source ? issueTrackerService.buildDraft(source) : null;
  });
  ipcMain.handle(
    "issues:createIssue",
    async (
      _e,
      params: {
        source?: unknown;
        title?: unknown;
        body?: unknown;
        attachmentFiles?: unknown;
        containerId?: unknown;
        subContainerId?: unknown;
        labelIds?: unknown;
      },
    ) => {
      const source = issueTrackerService.normalizeSource(params?.source);
      if (!source) throw new Error("That defect could not be identified.");
      const containerId = typeof params?.containerId === "string" ? params.containerId : "";
      if (!containerId) throw new Error("Choose a destination before sending.");
      const strings = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      return issueTrackerService.createIssue(
        {
          source,
          title: typeof params?.title === "string" ? params.title : "",
          body: typeof params?.body === "string" ? params.body : "",
          attachmentFiles: strings(params?.attachmentFiles),
        },
        {
          containerId,
          subContainerId:
            typeof params?.subContainerId === "string" ? params.subContainerId : null,
          labelIds: strings(params?.labelIds),
        },
      );
    },
  );
  ipcMain.handle("issues:linksForTest", async (_e, params: { testId?: unknown }) =>
    typeof params?.testId === "string" ? issueTrackerService.linksForTest(params.testId) : [],
  );
  ipcMain.handle("issues:a11yLinks", async () => issueTrackerService.a11yLinks());
  ipcMain.handle(
    "issues:commentRecurrence",
    async (_e, params: { source?: unknown; attachmentFiles?: unknown }) => {
      const source = issueTrackerService.normalizeSource(params?.source);
      if (!source) throw new Error("That defect could not be identified.");
      const files = Array.isArray(params?.attachmentFiles)
        ? params.attachmentFiles.filter((x): x is string => typeof x === "string")
        : [];
      return issueTrackerService.commentRecurrence(source, files);
    },
  );
  ipcMain.handle("issues:getDefaults", async () => issueTrackerService.defaults());
  ipcMain.handle(
    "issues:setDefaults",
    async (_e, params: { containerId?: unknown; subContainerId?: unknown }) => {
      // Rebuilt, not spread. `undefined` means "leave alone" and `null` means
      // "clear", and both have to survive the trip — so a key that is absent
      // stays absent rather than becoming an explicit null.
      const patch: { containerId?: string | null; subContainerId?: string | null } = {};
      if (params && "containerId" in params) {
        patch.containerId = typeof params.containerId === "string" ? params.containerId : null;
      }
      if (params && "subContainerId" in params) {
        patch.subContainerId =
          typeof params.subContainerId === "string" ? params.subContainerId : null;
      }
      return issueTrackerService.setDefaults(patch);
    },
  );

  // ── Runner handlers ─────────────────────────────────────────────────
  ipcMain.handle(
    "runner:run",
    async (
      _e,
      params: {
        id: string;
        headed?: boolean;
        captureArtifacts?: boolean;
        runHeadless?: boolean;
        browser?: string;
      },
    ) => {
      // A run executes stored specs, so an open inline-flow scope commits
      // first — otherwise the run reads the stale flow at the exact moment the
      // user is verifying their edit. A no-op when no trainer scope is open.
      recorderService.exitFlowScope();
      return playwrightRunner.start({
        testId: params.id,
        headed: params.headed ?? true,
        captureArtifacts: params.captureArtifacts ?? false,
        runHeadless: params.runHeadless ?? false,
        // Unvalidated input would reach the Playwright CLI verbatim; fall back
        // to the test/global default rather than failing the run.
        browser: isRunBrowser(params.browser) ? params.browser : undefined,
      });
    },
  );
  // Re-execute a past run's recorded steps against the live site. Always
  // captures, so the re-run produces its own screenshots to compare.
  ipcMain.handle(
    "runner:replayRun",
    async (_e, params: { testId: string; runId: string; runHeadless?: boolean }) =>
      playwrightRunner.start({
        testId: params.testId,
        headed: !(params.runHeadless ?? false),
        captureArtifacts: true,
        runHeadless: params.runHeadless ?? false,
        replayOfRunId: params.runId,
      }),
  );
  // Then-vs-now comparison between a past run and a re-run of it.
  ipcMain.handle(
    "runner:compareRuns",
    async (_e, params: { testId: string; baseRunId: string; replayRunId: string }) =>
      compareRuns(params.testId, params.baseRunId, params.replayRunId),
  );
  // ── Batch (suite) run handlers ──────────────────────────────────────
  ipcMain.handle(
    "batch:run",
    async (
      _e,
      params: {
        testIds: string[];
        captureArtifacts?: boolean;
        runHeadless?: boolean;
        browser?: string;
        datasetIds?: unknown;
        allDatasets?: boolean;
        concurrency?: unknown;
        perTest?: unknown;
      },
    ) => {
      const testIds = Array.isArray(params.testIds) ? params.testIds.filter((t) => !!t) : [];
      if (testIds.length === 0) throw new Error("Select at least one test to run.");
      // REBUILT, not filtered: every element is reconstructed from known keys,
      // so an unknown field on the wire can never ride along into the runner.
      // Filtering `browsers` THROUGH RUN_BROWSERS validates, dedupes and
      // normalises order in one pass — which is what stops a caller sending
      // ["chromium","chromium","chromium"] and running one test three times on
      // one engine. It also bounds each entry at 3, so the queue can be no
      // longer than 3 × testIds and needs no separate cap.
      const perTest = Array.isArray(params.perTest)
        ? (params.perTest as unknown[])
            .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
            .map((e) => ({
              testId: typeof e.testId === "string" ? e.testId : "",
              browsers: Array.isArray(e.browsers)
                ? RUN_BROWSERS.filter((b) => (e.browsers as unknown[]).includes(b))
                : [],
              headless: e.headless === true,
              // Rebuilt through the SAME normaliser a Routine's steps go
              // through, not passed along. This field now decides whether the
              // REST of the batch runs, so an unrecognised string reaching the
              // runner would be compared against "stopRoutine", come back
              // false, and continue — right today, and only by accident.
              onFailure: failurePolicy(e as { onFailure?: unknown }),
            }))
            // A zero-engine entry would contribute no queue entries, so the
            // batch would silently run fewer tests than were selected. Dropping
            // it falls back to the batch-wide browser instead.
            .filter((e) => e.testId !== "" && e.browsers.length > 0)
            .slice(0, MAX_BATCH_TEST_OPTIONS)
        : undefined;
      return batchRunner.start({
        testIds,
        captureArtifacts: params.captureArtifacts ?? false,
        runHeadless: params.runHeadless ?? false,
        browser: isRunBrowser(params.browser) ? params.browser : undefined,
        perTest,
        datasetIds: Array.isArray(params.datasetIds)
          ? params.datasetIds.filter((d): d is string => typeof d === "string")
          : undefined,
        allDatasets: params.allDatasets === true,
        // Clamped HERE as well as in the runner. Anything past this point spawns
        // a browser per unit, so "how many at once" is not a number to take on
        // trust from a caller — and the MCP reaches the same runner.
        // `new Set` because the ceiling is distinct TESTS: a dataset sweep and
        // a multi-engine row both queue one test many times, and those still
        // run one after another. Do NOT change this to the fan-out count — the
        // lanes are per-testId, so the extra workers would idle and the headed
        // warning would promise more windows than ever open.
        concurrency: clampBatchConcurrency(params.concurrency, new Set(testIds).size),
      });
    },
  );
  ipcMain.handle("batch:stop", async () => {
    batchRunner.stop();
  });
  ipcMain.handle("batch:status", async () => batchRunner.getState());
  // Persisted batch history — survives restarts, joined to runs by RunRecord.batchId.
  ipcMain.handle("batch:list", async () => batchHistoryStore.list());
  ipcMain.handle("batch:get", async (_e, params: { batchId: string }) =>
    batchHistoryStore.get(params.batchId),
  );
  ipcMain.handle("batch:delete", async (_e, params: { batchId: string }) =>
    batchHistoryStore.remove(params.batchId),
  );
  ipcMain.handle("batch:clearHistory", async () => batchHistoryStore.clear());

  // ── Routines ────────────────────────────────────────────────────────
  // Saved, named jobs. docs/ROUTINES.md capability 1.
  //
  // The channels are `routines:*` because they are new. The spec's rename table
  // says NOT to rename the existing `batch:*` channels, `batch-history.json` or
  // `RunRecord.batchId` — those are internal, invisible, and renaming them
  // costs a migration to buy a word. The word is worth having in the UI.
  //
  // `save` takes UNKNOWN and returns what was stored. The store rebuilds the
  // payload rather than trusting it, so what comes back is the job that will
  // actually run — which is what the editor must render. Returning the input
  // would let a step the store dropped stay on screen until the next reload.
  ipcMain.handle("routines:list", async () => routineStore.list());
  ipcMain.handle("routines:get", async (_e, params: { id: string }) =>
    routineStore.get(params.id),
  );
  ipcMain.handle("routines:save", async (_e, params: { routine: unknown }) =>
    routineStore.save(params.routine),
  );
  ipcMain.handle("routines:delete", async (_e, params: { id: string }) =>
    routineStore.remove(params.id),
  );
  /**
   * Run a saved Routine.
   *
   * A TRANSLATION INTO `batchRunner`, not a second execution engine. Every step
   * becomes its own process, its own RunRecord and its own row in Stats — a
   * Routine composes RUNS, and building a parallel runner for it is the design
   * risk ROUTINES.md names. So this reads the Routine, asks
   * `routineRunPlan` for the same `{ testIds, perTest }` payload `batch:run`
   * takes, and hands it over.
   *
   * `plan.skipped` is returned rather than swallowed. A Routine that runs four
   * of its five steps has done most of what was asked — refusing would let one
   * deleted test disable a suite — but a batch quietly one test shorter than
   * the job it came from is the failure this whole feature is supposed not to
   * have. The caller reports it; only a Routine that can run NOTHING throws,
   * and it throws the sentence explaining which kind of nothing.
   */
  /**
   * Occurrences missed while the app was closed. REPORTS, does not run.
   *
   * The renderer offers them; `routines:runMissed` accepts one and
   * `routines:dismissMissed` declines it. Declining still settles the
   * occurrence, or the same prompt returns on every launch forever.
   */
  ipcMain.handle("routines:missed", async () => routineScheduler.missed());
  ipcMain.handle("routines:runMissed", async (_e, params: { id: string }) => {
    const routine = routineStore.get(params.id);
    if (!routine) throw new Error("That routine no longer exists.");
    // The SAME path a timer fire takes — two routes to "the schedule ran this"
    // would be two chances to forget that a scheduled run is always headless.
    return routineScheduler.fire(routine);
  });
  ipcMain.handle("routines:dismissMissed", async (_e, params: { id: string }) =>
    routineScheduler.dismissMissed(params.id),
  );
  ipcMain.handle("routines:run", async (_e, params: { id: string }) => {
    const routine = routineStore.get(params.id);
    if (!routine) throw new Error("That routine no longer exists.");
    const plan = routineRunPlan(
      routine,
      testStore.list().map((t) => t.id),
    );
    const blocked = routineBlockedReason(plan);
    if (blocked) throw new Error(blocked);
    const started = await batchRunner.start({
      testIds: plan.testIds,
      // Stamped on the batch so its history can be scoped to the job it came
      // from. Additive and optional — a batch started any other way simply has
      // no Routine, which is true of it.
      routineId: routine.id,
      // For a `notify` step to name the job it came from. The name AT START,
      // which is the honest one to report even if the Routine is renamed while
      // it runs.
      routineName: routine.name,
      captureArtifacts: plan.captureArtifacts,
      // The batch-wide fallback for a test the runner finds no entry for.
      // Every step here HAS an entry, so this only decides the degenerate case
      // — headless, because a saved job opening windows nobody asked for is
      // the behaviour ROUTINES.md rules out for scheduled runs and there is no
      // reason for the manual path to differ on a test it could not resolve.
      runHeadless: true,
      perTest: plan.perTest,
      // Where the run joins and pauses. Empty for every Routine with no `wait`
      // steps, and empty means one segment — the execution every Routine had
      // before barriers existed.
      barriers: plan.barriers,
      // Clamped against DISTINCT tests, same as `batch:run`: the runner keys a
      // lane by testId, so a multi-engine step still runs one window at a time
      // and counting queue entries here would promise workers that only idle.
      concurrency: clampBatchConcurrency(plan.concurrency, new Set(plan.testIds).size),
    });
    return { ...started, skipped: plan.skipped, plannedRuns: plan.plannedRuns };
  });

  ipcMain.handle("runner:stop", async (_e, params: { runId: string }) => {
    playwrightRunner.stop(params.runId);
  });
  ipcMain.handle("runner:status", async (_e, params: { runId: string; browser?: string }) => ({
    running: playwrightRunner.isRunning(params.runId),
    browserInstalled: playwrightRunner.isBrowserInstalled(
      isRunBrowser(params.browser) ? params.browser : undefined,
    ),
  }));

  // ── Run history / stats handlers ────────────────────────────────────
  // ── Debug screenshots ────────────────────────────────────────────────────
  /** Capture every open app window now. Returns the session so the UI can say
   *  what it got rather than just claiming success. */
  ipcMain.handle("debug:capture", async () => captureWindows(newCaptureId(), "manual"));
  ipcMain.handle("debug:dir", async () => debugDir());
  ipcMain.handle("debug:shortcut", async () => DEBUG_CAPTURE_ACCELERATOR);

  // REDESIGN §6.5. One channel, and it is a VERB: the renderer asks for an emit
  // and gets back a path, never the text. Redaction reads an encrypted store
  // that cannot leave this process, so a channel returning content would move
  // the un-redacted payload across the boundary and make the redaction a
  // formality applied to a copy. `stamp` comes from the caller so the filename
  // the panel is about to show is the filename it asked for.
  ipcMain.handle(
    "report:emit",
    async (_e, params: { emitter: EmitterId; stamp: string; testId?: string }) =>
      emitReport(params.emitter, params.stamp, { testId: params.testId }),
  );
  ipcMain.handle("runs:list", async () => runHistoryStore.list());
  /** Open a failed run's salvaged trace in Playwright's trace viewer. The ids
   *  become path segments, and `openTrace` validates them itself (separator-
   *  free, no `..`) before building the path — `runDir` is a bare join. */
  ipcMain.handle("runs:openTrace", async (_e, params: { testId: string; runId: string }) =>
    openTrace(String(params?.testId ?? ""), String(params?.runId ?? "")),
  );
  /** Lifetime run counts. Separate from `runs:list` because the list is capped
   *  and these are not — counting the rows this returns is exactly the mistake
   *  that made the Stats board's "Total runs" stop at 1000. */
  ipcMain.handle("runs:totals", async () => runHistoryStore.totals());
  /** Flake and failure analytics over the recent run history.
   *
   *  Computed on demand rather than maintained incrementally: it's a read over
   *  at most ANALYSIS_WINDOW runs, and a cached figure that silently went stale
   *  would be worse than a brief wait. The window size is returned so a
   *  truncated history is visible in the UI rather than implied. */
  ipcMain.handle("runs:flake", async () => {
    const runs = analysisWindow();
    const report = analyseFlake(runs, gatherRunDetails(runs));
    return { ...report, windowRuns: runs.length, windowCap: ANALYSIS_WINDOW };
  });
  ipcMain.handle("runs:getLog", async (_e, params: { id: string }) =>
    runHistoryStore.readLog(params.id),
  );
  ipcMain.handle("runs:searchLogs", async (_e, params: { query: string }) =>
    runHistoryStore.searchLogs(params?.query ?? ""),
  );
  ipcMain.handle("runs:resetStats", async () => runHistoryStore.resetStats());
  ipcMain.handle("runs:deleteAll", async () => runHistoryStore.deleteAll());
  ipcMain.handle(
    "runs:deleteRange",
    async (_e, params: { fromMs: number; toMs: number }) => {
      const from = Number(params?.fromMs);
      const to = Number(params?.toMs);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw new Error("Invalid date range");
      }
      return runHistoryStore.deleteRange(Math.min(from, to), Math.max(from, to));
    },
  );
  ipcMain.handle("runs:logsDir", async () => runHistoryStore.logsDirPath());
  /**
   * Site problem or runner problem, for one failed run.
   *
   * Computed on read, never stored — see the note against the `runs` table in
   * metrics-schema.mjs. A verdict frozen at the classifier version that wrote
   * it goes stale silently, and improving the classifier here improves every
   * historical run at once.
   *
   * Returns null rather than throwing when metrics are unavailable or the run
   * has no rows: the panel then shows nothing, which is the correct UI for "no
   * opinion". An error here would put a red toast on a run that already failed.
   */
  // ── The metrics views (Phase 4) ─────────────────────────────────────
  //
  // One handler per view rather than one "give me everything": each is a
  // separate query over a table that can hold a hundred thousand rows, and the
  // Step Health table is useful long before the slowness panel has two windows
  // to compare. They also fail independently — `available: false` is the
  // ordinary answer on a runtime without `node:sqlite`, and a view that showed
  // an empty table there would read as "you have no history".
  ipcMain.handle("metrics:stepHealth", async (_e, params?: { testId?: string }) => ({
    available: metricsStore.available,
    rows: stepHealth(metricsStore.handle(), { testId: params?.testId }),
  }));
  ipcMain.handle(
    "metrics:slowness",
    async (_e, params?: { testId?: string; window?: number }) => {
      const rows = stepDurations(metricsStore.handle(), {
        testId: params?.testId,
        window: params?.window,
      });
      return {
        available: metricsStore.available,
        rows,
        // Computed backend-side so the panel and `get_suite_cost` cannot
        // disagree about what counts as a slowdown.
        slowed: slowdowns(rows),
        cost: costBreakdown(suiteCost(metricsStore.handle())),
        // The TEST's own trend, only when one was named (C §6.3). On the same
        // channel as its steps rather than a new one: the run summary and the
        // step list are one screen asking one question, and two channels would
        // let them answer it from two different reads of a database that is
        // being written to while they look.
        testTrend: params?.testId
          ? testDurationTrend(metricsStore.handle(), params.testId, params?.window)
          : null,
      };
    },
  );
  ipcMain.handle("metrics:divergence", async (_e, params?: { testId?: string }) => ({
    available: metricsStore.available,
    steps: divergentSteps(stepBrowserMatrix(metricsStore.handle(), { testId: params?.testId })),
  }));

  ipcMain.handle("runs:triage", async (_e, params: { id: string }) =>
    metricsStore.triage(params?.id ?? ""),
  );
  // Label WHY a failed run failed. The reason id is validated HERE, against
  // the whole vocabulary — the run store deliberately doesn't know the
  // definitions, and the renderer's picker is not a trust boundary. A disabled
  // custom reason is refused for NEW assignments (that is what disabling
  // means) while runs already carrying it keep resolving.
  ipcMain.handle(
    "runs:setFailureReason",
    async (_e, params: { id: string; reasonId: string | null }) => {
      const reasonId = params?.reasonId ?? null;
      if (reasonId !== null) {
        const custom = failureReasonStore.list();
        const def = resolveFailureReason(reasonId, custom);
        if (!def) throw new Error("No such failure reason: " + reasonId);
        if (custom.find((r) => r.id === reasonId)?.disabled) {
          throw new Error(`"${def.name}" is disabled and can't be assigned to new runs.`);
        }
      }
      const rec = runHistoryStore.setFailureReason(params?.id ?? "", reasonId, "user");
      if (!rec) throw new Error("Only a failed run can carry a failure reason.");
      sendToMain("runs:changed", {});
      return rec;
    },
  );
  // What screenshot capture costs, measured from run history (optionally for
  // one test — the fair comparison, since different tests do different work).
  ipcMain.handle("runs:captureOverhead", async (_e, params?: { testId?: string }) =>
    summarizeCaptureOverhead(runHistoryStore.list(), params?.testId),
  );

  // ── Visual-testing replay handlers (Phase 2) ────────────────────────
  // Runs that have persisted screenshot artifacts, newest first.
  ipcMain.handle("artifacts:list", async () => artifactStore.listReplays());
  // On-disk footprint of all captured artifacts (Settings retention readout).
  ipcMain.handle("artifacts:usage", async () => artifactStore.usage());
  // Apply the retention settings now, across every test. Lets the user see the
  // setting take effect immediately instead of waiting for the next run.
  ipcMain.handle("artifacts:pruneNow", async () => {
    const result = applyRetention();
    sendToMain("runs:changed", {});
    return result;
  });
  // The canonical per-step replay model for one run (or null if unavailable).
  ipcMain.handle(
    "artifacts:getReplay",
    async (_e, params: { testId: string; runId: string }) =>
      artifactStore.readReplay(params.testId, params.runId),
  );
  // A single step's screenshot as a data URL, or null when there's no artifact.
  ipcMain.handle(
    "artifacts:readShot",
    async (_e, params: { testId: string; runId: string; file: string }) => {
      const buf = artifactStore.readShot(params.testId, params.runId, params.file);
      return buf ? `data:image/png;base64,${buf.toString("base64")}` : null;
    },
  );

  // Recorded console + network for one run. Secrets are redacted on the way
  // out (see artifactStore.readLogs) — this is the last point before the data
  // can reach a UI or an LLM prompt.
  ipcMain.handle(
    "artifacts:getLogs",
    async (_e, params: { testId: string; runId: string }) =>
      artifactStore.readLogs(params.testId, params.runId),
  );
  ipcMain.handle(
    "artifacts:hasLogs",
    async (_e, params: { testId: string; runId: string }) => ({
      hasLogs: artifactStore.hasLogs(params.testId, params.runId),
    }),
  );

  // The page structure run-time Auto-Heal recorded around the steps it could
  // not rescue. Every string in it was authored by the site, so it is rebuilt
  // by `normalizeStepStructures` here rather than anywhere further in: this is
  // the last point before it can reach a UI or an LLM prompt, the same place
  // `artifacts:getLogs` redacts secrets.
  ipcMain.handle(
    "artifacts:getStructure",
    async (_e, params: { testId: string; runId: string }) =>
      buildStepStructures(
        artifactStore.readHealFailures(params.testId, params.runId),
        artifactStore.readStepMatches(params.testId, params.runId),
      ),
  );
  ipcMain.handle(
    "artifacts:hasStructure",
    async (_e, params: { testId: string; runId: string }) => ({
      hasStructure: artifactStore.hasHealFailures(params.testId, params.runId),
    }),
  );

  // ── Visual-diff handlers (Phase 3) ──────────────────────────────────
  // A test's visual-diff threshold (percent of pixels), falling back to default.
  ipcMain.handle("visual:getThreshold", async (_e, params: { testId: string }) => {
    const rec = testStore.get(params.testId);
    return rec?.visualThreshold ?? DEFAULT_VISUAL_THRESHOLD;
  });
  // Set a test's threshold (clamped 0–100). Returns the stored value.
  ipcMain.handle(
    "visual:setThreshold",
    async (_e, params: { testId: string; threshold: number }) => {
      const rec = testStore.get(params.testId);
      if (!rec) throw new Error("Test not found: " + params.testId);
      const t = Number.isFinite(params.threshold)
        ? Math.min(100, Math.max(0, params.threshold))
        : DEFAULT_VISUAL_THRESHOLD;
      rec.visualThreshold = t;
      rec.updatedAt = Date.now();
      testStore.save(rec);
      return t;
    },
  );
  // A test's ignore masks (regions excluded from visual diffing).
  ipcMain.handle("visual:getMasks", async (_e, params: { testId: string }) => {
    const rec = testStore.get(params.testId);
    return rec?.visualMasks ?? [];
  });
  // Replace a test's ignore masks. Geometry is normalized (0–1) and clamped
  // here so a bad drag in the UI can't persist an out-of-bounds region.
  ipcMain.handle(
    "visual:setMasks",
    async (_e, params: { testId: string; masks: VisualMask[] }) => {
      const rec = testStore.get(params.testId);
      if (!rec) throw new Error("Test not found: " + params.testId);
      const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
      rec.visualMasks = (params.masks ?? [])
        .map((m) => {
          const x = clamp01(m.x);
          const y = clamp01(m.y);
          return {
            id: m.id,
            stepId: m.stepId ?? null,
            x,
            y,
            // width/height can't extend past the right/bottom edge
            w: Math.min(clamp01(m.w), 1 - x),
            h: Math.min(clamp01(m.h), 1 - y),
            ...(m.label ? { label: m.label } : {}),
          };
        })
        // A zero-area mask would silently do nothing — drop it rather than store it.
        .filter((m) => m.w > 0 && m.h > 0);
      rec.updatedAt = Date.now();
      testStore.save(rec);
      return rec.visualMasks;
    },
  );
  // Step ids this test compares element-scoped rather than page-wide.
  ipcMain.handle("visual:getElementSteps", async (_e, params: { testId: string }) => {
    const rec = testStore.get(params.testId);
    return rec?.visualElementSteps ?? [];
  });
  // Toggle one step between page-level and element-scoped comparison.
  ipcMain.handle(
    "visual:setElementStep",
    async (_e, params: { testId: string; stepId: string; element: boolean }) => {
      const rec = testStore.get(params.testId);
      if (!rec) throw new Error("Test not found: " + params.testId);
      const current = new Set(rec.visualElementSteps ?? []);
      if (params.element) current.add(params.stepId);
      else current.delete(params.stepId);
      rec.visualElementSteps = [...current];
      rec.updatedAt = Date.now();
      testStore.save(rec);
      return rec.visualElementSteps;
    },
  );
  // Pin an entire run's screenshots as the new baselines. Returns patched replay.
  ipcMain.handle("visual:acceptRun", async (_e, params: { testId: string; runId: string }) => {
    const result = acceptRunBaseline(params.testId, params.runId);
    if (result) sendToMain("runs:changed", {});
    return result;
  });
  // Pin one step's screenshot as its new baseline. Returns patched replay.
  ipcMain.handle(
    "visual:acceptStep",
    async (_e, params: { testId: string; runId: string; stepId: string }) => {
      const result = acceptStepBaseline(params.testId, params.runId, params.stepId);
      if (result) sendToMain("runs:changed", {});
      return result;
    },
  );
  // ── Accessibility acceptance ─────────────────────────────────────────────
  //
  // Same shape as the visual accept handlers above, deliberately: the mental
  // model is identical ("this is the state I'm signing off"), so the affordance
  // and the plumbing should be too.
  ipcMain.handle(
    "a11y:acceptStep",
    async (_e, params: { testId: string; runId: string; stepId: string }) => {
      const result = acceptStepA11y(params.testId, params.runId, params.stepId);
      if (result) sendToMain("runs:changed", {});
      return result;
    },
  );
  ipcMain.handle("a11y:acceptRun", async (_e, params: { testId: string; runId: string }) => {
    const result = acceptRunA11y(params.testId, params.runId);
    if (result) sendToMain("runs:changed", {});
    return result;
  });
  /** The Accessibility view's triage verb: accept one rule everywhere it
   *  currently fires (the same latest-checked-run selection the rollup reads).
   *  Emits `runs:changed` because it rewrites replays across tests — the
   *  rollup, the Visual replays and the run list all derive from them. */
  ipcMain.handle("a11y:acceptRule", async (_e, params: { ruleId?: unknown }) => {
    if (typeof params?.ruleId !== "string" || !params.ruleId) return { tests: 0, steps: 0 };
    const result = acceptRuleA11y(params.ruleId);
    if (result.tests > 0) sendToMain("runs:changed", {});
    return result;
  });
  /** Per-item revoke for the baseline browser — un-accept one rule for one
   *  test, where `a11y:resetBaseline` would throw away everything. */
  ipcMain.handle(
    "a11y:revokeRule",
    async (_e, params: { testId?: unknown; ruleId?: unknown }) => {
      if (typeof params?.testId !== "string" || typeof params?.ruleId !== "string") {
        return { removed: 0 };
      }
      return revokeA11yRule(params.testId, params.ruleId);
    },
  );
  // ── Findings banners: dismiss / restore ──────────────────────────────────
  //
  // The counterpart to the two accept handlers above. Accepting resolves a
  // finding and changes what every future run reports; dismissing says "seen"
  // about this run only. Conflating them would mean the only way to clear a
  // banner is to sign off on findings you may not have looked at.
  ipcMain.handle(
    "artifacts:dismissNotice",
    async (_e, params: { testId: string; runId: string; kind: unknown }) => {
      if (!isRunNoticeKind(params?.kind)) return null;
      const result = dismissRunNotice(params.testId, params.runId, params.kind);
      if (result) sendToMain("runs:changed", {});
      return result;
    },
  );
  ipcMain.handle(
    "artifacts:restoreNotice",
    async (_e, params: { testId: string; runId: string; kind: unknown }) => {
      if (!isRunNoticeKind(params?.kind)) return null;
      const result = restoreRunNotice(params.testId, params.runId, params.kind);
      if (result) sendToMain("runs:changed", {});
      return result;
    },
  );
  /** The suite-wide accessibility picture, for the Stats category dashboard.
   *
   *  WHY THIS IS A HANDLER AND NOT A RENDERER COMPUTATION. A run record carries
   *  only counts (`a11yChecks`, `a11yNewSteps`); which RULES fired lives inside
   *  each run's `replay.json`. Rolling that up in the renderer would mean one
   *  `artifacts:getReplay` round trip per test to draw one screen. This reads
   *  the same files in the process that already has them open.
   *
   *  It reads the LATEST CHECKED RUN PER TEST, and it picks them with the same
   *  function the tile does — `selectLatestA11yRuns` in `shared/`. A run whose
   *  replay has been pruned simply drops out, which is the retention behaviour
   *  every other artifact reader here has. */
  ipcMain.handle("a11y:rollup", async () => {
    const chosen = selectLatestA11yRuns(runHistoryStore.list());
    const runs = [];
    for (const run of chosen) {
      const replay = artifactStore.readReplay(run.testId, run.id);
      if (!replay) continue;
      runs.push({
        testId: replay.testId,
        testName: replay.testName,
        runId: replay.runId,
        startedAt: replay.startedAt,
        steps: replay.steps,
      });
    }
    return rollupA11y(runs);
  });
  /** Forget everything accepted for a test — the way back from an over-eager
   *  "accept run", which is otherwise irreversible. */
  ipcMain.handle("a11y:resetBaseline", async (_e, params: { testId: string }) =>
    resetA11yBaseline(params.testId),
  );
  /** Per-test accessibility-check preference. */
  ipcMain.handle(
    "tests:setA11yChecks",
    async (_e, params: { id: string; a11yChecks: boolean }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      rec.a11yChecks = params.a11yChecks === true;
      rec.updatedAt = Date.now();
      testStore.save(rec);
      return rec;
    },
  );

  // Every pinned baseline for a test, newest first — backs the baselines
  // manager (which steps are pinned, from which run, and when).
  ipcMain.handle("visual:listBaselines", async (_e, params: { testId: string }) => {
    const entries = Object.values(baselineStore.manifest(params.testId).steps);
    return entries.sort((a, b) => b.at - a.at);
  });
  // Unpin a step's baseline, so the next capture run re-seeds it from scratch.
  ipcMain.handle(
    "visual:clearBaseline",
    async (_e, params: { testId: string; stepId: string }) => {
      baselineStore.clear(params.testId, params.stepId);
      sendToMain("runs:changed", {});
      return true;
    },
  );
  // A step's pinned baseline screenshot as a data URL (for side-by-side), or null.
  ipcMain.handle(
    "visual:baselineShot",
    async (_e, params: { testId: string; stepId: string }) =>
      baselineStore.readShotDataUrl(params.testId, params.stepId),
  );

  // ── Step annotation handlers (Phase 4) ──────────────────────────────
  // Every note on steps of one run, for populating the replay timeline.
  ipcMain.handle(
    "annotations:list",
    async (_e, params: { testId: string; runId: string }) =>
      annotationStore.list(params.testId, params.runId),
  );
  // Create/update/clear the note for one step (blank text clears it).
  ipcMain.handle(
    "annotations:upsert",
    async (_e, params: { testId: string; runId: string; stepId: string; text: string }) =>
      annotationStore.upsert(params.testId, params.runId, params.stepId, params.text),
  );

  // ── Failure-reason handlers ──────────────────────────────────────────
  // The whole vocabulary in one answer, because every consumer needs both
  // halves: the picker offers built-ins plus ENABLED customs, and display
  // resolution needs disabled ones too.
  ipcMain.handle("failureReasons:list", async () => ({
    builtin: DEFAULT_FAILURE_REASONS,
    custom: failureReasonStore.list(),
  }));
  // Both mutations push `failureReasons:changed`: the editor lives in the
  // Settings window, and the labels it renames are on screen in the MAIN
  // window — without the push a rename would show only where it was typed.
  ipcMain.handle(
    "failureReasons:create",
    async (_e, params: { name: unknown; description?: unknown }) => {
      const rec = failureReasonStore.create(params?.name, params?.description);
      sendToMain("failureReasons:changed", {});
      return rec;
    },
  );
  ipcMain.handle(
    "failureReasons:update",
    async (_e, params: { id: string; name?: unknown; description?: unknown; disabled?: unknown }) => {
      const rec = failureReasonStore.update(params?.id ?? "", {
        name: params?.name,
        description: params?.description,
        disabled: params?.disabled,
      });
      sendToMain("failureReasons:changed", {});
      return rec;
    },
  );

  // ── Standing overlay rules ────────────────────────────────────────────
  //
  // Every mutation pushes `overlayRules:changed`, for the reason the failure
  // reasons above do it: the management list lives in the SETTINGS window
  // while the trainer that teaches a rule is the MAIN one, so without the push
  // a rule taught in one would be invisible in the other until a restart.
  //
  // The trainer also has to re-arm its live watcher when the set changes,
  // which is what `recorderService.refreshOverlayRules()` does — a rule the
  // user just taught should start working on the page they are looking at, not
  // on the next navigation.
  ipcMain.handle("overlayRules:list", async () => overlayRuleStore.listRules());
  ipcMain.handle(
    "overlayRules:create",
    async (_e, params: { url: unknown; label: unknown; target: unknown }) => {
      // The target came from a PAGE, through the element picker, so it is
      // rebuilt from checked values rather than trusted for its type — see
      // `normalizeOverlayRule`. A target that will not normalize is refused
      // here rather than stored as a rule that can never fire.
      const target = normalizeLocator(params?.target, false);
      if (!target) throw new Error("That element can't be turned into a rule.");
      const rec = overlayRuleStore.createRule({
        url: typeof params?.url === "string" ? params.url : "",
        label: typeof params?.label === "string" ? params.label : "",
        target,
      });
      if (!rec) throw new Error("Could not create the rule for this page.");
      sendToMain("overlayRules:changed", {});
      recorderService.refreshOverlayRules();
      return rec;
    },
  );
  ipcMain.handle(
    "overlayRules:update",
    async (_e, params: { id: string; label?: unknown; disabled?: unknown }) => {
      const rec = overlayRuleStore.updateRule(params?.id ?? "", {
        label: typeof params?.label === "string" ? params.label : undefined,
        disabled: params?.disabled === true,
      });
      sendToMain("overlayRules:changed", {});
      recorderService.refreshOverlayRules();
      return rec;
    },
  );
  ipcMain.handle("overlayRules:remove", async (_e, params: { id: string }) => {
    const removed = overlayRuleStore.removeRule(params?.id ?? "");
    sendToMain("overlayRules:changed", {});
    recorderService.refreshOverlayRules();
    return removed;
  });

  logger.info("handlers", "✓ IPC handlers registered");
}
