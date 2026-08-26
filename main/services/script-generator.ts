// Convert recorded steps into a @playwright/test spec file.

import { GLAZE_RUNTIME_FILE } from "../../shared/glaze-runtime-source.mjs";
import {
  ASSERT_SEMANTICS,
  COMPARE_OP_LABEL,
  COMPARE_OPS,
  NUMERIC_COMPARE_OPS,
  regexPatternExpr,
  textMatchExpr,
  urlPathExpr,
  WAIT_SEMANTICS,
} from "../../shared/step-semantics.mjs";
import { testIdOverride, testIdSelector } from "../../shared/testid-attr.mjs";
import { frameSelector } from "../../shared/frame-ref.mjs";
import { credentialOrigin } from "../../shared/basic-auth.mjs";
import {
  cookieScopeIsValid,
  ELEMENT_STATES,
  isA11yImpact,
  isApiMethod,
  isCssPropName,
  isGenSpec,
  isSafeUploadRelPath,
  isValidCapturePath,
  isValidHeaderName,
  isValidVariableName,
  MAX_FLOW_REPEAT,
  MAX_LOOP_COUNT,
  MAX_TYPE_DELAY_MS,
  mapInterpolatable,
  toPlaywrightSameSite,
  VAR_REF_RE,
} from "../recorder/types.js";
import type { CompareOp, MatchSemantics } from "../../shared/step-semantics.mjs";
import type {
  CookieSpec,
  Locator,
  Step,
  TestRecord,
  TestVariable,
} from "../recorder/types.js";

function q(s: string): string {
  return JSON.stringify(s ?? "");
}

/**
 * Render a numeric field as a bare JS numeral.
 *
 * Every string this generator emits goes through `q`, which escapes it. The
 * numeric fields have no such step — they are concatenated straight into source
 * text — so their TYPE was doing the escaping, and a type is erased at runtime.
 * A step carrying `count: "0); <arbitrary node code>; ("` produced a spec that
 * ran that code, and specs run in Node with the user's privileges.
 *
 * Steps are normalized at the capture boundary now, but this is not belt and
 * braces: tests recorded BEFORE that fix are already on disk, and they are
 * regenerated from their stored steps. This is the check that covers them, and
 * the one that holds if a future writer into the step list forgets.
 */
function num(v: unknown, fallback: number): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return String(fallback);
  // Integers only: `1e21` and `0.30000000000000004` are valid JS but neither is
  // a viewport or an element count anyone recorded.
  return String(Math.trunc(v));
}

/** The largest per-step timeout worth emitting, matching the cap
 *  `normalizeRawStep` applies to `timeoutMs`. An hour is already longer than
 *  any run this app will finish. */
const MAX_STEP_TIMEOUT_MS = 3_600_000;

/**
 * A millisecond option, re-clamped at emission, or null when the step does not
 * carry one.
 *
 * Re-clamped HERE and not merely at the capture boundary for `num()`'s own
 * reason: `recorder:updateStep` copies its allowlisted fields without
 * re-normalizing, and every test on disk is regenerated from its stored steps,
 * so a value the boundary never saw can still reach this line. A negative is
 * dropped rather than clamped to zero — `timeout: 0` means "wait forever" to
 * Playwright, which is the opposite of what a negative was trying to say.
 */
function clampedMs(v: unknown, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  if (n < 0) return null;
  return Math.min(n, max);
}

/**
 * The trailing options object an action or assertion emits.
 *
 * FIXED KEY ORDER — `force`, then `delay`, then `timeout` — for two reasons.
 * The parser reads the object back key by key, and an order that varied with
 * which fields a step happened to carry would make the same step regenerate
 * differently from one save to the next.
 *
 * Empty string when there is nothing to say, and every caller omits the
 * argument entirely in that case, so a step carrying none of these options
 * emits exactly the call it emitted before they existed — which is what keeps
 * the whole library regenerating byte-identically.
 */
function optsExpr(parts: string[]): string {
  return parts.length > 0 ? "{ " + parts.join(", ") + " }" : "";
}

/** `["timeout: 5000"]`, or `[]` when the step sets no timeout. */
function timeoutParts(step: Step): string[] {
  const ms = clampedMs(step.timeoutMs, MAX_STEP_TIMEOUT_MS);
  return ms === null ? [] : ["timeout: " + String(ms)];
}

/** Render a call's argument list, dropping empties and appending the options
 *  object only when it has something in it. */
function callArgs(args: string[], opts: string): string {
  const all = [...args.filter((a) => a !== ""), ...(opts !== "" ? [opts] : [])];
  return "(" + all.join(", ") + ")";
}

/** Env var a secret variable's value arrives in. The name is already a valid
 *  JS identifier (enforced by `isValidVariableName`), so it needs no escaping,
 *  and it is used verbatim rather than upper-cased — folding case would let
 *  `pass` and `PASS` collide into one another's values. */
export function secretEnvName(varName: string): string {
  return `GLAZE_SECRET_${varName}`;
}

/** Escape a literal chunk for embedding inside a template literal. All three
 *  replacements are load-bearing: an unescaped backtick ends the literal early,
 *  an unescaped `${` starts an interpolation, and a lone backslash would eat
 *  whichever character follows it. */
function escTemplate(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/**
 * Render a recorded value as a JS expression.
 *
 * With no `${var}` reference to a DECLARED variable it stays a quoted literal,
 * so specs for tests without variables are byte-identical to what this
 * generator produced before variables existed. A reference to a name the test
 * doesn't declare is deliberately left as literal text — a user typing a price
 * of `${9.99}` or pasting a shell snippet must not have it silently turned into
 * an undefined-variable lookup that renders "undefined" at run time.
 */
function valueExpr(raw: string | undefined, vars: ReadonlySet<string>): string {
  const text = raw ?? "";
  if (vars.size === 0 || !text.includes("${")) return q(text);
  const matches = [...text.matchAll(VAR_REF_RE)].filter((m) => vars.has(m[1]));
  if (matches.length === 0) return q(text);
  // A value that is nothing but one reference emits as a plain lookup rather
  // than a one-element template literal — `V.email` reads better than
  // `` `${V.email}` `` in a spec the user is expected to open and read.
  if (matches.length === 1 && matches[0][0] === text) return "V." + matches[0][1];
  let out = "`";
  let last = 0;
  for (const m of matches) {
    const at = m.index ?? 0;
    out += escTemplate(text.slice(last, at));
    out += "${V." + m[1] + "}";
    last = at + m[0].length;
  }
  return out + escTemplate(text.slice(last)) + "`";
}

/**
 * The root a locator resolves against: `page`, or `page.frameLocator(…)` per
 * hop when the locator carries a frame path. Playwright's engines pierce open
 * frames only through `frameLocator`, so this prefix is the whole of iframe
 * support on the generation side — `locatorExpr` is unchanged, and a locator
 * with no `frame` yields exactly `"page"`, so every existing test regenerates
 * byte-identically.
 *
 * Each selector goes through `q()` like every other generated string: a frame
 * ref is a step field the moment the trainer can produce one, so the generator
 * is safe before that day rather than after it.
 */
function root(loc: Locator | null | undefined): string {
  const path = loc?.frame ?? [];
  return path.reduce((acc, f) => acc + ".frameLocator(" + q(frameSelector(f)) + ")", "page");
}

function locatorBase(loc: Locator): string {
  switch (loc.k) {
    case "testid": {
      // `getByTestId` resolves only data-testid (nothing configures
      // Playwright's testIdAttribute), so a locator recorded off another
      // test-id attribute spells it out. Allowlisted here as well as in
      // `normalizeLocator`: steps recorded before that boundary learned
      // `attr` are regenerated from their stored JSON, so the stored field
      // cannot be trusted for having the right TypeScript type — an unknown
      // attribute falls back to the default emission rather than reaching the
      // selector.
      const attr = testIdOverride(loc.attr);
      return attr
        ? "locator(" + q(testIdSelector(attr, loc.v ?? "")) + ")"
        : "getByTestId(" + q(loc.v ?? "") + ")";
    }
    case "role":
      return loc.name
        ? "getByRole(" + q(loc.role ?? "") + ", { name: " + q(loc.name) + " })"
        : "getByRole(" + q(loc.role ?? "") + ")";
    case "label":
      return "getByLabel(" + q(loc.v ?? "") + ")";
    case "placeholder":
      return "getByPlaceholder(" + q(loc.v ?? "") + ")";
    case "text":
      // `exact === true` and nothing looser: the flag crosses the capture
      // boundary, and a truthy string reaching here would emit an option the
      // trainer never graded. Mirrored in describe-step.ts and formatLocator.
      return loc.exact === true
        ? "getByText(" + q(loc.v ?? "") + ", { exact: true })"
        : "getByText(" + q(loc.v ?? "") + ")";
    case "xpath":
      return "locator(" + q("xpath=" + (loc.v ?? "")) + ")";
    case "css":
    default:
      return "locator(" + q(loc.v ?? "") + ")";
  }
}

/**
 * The locator expression, with its disambiguator if it has one.
 *
 * `.nth(k)` is appended for a locator the recorder could not make unique. It is
 * the difference between a step that RUNS and a strict-mode violation:
 * Playwright refuses a locator matching two elements rather than taking the
 * first, so an ambiguous locator does not degrade, it fails.
 *
 * The `nth` value is already bounded by `normalizeLocator`; `num` here is the
 * second of the two independent guards `check:step-ingest` pins, and it is the
 * one that covers steps recorded before the boundary existed.
 *
 * Also where a locator's user-pinned CONTEXT becomes source — see the chain
 * built below, and `check:locator-roundtrip`, which holds the property that
 * makes emitting one safe: everything written here can be read back.
 *
 * Mirrored in the renderer by `locatorExpr` in describe-step.ts, which both
 * the step list and `locatorToPrompt` (the AI-debug prompts' promise of this
 * exact expression) render through. Pinned twice: `describe-mirror.test.ts`
 * diffs the mirror against this function, and
 * __tests__/locator-prompt-parity.test.ts pins the prompt rendering against
 * `generateSpec`'s emitted line — a clause added here needs a case in each.
 */
export function locatorExpr(loc: Locator): string {
  let base = locatorBase(loc);

  // ── The user's pinned context ────────────────────────────────────────────
  //
  // Emitted as a chain, in the order Playwright evaluates it, which is also the
  // order `ctxFilter` narrows in. Each clause is the exact counterpart of one
  // there — that correspondence is what `e2e/context-parity.spec.ts` exists to
  // hold, because the trainer resolves context with `ctxFilter` and the RUN
  // resolves it with this source, and the two disagreeing is a step that is
  // green live and wrong in CI.
  //
  //   within        page.getByTestId("billing").getByRole("button", …)
  //   withinHasText …filter({ hasText: "Billing" })… on the CONTAINER
  //   and           …and(page.locator("[data-qa='x']")) on the TARGET
  //
  // `locatorBase` returns an unprefixed builder call and every call site
  // supplies `page.`, so a container chains by simple concatenation — but an
  // `and` predicate is a locator ARGUMENT rather than a continuation, so it
  // needs the `page.` prefix of its own.
  const ctx = loc.ctx;
  if (ctx?.within) {
    let scope = locatorBase(ctx.within);
    if (ctx.withinHasText !== undefined) {
      scope += ".filter({ hasText: " + q(ctx.withinHasText) + " })";
    }
    base = scope + "." + base;
  }
  if (ctx?.and) {
    // The predicate is a locator ARGUMENT, and Playwright resolves it in the
    // SAME frame as the base — so it takes the outer locator's frame root, not
    // a bare `page.`. `locatorExpr` receives the whole (framed) target, so
    // `root(loc)` here is that frame path.
    const predRoot = root(loc);
    for (const pred of ctx.and) base += ".and(" + predRoot + "." + locatorBase(pred) + ")";
  }

  // `.nth(k)` LAST, and that is a correctness requirement rather than a style
  // one: it indexes whatever set precedes it. Emitted before the context
  // clauses it would index the unnarrowed set, so an indexed step with a
  // container would silently mean a different element than the trainer showed.
  //
  // 0 is a real index and must survive: `.nth(0)` on a two-match locator is the
  // whole fix for that step, so a falsy test here would put the strict-mode
  // violation straight back for exactly the first element.
  //
  // `num`, not interpolation, and that is the same rule the rest of this file
  // follows for every numeric field — this lands in the source as a bare
  // numeral, which is precisely the hole a `count` of `"0); …; ("` went through
  // once.
  // -1 is Playwright's "last match" and the one negative the model admits
  // (`normalizeLocator` bounds it). The generator guards independently of the
  // boundary — the ternary is what stands between a forged deeper negative
  // (reachable through `updateStep`'s raw copy, which never re-normalizes) and
  // a `.nth(-7)` Playwright would refuse at run time; anything below -1 falls
  // back to 0, exactly as a non-numeric always has.
  return typeof loc.nth === "number"
    ? base + ".nth(" + num(loc.nth >= -1 ? loc.nth : 0, 0) + ")"
    : base;
}

function assertLine(step: Step, target: string | null, vars: ReadonlySet<string>): string | null {
  const e = step.soft ? "expect.soft" : "expect";
  // Every web-first matcher takes the same trailing `{ timeout }`, so the step's
  // own timeout is built once and threaded through `callArgs` below rather than
  // spelled at each of the fifteen call sites. Absent — the overwhelming case —
  // it is the empty string and every matcher emits exactly what it always did.
  const o = optsExpr(timeoutParts(step));
  // Page-level assertions don't need an element locator.
  //
  // All four embed their expected value INSIDE a pattern, so none of them can
  // use `valueExpr`: a value interpolated raw would reach the RegExp
  // unescaped, and a variable holding `a.b` would match `aXb` too. They go
  // through `regexPatternExpr` instead, which reEscapes the static text here
  // and emits `glazeReEscape(V.name)` for the parts only the run knows.
  if (step.assert === "url" || step.assert === "urlEndsWith" || step.assert === "urlIs") {
    const semantics = ASSERT_SEMANTICS[step.assert];
    if (!semantics) return null;
    // An empty expectation is not an assertion. `urlEndsWith` with no value
    // emits `/$/i`, which matches every URL on every host — green forever,
    // testing nothing, and the most expensive kind of wrong because nobody
    // looks at it again. `shared/url-assert.mjs` already refuses to SUGGEST a
    // value it cannot stand behind; this refuses to GENERATE one.
    if ((step.value ?? "") === "") return null;
    return "await " + e + "(page).toHaveURL" + callArgs([textMatchExpr(step.value ?? "", semantics, vars)], o) + ";";
  }
  if (step.assert === "urlPathIs") {
    // Same empty-value refusal as above: with no path, `urlPathPattern` builds
    // the site-root pattern, which asserts something the user never typed.
    if ((step.value ?? "") === "") return null;
    return "await " + e + "(page).toHaveURL" + callArgs([urlPathExpr(step.value ?? "", vars)], o) + ";";
  }
  if (step.assert === "title" || step.assert === "titleContains") {
    const semantics = ASSERT_SEMANTICS[step.assert];
    if (!semantics) return null;
    if ((step.value ?? "") === "") return null;
    // `title` is exact and case-sensitive, so it emits the plain string form —
    // which is what `toHaveTitle` means by a string, and reads better in a spec
    // than an anchored pattern. It also keeps `${var}` working for the one
    // title kind whose semantics do not need a pattern.
    if (step.assert === "title")
      return "await " + e + "(page).toHaveTitle" + callArgs([valueExpr(step.value, vars)], o) + ";";
    return "await " + e + "(page).toHaveTitle" + callArgs([textMatchExpr(step.value ?? "", semantics, vars)], o) + ";";
  }
  // Before the target check, deliberately: this is the one assert kind that
  // looks at nothing on the page, so requiring a locator would refuse every
  // one of them.
  if (step.assert === "variable") return variableAssertLine(step, vars);
  if (!target) return null;
  const x = e + "(" + target + ")";
  switch (step.assert) {
    case "hidden":
      return "await " + x + ".toBeHidden" + callArgs([], o) + ";";
    case "text":
      return "await " + x + ".toContainText" + callArgs([valueExpr(step.text, vars)], o) + ";";
    case "exactText":
      return "await " + x + ".toHaveText" + callArgs([valueExpr(step.text, vars)], o) + ";";
    case "enabled":
      return "await " + x + ".toBeEnabled" + callArgs([], o) + ";";
    case "disabled":
      return "await " + x + ".toBeDisabled" + callArgs([], o) + ";";
    case "checked":
      return "await " + x + ".toBeChecked" + callArgs([], o) + ";";
    case "unchecked":
      return "await " + x + ".not.toBeChecked" + callArgs([], o) + ";";
    case "value":
      return "await " + x + ".toHaveValue" + callArgs([valueExpr(step.value, vars)], o) + ";";
    case "attribute":
      return "await " + x + ".toHaveAttribute" + callArgs([q(step.attr ?? ""), valueExpr(step.value, vars)], o) + ";";
    case "count":
      return "await " + x + ".toHaveCount" + callArgs([num(step.count, 0)], o) + ";";
    case "css": {
      // `cssProp` is re-checked HERE and not merely at the capture boundary:
      // `recorder:updateStep` copies its allowlisted fields without
      // re-normalizing, and tests recorded before the boundary check existed
      // are regenerated from their stored steps. Same argument as `num()`.
      const prop = isCssPropName(step.cssProp) ? step.cssProp : "";
      if (!prop) return null;
      // `contains` embeds the expected value in a pattern, so it goes through
      // `regexPatternExpr` rather than `valueExpr`: a reference has to be
      // regex-escaped at RUN time, which is what glazeReEscape is for.
      const expected =
        step.cssMatch === "contains"
          ? "new RegExp(" + regexPatternExpr(step.value ?? "", vars) + ", \"i\")"
          : valueExpr(step.value, vars);
      return "await " + x + ".toHaveCSS" + callArgs([q(prop), expected], o) + ";";
    }
    case "visible":
    default:
      return "await " + x + ".toBeVisible" + callArgs([], o) + ";";
  }
}

/** The `capture` step: read a value off the page into the run's variable scope.
 *
 *  Emitted as a call to the `glazeCapture` runtime helper rather than the
 *  obvious `V.name = await ...`, because the line must START with `await`.
 *  `buildStepLineMap` in playwright-runner classifies spec lines by that
 *  prefix, and a step whose line doesn't match is invisible to it — which
 *  would shift every later step's highlight and screenshot attribution. */
function captureLine(step: Step, target: string | null): string | null {
  if (!step.captureVar) return null;
  const from = step.captureFrom ?? "text";
  // url/title read the page itself and need no element.
  const subject = from === "url" || from === "title" ? "page" : target;
  if (!subject) return null;
  const args = ["V", q(step.captureVar), subject, q(from)];
  if (from === "attribute") args.push(q(step.captureAttr ?? ""));
  return "await glazeCapture(" + args.join(", ") + ");";
}

/**
 * The `state` step: put an element into a pseudo-state so the assertion after
 * it measures the styled state rather than the resting one.
 *
 * Real input, not a forced pseudo-class. Chromium's CDP could force `:hover`
 * with `CSS.forcePseudoState`, but runs here execute on Chromium, Firefox AND
 * WebKit, and `locator.hover()` moves a real virtual mouse on all three.
 *
 * `press`/`release` carry no locator on purpose: `page.mouse.down()` acts
 * wherever the cursor already is, which is where the preceding `hover` put it.
 * Emitting a locator-bearing call would be a second, redundant way to say the
 * same thing, and it would disagree with the preceding hover the moment
 * somebody edited one of the two.
 *
 * `elementState` is re-checked here for the same reason `cssProp` is — see the
 * `css` case in `assertLine`.
 */
function stateLine(step: Step, target: string | null): string | null {
  const state = step.elementState;
  if (!state || !ELEMENT_STATES.includes(state)) return null;
  switch (state) {
    case "press":
      return "await page.mouse.down();";
    case "release":
      return "await page.mouse.up();";
    case "focus":
      return target ? "await " + target + ".focus();" : null;
    case "hover":
    default:
      return target ? "await " + target + ".hover();" : null;
  }
}

/**
 * A `contains` test as a plain boolean expression, for the one place that
 * cannot use a Playwright matcher: an `if` step's condition compiles to a JS
 * `if (...)`, so there is no `expect` to carry the semantics.
 *
 * Written to keep the SAME case and whitespace rules as the matching assert, by
 * reading the same descriptor. Without this the generated `if` branched on a
 * case-SENSITIVE `page.url().includes(...)` while the assertion one step later
 * matched case-insensitively — the same page taking two different paths through
 * one spec, which is worse than either rule chosen consistently.
 *
 * The expected value keeps the case the user typed and is lowered at RUN time
 * rather than folded here. Folding reads better in the file, and it silently
 * rewrites the user's data: the spec is re-parsed on every hand edit and every
 * applied AI fix, so a folded `"/Checkout"` comes back as `"/checkout"` and the
 * step list now shows a value nobody entered. The extra `.toLowerCase()` also
 * says out loud, in the generated source, which rule this comparison follows.
 */
function containsExpr(subject: string, raw: string | undefined, semantics: MatchSemantics, vars: ReadonlySet<string>): string {
  let subj = subject;
  if (semantics.normalizeWhitespace) subj = subj + ".replace(/\\s+/g, \" \").trim()";
  const expr = valueExpr(raw, vars);
  if (semantics.caseSensitive) return subj + ".includes(" + expr + ")";
  // `String(...)` only where it earns its place: a captured variable can hold a
  // number, and `.toLowerCase()` on one throws mid-run. A quoted literal cannot.
  const lowered = expr.startsWith("\"") ? expr + ".toLowerCase()" : "String(" + expr + ").toLowerCase()";
  return subj + ".toLowerCase().includes(" + lowered + ")";
}

/**
 * The variable a `variable` assertion or condition reads, and how it compares.
 *
 * Re-validated HERE and not merely at the capture boundary, for `num()`'s
 * reason: `recorder:updateStep` copies its allowlisted fields raw, and every
 * test on disk is regenerated from its stored steps. `compareOp` SELECTS A
 * MATCHER, and the variable NAME lands in source as an identifier, so both are
 * checked again before either can reach a line.
 */
function variableSubject(step: Step): { name: string; op: CompareOp } | null {
  const name = step.captureVar;
  if (!isValidVariableName(name)) return null;
  const op = (COMPARE_OPS as string[]).includes(step.compareOp ?? "")
    ? (step.compareOp as CompareOp)
    : "eq";
  return { name, op };
}

/**
 * The assertion line for a `variable` assert.
 *
 * REAL MATCHERS ON THE SPEC LINE, not a boolean helper wrapped in
 * `expect(...).toBe(true)`. Two reasons, and both are about what the user sees
 * when it fails. Playwright reports an `expect` step located at the spec line —
 * verified, including for these generic matchers — so the run highlights the
 * step that failed; and `toBe`/`toContain`/`toMatch` print the actual and
 * expected values, where a wrapped boolean prints "expected false to be true"
 * and the user has to open the spec to find out what was compared.
 *
 * `expect(value, message)` gives the step its TITLE, so the variable's name
 * appears in the run log rather than an anonymous assertion.
 *
 * The semantics are RAW because that is what these matchers do — see the
 * CompareOp block in shared/step-semantics.mjs for why this table does not
 * borrow the kinder rules the page-facing kinds use.
 */
function variableAssertLine(step: Step, vars: ReadonlySet<string>): string | null {
  const subject = variableSubject(step);
  if (!subject) return null;
  const { name, op } = subject;
  const e = step.soft ? "expect.soft" : "expect";
  const expected = valueExpr(step.value, vars);
  const opts = optsExpr(timeoutParts(step));
  // The message is the variable's own name: it is what the run log shows, and
  // `q()` because a name reaching source unquoted is the shape of the original
  // injection bug even when the grammar says it cannot contain a quote.
  const subj = (isNumeric: boolean): string =>
    e + "(" + (isNumeric ? "Number(V." + name + ")" : "V." + name) + ", " + q(name) + ")";

  if ((NUMERIC_COMPARE_OPS as string[]).includes(op)) {
    const matcher =
      op === "gt"
        ? "toBeGreaterThan"
        : op === "lt"
          ? "toBeLessThan"
          : op === "gte"
            ? "toBeGreaterThanOrEqual"
            : "toBeLessThanOrEqual";
    // `Number(...)` on BOTH sides, and a non-numeric one becomes NaN — which
    // every one of these matchers reports as a failure naming the value.
    // Silence would be the worst outcome: `"abc" > 3` quietly false reads
    // exactly like a real comparison that did not hold.
    return "await " + subj(true) + "." + matcher + callArgs(["Number(" + expected + ")"], opts) + ";";
  }

  switch (op) {
    case "eq":
      return "await " + subj(false) + ".toBe" + callArgs([expected], opts) + ";";
    case "neq":
      return "await " + subj(false) + ".not.toBe" + callArgs([expected], opts) + ";";
    case "contains":
      return "await " + subj(false) + ".toContain" + callArgs([expected], opts) + ";";
    case "notContains":
      return "await " + subj(false) + ".not.toContain" + callArgs([expected], opts) + ";";
    case "matches":
      // The user's own pattern, quoted as a STRING argument to `new RegExp` —
      // never concatenated into a literal, where a `/` would end it early and
      // the rest would be parsed as code.
      return "await " + subj(false) + ".toMatch" + callArgs(["new RegExp(" + expected + ")"], opts) + ";";
    default: {
      // starts/ends with, and their negations. Playwright has no matcher for
      // either, so they compile to an ANCHORED pattern over the reEscaped
      // value — the same shape `textMatchExpr` uses, and the reason the value
      // has to be escaped rather than interpolated.
      const anchored = regexPatternExpr(
        step.value ?? "",
        vars,
        op === "startsWith" || op === "notStartsWith" ? "^" : "",
        op === "endsWith" || op === "notEndsWith" ? "$" : "",
      );
      const negated = op === "notStartsWith" || op === "notEndsWith";
      return (
        "await " +
        subj(false) +
        (negated ? ".not" : "") +
        ".toMatch" +
        callArgs(["new RegExp(" + anchored + ")"], opts) +
        ";"
      );
    }
  }
}

/** Build the boolean expression for an `if` step's condition. */
function conditionExpr(step: Step, vars: ReadonlySet<string> = EMPTY_VARS): string {
  const loc = step.locator;
  const target = loc ? root(loc) + "." + locatorExpr(loc) : "page.locator(\"html\")";
  switch (step.cond) {
    case "variable": {
      // A helper rather than an inline comparison, because thirteen operators
      // inlined here would be a second spelling of `compareValues` — and the
      // condition and the assertion disagreeing about what "starts with" means
      // is precisely the class of bug shared/step-semantics.mjs exists to end.
      // Unlike the assertion, this is not a reported step: an `if` line is
      // control flow, and the generator has never emitted it as an await.
      const subject = variableSubject(step);
      if (!subject) return "false";
      return (
        "glazeCompare(V." + subject.name + ", " + q(subject.op) + ", " + valueExpr(step.value, vars) + ")"
      );
    }
    case "urlContains":
      return containsExpr("page.url()", step.value, WAIT_SEMANTICS.urlContains as MatchSemantics, vars);
    case "titleContains":
      return containsExpr("(await page.title())", step.value, WAIT_SEMANTICS.titleContains as MatchSemantics, vars);
    case "hidden":
      return "await " + target + ".isHidden()";
    case "exists":
      return "(await " + target + ".count()) > 0";
    case "enabled":
      return "await " + target + ".isEnabled()";
    case "disabled":
      return "await " + target + ".isDisabled()";
    case "checked":
      return "await " + target + ".isChecked()";
    case "unchecked":
      return "!(await " + target + ".isChecked())";
    case "visible":
    default:
      return "await " + target + ".isVisible()";
  }
}

/** Marker appended to the `expect`-based conditional waits below.
 *
 *  Load-bearing, not decoration. Playwright's only auto-retrying primitive for
 *  most predicates IS `expect`, so a "wait until enabled" and an "assert
 *  enabled" compile to the same call. `spec-parser.ts` reads a generated spec
 *  back into steps on every `tests:updateScript` (a hand edit, or an applied AI
 *  fix), and without something to tell the two apart every conditional wait
 *  would come back as an assertion — the step's TYPE changing under the user
 *  with nothing on screen to say so. The parser keys off this exact string;
 *  changing one side alone silently breaks the round trip, which is why
 *  `spec-parser.check.ts` pins both. A hand-written `expect` has no marker and
 *  correctly stays an assertion. */
export const WAIT_UNTIL_MARKER = " // wait until";

/** Default timeout for a conditional wait, in ms. Deliberately longer than
 *  Playwright's 5s expect default — a user reaching for an explicit wait is
 *  usually waiting on something slower than the default already covers. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

/**
 * Emit the line for a `wait` step.
 *
 * Three shapes, in precedence order: a `waitUntil` predicate, a `waitMs`
 * duration, then a bare locator wait. The last two are byte-identical to what
 * this generator emitted before conditional waits existed, so every test
 * already on disk regenerates unchanged.
 *
 * `waitUntil` is matched against known kinds and mapped to a fixed string —
 * never concatenated. `recorder:updateStep` copies its allowlisted fields
 * without re-normalizing, so an unrecognized value can reach here; it falls
 * through to the duration/locator behaviour rather than into the source text.
 */
function waitLine(step: Step, target: string | null, vars: ReadonlySet<string>): string | null {
  const t = ", timeout: " + num(step.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
  const opts = "{ timeout: " + num(step.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS) + " }";

  switch (step.waitUntil) {
    // These three have a native, unambiguous waiting API, so they need no
    // marker — `.waitFor()` is never an assertion.
    case "visible":
      return target ? "await " + target + ".waitFor({ state: \"visible\"" + t + " });" : null;
    case "hidden":
      return target ? "await " + target + ".waitFor({ state: \"hidden\"" + t + " });" : null;
    case "exists":
      return target ? "await " + target + ".waitFor({ state: \"attached\"" + t + " });" : null;

    // Page-level predicates. Both embed the expected text in a RegExp, so both
    // carry variables the same way `assertLine`'s URL kinds do — escaped at
    // run time through glazeReEscape rather than interpolated raw.
    //
    // These go through the SAME `textMatchExpr` as their assert counterparts,
    // reading the same table. "Wait until the URL contains X" and "assert the
    // URL contains X" disagreeing about case would be this file's own bug one
    // level down — and they did disagree: the wait emitted no `i` flag while
    // every URL assert emitted one.
    case "urlContains": {
      const s = WAIT_SEMANTICS.urlContains;
      if (!s || (step.value ?? "") === "") break;
      return (
        "await expect(page).toHaveURL(" + textMatchExpr(step.value ?? "", s, vars) + ", " + opts + ");" +
        WAIT_UNTIL_MARKER
      );
    }
    case "titleContains": {
      const s = WAIT_SEMANTICS.titleContains;
      if (!s || (step.value ?? "") === "") break;
      return (
        "await expect(page).toHaveTitle(" + textMatchExpr(step.value ?? "", s, vars) + ", " + opts + ");" +
        WAIT_UNTIL_MARKER
      );
    }

    default:
      break;
  }

  // The remaining predicates are element-scoped and all go through `expect`.
  if (step.waitUntil && target) {
    const x = "expect(" + target + ")";
    switch (step.waitUntil) {
      case "enabled":
        return "await " + x + ".toBeEnabled(" + opts + ");" + WAIT_UNTIL_MARKER;
      case "disabled":
        return "await " + x + ".toBeDisabled(" + opts + ");" + WAIT_UNTIL_MARKER;
      case "checked":
        return "await " + x + ".toBeChecked(" + opts + ");" + WAIT_UNTIL_MARKER;
      case "unchecked":
        return "await " + x + ".not.toBeChecked(" + opts + ");" + WAIT_UNTIL_MARKER;
      case "text":
        return (
          "await " + x + ".toContainText(" + valueExpr(step.text, vars) + ", " + opts + ");" +
          WAIT_UNTIL_MARKER
        );
      case "value":
        return (
          "await " + x + ".toHaveValue(" + valueExpr(step.value, vars) + ", " + opts + ");" +
          WAIT_UNTIL_MARKER
        );
      case "count":
        return (
          "await " + x + ".toHaveCount(" + num(step.count, 0) + ", " + opts + ");" +
          WAIT_UNTIL_MARKER
        );
      default:
        break;
    }
  }

  if (typeof step.waitMs === "number") return "await page.waitForTimeout(" + num(step.waitMs, 0) + ");";
  return target ? "await " + target + ".waitFor();" : null;
}

/** Emit the cookie object literal Playwright's addCookies expects.
 *
 *  Two renames matter and are easy to miss: Chromium's `expirationDate`
 *  (unix seconds) is Playwright's `expires`, and the sameSite vocabularies
 *  differ (see toPlaywrightSameSite). Playwright accepts `url` OR
 *  `domain`+`path`, never both, so domain+path wins when present. */
function cookieLiteral(spec: CookieSpec): string {
  const parts: string[] = [`name: ${q(spec.name)}`, `value: ${q(spec.value ?? "")}`];
  if (spec.domain && spec.path) {
    parts.push(`domain: ${q(spec.domain)}`, `path: ${q(spec.path)}`);
  } else if (spec.url) {
    parts.push(`url: ${q(spec.url)}`);
  }
  if (typeof spec.expirationDate === "number") parts.push(`expires: ${spec.expirationDate}`);
  if (spec.httpOnly) parts.push("httpOnly: true");
  if (spec.secure) parts.push("secure: true");
  const sameSite = toPlaywrightSameSite(spec.sameSite);
  if (sameSite) parts.push(`sameSite: ${q(sameSite)}`);
  return "{ " + parts.join(", ") + " }";
}

/** Filter for clearCookies — deleting ONE cookie rather than all of them.
 *  Playwright 1.43+ accepts {name, domain, path}; the bundled runner is 1.62. */
function cookieFilterLiteral(spec: CookieSpec): string {
  const parts: string[] = [`name: ${q(spec.name)}`];
  if (spec.domain) parts.push(`domain: ${q(spec.domain)}`);
  if (spec.path) parts.push(`path: ${q(spec.path)}`);
  return "{ " + parts.join(", ") + " }";
}

/** Shared "this test declares no variables" set, so the many call sites that
 *  legitimately have no variable context don't each allocate one. */
const EMPTY_VARS: ReadonlySet<string> = new Set<string>();

function cookieLine(step: Step): string | null {
  switch (step.cookieAction) {
    case "clearAll":
      return "await page.context().clearCookies();";
    case "delete":
      return step.cookie?.name
        ? "await page.context().clearCookies(" + cookieFilterLiteral(step.cookie) + ");"
        : null;
    case "set":
    default:
      // An addCookies call Playwright would reject at runtime is worse than no
      // line at all — the run would fail on setup rather than on the assertion
      // the test is actually about.
      return cookieScopeIsValid(step.cookie)
        ? "await page.context().addCookies([" + cookieLiteral(step.cookie!) + "]);"
        : null;
  }
}

/**
 * Why a step produced no line — the sentence that goes into the spec in its
 * place.
 *
 * A step that generated nothing used to VANISH: no code, no comment, no error,
 * no count. The step stayed in the trainer's list, previewed green, and had no
 * counterpart in the file the runner executed — so the run "passed" it by never
 * attempting it, which is the one failure mode worse than a red step. Every
 * `return null` in the line builders above is a way to reach that, and there
 * are eight of them.
 *
 * Best-effort and deliberately non-exhaustive: an unrecognised shape falls
 * through to a generic sentence rather than being asserted about, because the
 * value here is that SOMETHING appears in the spec, not that the diagnosis is
 * complete.
 */
/**
 * Render text as a `//` comment that cannot stop being one.
 *
 * A comment is a place people stop thinking about escaping, and that is exactly
 * what makes it a code sink here. `describeStep` interpolates step fields RAW —
 * it was UI copy until this file started emitting it — and a `//` comment ends
 * at the first LINE TERMINATOR, so anything after one lands in the spec as a
 * top-level statement inside the `test()` callback, which Playwright executes
 * in Node with the user's privileges. Same class of hole as the `count` field
 * that was RCE for being the right TypeScript type: page input → generated code
 * → executed.
 *
 * All FOUR terminators, not just `\n`. U+2028 and U+2029 end a comment exactly
 * as a newline does, and unlike `\n` they survive places that reject control
 * characters — a hostile page can put one in `document.cookie`, and the Cookies
 * panel pre-fills a step from that live read.
 *
 * Replaced with a space rather than stripped, so the message stays readable and
 * two words cannot silently fuse into a third.
 */
function commentSafe(text: string): string {
  return String(text ?? "").replace(/[\n\r\u2028\u2029]/g, " ");
}

function ungeneratableReason(step: Step): string {
  const needsLocator =
    step.type === "click" || step.type === "fill" || step.type === "select" ||
    step.type === "check" || step.type === "uncheck" ||
    step.type === "dblclick" || step.type === "rightclick" || step.type === "drag";
  if (needsLocator && !step.locator) return "this step needs an element and none was recorded";
  // Said separately from the rule above, because "needs an element" would send
  // the user looking at the SOURCE, which is the half that is fine.
  if (step.type === "drag" && !step.toLocator)
    return "this drag has nothing to drop onto — no target element was recorded";
  if (step.type === "assert") {
    const a = step.assert;
    if (a === "url" || a === "urlEndsWith" || a === "urlIs" || a === "urlPathIs" || a === "title" || a === "titleContains") {
      // The only way to reach here for a page-level assert. Said plainly,
      // because the alternative — generating it — is an assertion that either
      // matches every page or no page.
      return "the expected value is empty, which would assert nothing";
    }
    if (a === "css" && !isCssPropName(step.cssProp))
      return "the CSS property name is missing or not a valid kebab-case property";
    // Checked before the locator rule below: a variable assertion looks at
    // nothing on the page, so "needs an element" would be the wrong reason and
    // would send the user looking for a target that was never required.
    if (a === "variable")
      return isValidVariableName(step.captureVar)
        ? "this app could not turn it into a Playwright statement"
        : "no variable was chosen to compare, or its name is not a valid identifier";
    if (!step.locator) return "this assertion needs an element and none was recorded";
  }
  if (step.type === "capture" && !step.captureVar) return "no variable name was set to capture into";
  if (step.type === "cookie") return "the cookie is missing a name, or a domain/path to scope it to";
  if (step.type === "state") return "the element state is missing or not one this app can replay";
  if (step.type === "wait" && !step.locator) return "this wait needs an element and none was recorded";
  if (step.type === "scroll") return "this scroll step has neither an element nor a position";
  return "this app could not turn it into a Playwright statement";
}

function stepLine(step: Step, vars: ReadonlySet<string> = EMPTY_VARS): string | null {
  const loc = step.locator;
  const target = loc ? root(loc) + "." + locatorExpr(loc) : null;
  switch (step.type) {
    case "if":
      return "if (" + conditionExpr(step, vars) + ") {";
    case "endif":
      return "}";
    case "goto":
      return "await page.goto(" + valueExpr(step.url, vars) + ");";
    case "click": {
      // `force` skips Playwright's actionability checks — the per-step escape
      // for targets covered or animating BY DESIGN. `=== true`, not truthy: a
      // stored step predates the boundary knowing the field.
      if (!target) return null;
      const opts = optsExpr([
        ...(step.force === true ? ["force: true"] : []),
        ...timeoutParts(step),
      ]);
      return "await " + target + ".click(" + opts + ");";
    }
    case "fill": {
      if (!target) return null;
      const value = valueExpr(step.value, vars);
      // `sequential` is `pressSequentially`, emitted on the SPEC LINE rather
      // than routed through a runtime helper like the multi-statement steps
      // are. That is not a style choice: the step reporter drops any action
      // whose location is outside the spec file, so a fill delivered from
      // inside `glaze-runtime.mjs` would be reported by nothing on a plain run
      // and the progress bar would stall on the step before it. One locator
      // call on one line keeps it a real, highlightable step.
      //
      // It does NOT clear the field first — see TypeMode for why a clearing
      // variant would cost a second Playwright action, and what to do instead.
      if (step.typeMode === "sequential") {
        const delay = clampedMs(step.typeDelayMs, MAX_TYPE_DELAY_MS);
        const opts = optsExpr([
          ...(delay === null ? [] : ["delay: " + String(delay)]),
          ...timeoutParts(step),
        ]);
        return "await " + target + ".pressSequentially" + callArgs([value], opts) + ";";
      }
      return "await " + target + ".fill" + callArgs([value], optsExpr(timeoutParts(step))) + ";";
    }
    case "select":
      return target
        ? "await " + target + ".selectOption" +
            callArgs([valueExpr(step.value, vars)], optsExpr(timeoutParts(step))) + ";"
        : null;
    case "check":
      return target
        ? "await " + target + ".check(" + optsExpr(timeoutParts(step)) + ");"
        : null;
    case "uncheck":
      return target
        ? "await " + target + ".uncheck(" + optsExpr(timeoutParts(step)) + ");"
        : null;
    case "press":
      // A key name is a Playwright keyboard token ("Enter", "Control+A"), not
      // free text, so it stays a literal — interpolating a variable into it
      // would produce a silently-ignored key press rather than an error.
      //
      // `page.keyboard.press` takes no timeout: it types wherever focus already
      // is, so there is no element to wait for and Playwright's signature has
      // no such option. Only the locator form carries one.
      return target
        ? "await " + target + ".press" +
            callArgs([q(step.value ?? "")], optsExpr(timeoutParts(step))) + ";"
        : "await page.keyboard.press(" + q(step.value ?? "") + ");";
    case "echo":
      // One awaited helper line, like every other step whose natural spelling
      // does not start with `await`. It never fails and never asserts — the
      // point is a line in the run log next to the steps around it.
      return "await glazeEcho(" + valueExpr(step.text ?? step.value, vars) + ");";
    case "dblclick":
      return target ? "await " + target + ".dblclick(" + optsExpr(timeoutParts(step)) + ");" : null;
    case "rightclick": {
      // A click with a button, not a kind of its own to Playwright — so the
      // options object is never empty, and `button: "right"` is what the parser
      // reads back to tell it from an ordinary click.
      if (!target) return null;
      const opts = optsExpr([
        'button: "right"',
        ...(step.force === true ? ["force: true"] : []),
        ...timeoutParts(step),
      ]);
      return "await " + target + ".click(" + opts + ");";
    }
    case "drag": {
      // The only step that points at two elements. Both go through
      // `locatorExpr`, so both are quoted the same way — a second locator is a
      // second chance to interpolate one raw.
      if (!target || !step.toLocator) return null;
      const to = root(step.toLocator) + "." + locatorExpr(step.toLocator);
      return "await " + target + ".dragTo" + callArgs([to], optsExpr(timeoutParts(step))) + ";";
    }
    case "reload":
      // The one page-level action a recording produces that is not a `goto`.
      // Emitted with the same options object as the element actions so a slow
      // reload can be given room without a wait step in front of it.
      return "await page.reload(" + optsExpr(timeoutParts(step)) + ");";
    case "wait":
      return waitLine(step, target, vars);
    case "viewport":
      return (
        "await page.setViewportSize({ width: " +
        num(step.width, 1280) +
        ", height: " +
        num(step.height, 800) +
        " });"
      );
    case "cookie":
      return cookieLine(step);
    case "capture":
      return captureLine(step, target);
    case "state":
      return stateLine(step, target);
    case "upload": {
      // The staged path is interpolated only after the SHAPE guard — the
      // string lands in executed source, and a value like "uploads/../../x"
      // would hand setInputFiles an arbitrary file. Boundary length caps are
      // not enough here; the guard is independent on purpose (a forged value
      // can arrive through updateStep's raw copy).
      if (!target || !isSafeUploadRelPath(step.value)) return null;
      return "await " + target + ".setInputFiles(" + q(step.value) + ");";
    }
    case "api": {
      // ONE awaited helper line, fixed key order (the parser reads it back
      // key by key). Every vocabulary is re-checked here independently of
      // the boundary: the method from OUR allowlist, header names against
      // the token grammar, values refusing CR/LF, status through the int
      // guard, capture var/path through their grammars — a forged field
      // (updateStep copies raw) must not reach source, and q()/valueExpr
      // carry the strings that do.
      const method = isApiMethod(step.apiMethod) ? step.apiMethod : "GET";
      const parts: string[] = ['method: "' + method + '"'];
      parts.push("url: " + valueExpr(step.url ?? "", vars));
      const headers = Object.entries(step.apiHeaders ?? {}).filter(
        ([k, v]) => isValidHeaderName(k) && typeof v === "string" && !/[\r\n]/.test(v),
      );
      if (headers.length > 0) {
        parts.push(
          "headers: { " +
            headers.map(([k, v]) => q(k) + ": " + valueExpr(v, vars)).join(", ") +
            " }",
        );
      }
      if (typeof step.apiBody === "string" && step.apiBody !== "") {
        parts.push("body: " + valueExpr(step.apiBody, vars));
      }
      const status = num(
        typeof step.expectStatus === "number" && step.expectStatus >= 100 && step.expectStatus <= 599
          ? step.expectStatus
          : undefined,
        0,
      );
      if (status !== "0") parts.push("expectStatus: " + status);
      if (isValidVariableName(step.captureVar)) {
        parts.push("captureVar: " + q(step.captureVar));
        if (isValidCapturePath(step.capturePath)) {
          parts.push("capturePath: " + q(step.capturePath));
        }
      }
      return "await glazeApiRequest(page, V, { " + parts.join(", ") + " });";
    }
    case "emailCode": {
      // Every field re-checked at EMISSION, not merely at ingest. Tests
      // recorded before a boundary fix are already on disk and are
      // regenerated from their stored steps, so the generator needs its own
      // guard regardless (CLAUDE.md, the capture boundary).
      if (!isValidVariableName(step.captureVar)) return null;
      const parts: string[] = [
        "address: " + valueExpr(step.mailboxAddress ?? "", vars),
        "captureVar: " + q(step.captureVar),
      ];
      // A BARE NUMERAL goes through num(). A page that forged `codeDigits` as
      // a string would otherwise get it into executed source verbatim.
      if (typeof step.codeDigits === "number" && step.codeDigits >= 4 && step.codeDigits <= 10) {
        parts.push("digits: " + num(step.codeDigits, 6));
      }
      if (typeof step.codeLabel === "string" && step.codeLabel !== "") {
        parts.push("label: " + q(step.codeLabel));
      }
      return "await glazeEmailCode(page, V, { " + parts.join(", ") + " });";
    }
    case "scroll":
      // Element mode wins when both are present: `scrollIntoViewIfNeeded` is
      // native, self-correcting, and reports through the step reporter (a
      // locator call located in the spec). Position mode goes through the
      // glazeScrollTo runtime helper because reaching a recorded depth on a
      // lazily-rendered page takes incremental scrolling — a loop, which must
      // not be many spec lines for one step. `num`, never interpolation: these
      // arrive from the capture channel and land in source as bare numerals,
      // which is the exact hole the `count` field was RCE through.
      if (target) return "await " + target + ".scrollIntoViewIfNeeded();";
      if (typeof step.scrollX === "number" || typeof step.scrollY === "number")
        return (
          "await glazeScrollTo(page, " + num(step.scrollX, 0) + ", " + num(step.scrollY, 0) + ");"
        );
      return null;
    case "dialog": {
      // Action from OUR allowlist, never the field raw; the prompt text is a
      // free string through valueExpr (variables work). Dismiss carries no
      // second argument at all, so the two forms stay visually distinct.
      const action = step.dialogAction === "dismiss" ? "dismiss" : "accept";
      const textArg =
        action === "accept" && typeof step.value === "string" && step.value !== ""
          ? ", " + valueExpr(step.value, vars)
          : "";
      return 'await glazeArmDialog(page, "' + action + '"' + textArg + ");";
    }
    case "a11y": {
      // The impact interpolated into source comes from OUR allowlist, never
      // from the step field — same independent-guard rule as num()/q(). An
      // unknown value (possible only if the boundary is bypassed) falls back
      // to the default rather than reaching the spec.
      const impact = isA11yImpact(step.a11yImpact) ? step.a11yImpact : "serious";
      return 'await glazeA11yGate(page, "' + impact + '");';
    }
    // A runFlow step emits no line of its own — its target flow's steps are
    // inlined in its place by `expandSteps` before generation reaches here.
    case "runFlow":
      return null;
    case "assert":
      return assertLine(step, target, vars);
    default:
      return null;
  }
}

/**
 * An extra, non-step statement emitted directly after a step's own line.
 *
 * Only `viewport` uses it: a resize is the one recorded action with NO visible
 * effect in the run output. Every other step names its target in the log
 * ("click getByRole(...)"), but a viewport change is invisible until something
 * downstream fails at a width nobody can see from the log, which is precisely
 * when you need to know the page was resized and to what.
 *
 * Three constraints shape what may go here, and all three are why this is a
 * bare `console.log` rather than a runtime helper:
 *
 *  • It must NOT start with `await`. `buildStepLineMap` (the fallback used for
 *    hand-edited specs) classifies steps by counting leading-`await` lines, so
 *    an awaited log line would shift every later step's highlight by one.
 *  • It must NOT be a Playwright API call. `StepReporter` drops any `pw:api`
 *    step whose `location.file` isn't the spec, so routing the resize through
 *    an imported helper would silently cost viewport steps their highlight.
 *  • `page.viewportSize()` is SYNCHRONOUS, which is what makes reporting the
 *    APPLIED size possible under the first two rules. It's the applied size
 *    rather than an echo of the requested one on purpose — that's the whole
 *    point of logging it.
 */
function stepLogLine(step: Step): string | null {
  if (step.type !== "viewport") return null;
  const w = num(step.width, 1280);
  const h = num(step.height, 800);
  return (
    "console.log(" +
    q("[viewport] resized to " + w + "x" + h + " — page reports ") +
    " + JSON.stringify(page.viewportSize()));"
  );
}

/** The title a step's `test.step` wrapper carries — a PHRASE, never code.
 *
 *  `describeStep` falls through to the emitted statement for the common
 *  types, and a title that quotes the statement is wrong twice over: it
 *  doubles every line of the spec, and it puts `page.getByTestId("a")` inside
 *  a string where a scan of the file can find it (the parser consumes the
 *  wrapper whole, but every other reader of the file — a grep, a model, a
 *  reviewer — would not). So the common types get a short spelling here:
 *  the verb, the locator as `kind "value"`, and a capped value. Types
 *  `describeStep` already phrases keep that phrase. */
export function stepTitle(step: Step): string {
  const loc = (l: Locator | undefined): string => {
    if (!l) return "";
    const name = l.name ? ` ${JSON.stringify(String(l.name))}` : "";
    return `${l.k} ${JSON.stringify(String(l.v ?? ""))}${name}`;
  };
  const short = (v: unknown): string => {
    const text = String(v ?? "");
    return JSON.stringify(text.length > 40 ? text.slice(0, 37) + "…" : text);
  };
  switch (step.type) {
    case "code":
      return step.label?.trim() || "code";
    case "click":
    case "dblclick":
    case "rightclick":
    case "check":
    case "uncheck":
      return `${step.type} ${loc(step.locator)}`.trim();
    case "fill":
    case "select":
      return `${step.type} ${loc(step.locator)} ${short(step.value)}`.replace(/\s+/g, " ").trim();
    case "press":
      return `press ${short(step.value ?? step.text ?? "")}${step.locator ? " on " + loc(step.locator) : ""}`;
    case "goto":
      return `goto ${short(step.url ?? "")}`;
    case "assert": {
      const subject = step.locator ? loc(step.locator) : "page";
      const expected =
        step.value !== undefined && step.value !== "" ? " " + short(step.value) : "";
      return `${step.soft ? "soft " : ""}expect ${subject} ${step.assert ?? ""}${expected}`.replace(/\s+/g, " ").trim();
    }
    case "wait":
      return step.waitUntil ? describeStep(step) : `wait for ${loc(step.locator)}`.trim();
    case "viewport":
      return `viewport ${num(step.width, 0)}x${num(step.height, 0)}`;
    case "scroll":
      return step.locator ? `scroll to ${loc(step.locator)}` : describeStep(step);
    default: {
      // Anything `describeStep` phrases stays a phrase; anything it spells
      // as the statement gets the type and the target instead, so no title
      // ever carries code.
      const phrase = describeStep(step);
      return /\bpage\.|\bexpect\(|\bglaze[A-Z]/.test(phrase)
        ? `${step.type} ${loc(step.locator)}`.trim()
        : phrase;
    }
  }
}

/** Short human description of a step for the UI.
 *
 *  Deliberately renders values with no variable context, so a `${name}`
 *  reference shows as written rather than as the `V.name` the spec compiles to
 *  — the step list is meant to read like what the user typed. */
export function describeStep(step: Step): string {
  // Kept identical to the renderer's mirror — describe-step-parity.test.ts
  // compares the two for every step type.
  if (step.type === "code") {
    const first = (step.code ?? "").split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
    const lines = (step.code ?? "").split("\n").filter((l) => l.trim() !== "").length;
    return (step.label ? step.label + ": " : "code: ") + (first.length > 60 ? first.slice(0, 57) + "…" : first) + (lines > 1 ? ` (+${lines - 1} lines)` : "");
  }
  if (step.type === "if") return "if " + describeCondition(step);
  if (step.type === "endif") return "end if";
  if (step.type === "else") return "else";
  if (step.type === "loop") return "repeat " + (step.loopCount ?? 1) + " times";
  if (step.type === "endLoop") return "end repeat";
  // Kept in sync with the mirror in renderer/lib/describe-step.ts.
  if (step.type === "aiCheck") return `AI check: ${JSON.stringify(step.text ?? "")}`;
  // A PHRASE, not the emitted matcher. `expect(V.total, "total").toBe("49.99")`
  // names the mechanism; "total equals \"49.99\"" is the claim the user made.
  // Kept in sync with the mirror in renderer/lib/describe-step.ts.
  if (step.type === "assert" && step.assert === "variable") return describeVariableCheck(step);
  if (step.type === "echo") return "echo " + JSON.stringify(step.text ?? step.value ?? "");
  if (step.type === "emailCode") {
    // A PHRASE, not the helper line: glazeEmailCode(...) names the mechanism,
    // and what the user did was "wait for the code they email me".
    const where = step.mailboxAddress ? ` for ${JSON.stringify(step.mailboxAddress)}` : "";
    const into = step.captureVar ? ` into \${${step.captureVar}}` : "";
    return `read the emailed sign-in code${where}${into}`;
  }
  if (step.type === "group") return "group: " + (step.label ?? "");
  if (step.type === "endGroup") return "end group";
  if (step.type === "teardown") return "teardown — everything below always runs";
  if (step.type === "dialog") {
    return step.dialogAction === "dismiss"
      ? "dismiss the next dialog"
      : "accept the next dialog" + (step.value ? ` with ${JSON.stringify(step.value)}` : "");
  }
  // Phrase, not the helper line — glazeA11yGate(...) names the mechanism.
  // Kept in sync with the mirror in renderer/lib/describe-step.ts.
  if (step.type === "a11y")
    return (
      "check accessibility (fail on " +
      (isA11yImpact(step.a11yImpact) ? step.a11yImpact : "serious") +
      " or worse)"
    );
  // The staged path names the mechanism; the phrase names the intent. Kept
  // in sync with the mirror in renderer/lib/describe-step.ts.
  if (step.type === "upload") {
    const name = typeof step.value === "string" ? step.value.split("/").pop() ?? "" : "";
    return name ? `upload ${JSON.stringify(name)}` : "upload a file";
  }
  // Phrase, not the helper call. Kept in sync with the mirror in
  // renderer/lib/describe-step.ts.
  if (step.type === "api") {
    const m = isApiMethod(step.apiMethod) ? step.apiMethod : "GET";
    const base = `${m} ${step.url ?? ""}`.trim();
    const status = typeof step.expectStatus === "number" ? ` expecting ${num(step.expectStatus, 0)}` : "";
    const cap = isValidVariableName(step.captureVar) ? ` (response → ${step.captureVar})` : "";
    return "API " + base + status + cap;
  }
  if (step.type === "download") {
    const name = step.value ?? "";
    const base =
      name === ""
        ? "expect a download"
        : step.downloadMatch === "exact"
          ? `expect download named ${JSON.stringify(name)}`
          : `expect download containing ${JSON.stringify(name)}`;
    return isValidVariableName(step.captureVar)
      ? base + ` (filename → ${step.captureVar})`
      : base;
  }
  if (step.type === "wait" && step.waitUntil) return describeWait(step);
  if (step.type === "cookie") return describeCookie(step);
  if (step.type === "capture") return describeCapture(step);
  if (step.type === "runFlow") return describeFlow(step);
  // A position scroll is described as a phrase: the emitted line is a
  // glazeScrollTo(...) helper call, which names the mechanism rather than the
  // intent. An ELEMENT scroll falls through to the line, which reads fine.
  // Kept in sync with the mirror in renderer/lib/describe-step.ts — pinned by
  // describe-step-parity.test.ts.
  // `num`, not raw interpolation, even though this is "only" a description:
  // it is embedded into the spec as an UNGENERATABLE comment for a scroll step
  // with no usable fields, and a step already on disk can carry a forged
  // string in these fields (updateStep copies without re-normalizing).
  if (step.type === "scroll" && !step.locator)
    return "scroll to (" + num(step.scrollX, 0) + ", " + num(step.scrollY, 0) + ")";
  const line = stepLine(step);
  return line ? line.replace(/^await /, "").replace(/;$/, "") : step.type;
}

/** Readable phrasing of a variable check — used by BOTH the `variable` assert
 *  kind and the `variable` condition, because they are the same claim in two
 *  places and describing them differently is how a user comes to believe they
 *  mean different things. Kept in sync with the mirror in
 *  renderer/lib/describe-step.ts. */
export function describeVariableCheck(step: Step): string {
  const name = step.captureVar || "variable";
  const op = step.compareOp ?? "eq";
  const label = COMPARE_OP_LABEL[op] ?? "equals";
  return name + " " + label + " " + JSON.stringify(step.value ?? "");
}

/** Readable phrasing of a `capture` step. Kept in sync with the mirror in
 *  renderer/lib/describe-step.ts. */
export function describeCapture(step: Step): string {
  const name = step.captureVar || "variable";
  const from = step.captureFrom ?? "text";
  const loc = step.locator ? root(step.locator) + "." + locatorExpr(step.locator) : "page";
  switch (from) {
    case "count":
      return `capture ${name} from ${loc} count`;
    case "url":
      return `capture ${name} from the page URL`;
    case "title":
      return `capture ${name} from the page title`;
    case "value":
      return `capture ${name} from ${loc} value`;
    case "attribute":
      return `capture ${name} from ${loc} @${step.captureAttr || "attribute"}`;
    case "text":
    default:
      return `capture ${name} from ${loc} text`;
  }
}

/** Readable phrasing of a `runFlow` step. Kept in sync with the mirror in
 *  renderer/lib/describe-step.ts. */
export function describeFlow(step: Step): string {
  const name = step.label || step.flowId || "flow";
  // name=value rather than the bare names: a bound flow call's meaning IS its
  // arguments, and two calls to the same flow differ only here. Values are
  // clipped for the step list; the only spec-side sink is a comment, and both
  // comment emitters run through `commentSafe`, so a hostile value cannot
  // escape (pinned in assert-emission.test.ts). A repeated call carries its
  // ×N / ×${var} suffix — the loop is part of what the call MEANS.
  const entries = Object.entries(step.flowArgs ?? {});
  const args = entries.map(([k, v]) => `${k}=${v.length > 18 ? v.slice(0, 17) + "…" : v}`);
  const base =
    entries.length === 0 ? `run flow ${name}` : `run flow ${name} (${args.join(", ")})`;
  const { fixed, variable } = repeatSpec(step);
  if (variable !== undefined) return `${base} ×\${${variable}}`;
  return fixed > 1 ? `${base} ×${fixed}` : base;
}

/** Readable phrasing of a cookie step for the trainer's step list. Kept in
 *  sync with the mirror in renderer/lib/describe-step.ts. */
export function describeCookie(step: Step): string {
  const c = step.cookie;
  switch (step.cookieAction) {
    case "clearAll":
      return "clear all cookies";
    case "delete":
      return c?.name ? `delete cookie ${c.name}` : "delete cookie";
    case "set":
    default: {
      if (!c?.name) return "set cookie";
      const scope = c.domain ? ` on ${c.domain}` : "";
      return `set cookie ${c.name}=${c.value ?? ""}${scope}`;
    }
  }
}

/** Readable phrasing of an `if` condition for the trainer's step list. */
export function describeCondition(step: Step): string {
  const loc = step.locator;
  const el = loc ? root(loc) + "." + locatorExpr(loc) : "element";
  switch (step.cond) {
    case "variable":
      return describeVariableCheck(step);
    case "urlContains":
      return "URL contains " + q(step.value ?? "");
    case "titleContains":
      return "title contains " + q(step.value ?? "");
    case "hidden":
      return el + " is hidden";
    case "exists":
      return el + " exists";
    case "enabled":
      return el + " is enabled";
    case "disabled":
      return el + " is disabled";
    case "checked":
      return el + " is checked";
    case "unchecked":
      return el + " is unchecked";
    case "visible":
    default:
      return el + " is visible";
  }
}

/**
 * Readable phrasing of a conditional `wait` step. Kept in sync with the mirror
 * in renderer/lib/describe-step.ts.
 *
 * Deliberately NOT the generated line with `await`/`;` stripped, the way the
 * other step types are described. That line carries the `// wait until` marker
 * and a `{ timeout: … }` options object, which would put parser plumbing in
 * front of the user in the step list.
 */
export function describeWait(step: Step): string {
  const loc = step.locator;
  const el = loc ? root(loc) + "." + locatorExpr(loc) : "element";
  const secs = Math.round((step.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS) / 100) / 10;
  const within = " (within " + secs + "s)";
  switch (step.waitUntil) {
    case "urlContains":
      return "wait until URL contains " + q(step.value ?? "") + within;
    case "titleContains":
      return "wait until title contains " + q(step.value ?? "") + within;
    case "hidden":
      return "wait until " + el + " is hidden" + within;
    case "exists":
      return "wait until " + el + " exists" + within;
    case "enabled":
      return "wait until " + el + " is enabled" + within;
    case "disabled":
      return "wait until " + el + " is disabled" + within;
    case "checked":
      return "wait until " + el + " is checked" + within;
    case "unchecked":
      return "wait until " + el + " is unchecked" + within;
    case "text":
      return "wait until " + el + " contains text " + q(step.text ?? "") + within;
    case "value":
      return "wait until " + el + " has value " + q(step.value ?? "") + within;
    case "count":
      return "wait until " + el + " has count " + (step.count ?? 0) + within;
    case "visible":
    default:
      return "wait until " + el + " is visible" + within;
  }
}

/** The subset of a flow's record the generator needs to inline it. */
export type FlowSource = Pick<TestRecord, "id" | "name" | "steps"> &
  Partial<Pick<TestRecord, "variables" | "flowParams">>;

export interface GenerateOptions {
  /** Resolve a `runFlow` step's target. Omitted (the default) means flows
   *  can't be inlined and each `runFlow` step emits an explanatory comment —
   *  which is what every caller that only has one record in hand should get,
   *  rather than a silently missing block of steps. */
  resolveFlow?: (flowId: string) => FlowSource | null;
}

/** One generated statement, tagged with the step it came from. */
interface ExpandedStep {
  step: Step;
  /** index into the ORIGINAL record.steps — inlined flow steps all carry the
   *  index of the `runFlow` step that pulled them in, so highlighting a running
   *  step points at something the user can actually see in the step list. */
  sourceIndex: number;
  /** set when the step can't be generated (missing flow, cycle); emitted as a
   *  comment so the spec stays runnable and the problem stays visible. */
  problem?: string;
  /** marks the boundary of a repeated flow call: `open` emits the `for` line,
   *  `close` its `}`. Both carry the `runFlow` step itself (so emission can
   *  read `repeat`/`repeatVar`) and the call row's sourceIndex. */
  loop?: "open" | "close";
}

/** A `runFlow` step's effective repeat, both clamped forms. Applied at
 *  expansion AND baked into the emitted expression: the emitted clamp is the
 *  one that bounds a variable-driven count, whose value only exists at run
 *  time and arrives from a dataset row — user input. */
function repeatSpec(step: Step): { fixed: number; variable?: string } {
  const variable = isValidVariableName(step.repeatVar) ? step.repeatVar : undefined;
  const raw =
    typeof step.repeat === "number" && Number.isFinite(step.repeat)
      ? Math.trunc(step.repeat)
      : 1;
  return { fixed: Math.max(1, Math.min(MAX_FLOW_REPEAT, raw)), variable };
}

/** Substitute `${param}` references in a flow step's interpolatable fields.
 *
 *  Binding happens HERE, textually, at generation time rather than through a
 *  runtime scope: the value a caller supplies may itself reference the
 *  caller's own variables, and rewriting the text lets that resolve against the
 *  caller's `V` with no nested scopes to reason about.
 *
 *  Exported for the callers that need the SAME binding outside generation —
 *  unwrapping a flow call into plain steps, and the trainer's inline preview of
 *  what an inlined step will do. A second spelling of this substitution would
 *  disagree with the generated spec the day either changed. */
export function bindFlowStep(step: Step, args: Record<string, string>): Step {
  const names = Object.keys(args);
  if (names.length === 0) return step;
  const sub = (text: string): string => {
    if (!text.includes("${")) return text;
    return text.replace(VAR_REF_RE, (whole, name: string) =>
      Object.prototype.hasOwnProperty.call(args, name) ? args[name] : whole,
    );
  };
  // Which fields those are is `mapInterpolatable`'s to say, not this
  // function's. Spelling the list again here is what left an API step inside
  // a flow reading the caller's `${param}` as literal text.
  return mapInterpolatable(step, sub);
}

/**
 * The textual bindings one `runFlow` call applies to its flow's steps.
 *
 * ALL of the flow's plain variables are bound, not only the declared
 * parameters. A flow is written against its OWN variable scope, and before this
 * a non-parameter `${x}` inside a flow fell through to the caller: if the
 * caller happened to declare an `x` the step silently read the caller's value,
 * and if it didn't the reference emitted as the literal string `"${x}"`. Both
 * are wrong the same way — dynamic scoping nobody asked for.
 *
 * Two kinds stay UNBOUND on purpose, so they keep resolving through `V` at run
 * time: a secret's value is never on the record (it arrives via env), and a
 * captured variable's value doesn't exist until the flow's own `capture` step
 * writes it mid-run. Both are surfaced to the caller's header instead — see
 * the `extras` accumulator in `expandSteps`. A parameter naming a secret or
 * captured variable is therefore not overridable; a parameter naming nothing
 * at all still binds (caller's value, else empty).
 */
export function flowCallBindings(
  flow: Pick<FlowSource, "variables" | "flowParams">,
  flowArgs: Record<string, string> | undefined,
): Record<string, string> {
  const params = new Set(flow.flowParams ?? []);
  const args: Record<string, string> = {};
  for (const v of flow.variables ?? []) {
    if (v.kind !== "plain") continue;
    const supplied = params.has(v.name) ? flowArgs?.[v.name] : undefined;
    args[v.name] = typeof supplied === "string" ? supplied : (v.value ?? "");
  }
  for (const param of params) {
    if (param in args) continue;
    const declared = (flow.variables ?? []).find((v) => v.name === param);
    if (declared) continue; // secret/captured: stays a runtime V reference
    const supplied = flowArgs?.[param];
    args[param] = typeof supplied === "string" ? supplied : "";
  }
  return args;
}

/** Expand `runFlow` steps into the steps they invoke, depth-first.
 *
 *  `extras` accumulates the flow variables that CANNOT be bound textually
 *  (secrets and captured variables) so the caller's `const V` header can
 *  declare them — without that, a flow's `${sessionToken}` reference emits as
 *  literal text and its secret has no `process.env` line to arrive through. */
function expandSteps(
  steps: Step[],
  opts: GenerateOptions,
  sourceIndexOf: (i: number) => number,
  stack: string[],
  extras: Map<string, TestVariable>,
): ExpandedStep[] {
  const out: ExpandedStep[] = [];
  steps.forEach((step, i) => {
    const sourceIndex = sourceIndexOf(i);
    if (step.type !== "runFlow") {
      out.push({ step, sourceIndex });
      return;
    }
    const flowId = step.flowId ?? "";
    const label = step.label || flowId || "flow";
    if (!opts.resolveFlow) {
      out.push({ step, sourceIndex, problem: `flow ${label} not inlined (no resolver)` });
      return;
    }
    // A flow that invokes itself, directly or through another flow, would
    // expand forever. Refuse the repeat rather than recursing — the step list
    // is user-editable, so this is reachable by ordinary editing, not just by
    // a bug.
    if (stack.includes(flowId)) {
      out.push({ step, sourceIndex, problem: `flow ${label} skipped (circular reference)` });
      return;
    }
    const flow = opts.resolveFlow(flowId);
    if (!flow) {
      out.push({ step, sourceIndex, problem: `flow ${label} not found` });
      return;
    }
    if (flow.steps.length === 0) {
      out.push({ step, sourceIndex, problem: `flow ${label} has no steps` });
      return;
    }
    // Bind the flow's variable scope: the caller's argument wins for a declared
    // parameter, everything else takes the flow's own value.
    const args = flowCallBindings(flow, step.flowArgs);
    for (const v of flow.variables ?? []) {
      if (v.kind === "plain") continue;
      if (!extras.has(v.name)) extras.set(v.name, v);
    }
    const inner = expandSteps(
      flow.steps.map((s) => {
        const bound = bindFlowStep(s, args);
        // The call site's disabled/continue-on-failure apply to the whole
        // inlined block: disabling a flow call must not run half of it.
        if (step.disabled) bound.disabled = true;
        if (step.continueOnFailure) bound.continueOnFailure = true;
        return bound;
      }),
      opts,
      () => sourceIndex,
      [...stack, flowId],
      extras,
    );
    // A repeated call wraps its inlined block in loop markers. A DISABLED call
    // doesn't: its steps are emitted commented out, and a live `for` around
    // dead lines would be an empty loop that claims to run something.
    const { fixed, variable } = repeatSpec(step);
    if ((variable !== undefined || fixed > 1) && !step.disabled) {
      out.push({ step, sourceIndex, loop: "open" }, ...inner, { step, sourceIndex, loop: "close" });
    } else {
      out.push(...inner);
    }
  });
  return out;
}

/** Build the `const V = {...}` header for a test's variables.
 *
 *  Spread order is the whole design: declared defaults first, then the run's
 *  injected values (a dataset row), then secrets. Secrets go LAST so nothing
 *  can shadow them — a dataset row naming a secret variable must not be able to
 *  substitute a plaintext value for the encrypted one.
 *
 *  `needsCapture` forces the header even with zero declared variables: a
 *  capture step's emitted `glazeCapture(V, …)` writes into `V` at run time, so
 *  a spec containing one without the header is a ReferenceError on line one. */
function variableHeader(variables: TestVariable[], needsCapture: boolean): string[] {
  if (variables.length === 0 && !needsCapture) return [];
  const plain = variables.filter((v) => v.kind !== "secret" && v.kind !== "generated");
  const generated = variables.filter((v) => v.kind === "generated");
  const secret = variables.filter((v) => v.kind === "secret");
  const lines: string[] = ["  const V = {"];
  for (const v of plain) {
    lines.push(`    ${v.name}: ${q(v.value ?? "")},`);
  }
  // Generated values sit BEFORE the spread so a dataset row can PIN one —
  // pinning beats randomness, the same way a row overrides a plain default.
  // The spec string comes from OUR allowlist, never the record field raw:
  // it lands in source as a literal, so it gets the same double guard every
  // interpolated enum does. The name is grammar-safe (isValidVariableName)
  // but is still emitted through q() — belt and braces cost one call.
  for (const v of generated) {
    const spec = isGenSpec(v.genSpec) ? v.genSpec : "string";
    lines.push(`    ${v.name}: glazeGenerate("${spec}", ${q(v.name)}),`);
  }
  // JSON.parse over an env var rather than a baked-in literal: this is what
  // lets one spec run once per dataset row without regenerating the file.
  lines.push('    ...JSON.parse(process.env.GLAZE_VARS || "{}"),');
  for (const v of secret) {
    if (v.totp) {
      // A GETTER, not a value: TOTP codes expire in 30 seconds, and a code
      // computed at spec start is stale by the MFA prompt. Every ${V.name}
      // read derives the current code from the stored setup key. Sits with
      // the secrets, after the spread, so a dataset row cannot shadow it.
      lines.push(
        `    get ${v.name}() { return glazeTotp(process.env.${secretEnvName(v.name)} ?? ""); },`,
      );
    } else {
      lines.push(`    ${v.name}: process.env.${secretEnvName(v.name)} ?? "",`);
    }
  }
  lines.push("  };");
  return lines;
}

/** Generated spec plus the line→step map the runner needs to attribute a
 *  running step back to the step list. */
export interface GeneratedSpec {
  source: string;
  /** 1-based spec line number → 0-based index into `record.steps`. */
  lineMap: Record<number, number>;
}

export type SpecSource = Pick<TestRecord, "name" | "url" | "steps"> &
  Partial<Pick<TestRecord, "variables" | "basicAuth" | "baseUrl">>;

/**
 * Generate the spec AND the authoritative line→step map.
 *
 * The map is emitted here rather than re-derived from the finished file
 * because only this function knows which step produced which line. The
 * runner's `buildStepLineMap` fallback infers it by counting `await` lines,
 * which silently mis-attributes any step that emits something else (an `if`
 * block, an inlined flow) — every step after it shifts by one.
 */
export function generateSpecDetailed(
  record: SpecSource,
  opts: GenerateOptions = {},
): GeneratedSpec {
  const body: string[] = [];
  const lineMap: Record<number, number> = {};

  // Track block nesting so conditional bodies are indented one level deeper.
  // Initialised to `baseDepth` below, once the teardown split is known.
  let depth = 1; // base level: statements sit inside the test() callback
  const flowExtras = new Map<string, TestVariable>();
  const expanded = expandSteps(record.steps, opts, (i) => i, [], flowExtras);

  // ── Teardown split ───────────────────────────────────────────────────────
  //
  // `teardownSplit` is the index in `expanded` of the divider that puts every
  // step after it in a block that runs even when a step before it threw. It is
  // computed here, before anything is emitted, because it decides the base
  // indent of the WHOLE body.
  //
  // Two refusals, both emitted as a comment rather than silently honoured.
  // A divider nested inside an `if` or `loop` cannot be a split: the block it
  // opens would have to close across the enclosing block's brace, which is a
  // syntax error, and a spec that does not parse is worse than a test with no
  // teardown. A SECOND divider has no meaning either — the first already
  // claimed "everything after this" — so it degrades to a comment instead of
  // silently re-splitting and dropping the first block's steps.
  const teardownRefusals = new Set<number>();
  let teardownSplit = -1;
  {
    let nesting = 0;
    for (let k = 0; k < expanded.length; k++) {
      const e = expanded[k];
      if (e.problem) continue;
      const t = e.step.type;
      if (t === "if" || t === "loop") nesting += 1;
      else if (t === "endif" || t === "endLoop") nesting = Math.max(0, nesting - 1);
      else if (t === "teardown") {
        if (teardownSplit >= 0 || nesting > 0) teardownRefusals.add(k);
        else teardownSplit = k;
      }
    }
  }
  const hasTeardown = teardownSplit >= 0;
  // Everything sits one level deeper once the body is wrapped. `baseDepth` is
  // the floor every block-closing `Math.max` uses — hard-coding 1 there would
  // un-indent the first `}` of a block that closed inside the wrapper.
  const baseDepth = hasTeardown ? 2 : 1;
  depth = baseDepth;

  // The caller's declarations, plus the inlined flows' runtime-only variables
  // (secrets and captured values). The caller's own declaration of a name wins
  // — a flow must not be able to shadow what the test already says — and the
  // extras keep their relative order so regeneration is deterministic.
  const own = record.variables ?? [];
  const ownNames = new Set(own.map((v) => v.name));
  const variables = [...own, ...[...flowExtras.values()].filter((v) => !ownNames.has(v.name))];
  const vars: ReadonlySet<string> = new Set(variables.map((v) => v.name));

  // Everything above the test body, built as lines so the line map is derived
  // from the real preamble rather than a hard-coded count — the preamble grows
  // by one when a capture step is present, and an off-by-one here would
  // mis-attribute EVERY step rather than fail loudly.
  const needsCapture = expanded.some((e) => !e.problem && e.step.type === "capture");
  // Only a POSITION scroll needs the helper — an element scroll is a native
  // locator call. Import exactly the names used: a capture-only spec must keep
  // regenerating byte-identically to what this generator produced before
  // scroll steps existed.
  const needsScroll = expanded.some(
    (e) => !e.problem && e.step.type === "scroll" && !e.step.locator,
  );
  const needsA11y = expanded.some((e) => !e.problem && e.step.type === "a11y");
  const needsGenerate = variables.some((v) => v.kind === "generated");
  const needsApi = expanded.some((e) => !e.problem && e.step.type === "api");
  // The same guard the emission case applies. Without the captureVar clause a
  // step that emits NOTHING still adds the import, and the generator's own
  // rule is that a spurious import is as wrong as a missing one.
  const needsEmailCode = expanded.some(
    (e) => !e.problem && e.step.type === "emailCode" && isValidVariableName(e.step.captureVar),
  );
  const needsTotp = variables.some((v) => v.kind === "secret" && v.totp);
  const needsAiCheck = expanded.some((e) => !e.problem && e.step.type === "aiCheck");
  const needsDialog = expanded.some((e) => !e.problem && e.step.type === "dialog");
  const needsEcho = expanded.some((e) => !e.problem && e.step.type === "echo");
  // The preamble is built AFTER the body now — see the note above the
  // assembly at the end. Emission only needs `record1`, which records a
  // body-RELATIVE line and is resolved to an absolute one once the preamble's
  // height is known.
  const relLines: [number, number][] = [];
  const record1 = (index: number): void => {
    relLines.push([body.length, index]);
  };
  // Every plain statement is wrapped in `await test.step(<description>, …)`
  // since 2026-08-22: Playwright's own reports and trace viewer then show the
  // step by the name the Steps tab gives it, and the Script IDE folds and
  // reports per step. Three rules keep the wrapper from changing what runs:
  // only a STATEMENT is wrapped, never a brace half (`if`/`else`/`endif`, a
  // loop's `for`/`}`), never a comment, and never a download's arming line,
  // which must stay in the scope its `await downloadN` reads from; the
  // wrapped line is the one `record1` attributes, so the run highlight and
  // the reporter's `pw:api` markers land on the statement, not the header.
  // The title goes through `q()` like every free string.
  const stepOpen = (indent: string, step: Step): string =>
    indent + "await test.step(" + q(stepTitle(step)) + ", async () => {";
  const stepClose = (indent: string): string => indent + "});";

  // TWO loop bookkeepings, for the two loop constructs. `loopNames` holds the
  // open `loop`/`endLoop` BLOCK variables (`i`, `i2`, …) so nested blocks
  // don't shadow each other — a second `let i` inside the first is a
  // SyntaxError. `loopIdx`/`refusedLoops` belong to the runFlow CALL repeat:
  // sequential `gl_i<k>` counters so nested repeated flows can't collide with
  // each other or with the block names, and the set of calls whose loop was
  // refused (repeat variable not declared) so the matching close marker is
  // skipped too.
  const loopNames: string[] = [];
  // Open blocks by KIND, innermost last, with whether an `if` has spent its
  // `else`. The stack exists for one emission decision: `} else {` is only
  // valid directly inside an if that has no else yet — emitted anywhere else
  // (top of a loop, second else, no block at all) it is a SyntaxError, the
  // same never-break-the-file rule the loop halves follow.
  const blockKinds: { kind: "if" | "loop"; elsed?: boolean }[] = [];
  let aiCheckIdx = 0;
  let loopIdx = 0;
  const refusedLoops = new Set<Step>();

  // ── Download arming pre-pass ─────────────────────────────────────────────
  //
  // Playwright's blessed download shape arms the waitForEvent promise BEFORE
  // the triggering action — a listener attached after the click races the
  // event it exists to catch. So each `download` step's arming line is
  // emitted just before its trigger: the nearest preceding entry that is a
  // plain emitting step. Structural steps (if/endif, loop halves, flow-loop
  // markers) are refused as triggers — arming before an `endif` would put the
  // const inside a block the await cannot see — and fall back to arming in
  // place, which still awaits honestly against its timeout. Numbering is
  // emission order, so regeneration is a fixed point.
  const STRUCTURAL = new Set(["if", "endif", "loop", "endLoop"]);
  const armBefore = new Map<number, { n: number; step: Step; sourceIndex: number }[]>();
  const downloadNum = new Map<Step, { n: number; inPlace: boolean }>();
  {
    let n = 0;
    for (let k = 0; k < expanded.length; k++) {
      const e = expanded[k];
      if (e.problem || e.step.type !== "download" || e.step.disabled) continue;
      n += 1;
      let j = k - 1;
      while (
        j >= 0 &&
        (expanded[j].problem || expanded[j].step.type === "download")
      ) {
        j -= 1;
      }
      const trigger =
        j >= 0 && !expanded[j].loop && !STRUCTURAL.has(expanded[j].step.type)
          ? j
          : -1;
      downloadNum.set(e.step, { n, inPlace: trigger < 0 });
      if (trigger >= 0) {
        const list = armBefore.get(trigger) ?? [];
        list.push({ n, step: e.step, sourceIndex: e.sourceIndex });
        armBefore.set(trigger, list);
      }
    }
  }
  const armingLine = (n: number, step: Step): string => {
    const t = step.timeoutMs;
    const timeout =
      typeof t === "number" && Number.isFinite(t)
        ? Math.min(3_600_000, Math.max(1, Math.trunc(t)))
        : DEFAULT_WAIT_TIMEOUT_MS;
    return `const download${n} = page.waitForEvent("download", { timeout: ${timeout} });`;
  };

  // The latch itself. `glTeardownError` holds the FIRST error either half
  // threw, and the rethrow at the end is what keeps the test failing. A bare
  // `try { … } finally { … }` was the obvious shape and is wrong: when the
  // body has already thrown, a cleanup step that throws inside `finally`
  // REPLACES that error, so the run reports "could not click Delete account"
  // and the failure the user actually has to see is gone. Latching the first
  // error and letting the second lose keeps the body's failure authoritative
  // while still surfacing a teardown-only failure when the body passed.
  if (hasTeardown) {
    body.push("  let glTeardownError;");
    body.push("  try {");
  }

  let expandedIndex = -1;
  for (const { step, sourceIndex, problem, loop } of expanded) {
    expandedIndex += 1;
    if (step.type === "teardown") {
      if (teardownRefusals.has(expandedIndex)) {
        // Named out loud. A divider that silently did nothing would leave the
        // step list promising "everything below always runs" against a spec
        // that makes no such promise.
        record1(sourceIndex);
        body.push(
          "  ".repeat(depth) +
            "// teardown divider ignored — " +
            (teardownSplit >= 0 && teardownSplit !== expandedIndex
              ? "this test already has one"
              : "a divider cannot sit inside an if or repeat block"),
        );
        continue;
      }
      record1(sourceIndex);
      body.push("  } catch (e) { glTeardownError = e; }");
      body.push("  // ── teardown (always runs) ──");
      body.push("  try {");
      continue;
    }
    for (const pending of armBefore.get(expandedIndex) ?? []) {
      record1(pending.sourceIndex);
      body.push("  ".repeat(depth) + armingLine(pending.n, pending.step));
    }
    if (problem) {
      // Through `commentSafe` like every other comment: `problem` embeds the
      // step's LABEL, which is user text that `str()` length-caps but does not
      // strip line terminators from. Raw, a label containing a newline ended
      // the comment early and its remainder became a statement in the spec —
      // reachable from the capture channel with an unresolvable flowId, which
      // made it page input compiled into executed code. Pinned alongside the
      // other comment sinks in assert-emission.test.ts.
      body.push(commentSafe("  // " + problem));
      continue;
    }
    // Loop halves are emitted here rather than in `stepLine`: the `for` line
    // needs a variable name that depends on how many loops are already open,
    // which is emission-order state a per-step formatter cannot hold. Same
    // pairing rules as if/endif — never disabled, never wrapped — plus one
    // repair the spec's parseability demands: a stray `endLoop` (its opening
    // half was deleted) becomes a comment instead of an unbalanced `}` that
    // would make the whole file a syntax error.
    if (step.type === "loop") {
      const lc = step.loopCount;
      // The generator clamps independently of `normalizeLocator`-style bounds
      // at the boundary — same double-guard as every numeral, covering steps
      // that arrive through `updateStep`'s raw copy.
      const count =
        typeof lc === "number" && Number.isFinite(lc)
          ? Math.min(MAX_LOOP_COUNT, Math.max(1, Math.trunc(lc)))
          : 1;
      const nm = loopNames.length === 0 ? "i" : "i" + (loopNames.length + 1);
      record1(sourceIndex);
      body.push("  ".repeat(depth) + `for (let ${nm} = 0; ${nm} < ${count}; ${nm}++) {`);
      loopNames.push(nm);
      blockKinds.push({ kind: "loop" });
      depth += 1;
      continue;
    }
    if (step.type === "endLoop") {
      if (loopNames.length === 0) {
        body.push(commentSafe("  ".repeat(depth) + "// end repeat without an open loop — skipped"));
        continue;
      }
      if (blockKinds[blockKinds.length - 1]?.kind === "loop") blockKinds.pop();
      loopNames.pop();
      depth = Math.max(baseDepth, depth - 1);
      record1(sourceIndex);
      body.push("  ".repeat(depth) + "}");
      continue;
    }
    if (loop === "open") {
      const { fixed, variable } = repeatSpec(step);
      if (variable !== undefined && !vars.has(variable)) {
        // A count read from a variable nothing declares would emit
        // `Number(V.x)` against a header that may not even exist. Running the
        // flow ONCE with a visible sentence is the degradation that loses the
        // least — the steps still run, and the file says why only once.
        refusedLoops.add(step);
        body.push(
          commentSafe(
            "  ".repeat(depth) +
              `// flow ${step.label || step.flowId || "flow"} repeat count \${${variable}} is not a declared variable — running once`,
          ),
        );
        continue;
      }
      const indent = "  ".repeat(depth);
      const k = loopIdx;
      loopIdx += 1;
      const i = `gl_i${k}`;
      const n = `gl_n${k}`;
      body.push(
        variable !== undefined
          ? `${indent}for (let ${i} = 0, ${n} = Math.max(0, Math.min(${MAX_FLOW_REPEAT}, Number(V.${variable}) || 0)); ${i} < ${n}; ${i}++) {`
          : `${indent}for (let ${i} = 0; ${i} < ${String(fixed)}; ${i}++) {`,
      );
      blockKinds.push({ kind: "loop" });
      depth += 1;
      continue;
    }
    if (loop === "close") {
      if (refusedLoops.has(step)) continue;
      if (blockKinds[blockKinds.length - 1]?.kind === "loop") blockKinds.pop();
      depth = Math.max(baseDepth, depth - 1);
      body.push("  ".repeat(depth) + "}");
      continue;
    }
    // `else` splits the innermost if. Valid only there: emitted anywhere else
    // it is an unbalanced-brace SyntaxError, so a stray or second else becomes
    // a comment — the same never-break-the-file rule the loop halves follow.
    if (step.type === "else") {
      const top = blockKinds[blockKinds.length - 1];
      if (!top || top.kind !== "if" || top.elsed) {
        body.push(
          commentSafe(
            "  ".repeat(depth) +
              (top?.elsed
                ? "// second else in one if — skipped"
                : "// else without an open if — skipped"),
          ),
        );
        continue;
      }
      top.elsed = true;
      depth = Math.max(baseDepth, depth - 1);
      record1(sourceIndex);
      body.push("  ".repeat(depth) + "} else {");
      depth += 1;
      continue;
    }
    if (step.type === "code") {
      // Verbatim, by definition: the code IS the step. Each line re-indented
      // under the wrapper; a disabled one is commented out line by line so
      // the parser reads the wrapper back as disabled rather than as code.
      const indent = "  ".repeat(depth);
      const lines = dedent(step.code ?? "").split("\n");
      record1(sourceIndex);
      if (step.disabled) {
        body.push(commentSafe(indent + "// disabled — skipped: " + stepOpen("", step).trim()));
        for (const l of lines) body.push(commentSafe(indent + "// disabled — skipped: " + l));
        body.push(commentSafe(indent + "// disabled — skipped: });"));
        continue;
      }
      body.push(stepOpen(indent, step));
      for (const l of lines) body.push(l.trim() === "" ? "" : indent + "  " + l);
      body.push(stepClose(indent));
      continue;
    }
    if (step.type === "aiCheck") {
      const indent = "  ".repeat(depth);
      if (step.disabled) {
        // The STATEMENT, not the phrase: the disabled marker re-parses what
        // follows it, and a phrase would drop the step on round-trip. The
        // ordinal is 0 on purpose — disabled checks are outside the live
        // numbering, and regeneration re-derives ordinals anyway.
        body.push(
          commentSafe(indent + "// disabled — skipped: await glazeAiCheck(page, " + q(step.text ?? "") + ", 0);"),
        );
        continue;
      }
      // The claim is q()'d like every free string; the ordinal pairs the
      // helper's screenshot file with this step after the run and is OURS
      // (a counter, never a step field).
      aiCheckIdx += 1;
      body.push(stepOpen(indent, step));
      record1(sourceIndex);
      body.push(indent + "  await glazeAiCheck(page, " + q(step.text ?? "") + ", " + aiCheckIdx + ");");
      body.push(stepClose(indent));
      continue;
    }
    if (step.type === "group" || step.type === "endGroup") {
      // Markers, not code: a group is organization, and organization must
      // never be able to break a spec — so both halves are comments (through
      // commentSafe, like every comment a step field reaches) and the
      // GENERATED indent is untouched. Nesting is the STEP LIST's rendering.
      const indent = "  ".repeat(depth);
      record1(sourceIndex);
      body.push(
        commentSafe(
          step.type === "group"
            ? indent + "// ── group: " + (step.label ?? "") + " ──"
            : indent + "// ── end group ──",
        ),
      );
      continue;
    }
    if (step.type === "download") {
      const indent = "  ".repeat(depth);
      if (step.disabled) {
        body.push(commentSafe(indent + "// disabled — skipped: " + describeStep(step)));
        continue;
      }
      const num = downloadNum.get(step);
      if (!num) continue; // unreachable: every enabled download is numbered
      if (num.inPlace) {
        record1(sourceIndex);
        body.push(indent + armingLine(num.n, step));
      }
      const d = `d${num.n}`;
      const parts = [`const ${d} = await download${num.n};`];
      if ((step.value ?? "") !== "") {
        const matcher = step.downloadMatch === "exact" ? "toBe" : "toContain";
        parts.push(
          `expect(${d}.suggestedFilename()).${matcher}(${valueExpr(step.value, vars)});`,
        );
      }
      // The variable NAME lands in source as an identifier, so it carries the
      // same guard `repeatVar` does — an invalid name drops the capture, never
      // reaches the file.
      if (isValidVariableName(step.captureVar)) {
        parts.push(`V.${step.captureVar} = ${d}.suggestedFilename();`);
      }
      const stmt = `{ ${parts.join(" ")} }`;
      body.push(stepOpen(indent, step));
      record1(sourceIndex);
      body.push(
        indent +
          "  " +
          (step.continueOnFailure ? `try ${stmt} catch { /* continue on failure */ }` : stmt),
      );
      body.push(stepClose(indent));
      continue;
    }
    const line = stepLine(step, vars);
    if (line == null) {
      // `runFlow` is the one step that legitimately emits nothing — its target
      // flow's steps were inlined in its place. Everything else reaching here
      // is a step the user can see in the list and the runner will never
      // execute, so it says so in the file rather than disappearing from it.
      if (step.type !== "runFlow") {
        body.push(commentSafe("  // UNGENERATABLE STEP — " + describeStep(step) + ": " + ungeneratableReason(step)));
      }
      continue;
    }
    if (step.type === "endif") depth = Math.max(baseDepth, depth - 1);
    if (step.type === "endif" && blockKinds[blockKinds.length - 1]?.kind === "if") blockKinds.pop();
    const indent = "  ".repeat(depth);
    // A trailing log statement (viewport only) travels with its step through
    // every arm below: a disabled resize must not log that it happened, and a
    // continue-on-failure resize must log INSIDE the try, or a failed resize
    // would still report a size it never applied.
    const logLine = stepLogLine(step);
    // A disabled step is emitted as a commented-out line so the generated spec
    // stays runnable (the step is skipped) while preserving the step's place
    // in the script for round-tripping and readability. Structural `if`/
    // `endif` are never commented — disabling them would break block pairing.
    if (step.disabled && step.type !== "if" && step.type !== "endif") {
      // Same sink as the UNGENERATABLE comment below, and older: a step's line
      // reaches here through `valueExpr`, which escapes a value into a JS
      // literal — but a `${var}` reference emits a TEMPLATE literal, and a raw
      // newline is legal inside one. Commenting that line out puts the text
      // after the newline back into the file as a statement.
      body.push(commentSafe(indent + "// disabled — skipped: " + line));
      if (logLine) body.push(commentSafe(indent + "// disabled — skipped: " + logLine));
    } else if (step.continueOnFailure && step.type !== "if" && step.type !== "endif") {
      // "Continue on Failure" wraps the step's statement in a try/catch so a
      // failure is swallowed and the test proceeds to the next step. Only
      // applies to action/assert steps — structural `if`/`endif` are never wrapped.
      // The test.step sits INSIDE the try: a step that is allowed to fail is
      // still a step, and Playwright's report should show it failing.
      body.push(indent + "try {");
      body.push(stepOpen(indent + "  ", step));
      record1(sourceIndex);
      body.push(indent + "    " + line);
      if (logLine) body.push(indent + "    " + logLine);
      body.push(stepClose(indent + "  "));
      body.push(indent + "} catch { /* continue on failure */ }");
    } else if (step.type === "if" || step.type === "endif") {
      record1(sourceIndex);
      body.push(indent + line);
    } else {
      body.push(stepOpen(indent, step));
      record1(sourceIndex);
      body.push(indent + "  " + line);
      if (logLine) body.push(indent + "  " + logLine);
      body.push(stepClose(indent));
    }
    if (step.type === "if") blockKinds.push({ kind: "if" });
    if (step.type === "if") depth += 1;
  }

  // A `loop` whose closing half was deleted would leave the file with an
  // unclosed `for {` — a syntax error, a spec that cannot run. Close what
  // remains open with plain braces: the parser reads each one back as an
  // `endLoop`, so the next round-trip restores the pair instead of losing it.
  while (loopNames.length > 0) {
    loopNames.pop();
    depth = Math.max(baseDepth, depth - 1);
    body.push("  ".repeat(depth) + "}");
  }

  if (hasTeardown) {
    // `=== undefined` rather than a truthiness test: a thrown value can be
    // falsy (`throw ""` is legal, and a library rejecting with `null` is not
    // exotic), and a latch that reads that as "nothing failed" turns a real
    // failure into a pass.
    body.push("  } catch (e) { if (glTeardownError === undefined) glTeardownError = e; }");
    body.push("  if (glTeardownError !== undefined) throw glTeardownError;");
  }

  const preamble = ['import { test, expect } from "@playwright/test";'];
  const runtimeNames = [
    ...(needsCapture ? ["glazeCapture"] : []),
    ...(needsScroll ? ["glazeScrollTo"] : []),
    ...(needsA11y ? ["glazeA11yGate"] : []),
    ...(needsGenerate ? ["glazeGenerate"] : []),
    ...(needsApi ? ["glazeApiRequest"] : []),
    ...(needsEmailCode ? ["glazeEmailCode"] : []),
    ...(needsTotp ? ["glazeTotp"] : []),
    ...(needsAiCheck ? ["glazeAiCheck"] : []),
    ...(needsDialog ? ["glazeArmDialog"] : []),
    ...(needsEcho ? ["glazeEcho"] : []),
    // Asked of the EMITTED SOURCE for the same reason glazeReEscape is: only
    // `conditionExpr` decides whether a variable condition compiled to a
    // comparison at all (a step naming no valid variable degrades to `false`),
    // and re-deriving that here would be a second spelling of the same rule.
    ...(body.some((l) => l.includes("glazeCompare(")) ? ["glazeCompare"] : []),
    // Asked of the EMITTED SOURCE, not predicted from the steps.
    //
    // Only `regexPatternExpr` decides whether a value becomes a template with
    // a run-time escape in it — it depends on the kind, the match mode AND on
    // whether the reference names a DECLARED variable. Re-deriving that here
    // would be a second spelling of the same rule, and the two would disagree
    // the day a new pattern-built assert kind is added: an import that is
    // missing makes the spec throw at load, and one that is spurious makes it
    // throw too, since the runtime only exports what it exports.
    ...(body.some((l) => l.includes("glazeReEscape(")) ? ["glazeReEscape"] : []),
    ...(body.some((l) => l.includes("glazeUrlPathPattern(")) ? ["glazeUrlPathPattern"] : []),
  ];
  if (runtimeNames.length > 0) {
    preamble.push(`import { ${runtimeNames.join(", ")} } from "./${GLAZE_RUNTIME_FILE}";`);
  }
  preamble.push("");

  // HTTP basic auth, as a file-level `test.use({ httpCredentials })` before the
  // test — per-file is per-test here. The password is NEVER written into the
  // source: it is read from the same `GLAZE_SECRET_<name>` env var every secret
  // uses, so it stays on the encrypted path and inside the redaction snapshot.
  // `passwordVar` is re-gated through `isValidVariableName` (a stored record is
  // untrusted input) before `secretEnvName`, and the username is `q()`'d.
  const basicAuth = record.basicAuth;
  if (basicAuth && isValidVariableName(basicAuth.passwordVar)) {
    const passwordExpr = "process.env." + secretEnvName(basicAuth.passwordVar) + ' ?? ""';
    // SCOPE the credential to the test's own origin. Without `origin`,
    // Playwright answers ANY server's 401 during the run, so a third-party
    // subresource or a redirect to an attacker's host would receive the
    // password — see shared/basic-auth.mjs. Derived from the test's address,
    // and the trainer's login handler derives the same origin, so the two
    // agree on where the credential may go. Unparseable address → no scope
    // (an exotic case: a basic-auth wall needs a real URL to sit behind).
    const origin = credentialOrigin(record.url) ?? credentialOrigin(record.baseUrl);
    const originClause = origin ? ", origin: " + q(origin) : "";
    preamble.push(
      "test.use({ httpCredentials: { username: " +
        q(basicAuth.username ?? "") +
        ", password: " +
        passwordExpr +
        originClause +
        " } });",
    );
    preamble.push("");
  }

  // A download step saving its filename needs the V object to exist, but NOT
  // the glazeCapture runtime — the write is a plain property assignment. Kept
  // separate from `needsCapture` so a download-only spec doesn't grow an
  // import it never calls.
  // An api step passes V to its helper unconditionally (captures write into
  // it), so any api step forces the header like a capture does.
  const needsVarObject =
    needsCapture ||
    needsApi ||
    // An emailCode step writes the code into V, so it forces the header for
    // the same reason an api capture does.
    needsEmailCode ||
    expanded.some(
      (e) =>
        !e.problem && e.step.type === "download" && isValidVariableName(e.step.captureVar),
    );
  const header = variableHeader(variables, needsVarObject);
  // The `test(...)` line sits at `preamble.length + 1`; the variable header
  // follows it; the first body line is the one after that.
  const bodyStartLine = preamble.length + 2 + header.length;

  // Absolute line numbers, now that the preamble's height is known. Recorded
  // relative during emission because the preamble depends on what the body
  // turned out to contain, and an off-by-one here mis-attributes EVERY step's
  // run highlight rather than failing loudly.
  for (const [rel, index] of relLines) lineMap[bodyStartLine + rel] = index;

  const title = record.name && record.name.trim() ? record.name.trim() : "recorded test";
  const source =
    preamble.join("\n") +
    "\n" +
    "test(" + q(title) + ", async ({ page }) => {\n" +
    [...header, ...body].join("\n") +
    "\n});\n";
  return { source, lineMap };
}

export function generateSpec(record: SpecSource, opts: GenerateOptions = {}): string {
  return generateSpecDetailed(record, opts).source;
}

/** Strip the indentation the lines share, so a code step's text is the
 *  same whether it was typed at column 0 or read back from under a wrapper. */
export function dedent(text: string): string {
  const lines = text.replace(/^\n+|\s+$/g, "").split("\n");
  let common: number | null = null;
  for (const l of lines) {
    if (l.trim() === "") continue;
    const n = l.match(/^[ \t]*/)![0].length;
    common = common === null ? n : Math.min(common, n);
  }
  return lines.map((l) => l.slice(common ?? 0)).join("\n");
}
