/** Hand-written types for step-semantics.mjs — see CLAUDE.md on why `shared/`
 *  is `.mjs` with a `.d.mts` beside it rather than TypeScript. */

/** How an expected value is compared against what the page reports. */
export interface MatchSemantics {
  match: "exact" | "substring" | "endsWith";
  caseSensitive: boolean;
  normalizeWhitespace: boolean;
}

/** Every assert kind that compares a string against the page, and how.
 *
 *  Kinds that compare no free-text value (`visible`, `count`, `css`, …) have no
 *  entry, so a lookup is legitimately `undefined` — callers must handle that
 *  rather than assume totality. */
export const ASSERT_SEMANTICS: Record<string, MatchSemantics | undefined>;

/** The same, for `wait` predicates and `if` conditions. */
export const WAIT_SEMANTICS: Record<string, MatchSemantics | undefined>;

/** The assert kind a wait/condition predicate shares its semantics with. */
export const WAIT_TO_ASSERT_KIND: Record<string, string | undefined>;

/** Escape regex metacharacters so a literal string can be embedded in a RegExp. */
export function reEscape(s: string | null | undefined): string;

/** The RegExp source a `toHaveURL`/`toHaveTitle` call needs for these
 *  semantics, e.g. `new RegExp("/cart\\?step=2", "i")`. */
export function textMatchExpr(value: string, semantics: MatchSemantics): string;

/** Compare what the page reports against what the step expects. */
export function matchesValue(
  actual: string | null | undefined,
  expected: string | null | undefined,
  semantics: MatchSemantics,
): boolean;

/** `matchesValue` as source text, for embedding in an injected script. */
export function matchSource(): string;

/** Playwright's visibility rule: a non-empty box, not hidden, not display:none.
 *  Opacity is deliberately not consulted — Playwright does not consider it. */
export function isVisibleByRect(
  rect: { width: number; height: number },
  style: { visibility: string; display: string },
): boolean;

/** `isVisibleByRect` as source text, for embedding in an injected script. */
export function visibilitySource(): string;
