// Which fills the recorder chooses to type CHARACTER BY CHARACTER, and what
// the trainer's replay does with one.
//
// ── The bug this closes ────────────────────────────────────────────────────
// A recorded fill emits `locator.fill()`: the whole string in one operation,
// one `input` event. A field with real keyboard handling — an autocomplete, a
// combobox, a datalist-backed input — never sees the keystrokes, so its
// dropdown never opens, and the NEXT step, which clicks an option in that
// dropdown, fails against a list that was never rendered. Nothing about the
// recording looks wrong; the failure lands one step later, on an element that
// really is absent.
//
// ── Why this runs the real script against a real DOM ───────────────────────
// Both halves are claims about page-side code. "Which fields count as
// keyboard-driven" is a question about attributes and ancestors that only a
// DOM can answer, and "the replay fires an event per character" is a claim
// about what a page under the trainer actually observes. A test with a mocked
// page would assert the assumption back at itself.
//
// VERIFIED TO FAIL: with `fillStep` always returning the plain shape, every
// "records it as per-character" case here goes red; with the replayer's
// sequential branch removed, the per-character replay cases go red.

/* global document */

import { describe, expect, it } from "vitest";

import { captureHarness as harness } from "./capture-harness.js";
import { buildReplayScript } from "../services/step-replayer.js";
import type { Step } from "./types.js";

/** Focus a field, then change it — the order a person types in, and the order
 *  the detection depends on: the value AT FOCUS is what decides whether the
 *  per-character mode would mean the same thing as a plain fill. */
function typeInto(
  page: ReturnType<typeof harness>,
  selector: string,
  value: string,
  opts: { startingWith?: string } = {},
): void {
  const el = page.el(selector) as HTMLInputElement;
  if (opts.startingWith !== undefined) el.value = opts.startingWith;
  el.dispatchEvent(new page.win.FocusEvent("focusin", { bubbles: true }));
  el.value = value;
  el.dispatchEvent(new page.win.Event("change", { bubbles: true }));
}

describe("which fills are recorded as per-character", () => {
  it("records an ordinary text input as a plain fill", () => {
    const page = harness(`<input id="f" type="text" aria-label="Name" />`);
    typeInto(page, "#f", "Ada");
    expect(page.egress()).toMatchObject([{ type: "fill", value: "Ada" }]);
    expect(page.egress()[0].typeMode).toBeUndefined();
  });

  it("records an aria-autocomplete field as per-character", () => {
    const page = harness(
      `<input id="f" type="text" aria-label="City" aria-autocomplete="list" />`,
    );
    typeInto(page, "#f", "Lon");
    expect(page.egress()).toMatchObject([
      { type: "fill", value: "Lon", typeMode: "sequential" },
    ]);
  });

  it("records a datalist-backed input as per-character", () => {
    const page = harness(
      `<input id="f" type="text" aria-label="City" list="cities" />
       <datalist id="cities"><option value="London"></option></datalist>`,
    );
    typeInto(page, "#f", "Lon");
    expect(page.egress()[0].typeMode).toBe("sequential");
  });

  it("records a role=combobox input as per-character", () => {
    const page = harness(`<input id="f" type="text" aria-label="City" role="combobox" />`);
    typeInto(page, "#f", "Lon");
    expect(page.egress()[0].typeMode).toBe("sequential");
  });

  it("records a hand-rolled combobox — an input that expands a listbox it controls", () => {
    const page = harness(
      `<input id="f" type="text" aria-label="City" aria-expanded="false" aria-controls="lb" />
       <ul id="lb" role="listbox"></ul>`,
    );
    typeInto(page, "#f", "Lon");
    expect(page.egress()[0].typeMode).toBe("sequential");
  });

  it("looks up to three ancestors for the combobox role", () => {
    const page = harness(
      `<div role="combobox"><span><input id="f" type="text" aria-label="City" /></span></div>`,
    );
    typeInto(page, "#f", "Lon");
    expect(page.egress()[0].typeMode).toBe("sequential");
  });

  it("does NOT choose it when the field already had text", () => {
    // The whole safety argument. `pressSequentially` appends rather than
    // replacing, so on a field that starts non-empty the two modes are not the
    // same operation — the recorder must not silently pick the one that
    // changes what the step does.
    const page = harness(
      `<input id="f" type="text" aria-label="City" aria-autocomplete="list" />`,
    );
    typeInto(page, "#f", "London", { startingWith: "Man" });
    expect(page.egress()).toMatchObject([{ type: "fill", value: "London" }]);
    expect(page.egress()[0].typeMode).toBeUndefined();
  });

  it("does NOT choose it for a value-parsing input type, autocomplete or not", () => {
    // A date or number input parses its whole value at once. Typing it
    // character by character is a different operation and can leave the field
    // half-parsed — a worse bug than the one the mode exists to fix.
    const page = harness(
      `<input id="d" type="date" aria-label="When" aria-autocomplete="list" />
       <input id="n" type="number" aria-label="Qty" role="combobox" />`,
    );
    typeInto(page, "#d", "2026-08-21");
    typeInto(page, "#n", "3");
    for (const s of page.egress()) expect(s.typeMode).toBeUndefined();
  });

  it("does NOT choose it when the change came from a field the user never focused", () => {
    // A page that sets a value itself and dispatches `change` is not a person
    // typing, and the value-at-focus we hold belongs to a different element.
    const page = harness(
      `<input id="a" type="text" aria-label="A" aria-autocomplete="list" />
       <input id="b" type="text" aria-label="B" aria-autocomplete="list" />`,
    );
    const a = page.el("#a") as HTMLInputElement;
    a.dispatchEvent(new page.win.FocusEvent("focusin", { bubbles: true }));
    const b = page.el("#b") as HTMLInputElement;
    b.value = "set by the page";
    b.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    expect(page.egress()[0].typeMode).toBeUndefined();
  });

  it("reaches a textarea too", () => {
    const page = harness(
      `<textarea id="f" aria-label="Notes" aria-autocomplete="list"></textarea>`,
    );
    typeInto(page, "#f", "hi");
    expect(page.egress()[0].typeMode).toBe("sequential");
  });
});

describe("the trainer replays it per character", () => {
  /** Run the real injected replay script against a field, and report every
   *  event the page saw. The trainer agreeing with the run about what a step
   *  MEANS is the property this app keeps having to re-establish; a preview
   *  that fired one bulk `input` would be green for a reason the run cannot
   *  reproduce. */
  function replay(step: Step, html: string) {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const win = frame.contentWindow as Window & typeof globalThis;
    const doc = win.document;
    doc.body.innerHTML = html;
    const seen: string[] = [];
    for (const type of ["keydown", "keypress", "input", "keyup", "change"]) {
      doc.addEventListener(type, () => seen.push(type), true);
    }
    // jsdom has no layout engine, so every getBoundingClientRect is zeros and
    // anything gated on element size behaves as if hidden. The replayer's own
    // dom test installs a nominal box for exactly this reason.
    win.Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 } as DOMRect;
    } as never;
    const result = new Function("window", "document", `return (${buildReplayScript(step)})`)(
      win,
      doc,
    ) as { ok: boolean };
    return { result, seen, field: doc.querySelector("input") as HTMLInputElement };
  }

  const LOCATOR = { k: "label" as const, v: "City" };

  it("fires a key event for every character", () => {
    const { result, seen, field } = replay(
      { id: "s", type: "fill", locator: LOCATOR, value: "Lon", typeMode: "sequential", timestamp: 0 },
      `<label for="f">City</label><input id="f" type="text" />`,
    );
    expect(result.ok).toBe(true);
    expect(field.value).toBe("Lon");
    // Three characters: keydown, keypress, input, keyup each — then one change.
    expect(seen.filter((e) => e === "keydown")).toHaveLength(3);
    expect(seen.filter((e) => e === "input")).toHaveLength(3);
    expect(seen.filter((e) => e === "keyup")).toHaveLength(3);
    expect(seen.filter((e) => e === "change")).toHaveLength(1);
  });

  it("appends, exactly as the emitted pressSequentially does", () => {
    // Not a shortcoming being tested — a divergence being refused. If the
    // preview cleared the field and the run did not, the trainer would be
    // green for a step the run performs differently.
    const { field } = replay(
      { id: "s", type: "fill", locator: LOCATOR, value: "don", typeMode: "sequential", timestamp: 0 },
      `<label for="f">City</label><input id="f" type="text" value="Lon" />`,
    );
    expect(field.value).toBe("London");
  });

  it("a plain fill still fires exactly one input event", () => {
    const { seen, field } = replay(
      { id: "s", type: "fill", locator: LOCATOR, value: "Lon", timestamp: 0 },
      `<label for="f">City</label><input id="f" type="text" />`,
    );
    expect(field.value).toBe("Lon");
    expect(seen.filter((e) => e === "input")).toHaveLength(1);
    expect(seen.filter((e) => e === "keydown")).toHaveLength(0);
  });

  it("a plain fill REPLACES what was there", () => {
    const { field } = replay(
      { id: "s", type: "fill", locator: LOCATOR, value: "Paris", timestamp: 0 },
      `<label for="f">City</label><input id="f" type="text" value="Lon" />`,
    );
    expect(field.value).toBe("Paris");
  });
});
