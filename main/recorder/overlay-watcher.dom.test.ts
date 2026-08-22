/* Runs in the "dom" Vitest project (jsdom) but lives under main/, which the
   shared lint config treats as Node-only — hence the explicit globals. */
/* global document, Element, MutationObserver */

// Does a standing overlay rule actually dismiss the overlay, and does it stay
// out of the recording while doing it?
//
// ── Why it is tested by RUNNING the script ─────────────────────────────────
// The watcher is a string interpolated into two different hosts (the trainer's
// capture script and the run's dismissal fixture), and what it resolves with —
// `matchesFor` — is supplied by whichever host it lands in. A test that mocked
// the resolver would prove the watcher calls something, not that a rule finds
// the control it was taught on. This installs the REAL capture script, with
// real rules, over a real DOM.
//
// ── The two properties that cost the most to get wrong ─────────────────────
//
// 1. IT MUST NOT RECORD ITS OWN CLICK. The trainer's watcher runs in the same
//    isolated world as the capture listeners, so its click reaches them exactly
//    like a user's. Unsuppressed, teaching a rule silently appends a click on
//    a banner to the test being recorded — a step that will never find its
//    target again, because the rule now dismisses the banner before the step
//    can run.
//
// 2. IT MUST CLICK EACH ELEMENT ONCE. The first draft argued this was
//    structural: the rule targets the control that closes the overlay, so one
//    click removes the match. Measured against ritual.com's Klaviyo modal, that
//    is false — the close button is removed about 600ms AFTER the click, and
//    the sweep runs on every mutation batch. One dismissal produced SEVEN
//    clicks. A control that toggles rather than closes would have been clicked
//    back open.

import { describe, expect, it, vi } from "vitest";

import { captureHarness } from "./capture-harness.js";
import type { OverlayRule } from "./types.js";

function rule(over: Partial<OverlayRule> = {}): OverlayRule {
  return {
    id: "r1",
    host: "example.com",
    label: "Close",
    target: { k: "testid", v: "close-btn" },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as OverlayRule;
}

/** A page with the real capture script AND the given rules installed.
 *
 *  Through `captureHarness`, which puts each test in its own iframe window.
 *  That is not tidiness: the script installs listeners on `window` and
 *  `document` and the watcher installs a MutationObserver, none of which a
 *  `body.innerHTML` reset removes. On a shared document they ACCUMULATE, so
 *  every later test runs one watcher per earlier test — which reads as the
 *  clicked-once guard being broken when it is the fixture that is. */
function page(html: string, rules: OverlayRule[]) {
  return captureHarness(html, Date, rules);
}

/** jsdom lays nothing out, so `getBoundingClientRect` is zeros and the
 *  watcher's visibility gate would treat every element as hidden. Give the
 *  fixture a nominal box, the same way step-replayer.dom.test.ts does. */
function makeVisible(el: Element): void {
  el.getBoundingClientRect = () =>
    ({ width: 120, height: 32, top: 10, left: 10, right: 130, bottom: 42, x: 10, y: 10 }) as DOMRect;
}

/** Let the MutationObserver's microtask AND the watcher's release timer run.
 *
 *  Two turns, not one, and the order is why: a mutation schedules the observer
 *  as a microtask, the observer's click schedules the suppression release as a
 *  macrotask — so a single `setTimeout(0)` queued before the mutation runs
 *  BEFORE that release and reads the counter mid-click. */
const settle = async () => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

describe("a standing overlay rule", () => {
  const BANNER = `<div id="banner"><button data-testid="close-btn">Close</button></div>`;

  it("clicks the control it was taught on", async () => {
    const p = page(BANNER, [rule()]);
    const btn = p.el('[data-testid="close-btn"]');
    makeVisible(btn);
    const clicked = vi.fn();
    btn.addEventListener("click", clicked);

    p.el("#banner").appendChild(p.doc.createElement("span"));
    await settle();
    expect(clicked).toHaveBeenCalled();
  });

  it("does NOT record its own click as a step", async () => {
    // Property 1. Without the suppression counter this queues a click on the
    // banner — a step whose target the rule itself will have removed by the
    // time the test runs.
    const p = page(BANNER, [rule()]);
    makeVisible(p.el('[data-testid="close-btn"]'));
    p.el("#banner").appendChild(p.doc.createElement("span"));
    await settle();
    expect(p.egress().filter((s) => s.type === "click")).toHaveLength(0);
  });

  it("still records a click the USER makes on an unrelated element", async () => {
    // The suppression must be scoped to the watcher's own click, not a mute.
    const p = page(BANNER + `<button data-testid="buy">Buy</button>`, [rule()]);
    makeVisible(p.el('[data-testid="close-btn"]'));
    p.el("#banner").appendChild(p.doc.createElement("span"));
    await settle();
    p.click('[data-testid="buy"]');
    const clicks = p.egress().filter((s) => s.type === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0].locator).toMatchObject({ k: "testid", v: "buy" });
  });

  it("clicks a given element at most once, however many times it sweeps", async () => {
    // Property 2, and the one measurement proved wrong. The control stays in
    // the DOM after the click — exactly the Klaviyo case.
    const p = page(BANNER, [rule()]);
    const btn = p.el('[data-testid="close-btn"]');
    makeVisible(btn);
    const clicked = vi.fn();
    btn.addEventListener("click", clicked);
    for (let i = 0; i < 8; i++) {
      p.el("#banner").appendChild(p.doc.createElement("span"));
      await settle();
    }
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("clicks a REPLACED control again, because a new banner is a new element", async () => {
    // The other half of the same rule. Node identity rather than a per-rule
    // flag is what keeps a legitimately re-injected banner working.
    const p = page(BANNER, [rule()]);
    makeVisible(p.el('[data-testid="close-btn"]'));
    await settle();

    p.el("#banner").innerHTML = `<button data-testid="close-btn">Close</button>`;
    const fresh = p.el('[data-testid="close-btn"]');
    makeVisible(fresh);
    const clicked = vi.fn();
    fresh.addEventListener("click", clicked);
    p.el("#banner").appendChild(p.doc.createElement("span"));
    await settle();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("ignores a control that is present but not visible", async () => {
    // A CMP renders its banner and then reveals it. Clicking the hidden control
    // is how a watcher fires once at document start and never again.
    const p = page(BANNER, [rule()]);
    const btn = p.el('[data-testid="close-btn"]');
    // No makeVisible: jsdom's zero box models "not laid out".
    const clicked = vi.fn();
    btn.addEventListener("click", clicked);
    p.el("#banner").appendChild(p.doc.createElement("span"));
    await settle();
    expect(clicked).not.toHaveBeenCalled();
  });

  it("reaches a control inside an open shadow root", async () => {
    // The case the feature mostly exists for: consent modals are usually web
    // components. This works only because the watcher resolves through
    // `matchesFor`, which pierces open roots as of 2026-08-22.
    const p = page(`<aside id="host"></aside>`, [
      rule({ target: { k: "css", v: "button.accept" } }),
    ]);
    const host = p.el("#host");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<button class="accept">Accept All</button>`;
    const btn = root.querySelector("button") as HTMLElement;
    makeVisible(btn);
    const clicked = vi.fn();
    btn.addEventListener("click", clicked);
    host.appendChild(p.doc.createElement("span"));
    await settle();
    expect(clicked).toHaveBeenCalled();
  });

  it("does nothing at all when the rule list is empty", async () => {
    const p = page(BANNER, []);
    const btn = p.el('[data-testid="close-btn"]');
    makeVisible(btn);
    const clicked = vi.fn();
    btn.addEventListener("click", clicked);
    p.el("#banner").appendChild(p.doc.createElement("span"));
    await settle();
    expect(clicked).not.toHaveBeenCalled();
    // And capture is untouched: a page with no rules records normally.
    expect(p.overlaySuppress()).toBe(0);
  });

  it("leaves capture working after it fires — the counter always comes back down", async () => {
    // A leaked suppression is the worst outcome here: the recorder would stay
    // silently muted for the rest of the session and every later click would
    // vanish with no error anywhere.
    const p = page(BANNER + `<button data-testid="buy">Buy</button>`, [rule()]);
    makeVisible(p.el('[data-testid="close-btn"]'));
    p.el("#banner").appendChild(p.doc.createElement("span"));
    await settle();
    expect(p.overlaySuppress()).toBe(0);
    p.click('[data-testid="buy"]');
    expect(p.egress().filter((s) => s.type === "click")).toHaveLength(1);
  });

  it("survives a rule whose target matches nothing", async () => {
    const p = page(`<button data-testid="buy">Buy</button>`, [
      rule({ target: { k: "testid", v: "not-here" } }),
    ]);
    p.doc.body.appendChild(p.doc.createElement("span"));
    await settle();
    p.click('[data-testid="buy"]');
    expect(p.egress().filter((s) => s.type === "click")).toHaveLength(1);
  });
});
