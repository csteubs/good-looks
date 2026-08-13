/* Runs in the "dom" Vitest project but builds its OWN window per test — see
   `harness` below — so these globals are jsdom's, not this file's. */
/* global console */

// Does a captured step actually LEAVE the page?
//
// ── The bug ────────────────────────────────────────────────────────────────
// "Click events aren't recorded consistently, particularly when they involve
// navigation to another route." The click was captured correctly every time —
// and then left in `data-pw-queue`, an attribute of the document that the click
// was in the process of replacing. The backend read that attribute on a 250 ms
// poll, by which point the document, the attribute and the step were gone. The
// page transitioned, the step list did not grow, and the user had no way back:
// the training browser's URL strip is read-only by design.
//
// So the property under test is not "is the step correct" (that is
// locator-uniqueness.dom.test.ts) but "did the step get out of the document,
// inside the dispatch that is about to destroy it".
//
// ── Why this runs the real script against a real DOM ───────────────────────
// Every one of these failures is a disagreement between what the page does and
// what the recorder assumed it does — the propagation phase a listener sees,
// whether a click event is dispatched at all, what survives unload. A test with
// a mocked page would assert the assumption back at itself. This evaluates the
// script the app injects and reads what came out of it.
//
// VERIFIED TO FAIL against the previous implementation: with `push` writing
// only to the DOM queue, every "emits …" assertion here fails; with listeners
// only on `document`, "records a click a page swallows at window capture"
// fails; with no pointerdown fallback, the pagehide cases fail.

import { describe, expect, it } from "vitest";

import {
  ATTR_ASSERT,
  ATTR_PAUSED,
  buildCaptureScript,
  DRAIN_SCRIPT,
  WORLD_STATE_KEY,
} from "./capture-script.js";
import { parseCaptureMessage, parseDrainPayload } from "./capture-channel.js";
import { normalizeRawStep } from "./types.js";
import type { RawStep } from "./types.js";

const NONCE = "nonce-for-this-session";

/**
 * A page with the real capture script installed in it.
 *
 * The window and document come from an IFRAME, and the script is handed them as
 * arguments rather than reading the ambient ones. Both halves are load-bearing:
 *
 *  • A fresh window per test is what makes the counts mean anything. The script
 *    installs listeners on `window` and `document`; neither is removed by
 *    resetting `body.innerHTML`, so on the shared document the "dom" project
 *    provides they ACCUMULATE — the second test in a file runs two installed
 *    copies, the tenth runs ten, and each one records the same click again.
 *    (Written against the shared document, "one click is one step" read 18
 *    steps for one click while the app was perfectly correct.)
 *  • An iframe rather than a second JSDOM instance keeps this to the
 *    dependencies the repo already has, and `window` really is a separate event
 *    target from `document` in it — which is the whole point of the window-level
 *    listener being tested here.
 *
 * `clock` is injected for the same reason: the script's `Date.now` has to be
 * controllable from the test, and a vitest fake timer would move a clock the
 * injected code never reads, leaving the age check unexercised and the test
 * green.
 */
function harness(html: string, clock: { now(): number } = Date) {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const win = frame.contentWindow as Window & typeof globalThis;
  const doc = win.document;
  doc.body.innerHTML = html;

  /** Console messages the injected script emitted, newest last. */
  const emitted: string[] = [];
  const console = { debug: (...args: unknown[]) => emitted.push(String(args[0])) };

  doc.documentElement.setAttribute(ATTR_PAUSED, "0");
  doc.documentElement.setAttribute(ATTR_ASSERT, "");
  new Function("window", "document", "console", "Date", buildCaptureScript(NONCE))(
    win,
    doc,
    console,
    clock,
  );

  const parsed = () =>
    emitted
      .map((m) => parseCaptureMessage(m, NONCE))
      .filter((e): e is NonNullable<ReturnType<typeof parseCaptureMessage>> => !!e);

  return {
    win,
    doc,
    emitted,
    /** The steps that left the page over the console channel, in order.
     *  Through the real boundary, deliberately: a field the script emits but
     *  the normalizer drops would pass a test that read the envelope directly
     *  and then be missing in the app. */
    egress(): RawStep[] {
      const out: RawStep[] = [];
      for (const entry of parsed()) {
        const step = normalizeRawStep(entry.step);
        if (step) out.push(step);
      }
      return out;
    },
    /** The sequence numbers those steps carried. */
    egressSeqs(): number[] {
      return parsed().map((e) => e.seq);
    },
    /** What the backup channel would hand the backend, read through the real
     *  drain script rather than by inspecting the attribute. */
    drained() {
      const read = new Function("window", "document", `return (${DRAIN_SCRIPT})`) as (
        w: Window,
        d: Document,
      ) => unknown;
      return parseDrainPayload(read(win, doc));
    },
    el(selector: string): HTMLElement {
      const found = doc.querySelector(selector);
      expect(found, `fixture element ${selector}`).not.toBeNull();
      return found as HTMLElement;
    },
    click(selector: string): void {
      this.el(selector).click();
    },
    /** A pointer press with no click after it — the shape of a widget that
     *  navigates from its own mousedown handler. */
    pointerDown(selector: string): void {
      this.el(selector).dispatchEvent(new win.MouseEvent("pointerdown", { bubbles: true }));
    },
    /** The document going away. */
    unload(): void {
      win.dispatchEvent(new win.Event("pagehide"));
    },
    setAttr(name: string, value: string): void {
      doc.documentElement.setAttribute(name, value);
    },
    /** The capture script's own state, as the drain script sees it. */
    captureState(): { doc: string; seq: number; queue: { i: number; s: unknown }[] } | undefined {
      return (win as unknown as Record<string, never>)[WORLD_STATE_KEY];
    },
    dropCaptureState(): void {
      delete (win as unknown as Record<string, unknown>)[WORLD_STATE_KEY];
    },
    /** What the backend does on every dom-ready, and after a drain that found
     *  no capture state. */
    reinject(): void {
      new Function("window", "document", "console", "Date", buildCaptureScript(NONCE))(
        win,
        doc,
        console,
        clock,
      );
    },
  };
}

describe("a captured step leaves the document immediately", () => {
  it("emits the click before the handler returns", () => {
    const page = harness(`<a href="/next" id="go">Go</a>`);
    page.click("#go");
    // Not "after a poll", not "on navigation" — by the time the click's own
    // dispatch is over, the step is already out. That is the entire fix: the
    // navigation this click starts cannot take back what has already been sent.
    expect(page.egress()).toMatchObject([
      { type: "click", locator: { k: "role", role: "link", name: "Go" } },
    ]);
  });

  it("still queues it for the backup channel, with the same identity", () => {
    const page = harness(`<a href="/next" id="go">Go</a>`);
    page.click("#go");
    const sent = page.egress();
    const seqs = page.egressSeqs();
    const payload = page.drained();
    expect(payload?.installed).toBe(true);
    expect(payload?.doc).toBe(page.captureState()?.doc);
    expect(payload?.entries.map((e) => e.seq)).toEqual(seqs);
    // Same step, same sequence, both channels — which is what lets the ledger
    // admit it exactly once, whichever arrives first.
    expect(normalizeRawStep(payload?.entries[0]?.step)).toEqual(sent[0]);
  });

  it("numbers steps from one, so the backend can order them", () => {
    const page = harness(`<button id="a">A</button><button id="b">B</button>`);
    page.click("#a");
    page.click("#b");
    expect(page.egressSeqs()).toEqual([1, 2]);
  });

  it("emits every kind of captured step, not only clicks", () => {
    const page = harness(`
      <input id="t" type="text" aria-label="Name" />
      <input id="c" type="checkbox" aria-label="Agree" />
      <select id="s" aria-label="Size"><option value="l">Large</option></select>
    `);
    const text = page.el("#t") as HTMLInputElement;
    text.value = "Ada";
    text.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    const box = page.el("#c") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    page.el("#s").dispatchEvent(new page.win.Event("change", { bubbles: true }));
    expect(page.egress().map((s) => s.type)).toEqual(["fill", "check", "select"]);
  });

  it("carries the nonce, so the page cannot forge one of these", () => {
    const page = harness(`<button id="a">A</button>`);
    page.click("#a");
    // The page's own scripts run in a different world and never see this value.
    expect(parseCaptureMessage(page.emitted[0], "some-other-nonce")).toBeNull();
    expect(parseCaptureMessage(page.emitted[0], NONCE)).not.toBeNull();
  });
});

describe("one click is one step", () => {
  it("records a single step even though listeners are on window AND document", () => {
    // The handler is registered twice on purpose (see the script's `once`).
    // Getting this wrong is a test that clicks Pay twice.
    const page = harness(`<button id="a">Pay</button>`);
    page.click("#a");
    expect(page.egress()).toHaveLength(1);
    expect(page.drained()?.entries).toHaveLength(1);
  });

  it("records two real clicks as two steps", () => {
    // The other direction, and the one a sloppier dedupe gets wrong: two
    // dispatches close enough together to share a coarsened timestamp.
    const page = harness(`<button id="a">Pay</button>`);
    page.click("#a");
    page.click("#a");
    expect(page.egress()).toHaveLength(2);
  });

  it("records a click a page swallows at window capture", () => {
    // What a client-side router does to a link click. A listener registered on
    // `window` in the capture phase runs before the document phase exists — so
    // stopping propagation there used to make the recorder's document-level
    // listener never fire at all, and the click that changed route was the one
    // that vanished. Window is the earliest target there is; nothing on the
    // page can get in front of it.
    const page = harness(`<a href="/next" id="go">Go</a>`);
    page.win.addEventListener("click", (e: Event) => e.stopPropagation(), true);
    page.click("#go");
    expect(page.egress()).toHaveLength(1);
  });

  it("records a click a page swallows before it reaches the document", () => {
    // The same defence stated as the user sees it: the page's own handler runs,
    // the route changes, and the step is recorded anyway.
    const page = harness(`<a href="/next" id="go">Go</a>`);
    let pageSawIt = false;
    page.doc.addEventListener(
      "click",
      (e: Event) => {
        pageSawIt = true;
        e.stopImmediatePropagation();
      },
      true,
    );
    page.click("#go");
    expect(pageSawIt, "the page's own router handler ran").toBe(true);
    expect(page.egress()).toHaveLength(1);
  });
});

describe("the click that is never dispatched", () => {
  it("records the pointerdown as a click when the document unloads instead", () => {
    // A widget that navigates from `mousedown` never produces a click event, so
    // there is nothing for a click listener to hear. The step is recovered from
    // the pointer press as the document goes away — the DOM is still intact at
    // pagehide, which is what makes a locator possible at all.
    const page = harness(`<a href="/next" id="go">Go</a>`);
    page.pointerDown("#go");
    expect(page.egress(), "nothing is recorded on the press itself").toEqual([]);
    page.unload();
    expect(page.egress()).toMatchObject([
      { type: "click", locator: { k: "role", role: "link", name: "Go" } },
    ]);
    // The recovered step carries a fingerprint like any other, so Auto-Heal can
    // work on it later — it is a real step, not a stub.
    expect(page.egress()[0].fingerprint?.description).toBe("a#go");
  });

  it("does not record it twice when the click does arrive", () => {
    const page = harness(`<a href="/next" id="go">Go</a>`);
    page.pointerDown("#go");
    page.click("#go");
    page.unload();
    expect(page.egress()).toHaveLength(1);
  });

  it("does not invent a click for a press on something inert", () => {
    // A redirect that happens to land while the user was pressing on the page
    // background must not record a step. A phantom step is worse than a missing
    // one: it looks deliberate, and it replays as a click on whatever now sits
    // at that locator.
    const page = harness(`<div id="d">Just text</div>`);
    page.pointerDown("#d");
    page.unload();
    expect(page.egress()).toEqual([]);
  });

  it("does not record a press the user made minutes ago", () => {
    let now = 1_000_000;
    const page = harness(`<a href="/next" id="go">Go</a>`, { now: () => now });
    page.pointerDown("#go");
    now += 60_000;
    page.unload();
    expect(page.egress()).toEqual([]);
  });

  it("does not record a press on a text field the user then navigated away from", () => {
    // A click on a text input records nothing (typing is captured by `change`),
    // and the pending press has to be cleared with it — otherwise the next
    // navigation turns a click nobody wanted into a step.
    const page = harness(`<button id="b">Go</button><input id="t" type="text" aria-label="Name" />`);
    page.pointerDown("#t");
    page.click("#t");
    page.unload();
    expect(page.egress()).toEqual([]);
  });

  it("does not fire on beforeunload, which arrives mid-click", () => {
    // THE DUPLICATE THIS COST. beforeunload fires SYNCHRONOUSLY when a
    // navigation starts — and a client-side router starts one from inside its
    // own click handler, before the recorder's click listener has run. Wired to
    // that event, the rescue recorded the click and the real handler then
    // recorded it again: the trainer showed the same click twice, which replays
    // as a test that clicks Pay twice. (Caught in a real Electron window, not
    // here — hence this test.)
    const page = harness(`<a href="/next" id="go">Go</a>`);
    page.pointerDown("#go");
    page.win.dispatchEvent(new page.win.Event("beforeunload"));
    expect(page.egress(), "beforeunload records nothing on its own").toEqual([]);
    page.click("#go");
    expect(page.egress()).toHaveLength(1);
  });

  it("does not record the click twice when unload beats the click event", () => {
    // The mirror image, and the reason the rescue remembers what it recorded:
    // an unload that lands before the click event is dispatched leaves a click
    // still to come for a step that is already in the list.
    const page = harness(`<a href="/next" id="go"><span id="label">Go</span></a>`);
    page.pointerDown("#label");
    page.unload();
    expect(page.egress(), "the rescue recorded it").toHaveLength(1);
    page.click("#label");
    expect(page.egress(), "the late click is the same click").toHaveLength(1);
  });

  it("still records a different click after a rescue", () => {
    // The dedupe is scoped to the element that was rescued. Anything else the
    // user does is a step, or the guard against a duplicate becomes a new way
    // to lose one.
    const page = harness(`<a href="/next" id="go">Go</a><button id="other">Other</button>`);
    page.pointerDown("#go");
    page.unload();
    page.click("#other");
    expect(page.egress().map((s) => s.locator?.name)).toEqual(["Go", "Other"]);
  });

  it("respects pause", () => {
    const page = harness(`<a href="/next" id="go">Go</a>`);
    page.setAttr(ATTR_PAUSED, "1");
    page.pointerDown("#go");
    page.unload();
    expect(page.egress()).toEqual([]);
  });

  it("respects assertion mode", () => {
    // In assertion mode a click picks an element to assert on; it is not an
    // interaction to replay. The rescue path must not turn one into a click.
    const page = harness(`<a href="/next" id="go">Go</a>`);
    page.setAttr(ATTR_ASSERT, "visible");
    page.pointerDown("#go");
    page.unload();
    expect(page.egress()).toEqual([]);
  });
});

describe("the drain script", () => {
  it("reports that capture is installed", () => {
    const page = harness(`<button id="a">A</button>`);
    expect(page.drained()?.installed).toBe(true);
  });

  it("reports a document that has no capture state", () => {
    // The self-healing signal, and the reason the marker is the state object
    // rather than an attribute: this is the ONLY thing that reports capture as
    // absent, and it reports it exactly when the listeners are absent too. A
    // load whose dom-ready we missed leaves capture off with nothing on screen
    // to say so; the backend re-injects on the next poll because of this.
    const page = harness(`<button id="a">A</button>`);
    page.dropCaptureState();
    expect(page.drained()?.installed).toBe(false);
  });

  it("cannot be turned off by the page", () => {
    // The page CAN strip every attribute off <html> — which is what the old
    // attribute-based install marker rested on. It cannot reach the isolated
    // world's state, so capture keeps working and, just as importantly, the
    // backend is not told to re-inject over listeners that are still alive
    // (which would double every step from then on).
    const page = harness(`<button id="a">A</button>`);
    for (const attr of [...page.doc.documentElement.attributes]) {
      page.doc.documentElement.removeAttribute(attr.name);
    }
    page.click("#a");
    expect(page.egress()).toHaveLength(1);
    expect(page.drained()?.installed).toBe(true);
  });

  it("refuses to install twice over live listeners", () => {
    // The other half of self-healing. Re-injection is only safe while this
    // holds: a second copy of the script would record every later click twice.
    const page = harness(`<button id="a">A</button>`);
    page.reinject();
    page.click("#a");
    expect(page.egress()).toHaveLength(1);
  });

  it("clears the queue it hands over", () => {
    const page = harness(`<button id="a">A</button>`);
    page.click("#a");
    expect(page.drained()?.entries).toHaveLength(1);
    expect(page.drained()?.entries, "a drained step must not be handed over twice").toHaveLength(0);
  });

  it("does not clear the queue it failed to hand over", () => {
    // Serialization is the one step here that can fail. Clearing first and
    // failing second would drop the steps, which is the bug this file exists
    // for, arriving through the machinery meant to prevent it.
    const page = harness(`<button id="a">A</button>`);
    page.click("#a");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    page.captureState()?.queue.push({ i: 99, s: circular });
    expect(page.drained(), "an unserializable queue reads as nothing to ingest").toBeNull();
    page.captureState()?.queue.pop();
    expect(page.drained()?.entries).toHaveLength(1);
  });
});
