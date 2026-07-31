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

function stepLine(step: Step): string | null {
  const loc = step.locator;
  const target = loc ? "page." + locatorExpr(loc) : null;
  switch (step.type) {
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
  const line = stepLine(step);
  return line ? line.replace(/^await /, "").replace(/;$/, "") : step.type;
}

export function generateSpec(record: Pick<TestRecord, "name" | "url" | "steps">): string {
  const body: string[] = [];
  for (const step of record.steps) {
    const line = stepLine(step);
    if (line) body.push("  " + line);
  }
  const title = record.name && record.name.trim() ? record.name.trim() : "recorded test";
  return (
    'import { test, expect } from "@playwright/test";\n\n' +
    "test(" + q(title) + ", async ({ page }) => {\n" +
    body.join("\n") +
    "\n});\n"
  );
}
