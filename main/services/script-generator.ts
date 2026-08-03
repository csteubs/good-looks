// Convert recorded steps into a @playwright/test spec file.

import type { Locator, Step, TestRecord } from "../recorder/types.js";

function q(s: string): string {
  return JSON.stringify(s ?? "");
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

function assertLine(step: Step, target: string | null): string | null {
  const e = step.soft ? "expect.soft" : "expect";
  // Page-level assertions don't need an element locator.
  if (step.assert === "url") return "await " + e + "(page).toHaveURL(" + q(step.value ?? "") + ");";
  if (step.assert === "title") return "await " + e + "(page).toHaveTitle(" + q(step.value ?? "") + ");";
  if (!target) return null;
  const x = e + "(" + target + ")";
  switch (step.assert) {
    case "hidden":
      return "await " + x + ".toBeHidden();";
    case "text":
      return "await " + x + ".toContainText(" + q(step.text ?? "") + ");";
    case "exactText":
      return "await " + x + ".toHaveText(" + q(step.text ?? "") + ");";
    case "enabled":
      return "await " + x + ".toBeEnabled();";
    case "disabled":
      return "await " + x + ".toBeDisabled();";
    case "checked":
      return "await " + x + ".toBeChecked();";
    case "unchecked":
      return "await " + x + ".not.toBeChecked();";
    case "value":
      return "await " + x + ".toHaveValue(" + q(step.value ?? "") + ");";
    case "attribute":
      return "await " + x + ".toHaveAttribute(" + q(step.attr ?? "") + ", " + q(step.value ?? "") + ");";
    case "count":
      return "await " + x + ".toHaveCount(" + (step.count ?? 0) + ");";
    case "visible":
    default:
      return "await " + x + ".toBeVisible();";
  }
}

/** Build the boolean expression for an `if` step's condition. */
function conditionExpr(step: Step): string {
  const loc = step.locator;
  const target = loc ? "page." + locatorExpr(loc) : "page.locator(\"html\")";
  switch (step.cond) {
    case "urlContains":
      return "page.url().includes(" + q(step.value ?? "") + ")";
    case "titleContains":
      return "(await page.title()).includes(" + q(step.value ?? "") + ")";
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

function stepLine(step: Step): string | null {
  const loc = step.locator;
  const target = loc ? "page." + locatorExpr(loc) : null;
  switch (step.type) {
    case "if":
      return "if (" + conditionExpr(step) + ") {";
    case "endif":
      return "}";
    case "goto":
      return "await page.goto(" + q(step.url ?? "") + ");";
    case "click":
      return target ? "await " + target + ".click();" : null;
    case "fill":
      return target ? "await " + target + ".fill(" + q(step.value ?? "") + ");" : null;
    case "select":
      return target ? "await " + target + ".selectOption(" + q(step.value ?? "") + ");" : null;
    case "check":
      return target ? "await " + target + ".check();" : null;
    case "uncheck":
      return target ? "await " + target + ".uncheck();" : null;
    case "press":
      return target
        ? "await " + target + ".press(" + q(step.value ?? "") + ");"
        : "await page.keyboard.press(" + q(step.value ?? "") + ");";
    case "wait":
      if (typeof step.waitMs === "number") return "await page.waitForTimeout(" + step.waitMs + ");";
      return target ? "await " + target + ".waitFor();" : null;
    case "viewport":
      return (
        "await page.setViewportSize({ width: " +
        (step.width ?? 1280) +
        ", height: " +
        (step.height ?? 800) +
        " });"
      );
    case "assert":
      return assertLine(step, target);
    default:
      return null;
  }
}

/** Short human description of a step for the UI. */
export function describeStep(step: Step): string {
  if (step.type === "if") return "if " + describeCondition(step);
  if (step.type === "endif") return "end if";
  const line = stepLine(step);
  return line ? line.replace(/^await /, "").replace(/;$/, "") : step.type;
}

/** Readable phrasing of an `if` condition for the trainer's step list. */
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

export function generateSpec(record: Pick<TestRecord, "name" | "url" | "steps">): string {
  const body: string[] = [];
  // Track block nesting so conditional bodies are indented one level deeper.
  let depth = 1; // base level: statements sit inside the test() callback
  for (const step of record.steps) {
    const line = stepLine(step);
    if (line == null) continue;
    if (step.type === "endif") depth = Math.max(1, depth - 1);
    body.push("  ".repeat(depth) + line);
    if (step.type === "if") depth += 1;
  }
  const title = record.name && record.name.trim() ? record.name.trim() : "recorded test";
  return (
    'import { test, expect } from "@playwright/test";\n\n' +
    "test(" + q(title) + ", async ({ page }) => {\n" +
    body.join("\n") +
    "\n});\n"
  );
}
