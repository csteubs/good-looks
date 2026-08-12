// `goodlooks://` — the way back from an issue into the app.
//
// In `main/shell/` because registering a protocol client and answering
// `open-url` are Electron APIs, and this directory is the only place allowed to
// import `electron`. Everything ABOUT the URL — what is a valid one, what it
// selects — lives in `shared/deep-link.mjs`, which is pure and shared with the
// renderer so the two cannot disagree about what a link means.
//
// THE URL IS UNTRUSTED. It is written into a Linear issue that anyone in the
// workspace can edit, and clicked by whoever opens that issue. Two consequences
// are enforced between here and the parser:
//
//   • Nothing side-effectful. A link selects a VIEW. It does not run a test,
//     write, or delete, so the worst a hostile one achieves is opening a screen.
//   • Nothing is guessed. An unparseable link is dropped in silence rather than
//     falling back to the home screen — landing somewhere plausible is how a
//     malformed link gets reported as "nothing happened".
//
// macOS delivers these through `open-url`, which can fire BEFORE any window
// exists (clicking a link launches the app). So the last target is held and
// replayed to the first window that asks — without it, a cold start opens the
// app on the home screen and the click appears to have done nothing.

import { app, BrowserWindow } from "electron";

import { parseDeepLink, DEEP_LINK_SCHEME, type DeepLinkTarget } from "../../shared/deep-link.mjs";
import { logger } from "./logger.js";

/** The most recent target, held for a window that does not exist yet. */
let pending: DeepLinkTarget | null = null;

/** Push a target at every open window, and remember it for one that opens
 *  later. */
function deliver(target: DeepLinkTarget): void {
  pending = target;
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send("deepLink:open", target);
    // Bring the app forward — the user clicked a link expecting to arrive
    // somewhere, and a silent background navigation is the same as nothing.
    if (!win.isDestroyed()) win.show();
  }
  if (windows.length > 0) pending = null;
}

function handle(url: string | undefined): void {
  const target = parseDeepLink(url);
  if (!target) {
    // Logged WITHOUT the URL. It is attacker-chosen text, and a log line is
    // read by a person and sometimes pasted into an issue.
    logger.warn("shell", "Ignored a deep link that did not parse");
    return;
  }
  logger.info("shell", "Opening a deep link", { hasRun: !!target.runId, hasStep: !!target.stepId });
  deliver(target);
}

/**
 * Register the scheme and start listening.
 *
 * Call before `app.whenReady()` resolves — the `open-url` that launched the app
 * arrives early, and a listener attached later misses it.
 */
export function registerDeepLinks(): void {
  // In development `process.execPath` is Electron itself, so the argv form is
  // required for the OS to hand the URL back to THIS binary rather than to a
  // packaged copy that may not exist.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [process.argv[1]]);
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handle(url);
  });

  // Windows and Linux deliver the URL as an argv entry on a second launch,
  // which the single-instance lock turns into this event. Harmless on macOS,
  // where it simply never fires — and cheaper than a platform branch that
  // would need testing on a platform this app does not ship to yet.
  app.on("second-instance", (_event, argv) => {
    const url = argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`));
    if (url) handle(url);
  });
}

/**
 * The target a cold start arrived with, if any. Consumed once — a window asking
 * twice gets it once, so re-opening a window later does not re-navigate
 * somewhere the user has since left.
 */
export function takePendingDeepLink(): DeepLinkTarget | null {
  const target = pending;
  pending = null;
  return target;
}
