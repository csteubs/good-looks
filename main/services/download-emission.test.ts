// Download steps: the two-line shape and why the order is the feature.
//
// Playwright's own docs bless exactly one download idiom: arm the
// waitForEvent PROMISE before the triggering action, await it after. A
// listener attached after the click races the event it exists to catch —
// sometimes winning on a slow server, always losing on a fast one, which is
// flake by construction. So a `download` step emits in two halves around its
// trigger, and everything else here (numbering, scoping, pairing on the way
// back in) exists to keep those halves a unit.

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpec, parseSpecDetailed } from "./spec-parser.js";
import type { Step } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

const CLICK = (v = "export") => step({ type: "click", locator: { k: "testid", v } });

function gen(steps: Step[], variables?: { name: string; kind: "plain"; value?: string }[]): string {
  return generateSpec({
    name: "t",
    url: "https://x.test",
    steps,
    ...(variables ? { variables } : {}),
  } as Parameters<typeof generateSpec>[0]);
}

function shape(steps: Step[]): unknown[] {
  return steps.map(({ id: _i, timestamp: _t, ...rest }) => rest);
}

describe("emission", () => {
  it("arms before the trigger and awaits after it", () => {
    const src = gen([CLICK(), step({ type: "download", value: "report.csv" })]);
    const lines = src.split("\n").map((l) => l.trim());
    const arm = lines.findIndex((l) =>
      l.startsWith('const download1 = page.waitForEvent("download"'),
    );
    const click = lines.findIndex((l) => l.includes('getByTestId("export").click()'));
    const wait = lines.findIndex((l) => l.startsWith("{ const d1 = await download1;"));
    expect(arm).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(click);
    expect(click).toBeLessThan(wait);
    expect(lines[wait]).toContain('expect(d1.suggestedFilename()).toContain("report.csv");');
  });

  it("matches exactly when the step says so, and skips the assert on an empty value", () => {
    const exact = gen([CLICK(), step({ type: "download", value: "a.pdf", downloadMatch: "exact" })]);
    expect(exact).toContain('.toBe("a.pdf");');
    const any = gen([CLICK(), step({ type: "download" })]);
    expect(any).toContain("{ const d1 = await download1; }");
    expect(any).not.toContain("suggestedFilename()).to");
  });

  it("saves the filename into V when asked, and refuses a non-identifier name", () => {
    const src = gen([CLICK(), step({ type: "download", captureVar: "exportName" })]);
    expect(src).toContain("V.exportName = d1.suggestedFilename();");
    // The V header exists even with zero declared variables.
    expect(src).toContain("const V");
    const hostile = gen([
      CLICK(),
      { id: "x", timestamp: 0, type: "download", captureVar: "x = 1; evil(); //" } as unknown as Step,
    ]);
    expect(hostile).not.toContain("evil");
  });

  it("numbers several downloads in order, each armed at its own trigger", () => {
    const src = gen([
      CLICK("one"),
      step({ type: "download", value: "a.csv" }),
      CLICK("two"),
      step({ type: "download", value: "b.csv" }),
    ]);
    const lines = src.split("\n").map((l) => l.trim());
    const arm1 = lines.findIndex((l) => l.startsWith("const download1"));
    const one = lines.findIndex((l) => l.includes('"one"'));
    const arm2 = lines.findIndex((l) => l.startsWith("const download2"));
    const two = lines.findIndex((l) => l.includes('"two"'));
    expect(arm1).toBeLessThan(one);
    expect(one).toBeLessThan(arm2);
    expect(arm2).toBeLessThan(two);
  });

  it("arms outside a continue-on-failure trigger's try, so the await can still see it", () => {
    const src = gen([
      step({ type: "click", locator: { k: "testid", v: "export" }, continueOnFailure: true }),
      step({ type: "download", value: "a.csv" }),
    ]);
    const lines = src.split("\n").map((l) => l.trim());
    const arm = lines.findIndex((l) => l.startsWith("const download1"));
    const tryAt = lines.findIndex((l) => l === "try {");
    expect(arm).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(tryAt);
  });

  it("falls back to arming in place after a structural step", () => {
    // The download's previous entry is `endif` — arming before it would put
    // the const inside a block the await cannot see. In place still awaits
    // honestly against the timeout.
    const src = gen([
      step({ type: "if", cond: "visible", locator: { k: "testid", v: "x" } }),
      CLICK(),
      step({ type: "endif" }),
      step({ type: "download", value: "a.csv" }),
    ]);
    const lines = src.split("\n").map((l) => l.trim());
    const arm = lines.findIndex((l) => l.startsWith("const download1"));
    const wait = lines.findIndex((l) => l.startsWith("{ const d1"));
    const endifClose = lines.lastIndexOf("}", wait);
    expect(arm).toBe(wait - 1);
    expect(arm).toBeGreaterThan(endifClose - 1);
  });

  it("re-arms per iteration inside a loop", () => {
    const src = gen([
      step({ type: "loop", loopCount: 3 }),
      CLICK(),
      step({ type: "download", value: "a.csv" }),
      step({ type: "endLoop" }),
    ]);
    const lines = src.split("\n");
    const arm = lines.find((l) => l.includes("const download1"))!;
    const forLine = lines.find((l) => l.includes("for (let i"))!;
    // Indented one deeper than the for — inside the loop body, so every
    // iteration arms its own promise.
    expect(arm.match(/^ */)![0].length).toBe(forLine.match(/^ */)![0].length + 2);
  });

  it("interpolates a declared variable into the expected filename", () => {
    const src = gen(
      [CLICK(), step({ type: "download", value: "${reportName}" })],
      [{ name: "reportName", kind: "plain", value: "q3.pdf" }],
    );
    expect(src).toContain(".toContain(V.reportName);");
  });

  it("comments a disabled download whole — no arming, no await", () => {
    const src = gen([CLICK(), step({ type: "download", value: "a.csv", disabled: true })]);
    expect(src).not.toContain("waitForEvent");
    expect(src).toContain('// disabled — skipped: expect download containing "a.csv"');
  });
});

describe("round-trip", () => {
  it("reads its own emission back in every dressing", () => {
    const steps = [
      CLICK(),
      step({ type: "download", value: "report.csv" }),
      CLICK("two"),
      step({ type: "download", value: "a.pdf", downloadMatch: "exact", captureVar: "got" }),
      CLICK("three"),
      step({ type: "download", timeoutMs: 30000 }),
    ];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });

  it("round-trips a continue-on-failure download through the try recursion", () => {
    const steps = [
      CLICK(),
      step({ type: "download", value: "a.csv", continueOnFailure: true }),
    ];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });

  it("regeneration is a fixed point", () => {
    const steps = [
      CLICK(),
      step({ type: "download", value: "report.csv", captureVar: "name" }),
    ];
    const once = gen(steps);
    const again = gen(parseSpec(once));
    expect(again).toBe(once);
  });

  it("an awaiting block with no arming is foreign, and counts as skipped", () => {
    const src = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("t", async ({ page }) => {',
      "  { const d1 = await download1; }",
      '  await page.getByTestId("after").click();',
      "});",
    ].join("\n");
    const { steps, skipped } = parseSpecDetailed(src);
    expect(skipped).toBeGreaterThan(0);
    expect(steps.every((s) => s.type !== "download")).toBe(true);
  });
});
