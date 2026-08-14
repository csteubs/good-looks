/* global document, Element, DOMRect */
import { describe, expect, it, beforeEach } from "vitest";
import { buildReplayScript } from "./step-replayer.js";
import { buildHealProbeScript } from "./auto-heal.js";
import type { Step, StepType } from "../recorder/types.js";

interface R { ok: boolean; error?: string; met?: boolean; logs: { m: string }[] }
function step(p: Partial<Step> & { type: StepType }): Step {
  return { id: "s1", timestamp: 0, ...p } as Step;
}
function run(s: Step): R { return eval(buildReplayScript(s)) as R; }
function why(r: R): string { return r.logs.map((l) => l.m).join(" | ") + " | " + (r.error ?? ""); }

beforeEach(() => {
  document.body.innerHTML = "";
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

describe("MAX_UNIQUENESS_SCAN cap", () => {
  it("count assertion truncates on a big page", () => {
    // 7000 spans each containing "Row"
    const parts: string[] = [];
    for (let i = 0; i < 7000; i++) parts.push("<span>Row</span>");
    document.body.innerHTML = parts.join("");
    const r = run(step({ type: "assert", assert: "count", count: 7000, locator: { k: "css", v: "span" } }));
    console.log("COUNT css:", why(r));
    const r2 = run(step({ type: "assert", assert: "count", count: 7000, locator: { k: "text", v: "Row" } }));
    console.log("COUNT text:", why(r2));
  });

  it("text locator on a big page resolves to an ancestor, not the target", () => {
    const filler: string[] = [];
    for (let i = 0; i < 6500; i++) filler.push("<i>x</i>");
    document.body.innerHTML =
      "<div id='wrap'>" + filler.join("") + "<button id='target'>Checkout</button></div>";
    const r = run(step({ type: "click", locator: { k: "text", v: "Checkout" } }));
    console.log("BIGPAGE click:", why(r));
    console.log("BIGPAGE ok:", r.ok, "error:", r.error);
  });
});

describe("occludedBy", () => {
  it("bounding-box centre off the element reports a false occlusion", () => {
    document.body.innerHTML = '<div id="para">before <a id="lnk">Multi line link</a> after</div>';
    const lnk = document.getElementById("lnk")!;
    const para = document.getElementById("para")!;
    // Simulate an inline element wrapped over two lines: union box centre falls
    // in the gap, where the hit test returns the block container (an ANCESTOR).
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (this === lnk) return { width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      return { width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => para;
    const r = run(step({ type: "click", locator: { k: "css", v: "#lnk" } }));
    console.log("OCCLUSION:", r.ok, r.error);
  });

  it("is skipped entirely when elementFromPoint is absent (jsdom)", () => {
    console.log("has elementFromPoint in jsdom:", typeof (document as unknown as { elementFromPoint?: unknown }).elementFromPoint);
  });
});

describe("heal probe cost", () => {
  it("times how long the probe takes on a moderately large page", () => {
    const rows: string[] = [];
    for (let i = 0; i < 400; i++) {
      rows.push(`<div class="row"><button>Action ${i}</button><a href="#">Link ${i}</a><span>Some descriptive text for row ${i} that is reasonably long</span></div>`);
    }
    document.body.innerHTML = rows.join("");
    console.log("element count:", document.querySelectorAll("*").length);
    const s = step({ type: "click", locator: { k: "text", v: "Action 1" } });
    const src = buildHealProbeScript(s, []);
    const t0 = Date.now();
    const out = eval(src) as unknown[];
    console.log("heal probe ms:", Date.now() - t0, "candidates:", out.length);
  }, 300000);
});
