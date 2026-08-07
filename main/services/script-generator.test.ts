// Tests for the generated spec's line→step map.
//
// This map decides which step the UI highlights while a run is executing, and
// which step each captured screenshot is attributed to. Both failures are
// silent: nothing errors, the run still passes or fails correctly, and the user
// simply sees the wrong row lit up and a screenshot filed under the wrong step.
// It cost real debugging time before, which is why the generator now emits the
// map instead of the runner inferring it by counting `await` lines.
//
// The cases below are exactly the ones a counting heuristic gets wrong.

import { describe, expect, it } from "vitest";

import { generateSpecDetailed, type FlowSource } from "./script-generator.js";
import type { Step, TestVariable } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

/** The step index each 1-based spec line maps to, as an ordered list of
 *  [lineText, stepIndex] pairs — easier to read in a failure than raw numbers. */
function mappedLines(source: string, lineMap: Record<number, number>): [string, number][] {
  const lines = source.split("\n");
  return Object.entries(lineMap)
    .map(([line, index]) => [lines[Number(line) - 1].trim(), index] as [string, number])
    .sort((a, b) => a[1] - b[1]);
}

describe("generateSpecDetailed line map", () => {
  it("maps each plain step's line to its own index", () => {
    const steps = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "click", locator: { k: "testid", v: "a" } }),
      step({ type: "click", locator: { k: "testid", v: "b" } }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(mappedLines(source, lineMap)).toEqual([
      ['await page.goto("https://example.com");', 0],
      ['await page.getByTestId("a").click();', 1],
      ['await page.getByTestId("b").click();', 2],
    ]);
  });

  it("keeps steps after an `if` block aligned", () => {
    // An `if` emits `if (...) {`, which has no leading `await` — a counting
    // heuristic skips it and shifts every following step down by one.
    const steps = [
      step({ type: "if", cond: "visible", locator: { k: "testid", v: "banner" } }),
      step({ type: "click", locator: { k: "testid", v: "dismiss" } }),
      step({ type: "endif" }),
      step({ type: "click", locator: { k: "testid", v: "checkout" } }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    const mapped = mappedLines(source, lineMap);
    expect(mapped).toContainEqual(['await page.getByTestId("dismiss").click();', 1]);
    // The step AFTER the block is index 3, not 2.
    expect(mapped).toContainEqual(['await page.getByTestId("checkout").click();', 3]);
  });

  it("keeps steps after a variable header aligned", () => {
    // The `const V = {...}` header adds lines above the body. An off-by-one in
    // the preamble arithmetic mis-attributes every step in the test.
    const variables: TestVariable[] = [
      { name: "email", kind: "plain", value: "a@b.com" },
      { name: "password", kind: "secret" },
    ];
    const steps = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "fill", locator: { k: "label", v: "Email" }, value: "${email}" }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps, variables });
    expect(mappedLines(source, lineMap)).toEqual([
      ['await page.goto("https://example.com");', 0],
      ["await page.getByLabel(\"Email\").fill(V.email);", 1],
    ]);
  });

  it("attributes every line of an inlined flow to the runFlow step", () => {
    // One step produces several lines. A counting heuristic would treat each as
    // its own step and shift everything after the flow by the flow's length.
    const flow: FlowSource = {
      id: "f1",
      name: "Login",
      flowParams: [],
      steps: [
        step({ type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.com" }),
        step({ type: "click", locator: { k: "role", role: "button", name: "Log in" } }),
      ],
    };
    const steps = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "runFlow", flowId: "f1", label: "Login" }),
      step({ type: "click", locator: { k: "testid", v: "checkout" } }),
    ];
    const { source, lineMap } = generateSpecDetailed(
      { name: "t", url: "u", steps },
      { resolveFlow: (id) => (id === "f1" ? flow : null) },
    );
    const mapped = mappedLines(source, lineMap);
    // Both inlined lines point at the runFlow step the user can actually see.
    expect(mapped.filter(([, index]) => index === 1)).toHaveLength(2);
    // And the step after the flow keeps its own index.
    expect(mapped).toContainEqual(['await page.getByTestId("checkout").click();', 2]);
  });

  it("keeps steps after a capture step aligned", () => {
    // A capture step adds an import line to the preamble AND emits a call that
    // isn't a page/locator action. Both shift the body.
    const steps = [
      step({ type: "goto", url: "https://example.com" }),
      step({
        type: "capture",
        locator: { k: "testid", v: "order" },
        captureVar: "orderId",
        captureFrom: "text",
      }),
      step({ type: "click", locator: { k: "testid", v: "done" } }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(mappedLines(source, lineMap)).toEqual([
      ['await page.goto("https://example.com");', 0],
      ['await glazeCapture(V, "orderId", page.getByTestId("order"), "text");', 1],
      ['await page.getByTestId("done").click();', 2],
    ]);
  });

  it("does not map a disabled step's commented-out line", () => {
    // A disabled step never executes, so no reporter marker ever arrives for
    // it. Mapping its line would be harmless but misleading; leaving it out
    // keeps the map to lines that can actually run.
    const steps = [
      step({ type: "click", locator: { k: "testid", v: "a" }, disabled: true }),
      step({ type: "click", locator: { k: "testid", v: "b" } }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(mappedLines(source, lineMap)).toEqual([
      ['await page.getByTestId("b").click();', 1],
    ]);
  });

  it("maps a continue-on-failure step to the line inside its try block", () => {
    const steps = [
      step({ type: "click", locator: { k: "testid", v: "a" }, continueOnFailure: true }),
      step({ type: "click", locator: { k: "testid", v: "b" } }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(mappedLines(source, lineMap)).toEqual([
      ['await page.getByTestId("a").click();', 0],
      ['await page.getByTestId("b").click();', 1],
    ]);
  });
});

describe("viewport steps log the resize", () => {
  // A resize is the only recorded action with no visible effect in the run
  // output — every other step names its target ("click getByRole(...)"). Without
  // a log line, a run that fails at a responsive breakpoint gives no evidence
  // that the page was resized at all, let alone to what.

  /** Body lines of the generated spec, trimmed, in order. */
  function bodyLines(source: string): string[] {
    return source
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  it("emits a log statement after the resize", () => {
    const steps = [step({ type: "viewport", width: 390, height: 844 })];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    const lines = bodyLines(source);
    const at = lines.indexOf("await page.setViewportSize({ width: 390, height: 844 });");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toContain("console.log(");
    expect(lines[at + 1]).toContain("390x844");
  });

  it("reports the APPLIED viewport, not an echo of the requested one", () => {
    // page.viewportSize() is read back after the call. An echo of the numbers
    // already on the line above would assert the very thing worth checking.
    const steps = [step({ type: "viewport", width: 390, height: 844 })];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(source).toContain("page.viewportSize()");
  });

  it("does not await the log line", () => {
    // `buildStepLineMap` (the fallback for hand-edited specs) classifies steps
    // by counting leading-`await` lines. An awaited log line would shift every
    // later step's highlight and screenshot attribution by one.
    const steps = [step({ type: "viewport", width: 390, height: 844 })];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    const log = bodyLines(source).find((l) => l.includes("console.log("));
    expect(log?.startsWith("await ")).toBe(false);
  });

  it("keeps the step mapped to its setViewportSize line, not the log line", () => {
    const steps = [
      step({ type: "viewport", width: 390, height: 844 }),
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "click", locator: { k: "testid", v: "a" } }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(mappedLines(source, lineMap)).toEqual([
      ["await page.setViewportSize({ width: 390, height: 844 });", 0],
      ['await page.goto("https://example.com");', 1],
      ['await page.getByTestId("a").click();', 2],
    ]);
  });

  it("comments out the log line too when the step is disabled", () => {
    // A disabled resize that still logged would report a size change that
    // never happened — the most misleading line the run could produce.
    const steps = [step({ type: "viewport", width: 390, height: 844, disabled: true })];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    const log = bodyLines(source).find((l) => l.includes("console.log("));
    expect(log).toMatch(/^\/\/ disabled/);
  });

  it("puts the log line inside the try when the step continues on failure", () => {
    // Outside the try, a resize that THREW would still log the size it never
    // reached, because page.viewportSize() reports the old one.
    const steps = [step({ type: "viewport", width: 390, height: 844, continueOnFailure: true })];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    const lines = bodyLines(source);
    const log = lines.findIndex((l) => l.includes("console.log("));
    const close = lines.findIndex((l) => l.startsWith("} catch"));
    expect(log).toBeGreaterThan(lines.findIndex((l) => l === "try {"));
    expect(log).toBeLessThan(close);
  });

  it("emits no log line for steps that aren't resizes", () => {
    const steps = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "click", locator: { k: "testid", v: "a" } }),
      step({ type: "wait", waitMs: 500 }),
    ];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(source).not.toContain("console.log(");
  });

  it("cannot be poisoned into running code from the log line either", () => {
    // The same hole the numeric fields had: the log line concatenates width and
    // height into source text, so it goes through num() like everything else.
    const steps = [
      { id: "s", timestamp: 0, type: "viewport", width: "0}); evil(); ({", height: 800 },
    ] as unknown as Step[];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(source).not.toContain("evil(");
    expect(source).toContain("1280x800");
  });
});
