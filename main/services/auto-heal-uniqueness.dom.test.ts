// The heal probe's model of "unique", checked against Playwright's.
//
// `identifiesOnly` exists to stop the probe proposing a locator that matches
// two elements — applying one of those is a strict-mode violation, i.e. the
// heal makes the run fail in a NEW way. It was measuring uniqueness with exact
// string equality while Playwright matches a case-insensitive substring, so it
// systematically UNDER-counted and approved candidates that were not unique at
// all. Under-counting is the direction that matters: over-counting only costs a
// heal that could have worked, under-counting ships a broken one.

/* global document, Element, DOMRect */

import { beforeEach, describe, expect, it } from "vitest";

import { buildHealProbeScript } from "./auto-heal.js";
import type { Locator, Step } from "../recorder/types.js";

interface Candidate {
  locator: Locator;
  score: number;
}

function probe(s: Step): Candidate[] {
  const out = eval(buildHealProbeScript(s, [])) as { candidates?: Candidate[] } | Candidate[];
  return Array.isArray(out) ? out : (out.candidates ?? []);
}

/** Every locator the probe was willing to propose. */
function proposed(s: Step): Locator[] {
  return probe(s).map((c) => c.locator);
}

beforeEach(() => {
  document.body.innerHTML = "";
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

describe("a proposed candidate must be unique the way Playwright counts", () => {
  it("does not propose a text locator that is a substring of another element's text", () => {
    // THE BUG. `getByText("Save")` also matches "Save changes" — Playwright's
    // text match is a substring — so this candidate resolves to 2 elements and
    // applying it raises the exact violation identifiesOnly exists to prevent.
    // The old exact-equality check saw "Save" !== "Save changes" and approved.
    document.body.innerHTML = `
      <button data-testid="gone">Save</button>
      <button>Save changes</button>
    `;
    const step = { id: "s", type: "click", locator: { k: "testid", v: "gone" } } as Step;
    const texts = proposed(step).filter((l) => l.k === "text");
    expect(texts.map((l) => l.v)).not.toContain("Save");
  });

  it("still proposes a text locator when it really is unique", () => {
    document.body.innerHTML = `
      <button data-testid="gone">Save</button>
      <button>Cancel</button>
    `;
    const step = { id: "s", type: "click", locator: { k: "testid", v: "gone" } } as Step;
    expect(proposed(step).some((l) => l.k === "text" && l.v === "Save")).toBe(true);
  });

  it("does not propose a label locator that another field's label contains", () => {
    document.body.innerHTML = `
      <label for="a">Email</label><input id="a" data-testid="gone" />
      <label for="b">Email address</label><input id="b" />
    `;
    const step = { id: "s", type: "fill", locator: { k: "testid", v: "gone" } } as Step;
    expect(proposed(step).some((l) => l.k === "label" && l.v === "Email")).toBe(false);
  });

  it("counts case-insensitively, as Playwright does", () => {
    document.body.innerHTML = `
      <button data-testid="gone">Submit</button>
      <button>SUBMIT</button>
    `;
    const step = { id: "s", type: "click", locator: { k: "testid", v: "gone" } } as Step;
    expect(proposed(step).some((l) => l.k === "text" && l.v === "Submit")).toBe(false);
  });

  it("refuses a text locator on a wrapper, because it identifies the CHILD", () => {
    // The containment filter makes `getByText("Continue")` resolve to the
    // <span>, exactly as Playwright's deepest-match rule does — so the
    // candidate is unique but it is not the button. `identifiesOnly` requires
    // `hits[0] === el` for this reason, and it is a stronger requirement than
    // uniqueness: a locator that resolves to one element which is the WRONG
    // element does not throw, it silently acts on something nobody chose.
    // See DECISIONS 2026-08-12.
    document.body.innerHTML = `
      <button data-testid="gone"><span>Continue</span></button>
      <p>unrelated</p>
    `;
    const step = { id: "s", type: "click", locator: { k: "testid", v: "gone" } } as Step;
    expect(proposed(step).some((l) => l.k === "text" && l.v === "Continue")).toBe(false);
    // …and it still finds a way to address the button, rather than giving up.
    expect(proposed(step).length).toBeGreaterThan(0);
  });
});

describe("roles the recorder can actually find", () => {
  it("a search input is a searchbox, not a textbox", () => {
    // Every one of these collapsed to "textbox", which records cleanly,
    // verifies as unique against the same wrong function, previews green — and
    // matches nothing in the run, because Playwright uses the real mapping.
    document.body.innerHTML = '<input type="search" aria-label="Find" data-testid="gone" />';
    const step = { id: "s", type: "fill", locator: { k: "testid", v: "gone" } } as Step;
    const roles = proposed(step).filter((l) => l.k === "role").map((l) => l.role);
    expect(roles).toContain("searchbox");
    expect(roles).not.toContain("textbox");
  });

  it("a number input is a spinbutton", () => {
    document.body.innerHTML = '<input type="number" aria-label="Qty" data-testid="gone" />';
    const step = { id: "s", type: "fill", locator: { k: "testid", v: "gone" } } as Step;
    expect(proposed(step).filter((l) => l.k === "role").map((l) => l.role)).toContain("spinbutton");
  });

  it("a password input has NO role, so no role locator is offered for it", () => {
    document.body.innerHTML = '<input type="password" aria-label="Password" data-testid="gone" />';
    const step = { id: "s", type: "fill", locator: { k: "testid", v: "gone" } } as Step;
    expect(proposed(step).some((l) => l.k === "role")).toBe(false);
  });

  it("a multi-select is a listbox, not a combobox", () => {
    document.body.innerHTML = '<select multiple aria-label="Tags" data-testid="gone"><option>a</option></select>';
    const step = { id: "s", type: "select", locator: { k: "testid", v: "gone" } } as Step;
    const roles = proposed(step).filter((l) => l.k === "role").map((l) => l.role);
    expect(roles).toContain("listbox");
    expect(roles).not.toContain("combobox");
  });

  it("a single select is still a combobox", () => {
    document.body.innerHTML = '<select aria-label="Country" data-testid="gone"><option>a</option></select>';
    const step = { id: "s", type: "select", locator: { k: "testid", v: "gone" } } as Step;
    expect(proposed(step).filter((l) => l.k === "role").map((l) => l.role)).toContain("combobox");
  });
});
