// The trainer panel: a narrow window pinned to the edge of the training
// browser, carrying the step list and the tools, so recording an assertion no
// longer means hunting for the main app window between every click.
//
// Lifecycle mirrors settings-window.ts (module-scoped handle, `ready-to-show`,
// `closed` → null). What is new here is the FOLLOWER, and the follower is the
// dangerous part.
//
// ── The loop ─────────────────────────────────────────────────────────
// Docking resizes the training browser. That fires `resize`. The follower
// reacts by moving the panel. Moving the panel fires `move`. If the panel's own
// events were treated as reasons to re-follow, or if our write to the browser
// came back as a user resize, the two windows chase each other forever. mabl
// shipped exactly this ("resizing the browser while training resulted in an
// endless loop that hangs the product"), and it is silent — nothing throws, the
// app just stops responding.
//
// Three defences, all required:
//   1. EVERY programmatic bounds write goes through `applyBounds`, which raises
//      an `applying` flag. Pinned by check:trainer-panel so a later call site
//      cannot quietly bypass it.
//   2. `applying` alone is not enough — the native side can deliver the event a
//      tick after the flag clears — so `isDuplicateApply` also rejects an event
//      whose rectangle is one we just wrote, within a short window.
//   3. The follower only ever listens to the BROWSER, never to the panel. The
//      panel is a consequence, not an input.
//
// ── Following, not re-docking ────────────────────────────────────────
// `computeDock` runs once. Afterwards `computePanelFollow` places the panel and
// leaves the browser alone — see the note at the top of panel-dock.ts for why
// the two must not be the same operation.

import { BrowserWindow, logger, screen } from "@shell/backend";

import {
  PANEL_WIDTH,
  computeDock,
  computePanelFollow,
  computeUndock,
  isDuplicateApply,
  type Bounds,
  type DockSide,
} from "../services/panel-dock.js";
import {
  registerAuxWindow,
  sendToMain,
  unregisterAuxWindow,
} from "../services/app-window.js";
import { getPreloadPath, getWindowUrl } from "./window-paths.js";

/**
 * Browser-window events that can invalidate the panel's position.
 *
 * Attached BY ITERATION, deliberately: the navigation guard learned this the
 * hard way when `will-redirect` had no listener at all and a whole class of
 * escape went unnoticed. Adding an event to this list wires it everywhere.
 *
 * `move`/`resize` stream during a drag on platforms that support it and give a
 * gliding panel; `moved`/`resized` fire once at the end and are the guaranteed
 * floor. Listening to both costs nothing — a redundant fire is swallowed by
 * `isDuplicateApply` — and means the panel keeps up on whichever the SDK
 * actually emits.
 */
export const FOLLOW_EVENTS = ["move", "moved", "resize", "resized"] as const;

/** Panel width in DIP. Not user-configurable in this pass. */
const WIDTH = PANEL_WIDTH;

let panelWindow: BrowserWindow | null = null;
let browserWindow: BrowserWindow | null = null;

/** Null when undocked. Which edge the panel is currently glued to. */
let dockSide: DockSide | null = null;

/** Raised around our own bounds writes — see defence 1 above. */
let applying = false;

/** The last rectangle we wrote to each window — see defence 2 above. */
let lastPanelWrite: { bounds: Bounds; at: number } | null = null;
let lastBrowserWrite: { bounds: Bounds; at: number } | null = null;

/** Diagnostics for the events question the SDK docs do not answer: whether
 *  `move`/`resize` stream during a drag or only fire at the end. Logged once
 *  per session rather than per event, or a drag would flood the log. */
const seenEvents = new Set<string>();

/** True once the "docking narrowed your viewport" hint has been sent, so it is
 *  shown once per session rather than on every re-dock. */
let viewportHintSent = false;

/**
 * Whether this session's browser width is the size the test replays at (a
 * window-size preset), rather than a footprint the user happened to drag.
 *
 * Set once per session at open and read by every later dock, because the user
 * can undock and re-dock: a re-dock that forgot this would shrink the browser
 * the initial dock deliberately left alone.
 */
let preserveBrowserWidth = false;

/** Whether leaving full screen should restore the dock. Set on entry so a
 *  user who was undocked before going full screen stays undocked after. */
let reDockOnLeaveFullScreen = false;

function isLive(win: BrowserWindow | null): win is BrowserWindow {
  return win !== null && !win.isDestroyed();
}

/** The work area of the display the browser is currently on. */
function workAreaFor(bounds: Bounds): Bounds {
  try {
    return screen.getDisplayMatching(bounds).workArea;
  } catch {
    // A display query failing must not take the session with it; the primary
    // display's work area is a survivable guess, and the geometry is clamped
    // against whatever comes back anyway.
    return screen.getPrimaryDisplay().workArea;
  }
}

/**
 * The ONLY way bounds are written in this module.
 *
 * Every write raises `applying` and records the rectangle, so the events it
 * provokes can be recognised as our own. check:trainer-panel asserts no
 * `setBounds` call exists outside this function.
 */
function applyBounds(win: BrowserWindow, bounds: Bounds, which: "panel" | "browser"): void {
  if (!isLive(win)) return;
  const was = applying;
  applying = true;
  try {
    win.setBounds(bounds);
    const stamp = { bounds, at: Date.now() };
    if (which === "panel") lastPanelWrite = stamp;
    else lastBrowserWrite = stamp;
  } catch (err) {
    logger.warn("trainer-panel", "Could not set window bounds", { which, err: String(err) });
  } finally {
    applying = was;
  }
}

/** Reposition the panel against the browser's current edge. */
function follow(reason: string): void {
  if (dockSide === null) return;
  if (!isLive(browserWindow) || !isLive(panelWindow)) return;
  if (applying) return;

  let browserBounds: Bounds;
  try {
    browserBounds = browserWindow.getBounds();
  } catch (err) {
    logger.warn("trainer-panel", "Could not read the browser bounds", { err: String(err) });
    return;
  }

  // Our own write to the browser coming back as an event.
  if (isDuplicateApply(lastBrowserWrite, browserBounds, Date.now())) return;

  const placement = computePanelFollow(
    browserBounds,
    WIDTH,
    workAreaFor(browserBounds),
    dockSide,
  );

  if (placement === null) {
    // Neither side of the browser has room on this display. Clamping would put
    // the panel on top of the page under test, which is the one outcome this
    // feature exists to prevent, so undock and say so.
    logger.info("trainer-panel", "No room to stay docked — undocking", { reason });
    undock("no-room");
    return;
  }

  if (isDuplicateApply(lastPanelWrite, placement.panel, Date.now())) return;

  dockSide = placement.side;
  applyBounds(panelWindow, placement.panel, "panel");
}

/** Attach the follower to a training-browser window. */
function attachFollower(win: BrowserWindow): void {
  for (const event of FOLLOW_EVENTS) {
    // Same overload-vs-union situation as the navigation guards in
    // recorder-service: every FOLLOW_EVENTS entry takes a zero-arg listener,
    // so the cast is on dispatch only.
    (win.on as (e: string, fn: () => void) => void)(event, () => {
      if (!seenEvents.has(event)) {
        seenEvents.add(event);
        // Answers, from the running app, whether this SDK streams drag events
        // or only reports them at the end.
        logger.debug("trainer-panel", "First follow event of this session", { event });
      }
      follow(event);
    });
  }

  // ── Degraded paths, deliberately cheap ────────────────────────────
  // Full screen and multi-display SUPPORT are out of scope for this pass, but
  // undefined behaviour is not the alternative — these are the defined ones.
  // (mabl shipped a trainer that could not be moved to another screen at all.)
  win.on("enter-full-screen", () => {
    // A full-screen window owns its Space edge to edge; there is nowhere to
    // dock into. Remember that it WAS docked so leaving full screen restores
    // the arrangement rather than silently demoting the panel for good.
    reDockOnLeaveFullScreen = dockSide !== null;
    if (dockSide !== null) undock("full-screen");
  });
  win.on("leave-full-screen", () => {
    if (!reDockOnLeaveFullScreen) return;
    reDockOnLeaveFullScreen = false;
    dock();
  });
  win.on("minimize", () => {
    // The panel is always-on-top; leaving it floating over an empty desktop
    // after the browser is minimized would be the one window you cannot get
    // out of the way.
    if (isLive(panelWindow)) panelWindow.hide();
  });
  win.on("restore", () => {
    if (isLive(panelWindow)) panelWindow.show();
  });
}

/**
 * Open the panel for a training session and dock it to `recWindow`.
 *
 * Safe to call when the display cannot fit both windows: the panel opens
 * undocked rather than not at all, so the tools stay reachable.
 *
 * Pass `fixedBrowserWidth` when the session is recording at a window-size
 * preset. Docking then places the panel BESIDE the browser at its current
 * width instead of taking that width from it — see `DockOptions`.
 */
export async function openTrainerPanel(
  recWindow: BrowserWindow,
  opts: { fixedBrowserWidth?: boolean } = {},
): Promise<void> {
  if (isLive(panelWindow)) {
    panelWindow.show();
    return;
  }
  if (!isLive(recWindow)) return;

  browserWindow = recWindow;
  seenEvents.clear();
  viewportHintSent = false;
  preserveBrowserWidth = !!opts.fixedBrowserWidth;

  const browserBounds = recWindow.getBounds();
  const workArea = workAreaFor(browserBounds);
  const layout = computeDock(browserBounds, WIDTH, workArea, "right", { preserveBrowserWidth });

  panelWindow = new BrowserWindow({
    windowKey: "trainer-panel",
    width: WIDTH,
    height: layout?.panel.height ?? browserBounds.height,
    x: layout?.panel.x,
    y: layout?.panel.y,
    minWidth: WIDTH,
    title: "Trainer",
    // Frameless would look tidier, but the title bar is how the panel is
    // dragged when undocked, and a panel that cannot be moved is a trap.
    titleBarStyle: "hiddenInset",
    show: false,
    // The panel is a view of the session, not a second place to lose the
    // browser behind. Floating above the training window is the whole point.
    alwaysOnTop: true,
    // Without this the first click on the panel is spent activating the window
    // and the button under the cursor does nothing — which reads as the panel
    // being broken, and doubles every interaction this feature exists to halve.
    acceptFirstMouse: true,
    minimizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: getPreloadPath(),
    },
  });

  // Every backend push (recorder:state, recorder:steps, replay logs, …) now
  // reaches the panel as well as the main window. Registered before the load so
  // nothing emitted during startup is missed.
  registerAuxWindow(panelWindow);

  panelWindow.once("ready-to-show", () => {
    if (isLive(panelWindow)) panelWindow.show();
  });

  panelWindow.on("closed", () => {
    if (panelWindow) unregisterAuxWindow(panelWindow);
    panelWindow = null;
    dockSide = null;
  });

  if (layout) {
    dockSide = "right";
    applyBounds(recWindow, layout.browser, "browser");
    applyBounds(panelWindow, layout.panel, "panel");
    noteViewportChange(layout.browser.width);
  } else {
    // The display cannot hold both. Open free-floating rather than not at all.
    dockSide = null;
    logger.info("trainer-panel", "Display too small to dock — opening undocked", {
      workArea,
    });
    sendToMain("trainerPanel:undocked", { reason: "no-room" });
  }

  attachFollower(recWindow);

  const url = await getWindowUrl("trainer-window.html");
  logger.info("trainer-panel", "Loading trainer panel", { url, docked: dockSide !== null });
  await panelWindow.loadURL(url);
}

/**
 * Tell the renderer the training viewport just narrowed.
 *
 * Docking shrinks the training browser, so a responsive site can render a
 * different layout than it did a moment earlier — and than it will on a real
 * run, which uses whatever viewport the spec sets. Silent would be the wrong
 * call: the user would be recording against a layout they did not choose.
 *
 * Not sent when the browser's width was preserved: nothing narrowed, and a
 * warning about a layout change that did not happen would send the user looking
 * for a problem in the one case the geometry is guaranteed correct.
 */
function noteViewportChange(width: number): void {
  if (preserveBrowserWidth) return;
  if (viewportHintSent) return;
  viewportHintSent = true;
  sendToMain("trainerPanel:viewportNarrowed", { width });
}

/** Undock the panel, giving the browser back the width it was using. */
export function undock(reason: string): void {
  if (dockSide === null) return;
  const side = dockSide;
  dockSide = null;

  // Nothing to give back when the dock never took any: growing the browser here
  // would push it PAST its preset — undocking would silently change the size the
  // recording is being made at, in the opposite direction to docking.
  if (isLive(browserWindow) && !preserveBrowserWidth) {
    const bounds = browserWindow.getBounds();
    applyBounds(browserWindow, computeUndock(bounds, WIDTH, workAreaFor(bounds), side), "browser");
  }
  logger.info("trainer-panel", "Undocked", { reason });
  sendToMain("trainerPanel:undocked", { reason });
}

/** Re-dock the panel to the training browser. */
export function dock(): void {
  if (dockSide !== null) return;
  if (!isLive(browserWindow) || !isLive(panelWindow)) return;

  const browserBounds = browserWindow.getBounds();
  const workArea = workAreaFor(browserBounds);
  const layout = computeDock(browserBounds, WIDTH, workArea, "right", { preserveBrowserWidth });
  if (!layout) {
    logger.info("trainer-panel", "Cannot dock — display too small", {
      workArea,
      preserveBrowserWidth,
    });
    sendToMain("trainerPanel:undocked", { reason: "no-room" });
    return;
  }

  dockSide = "right";
  applyBounds(browserWindow, layout.browser, "browser");
  applyBounds(panelWindow, layout.panel, "panel");
  noteViewportChange(layout.browser.width);
  sendToMain("trainerPanel:docked", { width: layout.browser.width });
}

/** Close the panel and forget the session's windows. */
export function closeTrainerPanel(): void {
  // Undock FIRST, while the browser window is still alive: closing the session
  // should not leave the training browser a panel-width narrower than the user
  // left it, and after teardown there is nothing left to restore it from.
  if (dockSide !== null && isLive(browserWindow)) undock("session-ended");

  if (isLive(panelWindow)) {
    unregisterAuxWindow(panelWindow);
    panelWindow.close();
  }
  panelWindow = null;
  browserWindow = null;
  dockSide = null;
  lastPanelWrite = null;
  lastBrowserWrite = null;
  seenEvents.clear();
  viewportHintSent = false;
  reDockOnLeaveFullScreen = false;
}

export function getTrainerPanel(): BrowserWindow | null {
  return panelWindow;
}

/** Whether a panel is open — used to route context actions to it. */
export function isTrainerPanelOpen(): boolean {
  return isLive(panelWindow);
}

export function isTrainerPanelDocked(): boolean {
  return dockSide !== null;
}
