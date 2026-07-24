// Renders a recorded step as the Playwright call it will generate (without the
// leading `await`/trailing `;`), for display in the UI. Mirrors the backend
// script generator so what the user sees matches the generated script.

import type { Locator, Step } from "./recorder-types";

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

export function describeStep(step: Step): string {
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
        : "keyboard.press(" + q(step.value ?? "") + ")";
    case "assert":
      if (!target) return "assert";
      return step.assert === "text"
        ? "expect(" + target + ").toContainText(" + q(step.text ?? "") + ")"
        : "expect(" + target + ").toBeVisible()";
    default:
      return step.type;
  }
}
