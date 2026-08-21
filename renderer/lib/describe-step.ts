// Renders a recorded step as the Playwright call it will generate (without the
// leading `await`/trailing `;`), for display in the UI. Mirrors the backend
// script generator so what the user sees matches the generated script.

import {
  API_METHODS,
  DEFAULT_WAIT_TIMEOUT_MS,
  ELEMENT_STATES,
  isCssPropName,
  MAX_TYPE_DELAY_MS,
} from "./recorder-types";
import {
  ASSERT_SEMANTICS,
  COMPARE_OP_LABEL,
  reEscape,
  textMatchExpr,
  urlPathExpr,
} from "../../shared/step-semantics.mjs";
import { testIdOverride, testIdSelector } from "../../shared/testid-attr.mjs";
import type { Locator, Step, StepType } from "./recorder-types";

function q(s: string): string {
  return JSON.stringify(s ?? "");
}

/** Mirror of `clampedMs` in main/services/script-generator.ts. typeof-checked
 *  for the same reason the scroll branch below is: a stored step can carry a
 *  forged string in a numeric field, and it must not reach UI copy. */
function clampedMs(v: unknown, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  if (n < 0) return null;
  return Math.min(n, max);
}

/** Mirror of `optsExpr` in main/services/script-generator.ts — same fixed key
 *  order, and the same rule that an empty object is omitted entirely. This
 *  string is what the user reads in the step list and the generator's is what
 *  actually runs; the two disagreeing is the failure this file exists to
 *  avoid. */
function optsExpr(parts: string[]): string {
  return parts.length > 0 ? "{ " + parts.join(", ") + " }" : "";
}

/** Mirror of `timeoutParts`, with the same 1h cap. */
function timeoutParts(step: Step): string[] {
  const ms = clampedMs(step.timeoutMs, 3_600_000);
  return ms === null ? [] : ["timeout: " + String(ms)];
}

/** Mirror of `num` in main/services/script-generator.ts: a numeric field is
 *  rendered as an integer or as the fallback, never as whatever a forged step
 *  happens to be carrying. The scroll branch below has always done this by
 *  hand; `toHaveCount` had not, so a stored `count: "2); …"` reached UI copy
 *  verbatim while the generated spec said `toHaveCount(0)`. */
function numExpr(v: unknown, fallback: number): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return String(fallback);
  return String(Math.trunc(v));
}

/** Mirror of `callArgs`. */
function callArgs(args: string[], opts: string): string {
  const all = [...args.filter((a) => a !== ""), ...(opts !== "" ? [opts] : [])];
  return "(" + all.join(", ") + ")";
}

/** Mirror of `locatorExpr` in main/services/script-generator.ts — keep in
 *  sync, and mechanically so: `describe-mirror.test.ts` runs both over a
 *  battery of locators and diffs the strings.
 *
 *  The chain is the point. This file's header promises the step list shows
 *  the call the generated script contains, and until 2026-08-19 the mirror
 *  stopped at the base builder — a step pinned "inside billing-card" with
 *  `.nth(2)` displayed as a bare `getByRole(...)`, hiding exactly the
 *  disambiguation the user added and the run enforces. */
export function locatorExpr(loc: Locator): string {
  let base = locatorBaseExpr(loc);
  const ctx = loc.ctx;
  if (ctx?.within) {
    let scope = locatorBaseExpr(ctx.within);
    if (ctx.withinHasText !== undefined) {
      scope += ".filter({ hasText: " + q(ctx.withinHasText) + " })";
    }
    base = scope + "." + base;
  }
  if (ctx?.and) {
    for (const pred of ctx.and) base += ".and(page." + locatorBaseExpr(pred) + ")";
  }
  if (typeof loc.nth === "number") {
    base += ".nth(" + (loc.nth >= -1 ? Math.trunc(loc.nth) : 0) + ")";
  }
  return base;
}

function locatorBaseExpr(loc: Locator): string {
  switch (loc.k) {
    case "testid": {
      // Mirrors locatorBase in script-generator.ts: a testid on a non-default
      // attribute is emitted as an attribute selector, because getByTestId
      // resolves only data-testid.
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
      return "getByText(" + q(loc.v ?? "") + ")";
    case "xpath":
      return "locator(" + q("xpath=" + (loc.v ?? "")) + ")";
    case "css":
    default:
      return "locator(" + q(loc.v ?? "") + ")";
  }
}

/** Mirror of `describeVariableCheck` in main/services/script-generator.ts.
 *  Shared by the `variable` assert kind and the `variable` condition, because
 *  they are the same claim in two places. */
export function describeVariableCheck(step: Step): string {
  const name = step.captureVar || "variable";
  const op = step.compareOp ?? "eq";
  const label = COMPARE_OP_LABEL[op] ?? "equals";
  return name + " " + label + " " + JSON.stringify(step.value ?? "");
}

function describeAssert(step: Step, target: string | null): string {
  const e = step.soft ? "expect.soft" : "expect";
  const o = optsExpr(timeoutParts(step));
  // The page-level kinds build their pattern with the SHARED helper, off the
  // SHARED table, because this string is what the user reads in the step list
  // and the generator's is what actually runs. Those two disagreeing is the
  // worst version of this bug: a correct-looking assertion on screen standing
  // in for one that could never pass. See shared/step-semantics.mjs.
  if (step.assert === "url" || step.assert === "urlEndsWith" || step.assert === "urlIs") {
    const s = ASSERT_SEMANTICS[step.assert];
    if (!s || (step.value ?? "") === "") return "assert";
    return e + "(page).toHaveURL" + callArgs([textMatchExpr(step.value ?? "", s)], o);
  }
  if (step.assert === "urlPathIs") {
    if ((step.value ?? "") === "") return "assert";
    return e + "(page).toHaveURL" + callArgs([urlPathExpr(step.value ?? "")], o);
  }
  if (step.assert === "title") {
    if ((step.value ?? "") === "") return "assert";
    return e + "(page).toHaveTitle" + callArgs([q(step.value ?? "")], o);
  }
  if (step.assert === "titleContains") {
    const s = ASSERT_SEMANTICS.titleContains;
    if (!s || (step.value ?? "") === "") return "assert";
    return e + "(page).toHaveTitle" + callArgs([textMatchExpr(step.value ?? "", s)], o);
  }
  // Before the target check: the one assert kind that looks at nothing on the
  // page, so requiring a locator would describe every one of them as "assert".
  if (step.assert === "variable") return describeVariableCheck(step);
  if (!target) return "assert";
  const x = e + "(" + target + ")";
  switch (step.assert) {
    case "hidden":
      return x + ".toBeHidden" + callArgs([], o);
    case "text":
      return x + ".toContainText" + callArgs([q(step.text ?? "")], o);
    case "exactText":
      return x + ".toHaveText" + callArgs([q(step.text ?? "")], o);
    case "enabled":
      return x + ".toBeEnabled" + callArgs([], o);
    case "disabled":
      return x + ".toBeDisabled" + callArgs([], o);
    case "checked":
      return x + ".toBeChecked" + callArgs([], o);
    case "unchecked":
      return x + ".not.toBeChecked" + callArgs([], o);
    case "value":
      return x + ".toHaveValue" + callArgs([q(step.value ?? "")], o);
    case "attribute":
      return x + ".toHaveAttribute" + callArgs([q(step.attr ?? ""), q(step.value ?? "")], o);
    case "count":
      return x + ".toHaveCount" + callArgs([numExpr(step.count, 0)], o);
    case "css": {
      if (!isCssPropName(step.cssProp)) return "assert";
      const expected =
        step.cssMatch === "contains"
          ? "new RegExp(" + q(reEscape(step.value ?? "")) + ", \"i\")"
          : q(step.value ?? "");
      return x + ".toHaveCSS" + callArgs([q(step.cssProp), expected], o);
    }
    case "visible":
    default:
      return x + ".toBeVisible" + callArgs([], o);
  }
}

/** Readable phrasing of an `if` condition (mirror of script-generator.ts). */
export function describeCondition(step: Step): string {
  const loc = step.locator;
  const el = loc ? "page." + locatorExpr(loc) : "element";
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
 * Indentation level per step, so the trainer/detail list can visually nest the
 * body of a conditional block. `if` rows sit at the enclosing depth, their body
 * one level deeper, and `endif` closes back to the enclosing depth.
 */
export function computeStepDepths(steps: { type: StepType }[]): number[] {
  const depths: number[] = [];
  let d = 0;
  for (const s of steps) {
    if (s.type === "endif" || s.type === "endLoop" || s.type === "else" || s.type === "endGroup")
      d = Math.max(0, d - 1);
    depths.push(d);
    if (s.type === "if" || s.type === "loop" || s.type === "else" || s.type === "group") d += 1;
  }
  return depths;
}

/** Mirror of describeCookie in main/services/script-generator.ts — keep in sync. */
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

/** Mirror of describeCapture in main/services/script-generator.ts — keep in sync. */
export function describeCapture(step: Step): string {
  const name = step.captureVar || "variable";
  const from = step.captureFrom ?? "text";
  const loc = step.locator ? "page." + locatorExpr(step.locator) : "page";
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

/** Mirror of describeFlow in main/services/script-generator.ts — keep in sync. */
export function describeFlow(step: Step): string {
  const name = step.label || step.flowId || "flow";
  const entries = Object.entries(step.flowArgs ?? {});
  const args = entries.map(([k, v]) => `${k}=${v.length > 18 ? v.slice(0, 17) + "…" : v}`);
  const base =
    entries.length === 0 ? `run flow ${name}` : `run flow ${name} (${args.join(", ")})`;
  if (step.repeatVar) return `${base} ×\${${step.repeatVar}}`;
  return typeof step.repeat === "number" && step.repeat > 1 ? `${base} ×${step.repeat}` : base;
}

/** Mirror of describeWait in main/services/script-generator.ts — keep in sync.
 *
 *  Phrased rather than rendered as the generated call, because that call
 *  carries the `// wait until` parser marker and a `{ timeout: … }` options
 *  object that mean nothing to the user reading the step list. */
export function describeWait(step: Step): string {
  const loc = step.locator;
  const el = loc ? "page." + locatorExpr(loc) : "element";
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

/** Mirror of stateLine in main/services/script-generator.ts — keep in sync.
 *
 *  Rendered as the generated call rather than phrased (unlike a wait), because
 *  the call IS the explanation: `page.mouse.down()` with no target is exactly
 *  what the step does, and phrasing it as "press and hold" would hide that it
 *  presses wherever the preceding hover left the cursor. */
function describeState(step: Step, target: string | null): string {
  const state = step.elementState;
  if (!state || !ELEMENT_STATES.includes(state)) return "state";
  switch (state) {
    case "press":
      return "page.mouse.down()";
    case "release":
      return "page.mouse.up()";
    case "focus":
      return target ? target + ".focus()" : "state";
    case "hover":
    default:
      return target ? target + ".hover()" : "state";
  }
}

export function describeStep(step: Step): string {
  if (step.type === "if") return "if " + describeCondition(step);
  if (step.type === "endif") return "end if";
  if (step.type === "else") return "else";
  if (step.type === "loop") return "repeat " + (step.loopCount ?? 1) + " times";
  if (step.type === "endLoop") return "end repeat";
  // Mirror of the backend phrase — pinned by describe-step-parity.test.ts.
  if (step.type === "aiCheck") return `AI check: ${JSON.stringify(step.text ?? "")}`;
  if (step.type === "group") return "group: " + (step.label ?? "");
  if (step.type === "endGroup") return "end group";
  if (step.type === "teardown") return "teardown — everything below always runs";
  if (step.type === "dialog") {
    return step.dialogAction === "dismiss"
      ? "dismiss the next dialog"
      : "accept the next dialog" + (step.value ? ` with ${JSON.stringify(step.value)}` : "");
  }
  // Mirror of the backend phrase — pinned by describe-step-parity.test.ts.
  if (step.type === "a11y") {
    const impact =
      step.a11yImpact === "minor" ||
      step.a11yImpact === "moderate" ||
      step.a11yImpact === "critical"
        ? step.a11yImpact
        : "serious";
    return "check accessibility (fail on " + impact + " or worse)";
  }
  if (step.type === "upload") {
    const name = typeof step.value === "string" ? step.value.split("/").pop() ?? "" : "";
    return name ? `upload ${JSON.stringify(name)}` : "upload a file";
  }
  if (step.type === "api") {
    // Validated against the mirror allowlist, not printed raw — the backend
    // falls back to GET for a forged method and this copy must agree.
    const m =
      step.apiMethod && (API_METHODS as readonly string[]).includes(step.apiMethod)
        ? step.apiMethod
        : "GET";
    const base = `${m} ${step.url ?? ""}`.trim();
    const status = typeof step.expectStatus === "number" ? ` expecting ${Math.trunc(step.expectStatus)}` : "";
    const varOk =
      !!step.captureVar &&
      step.captureVar.length <= 40 &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(step.captureVar);
    const cap = varOk ? ` (response → ${step.captureVar})` : "";
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
    // Mirror of the backend's isValidVariableName gate (the backend is the
    // source of truth; this copy only decides display).
    const varOk =
      !!step.captureVar &&
      step.captureVar.length <= 40 &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(step.captureVar);
    return varOk ? base + ` (filename → ${step.captureVar})` : base;
  }
  if (step.type === "wait" && step.waitUntil) return describeWait(step);
  if (step.type === "cookie") return describeCookie(step);
  if (step.type === "capture") return describeCapture(step);
  if (step.type === "runFlow") return describeFlow(step);
  const loc = step.locator;
  const target = loc ? "page." + locatorExpr(loc) : null;
  switch (step.type) {
    case "goto":
      return "page.goto(" + q(step.url ?? "") + ")";
    case "click": {
      if (!target) return "click";
      // `force` is rendered here for the first time (2026-08-21). It was in the
      // generated call and not in the step list, so a step the user had marked
      // "skip actionability checks" read as an ordinary click on screen.
      return target + ".click(" + optsExpr([
        ...(step.force === true ? ["force: true"] : []),
        ...timeoutParts(step),
      ]) + ")";
    }
    case "fill": {
      if (!target) return "fill";
      if (step.typeMode === "sequential") {
        const delay = clampedMs(step.typeDelayMs, MAX_TYPE_DELAY_MS);
        return target + ".pressSequentially" + callArgs([q(step.value ?? "")], optsExpr([
          ...(delay === null ? [] : ["delay: " + String(delay)]),
          ...timeoutParts(step),
        ]));
      }
      return target + ".fill" + callArgs([q(step.value ?? "")], optsExpr(timeoutParts(step)));
    }
    case "select":
      return target
        ? target + ".selectOption" + callArgs([q(step.value ?? "")], optsExpr(timeoutParts(step)))
        : "select";
    case "check":
      return target ? target + ".check(" + optsExpr(timeoutParts(step)) + ")" : "check";
    case "uncheck":
      return target ? target + ".uncheck(" + optsExpr(timeoutParts(step)) + ")" : "uncheck";
    case "dblclick":
      // The bare TYPE NAME when there is no element, matching the `click` case
      // above and the backend's own fallback. Prose here ("double-click") read
      // as a different step from the backend's "dblclick" in exactly the place
      // the two lists sit side by side.
      return target ? target + ".dblclick(" + optsExpr(timeoutParts(step)) + ")" : "dblclick";
    case "rightclick":
      return target
        ? target +
            ".click(" +
            optsExpr([
              'button: "right"',
              ...(step.force === true ? ["force: true"] : []),
              ...timeoutParts(step),
            ]) +
            ")"
        : "rightclick";
    case "drag":
      return target && step.toLocator
        ? target + ".dragTo" + callArgs(["page." + locatorExpr(step.toLocator)], optsExpr(timeoutParts(step)))
        : "drag";
    case "reload":
      return "page.reload(" + optsExpr(timeoutParts(step)) + ")";
    case "echo":
      return "echo " + JSON.stringify(step.text ?? step.value ?? "");
    case "press":
      return target
        ? target + ".press" + callArgs([q(step.value ?? "")], optsExpr(timeoutParts(step)))
        // "page." prefix matters: the generated spec emits
        // await page.keyboard.press(...), and the backend's describeStep
        // (script-generator.ts) says so too. Dropping it made the trainer's
        // step list disagree with run logs for the same step.
        //
        // No timeout either: page.keyboard.press has no such option, because
        // there is no element to wait for.
        : "page.keyboard.press(" + q(step.value ?? "") + ")";
    case "wait":
      if (typeof step.waitMs === "number") return "page.waitForTimeout(" + step.waitMs + ")";
      return target ? target + ".waitFor()" : "wait";
    case "viewport":
      return "page.setViewportSize({ width: " + (step.width ?? 1280) + ", height: " + (step.height ?? 800) + " })";
    case "scroll":
      // Element mode reads like the emitted line; position mode is a phrase,
      // because the emitted glazeScrollTo(...) names the mechanism rather than
      // the intent. Kept in sync with describeStep in
      // main/services/script-generator.ts — pinned by describe-step-parity.
      // typeof-checked like the backend's num(): a stored step can carry a
      // forged string in a numeric field, and it must not reach UI copy.
      return target
        ? target + ".scrollIntoViewIfNeeded()"
        : "scroll to (" +
            (typeof step.scrollX === "number" && Number.isFinite(step.scrollX) ? Math.trunc(step.scrollX) : 0) +
            ", " +
            (typeof step.scrollY === "number" && Number.isFinite(step.scrollY) ? Math.trunc(step.scrollY) : 0) +
            ")";
    case "assert":
      return describeAssert(step, target);
    case "state":
      return describeState(step, target);
    default:
      return step.type;
  }
}
