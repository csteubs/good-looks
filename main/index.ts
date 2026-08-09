// Main process entry point — Electron main.
//
// Electron provides the framework wiring (IPC, lifecycle, signal handlers)
// natively; the only piece the Glaze runtime used to add that we must register
// ourselves is the host handler set backing window.glazeAPI (dialogs, shell,
// clipboard, theme, native menus) — see shell/host-handlers.ts.

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { installUserDataPath } from "./shell/user-data.js";
import {
  app,
  BrowserWindow,
  Menu,
  globalShortcut,
  logger,
  initDevToolsButtonState,
} from "@shell/backend";

import { installAppProtocol, registerAppScheme } from "./shell/app-protocol.js";
import { forwardRendererConsole, registerHostHandlers } from "./shell/host-handlers.js";
import { registerHandlers } from "./handlers/index.js";
import { getPreloadPath, getWindowUrl } from "./windows/window-paths.js";
import { openSettingsWindow } from "./windows/settings-window.js";
import { sendToMain, setMainWindow } from "./services/app-window.js";
import {
  captureWindows,
  DEBUG_CAPTURE_ACCELERATOR,
  newCaptureId,
  syncRequestWatcher,
} from "./services/debug-capture.js";
import { applyRetention } from "./services/retention.js";
import { batchHistoryStore } from "./services/batch-history-store.js";
import { aiDebugStore } from "./services/ai-debug-store.js";
import { metricsStore } from "./services/metrics-store.js";
import { setPrunePreflight } from "./services/artifact-store.js";

// ── Data directory ────────────────────────────────────────────────────
// FIRST STATEMENT IN THIS FILE, before anything touches a store. Every store
// resolves `app.getPath("userData")` lazily on each access, so this only has to
// run before the first access — but `applyRetention()` below runs at module
// scope, and pointing it at the wrong directory means sweeping the wrong
// artifacts. Imports are hoisted, so being "first" means first in the body, not
// first in the import list. See shell/user-data.ts for what it decides and why.
installUserDataPath();

// Get directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Custom scheme ─────────────────────────────────────────────────────
// Must run at module scope, before app.whenReady(): Electron reads the
// privileged-scheme list once during startup. The handler itself is installed
// after ready (see whenReady below).
registerAppScheme();

// ── IPC Handlers ──────────────────────────────────────────────────────
// Host surface first (dialogs/shell/clipboard/theme/menus), then the app's own.
registerHostHandlers();
registerHandlers();

// ── Artifact retention ────────────────────────────────────────────────
// Sweep on launch so the retention settings apply to every test, including
// ones that haven't been run lately — otherwise an "older than N days" rule
// would only ever take effect for a test you happen to run again.
{
  const swept = applyRetention();
  if (swept.removedRuns > 0) {
    logger.info("artifacts", "Applied retention at startup", swept);
  }
}

// ── Batch history reconciliation ──────────────────────────────────────
// A batch persisted as "running" means the app exited mid-batch; nothing is
// running now, so clear the stale flag rather than showing a phantom
// in-progress batch forever.
{
  const { reconciled } = batchHistoryStore.reconcileInterrupted();
  if (reconciled > 0) {
    logger.info("batch", "Reconciled interrupted batches at startup", { reconciled });
  }
}

// ── AI debug session reconciliation ───────────────────────────────────
// The llm request map dies with the process, so a session persisted as
// "streaming" describes a job that no longer exists. Restoring it as-is would
// leave a permanently-orange "AI is thinking" icon for a model that stopped
// answering at quit.
{
  const { reconciled } = aiDebugStore.reconcileInterrupted();
  if (reconciled > 0) {
    logger.info("ai-debug", "Reconciled interrupted AI debug sessions at startup", { reconciled });
  }
}

// ── State ─────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;

// ── Window creation ───────────────────────────────────────────────────
async function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    logger.debug("main", "Main window already exists, skipping creation");
    return;
  }

  // Read display name from package.json
  // In production: __dirname = build/main, package.json is at ../../package.json
  const packageJsonPath = path.join(__dirname, "..", "..", "package.json");

  const minWindowWidth = 390;
  const minWindowHeight = 456;
  const windowWidth = 1000;
  const windowHeight = 700;
  let windowTitle = "Glaze App";

  try {
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, "utf-8"));
      windowTitle = packageJson.productName || packageJson.appConfig?.displayName || windowTitle;
    }
  } catch {
    // Use defaults
  }

  // Create main window
  const browserWindowStartTime = Date.now();
  logger.info("main", "⏱️ [COLD_START] Creating BrowserWindow", {
    timestamp: new Date().toISOString(),
  });

  mainWindow = new BrowserWindow({
    windowKey: "main", // Stable key for frame persistence
    width: windowWidth,
    height: windowHeight,
    minWidth: minWindowWidth,
    minHeight: minWindowHeight,
    title: windowTitle,
    show: false, // Don't show until WebView is ready (prevents flickering)
    webPreferences: {
      preload: getPreloadPath(),
    },
  });

  const browserWindowEndTime = Date.now();
  logger.info("main", "⏱️ [COLD_START] BrowserWindow constructor completed", {
    timestamp: new Date().toISOString(),
    duration_ms: browserWindowEndTime - browserWindowStartTime,
  });

  forwardRendererConsole(mainWindow, "main");

  // Share the main window with backend services so they can push events.
  setMainWindow(mainWindow);
  mainWindow.on("closed", () => setMainWindow(null));

  // Wait for ready-to-show event before showing window (prevents flickering)
  mainWindow.once("ready-to-show", () => {
    const showStartTime = Date.now();
    logger.info("main", "⏱️ [COLD_START] ready-to-show event received, showing window", {
      timestamp: new Date().toISOString(),
    });

    mainWindow?.show();

    const showEndTime = Date.now();
    logger.info("main", "⏱️ [COLD_START] Window shown", {
      timestamp: new Date().toISOString(),
      duration_ms: showEndTime - showStartTime,
    });
  });

  // Determine URL to load (dev server preferred, fallback to build files)
  const url = await getWindowUrl("main-window.html");
  logger.info("main", "Resolved main window URL", { url });

  // Load URL - window will be shown automatically when ready-to-show fires
  const loadURLStartTime = Date.now();
  logger.info("main", "⏱️ [COLD_START] Loading URL in window", {
    timestamp: new Date().toISOString(),
    url,
  });

  await mainWindow.loadURL(url);

  const loadURLEndTime = Date.now();
  logger.info("main", "⏱️ [COLD_START] URL loaded in window (waiting for ready-to-show)", {
    timestamp: new Date().toISOString(),
    duration_ms: loadURLEndTime - loadURLStartTime,
  });
}

// ── Application menu ──────────────────────────────────────────────────
async function setupApplicationMenu() {
  await initDevToolsButtonState();
  const menu = Menu.buildFromTemplate([
    {
      label: "App",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "Command+,",
          click: async () => await openSettingsWindow(),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);
  logger.info("main", "Application menu configured with Settings");
}

/**
 * Debug screenshots: a global shortcut for capturing the app's own windows, and
 * (only when the Settings toggle is on) a watcher so an MCP client can request
 * a capture itself.
 *
 * Must run AFTER app ready. Registering at module scope throws
 * "globalShortcut cannot be used before the app is ready" — which is caught and
 * logged rather than crashing, so the only symptom is a shortcut that does
 * nothing. Exactly the silent failure this whole feature exists to avoid, so:
 * called from whenReady, alongside the application menu.
 */
async function setupDebugScreenshots(): Promise<void> {
  syncRequestWatcher();
  try {
    const ok = await globalShortcut.register(DEBUG_CAPTURE_ACCELERATOR, () => {
      void captureWindows(newCaptureId(), "shortcut").then((session) => {
        sendToMain("debug:captured", session);
      });
    });
    if (!ok) {
      // Something else owns the combination system-wide. Say so — a shortcut
      // that silently does nothing is worse than one that isn't offered.
      logger.warn("debug-capture", "Could not register the screenshot shortcut", {
        accelerator: DEBUG_CAPTURE_ACCELERATOR,
      });
      return;
    }
    logger.info("debug-capture", "Screenshot shortcut registered", {
      accelerator: DEBUG_CAPTURE_ACCELERATOR,
    });
  } catch (err) {
    logger.warn("debug-capture", "Screenshot shortcut registration failed", {
      err: String(err),
    });
  }
}

// ── Lifecycle events ──────────────────────────────────────────────────
app.on("window-all-closed", () => {
  // On macOS, apps typically don't quit when all windows are closed
  // Uncomment to quit on all windows closed:
  // app.quit();
});

app.on("activate", (_event, hasVisibleWindows) => {
  logger.info("main", "App activate event received", {
    hasVisibleWindows,
    mainWindowExists: !!mainWindow,
    mainWindowDestroyed: mainWindow?.isDestroyed() ?? true,
  });

  // On macOS, re-create window when dock icon clicked if no windows
  if (!hasVisibleWindows) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      logger.info("main", "Creating main window due to activate event");
      createMainWindow();
    } else {
      logger.info("main", "Showing existing main window");
      mainWindow.show();
    }
  } else {
    logger.info("main", "Has visible windows, no action needed");
  }
});

app.on("before-quit", () => {
  logger.info("main", "App before-quit, cleaning up...");
});

// ── App ready ─────────────────────────────────────────────────────────
const startTime = Date.now();
logger.info("main", "⏱️ [COLD_START] Waiting for app ready...", {
  timestamp: new Date().toISOString(),
});

app.whenReady().then(async () => {
  const windowCreateStartTime = Date.now();
  logger.info("main", "⏱️ [COLD_START] App ready, creating main window", {
    timestamp: new Date().toISOString(),
    wait_duration_ms: windowCreateStartTime - startTime,
  });

  // Before any window loads: the renderer is served over app://.
  installAppProtocol();

  // ── Metrics ────────────────────────────────────────────────────────
  // Opened BEFORE the prune preflight is registered and before any run can
  // start, because everything downstream of this is synchronous — retention
  // reaches the preflight from a sync code path, and node:sqlite is
  // synchronous by design. Never throws: a runtime without node:sqlite, or an
  // unwritable file, degrades to "no metrics" and the app is unchanged.
  await metricsStore.init();
  // Retention is where per-step evidence dies. This is the last moment anything
  // can distil a run into the rows that outlive its screenshots.
  setPrunePreflight((testId, runId) => metricsStore.ingestBeforePrune(testId, runId));

  await setupApplicationMenu();
  await setupDebugScreenshots();

  createMainWindow()
    .then(() => {
      const windowCreateEndTime = Date.now();
      logger.info("main", "⏱️ [COLD_START] Main window created successfully", {
        timestamp: new Date().toISOString(),
        duration_ms: windowCreateEndTime - windowCreateStartTime,
      });
    })
    .catch((error) => {
      logger.error("main", "Failed to create main window", error);
    });
});
