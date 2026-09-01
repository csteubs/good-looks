// The two validators between the heal fixture's page-derived evidence and the
// heal journal. Both fields come from a page the app does not control — the
// URL via `page.url()`, the rect via a measured bounding box — and both are
// narrowed on the way in: a doubtful value drops the FIELD, never the entry.
//
// The direction each rule fails matters, so every rule is tested both ways.

import { describe, expect, it } from "vitest";

import { ELIDED } from "../../shared/log-capture-source.mjs";
import { normalizeHealPageUrl, normalizeHealRect } from "./types.js";

describe("normalizeHealPageUrl", () => {
  it("keeps an ordinary page address, query and hash included", () => {
    expect(normalizeHealPageUrl("https://shop.example.test/checkout?page=2&q=shoes#top")).toBe(
      "https://shop.example.test/checkout?page=2&q=shoes#top",
    );
  });

  it("elides sensitive query VALUES by name and keeps the rest", () => {
    const out = normalizeHealPageUrl("https://a.test/cb?token=abc123&page=2&Code=xyz");
    expect(out).toContain("page=2");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("xyz");
    // The names survive — a reader can still see WHICH parameters were there.
    expect(out).toContain("token=");
    expect(out).toContain("Code=");
    expect(out).toContain(encodeURIComponent(ELIDED));
  });

  it("rejects an over-long URL whole rather than truncating it", () => {
    // A cut URL is a plausible URL for somewhere else; absent is honestly
    // unknown. Same rule as run-provenance.
    const long = "https://a.test/" + "x".repeat(2100);
    expect(normalizeHealPageUrl(long)).toBeNull();
  });

  it("rejects every non-http(s) scheme", () => {
    expect(normalizeHealPageUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeHealPageUrl("data:text/html,hi")).toBeNull();
    expect(normalizeHealPageUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeHealPageUrl("about:blank")).toBeNull();
  });

  it("rejects control characters, non-strings and the empty string", () => {
    // Built via fromCharCode so no raw control byte ever sits in this file.
    expect(normalizeHealPageUrl("https://a.test/" + String.fromCharCode(0) + "x")).toBeNull();
    expect(normalizeHealPageUrl("https://a.test/" + String.fromCharCode(9) + "x")).toBeNull();
    expect(normalizeHealPageUrl("https://a.test/" + String.fromCharCode(10) + "x")).toBeNull();
    expect(normalizeHealPageUrl("https://a.test/" + String.fromCharCode(127) + "x")).toBeNull();
    expect(normalizeHealPageUrl(42)).toBeNull();
    expect(normalizeHealPageUrl(null)).toBeNull();
    expect(normalizeHealPageUrl("")).toBeNull();
    expect(normalizeHealPageUrl("not a url")).toBeNull();
  });
});

describe("normalizeHealRect", () => {
  it("keeps a normalized box and REBUILDS it — unknown keys do not ride along", () => {
    const out = normalizeHealRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.4, extra: "smuggled" });
    expect(out).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  it("accepts the edges of the range", () => {
    expect(normalizeHealRect({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("rejects a member that is not a finite number", () => {
    expect(normalizeHealRect({ x: "0.1", y: 0.2, w: 0.3, h: 0.4 })).toBeNull();
    expect(normalizeHealRect({ x: NaN, y: 0.2, w: 0.3, h: 0.4 })).toBeNull();
    expect(normalizeHealRect({ x: Infinity, y: 0.2, w: 0.3, h: 0.4 })).toBeNull();
  });

  it("rejects a missing member rather than defaulting it", () => {
    expect(normalizeHealRect({ x: 0.1, y: 0.2, w: 0.3 })).toBeNull();
  });

  it("rejects values off the 0-1 scale — a doubtful rect draws no box", () => {
    expect(normalizeHealRect({ x: -0.1, y: 0.2, w: 0.3, h: 0.4 })).toBeNull();
    expect(normalizeHealRect({ x: 1.5, y: 0.2, w: 0.3, h: 0.4 })).toBeNull();
    expect(normalizeHealRect({ x: 0.1, y: 0.2, w: 1.5, h: 0.4 })).toBeNull();
  });

  it("rejects a zero-area box — a highlight with nothing behind it", () => {
    expect(normalizeHealRect({ x: 0.1, y: 0.2, w: 0, h: 0.4 })).toBeNull();
    expect(normalizeHealRect({ x: 0.1, y: 0.2, w: 0.3, h: 0 })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(normalizeHealRect(null)).toBeNull();
    expect(normalizeHealRect([0.1, 0.2, 0.3, 0.4])).toBeNull();
    expect(normalizeHealRect("rect")).toBeNull();
  });
});
