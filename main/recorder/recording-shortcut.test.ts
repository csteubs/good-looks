import { describe, expect, it } from "vitest";

import { isRecordingToggleInput, recordingToggleAction } from "./recording-shortcut";

const key = (over: Partial<Parameters<typeof isRecordingToggleInput>[0]> = {}) => ({
  type: "keyDown",
  key: "r",
  ...over,
});

describe("isRecordingToggleInput", () => {
  it("matches ⌘R (meta) and Ctrl+R (control)", () => {
    expect(isRecordingToggleInput(key({ meta: true }))).toBe(true);
    expect(isRecordingToggleInput(key({ control: true }))).toBe(true);
  });

  it("matches the capital spelling a shifted-off layout can deliver", () => {
    expect(isRecordingToggleInput(key({ meta: true, key: "R" }))).toBe(true);
  });

  it("ignores a bare R — typing into the page must never toggle", () => {
    expect(isRecordingToggleInput(key())).toBe(false);
  });

  it("ignores keyUp: the toggle fires once per press, on the way down", () => {
    expect(isRecordingToggleInput(key({ meta: true, type: "keyUp" }))).toBe(false);
  });

  it("ignores auto-repeat — a held key must not strobe the session", () => {
    expect(isRecordingToggleInput(key({ meta: true, isAutoRepeat: true }))).toBe(false);
  });

  it("lets ⌘⇧R fall through: force reload stays the escape hatch", () => {
    expect(isRecordingToggleInput(key({ meta: true, shift: true }))).toBe(false);
  });

  it("lets ⌥-modified chords fall through", () => {
    expect(isRecordingToggleInput(key({ meta: true, alt: true }))).toBe(false);
  });

  it("ignores other keys under the same modifier", () => {
    expect(isRecordingToggleInput(key({ meta: true, key: "p" }))).toBe(false);
    expect(isRecordingToggleInput(key({ meta: true, key: undefined }))).toBe(false);
  });
});

describe("recordingToggleAction", () => {
  const live = { hasSession: true, pageReady: true, replaying: false, refineMode: false };

  it("falls through to Reload only when there is NO session", () => {
    expect(recordingToggleAction({ ...live, hasSession: false })).toBe("fallthrough");
    // Even with the other flags in "unusable" positions — no session, no claim.
    expect(
      recordingToggleAction({ hasSession: false, pageReady: false, replaying: true, refineMode: true }),
    ).toBe("fallthrough");
  });

  it("toggles a live, ready, idle session", () => {
    expect(recordingToggleAction(live)).toBe("toggle");
  });

  it("consumes — never reloads — while the page is still loading", () => {
    // The failure this branch guards: a fall-through here hands the chord to
    // View → Reload, which tears down the window showing the session, on the
    // exact transient state where the user is most likely to mash the key.
    expect(recordingToggleAction({ ...live, pageReady: false })).toBe("consume");
  });

  it("consumes while a replay owns the window", () => {
    // withCaptureSuspended saves and restores session.paused; a toggle here
    // would be silently unwound when the replay exits.
    expect(recordingToggleAction({ ...live, replaying: true })).toBe("consume");
  });

  it("consumes while the Refine picker is armed", () => {
    // startRefine pauses and endRefine restores — refine owns the flag the
    // way a replay does, and a resume mid-pick runs capture live behind the
    // review dialog, recording keystrokes the user makes lining up the pick.
    expect(recordingToggleAction({ ...live, refineMode: true })).toBe("consume");
  });
});
