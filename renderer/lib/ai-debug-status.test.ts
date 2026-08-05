// The status → colour mapping is the whole user-facing contract of minimizing:
// blue means "ready for you", orange means "still thinking", green means
// "answer waiting". A wrong colour here is a silent lie — the user walks away
// from a finished job or waits on one that already failed — so every state is
// pinned, including the two that only exist after an interruption.

import { describe, it, expect } from "vitest";

import { isTerminal, toneFor } from "./ai-debug-status";
import type { AiDebugStatus } from "./recorder-types";

const ALL: AiDebugStatus[] = ["idle", "streaming", "done", "error", "cancelled", "interrupted"];

describe("toneFor", () => {
  it("gives blue for a session waiting on the user", () => {
    expect(toneFor("idle").className).toBe("text-accent");
    expect(toneFor("idle").busy).toBe(false);
    expect(toneFor("idle").ready).toBe(false);
  });

  it("gives orange while the model is thinking", () => {
    const tone = toneFor("streaming");
    expect(tone.className).toBe("text-support-orange");
    expect(tone.busy).toBe(true);
    // Not ready: an in-progress answer is exactly what the user must NOT be
    // invited back for.
    expect(tone.ready).toBe(false);
  });

  it("gives green only when the job has finished", () => {
    const tone = toneFor("done");
    expect(tone.className).toBe("text-support-green");
    expect(tone.ready).toBe(true);
    expect(tone.busy).toBe(false);
    for (const status of ALL.filter((s) => s !== "done")) {
      expect(toneFor(status).ready).toBe(false);
    }
  });

  it("gives red for a failed request", () => {
    expect(toneFor("error").className).toBe("text-support-red");
  });

  it("treats a stopped or interrupted session as ready for input, not as an error", () => {
    // Deliberate: nothing is broken in either case and the only action is to
    // send again, which is what blue means everywhere else in this mapping.
    expect(toneFor("cancelled").className).toBe("text-accent");
    expect(toneFor("interrupted").className).toBe("text-accent");
    expect(toneFor("interrupted").busy).toBe(false);
  });

  it("never leaves a status without a colour", () => {
    for (const status of ALL) {
      const tone = toneFor(status);
      expect(tone.className.length).toBeGreaterThan(0);
      expect(tone.label.length).toBeGreaterThan(0);
    }
  });

  it("gives every status a distinct label, so colour is never the only signal", () => {
    const labels = ALL.map((s) => toneFor(s).label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("throws rather than guessing on an unknown status", () => {
    // The compile-time guard is the real protection; this pins the runtime
    // half so a value arriving from disk can't silently render as some
    // arbitrary default tone.
    expect(() => toneFor("nonsense" as AiDebugStatus)).toThrow(/Unhandled AI debug status/);
  });
});

describe("isTerminal", () => {
  it("counts only states that hold no live request", () => {
    expect(isTerminal("streaming")).toBe(false);
    // Idle is not terminal either: the session exists and is about to be sent,
    // so evicting it would strand a job the user just started.
    expect(isTerminal("idle")).toBe(false);
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("error")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("interrupted")).toBe(true);
  });
});
