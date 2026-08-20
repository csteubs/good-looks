/** Hand-written types for step-semantics.mjs — see CLAUDE.md on why `shared/`
 *  is `.mjs` with a `.d.mts` beside it rather than TypeScript. */

/** How an expected value is compared against what the page reports. */
export interface MatchSemantics {
  match: "exact" | "substring" | "endsWith";
  caseSensitive: boolean;
  normalizeWhitespace: boolean;
  /** Which part of the value the comparison applies to. Absent means the whole
   *  string; "path" means the URL's pathname (query and fragment ignored), and
   *  such kinds compare via `urlPathPattern`, never via `matchesValue`. */
  part?: "path";
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
export function textMatchExpr(
  value: string,
  semantics: MatchSemantics,
  varNames?: ReadonlySet<string>,
): string;

/** Escape text for the inside of an emitted template literal. */
export function escapeForTemplate(s: string): string;

/** The regex-pattern source for a value that may reference `${name}`
 *  variables. Without a declared reference this is byte-identical to a
 *  JSON string literal of the reEscape'd value. */
export function regexPatternExpr(
  value: string | null | undefined,
  varNames?: ReadonlySet<string>,
  prefix?: string,
  suffix?: string,
): string;

/** The inverse of `regexPatternExpr`'s template branch — pattern text with
 *  `${name}` restored, or null when the source is not one this module
 *  emitted. */
export function regexPatternFromTemplate(source: string | null | undefined): string | null;

/** Compare what the page reports against what the step expects. */
export function matchesValue(
  actual: string | null | undefined,
  expected: string | null | undefined,
  semantics: MatchSemantics,
): boolean;

/** `matchesValue` as source text, for embedding in an injected script. */
export function matchSource(): string;

/** RegExp source (no flags) for a "URL path is" assertion — test against the
 *  full URL with the "i" flag. Query string and fragment are ignored, one
 *  trailing slash is tolerated. */
export function urlPathPattern(value: string | null | undefined): string;

/** `urlPathPattern` as source text, for embedding in an injected script. */
export function urlPathSource(): string;

/** The `toHaveURL` argument for a "URL path is" assertion, as JS source. */
export function urlPathExpr(
  value: string | null | undefined,
  varNames?: ReadonlySet<string>,
): string;

/** The structural frame `urlPathPattern` wraps a path in — the ends the
 *  parser recognises a "URL path is" assertion by. */
export const URL_PATH_PREFIX: string;
export const URL_PATH_SUFFIX: string;

/** The slash rules a path value carries before it becomes a pattern. */
export function normalizeUrlPath(value: string | null | undefined): string;

/** Playwright's visibility rule: a non-empty box, not hidden, not display:none.
 *  Opacity is deliberately not consulted — Playwright does not consider it. */
export function isVisibleByRect(
  rect: { width: number; height: number },
  style: { visibility: string; display: string },
): boolean;

/** `isVisibleByRect` as source text, for embedding in an injected script. */
export function visibilitySource(): string;
