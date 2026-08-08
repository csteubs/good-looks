// Apply a `state` step during trainer replay by driving the training window's
// REAL pointer, so `:hover` and `:active` genuinely apply in the preview.
//
// WHY THIS IS NOT THE INJECTED REPLAYER'S JOB. `:hover` is not a DOM event, it
// is a function of where the OS pointer is. A page can dispatch `mouseover` at
// itself all day and the browser will still not match `:hover` — which is why
// Cypress documents "you cannot hover" as a limitation. A synthetic dispatch
// would be worse than nothing here: the whole point of the feature is to see
// the hover STYLE, so a preview that fires the handlers, applies no style, and
// reports success would certify exactly the thing it failed to test.
//
// So this takes the same shape as `resize-service.ts` and the cookie path: a
// backend service dispatched from `runStep`, because the capability lives on
// the native window rather than in the page. The page still resolves the
// locator — only it can — and reports the target point; the move is native.
//
// A REAL RUN DOES NOT USE ANY OF THIS. There, `locator.hover()` moves
// Playwright's own virtual mouse, which is genuine input in all three engines.
// This module exists solely so the trainer preview tells the truth.

import type { Step } from "../recorder/types.js";

type LogLevel = "info" | "warn" | "error";
export interface InputLogLine {
  i: number;
  t: number;
  level: LogLevel;
  m: string;
}

/** The slice of a trainer window's webContents this needs. Narrow on purpose,
 *  so the logic can be exercised without an SDK window. */
export interface InputHost {
  isDestroyed(): boolean;
  webContents: {
    sendInputEvent(event: {
      type: "mouseMove" | "mouseDown" | "mouseUp";
      x: number;
      y: number;
      button?: "left" | "middle" | "right";
      clickCount?: number;
    }): void;
    getZoomFactor?: () => number;
  };
}

export interface StateStepResult {
  ok: boolean;
  error?: string;
  logs: InputLogLine[];
}

/**
 * Where the pointer was last put, in device-independent window points.
 *
 * Module state rather than a parameter because it models something that is
 * genuinely global and genuinely stateful: there is one pointer, and
 * `mouse.down` acts wherever it happens to be. Threading it through callers
 * would let two of them disagree about a fact the OS only has one of.
 */
let lastPoint: { x: number; y: number } | null = null;
/** True between a `press` and its `release`. See `releaseHeldMouse`. */
let buttonDown = false;

/** Forget the pointer between sessions, so a new training window doesn't
 *  inherit a point measured against a page that is no longer loaded. */
export function resetInputState(): void {
  lastPoint = null;
  buttonDown = false;
}

/** Whether a `press` is currently outstanding. Exported for the safety net's
 *  test, and so a caller can report it rather than having to infer it. */
export function isMouseHeld(): boolean {
  return buttonDown;
}

/**
 * Release a still-held mouse button.
 *
 * The safety net for the one genuinely dangerous failure mode in this feature.
 * A `press` step holds the left button down so an assertion can measure
 * `:active`; if that assertion FAILS, the replay stops — and in the trainer,
 * unlike in a real run, the window stays open with the button still held. Every
 * later click in that window would then be a drag, and the user's next action
 * would behave inexplicably in a browser they were about to keep working in.
 *
 * (A real run is not exposed to this: a hard failure ends the test and tears
 * the context down, and a soft/continue-on-failure assertion still reaches its
 * `release` step.)
 *
 * Idempotent, so every replay path can call it unconditionally on the way out.
 */
export function releaseHeldMouse(win: InputHost | null): InputLogLine[] {
  if (!buttonDown) return [];
  buttonDown = false;
  if (!win || win.isDestroyed() || !lastPoint) return [];
  try {
    win.webContents.sendInputEvent({
      type: "mouseUp",
      x: lastPoint.x,
      y: lastPoint.y,
      button: "left",
      clickCount: 1,
    });
  } catch {
    return [];
  }
  return [
    {
      i: 0,
      t: Date.now(),
      level: "warn",
      m: "Released the mouse button, which a Press step had left held down.",
    },
  ];
}

/**
 * Convert a point in the page's CSS client pixels to the window points
 * `sendInputEvent` expects.
 *
 * The page reports coordinates in CSS pixels, which the zoom factor scales
 * relative to the window. The right-click element picker already applies this
 * correction (see `recorder-service.ts`); getting it wrong here would move the
 * cursor to a plausible-looking wrong place — hovering the element NEXT to the
 * one the step names, which reads as a flaky locator rather than as bad
 * arithmetic.
 */
export function toWindowPoint(
  point: { x: number; y: number },
  zoomFactor: number,
): { x: number; y: number } {
  const z = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return { x: Math.round(point.x * z), y: Math.round(point.y * z) };
}

/**
 * Apply the native half of a `state` step.
 *
 * `focus` never reaches here — the injected replayer runs `el.focus()`, which
 * genuinely works from script. This handles the three that don't: the pointer
 * move for `hover`, and the button events for `press`/`release`.
 *
 * `point` comes from the injected replayer's result (the page resolved the
 * locator and measured the element). Returns the same `{ok, error?, logs}`
 * shape every other replay path returns.
 */
export function applyStateStep(
  win: InputHost | null,
  step: Step,
  point: { x: number; y: number } | null,
): StateStepResult {
  const logs: InputLogLine[] = [];
  const log = (level: LogLevel, m: string) =>
    logs.push({ i: logs.length, t: Date.now(), level, m });
  const state = step.elementState;

  if (!win || win.isDestroyed()) {
    const msg = "Step skipped — the training window is not open.";
    log("error", msg);
    return { ok: false, error: msg, logs };
  }

  let zoom = 1;
  try {
    zoom = win.webContents.getZoomFactor?.() ?? 1;
  } catch {
    zoom = 1;
  }

  const send = (
    type: "mouseMove" | "mouseDown" | "mouseUp",
    at: { x: number; y: number },
  ): string | null => {
    try {
      win.webContents.sendInputEvent({
        type,
        x: at.x,
        y: at.y,
        ...(type === "mouseMove" ? {} : { button: "left" as const, clickCount: 1 }),
      });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  if (state === "hover") {
    if (!point) {
      const msg = "Hover step has no target point.";
      log("error", msg);
      return { ok: false, error: msg, logs };
    }
    const at = toWindowPoint(point, zoom);
    const err = send("mouseMove", at);
    if (err) {
      log("error", `Could not move the pointer: ${err}`);
      return { ok: false, error: err, logs };
    }
    lastPoint = at;
    log("info", `Moved the pointer to (${at.x}, ${at.y}) — :hover styles now apply.`);
    return { ok: true, logs };
  }

  if (state === "press" || state === "release") {
    // A press with nothing to press ON is refused rather than defaulted to
    // (0, 0). `sendInputEvent` would happily accept the origin and click the
    // top-left corner of the page — a real click, on whatever is there, in the
    // user's live training window. Naming the missing Hover step is the whole
    // difference between a fixable message and a mystery navigation.
    if (!lastPoint) {
      const msg =
        state === "press"
          ? "Press needs a preceding Hover step — nothing has positioned the pointer yet."
          : "Release has no held button to let go of.";
      log("error", msg);
      return { ok: false, error: msg, logs };
    }
    const err = send(state === "press" ? "mouseDown" : "mouseUp", lastPoint);
    if (err) {
      log("error", `Could not ${state} the mouse button: ${err}`);
      return { ok: false, error: err, logs };
    }
    buttonDown = state === "press";
    log(
      "info",
      state === "press"
        ? `Pressed and held the left button at (${lastPoint.x}, ${lastPoint.y}) — :active styles now apply.`
        : "Released the left button.",
    );
    return { ok: true, logs };
  }

  const msg = `Unknown element state: ${String(state)}`;
  log("error", msg);
  return { ok: false, error: msg, logs };
}
