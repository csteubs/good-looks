import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ScriptOutlinePanel } from "./script-outline-panel";
import type { Step, TestRecord } from "../lib/recorder-types";

const SCRIPT = 'import { test } from "@playwright/test";\ntest("t", async ({ page }) => {\n  await page.goto("https://a.example");\n  await page.getByRole("button", { name: "Go" }).click();\n});\n';
const steps: Step[] = [
  { id: "a", type: "goto", url: "https://a.example", timestamp: 0 },
  { id: "b", type: "click", locator: { k: "role", role: "button", name: "Go" }, timestamp: 0 },
];
const ranges = [
  { from: SCRIPT.indexOf("  await page.goto"), to: SCRIPT.indexOf('");\n  await page.getByRole') + 3 },
  { from: SCRIPT.indexOf("  await page.getByRole"), to: SCRIPT.indexOf("click();") + 8 },
];
const library = [
  { id: "t1", name: "This", url: "u", steps } as unknown as TestRecord,
  { id: "t2", name: "Other", url: "u", steps: [{ id: "c", type: "click", locator: { k: "role", role: "button", name: "Go" }, timestamp: 0 }] } as unknown as TestRecord,
];

function mount(caretIndex: number | null) {
  const onJump = vi.fn();
  const onOpen = vi.fn();
  const onClose = vi.fn();
  render(
    <ScriptOutlinePanel steps={steps} stepRanges={ranges} script={SCRIPT} caretIndex={caretIndex} tests={library} currentTestId="t1" onJumpToLine={onJump} onOpenTest={onOpen} onClose={onClose} />,
  );
  return { onJump, onOpen, onClose };
}

describe("<ScriptOutlinePanel />", () => {
  it("lists the steps with their lines, marks the caret's, and a click jumps", () => {
    const { onJump } = mount(1);
    const list = screen.getByRole("list", { name: "Steps" });
    expect(list.textContent).toContain("L3");
    expect(list.textContent).toContain("L4");
    const rows = screen.getAllByRole("button", { name: /./ }).filter((b) => b.className === "gl-script-outline-row");
    expect(rows[1].getAttribute("aria-current")).toBe("true");
    fireEvent.click(rows[0]);
    expect(onJump).toHaveBeenCalledWith(3);
  });

  it("the filter narrows the list and Enter jumps to the first match", () => {
    const { onJump, onClose } = mount(null);
    const filter = screen.getByLabelText("Filter steps");
    fireEvent.change(filter, { target: { value: "click" } });
    expect(screen.getByText("1 of 2 steps")).toBeTruthy();
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onJump).toHaveBeenCalledWith(4);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows where the caret's locator is used elsewhere, and opens that test", () => {
    const { onOpen } = mount(1);
    expect(screen.getByText("This locator is used in 1 other step:")).toBeTruthy();
    const usages = screen.getByRole("list", { name: "Usages" });
    expect(usages.textContent).toContain("Other");
    fireEvent.click(usages.querySelector("button") as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith("t2");
  });

  it("says so when the caret's step has a locator used nowhere else, and shows no usages without a locator", () => {
    mount(0);
    expect(screen.queryByText(/This locator/)).toBeNull();
  });
});
