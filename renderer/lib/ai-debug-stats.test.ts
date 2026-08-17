// The AI Debug arithmetic.
//
// NODE PROJECT — no React, no jsdom, no query layer. Same reasoning as
// `stats-categories.test.ts`: what this module can get wrong is a NUMBER, and a
// component test is worst at noticing one. A savings panel reading "4.5 h" is
// indistinguishable on screen from one reading "45 min".
//
// The cases that matter most here are the ones where an honest answer is
// smaller than a flattering one: a fix that was reverted, a fix counted twice
// because it was both accepted and confirmed, and a wait that nobody
// subtracted. Each of those has a test that fails if the arithmetic drifts
// towards the sales pitch.

import { describe, it, expect } from "vitest";

import {
  aiDebugFinding,
  buildAiDebugReport,
  countOutcomes,
  durationOf,
  isLocalProvider,
  summariseByTest,
  summariseErrors,
  summariseFixes,
  summariseLocalUse,
  summariseSavings,
  summariseTiming,
  summariseTrend,
  CHARS_PER_TOKEN,
  CONFIRMATION_WINDOW_MS,
  TREND_WINDOW_MS,
} from "./ai-debug-stats";
import type {
  AiDebugHistoryRecord,
  RunRecord,
  ScriptChangeListEntry,
} from "./recorder-types";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ── Fixtures ──────────────────────────────────────────────────────────

function rec(over: Partial<AiDebugHistoryRecord> & { id: string }): AiDebugHistoryRecord {
  return {
    key: "run:t1",
    kind: "run",
    testId: "t1",
    testName: "Alpha",
    trigger: "manual",
    provider: "ollama",
    model: "qwen",
    status: "done",
    errorKind: null,
    startedAt: NOW - HOUR,
    endedAt: NOW - HOUR + 30_000,
    firstTokenMs: 2_000,
    promptChars: 4_000,
    answerChars: 400,
    runKey: null,
    ...over,
  };
}

function change(
  over: Partial<ScriptChangeListEntry> & { id: string },
): ScriptChangeListEntry {
  return {
    testId: "t1",
    testName: "Alpha",
    origin: "ai-debug",
    reviewed: true,
    before: "old",
    after: "new",
    addedLines: 1,
    removedLines: 1,
    status: "pending",
    at: NOW - HOUR,
    ...over,
  } as ScriptChangeListEntry;
}

function run(over: Partial<RunRecord> & { id: string }): RunRecord {
  return {
    testId: "t1",
    testName: "Alpha",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    startedAt: NOW - 30 * MINUTE,
    finishedAt: NOW - 29 * MINUTE,
    durationMs: MINUTE,
    logFile: `${over.id}.log`,
    logBytes: 10,
    ...over,
  } as RunRecord;
}

const ASSUMPTIONS = { minutesPerManualDebug: 15, hourlyRate: 0 };

// ── Outcomes and timing ───────────────────────────────────────────────

describe("outcomes", () => {
  it("counts each ending, and keeps live attempts out of all of them", () => {
    const counts = countOutcomes([
      rec({ id: "a" }),
      rec({ id: "b", status: "error" }),
      rec({ id: "c", status: "cancelled" }),
      rec({ id: "d", status: "interrupted" }),
      rec({ id: "e", status: "streaming", endedAt: null }),
    ]);
    expect(counts).toEqual({ done: 1, error: 1, cancelled: 1, interrupted: 1, live: 1 });
  });
});

describe("timing", () => {
  it("totals only settled attempts — a live one has no duration yet", () => {
    const timing = summariseTiming([
      rec({ id: "a", startedAt: NOW, endedAt: NOW + 10_000 }),
      rec({ id: "b", startedAt: NOW, endedAt: NOW + 30_000 }),
      // Still running. Counting it would mean charging the whole time since it
      // started to a job that may yet answer in a second.
      rec({ id: "c", status: "streaming", startedAt: NOW - HOUR, endedAt: null }),
    ]);
    expect(timing.totalMs).toBe(40_000);
    expect(timing.settled).toBe(2);
    expect(timing.longestMs).toBe(30_000);
    expect(timing.medianMs).toBe(20_000);
  });

  it("reports no median at all rather than zero when nothing settled", () => {
    // The file's first rule: "never measured" and "measured nothing" must not
    // produce the same figure. A median of 0 would read as "instant".
    const timing = summariseTiming([rec({ id: "a", status: "streaming", endedAt: null })]);
    expect(timing.medianMs).toBeNull();
    expect(timing.longestMs).toBeNull();
    expect(timing.totalMs).toBe(0);
  });

  it("reports no first-token median when nothing ever arrived", () => {
    const timing = summariseTiming([
      rec({ id: "a", status: "error", firstTokenMs: null }),
      rec({ id: "b", status: "error", firstTokenMs: null }),
    ]);
    expect(timing.medianFirstTokenMs).toBeNull();
  });

  it("treats a record with no end as having no duration", () => {
    expect(durationOf(rec({ id: "a", endedAt: null }))).toBeNull();
  });
});

// ── Fixes ─────────────────────────────────────────────────────────────

describe("fixes", () => {
  it("ignores changes that did not come from AI Debug", () => {
    const fixes = summariseFixes(
      [change({ id: "c1", origin: "manual", status: "accepted" })],
      [],
    );
    expect(fixes.applied).toBe(0);
  });

  it("counts a fix the next run passed as confirmed", () => {
    const fixes = summariseFixes(
      [change({ id: "c1", at: NOW - HOUR, status: "pending" })],
      [run({ id: "r1", startedAt: NOW - 30 * MINUTE, status: "passed" })],
    );
    expect(fixes.confirmed).toBe(1);
    expect(fixes.refuted).toBe(0);
    expect(fixes.unproven).toBe(0);
  });

  it("counts a fix the next run still failed as refuted", () => {
    const fixes = summariseFixes(
      [change({ id: "c1", at: NOW - HOUR })],
      [run({ id: "r1", startedAt: NOW - 30 * MINUTE, status: "failed" })],
    );
    expect(fixes.refuted).toBe(1);
    expect(fixes.confirmed).toBe(0);
  });

  it("leaves a fix with no run after it unproven, not confirmed", () => {
    // The interesting direction: silence is not agreement. A fix nobody has
    // re-run yet must not be counted as evidence the model was right.
    const fixes = summariseFixes(
      [change({ id: "c1", at: NOW - MINUTE })],
      [run({ id: "r1", startedAt: NOW - HOUR, status: "passed" })],
    );
    expect(fixes.unproven).toBe(1);
    expect(fixes.confirmed).toBe(0);
  });

  it("does not let a pass long afterwards confirm a fix", () => {
    const fixes = summariseFixes(
      [change({ id: "c1", at: NOW - 10 * 24 * HOUR })],
      [
        run({
          id: "r1",
          startedAt: NOW - 10 * 24 * HOUR + CONFIRMATION_WINDOW_MS + MINUTE,
          status: "passed",
        }),
      ],
    );
    expect(fixes.confirmed).toBe(0);
    expect(fixes.unproven).toBe(1);
  });

  it("counts a fix once when it was both accepted and confirmed", () => {
    // THE DOUBLE-COUNT. `accepted + confirmed` would report one fix as two, and
    // the savings figure would drift upwards by exactly the number of times the
    // feature worked properly.
    const fixes = summariseFixes(
      [change({ id: "c1", at: NOW - HOUR, status: "accepted" })],
      [run({ id: "r1", startedAt: NOW - 30 * MINUTE, status: "passed" })],
    );
    expect(fixes.accepted).toBe(1);
    expect(fixes.confirmed).toBe(1);
    expect(fixes.kept).toBe(1);
  });

  it("never counts a reverted fix as kept, however the run went", () => {
    const fixes = summariseFixes(
      [change({ id: "c1", at: NOW - HOUR, status: "reverted" })],
      [run({ id: "r1", startedAt: NOW - 30 * MINUTE, status: "passed" })],
    );
    expect(fixes.reverted).toBe(1);
    expect(fixes.kept).toBe(0);
  });

  it("counts an unread auto-applied fix as unreviewed", () => {
    const fixes = summariseFixes(
      [change({ id: "c1", reviewed: false, status: "pending" })],
      [],
    );
    expect(fixes.unreviewed).toBe(1);
  });

  it("stops calling a fix unreviewed once it has been settled", () => {
    // Reverting one IS dealing with it. Leaving it in the queue would keep the
    // tile amber over a decision the user has already made.
    const fixes = summariseFixes(
      [change({ id: "c1", reviewed: false, status: "reverted" })],
      [],
    );
    expect(fixes.unreviewed).toBe(0);
  });

  it("matches a run to the fix's own test only", () => {
    const fixes = summariseFixes(
      [change({ id: "c1", testId: "t1", at: NOW - HOUR })],
      [run({ id: "r1", testId: "t2", startedAt: NOW - 30 * MINUTE, status: "passed" })],
    );
    expect(fixes.confirmed).toBe(0);
    expect(fixes.unproven).toBe(1);
  });

  it("does not let a baseline update stand in for a run", () => {
    const fixes = summariseFixes(
      [change({ id: "c1", at: NOW - HOUR })],
      [
        run({
          id: "r1",
          startedAt: NOW - 30 * MINUTE,
          status: "passed",
          kind: "baseline-update",
        }),
      ],
    );
    expect(fixes.confirmed).toBe(0);
  });
});

// ── Savings ───────────────────────────────────────────────────────────

describe("savings", () => {
  const timing = (totalMs: number) =>
    summariseTiming([rec({ id: "t", startedAt: NOW, endedAt: NOW + totalMs })]);

  it("claims nothing for sessions whose answers were never kept", () => {
    const fixes = summariseFixes([], []);
    const savings = summariseSavings(fixes, timing(5 * MINUTE), ASSUMPTIONS);
    expect(savings.countedFixes).toBe(0);
    expect(savings.grossMinutes).toBe(0);
    // Waited five minutes and kept nothing: this is a net LOSS, and saying so
    // is the point.
    expect(savings.netMinutes).toBe(-5);
  });

  it("subtracts the wait from the time a kept fix stands in for", () => {
    const fixes = summariseFixes(
      [change({ id: "c1", at: NOW - HOUR, status: "accepted" })],
      [],
    );
    const savings = summariseSavings(fixes, timing(2 * MINUTE), ASSUMPTIONS);
    expect(savings.grossMinutes).toBe(15);
    expect(savings.waitedMinutes).toBe(2);
    expect(savings.netMinutes).toBe(13);
  });

  it("says nothing in money until an hourly rate is stated", () => {
    const fixes = summariseFixes(
      [change({ id: "c1", status: "accepted" })],
      [],
    );
    expect(summariseSavings(fixes, timing(0), ASSUMPTIONS).netValue).toBeNull();
  });

  it("converts at the stated rate once there is one", () => {
    const fixes = summariseFixes([change({ id: "c1", status: "accepted" })], []);
    const savings = summariseSavings(fixes, timing(0), {
      minutesPerManualDebug: 30,
      hourlyRate: 100,
    });
    // Half an hour at 100 an hour.
    expect(savings.netValue).toBe(50);
  });
});

// ── Local versus hosted ───────────────────────────────────────────────

describe("local use", () => {
  it("knows which providers run on your own machine", () => {
    expect(isLocalProvider("ollama")).toBe(true);
    expect(isLocalProvider("lmstudio")).toBe(true);
    expect(isLocalProvider("anthropic")).toBe(false);
    expect(isLocalProvider(null)).toBe(false);
  });

  it("counts an unstamped record as neither local nor hosted", () => {
    // The one that would corrupt the headline: guessing "local" for records
    // written before the provider was stamped would report hosted calls as
    // avoided when they were made.
    const split = summariseLocalUse([
      rec({ id: "a", provider: "ollama" }),
      rec({ id: "b", provider: "anthropic" }),
      rec({ id: "c", provider: null }),
    ]);
    expect(split).toMatchObject({ local: 1, hosted: 1, unknown: 1 });
  });

  it("estimates tokens from characters, on the side they were spent", () => {
    const split = summariseLocalUse([
      rec({ id: "a", provider: "ollama", promptChars: 400, answerChars: 400 }),
      rec({ id: "b", provider: "anthropic", promptChars: 40, answerChars: 0 }),
    ]);
    expect(split.localTokens).toBe(800 / CHARS_PER_TOKEN);
    expect(split.hostedTokens).toBe(10);
  });
});

// ── Errors ────────────────────────────────────────────────────────────

describe("errors", () => {
  it("groups failures by kind, commonest first, with a remedy on each", () => {
    const rows = summariseErrors([
      rec({ id: "a", status: "error", errorKind: "connection" }),
      rec({ id: "b", status: "error", errorKind: "connection" }),
      rec({ id: "c", status: "error", errorKind: "empty-response" }),
      rec({ id: "d", status: "done" }),
    ]);
    expect(rows.map((r) => [r.kind, r.count])).toEqual([
      ["connection", 2],
      ["empty-response", 1],
    ]);
    expect(rows[0].fix).toContain("Settings → AI");
  });

  it("keeps an unclassified failure as its own row", () => {
    // A send that threw before reaching a provider has no kind. Folding it into
    // another bucket would blame a cause nobody diagnosed.
    const rows = summariseErrors([rec({ id: "a", status: "error", errorKind: null })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("unknown");
  });
});

// ── Trend ─────────────────────────────────────────────────────────────

describe("trend", () => {
  it("splits into this window and the one before it", () => {
    const trend = summariseTrend(
      [
        rec({ id: "a", startedAt: NOW - HOUR }),
        rec({ id: "b", startedAt: NOW - TREND_WINDOW_MS - HOUR }),
        // Older than both windows — in neither half.
        rec({ id: "c", startedAt: NOW - 3 * TREND_WINDOW_MS }),
      ],
      NOW,
    );
    expect(trend.recent.attempts).toBe(1);
    expect(trend.previous.attempts).toBe(1);
    expect(trend.comparable).toBe(true);
  });

  it("refuses to compare against a window with nothing in it", () => {
    const trend = summariseTrend([rec({ id: "a", startedAt: NOW - HOUR })], NOW);
    expect(trend.comparable).toBe(false);
    expect(trend.previous.answeredRate).toBeNull();
  });
});

// ── Per test ──────────────────────────────────────────────────────────

describe("by test", () => {
  it("orders by how often each test was debugged", () => {
    const rows = summariseByTest([
      rec({ id: "a", testId: "t1" }),
      rec({ id: "b", testId: "t1" }),
      rec({ id: "c", testId: "t2", testName: "Beta" }),
    ]);
    expect(rows.map((r) => r.testId)).toEqual(["t1", "t2"]);
    expect(rows[0].attempts).toBe(2);
  });

  it("names a renamed test by its newest record", () => {
    const rows = summariseByTest([
      rec({ id: "a", testId: "t1", testName: "Old name", startedAt: NOW - HOUR }),
      rec({ id: "b", testId: "t1", testName: "New name", startedAt: NOW }),
    ]);
    expect(rows[0].testName).toBe("New name");
  });

  it("keeps a deleted test in the list, marked", () => {
    // Its attempts are inside every total on the screen above, so dropping the
    // row would make the list disagree with the summary.
    const rows = summariseByTest([rec({ id: "a", testDeleted: true })]);
    expect(rows[0].testDeleted).toBe(true);
  });
});

// ── The finding rule ──────────────────────────────────────────────────

describe("the finding", () => {
  const report = (
    records: AiDebugHistoryRecord[],
    changes: ScriptChangeListEntry[] = [],
    runs: RunRecord[] = [],
  ) =>
    buildAiDebugReport({
      records,
      scriptChanges: changes,
      runs,
      assumptions: ASSUMPTIONS,
      now: NOW,
    });

  it("says nothing when everything is answered and reviewed", () => {
    expect(aiDebugFinding(report([rec({ id: "a" })]))).toBeNull();
  });

  it("raises unreviewed fixes first", () => {
    const finding = aiDebugFinding(
      report([rec({ id: "a" })], [change({ id: "c1", reviewed: false, status: "pending" })]),
    );
    expect(finding?.id).toBe("unreviewed-fixes");
    expect(finding?.say).toContain("not been reviewed");
  });

  it("raises a high failure rate once there are enough attempts to have one", () => {
    const failing = Array.from({ length: 6 }, (_, i) =>
      rec({ id: `e${i}`, status: i < 3 ? "error" : "done" }),
    );
    expect(aiDebugFinding(report(failing))?.id).toBe("failing-sessions");
  });

  it("calls one failure out of two an anecdote rather than a rate", () => {
    // A ratio over a sample this small is not a ratio. The same floor
    // `cost-model.ts` puts on "never caught anything".
    const few = [rec({ id: "a", status: "error" }), rec({ id: "b", status: "done" })];
    expect(aiDebugFinding(report(few))).toBeNull();
  });

  it("measures the failure rate against settled attempts, not live ones", () => {
    // A job still streaming has not failed and has not succeeded. Dividing by
    // every attempt would DILUTE a real problem out of existence: three
    // failures in five finished attempts is a provider worth looking at, and
    // ten jobs currently running do not make it less so.
    const records = [
      ...Array.from({ length: 3 }, (_, i) => rec({ id: `e${i}`, status: "error" as const })),
      ...Array.from({ length: 2 }, (_, i) => rec({ id: `d${i}`, status: "done" as const })),
      ...Array.from({ length: 10 }, (_, i) =>
        rec({ id: `s${i}`, status: "streaming" as const, endedAt: null }),
      ),
    ];
    const finding = aiDebugFinding(report(records));
    expect(finding?.id).toBe("failing-sessions");
    // And it says so in the honest denominator too.
    expect(finding?.say).toContain("of 5 attempts");
  });
});

// ── The whole report ──────────────────────────────────────────────────

describe("the report", () => {
  it("says when the history starts, because a lifetime total has one", () => {
    const built = buildAiDebugReport({
      records: [rec({ id: "a", startedAt: NOW - 5 * HOUR }), rec({ id: "b", startedAt: NOW })],
      scriptChanges: [],
      runs: [],
      assumptions: ASSUMPTIONS,
      now: NOW,
    });
    expect(built.firstAt).toBe(NOW - 5 * HOUR);
    expect(built.attempts).toBe(2);
  });

  it("has nothing to report from an empty history", () => {
    const built = buildAiDebugReport({
      records: [],
      scriptChanges: [],
      runs: [],
      assumptions: ASSUMPTIONS,
      now: NOW,
    });
    expect(built.firstAt).toBeNull();
    expect(built.timing.medianMs).toBeNull();
    expect(built.savings.countedFixes).toBe(0);
  });
});
