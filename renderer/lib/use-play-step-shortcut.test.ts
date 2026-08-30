// The matcher only. The hook half is exercised where it has a window and a
// view around it — recording-view.test.tsx and trainer-panel-view.test.tsx —
// because this file runs in the NODE project (renderer/lib/**/*.test.ts),
// where there is no DOM to dispatch a keydown into.

import { describe, expect, it } from "vitest";

import { isPlayStepChord } from "./use-play-step-shortcut";

const chord = (over: Partial<Parameters<typeof isPlayStepChord>[0]> = {}) => ({
  key: "p",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("isPlayStepChord", () => {
  it("matches ⌘P and Ctrl+P", () => {
    expect(isPlayStepChord(chord({ metaKey: true }))).toBe(true);
    expect(isPlayStepChord(chord({ ctrlKey: true }))).toBe(true);
    expect(isPlayStepChord(chord({ metaKey: true, key: "P" }))).toBe(true);
  });

  it("ignores a bare p — it is a character, and fields get to keep it", () => {
    expect(isPlayStepChord(chord())).toBe(false);
  });

  it("ignores extra modifiers and auto-repeat", () => {
    expect(isPlayStepChord(chord({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isPlayStepChord(chord({ metaKey: true, altKey: true }))).toBe(false);
    expect(isPlayStepChord(chord({ metaKey: true, repeat: true }))).toBe(false);
  });

  it("ignores other keys under the same modifier", () => {
    expect(isPlayStepChord(chord({ metaKey: true, key: "r" }))).toBe(false);
  });
});
