// Configurable test-id attributes. Three layers: the shared grammar (one
// rule for ingest, emission, the parser's inverse, and the injected oracle),
// the round-trip through generator and parser with a configured attribute,
// and the REAL injected helpers evaluated in jsdom — the probe order and the
// oracle's recorded-attribute rule are meaning claims about page-side code.

/* global document */

import { describe, expect, it } from "vitest";

import {
  isTestIdAttributeName,
  normalizeTestIdAttributes,
  parseTestIdSelector,
  testIdOverride,
} from "../../shared/testid-attr.mjs";
import { DOM_HELPERS, UNIQUENESS_HELPERS, buildCaptureScript, buildCountScript } from "./capture-script.js";
import { normalizeLocator } from "./types.js";
import { generateSpec } from "../services/script-generator.js";
import { parseSpec } from "../services/spec-parser.js";
import type { Step } from "./types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

function gen(steps: Step[]): string {
  return generateSpec({ name: "t", url: "https://x.test", steps } as Parameters<
    typeof generateSpec
  >[0]);
}

describe("the shared grammar", () => {
  it("admits lowercase data-* names and nothing else", () => {
    expect(isTestIdAttributeName("data-cy")).toBe(true);
    expect(isTestIdAttributeName("data-qa-id")).toBe(true);
    for (const bad of [
      "data-testid", // the default is never an override
      "DATA-CY",
      "data-",
      "id",
      'data-cy"]',
      "data-cy ]",
      "data-" + "x".repeat(60),
      42,
      null,
    ]) {
      expect(isTestIdAttributeName(bad), String(bad)).toBe(false);
    }
  });

  it("testIdOverride (the embedded copy) agrees with isTestIdAttributeName", () => {
    // testIdOverride is serialized into injected/executed source and must be
    // self-contained, so it inlines the grammar — this pin is what makes the
    // inlining safe rather than a second spelling of one rule.
    for (const v of ["data-cy", "data-testid", "DATA-CY", "data-", 'data-x"]', "data-qa", "x"]) {
      expect(testIdOverride(v) !== null, v).toBe(isTestIdAttributeName(v));
    }
  });

  it("normalizes the settings list: grammar, dedupe, defaults out, capped", () => {
    expect(
      normalizeTestIdAttributes([
        "data-cy",
        "data-cy",
        "data-testid",
        "data-test",
        "bad name",
        "data-qa",
        "data-e2e",
        "data-hook",
        "data-extra",
      ]),
    ).toEqual(["data-cy", "data-qa", "data-e2e", "data-hook"]);
    expect(normalizeTestIdAttributes("data-cy")).toEqual([]);
  });
});

describe("round-trip with a configured attribute", () => {
  it("emits the attribute selector and reads it back as the same locator", () => {
    const steps = [step({ type: "click", locator: { k: "testid", v: "save", attr: "data-cy" } })];
    const src = gen(steps);
    expect(src).toContain('page.locator("[data-cy=\\"save\\"]").click()');
    const back = parseSpec(src);
    expect(back[0].locator).toEqual({ k: "testid", v: "save", attr: "data-cy" });
  });

  it("a hand-written [data-testid=…] selector still parses as css, not testid", () => {
    expect(parseTestIdSelector('[data-testid="v"]')).toBeNull();
  });

  it("the boundary keeps a grammar-valid attr and drops the rest", () => {
    expect(normalizeLocator({ k: "testid", v: "x", attr: "data-cy" })).toEqual({
      k: "testid",
      v: "x",
      attr: "data-cy",
    });
    expect(normalizeLocator({ k: "testid", v: "x", attr: 'foo="y"],[id' })).toEqual({
      k: "testid",
      v: "x",
    });
    expect(normalizeLocator({ k: "testid", v: "x", attr: "data-testid" })).toEqual({
      k: "testid",
      v: "x",
    });
  });
});

describe("the injected helpers, evaluated for real", () => {
  interface Helpers {
    testIdLocatorOf: (el: Element) => { k: string; v: string; attr?: string } | null;
    matchesFor: (loc: unknown, cap: number) => Element[];
    setAttrs: (attrs: string[]) => void;
  }

  function load(): Helpers {
    return eval(
      `(function () { ${DOM_HELPERS} ${UNIQUENESS_HELPERS} return {
         testIdLocatorOf: testIdLocatorOf,
         matchesFor: function (loc, cap) { return matchesFor(loc, cap); },
         setAttrs: function (a) { TID_ATTRS = a; },
       }; })()`,
    ) as Helpers;
  }

  it("probes only the built-in list by default — data-cy falls through", () => {
    document.body.innerHTML = '<button data-cy="save">Save</button>';
    const h = load();
    expect(h.testIdLocatorOf(document.querySelector("button")!)).toBeNull();
  });

  it("probes a configured extra, recording WHICH attribute matched", () => {
    document.body.innerHTML = '<button data-cy="save">Save</button>';
    const h = load();
    h.setAttrs(["data-testid", "data-cy", "data-test-id", "data-test"]);
    expect(h.testIdLocatorOf(document.querySelector("button")!)).toEqual({
      k: "testid",
      attr: "data-cy",
      v: "save",
    });
  });

  it("the default still wins when an element carries both", () => {
    document.body.innerHTML = '<button data-testid="a" data-cy="b">x</button>';
    const h = load();
    h.setAttrs(["data-testid", "data-cy", "data-test-id", "data-test"]);
    expect(h.testIdLocatorOf(document.querySelector("button")!)).toEqual({ k: "testid", v: "a" });
  });

  it("the oracle counts ONLY the recorded attribute — the parity rule", () => {
    // Two elements share the value across different attributes. A step
    // recorded off data-cy must count 1, not 2 — counting every attribute is
    // how a step could be unique live and match nothing on every run.
    document.body.innerHTML =
      '<button data-cy="save">A</button><button data-testid="save">B</button>';
    const h = load();
    expect(h.matchesFor({ k: "testid", v: "save", attr: "data-cy" }, 100).length).toBe(1);
    expect(h.matchesFor({ k: "testid", v: "save" }, 100).length).toBe(1);
    // A forged attr falls back to the default, never into the selector.
    expect(h.matchesFor({ k: "testid", v: "save", attr: 'x"],[id' }, 100).length).toBe(1);
  });

  it("the built scripts carry the configured list, grammar-gated", () => {
    const script = buildCaptureScript("n", ["data-cy", 'evil"]', "data-testid"]);
    expect(script).toContain('TID_ATTRS = ["data-testid","data-cy","data-test-id","data-test"];');
    expect(script).not.toContain("evil");
    const count = buildCountScript({ k: "testid", v: "x" }, ["data-qa"]);
    expect(count).toContain('TID_ATTRS = ["data-testid","data-qa","data-test-id","data-test"];');
  });
});
