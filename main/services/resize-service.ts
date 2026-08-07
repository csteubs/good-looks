// Apply a `viewport` step during trainer replay by actually resizing the
// training window, and report the dimensions it ended up at.
//
// WHY THIS IS NOT THE INJECTED REPLAYER'S JOB. A page cannot resize the window
// it is loaded in — `window.resizeTo` is a no-op for a non-script-opened
// window, and setting `innerWidth` is not a thing. The size lives on the native
// window, so this needs the host API, exactly like `cookie` steps need the
// session API. Both are dispatched from `runStep` in recorder-service.ts, which
// is the single place that decides which replay mechanism a step kind uses.
//
// Before this existed the trainer answered a `viewport` step with "applied at
// run time; not previewable" and moved on. That was the wrong shape of wrong:
// the step didn't merely go unpreviewed, EVERY LATER STEP in the replay then
// ran at whatever size the window happened to be, so a mobile-only menu button
// wouldn't resolve and the failure pointed at the click rather than at the
// resize that never happened.
//
// WHY CONTENT SIZE, NOT WINDOW SIZE. The recorded number is the PAGE size — a
// generated spec calls `page.setViewportSize` with it, and the trainer window
// is created with `useContentSize` when a preset applies. Sizing the frame
// instead would leave the page short by the title bar's height, so the trainer
// would preview a viewport a couple of dozen pixels shorter than the run.

import type { Step } from "../recorder/types.js";
import { normalizeViewport } from "../recorder/window-size.js";

type LogLevel = "info" | "warn" | "error";
export interface ResizeLogLine {
  i: number;
  t: number;
  level: LogLevel;
  m: string;
}

/** The slice of a trainer BrowserWindow a resize needs. Narrow on purpose, so
 *  the logic can be exercised without an SDK window. */
export interface ResizeHost {
  isDestroyed(): boolean;
  setContentSize(width: number, height: number, animate?: boolean): void;
  getContentSize(): [number, number];
}

/** The page's own measurement of itself, read back after the resize. */
export interface PageMetrics {
  innerWidth: number;
  innerHeight: number;
}

/** Read `window.innerWidth`/`innerHeight` out of the training page. Kept as a
 *  string constant so the injected expression is testable and identical
 *  everywhere it's used. */
export const PAGE_METRICS_SCRIPT =
  "({ innerWidth: window.innerWidth, innerHeight: window.innerHeight })";

function toMetrics(raw: unknown): PageMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  const { innerWidth, innerHeight } = raw as { innerWidth?: unknown; innerHeight?: unknown };
  if (typeof innerWidth !== "number" || typeof innerHeight !== "number") return null;
  if (!Number.isFinite(innerWidth) || !Number.isFinite(innerHeight)) return null;
  return { innerWidth: Math.round(innerWidth), innerHeight: Math.round(innerHeight) };
}

/**
 * The one line that says what a resize actually did.
 *
 * It prints THREE sizes because they routinely disagree and each disagreement
 * means something different:
 *   • requested — what the step asked for.
 *   • window    — what the OS granted. It clamps a window larger than the
 *     display, so a 1440-wide step on a 1280-wide laptop silently records one
 *     size and replays at another.
 *   • page      — what the document sees. Differs from the window size by the
 *     scrollbar's width, which is what actually flips a CSS breakpoint.
 *
 * A run that fails at a responsive breakpoint is unreadable without these, and
 * "resized to 390x844" alone would assert the very thing that didn't happen.
 */
export function formatResizeLog(
  requested: { width: number; height: number },
  content: [number, number],
  page: PageMetrics | null,
): string {
  const base =
    `Resized the training window to ${requested.width}x${requested.height} ` +
    `(window ${content[0]}x${content[1]}`;
  return page ? `${base}, page ${page.innerWidth}x${page.innerHeight})` : `${base}, page unknown)`;
}

/**
 * Apply a `viewport` step to the training window.
 *
 * Returns the same `{ok, error?, logs}` shape the injected replayer returns, so
 * every replay path can treat it uniformly.
 */
export async function applyViewportStep(
  win: ResizeHost | null,
  step: Step,
  evaluate: (script: string) => Promise<unknown>,
): Promise<{ ok: boolean; error?: string; logs: ResizeLogLine[] }> {
  const logs: ResizeLogLine[] = [];
  const log = (level: LogLevel, m: string) => logs.push({ i: logs.length, t: Date.now(), level, m });

  if (!win || win.isDestroyed()) {
    const msg = "Resize skipped — the training window is not open.";
    log("error", msg);
    return { ok: false, error: msg, logs };
  }

  // Same normalization the session-open path uses, so a step and a preset can
  // never resolve to different sizes. A step whose numbers didn't survive it
  // has no size to apply, and guessing one would resize to something the user
  // never recorded.
  const size = normalizeViewport({ width: step.width, height: step.height });
  if (!size) {
    const msg = "Resize step has no usable width and height.";
    log("error", msg);
    return { ok: false, error: msg, logs };
  }

  log("info", `Resizing the training window to ${size.width}x${size.height}`);
  try {
    win.setContentSize(size.width, size.height);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `Could not resize the training window: ${msg}`);
    return { ok: false, error: msg, logs };
  }

  // Measuring is best-effort: the resize itself already succeeded, and the page
  // can be mid-navigation or gone. A failed read costs the log its page numbers
  // and nothing else — failing the step here would report a resize that
  // happened as one that didn't.
  let content: [number, number] = [size.width, size.height];
  try {
    const measured = win.getContentSize();
    if (Array.isArray(measured) && measured.length === 2) content = [measured[0], measured[1]];
  } catch {
    /* keep the requested size as the best available answer */
  }
  let page: PageMetrics | null = null;
  try {
    page = toMetrics(await evaluate(PAGE_METRICS_SCRIPT));
  } catch {
    page = null;
  }

  log("info", formatResizeLog(size, content, page));
  if (content[0] !== size.width || content[1] !== size.height) {
    log(
      "warn",
      `The window did not reach the requested size — the display may be smaller than ${size.width}x${size.height}. ` +
        "A run resizes the page directly and is not subject to this limit.",
    );
  }
  return { ok: true, logs };
}
