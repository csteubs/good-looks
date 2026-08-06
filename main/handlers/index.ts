/**
 * Handler Registration
 *
 * Register all your IPC handlers here
 */

import * as path from "path";
import { fileURLToPath } from "url";

import { appHandlers } from "./app.js";
import { getSettingsWindow, openSettingsWindow } from "../windows/settings-window.js";
import { recorderService } from "../services/recorder-service.js";
import { batchRunner } from "../services/batch-runner.js";
import { batchHistoryStore } from "../services/batch-history-store.js";
import { webhookUrlStore } from "../services/webhook-url-store.js";
import { postWebhook } from "../services/alert-service.js";
import { playwrightRunner } from "../services/playwright-runner.js";
import { runHistoryStore } from "../services/run-history-store.js";
import { artifactStore } from "../services/artifact-store.js";
import { baselineStore } from "../services/baseline-store.js";
import { acceptRunBaseline, acceptStepBaseline } from "../services/visual-baseline-ops.js";
import { acceptRunA11y, acceptStepA11y, resetA11yBaseline } from "../services/a11y-baseline-ops.js";
import { sendToMain } from "../services/app-window.js";
import { annotationStore } from "../services/annotation-store.js";
import { testStore } from "../services/test-store.js";
import { importService } from "../services/import-service.js";
import { testSecretsStore } from "../services/test-secrets-store.js";
import { healJournalStore } from "../services/heal-journal-store.js";
import { refreshSecretSnapshot } from "../services/secret-redaction.js";
import { parseSpecDetailed } from "../services/spec-parser.js";
import { llmService } from "../services/llm-service.js";
import { llmConfigStore } from "../services/llm-config-store.js";
import { aiDebugStore } from "../services/ai-debug-store.js";
import { anthropicKeyStore } from "../services/anthropic-key-store.js";
import { recorderSettingsStore } from "../services/recorder-settings-store.js";
import { summarizeCaptureOverhead } from "../services/capture-overhead.js";
import { applyRetention } from "../services/retention.js";
import { compareRuns } from "../services/run-comparison.js";
import { analyseFlake } from "../services/flake-analysis.js";
import {
  captureWindows,
  debugDir,
  DEBUG_CAPTURE_ACCELERATOR,
  newCaptureId,
  syncRequestWatcher,
} from "../services/debug-capture.js";
import { ANALYSIS_WINDOW, analysisWindow, gatherRunDetails } from "../services/flake-source.js";
import {
  DEFAULT_VISUAL_THRESHOLD,
  isRunBrowser,
  isValidVariableName,
  normalizeDatasets,
  normalizeStep,
  normalizeTags,
  normalizeVariables,
} from "../recorder/types.js";
import type { AiDebugSession, AssertKind, CookieSpec, Locator, RawStep, RecorderSettings, Step, TestRecord, TestSpeed, VisualMask } from "../recorder/types.js";
import type { LlmConfig, LlmMessage, LlmProvider } from "../services/llm/types.js";

import { ipcMain, logger } from "@glaze/core/backend";

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
  ipcMain.handle("window:openSettings", async (_event) => {
    await openSettingsWindow();
  });

  ipcMain.handle("window:closeSettings", async (_event) => {
    getSettingsWindow()?.close();
  });

  // ── Recorder handlers ───────────────────────────────────────────────
  ipcMain.handle(
    "recorder:start",
    async (_e, params: { url: string; name?: string; testId?: string }) =>
      recorderService.start(params),
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
  ipcMain.handle(
    "recorder:applyHeal",
    async (_e, params: { stepId: string; locator: Locator }) =>
      recorderService.applyHeal(params.stepId, params.locator),
  );
  ipcMain.handle("recorder:setCursor", async (_e, params: { index: number }) =>
    recorderService.setCursor(params.index),
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

  ipcMain.handle("recorder:startRefine", async () => recorderService.startRefine());
  ipcMain.handle("recorder:endRefine", async () => recorderService.endRefine());
  ipcMain.handle("recorder:stop", async () => {
    recorderService.stop();
  });
  ipcMain.handle("recorder:discardExit", async () => {
    recorderService.discardExit();
  });
  ipcMain.handle("recorder:getState", async () => recorderService.getState());
  ipcMain.handle("recorder:getSettings", async () => recorderSettingsStore.get());
  ipcMain.handle(
    "recorder:setSettings",
    async (_e, params: Partial<RecorderSettings>) => {
      const next = recorderSettingsStore.set(params ?? {});
      // Bring the debug watcher into line immediately. Deferring to the next
      // launch would make the toggle look broken to the person who just used it.
      syncRequestWatcher();
      return next;
    },
  );

  // ── Test library handlers ───────────────────────────────────────────
  ipcMain.handle("tests:list", async () => testStore.list());
  ipcMain.handle("tests:get", async (_e, params: { id: string }) => testStore.get(params.id));
  ipcMain.handle("tests:getScript", async (_e, params: { id: string }) =>
    testStore.readScript(params.id),
  );
  ipcMain.handle("tests:delete", async (_e, params: { id: string }) => {
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
    if (speed !== "slow" && speed !== "medium" && speed !== "fast") {
      throw new Error("Invalid speed: " + String(speed));
    }
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    rec.speed = speed as TestSpeed;
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

  // ── Variables, secrets and datasets ──────────────────────────────────────
  //
  // Normalization is backend-only, matching tests:setTags: the renderer posts
  // raw input and renders whatever comes back, so the two sides cannot disagree
  // about what a valid variable name is. That matters more here than for tags —
  // a name that isn't a JS identifier would emit a spec that doesn't parse.
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

  ipcMain.handle("tests:setDatasets", async (_e, params: { id: string; datasets: unknown }) => {
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    rec.datasets = normalizeDatasets(params.datasets);
    rec.updatedAt = Date.now();
    testStore.save(rec);
    return rec;
  });

  /** Mark a test as a reusable flow, and declare the parameters it accepts. */
  ipcMain.handle(
    "tests:setFlow",
    async (_e, params: { id: string; isFlow: boolean; flowParams?: unknown }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      rec.isFlow = params.isFlow === true;
      rec.flowParams = Array.isArray(params.flowParams)
        ? params.flowParams.filter(isValidVariableName)
        : [];
      rec.updatedAt = Date.now();
      testStore.save(rec);
      return rec;
    },
  );

  /** Tests usable as flows from `fromId`, excluding itself. Cycles are refused
   *  at generation time too, but keeping a test from listing itself is the
   *  difference between "can't do that" and never offering it. */
  ipcMain.handle("tests:listFlows", async (_e, params: { fromId?: string }) => {
    return testStore
      .list()
      .filter((t) => t.isFlow && t.id !== params.fromId)
      .map((t) => ({ id: t.id, name: t.name, flowParams: t.flowParams ?? [] }));
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

  ipcMain.handle("tests:updateScript", async (_e, params: { id: string; source: string }) => {
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    rec.scriptPath = testStore.writeScript(rec.id, params.source);
    rec.scriptEdited = true;
    // Re-parse the steps from the new script so the Steps tab reflects the
    // edited spec (e.g. after applying an AI-suggested fix). Imported tests
    // (sourceDir set) stay script-only and keep their verbatim file as the
    // source of truth, so we don't overwrite their parsed steps.
    if (!rec.sourceDir) {
      try {
        const { steps, skipped } = parseSpecDetailed(params.source);
        rec.steps = steps;
        rec.stepsDiverged = skipped > 0;
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
    return rec;
  });

  // Update the steps of a saved test directly (no trainer browser). Used by the
  // "Edit Steps" mode: add / rearrange / remove steps in the detail view, then
  // regenerate the spec from the new step list (unless the script was hand-edited).
  ipcMain.handle(
    "tests:updateSteps",
    async (_e, params: { id: string; steps: Step[] }) => {
      const rec = testStore.get(params.id);
      if (!rec) throw new Error("Test not found: " + params.id);
      // The second way a step list reaches the generator, so it gets the same
      // treatment as the capture queue. A step that can't be normalized is
      // dropped rather than failing the save — the alternative is an edit that
      // silently does nothing because one row was malformed.
      rec.steps = Array.isArray(params.steps)
        ? params.steps.map(normalizeStep).filter((s): s is Step => s !== null)
        : [];
      // A hand-edited script is the source of truth — don't clobber it. For
      // app-generated tests, regenerate from the edited steps so the script
      // stays in sync. Clear any divergence flag since the steps are now clean.
      if (!rec.scriptEdited) {
        rec.scriptPath = testStore.regenerateScript(rec);
        rec.stepsDiverged = false;
      }
      rec.updatedAt = Date.now();
      testStore.save(rec);
      return rec;
    },
  );

  // Create a new test from an LLM-generated spec (prompt-driven generation).
  // Unlike a recorded test, there are no captured steps — the script is the
  // source of truth, so it's saved as scriptEdited with an empty steps array.
  ipcMain.handle(
    "tests:createFromPrompt",
    async (
      _e,
      params: { name: string; url: string; speed?: TestSpeed; source: string },
    ) => {
      const { randomUUID } = await import("crypto");
      const id = randomUUID();
      const now = Date.now();
      const name = params.name.trim() || "Generated test";
      const rec: TestRecord = {
        id,
        name,
        url: params.url.trim(),
        createdAt: now,
        updatedAt: now,
        steps: [],
        scriptPath: testStore.writeScript(id, params.source),
        scriptEdited: true,
        speed: params.speed ?? "fast",
        captureArtifacts: recorderSettingsStore.get().defaultCaptureArtifacts,
      };
      testStore.save(rec);
      logger.info("handlers", "Created test from prompt", { id, name });
      return rec;
    },
  );

  // ── Import handlers ─────────────────────────────────────────────────
  ipcMain.handle("tests:importFiles", async () => importService.importFromFiles());
  ipcMain.handle("tests:importGit", async (_e, params: { url: string }) =>
    importService.importFromGit(params?.url ?? ""),
  );
  ipcMain.handle("tests:repairImports", async (_e, params: { id: string }) => {
    const copied = importService.repairImports(params.id);
    return { copied };
  });

  // ── Local LLM handlers (Ollama / LM Studio) ─────────────────────────
  ipcMain.handle("llm:getConfig", async () => llmConfigStore.get());
  ipcMain.handle(
    "llm:setConfig",
    async (_e, params: { provider?: unknown; model?: unknown; baseUrls?: unknown }) => {
      const update: Partial<LlmConfig> = {};
      if (params?.provider !== undefined) update.provider = asProvider(params.provider);
      if (params?.model !== undefined) {
        update.model = params.model === null ? null : String(params.model);
      }
      if (params?.baseUrls && typeof params.baseUrls === "object") {
        update.baseUrls = params.baseUrls as LlmConfig["baseUrls"];
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
      params: { messages?: unknown; provider?: unknown; model?: unknown; temperature?: unknown },
    ) => {
      const requestId = llmService.chat({
        messages: asMessages(params?.messages),
        provider: params?.provider === undefined ? undefined : asProvider(params.provider),
        model: params?.model === undefined ? undefined : String(params.model),
        temperature: typeof params?.temperature === "number" ? params.temperature : undefined,
      });
      return { requestId };
    },
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
  ipcMain.handle("aiDebug:clear", async () => aiDebugStore.clear());

  // ── Alert (outgoing webhook) handlers ───────────────────────────────
  // The URL is a bearer credential, so it only ever travels renderer→backend.
  // The renderer can read back whether one exists and its host, never the URL.
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
    ) =>
      playwrightRunner.start({
        testId: params.id,
        headed: params.headed ?? true,
        captureArtifacts: params.captureArtifacts ?? false,
        runHeadless: params.runHeadless ?? false,
        // Unvalidated input would reach the Playwright CLI verbatim; fall back
        // to the test/global default rather than failing the run.
        browser: isRunBrowser(params.browser) ? params.browser : undefined,
      }),
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
      },
    ) => {
      const testIds = Array.isArray(params.testIds) ? params.testIds.filter((t) => !!t) : [];
      if (testIds.length === 0) throw new Error("Select at least one test to run.");
      return batchRunner.start({
        testIds,
        captureArtifacts: params.captureArtifacts ?? false,
        runHeadless: params.runHeadless ?? false,
        browser: isRunBrowser(params.browser) ? params.browser : undefined,
        datasetIds: Array.isArray(params.datasetIds)
          ? params.datasetIds.filter((d): d is string => typeof d === "string")
          : undefined,
        allDatasets: params.allDatasets === true,
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

  ipcMain.handle("runs:list", async () => runHistoryStore.list());
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

  logger.info("handlers", "✓ IPC handlers registered");
}
