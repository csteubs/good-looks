// Input fidelity: how a fill delivers its text, how long a step is allowed to
// take, and the reload step.
//
// Three features that share one mechanism — the trailing options object — so
// they share one test file. What is being pinned in every case is the pair:
// what the generator EMITS and what the parser reads back, because an option
// that emits but does not round-trip is worse than one that never existed. It
// disappears on the next hand edit, and the step goes back to looking exactly
// like the one the user was trying to change.

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpec, parseSpecDetailed } from "./spec-parser.js";
import { normalizeRawStep, MAX_TYPE_DELAY_MS } from "../recorder/types.js";
import { LOCATOR_ACTIONS, PAGE_ACTIONS } from "./page-actions.js";
import type { Step } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

function gen(steps: Step[]): string {
  return generateSpec({ name: "t", url: "https://x.test", steps } as Parameters<
    typeof generateSpec
  >[0]);
}

function shape(steps: Step[]): unknown[] {
  return steps.map(({ id: _i, timestamp: _t, ...rest }) => rest);
}

/** Generate, parse back, and regenerate — the property that actually matters.
 *  A step that survives one direction but not the other still loses its
 *  option, just one edit later. */
function roundTrip(steps: Step[]): { steps: Step[]; source: string; again: string } {
  const source = gen(steps);
  const parsed = parseSpecDetailed(source);
  return { steps: parsed.steps as Step[], source, again: gen(parsed.steps as Step[]) };
}

const FIELD = { k: "label" as const, v: "City" };

describe("typing mode", () => {
  it("emits fill() by default, exactly as it always has", () => {
    const src = gen([step({ type: "fill", locator: FIELD, value: "London" })]);
    expect(src).toContain('await page.getByLabel("City").fill("London");');
    expect(src).not.toContain("pressSequentially");
  });

  it("emits pressSequentially for the per-character mode", () => {
    const src = gen([
      step({ type: "fill", locator: FIELD, value: "Lon", typeMode: "sequential" }),
    ]);
    expect(src).toContain('await page.getByLabel("City").pressSequentially("Lon");');
  });

  it("carries a delay when one is set", () => {
    const src = gen([
      step({ type: "fill", locator: FIELD, value: "Lon", typeMode: "sequential", typeDelayMs: 40 }),
    ]);
    expect(src).toContain('.pressSequentially("Lon", { delay: 40 });');
  });

  it("emits it on the SPEC LINE rather than through a runtime helper", () => {
    // Not a style preference. The step reporter drops any action whose
    // location is outside the spec file (see step-reporter-source.ts), so a
    // fill delivered from inside glaze-runtime.mjs would be reported by
    // nothing on a plain run and the progress bar would stall on the step
    // before it.
    const src = gen([
      step({ type: "fill", locator: FIELD, value: "Lon", typeMode: "sequential" }),
    ]);
    expect(src).not.toContain("glazeType");
    expect(src).not.toContain("glaze-runtime.mjs");
  });

  it("is a patched action in both run-time fixtures", () => {
    // An action nothing wraps takes no screenshot and emits no step marker, so
    // on a capture or crawl run the step would be invisible to the progress
    // bar and have no visual baseline. `fill` is on this list for exactly the
    // same reason.
    expect(LOCATOR_ACTIONS).toContain("pressSequentially");
    expect(LOCATOR_ACTIONS).toContain("fill");
  });

  it("interpolates a variable the same way an ordinary fill does", () => {
    const src = generateSpec({
      name: "t",
      url: "https://x.test",
      steps: [step({ type: "fill", locator: FIELD, value: "${city}", typeMode: "sequential" })],
      variables: [{ name: "city", kind: "plain", value: "London" }],
    } as unknown as Parameters<typeof generateSpec>[0]);
    // A value that is nothing but one reference emits the bare `V.name`, the
    // same shape an ordinary fill produces — the mode changes the METHOD, not
    // how the value is rendered.
    expect(src).toContain(".pressSequentially(V.city);");
  });

  it("round-trips, including the delay", () => {
    const original = [
      step({ type: "fill", locator: FIELD, value: "Lon", typeMode: "sequential", typeDelayMs: 40 }),
    ];
    const { steps, source, again } = roundTrip(original);
    expect(shape(steps)).toEqual([
      { type: "fill", locator: FIELD, value: "Lon", typeMode: "sequential", typeDelayMs: 40 },
    ]);
    expect(again).toBe(source);
  });

  it("a plain fill round-trips WITHOUT growing a typeMode", () => {
    // The default has to read back as absence, not as `typeMode: "fill"` —
    // otherwise every fill in the library changes shape the first time its
    // spec is parsed.
    const { steps } = roundTrip([step({ type: "fill", locator: FIELD, value: "London" })]);
    expect(shape(steps)).toEqual([{ type: "fill", locator: FIELD, value: "London" }]);
  });

  it("clamps a delay past the cap at emission, not only at the boundary", () => {
    // `recorder:updateStep` copies its allowlisted fields without
    // re-normalizing, and every test on disk is regenerated from its stored
    // steps, so a value the boundary never saw can still reach this line.
    const src = gen([
      step({
        type: "fill",
        locator: FIELD,
        value: "x",
        typeMode: "sequential",
        typeDelayMs: MAX_TYPE_DELAY_MS * 100,
      }),
    ]);
    expect(src).toContain(`{ delay: ${MAX_TYPE_DELAY_MS} }`);
  });

  it("drops a forged delay rather than interpolating it into source", () => {
    const src = gen([
      step({
        type: "fill",
        locator: FIELD,
        value: "x",
        typeMode: "sequential",
        typeDelayMs: '40); require("child_process").execSync("id"); (' as unknown as number,
      }),
    ]);
    expect(src).toContain('.pressSequentially("x");');
    expect(src).not.toContain("child_process");
  });

  it("treats an unknown typeMode as the default rather than switching on it", () => {
    const src = gen([
      step({ type: "fill", locator: FIELD, value: "x", typeMode: "sneaky" as never }),
    ]);
    expect(src).toContain('.fill("x");');
  });

  it("refuses an unknown typeMode at the capture boundary", () => {
    expect(normalizeRawStep({ type: "fill", typeMode: "sneaky" })).toEqual({ type: "fill" });
    expect(normalizeRawStep({ type: "fill", typeMode: "sequential" })).toEqual({
      type: "fill",
      typeMode: "sequential",
    });
  });

  it("refuses an out-of-range or non-numeric delay at the capture boundary", () => {
    // The boundary REFUSES rather than clamps (that is what `int` does for
    // every numeric field), so an absurd value becomes "no delay". Emission
    // clamps instead, because a stored step can reach it without passing the
    // boundary at all — see the clamping test above.
    expect(normalizeRawStep({ type: "fill", typeDelayMs: 999_999_999 })).toEqual({ type: "fill" });
    expect(normalizeRawStep({ type: "fill", typeDelayMs: "40" })).toEqual({ type: "fill" });
    expect(normalizeRawStep({ type: "fill", typeDelayMs: MAX_TYPE_DELAY_MS })).toEqual({
      type: "fill",
      typeDelayMs: MAX_TYPE_DELAY_MS,
    });
  });
});

describe("per-step timeout", () => {
  it("adds an options object to an action that had none", () => {
    const src = gen([
      step({ type: "click", locator: { k: "testid", v: "go" }, timeoutMs: 15_000 }),
    ]);
    expect(src).toContain('.click({ timeout: 15000 });');
  });

  it("composes with force, in a fixed key order", () => {
    // The order is part of the contract: one that varied with which fields a
    // step happened to carry would make the same step regenerate differently
    // from one save to the next.
    const src = gen([
      step({ type: "click", locator: { k: "testid", v: "go" }, force: true, timeoutMs: 15_000 }),
    ]);
    expect(src).toContain('.click({ force: true, timeout: 15000 });');
  });

  it("reaches a fill, a select, a check and a press", () => {
    const src = gen([
      step({ type: "fill", locator: FIELD, value: "x", timeoutMs: 9000 }),
      step({ type: "select", locator: { k: "testid", v: "s" }, value: "uk", timeoutMs: 9000 }),
      step({ type: "check", locator: { k: "testid", v: "c" }, timeoutMs: 9000 }),
      step({ type: "press", locator: FIELD, value: "Enter", timeoutMs: 9000 }),
    ]);
    expect(src).toContain('.fill("x", { timeout: 9000 });');
    expect(src).toContain('.selectOption("uk", { timeout: 9000 });');
    expect(src).toContain('.check({ timeout: 9000 });');
    expect(src).toContain('.press("Enter", { timeout: 9000 });');
  });

  it("does NOT reach page.keyboard.press, which has no such option", () => {
    const src = gen([step({ type: "press", value: "Escape", timeoutMs: 9000 })]);
    expect(src).toContain('await page.keyboard.press("Escape");');
    expect(src).not.toContain("timeout");
  });

  it("reaches every assertion matcher", () => {
    const loc = { k: "testid" as const, v: "el" };
    const src = gen([
      step({ type: "assert", assert: "visible", locator: loc, timeoutMs: 7500 }),
      step({ type: "assert", assert: "hidden", locator: loc, timeoutMs: 7500 }),
      step({ type: "assert", assert: "text", locator: loc, text: "Hi", timeoutMs: 7500 }),
      step({ type: "assert", assert: "count", locator: loc, count: 3, timeoutMs: 7500 }),
      step({
        type: "assert",
        assert: "attribute",
        locator: loc,
        attr: "data-x",
        value: "1",
        timeoutMs: 7500,
      }),
      step({ type: "assert", assert: "urlIs", value: "https://x.test/a", timeoutMs: 7500 }),
      step({ type: "assert", assert: "title", value: "Home", timeoutMs: 7500 }),
    ]);
    expect(src).toContain('.toBeVisible({ timeout: 7500 });');
    expect(src).toContain('.toBeHidden({ timeout: 7500 });');
    expect(src).toContain('.toContainText("Hi", { timeout: 7500 });');
    expect(src).toContain('.toHaveCount(3, { timeout: 7500 });');
    expect(src).toContain('.toHaveAttribute("data-x", "1", { timeout: 7500 });');
    expect(src).toContain('{ timeout: 7500 });');
    expect(src).toContain('.toHaveTitle("Home", { timeout: 7500 });');
  });

  it("leaves every call untouched when no step sets one", () => {
    // The whole library has to regenerate byte-identically, so the absence of
    // a timeout must mean the absence of the argument — not an empty object.
    const src = gen([
      step({ type: "click", locator: { k: "testid", v: "go" } }),
      step({ type: "assert", assert: "visible", locator: { k: "testid", v: "el" } }),
    ]);
    expect(src).toContain(".click();");
    expect(src).toContain(".toBeVisible();");
    expect(src).not.toContain("{ }");
  });

  it("drops a forged timeout rather than interpolating it into source", () => {
    const src = gen([
      step({
        type: "click",
        locator: { k: "testid", v: "go" },
        timeoutMs: '5000); require("fs"); (' as unknown as number,
      }),
    ]);
    expect(src).toContain(".click();");
    expect(src).not.toContain("require");
  });

  it("drops a negative timeout instead of clamping it to zero", () => {
    // `timeout: 0` means "wait forever" to Playwright, which is the opposite
    // of what a negative was trying to say.
    const src = gen([step({ type: "click", locator: { k: "testid", v: "go" }, timeoutMs: -1 })]);
    expect(src).toContain(".click();");
  });

  it("round-trips on actions and assertions alike", () => {
    const original = [
      step({ type: "click", locator: { k: "testid", v: "go" }, force: true, timeoutMs: 15_000 }),
      step({ type: "fill", locator: FIELD, value: "x", timeoutMs: 9000 }),
      step({ type: "assert", assert: "visible", locator: { k: "testid", v: "el" }, timeoutMs: 7500 }),
      step({ type: "assert", assert: "urlIs", value: "https://x.test/a", timeoutMs: 7500 }),
    ];
    const { steps, source, again } = roundTrip(original);
    expect(shape(steps)).toEqual([
      { type: "click", locator: { k: "testid", v: "go" }, force: true, timeoutMs: 15_000 },
      { type: "fill", locator: FIELD, value: "x", timeoutMs: 9000 },
      { type: "assert", assert: "visible", locator: { k: "testid", v: "el" }, timeoutMs: 7500 },
      { type: "assert", assert: "urlIs", value: "https://x.test/a", timeoutMs: 7500 },
    ]);
    expect(again).toBe(source);
  });
});

describe("the options object the parser will not read back", () => {
  // Round-tripping an option we do not understand is the worse failure: the
  // step comes back looking ordinary and REGENERATES without it.
  it("skips an assertion carrying a foreign option", () => {
    const src = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("t", async ({ page }) => {',
      '  await expect(page.getByTestId("el")).toBeVisible({ visible: false });',
      "});",
      "",
    ].join("\n");
    const parsed = parseSpecDetailed(src);
    // `toBeVisible({ visible: false })` asserts the element is NOT visible.
    // Reading it leniently would store it as an ordinary "visible" assert —
    // its own opposite — and regenerate it that way.
    expect(parsed.steps).toEqual([]);
    expect(parsed.skipped).toBe(1);
  });

  it("skips an action carrying a foreign option", () => {
    const src = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("t", async ({ page }) => {',
      '  await page.getByTestId("go").click({ trial: true });',
      "});",
      "",
    ].join("\n");
    const parsed = parseSpecDetailed(src);
    expect(parsed.steps).toEqual([]);
    expect(parsed.skipped).toBe(1);
  });

  it("refuses `force: false`, which the generator never writes", () => {
    const src = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("t", async ({ page }) => {',
      '  await page.getByTestId("go").click({ force: false });',
      "});",
      "",
    ].join("\n");
    expect(parseSpecDetailed(src).steps).toEqual([]);
  });

  it("refuses `delay` on a call that is not a per-character fill", () => {
    // `delay` means something only to pressSequentially. A click's delay is a
    // different option entirely (how long the button stays down), and reading
    // it back as a typing delay would regenerate it as one.
    const src = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("t", async ({ page }) => {',
      '  await page.getByTestId("go").click({ delay: 40 });',
      "});",
      "",
    ].join("\n");
    expect(parseSpecDetailed(src).steps).toEqual([]);
  });

  it("does not mistake a brace inside a string argument for an options object", () => {
    const parsed = parseSpec(
      [
        'import { test, expect } from "@playwright/test";',
        "",
        'test("t", async ({ page }) => {',
        '  await page.getByLabel("City").fill("a{b}c");',
        "});",
        "",
      ].join("\n"),
    );
    expect(shape(parsed)).toEqual([{ type: "fill", locator: FIELD, value: "a{b}c" }]);
  });
});

describe("reload", () => {
  it("emits page.reload()", () => {
    expect(gen([step({ type: "reload" })])).toContain("await page.reload();");
  });

  it("takes a timeout like any other step", () => {
    expect(gen([step({ type: "reload", timeoutMs: 30_000 })])).toContain(
      "await page.reload({ timeout: 30000 });",
    );
  });

  it("is a patched page action, so a capture run screenshots after it", () => {
    expect(PAGE_ACTIONS).toContain("reload");
  });

  it("round-trips", () => {
    const { steps, source, again } = roundTrip([
      step({ type: "reload" }),
      step({ type: "reload", timeoutMs: 30_000 }),
    ]);
    expect(shape(steps)).toEqual([{ type: "reload" }, { type: "reload", timeoutMs: 30_000 }]);
    expect(again).toBe(source);
  });

  it("leaves a reload carrying options we do not model unclassified", () => {
    // An imported spec's `page.reload({ waitUntil: "networkidle" })` means
    // something this step model cannot say. Reading it back as a plain reload
    // would drop the option on the next regeneration.
    const src = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("t", async ({ page }) => {',
      '  await page.reload({ waitUntil: "networkidle" });',
      "});",
      "",
    ].join("\n");
    const parsed = parseSpecDetailed(src);
    expect(parsed.steps).toEqual([]);
    expect(parsed.skipped).toBe(1);
  });

  it("is accepted at the capture boundary", () => {
    expect(normalizeRawStep({ type: "reload" })).toEqual({ type: "reload" });
  });
});
