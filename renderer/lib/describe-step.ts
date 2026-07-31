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
