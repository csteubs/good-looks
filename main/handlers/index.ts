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
import { playwrightRunner } from "../services/playwright-runner.js";
import { testStore } from "../services/test-store.js";
import { importService } from "../services/import-service.js";
import { generateSpec } from "../services/script-generator.js";
import { llmService } from "../services/llm-service.js";
import { llmConfigStore } from "../services/llm-config-store.js";
import { recorderSettingsStore } from "../services/recorder-settings-store.js";
import type { AssertKind, RawStep, RecorderSettings, Step, TestRecord, TestSpeed } from "../recorder/types.js";
import type { LlmConfig, LlmMessage, LlmProvider } from "../services/llm/types.js";

import { ipcMain, logger } from "@glaze/core/backend";

function asProvider(v: unknown): LlmProvider {
  if (v === "ollama" || v === "lmstudio") return v;
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
  ipcMain.handle("recorder:setCursor", async (_e, params: { index: number }) =>
    recorderService.setCursor(params.index),
  );
  ipcMain.handle("recorder:replayStep", async (_e, params: { stepId: string }) =>
    recorderService.replayStep(params.stepId),
  );
  ipcMain.handle("recorder:startRefine", async () => recorderService.startRefine());
  ipcMain.handle("recorder:endRefine", async () => recorderService.endRefine());
  ipcMain.handle("recorder:stop", async () => {
    recorderService.stop();
  });
  ipcMain.handle("recorder:getState", async () => recorderService.getState());
  ipcMain.handle("recorder:getSettings", async () => recorderSettingsStore.get());
  ipcMain.handle(
    "recorder:setSettings",
    async (_e, params: Partial<RecorderSettings>) => recorderSettingsStore.set(params ?? {}),
  );

  // ── Test library handlers ───────────────────────────────────────────
  ipcMain.handle("tests:list", async () => testStore.list());
  ipcMain.handle("tests:get", async (_e, params: { id: string }) => testStore.get(params.id));
  ipcMain.handle("tests:getScript", async (_e, params: { id: string }) =>
    testStore.readScript(params.id),
  );
  ipcMain.handle("tests:delete", async (_e, params: { id: string }) => {
    testStore.remove(params.id);
  });
  ipcMain.handle("tests:rename", async (_e, params: { id: string; name: string }) => {
    const rec = testStore.get(params.id);
    if (!rec) throw new Error("Test not found: " + params.id);
    rec.name = params.name.trim() || rec.name;
    rec.updatedAt = Date.now();
    // A hand-edited script is no longer regenerated from steps, so a rename
    // must not clobber it — just update the title metadata.
    if (!rec.scriptEdited) {
      const source = generateSpec({ name: rec.name, url: rec.url, steps: rec.steps });
      rec.scriptPath = testStore.writeScript(rec.id, source);
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
    rec.updatedAt = Date.now();
    testStore.save(rec);
    return rec;
  });

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

  // ── Runner handlers ─────────────────────────────────────────────────
  ipcMain.handle("runner:run", async (_e, params: { id: string; headed?: boolean }) =>
    playwrightRunner.start({ testId: params.id, headed: params.headed ?? true }),
  );
  ipcMain.handle("runner:stop", async (_e, params: { runId: string }) => {
    playwrightRunner.stop(params.runId);
  });
  ipcMain.handle("runner:status", async (_e, params: { runId: string }) => ({
    running: playwrightRunner.isRunning(params.runId),
    browserInstalled: playwrightRunner.isBrowserInstalled(),
  }));

  logger.info("handlers", "✓ IPC handlers registered");
}
