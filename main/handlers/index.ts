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
import { generateSpec } from "../services/script-generator.js";
import type { AssertKind } from "../recorder/types.js";

import { ipcMain, logger } from "@glaze/core/backend";

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
  ipcMain.handle("recorder:start", async (_e, params: { url: string; name?: string }) =>
    recorderService.start(params),
  );
  ipcMain.handle("recorder:pause", async () => recorderService.pause());
  ipcMain.handle("recorder:resume", async () => recorderService.resume());
  ipcMain.handle("recorder:setAssert", async (_e, params: { mode: AssertKind | null }) =>
    recorderService.setAssertMode(params?.mode ?? null),
  );
  ipcMain.handle("recorder:deleteStep", async (_e, params: { stepId: string }) =>
    recorderService.deleteStep(params.stepId),
  );
  ipcMain.handle("recorder:stop", async () => {
    recorderService.stop();
  });
  ipcMain.handle("recorder:getState", async () => recorderService.getState());

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
    const source = generateSpec({ name: rec.name, url: rec.url, steps: rec.steps });
    rec.scriptPath = testStore.writeScript(rec.id, source);
    testStore.save(rec);
    return rec;
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
