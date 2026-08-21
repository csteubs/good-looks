// A page with the real capture script installed in it — the harness two
// `.dom.test.ts` files now share.
//
// It lived inside capture-egress.dom.test.ts until 2026-08-21, when the
// typing-mode tests needed the same thing. A second copy would have been the
// usual trap: the two would drift, and the drift would show up as one file's
// tests quietly measuring a different page from the other's.
//
// NOT named `*.test.ts`, so neither Vitest project picks it up as a suite of
// its own — it exports a helper and asserts nothing.

/* global document */

import { expect } from "vitest";

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

/** The session nonce the harness installs the script with. Exported so a test
 *  can prove a message carries it — the page's own scripts run in a different
 *  world and never see this value. */
export const CAPTURE_NONCE = "nonce-for-this-session";
const NONCE = CAPTURE_NONCE;

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
export function captureHarness(html: string, clock: { now(): number } = Date) {
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
