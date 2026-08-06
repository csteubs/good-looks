// Stripping terminal escape sequences from run output.
//
// Playwright's `line` reporter redraws its progress line with cursor-up +
// erase-line and colours failures. Those bytes reached three places they had
// no business being: the Output panel rendered them as visible mojibake, the
// log file kept them forever, and — the one that cost real money — they were
// sent verbatim to the model in the Debug-with-AI prompt, spending context on
// cursor movements and giving the model garbage to reason about.
//
// Stripped at emitOutput, the same single choke point where redaction happens,
// for the same reason: doing it per-consumer means getting it right in three
// places forever.

import { describe, expect, it } from "vitest";

import { stripAnsi } from "./playwright-runner.js";

const ESC = String.fromCharCode(27);

describe("stripAnsi", () => {
  it("removes the cursor-up / erase-line pair the line reporter redraws with", () => {
    // Verbatim shape from a real run log.
    const raw = `${ESC}[1A${ESC}[2K[1/1] [chromium] > spec.ts:3:5 > 8.4.1`;
    expect(stripAnsi(raw)).toBe("[1/1] [chromium] > spec.ts:3:5 > 8.4.1");
  });

  it("removes colour codes without eating the text between them", () => {
    const raw = `    ${ESC}[31mTest timeout of 30000ms exceeded.${ESC}[39m`;
    expect(stripAnsi(raw)).toBe("    Test timeout of 30000ms exceeded.");
  });

  it("leaves ordinary output completely alone", () => {
    const raw = "Running 1 test using 1 worker\n\n  1 failed\n";
    expect(stripAnsi(raw)).toBe(raw);
  });

  it("does not eat square brackets that carry meaning", () => {
    // `[chromium]`, `[1/1]` and array syntax in an error all survive — a
    // regex that dropped a leading `[` would quietly corrupt every log line.
    const raw = "[1/1] [chromium] expected [1, 2, 3] to equal [1, 2]";
    expect(stripAnsi(raw)).toBe(raw);
  });

  it("handles multi-parameter and private-mode sequences", () => {
    expect(stripAnsi(`${ESC}[1;31;40mred${ESC}[0m`)).toBe("red");
    expect(stripAnsi(`${ESC}[?25lhidden cursor${ESC}[?25h`)).toBe("hidden cursor");
  });

  it("is a no-op on empty input", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("strips every occurrence, not just the first", () => {
    const raw = `${ESC}[2Ka${ESC}[2Kb${ESC}[2Kc`;
    expect(stripAnsi(raw)).toBe("abc");
  });

  it("measurably shrinks what the AI prompt would carry", () => {
    // Not cosmetic: this is prompt budget spent on cursor movements.
    const line = `${ESC}[1A${ESC}[2K[1/1] [chromium] > spec.ts:3:5 > test\n`;
    const raw = line.repeat(40);
    expect(stripAnsi(raw).length).toBeLessThan(raw.length);
    expect(stripAnsi(raw)).not.toContain(ESC);
  });
});
