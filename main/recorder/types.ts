// Shared recorder data model (backend). Mirror kept in renderer/lib/recorder-types.ts.

import type { LlmErrorKind } from "../services/llm/types.js";

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
  | "runFlow";

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

export type LocatorKind = "testid" | "role" | "label" | "placeholder" | "text" | "css" | "xpath";

export interface Locator {
  k: LocatorKind;
  /** value for testid/label/placeholder/text/css/xpath */
  v?: string;
  /** aria role for role locators */
  role?: string;
  /** accessible name for role locators */
  name?: string;
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
  | "title";

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
  /** expected element count for a "count" assertion */
  count?: number;
  /** viewport width when type === "viewport" */
  width?: number;
  /** viewport height when type === "viewport" */
  height?: number;
  /** wait duration in ms when type === "wait" (omit to wait for the locator instead) */
  waitMs?: number;
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
  count?: number;
  width?: number;
  height?: number;
  waitMs?: number;
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

export type TestSpeed = "slow" | "medium" | "fast";

/** Playwright browser engine a test run uses. The trainer always uses the
 *  app's own WebView and is unaffected by this. */
export type RunBrowser = "chromium" | "firefox" | "webkit";

export const RUN_BROWSERS: RunBrowser[] = ["chromium", "firefox", "webkit"];

export function isRunBrowser(v: unknown): v is RunBrowser {
  return typeof v === "string" && (RUN_BROWSERS as string[]).includes(v);
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
  /** playback speed for runs (adds a slowMo delay between actions); defaults to "fast" (no delay) */
  speed?: TestSpeed;
  /** absolute path to the folder a test was imported from, so its sibling
   *  modules (e.g. `./helpers.js`) can be re-copied into the scripts dir */
  sourceDir?: string;
  /** absolute path to the ROOT of the imported project, which bounds what that
   *  test's spec is allowed to pull in. Absent on tests imported before the
   *  import sandbox existed — see `repairImports` for what that costs them. */
  sourceRoot?: string;
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
  /** Free-form labels used to group tests (e.g. "smoke", "checkout").
   *  Normalized by `normalizeTags` on write — the backend is the single source
   *  of truth, so the renderer sends raw strings and renders what comes back.
   *  Absent/empty means untagged. */
  tags?: string[];
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
  "wait", "viewport", "if", "endif", "cookie", "capture", "runFlow",
];

export const ASSERT_KINDS: AssertKind[] = [
  "visible", "hidden", "text", "exactText", "enabled", "disabled", "checked",
  "unchecked", "value", "attribute", "count", "url", "urlEndsWith", "urlIs", "title",
];

export const CONDITION_KINDS: ConditionKind[] = [
  "visible", "hidden", "exists", "enabled", "disabled", "checked", "unchecked",
  "urlContains", "titleContains",
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

function normalizeLocator(input: unknown): Locator | undefined {
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
  return out;
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

function normalizeFlowArgs(input: unknown): Record<string, string> | undefined {
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
  if (assert) out.assert = assert;
  if (cond) out.cond = cond;
  if (bool(s.soft)) out.soft = true;

  // The fields that reach the generator as bare numerals.
  const count = int(s.count, 0, 1_000_000);
  const width = int(s.width, 1, 100_000);
  const height = int(s.height, 1, 100_000);
  const waitMs = int(s.waitMs, 0, 3_600_000);
  if (count !== undefined) out.count = count;
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  if (waitMs !== undefined) out.waitMs = waitMs;

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
  return {
    tag: str(p.tag) ?? "",
    description: str(p.description) ?? "",
    candidates,
    css: strMap(p.css),
    attributes: strMap(p.attributes),
  };
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

/** Bounds for `TestRecord.tags`. Generous enough to never bite in practice,
 *  tight enough that a paste accident can't write a megabyte into tests.json. */
export const MAX_TAG_LENGTH = 32;
export const MAX_TAGS_PER_TEST = 20;

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
  /** id of the batch this run belonged to, when it was part of one. Absent for
   *  ordinary single runs — which is most of them. */
  batchId?: string;
  /** How many steps run-time Auto-Heal got past by substituting a locator.
   *  Non-zero makes a run "passed (healed)" rather than plainly passed —
   *  a distinction worth keeping, because a run that only passed because
   *  something was silently substituted is not the same evidence as one that
   *  passed outright. */
  healedSteps?: number;
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
  /** Distinguishes a real test "run" (default) from a "baseline-update" event
   *  logged when the user accepts screenshots as new baselines. Baseline-update
   *  records are excluded from the pass/fail charts but shown in the history
   *  table so baseline changes are auditable from Stats. */
  kind?: RunRecordKind;
  /** Human-readable summary for non-run events (e.g. baseline-update notes). */
  note?: string;
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
}

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
  /** POST a summary to a user-configured webhook when a run or batch has a
   *  problem (default false). The only thing in the app that sends data off the
   *  machine — inert until a URL is configured, and never includes run logs. */
  alertWebhookEnabled: boolean;
  /** User-chosen run order for the Batch view, as test ids. Tests missing from
   *  this list (newly added) run after it, in library order; ids for deleted
   *  tests are ignored. Empty = plain library order. */
  batchOrder: string[];
  /** how many runs' screenshot artifacts to keep per test before the oldest
   *  are pruned (default 10, clamped 1–50). The pinned visual baseline is
   *  never pruned regardless of this number. */
  artifactRetainedRuns: number;
  /** post a macOS notification when a run finishes with a failure or a visual
   *  change (default false). Local only — nothing leaves the machine. */
  notifyOnRunIssues: boolean;
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
  url: string | null;
  name: string | null;
  /** true when continuing/extending an existing test rather than recording a new one */
  editing: boolean;
  /** true when the pending assertion is soft (expect.soft) */
  assertSoft: boolean;
  /** index new steps are inserted at (defaults to the end of the list) */
  cursor: number;
  /** true while the "Refine Selector" element picker is active */
  refineMode: boolean;
  /** true once the trainer browser window has finished loading its first page */
  pageReady: boolean;
  /** true while the training browser window is opening but hasn't shown yet.
   *  The renderer shows a loading modal with copy explaining the load; if this
   *  stays true past the timeout, the session is cancelled and an error shown. */
  loading: boolean;
  /** set when the training window failed to open within the timeout; the
   *  renderer shows an error dialog prompting the user to try again. */
  loadFailed: boolean;
}

// ── Batch (suite) runs ────────────────────────────────────────────────
// A batch drives ordinary runs sequentially. Each test still writes its own
// RunRecord (joined back by `RunRecord.batchId`), so a batch is a grouping over
// runs rather than a separate kind of history. Mirror kept in
// renderer/lib/recorder-types.ts.

export type BatchTestStatus = "pending" | "running" | "passed" | "failed" | "skipped";

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
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  /** index in `results` currently executing, or -1 when idle */
  currentIndex: number;
  results: BatchTestResult[];
  /** the user stopped the batch partway */
  stopped: boolean;
}

/** A batch as persisted to batch-history.json. Same shape as the live state
 *  plus its computed summary, so a restored batch renders identically to a
 *  live one. `running: true` on a loaded record means the app exited mid-batch. */
export interface BatchRecord extends BatchState {
  summary: BatchSummary;
}

// ── Cookies ───────────────────────────────────────────────────────────
// Mirror kept in renderer/lib/recorder-types.ts.

export type CookieAction = "set" | "delete" | "clearAll";

/** Glaze/Chromium sameSite spelling (see @glaze/core/backend CookieSameSite).
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
