// Renders a recorded step as the Playwright call it will generate (without the
// leading `await`/trailing `;`), for display in the UI. Mirrors the backend
// script generator so what the user sees matches the generated script.

import type { Locator, Step, StepType } from "./recorder-types";

function q(s: string): string {
  return JSON.stringify(s ?? "");
}

/** Escape regex metacharacters so a literal string can be embedded in a RegExp. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function locatorExpr(loc: Locator): string {
  switch (loc.k) {
    case "testid":
      return "getByTestId(" + q(loc.v ?? "") + ")";
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

function describeAssert(step: Step, target: string | null): string {
  const e = step.soft ? "expect.soft" : "expect";
  if (step.assert === "url") return e + "(page).toHaveURL(" + q(step.value ?? "") + ")";
  if (step.assert === "urlEndsWith")
    return e + "(page).toHaveURL(new RegExp(" + q(reEscape(step.value ?? "") + "$") + ", \"i\"))";
  if (step.assert === "urlIs")
    return e + "(page).toHaveURL(new RegExp(" + q("^" + reEscape(step.value ?? "") + "$") + ", \"i\"))";
  if (step.assert === "title") return e + "(page).toHaveTitle(" + q(step.value ?? "") + ")";
  if (!target) return "assert";
  const x = e + "(" + target + ")";
  switch (step.assert) {
    case "hidden":
      return x + ".toBeHidden()";
    case "text":
      return x + ".toContainText(" + q(step.text ?? "") + ")";
    case "exactText":
      return x + ".toHaveText(" + q(step.text ?? "") + ")";
    case "enabled":
      return x + ".toBeEnabled()";
    case "disabled":
      return x + ".toBeDisabled()";
    case "checked":
      return x + ".toBeChecked()";
    case "unchecked":
      return x + ".not.toBeChecked()";
    case "value":
      return x + ".toHaveValue(" + q(step.value ?? "") + ")";
    case "attribute":
      return x + ".toHaveAttribute(" + q(step.attr ?? "") + ", " + q(step.value ?? "") + ")";
    case "count":
      return x + ".toHaveCount(" + (step.count ?? 0) + ")";
    case "visible":
    default:
      return x + ".toBeVisible()";
  }
}

/** Readable phrasing of an `if` condition (mirror of script-generator.ts). */
export function describeCondition(step: Step): string {
  const loc = step.locator;
  const el = loc ? "page." + locatorExpr(loc) : "element";
  switch (step.cond) {
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
    if (s.type === "endif") d = Math.max(0, d - 1);
    depths.push(d);
    if (s.type === "if") d += 1;
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

export function describeStep(step: Step): string {
  if (step.type === "if") return "if " + describeCondition(step);
  if (step.type === "endif") return "end if";
  if (step.type === "cookie") return describeCookie(step);
  const loc = step.locator;
  const target = loc ? "page." + locatorExpr(loc) : null;
  switch (step.type) {
    case "goto":
      return "page.goto(" + q(step.url ?? "") + ")";
    case "click":
      return target ? target + ".click()" : "click";
    case "fill":
      return target ? target + ".fill(" + q(step.value ?? "") + ")" : "fill";
    case "select":
      return target ? target + ".selectOption(" + q(step.value ?? "") + ")" : "select";
    case "check":
      return target ? target + ".check()" : "check";
    case "uncheck":
      return target ? target + ".uncheck()" : "uncheck";
    case "press":
      return target
        ? target + ".press(" + q(step.value ?? "") + ")"
        // "page." prefix matters: the generated spec emits
        // await page.keyboard.press(...), and the backend's describeStep
        // (script-generator.ts) says so too. Dropping it made the trainer's
        // step list disagree with run logs for the same step.
        : "page.keyboard.press(" + q(step.value ?? "") + ")";
    case "wait":
      if (typeof step.waitMs === "number") return "page.waitForTimeout(" + step.waitMs + ")";
      return target ? target + ".waitFor()" : "wait";
    case "viewport":
      return "page.setViewportSize({ width: " + (step.width ?? 1280) + ", height: " + (step.height ?? 800) + " })";
    case "assert":
      return describeAssert(step, target);
    default:
      return step.type;
  }
}
