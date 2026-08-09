// Shared reference to the app's windows so backend services can push events to
// the renderer via webContents.send.
//
// `sendToMain` is the ONE choke point for every backend→renderer push in the
// app (~50 call sites across the recorder, runner, LLM and batch services).
// That is why the trainer panel fans out from inside this function rather than
// from the call sites: a second window that receives *most* pushes is worse
// than one that receives none, because the two trainers would then disagree
// about the step list in ways that look like a step-ordering bug. Registering
// the window here means a channel added tomorrow reaches it without anyone
// remembering to wire it.
//
// The name stays `sendToMain` because "the renderer" is still what it means —
// the auxiliary windows are additional views of the same session state, not
// separate destinations that callers should have to choose between.

import type { BrowserWindow } from "@shell/backend";

let mainWindow: BrowserWindow | null = null;

/**
 * Additional app windows that mirror main-window state (currently the trainer
 * panel). Kept as a Set so a re-register cannot double-deliver.
 */
const auxWindows = new Set<BrowserWindow>();

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Start delivering `sendToMain` pushes to `win` as well as the main window.
 *
 * The caller must `unregisterAuxWindow` on close. Delivery is defensive about
 * destroyed windows anyway, but a Set that only ever grows would keep dead
 * handles alive for the life of the process.
 */
export function registerAuxWindow(win: BrowserWindow): void {
  auxWindows.add(win);
}

export function unregisterAuxWindow(win: BrowserWindow): void {
  auxWindows.delete(win);
}

/** Live auxiliary windows, pruning any that have been destroyed. */
export function getAuxWindows(): BrowserWindow[] {
  for (const win of auxWindows) {
    if (win.isDestroyed()) auxWindows.delete(win);
  }
  return [...auxWindows];
}

export function sendToMain(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
  for (const win of getAuxWindows()) {
    // One window throwing must not stop delivery to the others — a half-
    // delivered broadcast is exactly the state that makes two trainers
    // disagree, which is the failure this fan-out exists to prevent.
    try {
      win.webContents.send(channel, payload);
    } catch {
      unregisterAuxWindow(win);
    }
  }
}
