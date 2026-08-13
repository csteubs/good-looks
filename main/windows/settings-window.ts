import { BrowserWindow, logger } from "@shell/backend";
import { getPreloadPath, getWindowUrl } from "./window-paths.js";
import { attachUiScale, scaled } from "../services/ui-scale.js";

let settingsWindow: BrowserWindow | null = null;

/** Which pane a deep-linked open lands on. A URL FRAGMENT and not a new IPC
 *  channel: the window is loaded exactly once per open, and `#cost` is read by
 *  `settings-view`'s lazy initial state, so there is nothing to keep in sync
 *  and nothing that can arrive before the renderer is listening.
 *
 *  VALIDATED HERE, not only in the renderer. The id crosses IPC from a renderer
 *  process and is concatenated into the URL this window loads — the pane's own
 *  `paneById(...) ?? DEFAULT_PANE_ID` fallback is the second line of defence,
 *  not the first. */
function paneFragment(pane: unknown): string {
  return typeof pane === "string" && /^[a-z][a-z-]{0,31}$/.test(pane) ? `#${pane}` : "";
}

export async function openSettingsWindow(pane?: string): Promise<void> {
  // If window exists and is not destroyed, just show it.
  //
  // A `pane` is deliberately NOT applied to an already-open window. Re-loading
  // it would throw away whatever the user was in the middle of typing, and
  // pushing the pane across would need a channel aimed at this window
  // specifically — which `check:push-consumers` cannot see, because it only
  // scans `sendToMain`. Landing on the pane you were already looking at is not
  // a bug worth that.
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    logger.debug("settings", "Settings window already exists, showing it");
    settingsWindow.show();
    return;
  }

  logger.info("settings", "Creating settings window");

  settingsWindow = new BrowserWindow({
    windowKey: "settings",
    // Wide enough for the pane sidebar (190pt, min 170) plus a content column
    // that still fits a label, its description and a control on one row. At the
    // old 560×480 the same content was one flat scroll about eight screens
    // long; the sidebar only pays for itself if the pane beside it is readable.
    //
    // CSS PIXELS, scaled into points. This window is the one where an unscaled
    // number shows immediately: 760 points is 608 CSS pixels at 125%, below its
    // own 620 minimum, so it would OPEN with the size control that caused it
    // already cut off the right-hand edge.
    width: scaled(760),
    height: scaled(560),
    minWidth: scaled(620),
    minHeight: scaled(420),
    title: "Settings",
    show: false,
    center: true,
    webPreferences: {
      preload: getPreloadPath(),
    },
  });

  // The window the scale is CHANGED in has to obey it too, or the control
  // appears to do nothing to the person using it.
  attachUiScale(settingsWindow, { width: 620, height: 420 });

  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  const url = (await getWindowUrl("settings-window.html")) + paneFragment(pane);
  logger.info("settings", "Loading settings URL", { url });

  await settingsWindow.loadURL(url);
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}
