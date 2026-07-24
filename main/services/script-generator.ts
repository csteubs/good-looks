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
    case "css":
    default:
      return "locator(" + q(loc.v ?? "") + ")";
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
    case "assert":
      if (!target) return null;
      return step.assert === "text"
        ? "await expect(" + target + ").toContainText(" + q(step.text ?? "") + ");"
        : "await expect(" + target + ").toBeVisible();";
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
