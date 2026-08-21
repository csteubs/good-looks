// Double-click, right-click and drag: emission, round-trip, and the guards.
//
// These are the three interactions mabl records that this recorder did not. All
// three are ordinary element actions, so most of what is pinned here is the
// same pair as every other step — what the generator emits and what the parser
// reads back. Two things are specific to this set and worth reading for:
//
//  • a right-click is not its own Playwright method. It is `click({ button:
//    "right" })`, so the OPTIONS OBJECT is what tells it from an ordinary
//    click, in both directions. Read wrongly, a right-click comes back as a
//    left one and regenerates as a left one, and nothing on screen says so.
//  • `drag` is the only step in the model that points at TWO elements. Every
//    reader of `Step.locator` had to be asked whether it meant "the target" or
//    "every target", and the ones that answered "the source" are pinned here.

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpecDetailed } from "./spec-parser.js";
import { buildHealMap, healKeyFor } from "./playwright-runner.js";
import { normalizeRawStep } from "../recorder/types.js";
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

const ROW = { k: "testid" as const, v: "row" };
const CARD = { k: "testid" as const, v: "card" };
const COLUMN = { k: "testid" as const, v: "done" };

describe("double-click", () => {
  it("emits dblclick()", () => {
    expect(gen([step({ type: "dblclick", locator: ROW })])).toContain(
      'await page.getByTestId("row").dblclick();',
    );
  });

  it("takes a per-step timeout", () => {
    expect(gen([step({ type: "dblclick", locator: ROW, timeoutMs: 9000 })])).toContain(
      ".dblclick({ timeout: 9000 });",
    );
  });

  it("refuses out loud with no element", () => {
    expect(gen([step({ type: "dblclick" })])).toContain("this step needs an element");
  });
});

describe("right-click", () => {
  it("emits a click carrying the button", () => {
    // Not a method of its own — which is exactly why the options object has to
    // survive the round trip.
    expect(gen([step({ type: "rightclick", locator: ROW })])).toContain(
      'await page.getByTestId("row").click({ button: "right" });',
    );
  });

  it("composes with force and a timeout, in the fixed key order", () => {
    expect(
      gen([step({ type: "rightclick", locator: ROW, force: true, timeoutMs: 9000 })]),
    ).toContain('.click({ button: "right", force: true, timeout: 9000 });');
  });

  it("is told from an ordinary click on the way back", () => {
    const src = gen([
      step({ type: "click", locator: ROW }),
      step({ type: "rightclick", locator: ROW }),
    ]);
    const parsed = parseSpecDetailed(src);
    expect(parsed.steps.map((s) => s.type)).toEqual(["click", "rightclick"]);
  });

  it("refuses a button value the generator never writes", () => {
    // `button: "middle"` is a real Playwright option and not a step this app
    // has. Read leniently it would come back as a LEFT click and regenerate as
    // one — the click silently changing which button it presses.
    const src = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("t", async ({ page }) => {',
      '  await page.getByTestId("row").click({ button: "middle" });',
      "});",
      "",
    ].join("\n");
    const parsed = parseSpecDetailed(src);
    expect(parsed.steps).toEqual([]);
    expect(parsed.skipped).toBe(1);
  });
});

describe("drag", () => {
  it("emits source.dragTo(target)", () => {
    expect(gen([step({ type: "drag", locator: CARD, toLocator: COLUMN })])).toContain(
      'await page.getByTestId("card").dragTo(page.getByTestId("done"));',
    );
  });

  it("quotes BOTH locators through the same builder", () => {
    // A second locator is a second chance to interpolate one raw. The property
    // is that each value lands as ONE quoted argument; the text is allowed to
    // look like anything, because it is data.
    const a = '#a"); require("fs"); //';
    const b = '#b"); require("fs"); //';
    const src = gen([
      step({ type: "drag", locator: { k: "css", v: a }, toLocator: { k: "css", v: b } }),
    ]);
    expect(src).toContain(
      "page.locator(" + JSON.stringify(a) + ").dragTo(page.locator(" + JSON.stringify(b) + "))",
    );
  });

  it("refuses a drag with nothing to drop onto, and says which half is missing", () => {
    // "needs an element" would send the user looking at the SOURCE, which is
    // the half that is fine.
    const src = gen([step({ type: "drag", locator: CARD })]);
    expect(src).toContain("nothing to drop onto");
    expect(src).not.toContain("dragTo");
  });

  it("round-trips both ends, to a fixed point", () => {
    const steps = [
      step({ type: "drag", locator: CARD, toLocator: COLUMN }),
      step({
        type: "drag",
        locator: { k: "role", role: "listitem", name: "Task" },
        toLocator: { k: "css", v: "#col-2" },
        timeoutMs: 15_000,
      }),
    ];
    const src = gen(steps);
    const parsed = parseSpecDetailed(src);
    expect(parsed.skipped).toBe(0);
    expect(shape(parsed.steps)).toEqual([
      { type: "drag", locator: CARD, toLocator: COLUMN },
      {
        type: "drag",
        locator: { k: "role", role: "listitem", name: "Task" },
        toLocator: { k: "css", v: "#col-2" },
        timeoutMs: 15_000,
      },
    ]);
    expect(gen(parsed.steps as Step[])).toBe(src);
  });

  it("rebuilds the drop target at the capture boundary", () => {
    // Through the SAME normalizeLocator the source goes through — a second
    // locator on the boundary is a second chance to forget one.
    expect(normalizeRawStep({ type: "drag", toLocator: { k: "testid", v: "x", evil: 1 } })).toEqual({
      type: "drag",
      toLocator: { k: "testid", v: "x" },
    });
    expect(normalizeRawStep({ type: "drag", toLocator: { k: "nope", v: "x" } })).toEqual({
      type: "drag",
    });
  });

  it("heals its SOURCE and not its target", () => {
    // Not a shortcoming being hidden — a consequence being pinned. The heal map
    // is keyed by locator and probes with the step's FINGERPRINT, which is the
    // source element's; there is no recorded identity for the drop target, so
    // its key is simply absent from the map and the fixture attempts nothing.
    const drag = step({
      type: "drag",
      locator: CARD,
      toLocator: COLUMN,
      fingerprint: {
        tag: "div",
        description: "div.card",
        candidates: [CARD],
        attributes: {},
        depth: 3,
      },
    } as Partial<Step> & Pick<Step, "type">);
    const map = buildHealMap([drag]);
    expect(Object.keys(map)).toEqual([healKeyFor(CARD)]);
    expect(Object.keys(map)).not.toContain(healKeyFor(COLUMN));
  });
});

describe("all three together", () => {
  it("round-trip to a fixed point alongside an ordinary click", () => {
    const steps = [
      step({ type: "click", locator: ROW }),
      step({ type: "dblclick", locator: ROW }),
      step({ type: "rightclick", locator: ROW, force: true }),
      step({ type: "drag", locator: CARD, toLocator: COLUMN }),
    ];
    const src = gen(steps);
    const parsed = parseSpecDetailed(src);
    expect(parsed.skipped).toBe(0);
    expect(parsed.steps.map((s) => s.type)).toEqual(["click", "dblclick", "rightclick", "drag"]);
    expect(gen(parsed.steps as Step[])).toBe(src);
  });
});
