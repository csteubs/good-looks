// What the AI Debug feature has been worth, arithmetically.
//
// PURE, AND IN `renderer/lib/` FOR THE SAME REASON `stats-categories.ts` IS:
// this project's node test suite can exercise it with no React, no jsdom and no
// query layer, and the failure this file exists to prevent is a WRONG NUMBER
// rather than a broken render. A component test is worst at noticing exactly
// that.
//
// FOUR RULES, each written against a way this screen could mislead.
//
// 1. "NEVER USED" AND "USED, FOUND NOTHING" ARE DIFFERENT ANSWERS. The rule
//    `renderer/lib/stats-categories.ts` opens with, applied one level down:
//    every figure here is null rather than 0 when there is nothing behind it.
//    A savings figure of "0h" reads as "the model wasted your time"; the truth
//    is usually "no diagnosis has been kept yet".
//
// 2. ONLY A KEPT FIX COUNTS AS TIME SAVED. A diagnosis nobody applied saved
//    nothing — you still did the work — and one that was applied and then
//    REVERTED cost time rather than saving it. So the savings figure is driven
//    by the script-change journal's own statuses, not by how many sessions
//    were run, and the model's own answer never votes on whether it was right.
//
// 3. THE WAIT IS SUBTRACTED. Time spent watching a model think is real time. A
//    "saved" figure that ignores it is the flattering kind, and this app's cost
//    model already refuses one of those (see `cost-model.ts` on why value is
//    reported in hours rather than money).
//
// 4. TOKENS ARE ADMITTED TO BE APPROXIMATE. Nothing here is told a token
//    count — no provider this app talks to reports one through the streaming
//    path — so the estimate is characters ÷ 4, the same approximation
//    `provider-errors.ts` already puts on screen, and every caller labels it.

import type {
  AiDebugHistoryRecord,
  RunRecord,
  ScriptChangeListEntry,
} from "./recorder-types";
import type { LlmErrorKind } from "./llm-types";

/** Characters per token. Rough on purpose and labelled everywhere it surfaces —
 *  it exists so a user can compare orders of magnitude, not to bill anyone. */
export const CHARS_PER_TOKEN = 4;

/** Providers that answer on the user's own machine. A record whose provider is
 *  null is UNKNOWN and is counted as neither: the local-versus-hosted split is
 *  precisely the figure a guess here would corrupt. */
export const LOCAL_PROVIDERS = ["ollama", "lmstudio"] as const;

export function isLocalProvider(provider: string | null): boolean {
  return provider !== null && (LOCAL_PROVIDERS as readonly string[]).includes(provider);
}

/** A record that settled. `streaming` rows are live attempts — counting their
 *  duration would mean counting from the start of time on a job still running. */
export function isSettled(rec: AiDebugHistoryRecord): boolean {
  return rec.endedAt !== null && rec.status !== "streaming";
}

/** How long this attempt took, or null while it is still live. */
export function durationOf(rec: AiDebugHistoryRecord): number | null {
  if (rec.endedAt === null) return null;
  return Math.max(0, rec.endedAt - rec.startedAt);
}

// ── Outcomes ──────────────────────────────────────────────────────────

/** The four ways an attempt ends, in the order a reader cares about them.
 *  `idle` and `streaming` are not outcomes and never appear here. */
export const OUTCOME_FACETS = ["done", "error", "cancelled", "interrupted"] as const;
export type OutcomeFacet = (typeof OUTCOME_FACETS)[number];

export function outcomeOf(rec: AiDebugHistoryRecord): OutcomeFacet | null {
  const status = rec.status;
  return (OUTCOME_FACETS as readonly string[]).includes(status) ? (status as OutcomeFacet) : null;
}

export interface OutcomeCounts {
  done: number;
  error: number;
  cancelled: number;
  interrupted: number;
  /** Attempts still in flight. Reported separately so they neither inflate the
   *  answered count nor read as failures. */
  live: number;
}

export function countOutcomes(records: AiDebugHistoryRecord[]): OutcomeCounts {
  const out: OutcomeCounts = { done: 0, error: 0, cancelled: 0, interrupted: 0, live: 0 };
  for (const rec of records) {
    const outcome = outcomeOf(rec);
    if (outcome) out[outcome]++;
    else out.live++;
  }
  return out;
}

// ── Timing ────────────────────────────────────────────────────────────

export interface TimingSummary {
  /** Total wall time spent waiting on the model, in ms, over settled attempts. */
  totalMs: number;
  /** Median attempt, and the longest one. Null when nothing has settled — a
   *  median over an empty set is not zero, it is no measurement. */
  medianMs: number | null;
  longestMs: number | null;
  /** Median wait before the first token arrived, over attempts that produced
   *  one. Null when none did, which is a real state: every attempt failed
   *  before the model said anything. */
  medianFirstTokenMs: number | null;
  /** How many attempts the figures above are drawn from. */
  settled: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function summariseTiming(records: AiDebugHistoryRecord[]): TimingSummary {
  const durations: number[] = [];
  for (const rec of records) {
    if (!isSettled(rec)) continue;
    const ms = durationOf(rec);
    if (ms !== null) durations.push(ms);
  }
  const firstTokens = records
    .map((r) => r.firstTokenMs)
    .filter((ms): ms is number => ms !== null);
  return {
    totalMs: durations.reduce((n, ms) => n + ms, 0),
    medianMs: median(durations),
    longestMs: durations.length > 0 ? Math.max(...durations) : null,
    medianFirstTokenMs: median(firstTokens),
    settled: durations.length,
  };
}

// ── Where the answers went ────────────────────────────────────────────
//
// THE EFFECTIVENESS SIGNAL, AND IT DELIBERATELY DOES NOT COME FROM THE MODEL.
// Whether a diagnosis was any good is answered by what the user did with it and
// by what the test did next — both recorded elsewhere, by the script-change
// journal and the run history. Asking the answer to grade itself is how a panel
// ends up reporting a 100% success rate for a feature nobody trusts.

/** How long after a fix lands a run still counts as "the run that followed it".
 *  A pass a week later says nothing about the change; the next execution does. */
export const CONFIRMATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface FixOutcomes {
  /** Script changes this app attributes to AI Debug. */
  applied: number;
  /** Of those, still waiting for somebody to look at them. */
  pending: number;
  /** Applied automatically and never read by anyone — the queue the tile turns
   *  amber for, and the one that grows when fixes stop being asked for. */
  unreviewed: number;
  accepted: number;
  reverted: number;
  /** Fixes followed, within the window, by a passing run of that test. The
   *  strongest evidence available that the diagnosis worked. */
  confirmed: number;
  /** Fixes followed by a FAILING run — the diagnosis did not work, whether or
   *  not anyone got round to reverting it. */
  refuted: number;
  /** Fixes with no run after them yet. Neither confirmed nor refuted, and
   *  counted separately so the two figures above are not read as a whole. */
  unproven: number;
  /**
   * Fixes the user (or the run after them) actually KEPT — the only ones any
   * saving is claimed for.
   *
   * COUNTED PER FIX, never as `accepted + confirmed`. A fix that was both
   * accepted and followed by a passing run is one fix; adding the two counters
   * would report it as two, and the savings figure would drift upwards by
   * exactly the number of times the feature worked properly.
   */
  kept: number;
}

/** Script changes this app attributes to AI Debug, newest first. */
export function aiFixes(changes: ScriptChangeListEntry[]): ScriptChangeListEntry[] {
  return changes.filter((c) => c.origin === "ai-debug").sort((a, b) => b.at - a.at);
}

/**
 * What became of the fixes.
 *
 * `confirmed` needs the run history because nothing else can answer it: the
 * script-change journal knows a fix landed and the user kept it, which is an
 * opinion; the next run of that test passing is evidence.
 */
export function summariseFixes(
  changes: ScriptChangeListEntry[],
  runs: RunRecord[],
): FixOutcomes {
  const fixes = aiFixes(changes);
  const out: FixOutcomes = {
    applied: fixes.length,
    pending: 0,
    unreviewed: 0,
    accepted: 0,
    reverted: 0,
    confirmed: 0,
    refuted: 0,
    unproven: 0,
    kept: 0,
  };

  // Real executions only, oldest first — a baseline update is an audit event
  // and carries an incidental status that would answer the question wrongly.
  const executions = runs
    .filter((r) => (r.kind ?? "run") === "run")
    .sort((a, b) => a.startedAt - b.startedAt);

  for (const fix of fixes) {
    if (fix.status === "pending") out.pending++;
    if (fix.status === "accepted") out.accepted++;
    if (fix.status === "reverted") out.reverted++;
    // `reviewed: false` is the auto-apply case: the fix landed while the job
    // was minimized and nobody has read it. A REVERTED one has been dealt
    // with, whatever the flag says.
    if (!fix.reviewed && fix.status === "pending") out.unreviewed++;

    const next = executions.find((r) => r.testId === fix.testId && r.startedAt >= fix.at);
    const confirmed =
      Boolean(next) &&
      next!.startedAt - fix.at <= CONFIRMATION_WINDOW_MS &&
      next!.status === "passed";
    if (!next || next.startedAt - fix.at > CONFIRMATION_WINDOW_MS) out.unproven++;
    else if (confirmed) out.confirmed++;
    else out.refuted++;

    // Kept: not reverted, and either the user said so or the next run did.
    // Reverted always loses, whichever way the run went — putting the old
    // script back is the clearest statement available that the fix was wrong.
    if (fix.status !== "reverted" && (fix.status === "accepted" || confirmed)) out.kept++;
  }

  return out;
}

// ── What it saved ─────────────────────────────────────────────────────

export interface SavingsAssumptions {
  /** How long working out one failure by hand would take, in minutes. */
  minutesPerManualDebug: number;
  /** What an hour of that time is worth. ZERO MEANS NOT STATED, and every money
   *  figure below is then null rather than 0 — see `shared/cost-units.mjs`. */
  hourlyRate: number;
}

export interface SavingsSummary {
  /** Diagnoses the savings are claimed for: kept fixes, nothing else. */
  countedFixes: number;
  /** Minutes those fixes stand in for, before the wait is deducted. */
  grossMinutes: number;
  /** Minutes spent waiting on the model, across every settled attempt —
   *  including the ones that produced nothing, because that time was spent. */
  waitedMinutes: number;
  /** The honest figure: gross minus the wait. CAN BE NEGATIVE, and is left
   *  negative rather than floored at zero — a suite where the model is asked
   *  constantly and its answers are rarely kept is genuinely costing time, and
   *  that is the single most useful thing this panel could tell someone. */
  netMinutes: number;
  /** `netMinutes` in money, or null when no hourly rate has been stated. */
  netValue: number | null;
}

/**
 * What the feature saved, net.
 *
 * COUNTED FIXES ARE THE KEPT ONES, never all sessions. A diagnosis you read and
 * did not apply saved nothing; one you applied and reverted cost you time
 * rather than saving it. Deliberately conservative in the same way
 * `cost-model.ts` is: every figure here scales off an assumption, and a
 * flattering rule makes the whole panel a sales pitch.
 */
export function summariseSavings(
  fixes: FixOutcomes,
  timing: TimingSummary,
  assumptions: SavingsAssumptions,
): SavingsSummary {
  // Counted per fix by `summariseFixes` — see `FixOutcomes.kept` for why this
  // is not `accepted + confirmed`.
  const countedFixes = fixes.kept;
  const grossMinutes = countedFixes * assumptions.minutesPerManualDebug;
  const waitedMinutes = timing.totalMs / 60_000;
  const netMinutes = grossMinutes - waitedMinutes;
  return {
    countedFixes,
    grossMinutes,
    waitedMinutes,
    netMinutes,
    netValue:
      assumptions.hourlyRate > 0 ? (netMinutes / 60) * assumptions.hourlyRate : null,
  };
}

export interface LocalSplit {
  local: number;
  hosted: number;
  /** Records written before the provider was stamped. Reported, never
   *  attributed — this is the honest denominator for the two above. */
  unknown: number;
  /** Approximate tokens sent to and returned by LOCAL models — the hosted calls
   *  that never happened. Characters ÷ 4, and every caller says so. */
  localTokens: number;
  hostedTokens: number;
}

export function summariseLocalUse(records: AiDebugHistoryRecord[]): LocalSplit {
  const out: LocalSplit = { local: 0, hosted: 0, unknown: 0, localTokens: 0, hostedTokens: 0 };
  for (const rec of records) {
    const tokens = Math.round((rec.promptChars + rec.answerChars) / CHARS_PER_TOKEN);
    if (rec.provider === null) out.unknown++;
    else if (isLocalProvider(rec.provider)) {
      out.local++;
      out.localTokens += tokens;
    } else {
      out.hosted++;
      out.hostedTokens += tokens;
    }
  }
  return out;
}

// ── Why attempts failed ───────────────────────────────────────────────

/** What each failure kind means, and what to do about it. The COPY lives here
 *  rather than in the dashboard because the same sentence has to be reachable
 *  from a node test — and because a failure taxonomy with no remedy attached is
 *  a list of complaints. */
export const ERROR_KIND_COPY: Record<LlmErrorKind, { label: string; fix: string }> = {
  connection: {
    label: "Could not reach the provider",
    fix: "The server was down, unreachable or timed out. Check it is running in Settings → AI.",
  },
  "model-unavailable": {
    label: "Model not available",
    fix: "The provider did not have that model loaded. Pull or load it, or pick another in Settings → AI.",
  },
  auth: {
    label: "Credentials refused",
    fix: "The API key or token was missing or rejected. Set it in Settings → AI.",
  },
  provider: {
    label: "The provider returned an error",
    fix: "The server answered, but with a failure of its own. Its own log is the next place to look.",
  },
  "empty-response": {
    label: "Answered with nothing",
    fix: "The stream ended before any text arrived — usually a context or token limit. Raise it, or use a smaller prompt.",
  },
  "no-model": {
    label: "No model configured",
    fix: "Pick a provider and a model in Settings → AI.",
  },
};

export interface ErrorBreakdownRow {
  kind: LlmErrorKind | "unknown";
  label: string;
  fix: string;
  count: number;
}

/** Failed attempts by kind, commonest first.
 *
 *  `unknown` is a real row: an attempt that failed before the backend could
 *  classify it (the send itself threw) has no kind, and folding those into
 *  another bucket would attribute them to a cause nobody diagnosed. */
export function summariseErrors(records: AiDebugHistoryRecord[]): ErrorBreakdownRow[] {
  const counts = new Map<LlmErrorKind | "unknown", number>();
  for (const rec of records) {
    if (rec.status !== "error") continue;
    const kind = rec.errorKind ?? "unknown";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const rows: ErrorBreakdownRow[] = [];
  for (const [kind, count] of counts) {
    const copy = kind === "unknown" ? null : ERROR_KIND_COPY[kind];
    rows.push({
      kind,
      label: copy?.label ?? "Failed before it started",
      fix:
        copy?.fix ??
        "The request never reached a provider, so nothing classified it. Usually the app could not talk to the server at all.",
      count,
    });
  }
  return rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// ── Over time ─────────────────────────────────────────────────────────

/** The window each half of the trend covers. A week, because that is the unit
 *  this app already reports in (`DigestPanel`) and because a shorter window
 *  turns one quiet afternoon into a trend. */
export const TREND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface TrendHalf {
  attempts: number;
  answered: number;
  failed: number;
  /** Share of attempts that produced an answer, or null when there were none —
   *  a rate over zero attempts is not 0%, it is nothing. */
  answeredRate: number | null;
  totalMs: number;
}

export interface Trend {
  recent: TrendHalf;
  previous: TrendHalf;
  /** Whether the previous window holds enough to compare against. Two windows
   *  is the same bar `metrics:slowness` sets before it reports a slowdown: one
   *  window is a measurement, two are a comparison. */
  comparable: boolean;
}

function halfOf(records: AiDebugHistoryRecord[]): TrendHalf {
  const answered = records.filter((r) => r.status === "done").length;
  const failed = records.filter((r) => r.status === "error").length;
  const totalMs = records.reduce((n, r) => n + (durationOf(r) ?? 0), 0);
  return {
    attempts: records.length,
    answered,
    failed,
    answeredRate: records.length > 0 ? answered / records.length : null,
    totalMs,
  };
}

/**
 * This week against the one before it.
 *
 * `now` is a parameter rather than `Date.now()` so this is testable at all —
 * the same reason `run-summary.ts` takes the run records it reasons over.
 */
export function summariseTrend(records: AiDebugHistoryRecord[], now: number): Trend {
  const recentFrom = now - TREND_WINDOW_MS;
  const previousFrom = now - 2 * TREND_WINDOW_MS;
  const recent = records.filter((r) => r.startedAt >= recentFrom);
  const previous = records.filter((r) => r.startedAt >= previousFrom && r.startedAt < recentFrom);
  return {
    recent: halfOf(recent),
    previous: halfOf(previous),
    comparable: previous.length > 0,
  };
}

// ── Which tests keep needing it ───────────────────────────────────────

export interface TestUsageRow {
  testId: string;
  testName: string;
  testDeleted: boolean;
  attempts: number;
  answered: number;
  totalMs: number;
  /** When it was last asked about. */
  lastAt: number;
}

/** Tests by how often they have been debugged, most first.
 *
 *  Deleted tests are KEPT in this list (marked, and not openable): their
 *  sessions really happened, and dropping them would make the rows here
 *  disagree with every total on the screen above. */
export function summariseByTest(records: AiDebugHistoryRecord[]): TestUsageRow[] {
  const byId = new Map<string, TestUsageRow>();
  for (const rec of records) {
    const existing = byId.get(rec.testId);
    const row: TestUsageRow = existing ?? {
      testId: rec.testId,
      testName: rec.testName || "Untitled test",
      testDeleted: Boolean(rec.testDeleted),
      attempts: 0,
      answered: 0,
      totalMs: 0,
      lastAt: 0,
    };
    row.attempts++;
    if (rec.status === "done") row.answered++;
    row.totalMs += durationOf(rec) ?? 0;
    if (rec.startedAt > row.lastAt) {
      row.lastAt = rec.startedAt;
      // The newest record's name wins: a rename leaves older rows carrying the
      // old one, and a table listing one test twice reads as two tests.
      row.testName = rec.testName || row.testName;
    }
    // Once any record says the test is gone, it is gone.
    row.testDeleted = row.testDeleted || Boolean(rec.testDeleted);
    byId.set(rec.testId, row);
  }
  return [...byId.values()].sort((a, b) => b.attempts - a.attempts || b.lastAt - a.lastAt);
}

// ── The whole picture ─────────────────────────────────────────────────

export interface AiDebugReport {
  attempts: number;
  outcomes: OutcomeCounts;
  timing: TimingSummary;
  fixes: FixOutcomes;
  savings: SavingsSummary;
  local: LocalSplit;
  errors: ErrorBreakdownRow[];
  trend: Trend;
  byTest: TestUsageRow[];
  /** When the history starts. Null when it is empty. The board says this out
   *  loud: a lifetime total is only lifetime since the app began recording one,
   *  and a figure that quietly means "since last Tuesday" is worse than one
   *  that says so. */
  firstAt: number | null;
}

export interface AiDebugInputs {
  records: AiDebugHistoryRecord[];
  scriptChanges: ScriptChangeListEntry[];
  runs: RunRecord[];
  assumptions: SavingsAssumptions;
  now: number;
}

export function buildAiDebugReport(inputs: AiDebugInputs): AiDebugReport {
  const { records, scriptChanges, runs, assumptions, now } = inputs;
  const timing = summariseTiming(records);
  const fixes = summariseFixes(scriptChanges, runs);
  return {
    attempts: records.length,
    outcomes: countOutcomes(records),
    timing,
    fixes,
    savings: summariseSavings(fixes, timing, assumptions),
    local: summariseLocalUse(records),
    errors: summariseErrors(records),
    trend: summariseTrend(records, now),
    byTest: summariseByTest(records),
    firstAt: records.length > 0 ? Math.min(...records.map((r) => r.startedAt)) : null,
  };
}

// ── The finding rule ──────────────────────────────────────────────────
//
// AN ORDERED LIST OF NAMED CONDITIONS, NOT A BOOLEAN, and that is the part
// written for what this feature is becoming rather than for what it is. Today
// the tile asks "is anything here waiting on me, or broken?". When failing
// tests start diagnosing and fixing themselves, the unreviewed-fix queue stops
// being an edge case behind an opt-in setting and becomes the normal state —
// this screen is then the supervision surface, and "drift against the charter"
// is a third condition of exactly the same shape. A list absorbs that; a
// boolean has to be rewritten, along with every test that pins it.

export type AiDebugFindingId = "unreviewed-fixes" | "failing-sessions";

export interface AiDebugFinding {
  id: AiDebugFindingId;
  /** How many things are in this state. */
  count: number;
  /** One clause, for the tile and the dashboard head. */
  say: string;
}

/** Below this many attempts, a failure RATE is an anecdote with a percent sign
 *  on it. The same shape of floor `cost-model.ts` puts on "never caught". */
export const MIN_ATTEMPTS_FOR_RATE = 5;

/** Failed share above which the provider is worth looking at rather than
 *  shrugging at. A third is high enough that it is not one bad afternoon. */
export const FAILING_SHARE = 0.33;

/**
 * The first condition that applies, or null when nothing needs attention.
 *
 * ORDER IS PRIORITY. Unreviewed fixes come first because they are changes to
 * the user's own tests that nobody has read — the only thing on this screen
 * that alters what a test does.
 */
export function aiDebugFinding(report: AiDebugReport): AiDebugFinding | null {
  if (report.fixes.unreviewed > 0) {
    const n = report.fixes.unreviewed;
    return {
      id: "unreviewed-fixes",
      count: n,
      say: `${n} applied ${n === 1 ? "fix has" : "fixes have"} not been reviewed`,
    };
  }
  const settledAttempts = report.attempts - report.outcomes.live;
  if (
    settledAttempts >= MIN_ATTEMPTS_FOR_RATE &&
    report.outcomes.error / settledAttempts >= FAILING_SHARE
  ) {
    return {
      id: "failing-sessions",
      count: report.outcomes.error,
      say: `${report.outcomes.error} of ${settledAttempts} attempts failed to get an answer`,
    };
  }
  return null;
}
