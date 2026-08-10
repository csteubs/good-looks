// "Font size", implemented as proportional zoom on the app's own windows.
//
// WHY ZOOM AND NOT A FONT SIZE. The redesign is tuned in whole pixels — 108
// `font-size` declarations across `renderer/theme/*.css`, 9.5px uppercase
// labels inside 24px controls inside a 34px strip (`--gl-strip-h`), chips whose
// widths were picked against a specific face at a specific size. Scaling the
// TEXT alone inside chrome whose heights are fixed does not make the app more
// readable, it makes it clip: the labels grow, the boxes do not, and the first
// thing to disappear is the status column. `setZoomFactor` re-lays the page out
// in larger CSS pixels, so text and the boxes around it grow together and every
// proportion the design was drawn with survives. It also costs no CSS, which
// means there is no second sizing system to keep in step with the first.
//
// The honest cost, and the pane says so: this scales the whole interface, not
// only the type.
//
// THE TRAINING BROWSER IS DELIBERATELY EXCLUDED — this is the load-bearing line
// in the file. `recorder-service.ts` opens a window onto the arbitrary site
// under test, and zooming that is not a display preference, it is a change to
// the thing being recorded: layout is viewport-width dependent, so a responsive
// site under 125% zoom may serve a different DOM, a click may land on a
// different element, and a visual baseline captured at one scale will not match
// one captured at another. A reading preference must never rewrite the test. So
// this module is called from the three APP window creation sites and nowhere
// else, and it takes the window as an argument rather than reaching for
// `BrowserWindow.getAllWindows()` — a helper that scales "every window" would
// pick the training browser up the day someone adds one.

import { logger } from "@shell/backend";

import { recorderSettingsStore } from "./recorder-settings-store.js";
import { getAuxWindows, getMainWindow } from "./app-window.js";
import { getSettingsWindow } from "../windows/settings-window.js";

/**
 * The bit of a BrowserWindow this module needs.
 *
 * Structural rather than `BrowserWindow` so the behaviour is unit-testable with
 * a plain object — the real type is native-backed and a test that has to open a
 * window to check a number is a test nobody runs.
 */
export interface ZoomableWindow {
  isDestroyed(): boolean;
  setMinimumSize(width: number, height: number): void;
  getSize(): number[];
  setSize(width: number, height: number): void;
  webContents: {
    setZoomFactor(factor: number): void;
    on(event: "did-finish-load", listener: () => void): unknown;
  };
}

/** A window's layout floor, in CSS pixels — what the VIEW needs, not what the
 *  window happens to measure. See `scaledMinimums` for why the distinction is
 *  the whole point. */
export interface MinSize {
  width: number;
  height: number;
}

/** The stored scale, already validated by the settings store — an unrecognised
 *  value on disk has been replaced by 1 before it gets here. */
export function uiScale(): number {
  return recorderSettingsStore.get().uiScale;
}

/** A CSS-pixel measurement in the physical points a window is sized in. */
export function scaled(cssPixels: number): number {
  return Math.round(cssPixels * uiScale());
}

/**
 * Every window's declared layout floor, so a scale change can re-apply it.
 *
 * WHY MINIMUMS HAVE TO MOVE WITH THE ZOOM, and this is a correctness fix rather
 * than polish. `main/index.ts` sets the main window's floor at 960 with a
 * comment explaining the number: the widest toolbar needs 688px beside a 240px
 * sidebar, so below ~928 the run controls — `Run test` itself — leave the
 * viewport with nowhere to scroll them back from. That is a measurement in CSS
 * PIXELS. Left at 960 physical points, the same floor is 768 CSS pixels at
 * 125%, well under the requirement it was derived from — so the promise the
 * comment makes silently stops holding at exactly the setting a user reaches
 * for when they are struggling to read the app. The Settings window has the
 * same shape of floor and fails sooner, because it also OPENS at a fixed size:
 * 760 points is 608 CSS pixels at 125%, under its own 620 minimum, so it opens
 * with its controls already cut off.
 *
 * A WeakMap rather than a field on the window: the type here is structural, and
 * a window that closes should take its entry with it.
 */
const minimums = new WeakMap<object, MinSize>();

function applyMinimum(win: ZoomableWindow | null): void {
  if (!win || win.isDestroyed()) return;
  const min = minimums.get(win as object);
  if (!min) return;
  const width = scaled(min.width);
  const height = scaled(min.height);
  try {
    win.setMinimumSize(width, height);
    // AND GROW IT, if it is now under its own floor.
    //
    // `setMinimumSize` constrains what the user can drag to; on macOS it does
    // NOT resize a window that is already smaller. So a settings window open
    // when the scale went up kept its 760 points, which is 608 CSS pixels at
    // 125% — under the 620 its own layout declares — leaving the person who
    // just turned the size up looking at a pane narrower than it is built for.
    // With this, the same window measures 775 points and exactly 620 CSS
    // pixels, with no horizontal overflow.
    //
    // Growing a window the user has sized is intrusive, and it is still the
    // right trade here: the only windows it happens to are ones below the size
    // their own toolbar needs, where the alternative is controls that cannot be
    // reached at all.
    const [currentWidth, currentHeight] = win.getSize();
    if (currentWidth < width || currentHeight < height) {
      win.setSize(Math.max(currentWidth, width), Math.max(currentHeight, height));
    }
  } catch (err) {
    logger.warn("ui-scale", "Could not set minimum size", { error: String(err) });
  }
}

function setZoom(win: ZoomableWindow | null, scale: number): void {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.setZoomFactor(scale);
  } catch (err) {
    // A window that cannot be zoomed is a window at 100%, which is legible.
    // Throwing here would take down whatever was creating it.
    logger.warn("ui-scale", "Could not set zoom factor", { scale, error: String(err) });
  }
}

/**
 * Draw `win` at the user's chosen scale, now and after every load.
 *
 * Call once per APP window, at creation. The `did-finish-load` listener is why
 * this is separate from `applyUiScaleToAllWindows`: Chromium resets the zoom
 * factor across a navigation, so a window that reloads (the dev server's HMR
 * full-reload, a renderer crash recovery) would silently snap back to 100%.
 * Registering that listener on every save instead would stack a new one per
 * save.
 */
export function attachUiScale(win: ZoomableWindow, minSize?: MinSize): void {
  setZoom(win, uiScale());
  if (minSize) {
    minimums.set(win as object, minSize);
    applyMinimum(win);
  }
  win.webContents.on("did-finish-load", () => setZoom(win, uiScale()));
}

/**
 * Re-draw every app window at the stored scale.
 *
 * Called from the `recorder:setSettings` handler so the change lands while the
 * user is looking at it. The settings window is included explicitly: it is not
 * registered as an aux window (only the trainer panel is), and the one window
 * that must respond to this setting is the one it is changed in.
 */
export function applyUiScaleToAllWindows(): void {
  const scale = uiScale();
  for (const win of [getMainWindow(), getSettingsWindow(), ...getAuxWindows()]) {
    setZoom(win, scale);
    // And the floor moves with it. Electron grows a window that is smaller than
    // its new minimum, which is the behaviour wanted here: turning the size up
    // must not leave a window too small to lay its own toolbar out.
    applyMinimum(win);
  }
}
