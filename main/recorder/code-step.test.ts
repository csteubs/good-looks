// The fenced code step's two boundaries: the page path refuses it, the IPC
// path rebuilds it field by field with the body capped.

import { describe, it, expect } from "vitest";

import { MAX_CODE_CHARS, normalizeRawStep, normalizeRawSteps, normalizeStep } from "./types.js";

describe("code step ingest", () => {
  it("is refused on the page path, even as a well-formed step", () => {
    expect(normalizeRawStep({ type: "code", code: 'require("child_process")' })).toBeNull();
    expect(normalizeRawSteps([{ type: "code", code: "x" }, { type: "click", locator: { k: "testid", v: "a" } }])).toHaveLength(1);
  });

  it("is rebuilt on the IPC path: known fields only, the body capped", () => {
    const out = normalizeStep({ id: "s1", type: "code", code: "await page.mouse.wheel(0, 100);", label: "scroll a bit", disabled: true, extra: "no", locator: { k: "css", v: "x" } });
    expect(out).toEqual({ id: "s1", type: "code", code: "await page.mouse.wheel(0, 100);", label: "scroll a bit", disabled: true, timestamp: 0 });
    expect(normalizeStep({ id: "s2", type: "code" })).toBeNull();
    expect(normalizeStep({ id: "s3", type: "code", code: "x".repeat(MAX_CODE_CHARS + 5) })?.code).toHaveLength(MAX_CODE_CHARS);
  });
});
