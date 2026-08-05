// Rules for the set of AI debug sessions.
//
// Each of these has a failure mode that reads as data loss or a lying icon
// rather than as an error: a job evicted while still running, a chip showing
// "thinking" when an answer is already waiting, a diff applied over edits the
// model never saw, a cap that locks the user out of the session they're
// looking at. That's why they're pure and pinned this closely.

import { describe, it, expect } from "vitest";

import {
  MAX_ACTIVE_STREAMS,
  MAX_SESSIONS,
  aggregateStatus,
  canStartStream,
  hashScript,
  isStale,
  parseSessionKey,
  pruneSessions,
  runSessionKey,
  sortSessions,
  stepSessionKey,
  type SessionLike,
} from "./ai-debug-sessions";
import type { AiDebugStatus } from "./recorder-types";

function s(key: string, status: AiDebugStatus, startedAt = 0, updatedAt = startedAt): SessionLike {
  return { key, status, startedAt, updatedAt };
}

describe("session keys", () => {
  it("round-trips a run key", () => {
    const key = runSessionKey("t1");
    expect(parseSessionKey(key)).toEqual({ kind: "run", testId: "t1", stepIndex: null });
  });

  it("round-trips a step key", () => {
    const key = stepSessionKey("t1", 3);
    expect(parseSessionKey(key)).toEqual({ kind: "step", testId: "t1", stepIndex: 3 });
  });

  it("round-trips a test id that itself contains colons", () => {
    // Step keys are parsed from the LAST colon, so an id with colons in it must
    // not shear off part of the id and produce a session pointing at a
    // different test.
    const key = stepSessionKey("a:b:c", 12);
    expect(parseSessionKey(key)).toEqual({ kind: "step", testId: "a:b:c", stepIndex: 12 });
  });

  it("keeps run and step keys for the same test distinct", () => {
    expect(runSessionKey("t1")).not.toBe(stepSessionKey("t1", 0));
  });

  it("returns null for anything malformed rather than inventing a session", () => {
    expect(parseSessionKey("")).toBeNull();
    expect(parseSessionKey("run:")).toBeNull();
    expect(parseSessionKey("step:t1")).toBeNull();
    expect(parseSessionKey("step::4")).toBeNull();
    expect(parseSessionKey("step:t1:notanumber")).toBeNull();
    expect(parseSessionKey("step:t1:-1")).toBeNull();
    expect(parseSessionKey("step:t1:1.5")).toBeNull();
    expect(parseSessionKey("other:t1")).toBeNull();
  });
});

describe("hashScript / isStale", () => {
  it("is stable for the same text and different for changed text", () => {
    expect(hashScript("a")).toBe(hashScript("a"));
    expect(hashScript("a")).not.toBe(hashScript("b"));
  });

  it("distinguishes transpositions", () => {
    // A hash that only summed characters would call these equal, and a script
    // edit that reorders lines would then apply silently.
    expect(hashScript("ab")).not.toBe(hashScript("ba"));
  });

  it("handles an empty script without collapsing to a shared value", () => {
    expect(hashScript("")).not.toBe(hashScript(" "));
    expect(hashScript("")).toHaveLength(8);
  });

  it("flags a script edited since the prompt was built", () => {
    const session = { scriptHash: hashScript("original") };
    expect(isStale(session, "original")).toBe(false);
    expect(isStale(session, "edited")).toBe(true);
  });

  it("does not cry stale when either side is unknown", () => {
    // A session predating hashing, or a script that hasn't loaded yet, must not
    // raise a false alarm on every restore — a warning that always fires is a
    // warning nobody reads.
    expect(isStale({ scriptHash: null }, "anything")).toBe(false);
    expect(isStale({ scriptHash: hashScript("x") }, null)).toBe(false);
  });
});

describe("canStartStream", () => {
  it("allows a stream below the cap", () => {
    expect(canStartStream([s("a", "streaming")], "b")).toEqual({ ok: true });
  });

  it("refuses once the cap is reached, naming the oldest to stop", () => {
    const sessions = [s("a", "streaming", 100), s("b", "streaming", 50)];
    const decision = canStartStream(sessions, "c");
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("at-capacity");
      // Oldest by START time, not by list order — that's the one whose slot is
      // most reasonable to reclaim.
      expect(decision.oldestStreamingKey).toBe("b");
    }
  });

  it("never counts a session against itself", () => {
    // Restarting the session you're looking at replaces its own request. If it
    // counted toward the cap, "Regenerate" would refuse on the very dialog the
    // user has open.
    const sessions = [s("a", "streaming", 1), s("b", "streaming", 2)];
    expect(canStartStream(sessions, "a")).toEqual({ ok: true });
  });

  it("ignores terminal sessions entirely", () => {
    const sessions = [
      s("a", "done"),
      s("b", "error"),
      s("c", "cancelled"),
      s("d", "interrupted"),
      s("e", "idle"),
    ];
    expect(canStartStream(sessions, "new")).toEqual({ ok: true });
  });

  it("has a cap above one, so a single job can't block the trainer", () => {
    expect(MAX_ACTIVE_STREAMS).toBeGreaterThanOrEqual(2);
  });
});

describe("aggregateStatus", () => {
  it("is null with no sessions", () => {
    expect(aggregateStatus([])).toBeNull();
  });

  it("surfaces a finished job over a still-running one", () => {
    // The core promise of the feature: an answer that is ready must not hide
    // behind a job that is still thinking.
    expect(aggregateStatus([s("a", "streaming"), s("b", "done")])).toBe("done");
  });

  it("surfaces an error over everything else", () => {
    expect(aggregateStatus([s("a", "streaming"), s("b", "done"), s("c", "error")])).toBe("error");
  });

  it("prefers streaming over merely-idle work", () => {
    expect(aggregateStatus([s("a", "idle"), s("b", "streaming")])).toBe("streaming");
    expect(aggregateStatus([s("a", "idle"), s("b", "interrupted")])).toBe("interrupted");
  });

  it("falls back to the only status present", () => {
    expect(aggregateStatus([s("a", "idle")])).toBe("idle");
    expect(aggregateStatus([s("a", "cancelled")])).toBe("cancelled");
  });
});

describe("sortSessions", () => {
  it("orders by most recent activity", () => {
    const out = sortSessions([s("a", "done", 1, 10), s("b", "done", 1, 30), s("c", "done", 1, 20)]);
    expect(out.map((x) => x.key)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate its input", () => {
    const input = [s("a", "done", 1, 1), s("b", "done", 1, 2)];
    sortSessions(input);
    expect(input.map((x) => x.key)).toEqual(["a", "b"]);
  });
});

describe("pruneSessions", () => {
  it("keeps everything below the cap", () => {
    const input = [s("a", "done", 1, 1), s("b", "done", 1, 2)];
    expect(pruneSessions(input, 5)).toHaveLength(2);
  });

  it("drops the least recently active beyond the cap", () => {
    const input = [s("a", "done", 1, 10), s("b", "done", 1, 30), s("c", "done", 1, 20)];
    expect(pruneSessions(input, 2).map((x) => x.key)).toEqual(["b", "c"]);
  });

  it("never evicts a streaming session, however stale its timestamp", () => {
    // Dropping a live session strands its backend request with nobody holding
    // the requestId — it can never be cancelled, and on a hosted provider it
    // keeps billing. Age must not override that.
    const input = [
      s("old-live", "streaming", 1, 1),
      s("new1", "done", 1, 50),
      s("new2", "done", 1, 60),
    ];
    const kept = pruneSessions(input, 2).map((x) => x.key);
    expect(kept).toContain("old-live");
    expect(kept).toHaveLength(2);
  });

  it("never evicts an idle session either — it is about to be sent", () => {
    const input = [s("pending", "idle", 1, 1), s("a", "done", 1, 90), s("b", "done", 1, 80)];
    expect(pruneSessions(input, 2).map((x) => x.key)).toContain("pending");
  });

  it("keeps every live session even when they alone exceed the cap", () => {
    const input = [
      s("l1", "streaming", 1, 1),
      s("l2", "streaming", 1, 2),
      s("l3", "streaming", 1, 3),
    ];
    expect(pruneSessions(input, 2)).toHaveLength(3);
  });

  it("defaults to a cap that leaves room for real use", () => {
    expect(MAX_SESSIONS).toBeGreaterThanOrEqual(10);
  });
});
