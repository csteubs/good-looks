// Upload steps: setInputFiles against a STAGED path. The property that
// carries the feature is the shape guard — the staged path is a string that
// lands in EXECUTED source, so emission refuses anything that isn't exactly
// uploads/<safe>/<safe>, independently of the boundary (a forged value can
// arrive through updateStep's raw copy).

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpec } from "./spec-parser.js";
import { isSafeUploadRelPath, normalizeRawStep } from "../recorder/types.js";
import type { Step } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

const UPLOAD = (value: string): Step =>
  step({ type: "upload", locator: { k: "testid", v: "avatar" }, value });

function gen(steps: Step[]): string {
  return generateSpec({ name: "t", url: "https://x.test", steps } as Parameters<
    typeof generateSpec
  >[0]);
}

function shape(steps: Step[]): unknown[] {
  return steps.map(({ id: _i, timestamp: _t, ...rest }) => rest);
}

describe("the shape guard", () => {
  it("accepts exactly the staged form", () => {
    expect(isSafeUploadRelPath("uploads/t-123/report.csv")).toBe(true);
    expect(isSafeUploadRelPath("uploads/abc/a_b-c.2.png")).toBe(true);
  });

  it("refuses traversal, absolute, deep, and misrooted paths", () => {
    for (const bad of [
      "uploads/../secrets.txt",
      "uploads/t/../../x",
      "uploads/t/..",
      "/etc/passwd",
      "uploads/t/a/b.csv",
      "downloads/t/a.csv",
      "uploads/.hidden/a.csv",
      "uploads/t/",
      "uploads//a.csv",
      "",
      42,
      null,
    ]) {
      expect(isSafeUploadRelPath(bad), String(bad)).toBe(false);
    }
  });
});

describe("emission", () => {
  it("emits setInputFiles with the quoted staged path", () => {
    const src = gen([UPLOAD("uploads/t-1/report.csv")]);
    expect(src).toContain('await page.getByTestId("avatar").setInputFiles("uploads/t-1/report.csv");');
  });

  it("refuses a forged path as a problem, never as source", () => {
    const forged = UPLOAD("x");
    (forged as unknown as Record<string, unknown>).value = 'uploads/../../etc/passwd") //';
    const src = gen([forged]);
    expect(src).not.toContain("setInputFiles");
    expect(src).not.toContain("etc/passwd\")");
  });

  it("refuses an upload with no element", () => {
    const src = gen([step({ type: "upload", value: "uploads/t/a.csv" })]);
    expect(src).not.toContain("setInputFiles");
  });
});

describe("the boundary", () => {
  it("carries the value through normalize like any string field", () => {
    const raw = normalizeRawStep({
      type: "upload",
      locator: { k: "testid", v: "f" },
      value: "uploads/t/a.csv",
    });
    expect(raw?.value).toBe("uploads/t/a.csv");
  });
});

describe("round-trip", () => {
  it("reads the emitted call back as the same step", () => {
    const steps = [UPLOAD("uploads/t-1/data.json")];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });

  it("regeneration is a fixed point", () => {
    const once = gen([UPLOAD("uploads/t-1/a.csv")]);
    expect(gen(parseSpec(once))).toBe(once);
  });

  it("counts a foreign setInputFiles as skipped rather than half-reading it", () => {
    // Arrays, buffers, and paths outside uploads/ have no counterpart the
    // generator would re-emit — reading them into a step would silently DROP
    // the call on the next regeneration.
    const src = gen([UPLOAD("uploads/t-1/a.csv")])
      .replace('"uploads/t-1/a.csv"', '"/tmp/anything.csv"');
    expect(parseSpec(src).some((s) => s.type === "upload")).toBe(false);
  });

  it("round-trips disabled and continue-on-failure uploads", () => {
    const steps = [
      UPLOAD("uploads/t-1/a.csv"),
      step({
        type: "upload",
        locator: { k: "testid", v: "avatar" },
        value: "uploads/t-1/b.csv",
        continueOnFailure: true,
      }),
    ];
    steps[0].disabled = true;
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });
});
