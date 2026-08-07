// The Playwright methods that mutate or navigate the page — the canonical set
// every run-time fixture patches.
//
// This lives in its own module because TWO fixtures patch it now (capture takes
// a screenshot after each of these; settle waits for the page to quiet down
// after each of these), and they are written as separate source strings. Two
// hand-maintained copies of this list would drift the first time an action was
// added to one, and the failure is silent in the worst way: the step still
// runs, still screenshots, and simply never settles — a "crawl" run that
// quietly isn't crawling for that action.
//
// Interpolated into both fixture sources, so there is exactly one list.

/** Page-level actions: navigation and whole-page mutation. */
export const PAGE_ACTIONS = [
  "goto",
  "goBack",
  "goForward",
  "reload",
  "setViewportSize",
  "setContent",
] as const;

/** Locator-level actions: everything that touches an element. Patched on the
 *  Locator PROTOTYPE, so one patch covers every locator in the run. */
export const LOCATOR_ACTIONS = [
  "click",
  "dblclick",
  "fill",
  "press",
  "type",
  "check",
  "uncheck",
  "setChecked",
  "selectOption",
  "tap",
  "hover",
  "focus",
  "clear",
  "setInputFiles",
  "dragTo",
] as const;

/** Render a list as a JS array literal for embedding in a fixture source
 *  string. Values are known identifiers, but they go through JSON.stringify
 *  anyway — a fixture source is code, and nothing should be concatenated into
 *  code unquoted just because it "can't" contain a quote. */
export function actionsLiteral(actions: readonly string[]): string {
  return JSON.stringify(actions);
}
