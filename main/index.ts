// Main process entry point — Electron main.
//
// Electron provides the framework wiring (IPC, lifecycle, signal handlers)
// natively; the only piece the Glaze runtime used to add that we must register
// ourselves is the host handler set backing window.glazeAPI (dialogs, shell,
// clipboard, theme, native menus) — see shell/host-handlers.ts.


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
import { registerDeepLinks, takePendingDeepLink } from "./shell/deep-link.js";
import { forwardRendererConsole, registerHostHandlers } from "./shell/host-handlers.js";
import { registerHandlers } from "./handlers/index.js";
import { getPreloadPath, getWindowUrl } from "./windows/window-paths.js";
import { openSettingsWindow } from "./windows/settings-window.js";
import { sendToMain, setMainWindow } from "./services/app-window.js";
import { attachUiScale, scaled } from "./services/ui-scale.js";
import {
  captureWindows,
  DEBUG_CAPTURE_ACCELERATOR,
  newCaptureId,
  syncRequestWatcher,
} from "./services/debug-capture.js";
import { applyRetention } from "./services/retention.js";
import { batchHistoryStore } from "./services/batch-history-store.js";
import { routineStore } from "./services/routine-store.js";
import { routineScheduler } from "./services/routine-scheduler.js";
import { recorderSettingsStore } from "./services/recorder-settings-store.js";
import { testStore } from "./services/test-store.js";
import { aiDebugStore } from "./services/ai-debug-store.js";
import { aiDebugHistoryStore } from "./services/ai-debug-history-store.js";
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

// ── Custom scheme ─────────────────────────────────────────────────────
// Must run at module scope, before app.whenReady(): Electron reads the
// privileged-scheme list once during startup. The handler itself is installed
// after ready (see whenReady below).
registerAppScheme();

// ── Deep links ────────────────────────────────────────────────────────
// Also at module scope, and for the same class of reason: on macOS the
// `open-url` that LAUNCHED the app fires before `whenReady` resolves, so a
// listener attached after ready misses the click that started everything and a
// cold start opens on the home screen instead.
registerDeepLinks();

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

// ── Routine migration ─────────────────────────────────────────────────
// One-time: synthesise a Routine named "Batch" from the old per-row Batch
// settings, so nobody loses a checklist they spent time on. Idempotent by a
// flag in routines.json, not by "is the list empty" — the difference is
// whether a Routine the user has since deleted comes back on the next launch.
// The settings keys it reads are deliberately left in place for one release;
// a migration that also removes its own source has no way back.
{
  const settings = recorderSettingsStore.get();
  const knownTestIds = testStore.list().map((t) => t.id);
  routineStore.ensureMigrated(settings, knownTestIds);
}

// ── Routine scheduler ─────────────────────────────────────────────────
// The in-process half of ROUTINES capability 2: while the app is open, a
// Routine whose occurrence arrives runs itself. The OTHER half — occurrences
// missed while the app was closed — is deliberately not started here; it is
// offered, and the renderer asks for it (`routines:missed`). A suite that
// seizes the machine the moment you launch the app is how people turn
// scheduling off.
routineScheduler.start();

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
  // The same reconciliation over the history the Stats board counts, and for a
  // sharper reason: an attempt left open would be counted as either still
  // running or as zero-length, and both answers corrupt "time spent in AI
  // debug". Then seed the history from whatever sessions survive, ONCE — a
  // board that opened at zero for a user who has been using this feature for
  // months would be a wrong answer wearing a new feature's clothes.
  const { reconciled: staleAttempts } = aiDebugHistoryStore.reconcileInterrupted();
  if (staleAttempts > 0) {
    logger.info("ai-debug", "Reconciled interrupted AI debug attempts at startup", {
      reconciled: staleAttempts,
    });
  }
  const { added } = aiDebugHistoryStore.backfillFrom(aiDebugStore.list());
  if (added > 0) {
    logger.info("ai-debug", "Seeded AI debug history from retained sessions", { added });
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

  // 960, not 390. The old minimum was a promise the layout could not keep: the
  // widest toolbar (test detail) needs 688px beside a 240px sidebar, so below
  // ~928px the run controls — including `Run test` itself — left the viewport
  // with no horizontal scroll anywhere to bring them back. Batch lost its `Run`
  // the same way. A window the user is allowed to make cannot be a window the
  // primary action falls out of, so the floor is now the measured requirement
  // plus a little slack, rather than a number chosen independently of it.
  //
  // If a future toolbar needs more room, this is the number that moves — but
  // `check:narrow-layout` pins it against the measured requirement, so a wider
  // toolbar fails there rather than silently overflowing here.
  //
  // These four are CSS PIXELS, and `scaled()` turns each into the physical
  // points a window is sized in. At 100% that is the identity and these are the
  // numbers they always were; above it, a floor left unscaled would be a
  // smaller viewport than the measurement above describes — 960 points is 768
  // CSS pixels at 125%, under the ~928 the toolbar needs — so the guarantee
  // would quietly lapse at the setting someone turns up in order to read the
  // app. See services/ui-scale.ts.
  const minWindowWidth = scaled(960);
  const minWindowHeight = scaled(456);
  const windowWidth = scaled(1000);
  const windowHeight = scaled(700);

  // No title. The app's name is already in the menu bar and the Dock, and the
  // window's own chrome draws the view it is showing — a title bar repeating
  // "Good Looks!" above that is noise.
  //
  // Setting it to "" is not enough on its own: a window with an empty title
  // adopts its page's <title>, so main-window.html carries an empty one too.
  // Both halves are needed, which is what `check:app-identity` pins.
  const windowTitle = "";

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

  // Keep the window untitled. Chromium pushes the document's title up to the
  // window whenever it changes, so an empty `title` above only survives until
  // some page or library sets `document.title` — refusing the event is what
  // makes "no title" a property of the window rather than of one HTML file.
  mainWindow.on("page-title-updated", (event) => event.preventDefault());

  // Draw at the user's chosen interface scale, before the first paint and
  // after every reload — and keep the layout floor above expressed in the CSS
  // pixels it was measured in. See services/ui-scale.ts.
  attachUiScale(mainWindow, { width: 960, height: 456 });

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

    // A deep link that LAUNCHED the app arrived before this window existed, so
    // it was held rather than delivered. Replayed here, once the renderer can
    // receive it — without this a cold start from a clicked link opens on the
    // home screen and the click looks like it did nothing.
    const pending = takePendingDeepLink();
    if (pending) mainWindow?.webContents.send("deepLink:open", pending);

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
    // The app had no help surface at all: every document it has lived in the
    // repo, and the only in-app mention of the MCP server was one clause inside
    // a screenshot setting. `role: "help"` is what puts this menu where macOS
    // users look for it and attaches the system's own search field to it.
    //
    // Each item deep-links a TOPIC of the Documentation pane. The slugs are a
    // contract with `docs/MCP-GUIDE.md` — rename one of those headings and
    // `check:docs-blocks` fails rather than these items quietly opening the top
    // of the document. The one external link is github.com, which is the only
    // host `shell.openExternal` accepts here.
    {
      role: "help",
      submenu: [
        {
          label: "Good Looks! Help",
          click: async () => await openSettingsWindow("documentation"),
        },
        { type: "separator" },
        {
          label: "Using Good Looks! from an AI assistant",
          click: async () => await openSettingsWindow("documentation/what-it-is"),
        },
        {
          label: "Set up the MCP server",
          click: async () => await openSettingsWindow("documentation/setup"),
        },
        {
          label: "What you can ask for",
          click: async () => await openSettingsWindow("documentation/what-you-can-ask-for"),
        },
        {
          label: "Linear, GitHub and Slack",
          click: async () => await openSettingsWindow("documentation/linear-github-and-slack"),
        },
        { type: "separator" },
        {
          label: "Troubleshooting",
          click: async () => await openSettingsWindow("documentation/troubleshooting"),
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
  logger.info("main", "Application menu configured with Settings and Help");
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
