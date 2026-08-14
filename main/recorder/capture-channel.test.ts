// The rules that let two capture channels deliver the same step safely.
//
// ── What broke, and why this file is not incidental ────────────────────────
// A click that navigated was recorded by the page and then lost, because the
// only way out of the page was a DOM attribute read on a poll — and the click
// was busy destroying the document that attribute lived on. The fix gives every
// step a second, immediate exit (a console message emitted inside the click's
// own dispatch) and keeps the queue as a backup.
//
// Two channels for the same steps is a correctness problem of its own, and it
// is the kind this codebase keeps meeting: the failures are SILENT. A step
// admitted twice is a test that clicks Pay twice. A step admitted late is a
// test that does the right things in the wrong order. Neither throws, neither
// shows up on screen, and both are only visible on a run against a real site.
// So the rules live in a pure module and are pinned here rather than being an
// emergent property of the service's poll loop.

import { describe, expect, it } from "vitest";

import {
  CAPTURE_MESSAGE_PREFIX,
  CaptureLedger,
  GAP_GRACE_MS,
  MAX_CAPTURE_MESSAGE_BYTES,
  MAX_PENDING_PER_DOC,
  MAX_TRACKED_DOCS,
  parseCaptureMessage,
  parseDrainPayload,
} from "./capture-channel.js";

const NONCE = "session-nonce-1234";

/** A console message exactly as the injected script builds one. */
function message(fields: Record<string, unknown>): string {
  return CAPTURE_MESSAGE_PREFIX + JSON.stringify(fields);
}

describe("parseCaptureMessage", () => {
  it("reads a step the capture script emitted", () => {
    const entry = parseCaptureMessage(
      message({ n: NONCE, d: "docA", i: 1, s: { type: "click" } }),
      NONCE,
    );
    expect(entry).toEqual({ doc: "docA", seq: 1, step: { type: "click" } });
  });

  it("ignores the page's own console output", () => {
    // The overwhelmingly common case: this handler sees every message an
    // arbitrary website prints.
    expect(parseCaptureMessage("Download the React DevTools", NONCE)).toBeNull();
    expect(parseCaptureMessage("", NONCE)).toBeNull();
    expect(parseCaptureMessage(undefined, NONCE)).toBeNull();
    expect(parseCaptureMessage({ message: "x" }, NONCE)).toBeNull();
  });

  it("refuses a step whose nonce is not this session's", () => {
    // THE BOUNDARY. The nonce lives in an isolated-world closure the page
    // cannot read, so a page script printing a well-formed step message cannot
    // inject one into the recording. Losing this check would turn console
    // output into a way for any site to write steps of its choosing — and steps
    // become a spec that is executed in Node.
    const forged = message({ n: "guessed", d: "docA", i: 1, s: { type: "click" } });
    expect(parseCaptureMessage(forged, NONCE)).toBeNull();
    // ...including the one shape that would otherwise slip through: no nonce at
    // all on both sides.
    expect(parseCaptureMessage(message({ d: "docA", i: 1, s: {} }), "")).toBeNull();
  });

  it("refuses anything that is not a well-formed envelope", () => {
    expect(parseCaptureMessage(CAPTURE_MESSAGE_PREFIX + "{not json", NONCE)).toBeNull();
    expect(parseCaptureMessage(CAPTURE_MESSAGE_PREFIX + "[1,2,3]", NONCE)).toBeNull();
    expect(parseCaptureMessage(message({ n: NONCE, d: "", i: 1, s: {} }), NONCE)).toBeNull();
    expect(parseCaptureMessage(message({ n: NONCE, d: "docA", i: 0, s: {} }), NONCE)).toBeNull();
    expect(parseCaptureMessage(message({ n: NONCE, d: "docA", i: 1.5, s: {} }), NONCE)).toBeNull();
    expect(parseCaptureMessage(message({ n: NONCE, d: "docA", i: "1", s: {} }), NONCE)).toBeNull();
    // A step field that is absent is not a step. (`null` IS carried through —
    // normalizeRawStep is what rejects it, and it is the only thing allowed to.)
    expect(parseCaptureMessage(message({ n: NONCE, d: "docA", i: 1 }), NONCE)).toBeNull();
  });

  it("refuses a message far larger than any step", () => {
    const huge = message({ n: NONCE, d: "docA", i: 1, s: { type: "click" } }) +
      "x".repeat(MAX_CAPTURE_MESSAGE_BYTES);
    expect(parseCaptureMessage(huge, NONCE)).toBeNull();
  });

  it("does not normalize the step — that is the service's boundary", () => {
    // Deliberate: if this ever returned a typed Step, a caller could reasonably
    // skip normalizeRawStep and put page-authored fields straight into a spec.
    const entry = parseCaptureMessage(
      message({ n: NONCE, d: "docA", i: 1, s: { type: "click", count: "0); process.exit(1); (" } }),
      NONCE,
    );
    expect(entry?.step).toEqual({ type: "click", count: "0); process.exit(1); (" });
  });
});

describe("parseDrainPayload", () => {
  it("reads the queue, the document id and the install flag", () => {
    const payload = parseDrainPayload(
      '{"d":"docA","installed":1,"q":[{"i":1,"s":{"type":"click"}},{"i":2,"s":{"type":"fill"}}]}',
    );
    expect(payload).toEqual({
      doc: "docA",
      installed: true,
      entries: [
        { doc: "docA", seq: 1, step: { type: "click" } },
        { doc: "docA", seq: 2, step: { type: "fill" } },
      ],
    });
  });

  it("reports a page that has lost the capture script", () => {
    // The signal behind self-healing injection: dom-ready is a single shot, so
    // without this a document that lost its listeners records nothing for the
    // rest of the session and says nothing about it.
    expect(parseDrainPayload('{"d":"docA","installed":0,"q":[]}')?.installed).toBe(false);
  });

  it("survives a page that corrupted the queue attribute", () => {
    // `data-pw-queue` is page-writable, so this is a normal input, not an edge
    // case. Anything unusable reads as "nothing to ingest".
    expect(parseDrainPayload('{"d":"docA","installed":1,"q":not-json}')).toBeNull();
    expect(parseDrainPayload("")).toBeNull();
    expect(parseDrainPayload("[]")).toBeNull();
    expect(parseDrainPayload(undefined)).toBeNull();
    // Junk entries are skipped one by one rather than poisoning the batch.
    expect(
      parseDrainPayload('{"d":"docA","installed":1,"q":[1,{"i":2,"s":{}},{"i":"x","s":{}}]}')
        ?.entries,
    ).toEqual([{ doc: "docA", seq: 2, step: {} }]);
  });
});

describe("CaptureLedger", () => {
  const t0 = 1_000_000;
  const entry = (doc: string, seq: number, step: unknown = { type: "click", value: `s${seq}` }) => ({
    doc,
    seq,
    step,
  });

  it("admits a step once, however many channels deliver it", () => {
    const ledger = new CaptureLedger();
    // The console channel, inside the click's dispatch.
    expect(ledger.admit(entry("d1", 1), t0)).toEqual([{ type: "click", value: "s1" }]);
    // The drain, a quarter of a second later, carrying the same step.
    expect(ledger.admit(entry("d1", 1), t0 + 250)).toEqual([]);
  });

  it("admits in capture order when the drain arrives first", () => {
    // Both channels are ordered, but they interleave freely. Any interleaving
    // of two ordered copies has to come out as one ordered list.
    const ledger = new CaptureLedger();
    const got: unknown[] = [];
    got.push(...ledger.admit(entry("d1", 1), t0));
    got.push(...ledger.admit(entry("d1", 2), t0));
    got.push(...ledger.admit(entry("d1", 1), t0)); // drain, replaying 1..3
    got.push(...ledger.admit(entry("d1", 2), t0));
    got.push(...ledger.admit(entry("d1", 3), t0));
    expect(got).toEqual([
      { type: "click", value: "s1" },
      { type: "click", value: "s2" },
      { type: "click", value: "s3" },
    ]);
  });

  it("holds a step that arrives ahead of one that has not", () => {
    // THE ORDERING BUG this class exists for. If step 2's console message is
    // dropped and step 3's is not, admitting 3 immediately puts the recovered
    // step 2 AFTER it — a test that does the right things in the wrong order,
    // which nothing downstream can detect.
    const ledger = new CaptureLedger();
    expect(ledger.admit(entry("d1", 1), t0)).toEqual([{ type: "click", value: "s1" }]);
    expect(ledger.admit(entry("d1", 3), t0)).toEqual([]);
    expect(ledger.admit(entry("d1", 2), t0 + 10)).toEqual([
      { type: "click", value: "s2" },
      { type: "click", value: "s3" },
    ]);
  });

  it("releases a gap no channel is going to fill", () => {
    // Held forever would be worse than late: one dropped message would stop the
    // recorder recording, which is the bug with a different shape.
    const ledger = new CaptureLedger();
    ledger.admit(entry("d1", 1), t0);
    expect(ledger.admit(entry("d1", 3), t0)).toEqual([]);
    expect(ledger.sweep(t0 + GAP_GRACE_MS - 1), "still within the grace period").toEqual([]);
    expect(ledger.sweep(t0 + GAP_GRACE_MS)).toEqual([{ type: "click", value: "s3" }]);
    expect(ledger.pendingCount()).toBe(0);
    // ...and the released step is not admitted a second time when the drain
    // finally supplies it.
    expect(ledger.admit(entry("d1", 3), t0 + 5000)).toEqual([]);
  });

  it("waits from the gap, not from the session", () => {
    const ledger = new CaptureLedger();
    ledger.admit(entry("d1", 1), t0);
    expect(ledger.sweep(t0 + GAP_GRACE_MS * 10), "no gap, nothing to release").toEqual([]);
    ledger.admit(entry("d1", 3), t0 + GAP_GRACE_MS * 10);
    expect(ledger.sweep(t0 + GAP_GRACE_MS * 10 + 1)).toEqual([]);
  });

  it("keeps each document's sequence separate", () => {
    // Sequences restart at 1 in every new document, which is the whole reason
    // an entry carries a doc id: without it, the first click on page two would
    // look like a duplicate of the first click on page one and vanish. That is
    // the reported bug, reintroduced by the machinery meant to fix it.
    const ledger = new CaptureLedger();
    expect(ledger.admit(entry("d1", 1, "page-one-click"), t0)).toEqual(["page-one-click"]);
    expect(ledger.admit(entry("d2", 1, "page-two-click"), t0 + 300)).toEqual(["page-two-click"]);
  });

  it("does not hold a new document's steps behind an old document's gap", () => {
    const ledger = new CaptureLedger();
    ledger.admit(entry("d1", 5), t0);
    expect(ledger.admit(entry("d2", 1, "after-nav"), t0)).toEqual(["after-nav"]);
  });

  it("releases rather than hoards when a gap never closes", () => {
    const ledger = new CaptureLedger();
    ledger.admit(entry("d1", 1), t0);
    const out: unknown[] = [];
    for (let seq = 3; seq <= MAX_PENDING_PER_DOC + 3; seq++) {
      out.push(...ledger.admit(entry("d1", seq), t0));
    }
    expect(out.length).toBe(MAX_PENDING_PER_DOC + 1);
    expect(ledger.pendingCount()).toBe(0);
  });

  it("hands back what an evicted document was still holding", () => {
    // A session that visits many pages must not grow a map per page — but
    // evicting one silently would drop steps, which is the failure this whole
    // change exists to end.
    const ledger = new CaptureLedger();
    ledger.admit(entry("old", 2, "stranded"), t0);
    const out: unknown[] = [];
    for (let i = 0; i < MAX_TRACKED_DOCS; i++) {
      out.push(...ledger.admit(entry(`doc${i}`, 1, `first-${i}`), t0));
    }
    expect(out).toContain("stranded");
  });

  it("forgets everything when a session ends", () => {
    const ledger = new CaptureLedger();
    ledger.admit(entry("d1", 1), t0);
    ledger.reset();
    // The same document id could not recur in practice, but a ledger that
    // remembered a previous session would silently swallow the next one's first
    // step — the exact class of bug being fixed.
    expect(ledger.admit(entry("d1", 1, "next-session"), t0)).toEqual(["next-session"]);
  });
});
