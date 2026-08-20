// Shared recorder data model (backend). Mirror kept in renderer/lib/recorder-types.ts.

import type { LlmErrorKind } from "../services/llm/types.js";
// Declared in shared/ because the settings store validates against the same
// list the Settings pane offers and the Cost panel formats with — see the
// header of `shared/cost-units.mjs`.
import type { CostCurrency } from "../../shared/cost-units.mjs";
// Same arrangement for the proxy vocabulary: the store validates with the
// same guards the Settings pane offers options from, and the MCP server
// applies the same rules to the runs it spawns.
import type { ProxySource, ProxyTraffic } from "../../shared/proxy-config.mjs";
// The test-id attribute vocabulary lives in shared/ because the selector it
// produces is spelled identically by the generator, the runner's heal key,
// the heal fixture and the renderer's locator renderings — see the header of
// `shared/testid-attr.mjs`.
import { TESTID_ATTRIBUTE_OVERRIDES, type TestIdAttributeOverride } from "../../shared/testid-attr.mjs";

export type { CostCurrency };
export type { ProxySource, ProxyTraffic };
export type { TestIdAttributeOverride };

export type StepType =
  | "goto"
  | "click"
  | "fill"
  | "press"
  | "select"
  | "check"
  | "uncheck"
  | "assert"
  | "wait"
  | "viewport"
  // Logic layer: `if` opens a conditional block, `endif` closes it. Steps
  // between them run only when the condition holds; otherwise they're skipped
  // and the test continues gracefully.
  | "if"
  | "endif"
  // Cookie state. Applied through the browser session rather than injected JS,
  // because an httpOnly cookie is invisible to document.cookie by definition.
  | "cookie"
  // Variable layer: `capture` reads a value off the page into the run's
  // variable scope; `runFlow` inlines another test's steps as a reusable flow.
  | "capture"
  | "runFlow"
  // Pseudo-state layer: puts an element into :hover / :focus / :active so the
  // assertion AFTER it measures the styled state rather than the resting one.
  | "state";

/**
 * Predicate for an `if` step. Element conditions resolve `Step.locator`; page
 * conditions (urlContains/titleContains) use `Step.value` as the substring.
 */
export type ConditionKind =
  | "visible"
  | "hidden"
  | "exists"
  | "enabled"
  | "disabled"
  | "checked"
  | "unchecked"
  | "urlContains"
  | "titleContains";

/**
 * Predicate a `wait` step blocks on until it holds (`Step.waitUntil`).
 *
 * A superset of ConditionKind, kept as its OWN type rather than an alias with
 * extras: an `if` block evaluates its condition once, so widening the wait
 * vocabulary must not silently widen what a condition accepts — the two
 * normalizers check against separate lists for exactly that reason.
 *
 * Element predicates resolve `Step.locator`; `text`/`value` read `Step.text` /
 * `Step.value`, `count` reads `Step.count`, and urlContains/titleContains match
 * `Step.value` against the page.
 */
export type WaitUntilKind =
  | "visible"
  | "hidden"
  | "exists"
  | "enabled"
  | "disabled"
  | "checked"
  | "unchecked"
  | "text"
  | "value"
  | "count"
  | "urlContains"
  | "titleContains";

export type LocatorKind = "testid" | "role" | "label" | "placeholder" | "text" | "css" | "xpath";

/**
 * What the USER said about which element they meant — the disambiguation the
 * recorder cannot infer.
 *
 * The recorder resolves ambiguity alone today: `pickLocator` asks the page how
 * many elements each candidate matches and, when none is unique, writes
 * `nth`. That is an index into DOM order — it works now and breaks the day the
 * page reorders, and it is the app admitting it had to guess. The user watching
 * that happen knows the answer ("the Edit button in the Billing card") and has
 * nowhere to put it. This is that place.
 *
 * THREE SHAPES ONLY, and the restriction is what makes the feature total: each
 * one is something Playwright expresses natively, so every context the picker
 * can offer is a context the generator can emit and the parser can read back.
 *
 *   within        → a chained builder,  page.getByTestId("billing").getByRole(…)
 *   withinHasText → .filter({ hasText }) on the container
 *   and           → .and(page.locator(…)) on the target
 *
 * A pinned attribute is an `and` entry of kind `css` rather than a field of its
 * own, for the same reason: one emission path, not one per property kind.
 *
 * Context hangs off the LOCATOR rather than the Step because every resolver in
 * the app already takes a `Locator` — the capture script's `matchesFor`, the
 * replayer, the heal probe, the generator, the parser — as do heal candidates
 * and fingerprint candidates. A field on Step would have to be threaded through
 * each of them by hand, and the one that got missed would fail silently.
 */
export interface LocatorContext {
  /** An ancestor the target must live inside. Never itself carries a `ctx` —
   *  see `normalizeLocator`. */
  within?: Locator;
  /** Text the CONTAINER must contain — the "which row?" question. Meaningless
   *  without `within` (there is nothing to filter), and dropped in that case
   *  rather than reinterpreted as a filter on the target: a context that
   *  silently changes what it constrains is worse than one that is absent. */
  withinHasText?: string;
  /** Extra predicates the TARGET itself must satisfy. */
  and?: Locator[];
}

export interface Locator {
  k: LocatorKind;
  /** value for testid/label/placeholder/text/css/xpath */
  v?: string;
  /**
   * For a testid locator: WHICH test-id attribute matched at record time,
   * when it was not data-testid. Absent means data-testid — the only
   * attribute `getByTestId` resolves, since nothing in this repo configures
   * Playwright's `testIdAttribute`.
   *
   * This exists because the capture script accepts data-test-id and data-test
   * as test ids too, and used to record all three as the same bare locator.
   * The trainer's oracle counted matches across all three attributes, so the
   * step was declared unique and replayed green — and the emitted
   * `getByTestId()` then matched nothing on every run. The generator spells a
   * non-default attribute out as an attribute selector instead; see
   * shared/testid-attr.mjs for the one definition of that spelling.
   */
  attr?: TestIdAttributeOverride;
  /** aria role for role locators */
  role?: string;
  /** accessible name for role locators */
  name?: string;
  /**
   * Which of several matches this locator meant, 0-based. ABSENT when the
   * locator resolves to exactly one element, which is the case the recorder
   * works hard to reach — see `locatorFor` in capture-script.ts.
   *
   * This exists because Playwright runs in STRICT MODE: a locator resolving to
   * two elements is not "the first one", it is an error that fails the step.
   * The recorder used to emit locators on the untested assumption that a name,
   * a label or a run of text identified one element, and every such step was a
   * strict-mode violation waiting for the page to grow a second match. The one
   * that prompted this was `getByText("Browser")` against firefox.com, which has
   * two.
   *
   * A last resort, and deliberately so: an index picks by DOM order, so it
   * breaks the day the page reorders. Every unique candidate is preferred over
   * it, and it is only written when NONE of them is unique — at which point the
   * honest choice is between an index that works now and a locator that has
   * already failed.
   */
  nth?: number;
  /** User-pinned disambiguation. Absent on the overwhelming majority of
   *  locators, and absent on every locator recorded before this existed. */
  ctx?: LocatorContext;
}

export type AssertKind =
  | "visible"
  | "hidden"
  | "text"
  | "exactText"
  | "enabled"
  | "disabled"
  | "checked"
  | "unchecked"
  | "value"
  | "attribute"
  | "count"
  | "url"
  | "urlEndsWith"
  | "urlIs"
  // The URL's PATH alone, exactly — query string and #fragment ignored, one
  // trailing slash tolerated. The robust default for "did the navigation land
  // where I meant": the three kinds above compare the FULL URL, and every URL
  // assertion recorded in this app's own store had failed on query noise
  // (`?variant=`, `utm_*`) that differed between the recording and the run.
  | "urlPathIs"
  // `title` is an EXACT whole-title match, which is what its "Page title is"
  // label has always promised and what the generator has always emitted. The
  // trainer's replayer read it as a case-insensitive substring, so "Cart"
  // passed live against a page titled "Cart | Acme" and then failed in every
  // run. Aligning the replayer to the label would have removed the only way to
  // assert on part of a title, so `titleContains` exists to keep that reachable
  // — it is the assert counterpart of the `titleContains` wait, which the
  // vocabulary was already missing.
  | "title"
  | "titleContains"
  // Computed CSS property, e.g. background-color is "rgb(0, 82, 204)". Reads
  // `Step.cssProp` / `Step.cssMatch`, with the expected value in `Step.value`.
  | "css";

/**
 * Pseudo-state a `state` step puts an element into (`Step.elementState`).
 *
 * Each one emits EXACTLY ONE awaited statement, which is not a stylistic
 * choice: `generateSpecDetailed` records one spec line per step in its line
 * map, and the `buildStepLineMap` fallback for hand-edited specs classifies
 * steps by counting leading-`await` lines. A step emitting two awaited
 * statements shifts every later step's run highlight by one.
 *
 * That is why `:active` and `:focus-visible` are not members here — they need
 * two calls apiece, so the Add-step dialog emits them as SEVERAL ordinary rows
 * (the same shape the "Wait until" dialog uses for multiple ticked properties):
 *   :active         → hover, press, <the assertion>, release
 *   :focus-visible  → press "Tab" (a plain `press` step), focus
 *
 * `press`/`release` carry no locator. `page.mouse.down()` acts wherever the
 * cursor already is, which is what the preceding `hover` put there.
 */
export type ElementState = "hover" | "focus" | "press" | "release";

/** How a `css` assertion compares the computed value against the expected one. */
export type CssMatch = "is" | "contains";

export interface Step {
  id: string;
  type: StepType;
  locator?: Locator;
  /** fill value / selectOption value / key for press / expected value for value/attribute/url/title asserts */
  value?: string;
  /** human-friendly label (e.g. selected option text) */
  label?: string;
  /** goto url */
  url?: string;
  /** assertion kind when type === "assert" */
  assert?: AssertKind;
  /** condition predicate when type === "if" */
  cond?: ConditionKind;
  /** assertion text / extra description */
  text?: string;
  /** soft assertion — reports a failure but doesn't stop the test (expect.soft) */
  soft?: boolean;
  /** attribute name for an "attribute" assertion */
  attr?: string;
  /** CSS property for a "css" assertion, as a KEBAB-case name
   *  ("background-color", not "backgroundColor"). Playwright reads it through
   *  `getComputedStyle().getPropertyValue()`, which answers "" for a camelCase
   *  name — so a camelCase property would compare an empty string against the
   *  expected value and fail for a reason nothing on screen explains. */
  cssProp?: string;
  /** how a "css" assertion compares (default "is"). */
  cssMatch?: CssMatch;
  /** the pseudo-state a `state` step applies. */
  elementState?: ElementState;
  /** expected element count for a "count" assertion */
  count?: number;
  /** viewport width when type === "viewport" */
  width?: number;
  /** viewport height when type === "viewport" */
  height?: number;
  /** wait duration in ms when type === "wait" (omit to wait for the locator instead) */
  waitMs?: number;
  /** predicate a `wait` step blocks on until it holds. Takes precedence over
   *  waitMs / a bare locator wait, which stay exactly as they were so every
   *  test already on disk regenerates byte-identically. */
  waitUntil?: WaitUntilKind;
  /** how long a `waitUntil` step waits before failing, in ms. Reaches the
   *  generator as a BARE NUMERAL — see normalizeRawStep's `int` note. */
  timeoutMs?: number;
  /** what a `cookie` step does */
  cookieAction?: CookieAction;
  /** the cookie a `cookie` step sets or deletes (absent for clearAll) */
  cookie?: CookieSpec;
  /** true when the runner should swallow this step's failure and continue to
   *  the next step instead of stopping the test. Emitted as a try/catch wrapper
   *  around the step's line in the generated spec. */
  continueOnFailure?: boolean;
  /** true when the user disabled this step. The runner skips it (logging that
   *  it was skipped because it was disabled) and the generated spec emits the
   *  step's line commented out so the test passes. The step stays in the list
   *  and keeps its index/position. */
  disabled?: boolean;
  /** variable a `capture` step writes its read value into. */
  captureVar?: string;
  /** what a `capture` step reads off the resolved element (default "text"). */
  captureFrom?: CaptureSource;
  /** attribute name when `captureFrom === "attribute"`. */
  captureAttr?: string;
  /** id of the flow (another TestRecord) a `runFlow` step invokes. */
  flowId?: string;
  /** argument bindings for a `runFlow` step: flow parameter name → value
   *  expression (which may itself interpolate `${var}` from the caller). */
  flowArgs?: Record<string, string>;
  /** names of the variables this step's value/text/url interpolates. Derived on
   *  write by `collectVarRefs` — never hand-maintained — so the editor can warn
   *  before deleting a variable something still references. */
  varRefs?: string[];
  /** What the target element looked like when this step was recorded. Absent on
   *  steps recorded before fingerprinting existed, and on steps with no element
   *  (goto, wait, viewport, cookie). Used by Auto-Heal — see ElementFingerprint. */
  fingerprint?: ElementFingerprint;
  timestamp: number;
}

/**
 * The recorded identity of a step's target element.
 *
 * Auto-Heal previously had only `Step.locator` — ONE strategy, chosen by
 * `locatorFor` — and had to infer from it what the user meant. That inference
 * needed three separate bug fixes, and the commonest real heal (a renamed
 * testid on an element whose visible label never changed) still scored at zero,
 * because nothing recorded that the label had ever been part of the element's
 * identity.
 *
 * Recording the whole identity at capture time turns "guess what this locator
 * was trying to point at" into "find the element that best matches what we
 * saw", which is a question with an answer.
 */
export interface ElementFingerprint {
  /** lowercase tag name */
  tag: string;
  /** human-readable descriptor, e.g. "button#submit.btn-primary" */
  description: string;
  /** EVERY locator strategy that applied at record time, best-first. The
   *  load-bearing field: a candidate matching any of these is strong evidence,
   *  even when the one locator the step uses has gone stale. */
  candidates: Locator[];
  /** curated attributes (id, class, type, name, role, href, placeholder,
   *  aria-label) */
  attributes: Record<string, string>;
  /** the element's own trimmed text, capped */
  text?: string;
  /** nearest preceding heading/label text — survives the element's own text
   *  changing, which is the case a text locator can't heal on its own */
  neighborText?: string;
  /** how deep the element sat in the document */
  depth: number;
  /** viewport-normalized box (same 0–1 convention as the capture fixture's
   *  elementRect), so a heal candidate's geometry can be compared to it */
  rect?: { x: number; y: number; w: number; h: number };
}

/** What a `capture` step reads off its resolved element. */
export type CaptureSource = "text" | "value" | "attribute" | "url" | "title";

export const CAPTURE_SOURCES: CaptureSource[] = ["text", "value", "attribute", "url", "title"];

export function isCaptureSource(v: unknown): v is CaptureSource {
  return typeof v === "string" && (CAPTURE_SOURCES as string[]).includes(v);
}

/** Payload emitted by the injected capture script (before backend enrichment). */
export interface RawStep {
  type: StepType;
  locator?: Locator;
  value?: string;
  label?: string;
  url?: string;
  assert?: AssertKind;
  cond?: ConditionKind;
  text?: string;
  soft?: boolean;
  attr?: string;
  cssProp?: string;
  cssMatch?: CssMatch;
  elementState?: ElementState;
  count?: number;
  width?: number;
  height?: number;
  waitMs?: number;
  waitUntil?: WaitUntilKind;
  timeoutMs?: number;
  /** cookie fields, so a cookie step can be inserted via insertStep */
  cookieAction?: CookieAction;
  cookie?: CookieSpec;
  /** capture/flow fields, so those steps can be inserted via insertStep */
  captureVar?: string;
  captureFrom?: CaptureSource;
  captureAttr?: string;
  flowId?: string;
  flowArgs?: Record<string, string>;
  /** the target element's recorded identity, attached by the capture script */
  fingerprint?: ElementFingerprint;
}

export type TestSpeed = "crawl" | "slow" | "medium" | "fast";

/** Every speed, SLOWEST FIRST — the order the sidebar slider's stops are in.
 *  Exported so the UI lists, the settings validator and the `tests:setSpeed`
 *  handler all derive from one array: the previous arrangement re-declared the
 *  set in six places, and a speed accepted by one entry point but rejected by
 *  another is a bug with no error message. */
export const TEST_SPEEDS: TestSpeed[] = ["crawl", "slow", "medium", "fast"];

/** Display labels for the speed pickers. */
export const TEST_SPEED_LABELS: Record<TestSpeed, string> = {
  crawl: "Crawl",
  slow: "Slow",
  medium: "Medium",
  fast: "Fast",
};

export function isTestSpeed(v: unknown): v is TestSpeed {
  return typeof v === "string" && (TEST_SPEEDS as string[]).includes(v);
}

/** Playwright browser engine a test run uses. The trainer always uses the
 *  app's own WebView and is unaffected by this. */
export type RunBrowser = "chromium" | "firefox" | "webkit";

export const RUN_BROWSERS: RunBrowser[] = ["chromium", "firefox", "webkit"];

export function isRunBrowser(v: unknown): v is RunBrowser {
  return typeof v === "string" && (RUN_BROWSERS as string[]).includes(v);
}

/** How big the app's own interface is drawn, as a zoom factor.
 *
 *  A CLOSED SET, and the validator below is membership rather than a range
 *  clamp — on purpose. This number is handed to `webContents.setZoomFactor`
 *  for every app window (see `main/services/ui-scale.ts`), and a `0`, a `NaN`
 *  or a `1e9` arriving through `recorder:setSettings` does not degrade, it
 *  makes every window unreadable — INCLUDING the Settings window, which is the
 *  only place the value can be changed back. A clamp would still accept a
 *  garbage type and round it into range; four allowed values cannot be wedged. */
export type UiScale = 0.9 | 1 | 1.1 | 1.25;

export const UI_SCALES: UiScale[] = [0.9, 1, 1.1, 1.25];

export function isUiScale(v: unknown): v is UiScale {
  return typeof v === "number" && (UI_SCALES as number[]).includes(v);
}

/** Which typeface pairing the interface is set in.
 *
 *  A NAME, never a font family. The name is what crosses IPC and what is
 *  stored; the families themselves live in `renderer/theme/tokens.css` and are
 *  selected by a `data-gl-typeface` attribute. A free-text family would be a
 *  string from an IPC caller landing inside a `font-family` declaration, and
 *  there is no useful way to validate one — an enum of three has nothing to
 *  validate against a stylesheet at all. */
export type UiTypeface = "space" | "system" | "classic";

export const UI_TYPEFACES: UiTypeface[] = ["space", "system", "classic"];

export function isUiTypeface(v: unknown): v is UiTypeface {
  return typeof v === "string" && (UI_TYPEFACES as string[]).includes(v);
}

/** How often the AI insights report generates. An enum for the same reason a
 *  Routine schedule is: every value comes from a picker, so a cadence that
 *  never fires — the failure mode a free-form value invites — cannot be
 *  expressed. Validated on BOTH read and set (see the settings store). */
export type InsightsCadence = "daily" | "weekly" | "monthly";

export const INSIGHTS_CADENCES: InsightsCadence[] = ["daily", "weekly", "monthly"];

export function isInsightsCadence(v: unknown): v is InsightsCadence {
  return typeof v === "string" && (INSIGHTS_CADENCES as string[]).includes(v);
}

export interface TestRecord {
  id: string;
  name: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  steps: Step[];
  /** absolute path to the generated .spec.ts file */
  scriptPath: string;
  /** true once the script has been hand-edited, so it's no longer regenerated from steps */
  scriptEdited?: boolean;
  /** playback speed for runs (adds a slowMo delay between actions); defaults to
   *  "fast" (no delay). "crawl" additionally waits for the page to settle after
   *  every action — see settle-fixture-source.ts. */
  speed?: TestSpeed;
  /** absolute path to the folder a test was imported from, so its sibling
   *  modules (e.g. `./helpers.js`) can be re-copied into the scripts dir */
  sourceDir?: string;
  /** absolute path to the ROOT of the imported project, which bounds what that
   *  test's spec is allowed to pull in. Absent on tests imported before the
   *  import sandbox existed — see `repairImports` for what that costs them. */
  sourceRoot?: string;
  /** Base URL a spec's relative navigations resolve against, carried over from
   *  the imported project's own `playwright.config` (or typed in afterwards).
   *
   *  Only imported tests have one. A recorded test navigates to an absolute URL
   *  because the recorder watched it happen, but a hand-written suite is
   *  idiomatically relative — `page.goto("/")` — and that is meaningless
   *  without this. Travels to a run as `PW_BASE_URL`, which the generated
   *  config reads into `use.baseURL`; absent means the config declares none,
   *  exactly as before this field existed.
   *
   *  Always an http(s) URL: `normalizeBaseUrl` in `imported-config.ts` is the
   *  only way a value gets in, whether it came from a config file we parsed or
   *  from an IPC caller. */
  baseUrl?: string;
  /** true when the user removed the test from the sidebar view — the record
   *  and its script file are kept on disk; the sidebar just hides it. */
  hidden?: boolean;
  /** true when the steps on record and the .spec.ts that actually runs are not
   *  the same test. See `stepsDivergedReason` for which way round. */
  stepsDiverged?: boolean;
  /** Why the two are out of sync, so the warning can be acted on rather than
   *  merely noticed. `"parse"`: the script was resynced to steps (e.g. after an
   *  LLM-apply) and the parser skipped statements it couldn't classify, so the
   *  steps UNDERCOUNT the script. `"unapplied"`: edited steps were saved
   *  against a script that isn't generated from them, so the script — and every
   *  run — is missing those edits. Absent on records written before the reason
   *  was tracked; treat that as `"parse"`, the only cause that existed then. */
  stepsDivergedReason?: "parse" | "unapplied";
  /** true when the user has waved the divergence warning off. Kept on the record
   *  rather than in renderer state so it survives leaving the test — a warning
   *  you can only silence until you click away is one you learn to read past.
   *
   *  Cleared whenever divergence is ESTABLISHED AFRESH — an apply whose script
   *  won't fully parse back into steps, or a step edit saved without
   *  regenerating. So the banner returns for a new divergence and stays gone for
   *  the one already acknowledged, which is the whole distinction. */
  stepsDivergedDismissed?: boolean;
  /** Visual-diff sensitivity for capture runs (Phase 3): the percent of pixels
   *  (0–100) allowed to change vs the pinned baseline before a step is flagged
   *  "visual change detected". Absent → DEFAULT_VISUAL_THRESHOLD. */
  visualThreshold?: number;
  /** Regions of the page to ignore when visual-diffing capture runs. Dynamic
   *  content (timestamps, carousels, ads) would otherwise flag a change on
   *  every run. Absent/empty → nothing is masked. */
  visualMasks?: VisualMask[];
  /** Step ids compared ELEMENT-scoped (cropped to the element's recorded
   *  rectangle) instead of page-wide. Absent/empty → every step is page-level,
   *  which stays the default. */
  visualElementSteps?: string[];
  /** Per-test accessibility-check preference, remembered between sessions.
   *  When absent, the global `RecorderSettings.defaultA11yChecks` applies.
   *  Independent of `captureArtifacts`: axe costs far more than a screenshot,
   *  so asking for one must not silently buy the other. */
  a11yChecks?: boolean;
  /** Violations the user has accepted for this test, keyed by step id. Only
   *  violations NOT in this set are flagged. Without it, the first run against
   *  any real site reports dozens of pre-existing problems and the feature is
   *  ignored from then on. */
  a11yBaseline?: Record<string, string[]>;
  /** Per-test console+network recording preference, remembered between
   *  sessions. When absent, `RecorderSettings.defaultRecordLogs` applies.
   *  Independent of `captureArtifacts` again: this one writes page-controlled
   *  text and request URLs to disk, so it must never be bought by asking for
   *  screenshots. */
  recordLogs?: boolean;
  /** Per-test screenshot-capture preference, remembered between sessions.
   *  When absent, the global `RecorderSettings.defaultCaptureArtifacts`
   *  applies. Set from the test detail toolbar's "Capture screenshots" toggle. */
  captureArtifacts?: boolean;
  /** Per-test headless-run preference, remembered between sessions. When absent,
   *  the global `RecorderSettings.defaultRunHeadless` applies. Set from the test
   *  detail toolbar's "Run headless" toggle. Only affects test runs, not the
   *  trainer. */
  runHeadless?: boolean;
  /** Per-test browser-engine preference, remembered between sessions. When
   *  absent, the global `RecorderSettings.defaultRunBrowser` applies. Set from
   *  the test detail toolbar's browser picker. Only affects test runs. */
  runBrowser?: RunBrowser;
  /** Per-test Playwright timeout in ms (how long one test may run before
   *  Playwright fails it). When absent, `RecorderSettings.defaultTestTimeoutMs`
   *  applies. Set from the test detail toolbar. Only affects test runs. */
  testTimeoutMs?: number;
  /** Free-form labels used to group tests (e.g. "smoke", "checkout").
   *  Normalized by `normalizeTags` on write — the backend is the single source
   *  of truth, so the renderer sends raw strings and renders what comes back.
   *  Absent/empty means untagged. */
  tags?: string[];
  /** The one folder this test lives in, in the library rail (REDESIGN §7.2).
   *
   *  A GROUP IS NOT A TAG, and the difference is exactly one word: `one`. Tags
   *  are many-to-many labels for SELECTION — the Batch checklist filters by
   *  them, and a test being both `smoke` and `checkout` is the point. A group
   *  is a PLACE in a navigation rail, so a test needs exactly one home: with
   *  many, a test would be drawn under several folders and the counts would not
   *  add up to the library. Hence a single string, not a list.
   *
   *  THE NAME IS THE IDENTITY — there is no groups store. A group is a tag you
   *  can only have one of, so it needs no more machinery than a tag does, and a
   *  second entity with its own file, its own ids and its own orphan cleanup
   *  would be a parallel system to maintain for a folder. Two consequences,
   *  both wanted: groups sort alphabetically for free and deterministically,
   *  and a group with no members ceases to exist — which is the right rule for
   *  a rail folder, since a row with nothing under it is a row you can only
   *  collapse.
   *
   *  Normalized by `normalizeGroup` on write. Absent/empty means ungrouped. */
  group?: string;
  /** Named values this test's steps can interpolate with `${name}`. Normalized
   *  by `normalizeVariables` on write. A "secret" variable's value is NOT here —
   *  it lives encrypted in test-secrets-store and is injected as an env
   *  reference at generation time, so it never reaches the spec file or IPC. */
  variables?: TestVariable[];
  /** Rows of variable values this test can be swept over. Each row produces its
   *  own run (and its own RunRecord) when the test is run as a sweep. */
  datasets?: Dataset[];
  /** true when this test is a reusable flow — a step sequence meant to be
   *  inlined into other tests via a `runFlow` step rather than run on its own.
   *  A flow is an ordinary TestRecord (same library, tags, trainer and MCP
   *  surface); this flag only hides it from the Batch checklist, the same way
   *  `hidden` hides a test from the sidebar. */
  isFlow?: boolean;
  /** Parameter names a flow accepts. A `runFlow` step supplies a value for each
   *  via `flowArgs`; unsupplied parameters fall back to the flow's own variable
   *  defaults. Meaningless unless `isFlow`. */
  flowParams?: string[];
}

/** How a variable's value is sourced. "plain" is stored on the record;
 *  "secret" is stored encrypted and referenced via env at run time; "captured"
 *  has no stored value at all — it's written during the run by a `capture`
 *  step, and any default here is only a fallback for steps that read it before
 *  the capture happens. */
export type VariableKind = "plain" | "secret" | "captured";

export const VARIABLE_KINDS: VariableKind[] = ["plain", "secret", "captured"];

export function isVariableKind(v: unknown): v is VariableKind {
  return typeof v === "string" && (VARIABLE_KINDS as string[]).includes(v);
}

export interface TestVariable {
  /** identifier used in `${name}` interpolation; see `isValidVariableName` */
  name: string;
  /** default value. Always absent for "secret" — a secret's value never lives
   *  on the record, only in the encrypted store. */
  value?: string;
  kind: VariableKind;
  description?: string;
}

/** One row of variable values a test can be swept over. */
export interface Dataset {
  id: string;
  /** display name, used in the run history so a failing row is identifiable */
  name: string;
  /** variable name → value for this row. Names not declared as variables on
   *  the test are ignored at generation time rather than injected blindly. */
  values: Record<string, string>;
}

/** Bounds — generous in practice, tight enough that a paste accident can't
 *  write a megabyte into tests.json. */
export const MAX_VARIABLE_NAME_LENGTH = 40;
export const MAX_VARIABLE_VALUE_LENGTH = 2000;
export const MAX_VARIABLES_PER_TEST = 50;
export const MAX_DATASETS_PER_TEST = 100;

/**
 * A variable name must be a plain JS identifier: it becomes a property access
 * (`V.name`) in the generated spec, so anything else would emit a spec that
 * doesn't parse. Rejecting at the boundary is what keeps that guarantee — the
 * generator never has to escape or quote a name.
 */
export function isValidVariableName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length <= MAX_VARIABLE_NAME_LENGTH &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
  );
}

/**
 * Canonicalize a set of variables: drop invalid names, dedupe by name
 * (case-SENSITIVE — `user` and `User` are different JS properties, so folding
 * them would silently merge two distinct variables), truncate over-long values,
 * strip any value from a secret, and cap the count.
 *
 * Accepts `unknown` because it sits directly behind an IPC boundary.
 */
export function normalizeVariables(input: unknown): TestVariable[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: TestVariable[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Partial<TestVariable>;
    if (!isValidVariableName(v.name)) continue;
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    const kind: VariableKind = isVariableKind(v.kind) ? v.kind : "plain";
    const entry: TestVariable = { name: v.name, kind };
    // A secret's value never round-trips through the record — it would land in
    // tests.json in plaintext, which is the exact thing the encrypted store
    // exists to prevent.
    if (kind !== "secret" && typeof v.value === "string") {
      entry.value = v.value.slice(0, MAX_VARIABLE_VALUE_LENGTH);
    }
    if (typeof v.description === "string" && v.description.trim()) {
      entry.description = v.description.trim().slice(0, 200);
    }
    out.push(entry);
    if (out.length >= MAX_VARIABLES_PER_TEST) break;
  }
  return out;
}

/**
 * Fold the variables declared during a trainer session back into the ones the
 * stored record already had.
 *
 * Upsert by name, session wins. NOT a replacement: the trainer can only ADD a
 * variable, so anything the record carries that the session doesn't know about
 * came from the Variables tab — possibly in another window, while the session
 * was open — and rebuilding the list from the session alone would delete it.
 * That is the same failure `finalize` avoids by spreading the existing record
 * first, applied to the one field the trainer now writes.
 *
 * Order is existing-first so a variable keeps the row it had; a name only the
 * session has is appended. Normalized on the way out, so the cap and the
 * secret-value strip apply to the merged list rather than to each half.
 */
export function mergeSessionVariables(
  existing: TestVariable[] | undefined,
  session: TestVariable[] | undefined,
): TestVariable[] {
  const fromSession = new Map((session ?? []).map((v) => [v.name, v]));
  const merged: TestVariable[] = [];
  for (const v of existing ?? []) {
    merged.push(fromSession.get(v.name) ?? v);
    fromSession.delete(v.name);
  }
  merged.push(...fromSession.values());
  return normalizeVariables(merged);
}

/**
 * Canonicalize datasets: require an id and a name, keep only string values,
 * truncate over-long ones, and cap the count. Values for variables the test
 * doesn't declare are kept here (the user may be mid-edit) but ignored at
 * generation time.
 */
export function normalizeDatasets(input: unknown): Dataset[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: Dataset[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const d = raw as Partial<Dataset>;
    if (typeof d.id !== "string" || !d.id) continue;
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const name = typeof d.name === "string" && d.name.trim() ? d.name.trim().slice(0, 80) : d.id;
    const values: Record<string, string> = {};
    if (d.values && typeof d.values === "object") {
      for (const [k, v] of Object.entries(d.values as Record<string, unknown>)) {
        if (!isValidVariableName(k)) continue;
        if (typeof v !== "string") continue;
        values[k] = v.slice(0, MAX_VARIABLE_VALUE_LENGTH);
      }
    }
    out.push({ id: d.id, name, values });
    if (out.length >= MAX_DATASETS_PER_TEST) break;
  }
  return out;
}

// ── Step normalization at the capture boundary ─────────────────────────────
//
// The injected capture script hands steps back through a DOM ATTRIBUTE on
// documentElement (`data-pw-queue`). That attribute is shared with the page —
// which is an arbitrary, untrusted website — so anything on it is attacker
// input, not our own script's output. The page can write the attribute itself.
//
// What made that dangerous is the sink: recorded steps are compiled into a
// .spec.ts and later EXECUTED by Playwright in Node. Every string field is
// escaped by the generator via JSON.stringify, but the numeric fields were
// interpolated as-is on the strength of their TypeScript type — and a type is
// not a runtime check. A page writing `count: "0); <arbitrary node code>; ("`
// got that code into the generated spec verbatim.
//
// So a step arriving from the page is rebuilt field by field here, out of
// values that have each been checked. Not filtered — REBUILT: spreading the
// input and overwriting known keys would carry every unknown key along with
// it, and the next field added to the generator would silently become a hole
// again.

export const STEP_TYPES: StepType[] = [
  "goto", "click", "fill", "press", "select", "check", "uncheck", "assert",
  "wait", "viewport", "if", "endif", "cookie", "capture", "runFlow", "state",
];

export const ASSERT_KINDS: AssertKind[] = [
  "visible", "hidden", "text", "exactText", "enabled", "disabled", "checked",
  "unchecked", "value", "attribute", "count", "url", "urlEndsWith", "urlIs",
  "urlPathIs", "title", "titleContains", "css",
];

export const ELEMENT_STATES: ElementState[] = ["hover", "focus", "press", "release"];

export const CSS_MATCHES: CssMatch[] = ["is", "contains"];

/**
 * The properties the CSS-assertion picker offers with the element's live
 * computed value beside each — the ones a visual regression is actually about.
 * A property outside this list is still assertable; the picker has a free-text
 * field, and `isCssPropName` is what bounds THAT.
 *
 * KEBAB-case throughout, and `check:css-assertions` pins that: these names are
 * passed to `getComputedStyle().getPropertyValue()` on both sides (the capture
 * script that reads them, and Playwright's `toHaveCSS` that compares them), and
 * that call answers "" for a camelCase name rather than throwing.
 *
 * Interpolated into `capture-script.ts` rather than retyped there, the same
 * one-list discipline as `page-actions.ts`: two hand-maintained copies would
 * drift the first time a property was added to one, and the failure is silent —
 * the picker simply stops offering a value for a property it still lists.
 */
export const CSS_ASSERT_PROPS: string[] = [
  "color",
  "background-color",
  "opacity",
  "border-color",
  "border-width",
  "border-radius",
  "box-shadow",
  "outline-color",
  "font-size",
  "font-weight",
  "font-family",
  "text-decoration",
  "letter-spacing",
  "cursor",
  "display",
  "visibility",
  "width",
  "height",
  "padding",
  "margin",
  "transform",
  "z-index",
];

/**
 * A syntactically valid CSS property name (including custom properties).
 *
 * `cssProp` reaches the generator as the first argument of `toHaveCSS`, where
 * `q()` quotes it — but a property name has a KNOWN grammar, and checking the
 * shape at the boundary means the generator's quoting is the second line of
 * defence rather than the only one. Same reasoning as `isValidVariableName`.
 */
export function isCssPropName(v: unknown): v is string {
  return typeof v === "string" && v.length <= 100 && /^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$/.test(v);
}

export const CONDITION_KINDS: ConditionKind[] = [
  "visible", "hidden", "exists", "enabled", "disabled", "checked", "unchecked",
  "urlContains", "titleContains",
];

/** Deliberately a separate list from CONDITION_KINDS even though it contains
 *  all of them — see the WaitUntilKind doc comment. */
export const WAIT_UNTIL_KINDS: WaitUntilKind[] = [
  "visible", "hidden", "exists", "enabled", "disabled", "checked", "unchecked",
  "text", "value", "count", "urlContains", "titleContains",
];

export const LOCATOR_KINDS: LocatorKind[] = [
  "testid", "role", "label", "placeholder", "text", "css", "xpath",
];

export const COOKIE_ACTIONS: CookieAction[] = ["set", "delete", "clearAll"];

export const COOKIE_SAME_SITE: CookieSameSite[] = [
  "unspecified", "no_restriction", "lax", "strict",
];

/** Bounds for a captured step. Generous — a real locator or assertion text is
 *  orders of magnitude under these — but finite, so a hostile page cannot make
 *  the recorder hold an unbounded string. */
export const MAX_STEP_STRING_LENGTH = 8000;
export const MAX_FINGERPRINT_CANDIDATES = 40;
export const MAX_FINGERPRINT_ATTRIBUTES = 40;
export const MAX_FLOW_ARGS = 50;
/** Upper bound on `Locator.nth`. The recorder only ever writes this when no
 *  candidate locator was unique, and it caps its own scan well below here
 *  (`MAX_UNIQUENESS_SCAN` in capture-script.ts) — so a value near this one did
 *  not come from a person clicking an element. */
export const MAX_MATCH_INDEX = 1000;
/** Predicates a single locator's context may AND together. A person pinning
 *  disambiguation ticks one or two boxes; anything near this came from a page
 *  rather than a person, and every entry is a locator the generator emits into
 *  source Playwright executes. */
export const MAX_CONTEXT_PREDICATES = 8;
/** Disambiguating properties offered for one picked element. The page chooses
 *  how many attributes and ancestors an element has, so this is a bound on a
 *  page-controlled list; the capture script caps its own scan well below it. */
export const MAX_CONTEXT_SIGNALS = 60;
/** Steps accepted from a single drain of the capture queue. A real recording
 *  produces a handful per poll; anything near this is not a person clicking. */
export const MAX_STEPS_PER_DRAIN = 500;
/** Size cap on the queue attribute itself, applied BEFORE parsing. Per-field
 *  limits can't help here — `JSON.parse` has to materialize the whole string
 *  first, and the page chooses how long that string is. */
export const MAX_DRAIN_BYTES = 2_000_000;

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v.slice(0, MAX_STEP_STRING_LENGTH) : undefined;
}

/** A finite integer within bounds, or undefined.
 *
 *  The load-bearing one. `Number.isFinite` rejects a string, NaN and Infinity;
 *  `Math.trunc` means a float can't reach the generator either, since `1e21`
 *  stringifies to exponential notation and `0.1+0.2` to 17 digits — both are
 *  valid JS, but neither is what the user recorded. */
function int(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.trunc(v);
  return n >= min && n <= max ? n : undefined;
}

function bool(v: unknown): boolean | undefined {
  return v === true ? true : undefined;
}

/**
 * Rebuild a locator out of checked values.
 *
 * `allowContext` is the recursion guard, not a feature flag. `Locator.ctx`
 * holds locators of its own, so the type is self-referential and a hostile page
 * can nest it as deep as it likes; each level costs a parse and lands in
 * generated source. One level is all the picker can produce and all the
 * generator emits — a container is a container, not a chain of them — so the
 * inner call passes `false` and any `ctx` on a context locator is dropped
 * rather than recursed into.
 */
export function normalizeLocator(input: unknown, allowContext = true): Locator | undefined {
  if (!input || typeof input !== "object") return undefined;
  const l = input as Partial<Locator>;
  const k = oneOf(l.k, LOCATOR_KINDS);
  if (!k) return undefined;
  const out: Locator = { k };
  const v = str(l.v);
  const role = str(l.role);
  const name = str(l.name);
  if (v !== undefined) out.v = v;
  if (role !== undefined) out.role = role;
  if (name !== undefined) out.name = name;
  // Allowlisted, not merely length-capped: the attribute is interpolated into
  // an attribute SELECTOR by the generator, and only the two names in
  // TESTID_ATTRIBUTE_OVERRIDES mean anything there. data-testid itself is
  // deliberately not accepted — absent already means it, and a second spelling
  // of the same locator would be a second heal-map key.
  if (k === "testid") {
    const attr = oneOf(l.attr, TESTID_ATTRIBUTE_OVERRIDES);
    if (attr !== undefined) out.attr = attr;
  }
  // `int`, not a typeof check. This field reaches the generator as a BARE
  // NUMERAL — `.nth(<here>)` — which is the exact shape that was remote code
  // execution the last time a numeric step field was trusted for having the
  // right TypeScript type (see `num` in script-generator.ts). The upper bound is
  // MAX_MATCH_INDEX rather than something enormous because a page with more
  // than that many matches for one locator is not a page anyone is indexing
  // into on purpose. -1 is the one negative Playwright honours — `.nth(-1)` is
  // "the last match", the stable way to index a set whose size changes between
  // runs — so the bound admits exactly it and nothing below.
  const nth = int(l.nth, -1, MAX_MATCH_INDEX);
  if (nth !== undefined) out.nth = nth;
  if (allowContext) {
    const ctx = normalizeLocatorContext(l.ctx);
    if (ctx) out.ctx = ctx;
  }
  return out;
}

/**
 * Rebuild a locator's user-pinned context.
 *
 * Returns undefined for an EMPTY result rather than `{}`. An empty context
 * constrains nothing, but it is not inert: it would change the heal-map key
 * (`healKeyFor`), and it would round-trip through the generator and parser as a
 * difference that produces identical source — so a step would compare unequal
 * to its own regenerated self. Absent and empty must be the same value here.
 */
function normalizeLocatorContext(input: unknown): LocatorContext | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const c = input as Partial<LocatorContext>;
  const out: LocatorContext = {};
  const within = normalizeLocator(c.within, false);
  if (within) out.within = within;
  // Only meaningful as a filter ON the container — see LocatorContext. Read
  // after `within` so this reads as the dependency it is.
  if (within) {
    const hasText = str(c.withinHasText);
    if (hasText !== undefined) out.withinHasText = hasText;
  }
  if (Array.isArray(c.and)) {
    const and: Locator[] = [];
    for (const p of c.and) {
      const loc = normalizeLocator(p, false);
      if (loc) and.push(loc);
      if (and.length >= MAX_CONTEXT_PREDICATES) break;
    }
    if (and.length > 0) out.and = and;
  }
  return out.within || out.and ? out : undefined;
}

function normalizeFingerprint(input: unknown): ElementFingerprint | undefined {
  if (!input || typeof input !== "object") return undefined;
  const f = input as Partial<ElementFingerprint>;
  const candidates: Locator[] = [];
  if (Array.isArray(f.candidates)) {
    for (const c of f.candidates) {
      const loc = normalizeLocator(c);
      if (loc) candidates.push(loc);
      if (candidates.length >= MAX_FINGERPRINT_CANDIDATES) break;
    }
  }
  const attributes: Record<string, string> = {};
  if (f.attributes && typeof f.attributes === "object") {
    let n = 0;
    for (const [k, v] of Object.entries(f.attributes as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      attributes[k.slice(0, 200)] = v.slice(0, MAX_STEP_STRING_LENGTH);
      if (++n >= MAX_FINGERPRINT_ATTRIBUTES) break;
    }
  }
  const out: ElementFingerprint = {
    tag: str(f.tag) ?? "",
    description: str(f.description) ?? "",
    candidates,
    attributes,
    depth: int(f.depth, 0, 10_000) ?? 0,
  };
  const text = str(f.text);
  const neighborText = str(f.neighborText);
  if (text !== undefined) out.text = text;
  if (neighborText !== undefined) out.neighborText = neighborText;
  // Normalized 0–1 geometry. Out-of-range numbers are dropped wholesale rather
  // than clamped: a partial rect would read as a real measurement.
  if (f.rect && typeof f.rect === "object") {
    const r = f.rect as Partial<ElementFingerprint["rect"]>;
    const nums = [r?.x, r?.y, r?.w, r?.h].map((n) =>
      typeof n === "number" && Number.isFinite(n) ? n : undefined,
    );
    if (nums.every((n) => n !== undefined)) {
      out.rect = { x: nums[0] as number, y: nums[1] as number, w: nums[2] as number, h: nums[3] as number };
    }
  }
  return out;
}

function normalizeCookieSpec(input: unknown): CookieSpec | undefined {
  if (!input || typeof input !== "object") return undefined;
  const c = input as Partial<CookieSpec>;
  const name = str(c.name);
  if (name === undefined) return undefined;
  const out: CookieSpec = { name };
  const value = str(c.value);
  const domain = str(c.domain);
  const p = str(c.path);
  const url = str(c.url);
  if (value !== undefined) out.value = value;
  if (domain !== undefined) out.domain = domain;
  if (p !== undefined) out.path = p;
  if (url !== undefined) out.url = url;
  if (c.secure === true) out.secure = true;
  if (c.httpOnly === true) out.httpOnly = true;
  const sameSite = oneOf(c.sameSite, COOKIE_SAME_SITE);
  if (sameSite) out.sameSite = sameSite;
  const exp = int(c.expirationDate, 0, 4_102_444_800);
  if (exp !== undefined) out.expirationDate = exp;
  return out;
}

/** Exported for `recorder-service.updateStep`: `flowArgs` is the one map-valued
 *  field a step patch can carry, so it gets the same rebuild `insertStep` gives
 *  it rather than the allowlist's raw copy. */
export function normalizeFlowArgs(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    // Flow parameter names are emitted as object keys in the generated spec, so
    // they carry the same constraint as a variable name.
    if (!isValidVariableName(k)) continue;
    if (typeof v !== "string") continue;
    out[k] = v.slice(0, MAX_STEP_STRING_LENGTH);
    if (++n >= MAX_FLOW_ARGS) break;
  }
  return out;
}

/**
 * Rebuild a step arriving from the capture queue out of checked values.
 *
 * Returns null when there is no usable step — an unknown `type` above all,
 * since every downstream switch keys off it.
 *
 * Accepts `unknown` because it sits directly behind the page boundary.
 */
export function normalizeRawStep(input: unknown): RawStep | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const s = input as Record<string, unknown>;
  const type = oneOf(s.type, STEP_TYPES);
  if (!type) return null;

  const out: RawStep = { type };
  const locator = normalizeLocator(s.locator);
  if (locator) out.locator = locator;

  const value = str(s.value);
  const label = str(s.label);
  const url = str(s.url);
  const text = str(s.text);
  const attr = str(s.attr);
  if (value !== undefined) out.value = value;
  if (label !== undefined) out.label = label;
  if (url !== undefined) out.url = url;
  if (text !== undefined) out.text = text;
  if (attr !== undefined) out.attr = attr;

  const assert = oneOf(s.assert, ASSERT_KINDS);
  const cond = oneOf(s.cond, CONDITION_KINDS);
  const waitUntil = oneOf(s.waitUntil, WAIT_UNTIL_KINDS);
  if (assert) out.assert = assert;
  if (cond) out.cond = cond;
  if (waitUntil) out.waitUntil = waitUntil;
  if (bool(s.soft)) out.soft = true;

  // A CSS property name is checked for SHAPE, not merely length-capped like the
  // other free strings: it is the one string field whose grammar is known, and
  // `str()` alone would carry `"); require("child_process")…` through to the
  // generator's quoting and no further check.
  if (isCssPropName(s.cssProp)) out.cssProp = s.cssProp;
  const cssMatch = oneOf(s.cssMatch, CSS_MATCHES);
  if (cssMatch) out.cssMatch = cssMatch;
  const elementState = oneOf(s.elementState, ELEMENT_STATES);
  if (elementState) out.elementState = elementState;

  // The fields that reach the generator as bare numerals.
  const count = int(s.count, 0, 1_000_000);
  const width = int(s.width, 1, 100_000);
  const height = int(s.height, 1, 100_000);
  const waitMs = int(s.waitMs, 0, 3_600_000);
  const timeoutMs = int(s.timeoutMs, 0, 3_600_000);
  if (count !== undefined) out.count = count;
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  if (waitMs !== undefined) out.waitMs = waitMs;
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;

  const cookieAction = oneOf(s.cookieAction, COOKIE_ACTIONS);
  if (cookieAction) out.cookieAction = cookieAction;
  const cookie = normalizeCookieSpec(s.cookie);
  if (cookie) out.cookie = cookie;

  const captureVar = str(s.captureVar);
  const captureAttr = str(s.captureAttr);
  if (captureVar !== undefined) out.captureVar = captureVar;
  if (captureAttr !== undefined) out.captureAttr = captureAttr;
  if (isCaptureSource(s.captureFrom)) out.captureFrom = s.captureFrom;

  const flowId = str(s.flowId);
  if (flowId !== undefined) out.flowId = flowId;
  const flowArgs = normalizeFlowArgs(s.flowArgs);
  if (flowArgs && Object.keys(flowArgs).length > 0) out.flowArgs = flowArgs;

  const fingerprint = normalizeFingerprint(s.fingerprint);
  if (fingerprint) out.fingerprint = fingerprint;

  return out;
}

/**
 * Rebuild a picked element out of checked values.
 *
 * Arrives on the same page-writable channel as the step queue. Its fields reach
 * the generator only through `Locator`, which the generator quotes — but it is
 * the same boundary, and "not exploitable through today's sinks" is a property
 * of the current code rather than of the data.
 */
export function normalizePickedElement(input: unknown): PickedElement | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const p = input as Record<string, unknown>;
  const candidates: Locator[] = [];
  if (Array.isArray(p.candidates)) {
    for (const c of p.candidates) {
      const loc = normalizeLocator(c);
      if (loc) candidates.push(loc);
      if (candidates.length >= MAX_FINGERPRINT_CANDIDATES) break;
    }
  }
  const strMap = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!v || typeof v !== "object") return out;
    let n = 0;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val !== "string") continue;
      out[k.slice(0, 200)] = val.slice(0, MAX_STEP_STRING_LENGTH);
      if (++n >= MAX_FINGERPRINT_ATTRIBUTES) break;
    }
    return out;
  };
  const signals: ContextSignal[] = [];
  if (Array.isArray(p.contextSignals)) {
    for (const raw of p.contextSignals) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      const kind = oneOf(s.kind, CONTEXT_SIGNAL_KINDS);
      if (!kind) continue;
      // The context fragment is the load-bearing part — it is what gets pinned
      // onto the step and emitted into generated source — so it goes through
      // the same normalizer as any other context, not a lighter one because it
      // arrived alongside display text.
      const ctx = normalizeLocatorContext(s.ctx);
      if (!ctx) continue;
      const sig: ContextSignal = {
        kind,
        name: str(s.name) ?? "",
        value: str(s.value) ?? "",
        ctx,
        // A count is a claim about the page. An unreadable one reads as zero
        // ("nothing matches"), which is a different and more alarming claim
        // than "we could not count", so it is bounded rather than defaulted to
        // a number that would be believed.
        count: int(s.count, 0, MAX_MATCH_INDEX) ?? 0,
        resolves: s.resolves === true,
      };
      const loc = normalizeLocator(s.locator, false);
      if (loc) sig.locator = loc;
      signals.push(sig);
      if (signals.length >= MAX_CONTEXT_SIGNALS) break;
    }
  }
  const out: PickedElement = {
    tag: str(p.tag) ?? "",
    description: str(p.description) ?? "",
    candidates,
    css: strMap(p.css),
    attributes: strMap(p.attributes),
    ambiguous: p.ambiguous === true,
    contextBaseCount: int(p.contextBaseCount, 0, MAX_MATCH_INDEX) ?? 0,
    contextSignals: signals,
  };
  const base = normalizeLocator(p.contextBase);
  if (base) out.contextBase = base;
  const text = str(p.text);
  const neighborText = str(p.neighborText);
  if (text !== undefined) out.text = text;
  if (neighborText !== undefined) out.neighborText = neighborText;
  return out;
}

/** One element the failing locator actually resolved to. Every field is
 *  page-authored — see normalizeStepStructures. */
export interface StepMatch {
  index: number;
  tag: string;
  id?: string;
  testid?: string;
  ariaLabel?: string;
  text?: string;
  classes: string[];
  /** ancestors that could scope a locator (testid, id or landmark), nearest first */
  ancestors: string[];
  visible: boolean;
  enabled: boolean;
  rect?: { x: number; y: number; w: number; h: number };
}

/** One failing step's page structure, rebuilt for a prompt. Two independent
 *  records of the same moment, and the difference between them is the whole
 *  point: `matches` is what the locator LITERALLY resolved to, `candidates` is
 *  what Auto-Heal thought RESEMBLED the element we wanted. An ambiguous locator
 *  is answered by the first; a stale one by the second.
 *  The renderer mirror is in renderer/lib/recorder-types.ts. */
export interface StepStructure {
  stepIndex: number;
  stepLabel: string;
  /** the Locator action that failed (`click`, `fill`, …) */
  method?: string;
  originalLocator?: Locator;
  /** how many elements matched, before `matches` was capped */
  matchCount?: number;
  matches: StepMatch[];
  /** absent when Auto-Heal never got as far as ranking (the step healed, or
   *  only the match record exists) */
  outcome?: "exhausted" | "no-candidates";
  candidates: HealCandidate[];
}

/** Failing steps whose Auto-Heal candidates are worth showing, capped. Each
 *  entry describes real elements, so this is where the per-step budget is
 *  spent — see MAX_STRUCTURE_CANDIDATES. */
export const MAX_STRUCTURE_STEPS = 10;
export const MAX_STRUCTURE_CANDIDATES = 20;

/**
 * Rebuild the page structure Auto-Heal recorded for the steps it could not
 * rescue (`heal-failures.json`).
 *
 * This is the same boundary as the step queue, one remove further out. The
 * probe runs INSIDE the page and its `description` and `locator` fields are
 * built from whatever the site's DOM says — so a hostile page picks every
 * string here. They are read off disk rather than off `data-pw-queue`, which
 * changes nothing: `writeHealFailures` persists the fixture's JSON verbatim,
 * and what it persists is page-authored.
 *
 * Rebuilt, not filtered, per the rule the other normalizers in this file
 * follow: spreading the input would carry every unknown key into a prompt the
 * moment someone adds a field to HealFailure.
 */
export function normalizeStepStructures(input: unknown): StepStructure[] {
  if (!Array.isArray(input)) return [];
  const out: StepStructure[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const f = raw as Record<string, unknown>;
    const outcome = oneOf(f.outcome, ["exhausted", "no-candidates"] as const);
    if (!outcome) continue;
    const candidates: HealCandidate[] = [];
    if (Array.isArray(f.candidates)) {
      for (const c of f.candidates) {
        if (!c || typeof c !== "object") continue;
        const cand = c as Record<string, unknown>;
        const locator = normalizeLocator(cand.locator);
        if (!locator) continue;
        candidates.push({
          locator,
          description: str(cand.description) ?? "",
          // A score outside 0–1 is not a score. Dropped to 0 rather than
          // clamped: a made-up 1 would sort a hostile candidate to the top of
          // a list the model reads as ranked.
          score:
            typeof cand.score === "number" && Number.isFinite(cand.score) &&
            cand.score >= 0 && cand.score <= 1
              ? cand.score
              : 0,
          matchedPastRun: cand.matchedPastRun === true,
        });
        if (candidates.length >= MAX_STRUCTURE_CANDIDATES) break;
      }
    }
    const entry: StepStructure = {
      stepIndex: int(f.stepIndex, 0, 100_000) ?? 0,
      stepLabel: str(f.stepLabel) ?? "",
      outcome,
      matches: [],
      candidates,
    };
    const method = str(f.method);
    if (method !== undefined) entry.method = method;
    const originalLocator = normalizeLocator(f.originalLocator);
    if (originalLocator !== undefined) entry.originalLocator = originalLocator;
    out.push(entry);
    if (out.length >= MAX_STRUCTURE_STEPS) break;
  }
  return out;
}

/** Elements described per failing step. Deliberately smaller than the fixture's
 *  own cap: this is a list to be PICKED FROM, and one longer than this is one
 *  nobody reads. `matchCount` reports the true total either way. */
export const MAX_STRUCTURE_MATCHES = 20;
/** Ancestors and class names kept per element. Both are page-authored lists of
 *  unbounded length; three of each is enough to tell two matches apart. */
const MAX_MATCH_ANCESTORS = 3;
const MAX_MATCH_CLASSES = 3;
/** Longest page-authored string kept in a match descriptor. Far under
 *  MAX_STEP_STRING_LENGTH on purpose — twenty of these go into one prompt, and
 *  8000 characters of button text each would be the whole context window. */
const MAX_MATCH_TEXT = 200;

function shortStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, MAX_MATCH_TEXT) : undefined;
}

function strList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = shortStr(item);
    if (s !== undefined) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Rebuild what the failing locator actually resolved to (`matches.json`).
 *
 * Same boundary as everything else here, and the most directly page-authored of
 * the lot: these fields ARE the site's DOM — its text, its ids, its class
 * names, read straight off the elements. They go into a prompt whose answer the
 * user can apply to their script with one click, so a page can put whatever it
 * likes in a button's `aria-label` and have the model read it. Naming the data
 * untrusted in the payload is the mitigation for that; this function's job is
 * the shape and the size.
 */
export function normalizeStepMatches(input: unknown): StepStructure[] {
  if (!Array.isArray(input)) return [];
  const out: StepStructure[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const f = raw as Record<string, unknown>;
    const matches: StepMatch[] = [];
    if (Array.isArray(f.matches)) {
      for (const m of f.matches) {
        if (!m || typeof m !== "object") continue;
        const el = m as Record<string, unknown>;
        const tag = shortStr(el.tag);
        // A descriptor with no tag is not an element description. Dropped
        // rather than defaulted: "" would render as a blank line the model
        // would count among the candidates it is choosing between.
        if (!tag) continue;
        const match: StepMatch = {
          index: int(el.index, 0, 100_000) ?? matches.length,
          tag,
          classes: strList(el.classes, MAX_MATCH_CLASSES),
          ancestors: strList(el.ancestors, MAX_MATCH_ANCESTORS),
          visible: el.visible === true,
          // Defaults to ENABLED, matching the DOM: `disabled` is the property
          // that exists, and a missing field meaning "disabled" would have the
          // payload tell the model an element it can click cannot be clicked.
          enabled: el.enabled !== false,
        };
        const id = shortStr(el.id);
        const testid = shortStr(el.testid);
        const ariaLabel = shortStr(el.ariaLabel);
        const text = shortStr(el.text);
        if (id !== undefined) match.id = id;
        if (testid !== undefined) match.testid = testid;
        if (ariaLabel !== undefined) match.ariaLabel = ariaLabel;
        if (text !== undefined) match.text = text;
        if (el.rect && typeof el.rect === "object") {
          const r = el.rect as Record<string, unknown>;
          const nums = [r.x, r.y, r.w, r.h].map((n) => int(n, -1_000_000, 1_000_000));
          // All four or none: a partial rect would read as a real measurement.
          if (nums.every((n) => n !== undefined)) {
            match.rect = { x: nums[0]!, y: nums[1]!, w: nums[2]!, h: nums[3]! };
          }
        }
        matches.push(match);
        if (matches.length >= MAX_STRUCTURE_MATCHES) break;
      }
    }
    const entry: StepStructure = {
      stepIndex: int(f.stepIndex, 0, 100_000) ?? 0,
      stepLabel: str(f.stepLabel) ?? "",
      matches,
      candidates: [],
    };
    const matchCount = int(f.matchCount, 0, 1_000_000);
    if (matchCount !== undefined) entry.matchCount = matchCount;
    const method = str(f.method);
    if (method !== undefined) entry.method = method;
    const originalLocator = normalizeLocator(f.originalLocator);
    if (originalLocator !== undefined) entry.originalLocator = originalLocator;
    out.push(entry);
    if (out.length >= MAX_STRUCTURE_STEPS) break;
  }
  return out;
}

/**
 * One record per failing step, from the two files that describe one.
 *
 * They are written by the same fixture at the same moment but are not the same
 * question, and either can exist without the other: a step whose locator was
 * ambiguous and then HEALED leaves a match record and no heal failure, while a
 * run from before this existed leaves the reverse. Joined on step index, with
 * the matches taking the identity fields — both wrote them from the same
 * `entry`, so they agree, and preferring one avoids a merge that has to decide.
 */
export function buildStepStructures(healFailures: unknown, matchSets: unknown): StepStructure[] {
  const byIndex = new Map<number, StepStructure>();
  for (const m of normalizeStepMatches(matchSets)) byIndex.set(m.stepIndex, m);
  for (const h of normalizeStepStructures(healFailures)) {
    const existing = byIndex.get(h.stepIndex);
    if (!existing) {
      byIndex.set(h.stepIndex, h);
      continue;
    }
    existing.outcome = h.outcome;
    existing.candidates = h.candidates;
    if (existing.originalLocator === undefined) existing.originalLocator = h.originalLocator;
    if (!existing.stepLabel) existing.stepLabel = h.stepLabel;
    if (existing.method === undefined) existing.method = h.method;
  }
  return [...byIndex.values()]
    .sort((a, b) => a.stepIndex - b.stepIndex)
    .slice(0, MAX_STRUCTURE_STEPS);
}

/** Every usable step from one drain of the capture queue, capped. */
export function normalizeRawSteps(input: unknown): RawStep[] {
  if (!Array.isArray(input)) return [];
  const out: RawStep[] = [];
  for (const raw of input) {
    const step = normalizeRawStep(raw);
    if (step) out.push(step);
    if (out.length >= MAX_STEPS_PER_DRAIN) break;
  }
  return out;
}

/**
 * The `Step` counterpart, for step lists arriving over IPC rather than from the
 * page. Keeps the caller's id and timestamp when they're usable and mints
 * neither — a step list is edited in place, so inventing an id here would
 * detach it from everything that references it (heal journal, visual masks).
 */
export function normalizeStep(input: unknown): Step | null {
  const raw = normalizeRawStep(input);
  if (!raw) return null;
  const s = input as Record<string, unknown>;
  const id = str(s.id);
  if (!id) return null;
  const step: Step = { ...raw, id, timestamp: int(s.timestamp, 0, Number.MAX_SAFE_INTEGER) ?? 0 };
  if (bool(s.continueOnFailure)) step.continueOnFailure = true;
  if (bool(s.disabled)) step.disabled = true;
  if (Array.isArray(s.varRefs)) {
    step.varRefs = s.varRefs.filter((n): n is string => isValidVariableName(n));
  }
  return step;
}

/** Matches a `${name}` reference in a step's value. Deliberately narrow: only a
 *  bare identifier, so a literal `${...}` containing anything else (an actual
 *  price string, a template someone typed) is left alone as text. */
export const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Every variable name referenced anywhere in a string, in order, deduped. */
export function varRefsIn(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const out: string[] = [];
  for (const m of text.matchAll(VAR_REF_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** The interpolatable fields of a step, in a fixed order. Every site that
 *  scans or substitutes must use this list, so a new interpolatable field can't
 *  be added to one and forgotten in the other. */
export function interpolatableFields(step: Step): string[] {
  const parts: string[] = [];
  if (typeof step.value === "string") parts.push(step.value);
  if (typeof step.text === "string") parts.push(step.text);
  if (typeof step.url === "string") parts.push(step.url);
  if (step.flowArgs) parts.push(...Object.values(step.flowArgs));
  return parts;
}

/** All variable names a step references across its interpolatable fields. */
export function collectVarRefs(step: Step): string[] {
  const out: string[] = [];
  for (const field of interpolatableFields(step)) {
    for (const name of varRefsIn(field)) {
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * Substitute a step's `${name}` references for a trainer replay.
 *
 * The injected replayer takes a step as JSON and acts on exactly what it is
 * given, so a step carrying `${storePassword}` types those seventeen characters
 * into the field. In a real run the generator turns that into `V.storePassword`
 * and the value arrives from the record or the environment — which means the
 * one action a user takes to check their new variable step (the per-step ▶) is
 * the one place it would appear not to work.
 *
 * **Secrets are resolved here too, and that is a deliberate reversal.** The
 * first version refused them, on the grounds that decrypting a password into an
 * evaluated script puts it in the page's isolated world. It does — but the page
 * is where the password has to end up for the login to happen, it is exactly
 * where recording the step by hand put it, and a preview that cannot exercise
 * the one step type this feature exists for is not a preview. The caller passes
 * the values in (they live in the encrypted store, which this pure module
 * cannot read) and gets `usedValues` back, which is what keeps them out of the
 * trainer's logs. See DECISIONS 2026-08-17.
 *
 * A declared secret with NO stored value comes back in `missingSecrets` rather
 * than being substituted for an empty string: filling a login form with "" and
 * reporting success is how a step passes here and fails in the run, several
 * steps later, for a reason nothing connects back to this one.
 *
 * An undeclared reference is left as literal text — the same rule `valueExpr`
 * applies in the generator, so a price of `${9.99}` means here what it will
 * mean in the spec.
 */
export function resolveStepForReplay(
  step: Step,
  variables: readonly TestVariable[],
  secretValues: Readonly<Record<string, string>> = {},
): { step: Step; usedValues: string[]; missingSecrets: string[] } {
  const refs = collectVarRefs(step);
  if (refs.length === 0) return { step, usedValues: [], missingSecrets: [] };
  const byName = new Map(variables.map((v) => [v.name, v]));
  const missingSecrets: string[] = [];
  const usedValues: string[] = [];

  /** The text a reference resolves to, or null to leave it alone. */
  const valueOf = (name: string): string | null => {
    const v = byName.get(name);
    if (!v) return null;
    if (v.kind !== "secret") return v.value ?? "";
    const stored = secretValues[name];
    if (typeof stored !== "string" || stored === "") {
      if (!missingSecrets.includes(name)) missingSecrets.push(name);
      return null;
    }
    return stored;
  };

  const sub = (text: string): string =>
    text.replace(VAR_REF_RE, (whole, name: string) => {
      const value = valueOf(name);
      if (value === null) return whole;
      if (value && !usedValues.includes(value)) usedValues.push(value);
      return value;
    });

  const next: Step = { ...step };
  if (typeof next.value === "string") next.value = sub(next.value);
  if (typeof next.text === "string") next.text = sub(next.text);
  if (typeof next.url === "string") next.url = sub(next.url);
  if (next.flowArgs) {
    next.flowArgs = Object.fromEntries(
      Object.entries(next.flowArgs).map(([k, val]) => [k, sub(val)]),
    );
  }
  return { step: next, usedValues, missingSecrets };
}

/** Bounds for `TestRecord.tags`. Generous enough to never bite in practice,
 *  tight enough that a paste accident can't write a megabyte into tests.json. */
export const MAX_TAG_LENGTH = 32;
export const MAX_TAGS_PER_TEST = 20;

/** Bound for `TestRecord.group`. Longer than a tag because a folder name is
 *  read as a phrase ("Checkout — logged in") where a tag is scanned as a chip,
 *  and the rail truncates with an ellipsis rather than wrapping. */
export const MAX_GROUP_LENGTH = 48;

/**
 * Canonicalize a set of tags: trim, drop empties, collapse inner whitespace,
 * truncate over-long tags, dedupe case-insensitively (first spelling wins, so
 * "Smoke" then "smoke" keeps "Smoke"), sort case-insensitively for stable
 * display, and cap the count.
 *
 * Accepts `unknown` because it sits directly behind an IPC boundary — anything
 * that isn't an array of strings normalizes to an empty list rather than
 * throwing or persisting junk.
 */
export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().replace(/\s+/g, " ").slice(0, MAX_TAG_LENGTH);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS_PER_TEST) break;
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/**
 * Canonicalize a group name: trim, collapse inner whitespace, truncate.
 *
 * Returns `""` for anything unusable, which every caller reads as UNGROUPED —
 * so a hostile or absent value moves a test to the top level rather than into a
 * folder nobody can see. That direction matters: the rail draws groups from the
 * names the tests carry, so an unrenderable name would be a test that vanished
 * from the list entirely.
 *
 * Deliberately NOT case-folded, and deliberately not deduped against existing
 * names. `Checkout` and `checkout` are two folders here where they would be one
 * tag, because a tag is matched (the chip that says `smoke` must find every
 * spelling) and a folder is only ever displayed. Case-folding would mean the
 * name the user typed is not the name on the row.
 *
 * Accepts `unknown` because it sits directly behind an IPC boundary.
 */
export function normalizeGroup(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.trim().replace(/\s+/g, " ").slice(0, MAX_GROUP_LENGTH);
}

/** Default visual-diff threshold (percent of pixels changed) when a test has
 *  none set. 0.1% tolerates trivial antialiasing noise while flagging real
 *  layout/content changes. */
export const DEFAULT_VISUAL_THRESHOLD = 0.1;

/** A rectangular region excluded from visual diffing.
 *
 *  Coordinates are NORMALIZED (0–1, fractions of image width/height) rather
 *  than pixels, so a mask drawn at one viewport still covers the same part of
 *  the page at another — and a baseline captured before a viewport change
 *  keeps masking the right area. */
export interface VisualMask {
  id: string;
  /** Step this mask applies to, or null for "every step in the test".
   *  Dynamic chrome (a clock in the header) is usually test-wide; a single
   *  volatile widget is usually one step. */
  stepId: string | null;
  /** left edge, 0–1 */
  x: number;
  /** top edge, 0–1 */
  y: number;
  /** width, 0–1 */
  w: number;
  /** height, 0–1 */
  h: number;
  /** optional user label (e.g. "clock", "ad slot") */
  label?: string;
}

/** A single completed test run, persisted to run-history.json. The raw console
 *  output for the run lives in a sibling .log file (see logFile) so large
 *  outputs stay out of the JSON index. */
export type RunRecordKind = "run" | "baseline-update";

export interface RunRecord {
  /** unique per run (not the testId — one test has many runs) */
  id: string;
  testId: string;
  testName: string;
  url: string;
  status: "passed" | "failed";
  exitCode: number;
  /** epoch ms */
  startedAt: number;
  /** epoch ms */
  finishedAt: number;
  durationMs: number;
  /** absolute path to the raw console-output .log file for this run */
  logFile: string;
  /** size of the log file in bytes (0 if the raw log was deleted but the
   *  record kept, or if the log could not be read) */
  logBytes: number;
  /** Whether this run was asked to capture artifacts (screenshots, and later
   *  video/DOM snapshots). Per-run choice, off by default; the gate every
   *  visual-testing phase checks. Absent on runs recorded before the toggle. */
  captureArtifacts?: boolean;
  /** Whether this run executed headless (no visible browser). Absent on runs
   *  recorded before the toggle — treated as false (headed) for display. */
  runHeadless?: boolean;
  /** Browser engine this run used. Absent on runs recorded before the picker
   *  existed — treated as chromium, which is what they all ran on. */
  runBrowser?: RunBrowser;
  /** Playback speed this run executed at. Recorded because speed is a per-test
   *  setting the user changes between runs, so without it a run history can't
   *  say whether yesterday's failure and today's pass differ by the code or by
   *  the pacing — which is the whole question "crawl" exists to answer.
   *  Absent on runs recorded before this field; read as "unknown", NOT as
   *  "fast" — a pre-existing run genuinely might have been any speed, and
   *  defaulting would invent evidence. */
  speed?: TestSpeed;
  /** id of the batch this run belonged to, when it was part of one. Absent for
   *  ordinary single runs — which is most of them. */
  batchId?: string;
  /** How many steps run-time Auto-Heal got past by substituting a locator.
   *  Non-zero makes a run "passed (healed)" rather than plainly passed —
   *  a distinction worth keeping, because a run that only passed because
   *  something was silently substituted is not the same evidence as one that
   *  passed outright. */
  healedSteps?: number;
  /** How many steps Auto-Heal TRIED to rescue and could not — it looked for
   *  the element under every candidate locator it could rank, and none of them
   *  worked (or nothing on the page resembled it at all).
   *
   *  The opposite evidence to `healedSteps`, and the more informative half. A
   *  step that healed says the locator was stale; a step that could not be
   *  healed says the element is *gone*, which points at the site rather than at
   *  the test. Nothing recorded this before 2026-08-07 — the fixture only ever
   *  wrote an event on success — so it is absent on older runs and, unlike
   *  everything else in this record, could never have been reconstructed. */
  healFailedSteps?: number;
  /** The per-test Playwright timeout THIS run actually executed under, in ms.
   *
   *  Stored on the run rather than read back from the TestRecord, because the
   *  TestRecord holds the CURRENT value: raise a test's timeout today and every
   *  older run's "how close was this step to its budget?" comparison silently
   *  becomes wrong, while still looking like a plausible number. Absent on runs
   *  recorded before this field; read as unknown, never as the default. */
  testTimeoutMs?: number;
  /** The dataset row this run used, when it was one row of a sweep. Both are
   *  stored: the id joins back to the record, and the name survives the row
   *  being renamed or deleted — a run history that can't say WHICH row failed
   *  is the whole reason the sweep exists. */
  datasetId?: string;
  datasetName?: string;
  /** Wall-clock ms this run spent on accessibility checks, and how many ran.
   *  Kept apart from the capture numbers so a slow run's cost can be attributed
   *  to the right feature. */
  a11yMs?: number;
  a11yChecks?: number;
  /** Steps whose accessibility check found violations that are NOT in the
   *  test's accepted baseline. Reported, never fatal — the run's pass/fail is
   *  decided purely by its assertions. */
  a11yNewSteps?: number;
  /** Wall-clock ms this run spent taking screenshots, and how many it took.
   *  Only present on capture runs from the instrumented fixture onward — the
   *  raw inputs for the "what does capture cost?" readout in Stats. */
  captureOverheadMs?: number;
  shotCount?: number;
  /** set when this run re-executed a past run's recorded steps; the id of that
   *  run, so the two can be compared then-vs-now. */
  replayOfRunId?: string;
  /** WHY this failed run failed, when categorized — the id of a reason from
   *  shared/failure-reasons.mjs's built-ins or the custom-reason store. The ID
   *  is stored and the name resolved at display time, so renaming a custom
   *  reason updates every historical run without touching this file. Only ever
   *  present on a failed run. */
  failureReasonId?: string;
  /** Who assigned it. "auto" is the deterministic triage mapping at run end;
   *  "user" is the run panel's picker — and a user assignment is never
   *  overwritten by an automatic one (see setFailureReason). */
  failureReasonBy?: "user" | "auto";
  /** The triage signal that argued for an automatic assignment — the label's
   *  own evidence. Absent on manual assignments. */
  failureReasonSignal?: string;
  /** Distinguishes a real test "run" (default) from a "baseline-update" event
   *  logged when the user accepts screenshots as new baselines. Baseline-update
   *  records are excluded from the pass/fail charts but shown in the history
   *  table so baseline changes are auditable from Stats. */
  kind?: RunRecordKind;
  /** Human-readable summary for non-run events (e.g. baseline-update notes). */
  note?: string;
  /**
   * The test this run belonged to has been deleted.
   *
   * A TOMBSTONE, not a delete. The record stays so the aggregate numbers hold
   * still — pass rate, the daily chart and capture overhead are answers about
   * what this machine has done, and having them lurch when a test is removed
   * makes them untrustworthy for the thing they are for. What goes away is
   * every surface that NAMES the test: the run table, the test filter, log
   * search, and the Stability panel. See `markTestDeleted`.
   *
   * The run's screenshots and its raw .log are really deleted — nothing can
   * display them once the rows are hidden, and they are the bulk of the bytes.
   */
  testDeleted?: boolean;
}

/**
 * How many test runs there have EVER been — the answer the run index alone
 * cannot give.
 *
 * The index is capped (run-history-store.ts, MAX_RECORDS), so counting its
 * records answers "how many runs are still on disk", which is a different
 * question from the one the Stats board's "Total runs" card asks. `runs` is the
 * real figure, carried across pruning by a counter written at the moment of
 * pruning; `retained` is what the chart, the run table and the drill-down lists
 * are able to show. When they differ, the screen says so — two numbers
 * disagreeing with no explanation reads as a bug in whichever one the reader
 * trusts less.
 *
 * Executions only: a baseline update is an event with an incidental `status`,
 * and counting it here would move the pass rate when nothing was executed.
 */
export interface RunTotals {
  /** executions ever recorded, pruned ones included */
  runs: number;
  passed: number;
  failed: number;
  /** executions still in the index — the window every list on the screen shows */
  retained: number;
  /** executions the cap has dropped: `runs - retained` */
  pruned: number;
  /**
   * Pruned runs by the local calendar day they started, oldest first, most
   * recent 60 days.
   *
   * For the figures that are windowed by TIME rather than being lifetime
   * counts — the weekly digest, the pass/fail chart. Pruned runs are always
   * older than every surviving record, so as soon as a thousand runs fit inside
   * a week those windows start losing runs to the cap: "1000 runs this week" on
   * a week that had 1019. The flat totals cannot repair that, because they
   * cannot say WHEN. Empty when nothing has been pruned, or when the breakdown
   * on disk did not survive validation — in which case the windowed figures
   * degrade to counting retained records, which is what they did before.
   */
  prunedDays: RunDayCount[];
}

export interface RunDayCount {
  /** local midnight of the day, epoch ms */
  dayStart: number;
  runs: number;
  passed: number;
  failed: number;
}

/** A hit from searching the raw run logs. */
export interface LogSearchResult {
  runId: string;
  testName: string;
  status: "passed" | "failed";
  startedAt: number;
  matchCount: number;
  /** a short excerpt of the log around the first match */
  snippet: string;
}

/** How a context signal is expressed, and how durable it is.
 *
 *  The order of this list IS the durability ranking the picker sorts by, most
 *  durable first. It is a ranking rather than a filter because durability is a
 *  property of the SITE, not of the property kind: a class name is brittle in a
 *  utility-class codebase and perfectly stable in a hand-written one, and the
 *  user knows which they have. So the brittle kinds are offered, ranked last,
 *  and labelled — not hidden. */
export type ContextSignalKind = "within" | "withinHasText" | "attr" | "class";

export const CONTEXT_SIGNAL_KINDS: ContextSignalKind[] = [
  "within",
  "withinHasText",
  "attr",
  "class",
];

/**
 * One disambiguating property the picker offers, already priced.
 *
 * `count` is what makes the list usable: it is how many elements still match
 * once this signal is applied to the base locator, computed in the page with
 * `matchesFor` — the same oracle `pickLocator` uses to decide what gets
 * recorded. Without it the user is asked to guess whether "inside .card"
 * narrows nine matches to one or to four, and guessing is the thing this
 * feature exists to replace.
 */
export interface ContextSignal {
  kind: ContextSignalKind;
  /** attribute name, or "within" / "within + text" for a container */
  name: string;
  /** the value shown to the user */
  value: string;
  /** the container's locator, for the two `within` kinds */
  locator?: Locator;
  /** the context fragment this row contributes when ticked */
  ctx: LocatorContext;
  /** elements still matching once this signal alone is applied */
  count: number;
  /** true when this signal ALONE identifies the picked element. The picker
   *  leads with these: one tick that ends the ambiguity is both the best
   *  outcome and the shortest emitted locator. */
  resolves: boolean;
}

/** An element captured via the "Refine Selector" picker in the training window. */
export interface PickedElement {
  /** lowercase tag name, e.g. "button" */
  tag: string;
  /** human-readable descriptor, e.g. "button#submit.btn-primary" */
  description: string;
  /** every locator strategy that applies, best-first */
  candidates: Locator[];
  /** curated slice of computed styles */
  css: Record<string, string>;
  /** curated element attributes */
  attributes: Record<string, string>;
  /** The recorder could not find a locator identifying this element on its own
   *  — `pickLocator` fell back to an index. The picker opens EXPANDED on this,
   *  because it is the app's own admission that it had to guess, and it is
   *  exactly the "one of many similar selectors" case. */
  ambiguous: boolean;
  /** the locator the counts below are relative to (what the step would use) */
  contextBase?: Locator;
  /** how many elements `contextBase` matches with no context at all — the
   *  denominator, without which a count means nothing */
  contextBaseCount: number;
  /** disambiguating properties on offer, each priced */
  contextSignals: ContextSignal[];
  /** the element's own trimmed text */
  text?: string;
  /** nearest preceding heading/label text */
  neighborText?: string;
}

/**
 * One test's row in the Batch view: whether it's ticked, which engines it runs
 * on, and headed or headless. Persisted per test id in
 * `RecorderSettings.batchTestOptions`.
 *
 * An ABSENT entry is the default, not a bug — unticked, the test's own
 * `TestRecord.runBrowser` (falling back to `defaultRunBrowser`), and
 * `defaultRunHeadless`. Entries are written only when the user touches a
 * control, so an existing settings file needs no migration.
 */
export interface BatchRowOptions {
  /** ticked in the Batch checklist */
  selected: boolean;
  /** Engines this test runs on, 1–3, deduped, in RUN_BROWSERS order. NEVER
   *  empty: an empty array is a ticked test that silently doesn't run, which
   *  reads as the batch dropping it. Every writer must preserve this. */
  browsers: RunBrowser[];
  /** headed or headless for this row alone */
  headless: boolean;
}

/** Ceiling on the persisted per-row batch options, mirroring MAX_BATCH_ORDER:
 *  far above any real library, so a corrupt file can't grow without bound. */
export const MAX_BATCH_TEST_OPTIONS = 1000;

/** What a deleted test's denormalized name is replaced with in run and batch
 *  history. The records survive so the aggregate counts hold still, but the
 *  NAME is the identifying leftover the delete is supposed to take with it —
 *  and it is the one thing in those files a person would recognise. Matches the
 *  fallback wording the Heals view already uses for an unknown test. */
export const DELETED_TEST_NAME = "(deleted test)";

/** Global trainer preferences, independent of any recording session. */
export interface RecorderSettings {
  /** show the current page's URL in the training window's title bar (default true) */
  showUrlBar: boolean;
  /** Open the trainer panel docked beside the training browser (default false).
   *  Opt-in while the docking behaviour beds in — the in-window trainer stays
   *  the default and is unaffected either way. */
  trainerPanelEnabled: boolean;
  /** default playback speed for new recordings (adds a slowMo delay between
   *  actions during runs); persisted so the New Recording dialog remembers the
   *  last choice. Defaults to "slow" so runs are watchable by default. */
  defaultRunSpeed: TestSpeed;
  /** browser window size for new recordings, or null for the trainer's own
   *  default. Persisted so the New Recording dialog remembers the last preset.
   *  A chosen size also becomes the recording's first `viewport` step, so the
   *  test replays at the size it was recorded at — see recorder/window-size.ts. */
  defaultWindowSize: { width: number; height: number } | null;
  /** Auto-Heal engine enabled (default true). When a step's locator fails to
   *  resolve during replay, the engine probes the page for alternative target
   *  elements using all locator strategies + context from past runs. */
  autoHealEnabled: boolean;
  /** how many heal attempts to make before giving up (default 3). */
  autoHealRetries: number;
  /** per-attempt timeout in ms before the attempt is considered timed-out
   *  (default 4000). */
  autoHealAttemptTimeoutMs: number;
  /** What a successful heal is allowed to do (default "suggest").
   *
   *  "suggest" — the heal gets the step past its failure in memory and records
   *  the change in the heal journal for review. The stored test is untouched.
   *  "apply"   — the healed locator is written to the step immediately.
   *
   *  Governs BOTH the trainer and run-time heal paths from one place, so the
   *  two can't drift into different answers to the same question. */
  autoHealApply: HealApplyMode;
  /** default value of the per-test "Capture screenshots" toggle for tests
   *  that haven't set their own preference (default false). */
  defaultCaptureArtifacts: boolean;
  /** default value of the per-test "Record console & network" toggle (default
   *  FALSE). Off by default because it persists page console output and
   *  request URLs — cheap to collect, but data at rest the user didn't ask
   *  for. */
  defaultRecordLogs: boolean;
  /** EXPERIMENTAL. A test being re-run normally discards its AI debug session,
   *  so each run starts from a blank slate. With this on, a session that is
   *  STILL STREAMING survives instead — marked as belonging to the previous
   *  run and reachable only from the global chip. Finished sessions are
   *  cleared either way: the thing worth protecting is work in progress, not a
   *  stale answer. Default false. */
  keepRunningAiDebugJobs: boolean;
  /** Record EVERY request/response header rather than the allowlist in
   *  log-capture-source.ts (default false). The allowlist covers CORS and
   *  caching, which is what headers are usually wanted for; this is the
   *  explicit escape hatch for anything else, and it can capture credentials. */
  recordAllHeaders: boolean;
  /** Draw each library row's icon by fetching a third-party favicon instead of
   *  the generated monogram (default false).
   *
   *  AN EGRESS SWITCH, so `false` is a security default and not a taste one:
   *  turning it on tells icons.duckduckgo.com the hostname of every test in the
   *  library, every time the sidebar draws. See `SiteIcon` and REDESIGN §3.5;
   *  `check:renderer-egress` pins both defaults and the disclosure copy. */
  siteIconsFromWeb: boolean;
  /** default value of the per-test "Check accessibility" toggle (default
   *  false). Off by default because axe typically costs more per step than
   *  everything else the step does. */
  defaultA11yChecks: boolean;
  /** default value of the per-test "Run headless" toggle for tests that
   *  haven't set their own preference (default false → runs are headed). Only
   *  affects test runs, not the trainer. */
  defaultRunHeadless: boolean;
  /** default browser engine for tests that haven't set their own preference
   *  (default "chromium"). Only affects test runs, not the trainer. */
  defaultRunBrowser: RunBrowser;
  /** default Playwright per-test timeout in ms for tests that haven't set their
   *  own preference (default 60000 = 1 minute). Playwright's built-in default is
   *  30s; this raises it so ordinary multi-step runs don't fail mid-flow. Only
   *  affects test runs, not the trainer. */
  defaultTestTimeoutMs: number;
  /** POST a summary to a user-configured webhook when a run or batch has a
   *  problem (default false). The only thing in the app that sends data off the
   *  machine — inert until a URL is configured, and never includes run logs. */
  alertWebhookEnabled: boolean;
  /** User-chosen run order for the Batch view, as test ids. Tests missing from
   *  this list (newly added) run after it, in library order; ids for deleted
   *  tests are ignored. Empty = plain library order. */
  batchOrder: string[];
  /** Library-rail folders the user has COLLAPSED, by group name (REDESIGN
   *  §7.2). Written straight from the rail, like `batchOrder`, so it has no row
   *  in `settings-schema.ts`.
   *
   *  Collapsed rather than expanded is the list that is stored, because the
   *  default has to be "everything visible": a new group appearing collapsed
   *  would hide the tests that were just put in it, and a library restored on
   *  a fresh install would open showing nothing at all. A name here that no
   *  test carries is simply never read — groups have no records to clean up,
   *  so neither does this. */
  collapsedTestGroups: string[];
  /** Per-row Batch-view options, keyed by test id: ticked, engines, headed.
   *  Written straight from the Batch view (like `batchOrder`) rather than from
   *  the Settings window, so it has no row in `settings-schema.ts`. A test with
   *  no entry falls back to its own record and the defaults above — see
   *  `BatchRowOptions`. */
  batchTestOptions: Record<string, BatchRowOptions>;
  /** How many tests a batch starts at once by default (default 1 = one at a
   *  time, clamped 1–MAX_BATCH_CONCURRENCY). Seeds the Batch view's picker; the
   *  view never writes it back, so choosing "4 at once" for one suite run
   *  doesn't silently become everyone's default. */
  defaultBatchConcurrency: number;
  /** how many runs' screenshot artifacts to keep per test before the oldest
   *  are pruned (default 10, clamped 1–50). The pinned visual baseline is
   *  never pruned regardless of this number. */
  artifactRetainedRuns: number;
  /** post a macOS notification when a run finishes with a failure or a visual
   *  change (default false). Local only — nothing leaves the machine. */
  notifyOnRunIssues: boolean;
  /** Post a macOS notification when a BATCH finishes (default true). Unlike
   *  notifyOnRunIssues this fires on success too: the point of a batch
   *  notification is that the user started a long job and walked away, so
   *  "all 12 passed" is the message they were waiting for. While this is on,
   *  the per-run notification is suppressed for tests inside a batch — one
   *  notification for the suite, not one per failure. */
  notifyOnBatchDone: boolean;
  /** Post a macOS notification when an AI debug job finishes or fails
   *  (default false). Like notifyOnBatchDone it fires on success: the reason
   *  to be told is that the user minimized a slow job and walked away, and
   *  "the answer is ready" is the message they were waiting for. Local only. */
  notifyOnAiDebugDone: boolean;
  /** Generate a periodic AI insights report with the configured LLM provider
   *  (default false). This is the consent switch for the app's only
   *  UNATTENDED AI send: while it is on, a summary of recent activity —
   *  aggregates, test names, error signatures, never logs or scripts — goes
   *  to the configured provider on the cadence below, with nobody reviewing
   *  the individual send. Off by default for exactly that reason, and the
   *  Alerts pane row states what goes. */
  aiInsightsEnabled: boolean;
  /** How often the insights report generates (default "weekly"). */
  aiInsightsCadence: InsightsCadence;
  /** Post a macOS notification when an insights report is ready (default
   *  true). Fires on success by design — the report generates unattended, so
   *  "it's ready" is the message being waited for. The notification itself is
   *  local to this Mac. */
  notifyOnInsightsReady: boolean;
  /** Post a summary of each new insights report — the headline and the
   *  deterministic counts, never the sections — to the Slack incoming webhook
   *  stored for it (default false). Inert until that URL is configured; the
   *  send goes through alert-service, the app's one webhook egress. */
  insightsSlackEnabled: boolean;
  /** Automatically label WHY a failed run failed (default true), by mapping
   *  the triage classifier's strongest signal to a built-in failure reason at
   *  run end. Deterministic and local — no AI, no egress — which is why it
   *  defaults on where the AI toggles above default off. A label the user set
   *  by hand is never overwritten (see runHistoryStore.setFailureReason). */
  autoFailureReasons: boolean;
  /** EXPERIMENTAL. Apply an AI debug job's suggested script fix automatically
   *  the moment the job completes (default false). Guarded: only a run-scoped
   *  job, only while its dialog is minimized, and only when the script is
   *  byte-identical to the one the prompt was built from — an edit made while
   *  the model was thinking always wins, and the suggestion falls back to a
   *  review toast instead. */
  autoAcceptAiDebugFixes: boolean;
  /** How many of the most recent runs keep their RAW .log file (default 1000,
   *  clamped 0–50000; 0 keeps none).
   *
   *  Separate from how many run RECORDS the history keeps, and that separation
   *  is the point. A record is ~700 bytes; the log beside it is tens of KB, so
   *  one number governing both made the cheap thing as scarce as the expensive
   *  one — the history stopped at 1000 runs to bound a DISK cost, and every
   *  count on the Stats screen inherited that ceiling. Records now run to
   *  MAX_RECORDS; this is the log budget, on its own dial. A run past it keeps
   *  its record (and its counts) and loses only its console output. */
  runLogRetainedRuns: number;
  /** additionally delete captured runs older than this many days (0 = off,
   *  max 365). Applies ON TOP of artifactRetainedRuns — a run is kept only if
   *  it satisfies both rules. The pinned baseline is never pruned. */
  artifactRetentionDays: number;
  /** Listen for screenshot requests from an MCP client (default false).
   *  Off by default because it costs a directory watcher, and a debugging aid
   *  has no business running for people who aren't debugging. The in-app
   *  shortcut works regardless of this. */
  debugScreenshots: boolean;
  /** IDs of aesthetic enhancement features the user has disabled.
   *  Empty = all enabled. Known IDs: "aiThinkingGif". */
  disabledAestheticEnhancements: string[];
  /** How big the app's interface is drawn (default 1 = 100%).
   *
   *  A ZOOM FACTOR AND NOT A FONT SIZE, which is the whole design of this
   *  setting: the theme is tuned in whole pixels (9.5px labels inside 24px
   *  controls inside a 34px strip), so growing the text alone overflows the
   *  chrome around it in about a dozen places. Zoom scales both together and
   *  the proportions survive. Applied to the app's own windows only — never to
   *  the training browser. See `main/services/ui-scale.ts`. */
  uiScale: UiScale;
  /** Which typeface pairing the interface is set in (default "space").
   *
   *  "space" is the bundled Space Mono / Space Grotesk pairing the redesign was
   *  drawn in; "system" and "classic" are faces macOS already has. Nothing here
   *  is fetched — see the header of `renderer/theme/fonts.css` for why this app
   *  does not load fonts over the network. */
  uiTypeface: UiTypeface;
  /** Which symbol the Cost panel stamps on a money figure (default "usd").
   *
   *  "none" restores the panel's original behaviour — bare numbers, claiming
   *  nothing about currency. See `shared/cost-units.mjs`. */
  costCurrency: CostCurrency;
  /** What one minute of CI costs, in the currency above (default 0.008).
   *
   *  The Cost panel's whole output scales off this and off the minutes below,
   *  which is why both are settings a user can correct rather than constants.
   *  The Settings pane offers GitHub's published runner rates as pre-fills; the
   *  chosen runner is DERIVED from this number and never stored beside it. */
  costPerCiMinute: number;
  /** How long one run of one test would take a person, by hand, in minutes
   *  (default 12). The other half of every "manual testing avoided" figure. */
  costMinutesPerManualRun: number;
  /** How long working out why a test failed would take a person, in minutes
   *  (default 15). The Stats → AI Debug category multiplies this by diagnoses
   *  that were KEPT, then subtracts the time actually spent waiting on the
   *  model — so the figure is a net saving rather than a gross one. */
  costMinutesPerManualDebug: number;
  /** What an hour of that person's time is worth (default 0).
   *
   *  ZERO IS NOT A PRICE. It is "you have not told me", and every money figure
   *  derived from saved time is SUPPRESSED at 0 rather than rendered as free.
   *  The app declines to guess this — see `shared/cost-units.mjs` — so saved
   *  time stays in hours until the user states a rate of their own. */
  costHourlyRate: number;
  /** Which traffic goes through the proxy (default "none").
   *
   *  "app" is traffic from Good Looks! itself — the AI provider, GitHub,
   *  webhooks, site icons, browser downloads. "test" is the system under
   *  test's traffic — the training browser and every test run, whichever
   *  process spawns it. "none" IGNORES the rest of this configuration without
   *  erasing it, so turning the proxy off for a check doesn't mean retyping
   *  it. Modelled on the mabl Desktop App's proxy settings; the vocabulary
   *  and every rule about it live in `shared/proxy-config.mjs`, because the
   *  MCP server reads these same settings when it spawns runs. */
  proxyTraffic: ProxyTraffic;
  /** Where the proxy configuration comes from (default "automatic").
   *
   *  "automatic" means the OS decides: the training browser and the app's
   *  Chromium-side requests ask the system resolver, test runs let the
   *  browsers detect it themselves, and the app's own Node-side requests
   *  resolve per-URL through the same system rules. "manual" uses the URL and
   *  credentials below instead. */
  proxySource: ProxySource;
  /** The manual proxy, as `scheme://host:port` (default "" = none).
   *
   *  Canonicalised through `normalizeProxyUrl`, which REFUSES credentials in
   *  the URL: this value is stored in the plain settings JSON, and the split
   *  between it and the encrypted password is the point. http://, https://
   *  and socks5:// all reach every consumer. */
  proxyUrl: string;
  /** Username for the manual proxy (default ""). Stored plain — it names an
   *  account, it does not open it. The password half lives encrypted in
   *  `proxy-password-store.ts` and never appears on this object. */
  proxyUsername: string;
  /** Verify TLS certificates on proxied connections (default true).
   *
   *  Off is for proxies that re-sign traffic with their own certificate. It
   *  only relaxes connections that actually go through the configured manual
   *  proxy — direct traffic keeps full verification, and loopback keeps it
   *  even in manual mode. */
  proxySslVerify: boolean;
}

/** What a successful Auto-Heal is allowed to do to the stored test. */
export type HealApplyMode = "suggest" | "apply";

/** A single alternative locator the Auto-Heal engine found for a failed step. */
export interface HealCandidate {
  /** the alternative locator to try */
  locator: Locator;
  /** human-readable description of the matched element (e.g. "button#submit") */
  description: string;
  /** relevance score (0–1, higher = better match) */
  score: number;
  /** true if this candidate matches something seen in past-run debug logs
   *  for this step (the locator previously resolved successfully). */
  matchedPastRun: boolean;
}

/** Result of a heal attempt for a single failed step. */
export interface HealResult {
  /** step id this heal was for */
  stepId: string;
  /** 0-based step index */
  stepIndex: number;
  /** human-friendly step label */
  stepLabel: string;
  /** the step's original locator (before healing) */
  originalLocator: Locator | undefined;
  /** all candidates the engine found, best-first */
  candidates: HealCandidate[];
  /** how many attempts were made */
  attempts: number;
  /** true if a candidate was auto-applied and the step succeeded on re-run */
  ok: boolean;
  /** the locator that was auto-applied (if ok) */
  appliedLocator?: Locator;
  /** true if the best candidate was auto-applied (set by tryHeal) */
  autoApplied: boolean;
  /** short error if healing failed entirely */
  error?: string;
}

/** A single verbose diagnostic line produced while replaying a step. */
export interface DebugLogLine {
  /** monotonic index within the step's log session */
  i: number;
  /** ms timestamp (Date.now()) when the line was produced */
  t: number;
  /** "info" | "warn" | "error" — controls tone in the panel */
  level: "info" | "warn" | "error";
  /** the diagnostic message */
  m: string;
}

/** Persisted debug entry for a single step's replay attempt. */
export interface DebugEntry {
  /** step id this entry belongs to */
  stepId: string;
  /** 1-based step index at the time of replay (for display) */
  stepIndex: number;
  /** human-friendly step label at replay time */
  stepLabel: string;
  /** replay outcome */
  ok: boolean;
  /** short error string (mirrors the legacy `error` field) */
  error?: string;
  /** ms timestamp of the replay attempt */
  at: number;
  /** verbose, ordered diagnostic lines */
  logs: DebugLogLine[];
}

export interface RecorderState {
  recording: boolean;
  paused: boolean;
  assertMode: AssertKind | null;
  stepCount: number;
  testId: string | null;
  /** where the recording STARTS — what gets saved as the test's URL and what
   *  the opening `goto` step replays */
  url: string | null;
  /** where the page is NOW. Separate from `url` on purpose: tracking the live
   *  location in that field would rewrite every saved test's starting point to
   *  wherever the user happened to stop. Null outside a session. */
  liveUrl: string | null;
  name: string | null;
  /** true when continuing/extending an existing test rather than recording a new one */
  editing: boolean;
  /** true when the pending assertion is soft (expect.soft) */
  assertSoft: boolean;
  /** index new steps are inserted at (defaults to the end of the list) */
  cursor: number;
  /** true while the "Refine Selector" element picker is active */
  refineMode: boolean;
  /** Variables this session can interpolate into a step value with `${name}`.
   *
   *  Carried on the session rather than read from the record, because for a NEW
   *  recording there IS no record yet — the id is a UUID nothing has been saved
   *  under. The trainer declares into this list and `finalize` merges it into
   *  whatever the record ends up being. A secret's VALUE is never here; it goes
   *  straight to the encrypted store and only its declaration travels. */
  variables?: TestVariable[];
  /** true while a replay is running steps against the training window.
   *
   *  Broadcast rather than per-window React state because BOTH trainers (the
   *  main window and the docked panel) render one session: without this, the
   *  window that did not start the replay still shows "Recording" and offers
   *  live Add-step / Replay controls, and an action taken there lands in the
   *  middle of a run whose whole premise is that capture is suspended. */
  replaying: boolean;
  /** true once the trainer browser window has finished loading its first page */
  pageReady: boolean;
  /** true while the training browser window is opening but hasn't shown yet.
   *  The renderer shows a loading modal with copy explaining the load; if this
   *  stays true past the timeout, the session is cancelled and an error shown. */
  loading: boolean;
}

// ── Batch (suite) runs ────────────────────────────────────────────────
// A batch drives ordinary runs, one at a time by default and up to
// `concurrency` at a time when asked. Each test still writes its own RunRecord
// (joined back by `RunRecord.batchId`), so a batch is a grouping over runs
// rather than a separate kind of history. Mirror kept in
// renderer/lib/recorder-types.ts.

export type BatchTestStatus = "pending" | "running" | "passed" | "failed" | "skipped";

/** Hard ceiling on how many tests a batch may run at once.
 *
 *  Every concurrent test is a full Node process plus its own browser, so this
 *  is a machine limit, not a preference: past it the runs contend for CPU and
 *  each one gets slower, which looks like flakiness rather than saturation.
 *  Enforced on the BACKEND (see the batch:run handler) so a hostile or buggy
 *  caller — IPC, MCP — can't ask for 500 browsers. */
export const MAX_BATCH_CONCURRENCY = 16;

/** Above this many VISIBLE browsers at once, the Batch view asks first.
 *
 *  Headless runs are invisible and cost only CPU, but every headed run opens a
 *  real window that takes focus when it launches — so a big headed batch makes
 *  the machine unusable for as long as it runs. Ten is where "I can still see
 *  what's happening" stops being true. */
export const HEADED_PARALLEL_WARN = 10;

/** Clamp a requested batch concurrency to something runnable.
 *
 *  `lanes` is how many tests could possibly run at once (see the batch runner:
 *  entries for the SAME test are serialized, so the real ceiling is the number
 *  of DISTINCT tests queued, not the queue length). Shared by the backend
 *  handler and — via the renderer mirror — the warning threshold, so the number
 *  the user is warned about is the number that actually runs. */
export function clampBatchConcurrency(requested: unknown, lanes: number): number {
  const max = Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, Math.floor(lanes) || 1));
  if (typeof requested !== "number" || !Number.isFinite(requested)) return 1;
  return Math.max(1, Math.min(max, Math.floor(requested)));
}

export interface BatchTestResult {
  testId: string;
  testName: string;
  status: BatchTestStatus;
  /** Playwright exit code, once finished. */
  exitCode?: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  /** why the test was skipped, or why it failed to start */
  note?: string;
  /** id of the RunRecord this test produced, when it actually ran. Lets a
   *  persisted batch link through to the run's log in Stats. */
  runRecordId?: string;
  /** The dataset row this entry ran. A sweep queues the same test once per row,
   *  so without this the results list would show N identical-looking entries
   *  with no way to tell which row was the one that failed. */
  datasetId?: string;
  datasetName?: string;
  /** The engine this entry ran on, when the batch fanned the test out across
   *  more than one. Same reasoning as `datasetId`: without it, three results
   *  for one test are indistinguishable. Optional, so batch-history.json
   *  records written before per-row browsers load unchanged. */
  browser?: RunBrowser;
  /** The test has since been deleted. The row is kept so the batch's own
   *  summary still adds up, and hidden by the view. See `RunRecord.testDeleted`
   *  for the reasoning. */
  testDeleted?: boolean;
}

export interface BatchSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** something ran and nothing failed — an all-skipped batch is NOT ok */
  ok: boolean;
  durationMs: number;
}

export interface BatchState {
  batchId: string;
  /** The Routine this batch was started from, when it was started from one.
   *
   *  ADDITIVE AND OPTIONAL, deliberately. ROUTINES.md's rename table says NOT
   *  to rewrite `batch-history.json` — a rename there costs a migration and
   *  buys a word — but a new optional field needs none: an older record simply
   *  has no routine, which is TRUE of it. That is what lets the Routines screen
   *  show one job's history without pretending the app had no history before.
   *
   *  Absent for a batch started any other way (the MCP's `run_batch`, an
   *  older release), and `ORPHAN_BATCH_OWNER` decides who those belong to. */
  routineId?: string;
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  /** index in `results` currently executing, or -1 when idle */
  currentIndex: number;
  results: BatchTestResult[];
  /** the batch ended before its queue did */
  stopped: boolean;
  /** WHY it stopped, when it did. Absent means the user pressed Stop, which is
   *  what `stopped` meant on its own and what every record written before
   *  Routines honoured a failure policy means.
   *
   *  A SEPARATE FIELD rather than a note parsed back out, because three
   *  consumers act on it: the skip note on the entries that never ran, the
   *  alert, and the desktop notification. A scheduled routine's notification is
   *  often the ONLY thing the user sees, and "Batch stopped" for a run nobody
   *  touched is a lie about who did it. */
  stoppedBy?: "user" | "failure";
  /** The test whose failure stopped it, for `stoppedBy: "failure"`. The NAME,
   *  not the id: this is read straight into a notification. */
  stoppedByTest?: string;
  /** When the run's current `wait` barrier ends, as a timestamp. Present ONLY
   *  while the run is sitting in one.
   *
   *  This is what stops a pause from looking like a hang: mid-barrier there is
   *  nothing running and nothing new to report, so a waiting batch is otherwise
   *  indistinguishable on screen from one that has stopped answering. A
   *  timestamp rather than a remaining-ms so the UI can count down without the
   *  backend emitting once a second. */
  waitingUntil?: number;
}

/** A batch as persisted to batch-history.json. Same shape as the live state
 *  plus its computed summary, so a restored batch renders identically to a
 *  live one. `running: true` on a loaded record means the app exited mid-batch. */
export interface BatchRecord extends BatchState {
  summary: BatchSummary;
}

// ── Routines ──────────────────────────────────────────────────────────
// Batch v2: a saved, named job. docs/ROUTINES.md. Mirror kept in
// renderer/lib/recorder-types.ts.
//
// A ROUTINE COMPOSES RUNS; `runFlow` COMPOSES STEPS. That is the line the spec
// calls the main design risk here, and it is why a `test` step names a testId
// and nothing else: it runs that test as its own process, with its own
// RunRecord and its own row in Stats. A Routine never reaches inside a test.
//
// `test`, `group` and `wait` exist. `notify` and `branch` are designed in
// ROUTINES.md and still unbuilt.
//
// `group` came first because it is pure STRUCTURE over test steps: the plan
// flattens it in order, entries carry the group they came from, and the only
// runtime meaning is `skipGroup` — which had nowhere to point until there were
// groups.
//
// `wait` is the first step that is NOT A RUN, and that is the whole of its
// difficulty. A Routine stopped being a set of tests the runner can pour into
// one queue: it is now a SEQUENCE with joins in it. The way that landed without
// a second execution engine — the risk the spec names — is that the plan
// SEGMENTS the steps at each barrier and the existing lane pool runs one
// segment at a time. See `routineRunPlan`. `notify` and `branch` are additive
// on top of that machinery; they were left out of this slice so the barrier
// itself could be the thing under review.

/** What a Routine does when one of its steps fails. `continue` FIRST and the
 *  default: it is Batch's current unwritten behaviour, so anything else changes
 *  what a migrated job does on its first run. See ROUTINES.md — no `retry`
 *  policy in v1, because a routine-level retry stacked on Auto-Heal makes a
 *  flaky test look stable, which is the signal Stability exists to give. */
export type FailurePolicy = "continue" | "stopRoutine" | "skipGroup";

export interface RoutineTestStep {
  kind: "test";
  testId: string;
  /** Engines this step runs on. NEVER empty — an empty array is a step that
   *  produces no queue entries, so the Routine silently runs fewer tests than
   *  it lists. Same invariant `batch-run-plan.ts` protects for a Batch row. */
  browsers: RunBrowser[];
  headless: boolean;
  onFailure: FailurePolicy;
  /** The test this step names has been deleted. MARKED, NOT REMOVED — ROUTINES
   *  open question 4: silently shrinking a saved job is the same class of bug
   *  as the batch running fewer tests than it said. The step renders as broken
   *  and the user removes it, so the job they built is the job they see. */
  testDeleted?: boolean;
}

/**
 * A named run of steps, for the one thing groups mean at run time: `skipGroup`.
 *
 * ONE LEVEL DEEP. A group holds test steps and never another group, and that is
 * a v1 constraint rather than an oversight — nesting multiplies the editor, the
 * flattening and the skip semantics, and nothing asked for it. The type says so
 * rather than the store quietly dropping what it cannot handle.
 *
 * NO `parallel` FLAG YET, which ROUTINES.md's sketch has. The runner's
 * concurrency is a single global lane limit, so "these four together, then the
 * checkout suite one at a time" cannot be expressed by a number — it needs the
 * same barrier machinery `wait` does. Shipping the flag without it would be a
 * builder that draws two parallel branches and runs them sequentially, which
 * the spec calls lying in a diagram.
 */
export interface RoutineGroupStep {
  kind: "group";
  /** Stable across renames and reorders. Test steps are keyed by `testId` —
   *  unique within a Routine, because the store collapses duplicates — but a
   *  group has no natural key, and the run record refers to it by this. */
  id: string;
  label: string;
  steps: RoutineTestStep[];
}

/**
 * Pause the Routine. docs/ROUTINES.md capability 3.
 *
 * A BARRIER, not a sleep on one lane. Everything queued before it finishes
 * before the clock starts, and nothing after it begins until the clock ends —
 * which is the only reading that makes a wait mean anything: "let the thing the
 * last step triggered settle" is a statement about the whole job, and a wait
 * that ran concurrently with the steps around it would be a no-op wearing a
 * label.
 *
 * `ms` is bounded (see `MAX_ROUTINE_WAIT_MS`). A wait is a stretch of time the
 * user cannot see progress through and can only escape with Stop, so an
 * unbounded one is a job that looks hung.
 */
export interface RoutineWaitStep {
  kind: "wait";
  /** Stable across edits and reorders. Same reasoning as a group's: a wait has
   *  no natural key, and two waits of the same length are different steps. */
  id: string;
  ms: number;
}

/**
 * Say something when the run reaches this point. docs/ROUTINES.md capability 3.
 *
 * A BARRIER, like `wait`: everything before it finishes before it fires. "Tell
 * me when the seeding is done" is a claim about the steps above it, and a
 * notify racing them would report a thing that had not happened.
 *
 * THE MESSAGE IS STATIC TEXT, and that is a security decision rather than a
 * missing feature. `channel: "webhook"` sends it off the machine through
 * `alert-service`, which is the app's ONLY egress and is summary-only by
 * design — run logs are never sent, because they routinely carry page content,
 * URLs with tokens and typed fixture values. A message with `${...}`
 * interpolation would turn this field into a general-purpose pipe from run data
 * to a third-party endpoint, which is exactly what `check:alerts` exists to
 * prevent. If interpolation is ever added it needs its own allow-list of
 * substitutable values, not a template engine.
 */
export interface RoutineNotifyStep {
  kind: "notify";
  /** Stable across edits and reorders, like a group's and a wait's. */
  id: string;
  /** `desktop` is local and always available. `webhook` goes through
   *  `alert-service` and is INERT until the user configures a URL — which is
   *  the same promise the run and batch alerts make. */
  channel: "desktop" | "webhook";
  message: string;
}

/**
 * Take one of two paths. docs/ROUTINES.md capability 3, the last step kind.
 *
 * BOTH SIDES ARE QUEUED UP FRONT and the untaken one is marked skipped when the
 * branch is reached. That is the whole design, and the alternative is what makes
 * it worth stating: building the queue as the run goes would mean
 * `BatchState.results` growing mid-run, which every part of this feature assumes
 * it does not — write-through persistence, the summary, `currentIndex`, and the
 * view's per-row result lookup are all written against a fixed list decided at
 * start. Queueing both and skipping one keeps every one of them true, and the
 * skipped rows say WHY, which a queue that never mentioned them could not.
 *
 * The cost is that `plannedRuns` becomes a MAXIMUM rather than a count. A
 * Routine with a branch will run fewer entries than it queues, always. The
 * toolbar says so.
 *
 * `on` is evaluated against THE RUN SO FAR, not against the immediately
 * preceding step. "If anything has failed, run the teardown" is the thing
 * people mean, and scoping it to the last segment would make the answer depend
 * on where the user happened to put a pause.
 *
 * ONE LEVEL DEEP, like `group`: each side holds test steps and never another
 * branch. Nesting multiplies the editor and the skip semantics, and a flat
 * checklist cannot draw it honestly.
 */
export interface RoutineBranchStep {
  kind: "branch";
  id: string;
  on: "anyFailed" | "allPassed";
  then: RoutineTestStep[];
  else: RoutineTestStep[];
}

export type RoutineStep =
  | RoutineTestStep
  | RoutineGroupStep
  | RoutineWaitStep
  | RoutineNotifyStep
  | RoutineBranchStep;

/** Longest a `notify` message may be. Bounded because it is user text that can
 *  leave the machine: a webhook body is not the place for a paste of something
 *  large, and a cap is cheaper to reason about than a truncation nobody sees. */
export const MAX_ROUTINE_MESSAGE = 200;

/** Longest a single `wait` step may pause a Routine: one hour.
 *
 *  A CEILING RATHER THAN A WARNING. The runner holds the batch open across a
 *  wait, so a stored value of `Infinity` — or of `86_400_000` typed by someone
 *  who meant seconds — is a batch that never finishes and reports nothing about
 *  why. Anything longer than this is what a SCHEDULE is for, and the app has
 *  one. */
export const MAX_ROUTINE_WAIT_MS = 60 * 60 * 1000;

/**
 * When a Routine runs by itself. docs/ROUTINES.md capability 2.
 *
 * NOT A CRON STRING, which is what the spec sketched — see
 * `shared/routine-schedule.mjs` for the argument. The short version: a cron
 * text field's failure mode is a schedule that never fires, and that looks
 * exactly like a schedule that is not due yet. An enumerated schedule cannot
 * hold a value the picker could not produce.
 *
 * `everyMinutes` is anchored to LOCAL MIDNIGHT, not to the last run, so the
 * cadence cannot drift; `minutes` is constrained to divisors of a day so there
 * is no short gap at the end of it. `minute` is minutes since local midnight.
 *
 * `onceAt` holds an absolute epoch-ms INSTANT rather than a wall-clock
 * description — a one-off is a moment, not a rule, and storing it as one is
 * what makes "has it fired yet" a comparison instead of bookkeeping. Its
 * three-year horizon is a question about the future, so it lives in
 * `withinOnceHorizon` rather than in the type or the normalizer.
 *
 * There is no `everyHours` any more. It migrates to `everyMinutes` on read —
 * see `shared/routine-schedule.mjs`.
 */
export type RoutineSchedule =
  | { kind: "everyMinutes"; minutes: number }
  | { kind: "dailyAt"; minute: number }
  | { kind: "weekdaysAt"; minute: number }
  | { kind: "onceAt"; at: number };

export interface RoutineDefaults {
  captureArtifacts: boolean;
  /** Lanes. Clamped against the queue by `clampBatchConcurrency` at run time,
   *  not here — a saved Routine's number is a preference, and the ceiling
   *  depends on how many distinct tests it actually queues. */
  concurrency: number;
}

export interface Routine {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  steps: RoutineStep[];
  /** When it runs by itself. Absent means it only runs when you press Run. */
  schedule?: RoutineSchedule;
  /**
   * When this Routine's SCHEDULE last fired — not when the Routine last ran.
   *
   * Held beside the schedule rather than inside it, which is where the spec put
   * it: editing a schedule then cannot clobber the record of what it has
   * already done, and "I changed the time and it ran again immediately" is a
   * bug nobody would think to look for. A MANUAL run does not update it, so
   * running the job by hand at 23:00 does not cancel its 23:30 occurrence.
   */
  lastScheduledRunAt?: number;
  defaults: RoutineDefaults;
}

/** Ceiling on stored Routines. This is a local app and the whole index is
 *  rewritten on every save; a person with more than this many saved jobs has a
 *  different problem than the one Routines solves. */
export const MAX_ROUTINES = 50;

/** Ceiling on steps in one Routine. Bounds the file, and bounds what a single
 *  IPC payload can ask the runner to queue. */
export const MAX_ROUTINE_STEPS = 200;

/** Longest a Routine's name may be. Long enough for a real sentence, short
 *  enough that the list stays a list. */
export const MAX_ROUTINE_NAME = 80;

// ── Cookies ───────────────────────────────────────────────────────────
// Mirror kept in renderer/lib/recorder-types.ts.

export type CookieAction = "set" | "delete" | "clearAll";

/** Glaze/Chromium sameSite spelling (see @shell/backend CookieSameSite).
 *  NOT the same vocabulary Playwright uses — see toPlaywrightSameSite. */
export type CookieSameSite = "unspecified" | "no_restriction" | "lax" | "strict";

export interface CookieSpec {
  name: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: CookieSameSite;
  /** Unix seconds. Omit for a session cookie (cleared when the browser closes). */
  expirationDate?: number;
  /** URL the cookie is scoped to. `session.cookies.set/remove` require it, and
   *  Playwright accepts either `url` OR `domain`+`path` — never a mix. */
  url?: string;
}

/**
 * Chromium and Playwright disagree on how to spell sameSite, and getting this
 * wrong silently produces a cookie the site won't send on navigation:
 *   Chromium "no_restriction" ≡ Playwright "None"
 *   Chromium "lax"            ≡ Playwright "Lax"
 *   Chromium "strict"         ≡ Playwright "Strict"
 *   Chromium "unspecified"    → omitted (let Playwright default)
 */
export function toPlaywrightSameSite(v: CookieSameSite | undefined): "Strict" | "Lax" | "None" | null {
  switch (v) {
    case "strict":
      return "Strict";
    case "lax":
      return "Lax";
    case "no_restriction":
      return "None";
    default:
      return null;
  }
}

/** Inverse of toPlaywrightSameSite, for parsing a spec back into steps. */
export function fromPlaywrightSameSite(v: string | undefined): CookieSameSite | undefined {
  switch (v) {
    case "Strict":
      return "strict";
    case "Lax":
      return "lax";
    case "None":
      return "no_restriction";
    default:
      return undefined;
  }
}

/** A cookie step needs a scope Playwright will accept: domain+path, or a url.
 *  Returns null when the step carries neither, so the generator can skip
 *  emitting an addCookies call that Playwright would reject at runtime. */
export function cookieScopeIsValid(spec: CookieSpec | undefined): boolean {
  if (!spec || !spec.name) return false;
  return !!spec.url || !!(spec.domain && spec.path);
}

// ── AI debug sessions (minimizable "Debug with AI" jobs) ─────────────
// A session is one LLM diagnosis — either of a whole failed run or of a single
// trainer step. Sessions can be minimized and outlive the view that started
// them, so they persist here rather than in component state.

/** Lifecycle of one AI debug session.
 *
 *  `interrupted` exists only on RESTORE: the backend's in-flight request map
 *  dies with the process, so a session persisted as "streaming" describes a job
 *  that no longer exists. Startup rewrites those (see reconcileInterrupted)
 *  rather than restoring a phantom in-progress job. */
export type AiDebugStatus =
  | "idle"
  | "streaming"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

export type AiDebugKind = "run" | "step";

/** The persisted shape. Deliberately does NOT include the prompt `messages`:
 *  they embed the full script and run output — page content, URLs with session
 *  tokens, values typed while recording — and they're reconstructible from live
 *  data via buildDebugMessages. Only the model's answer is kept. */
export interface AiDebugSession {
  key: string;
  kind: AiDebugKind;
  testId: string;
  /** Display label for the chip/list ("Step 3: click Submit", or the test name). */
  label: string;
  testName: string;
  status: AiDebugStatus;
  content: string;
  reasoning: string;
  error: string | null;
  /** Which kind of failure `error` was, so the UI offers the right fix without
   *  re-deriving it from the message text. Absent on sessions stored before
   *  kinds existed. */
  errorKind?: LlmErrorKind | null;
  /** Backend llm request id while streaming; null once terminal. Owning this is
   *  what makes an orphaned request cancellable. */
  requestId: string | null;
  /** Identifies the RUN this session describes — the artifact id, or a hash of
   *  the run output before one exists. A session is about one execution, not
   *  about a test in general: reopening the panel after a re-run must not show
   *  a diagnosis of output that is no longer on screen. */
  runKey?: string | null;
  /** True when this session outlived the run it describes — kept alive only
   *  because it was still streaming and the user opted to preserve running
   *  jobs. Everything showing it must say so: its answer is about output that
   *  is no longer on screen. */
  superseded?: boolean;
  /** Hash of the script the prompt was built from, so a diff computed against a
   *  since-edited script can be flagged instead of silently clobbering it. */
  scriptHash: string | null;
  /** Which model answered, stamped when the stream started. The auto-apply path
   *  labels the resulting script-change entry with it, and runs long after the
   *  panel that chose the model is gone — reading the current setting there
   *  would name whichever model happens to be selected then. Absent on sessions
   *  stored before this was recorded. */
  model?: string;
  startedAt: number;
  updatedAt: number;
  /** Restored from disk with no live context behind it — readable, not re-runnable. */
  readOnly?: boolean;
}

/** Bumped when the persisted shape changes; an unrecognized version reads as
 *  empty rather than half-parsing into a wrong-shaped session. */
export const AI_DEBUG_SESSIONS_VERSION = 1;

export interface AiDebugSessionsFile {
  version: number;
  sessions: AiDebugSession[];
}

// ── AI debug history (what the Stats board counts) ───────────────────
//
// A SECOND, SEPARATE STORE, and the split is the whole point. `AiDebugSession`
// above is the ANSWER — the model's text, quoting the script and the run
// output — and it is kept for reading: newest twenty only, hard-deleted with
// its test, because with the test gone there is no route to it and no reason to
// keep the quotes. That is a good rule for content and a useless one for
// counting: it cannot say how many sessions there have ever been, how long they
// took, or whether last month was better than this one.
//
// So the FACTS about a session live here instead, with no content at all: no
// answer, no reasoning, no script, no error message — only its shape (see
// `AiDebugHistoryRecord`). Nothing in this record quotes the page or the test,
// which is what lets it outlive both the twenty-session cap and the test
// itself. A deleted test TOMBSTONES its rows the way run records are
// tombstoned, rather than erasing them: the sessions really happened, and
// rewriting the totals to pretend otherwise is what makes an aggregate stop
// being worth reading.

/** Whether a person asked for this diagnosis, or the app started it on its own.
 *
 *  EVERY SESSION IS `manual` TODAY — nothing in the app starts one by itself.
 *  It is recorded anyway because the field cannot be backfilled: the day
 *  failing tests debug themselves, "I asked for this" versus "it decided" is
 *  the first filter every panel here needs, and every record written before the
 *  field existed would be unclassifiable forever. */
export type AiDebugTrigger = "manual" | "auto";

/**
 * One ATTEMPT at one diagnosis — the unit the Stats board counts.
 *
 * An attempt, not a session: re-sending after a connection error is a second
 * request, a second wait and a second chance at an answer, and folding it into
 * the first would quietly under-count both the failures and the time. Sessions
 * are keyed by test (`run:<testId>`), so the key alone cannot separate them;
 * `id` is minted per send.
 *
 * NO CONTENT, EVER. `answerChars` is the SIZE of the answer, not the answer;
 * `errorKind` is which class of failure it was, not the message. See the header
 * above for why that constraint is what makes this store outlive its subject.
 */
export interface AiDebugHistoryRecord {
  /** Unique per attempt. Minted by the renderer at send time. */
  id: string;
  /** The session key this attempt belonged to (`run:<id>` / `step:<id>:<n>`). */
  key: string;
  kind: AiDebugKind;
  testId: string;
  /** The test's name AS IT WAS. Copied rather than joined, because the join
   *  stops resolving the moment the test is deleted — and a tombstoned row that
   *  cannot name its test is a row no panel can list. */
  testName: string;
  /** The test has since been deleted. The record stays and still counts; every
   *  surface that offers to OPEN the test must skip it. */
  testDeleted?: boolean;
  trigger: AiDebugTrigger;
  /** Which provider answered. Null means UNKNOWN — a record written before the
   *  provider was stamped — and must never be reported as local or as hosted:
   *  the local-model savings figure is exactly the number a guess here would
   *  corrupt. */
  provider: string | null;
  model: string | null;
  /** How it ended. `streaming` while live, and rewritten to `interrupted` at
   *  startup if the app exited first — same reconciliation the session store
   *  does, and for the same reason: a permanently-live row would inflate every
   *  duration on the board. */
  status: AiDebugStatus;
  errorKind?: LlmErrorKind | null;
  startedAt: number;
  /** Null while the attempt is still live. */
  endedAt: number | null;
  /** Wait before the first token arrived. Null when nothing arrived at all,
   *  which is a different fact from a long wait and reads as one. */
  firstTokenMs: number | null;
  /** Size of the prompt and of the answer, in characters. The only basis this
   *  app has for a token figure (~4 chars/token, the approximation
   *  `provider-errors.ts` already uses on screen), and it is labelled as an
   *  approximation everywhere it is shown. */
  promptChars: number;
  answerChars: number;
  /** Which run this attempt was about, so a fix can be matched to the run that
   *  followed it. Null for step sessions and for anything predating run keys. */
  runKey: string | null;
}

/** Bumped when the persisted shape changes; an unrecognized version reads as
 *  empty rather than half-parsing. */
export const AI_DEBUG_HISTORY_VERSION = 1;

export interface AiDebugHistoryFile {
  version: number;
  records: AiDebugHistoryRecord[];
}

/** The statuses a record can hold. Anything else read off disk is not a status
 *  this app produces, and is filed as `interrupted` rather than trusted. */
const AI_DEBUG_STATUSES: AiDebugStatus[] = [
  "idle",
  "streaming",
  "done",
  "error",
  "cancelled",
  "interrupted",
];

const LLM_ERROR_KINDS: LlmErrorKind[] = [
  "no-model",
  "auth",
  "model-unavailable",
  "provider",
  "empty-response",
  "connection",
];

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function nullableFinite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Rebuild a history record from whatever arrived.
 *
 * REBUILT, NOT FILTERED — the rule the capture boundary is held to, applied
 * here for the same reason. Spreading the input and overwriting known keys
 * carries every unknown key straight into the file, so the next field wired in
 * would silently become a hole. This lists what a record is and takes nothing
 * else, which also means a record read back from a hand-edited file cannot
 * carry the one thing this store promises never to hold: content.
 */
export function normalizeAiDebugHistoryRecord(input: unknown): AiDebugHistoryRecord | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const id = String(raw.id ?? "");
  const key = String(raw.key ?? "");
  const testId = String(raw.testId ?? "");
  // An id-less or test-less record can be neither found, updated nor attributed
  // — dropping it beats storing a row nothing can ever reach.
  if (!id || !key || !testId) return null;
  const status = raw.status as AiDebugStatus;
  const errorKind = raw.errorKind as LlmErrorKind;
  return {
    id,
    key,
    kind: raw.kind === "step" ? "step" : "run",
    testId,
    testName: String(raw.testName ?? ""),
    ...(raw.testDeleted ? { testDeleted: true } : {}),
    trigger: raw.trigger === "auto" ? "auto" : "manual",
    provider: typeof raw.provider === "string" && raw.provider ? raw.provider : null,
    model: typeof raw.model === "string" && raw.model ? raw.model : null,
    status: AI_DEBUG_STATUSES.includes(status) ? status : "interrupted",
    errorKind: LLM_ERROR_KINDS.includes(errorKind) ? errorKind : null,
    startedAt: finiteOr(raw.startedAt, 0),
    endedAt: nullableFinite(raw.endedAt),
    firstTokenMs: nullableFinite(raw.firstTokenMs),
    // Negative sizes are not a thing; clamping beats trusting, because these
    // are multiplied into a token estimate the panel puts on screen.
    promptChars: Math.max(0, Math.round(finiteOr(raw.promptChars, 0))),
    answerChars: Math.max(0, Math.round(finiteOr(raw.answerChars, 0))),
    runKey: typeof raw.runKey === "string" && raw.runKey ? raw.runKey : null,
  };
}

/**
 * Where the insert cursor sits when a trainer session opens.
 *
 * Opening a session executes exactly ONE thing: the initial navigation. No
 * recorded step is replayed (that auto-replay was removed — it flew through the
 * whole test and could wedge the backend). So the session's position in the
 * test is "just past the goto", and the cursor — which decides where the next
 * captured step lands — belongs there.
 *
 * It used to default to the END of the list when continuing an existing test,
 * which quietly meant every newly recorded step was appended after the last
 * one, no matter where in the flow the user actually was. Since the browser is
 * sitting on the starting URL, appending to the end is the one position that is
 * almost certainly wrong.
 *
 * A NEW recording passes an empty list; its `goto` (and the `viewport` step
 * ahead of it, when the session has a window-size preset) is added immediately
 * after and pushes the cursor along by the normal insert path, so both cases
 * converge on the same place.
 *
 * Takes the STEPS rather than a count because the navigation is not always
 * index 0: a test recorded at a window-size preset opens with a `viewport`
 * step, and a cursor hardcoded to 1 would drop every newly captured step
 * BETWEEN the viewport and the goto — i.e. before the page it was recorded
 * against had even been navigated to.
 */
export function initialCursor(editing: boolean, steps: readonly Step[]): number {
  if (!editing) return steps.length;
  const navIndex = steps.findIndex((s) => s.type === "goto");
  // No navigation to sit past (shouldn't happen — an existing test always has
  // its goto): fall back to the front of the list rather than the end, which is
  // the position this function exists to stop being the default.
  if (navIndex === -1) return Math.min(1, steps.length);
  // Just past the navigation, or the end of a shorter list.
  return Math.min(navIndex + 1, steps.length);
}

// ── AI Insights ─────────────────────────────────────────────────────────────
//
// The scheduled report the insights service generates. The report is PRIMARY
// data (an LLM answer cannot be re-derived from history), stored in
// `insight-reports.json` — never in the metrics DB, which drops and replays
// itself on schema bumps. The model's output crosses a trust boundary on the
// way in — it was steered by test names and error text a web page can
// influence — so everything here is rebuilt field-by-field like every other
// boundary-crossing record in this file.

/**
 * What a recommendation's button can DO. A closed enum on purpose: each kind
 * maps to a hard-coded renderer behavior (run a test, open the AI debug
 * dialog, navigate), so the model chooses from a menu and can never name a
 * path, a channel or a target the app didn't offer. Test-scoped kinds carry a
 * `testId` that is validated against the tests the model was SHOWN at parse
 * time, and against the live library at render time.
 */
export type InsightActionKind =
  | "run-test"
  | "debug-test"
  | "open-test"
  | "open-stats"
  | "open-heals"
  | "open-visual"
  | "open-settings-integrations";

export const INSIGHT_ACTION_KINDS: InsightActionKind[] = [
  "run-test",
  "debug-test",
  "open-test",
  "open-stats",
  "open-heals",
  "open-visual",
  "open-settings-integrations",
];

export function isInsightActionKind(v: unknown): v is InsightActionKind {
  return typeof v === "string" && (INSIGHT_ACTION_KINDS as string[]).includes(v);
}

const TEST_SCOPED_ACTION_KINDS: ReadonlySet<InsightActionKind> = new Set([
  "run-test",
  "debug-test",
  "open-test",
]);

export interface InsightAction {
  kind: InsightActionKind;
  /** Required for the test-scoped kinds; absent otherwise. */
  testId?: string;
  /** The test's name AS IT WAS — copied, not joined, so a deleted test's
   *  recommendation still reads as a sentence (same rule as
   *  AiDebugHistoryRecord.testName). */
  testName?: string;
  /** The model's one-line reason for the recommendation. Prose, clamped —
   *  the button's VERB is ours, fixed per kind, so this can never relabel
   *  "Run test" into something else. */
  label: string;
}

export interface InsightSection {
  title: string;
  /** Plain prose. Rendered as paragraphs, never interpreted as markup. */
  body: string;
}

/**
 * The deterministic numbers strip. Computed by the facts builder from the
 * stores — NEVER parsed back out of the model's prose, so a hallucinated
 * figure cannot reach a number the user reads. `null` fields are "the metrics
 * DB was unavailable", which is a different fact from zero.
 */
export interface InsightStats {
  runs: number;
  failed: number;
  previousRuns: number;
  flakyRuns: number;
  healedSteps: number;
  healFailures: number;
  visualChanges: number | null;
  newClusters: number | null;
  a11yNewSteps: number;
  testsCreated: number;
  unreviewedScriptChanges: number;
  expiringSignatures: number;
}

/** One line of the per-report "what was sent" disclosure: a payload category
 *  and its size in characters (characters, not tokens — a token count is a
 *  guess dressed as a measurement). Stored WITH the report because it
 *  describes the send that actually happened, not the one today's builder
 *  would make. */
export interface InsightSendingItem {
  label: string;
  chars: number;
}

export interface InsightReport {
  id: string;
  cadence: InsightsCadence;
  /** The rolling window the report summarizes. */
  periodStart: number;
  periodEnd: number;
  generatedAt: number;
  /** Resolved by the completion call, same rationale as `llm:chat`'s return:
   *  only the backend knows what the configured values were at send time. */
  provider: string;
  model: string;
  headline: string;
  sections: InsightSection[];
  actions: InsightAction[];
  stats: InsightStats;
  sending: InsightSendingItem[];
  /** Present when the model's answer failed the JSON contract and `sections`
   *  holds its raw prose — the view labels it, and there are no actions.
   *  Absent-not-false, like `testDeleted`. */
  degraded?: true;
  promptChars: number;
  answerChars: number;
  durationMs: number;
  firstTokenMs: number | null;
  read: boolean;
}

/** The list row: everything the Insights rail list renders, nothing more. */
export interface InsightReportSummary {
  id: string;
  cadence: InsightsCadence;
  generatedAt: number;
  headline: string;
  read: boolean;
  degraded?: true;
}

export interface InsightsState {
  /** Last successful generation. What the due-rule compares against. */
  lastGeneratedAt: number | null;
  /** Last FAILED attempt, stamped when the attempt settles — never at start,
   *  so a quit mid-generation persists nothing and the period stays due. What
   *  the retry backoff compares against. */
  lastAttemptAt: number | null;
  lastError: { at: number; kind: LlmErrorKind; message: string } | null;
  /** App version at the last successful generation, so the next report can
   *  say what changed in the app since the reader last heard. */
  lastSeenAppVersion: string | null;
}

/** What `insights:status` answers: the persisted state plus whether a
 *  generation is in flight right now. */
export interface InsightsStatus extends InsightsState {
  generating: boolean;
}

export const MAX_INSIGHT_SECTIONS = 8;
export const MAX_INSIGHT_ACTIONS = 6;
export const MAX_INSIGHT_HEADLINE_CHARS = 200;
export const MAX_INSIGHT_SECTION_TITLE_CHARS = 120;
export const MAX_INSIGHT_SECTION_BODY_CHARS = 4000;
export const MAX_INSIGHT_ACTION_LABEL_CHARS = 160;

function clampText(v: unknown, max: number): string {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Rebuild one action from untrusted input.
 *
 * `knownTestIds` is the set of tests the model was SHOWN (the facts pack's
 * index) — passed at PARSE time so an invented or off-menu id is dropped
 * before persistence. Pass `null` when re-normalizing a stored report on
 * read: the library has moved on since generation, and a since-deleted test's
 * action must survive to render disabled rather than vanish from history.
 */
export function normalizeInsightAction(
  input: unknown,
  knownTestIds: ReadonlySet<string> | null,
): InsightAction | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (!isInsightActionKind(raw.kind)) return null;
  const label = clampText(raw.label, MAX_INSIGHT_ACTION_LABEL_CHARS);
  if (!label) return null;
  if (!TEST_SCOPED_ACTION_KINDS.has(raw.kind)) {
    // Rebuilt, not spread: a navigation action carries no test identity, and
    // whatever else rode in on the object stays behind.
    return { kind: raw.kind, label };
  }
  const testId = typeof raw.testId === "string" ? raw.testId : "";
  if (!testId) return null;
  if (knownTestIds && !knownTestIds.has(testId)) return null;
  const testName = clampText(raw.testName, 160);
  return { kind: raw.kind, testId, ...(testName ? { testName } : {}), label };
}

export function normalizeInsightSection(input: unknown): InsightSection | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const body = clampText(raw.body, MAX_INSIGHT_SECTION_BODY_CHARS);
  if (!body) return null;
  return { title: clampText(raw.title, MAX_INSIGHT_SECTION_TITLE_CHARS), body };
}

function normalizeInsightStats(input: unknown): InsightStats {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const count = (v: unknown) => Math.max(0, Math.round(finiteOr(v, 0)));
  const countOrNull = (v: unknown) => {
    const n = nullableFinite(v);
    return n === null ? null : Math.max(0, Math.round(n));
  };
  return {
    runs: count(raw.runs),
    failed: count(raw.failed),
    previousRuns: count(raw.previousRuns),
    flakyRuns: count(raw.flakyRuns),
    healedSteps: count(raw.healedSteps),
    healFailures: count(raw.healFailures),
    visualChanges: countOrNull(raw.visualChanges),
    newClusters: countOrNull(raw.newClusters),
    a11yNewSteps: count(raw.a11yNewSteps),
    testsCreated: count(raw.testsCreated),
    unreviewedScriptChanges: count(raw.unreviewedScriptChanges),
    expiringSignatures: count(raw.expiringSignatures),
  };
}

function normalizeInsightSending(input: unknown): InsightSendingItem[] {
  if (!Array.isArray(input)) return [];
  const out: InsightSendingItem[] = [];
  for (const item of input.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const label = clampText(raw.label, 80);
    if (!label) continue;
    out.push({ label, chars: Math.max(0, Math.round(finiteOr(raw.chars, 0))) });
  }
  return out;
}

/** Rebuild a stored report. Returns null when the identity fields are
 *  unusable — a report nothing can list or open is not worth carrying. */
export function normalizeInsightReport(input: unknown): InsightReport | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const id = String(raw.id ?? "");
  const generatedAt = finiteOr(raw.generatedAt, 0);
  if (!id || generatedAt <= 0 || !isInsightsCadence(raw.cadence)) return null;
  const headline = clampText(raw.headline, MAX_INSIGHT_HEADLINE_CHARS);
  if (!headline) return null;
  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .slice(0, MAX_INSIGHT_SECTIONS)
    .map(normalizeInsightSection)
    .filter((s): s is InsightSection => s !== null);
  const actions = (Array.isArray(raw.actions) ? raw.actions : [])
    .slice(0, MAX_INSIGHT_ACTIONS)
    .map((a) => normalizeInsightAction(a, null))
    .filter((a): a is InsightAction => a !== null);
  return {
    id,
    cadence: raw.cadence,
    periodStart: finiteOr(raw.periodStart, 0),
    periodEnd: finiteOr(raw.periodEnd, generatedAt),
    generatedAt,
    provider: String(raw.provider ?? ""),
    model: String(raw.model ?? ""),
    headline,
    sections,
    actions: raw.degraded ? [] : actions,
    stats: normalizeInsightStats(raw.stats),
    sending: normalizeInsightSending(raw.sending),
    ...(raw.degraded ? { degraded: true as const } : {}),
    promptChars: Math.max(0, Math.round(finiteOr(raw.promptChars, 0))),
    answerChars: Math.max(0, Math.round(finiteOr(raw.answerChars, 0))),
    durationMs: Math.max(0, Math.round(finiteOr(raw.durationMs, 0))),
    firstTokenMs: nullableFinite(raw.firstTokenMs),
    read: raw.read === true,
  };
}

export function normalizeInsightsState(input: unknown): InsightsState {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const err = raw.lastError as Record<string, unknown> | null | undefined;
  const errKind = err?.kind as LlmErrorKind;
  return {
    lastGeneratedAt: nullableFinite(raw.lastGeneratedAt),
    lastAttemptAt: nullableFinite(raw.lastAttemptAt),
    lastError:
      err && typeof err === "object" && typeof err.message === "string" && err.message
        ? {
            at: finiteOr(err.at, 0),
            kind: LLM_ERROR_KINDS.includes(errKind) ? errKind : "provider",
            message: clampText(err.message, 500),
          }
        : null,
    lastSeenAppVersion:
      typeof raw.lastSeenAppVersion === "string" && raw.lastSeenAppVersion
        ? raw.lastSeenAppVersion
        : null,
  };
}
