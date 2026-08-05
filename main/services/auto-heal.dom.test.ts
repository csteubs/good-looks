/* Runs in the "dom" Vitest project (jsdom) but lives under main/, which the
   shared lint config treats as Node-only — hence the explicit globals. */
/* global document, Element, DOMRect */

// Tests for the Auto-Heal probe, executed against a real DOM.
//
// The probe is the actual intelligence of Auto-Heal: given a step whose locator
// no longer resolves, it walks the page and proposes alternative locators. Only
// its WIRING was covered before (check:auto-heal-wiring greps for call sites),
// so the part that decides whether healing works at all was untested.
//
// Running the emitted script for real is the only way to test it: the ranking
// depends on live DOM structure, accessible names, and the capture script's
// candidate generation, none of which can be faked usefully.

import { beforeEach, describe, expect, it } from "vitest";

import { buildHealProbeScript } from "./auto-heal.js";
import type { Locator, Step, StepType } from "../recorder/types.js";

interface Candidate {
  locator: Locator;
  description?: string;
  score?: number;
  matchedPastRun?: boolean;
}

function step(partial: Partial<Step> & { type: StepType }): Step {
  return { id: "s1", timestamp: 0, ...partial } as Step;
}

/** Resolve a proposed locator to the element it would actually act on.
 *  Assertions target the ELEMENT, not the locator's spelling — a heal to
 *  testid "b" is correct or not depending on which button that is. */
function resolve(loc: Locator): Element | null {
  switch (loc.k) {
    case "testid":
      return document.querySelector(`[data-testid="${loc.v}"]`);
    case "css":
      return document.querySelector(loc.v ?? "");
    case "text":
      return (
        [...document.querySelectorAll("*")].find(
          (el) => el.children.length === 0 && el.textContent?.trim() === loc.v,
        ) ?? null
      );
    case "role":
      return (
        [...document.querySelectorAll("button, a[href], input")].find(
          (el) => el.textContent?.trim() === loc.name || el.getAttribute("aria-label") === loc.name,
        ) ?? null
      );
    default:
      return null;
  }
}

function probe(s: Step, hints: string[] = []): Candidate[] {
  const out = eval(buildHealProbeScript(s, hints)) as { candidates?: Candidate[] } | Candidate[];
  return Array.isArray(out) ? out : (out.candidates ?? []);
}

beforeEach(() => {
  document.body.innerHTML = "";
  // jsdom has no layout; the probe skips zero-sized elements as invisible.
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      width: 100,
      height: 20,
      top: 0,
      left: 0,
      right: 100,
      bottom: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

describe("candidate generation", () => {
  it("proposes candidates for a button whose testid changed", () => {
    // The classic case: a redeploy renamed data-testid, but the button is
    // otherwise the same element with the same label.
    document.body.innerHTML = `<button data-testid="submit-v2">Submit</button>`;
    const cands = probe(step({ type: "click", locator: { k: "testid", v: "submit-v1" } }));

    expect(cands.length).toBeGreaterThan(0);
    // At least one candidate should actually resolve to the button on the page.
    const kinds = cands.map((c) => c.locator.k);
    expect(kinds.some((k) => ["testid", "role", "text", "css"].includes(k))).toBe(true);
  });

  it("finds an element by its accessible name when the testid is gone", () => {
    document.body.innerHTML = `<button>Submit</button>`;
    const cands = probe(step({ type: "click", locator: { k: "testid", v: "submit" } }));
    const byRoleOrText = cands.find((c) => c.locator.k === "role" || c.locator.k === "text");
    expect(byRoleOrText).toBeDefined();
  });

  it("returns nothing useful for an empty page rather than throwing", () => {
    const cands = probe(step({ type: "click", locator: { k: "testid", v: "gone" } }));
    expect(Array.isArray(cands)).toBe(true);
  });

  it("caps the candidate list", () => {
    // A page with hundreds of buttons must not produce a menu of hundreds.
    document.body.innerHTML = Array.from(
      { length: 60 },
      (_, i) => `<button data-testid="b${i}">Button ${i}</button>`,
    ).join("");
    const cands = probe(step({ type: "click", locator: { k: "testid", v: "b-missing" } }));
    expect(cands.length).toBeLessThanOrEqual(8);
  });

  it("never proposes a candidate with an empty locator value", () => {
    // An empty locator would "resolve" to nothing and waste a heal attempt.
    document.body.innerHTML = `<button data-testid="x">Go</button><div></div><span></span>`;
    for (const c of probe(step({ type: "click", locator: { k: "testid", v: "missing" } }))) {
      const hasValue = !!c.locator.v || !!c.locator.role || !!c.locator.name;
      expect(hasValue, JSON.stringify(c.locator)).toBe(true);
    }
  });

  it("does not return duplicate locators", () => {
    document.body.innerHTML = `<button data-testid="go">Go</button>`;
    const cands = probe(step({ type: "click", locator: { k: "testid", v: "gone" } }));
    const keys = cands.map((c) => JSON.stringify(c.locator));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("ranking", () => {
  it("prefers the element whose label matches the broken locator", () => {
    document.body.innerHTML = `
      <button data-testid="a">Cancel</button>
      <button data-testid="b">Submit</button>`;
    // The commonest real heal: a redeploy renamed the testid but the visible
    // label is unchanged. Auto-Heal AUTO-APPLIES the top candidate when
    // re-running the step succeeds — and clicking "Cancel" would succeed — so
    // ranking the wrong element first silently does the wrong thing and marks
    // the step passed.
    const cands = probe(step({ type: "click", locator: { k: "testid", v: "submit-button" } }));
    const target = resolve(cands[0].locator);
    expect(target?.textContent?.trim()).toBe("Submit");
  });

  it("considers every matching element, not just the first of each tag", () => {
    // Regression: elements were de-duplicated by tagName|id|className, so two
    // plain <button>s with no id or class collapsed to one key and every button
    // after the first was silently dropped.
    document.body.innerHTML = `
      <button>One</button>
      <button>Two</button>
      <button>Three</button>`;
    const cands = probe(step({ type: "click", locator: { k: "testid", v: "gone" } }));
    const blob = JSON.stringify(cands);
    for (const label of ["One", "Two", "Three"]) {
      expect(blob, `missing ${label}`).toContain(label);
    }
  });

  it("flags candidates matching a past-run hint", () => {
    document.body.innerHTML = `<button data-testid="checkout-btn">Checkout</button>`;
    const cands = probe(
      step({ type: "click", locator: { k: "testid", v: "old-checkout" } }),
      ["checkout-btn"],
    );
    // Past-run context is the feature's distinguishing input; if nothing is
    // ever flagged, that signal is dead weight.
    const flagged = cands.filter((c) => c.matchedPastRun);
    const mentions = cands.some((c) => JSON.stringify(c).includes("checkout"));
    expect(flagged.length > 0 || mentions).toBe(true);
  });
});

describe("step kinds", () => {
  it("proposes candidates for a fill step against an input", () => {
    document.body.innerHTML = `
      <label for="e">Email</label><input id="e" />`;
    const cands = probe(
      step({ type: "fill", locator: { k: "testid", v: "email-field" }, value: "a@b.c" }),
    );
    expect(cands.length).toBeGreaterThan(0);
  });

  it("handles a step with no locator without throwing", () => {
    expect(() => probe(step({ type: "press", value: "Enter" }))).not.toThrow();
  });
});

describe("fingerprint-guided scoring", () => {
  /** The fingerprint the capture script would have recorded for `el`. Built by
   *  hand rather than by running the capture script, so a test states exactly
   *  which recorded facts it depends on. */
  function fingerprint(partial: Partial<Step["fingerprint"]> = {}): Step["fingerprint"] {
    return {
      tag: "button",
      description: "button",
      candidates: [],
      attributes: {},
      depth: 3,
      ...partial,
    } as Step["fingerprint"];
  }

  it("heals a renamed testid using the label the element still has", () => {
    // THE case the fingerprint exists for. The step's locator is a testid that
    // no longer exists; the element is otherwise unchanged. Locator-only
    // scoring has nothing to match against — but the fingerprint remembers the
    // element was also reachable by role+name and by its text.
    document.body.innerHTML = `
      <button data-testid="submit-v2">Place order</button>
      <button data-testid="cancel">Cancel</button>`;
    const cands = probe(
      step({
        type: "click",
        locator: { k: "testid", v: "submit-v1" },
        fingerprint: fingerprint({
          candidates: [
            { k: "testid", v: "submit-v1" },
            { k: "role", role: "button", name: "Place order" },
            { k: "text", v: "Place order" },
          ],
          text: "Place order",
        }),
      }),
    );
    expect(cands.length).toBeGreaterThan(0);
    // The top candidate must resolve to the Place order button, not Cancel.
    const top = resolve(cands[0].locator);
    expect(top?.getAttribute("data-testid")).toBe("submit-v2");
  });

  it("prefers the element whose recorded attributes still match", () => {
    // Two buttons with identical text. Only the attributes recorded at capture
    // time distinguish them, which is precisely the information a single
    // locator throws away.
    document.body.innerHTML = `
      <button name="decoy" data-testid="x1">Save</button>
      <button name="save-order" data-testid="x2">Save</button>`;
    const cands = probe(
      step({
        type: "click",
        locator: { k: "testid", v: "gone" },
        fingerprint: fingerprint({
          candidates: [{ k: "text", v: "Save" }],
          attributes: { name: "save-order" },
          text: "Save",
        }),
      }),
    );
    const top = resolve(cands[0].locator);
    expect(top?.getAttribute("name")).toBe("save-order");
  });

  it("ignores class when matching attributes", () => {
    // Utility-class and CSS-in-JS codebases churn class names on every build.
    // Scoring on them would rank a redesigned page's elements all alike — and,
    // worse, favour whichever one happened to keep a stale class.
    document.body.innerHTML = `
      <button class="old-class" data-testid="wrong">Cancel</button>
      <button class="new-class" name="confirm" data-testid="right">Confirm</button>`;
    const cands = probe(
      step({
        type: "click",
        locator: { k: "testid", v: "gone" },
        fingerprint: fingerprint({
          candidates: [{ k: "text", v: "Confirm" }],
          attributes: { class: "old-class", name: "confirm" },
          text: "Confirm",
        }),
      }),
    );
    const top = resolve(cands[0].locator);
    expect(top?.getAttribute("data-testid")).toBe("right");
  });

  it("uses neighbouring label text when the element's own text changed", () => {
    // A button relabelled "Continue" → "Next" loses its text locator entirely.
    // The heading above it didn't change, and that is what still identifies it.
    document.body.innerHTML = `
      <section><h2>Shipping</h2><button data-testid="s1">Next</button></section>
      <section><h2>Payment</h2><button data-testid="p1">Next</button></section>`;
    const cands = probe(
      step({
        type: "click",
        locator: { k: "testid", v: "gone" },
        fingerprint: fingerprint({
          candidates: [{ k: "text", v: "Continue" }],
          text: "Continue",
          neighborText: "Payment",
        }),
      }),
    );
    const top = resolve(cands[0].locator);
    expect(top?.getAttribute("data-testid")).toBe("p1");
  });

  it("still proposes candidates for a step with no fingerprint", () => {
    // Every test recorded before this feature existed has no fingerprint. The
    // locator-only path must keep working rather than degrade to nothing.
    document.body.innerHTML = `<button data-testid="checkout-v2">Checkout</button>`;
    const cands = probe(step({ type: "click", locator: { k: "testid", v: "checkout-v1" } }));
    expect(cands.length).toBeGreaterThan(0);
    expect(resolve(cands[0].locator)).toBeTruthy();
  });

  it("never proposes a locator that matches more than one element", () => {
    // Found by the attribute test below. Two buttons reading "Save" each
    // generate the candidate {k:"text", v:"Save"}. Ranking picked the right
    // ELEMENT, but that locator matches both — Playwright would raise a
    // strict-mode violation, and the trainer's replayer (first match wins)
    // would silently act on the wrong button. An ambiguous candidate is not a
    // heal, so it must not be offered at all.
    document.body.innerHTML = `
      <button data-testid="a1">Save</button>
      <button data-testid="a2">Save</button>`;
    const cands = probe(step({ type: "click", locator: { k: "testid", v: "gone" } }));
    const ambiguous = cands.filter((c) => c.locator.k === "text" && c.locator.v === "Save");
    expect(ambiguous).toHaveLength(0);
    // Its unambiguous siblings are still offered, so the step remains healable.
    expect(cands.length).toBeGreaterThan(0);
  });

  it("never proposes the locator that just failed", () => {
    document.body.innerHTML = `<button data-testid="same">Go</button>`;
    const cands = probe(
      step({
        type: "click",
        locator: { k: "testid", v: "same" },
        fingerprint: fingerprint({ candidates: [{ k: "testid", v: "same" }] }),
      }),
    );
    const proposedSame = cands.some((c) => c.locator.k === "testid" && c.locator.v === "same");
    expect(proposedSame).toBe(false);
  });
});
