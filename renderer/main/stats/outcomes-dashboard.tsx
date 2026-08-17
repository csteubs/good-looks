// Outcomes — the category dashboard and its leaf.
//
// MOVED HERE FROM THE STATS LANDING, not rewritten. The chart, the four KPI
// cards and the capture-overhead panel were the landing's answer to "what
// happened", which is precisely this category's question — and a copy on both
// screens is two places to fix a number. What did NOT move is the run-history
// table with its filters, pagination and log search: that is a run EXPLORER,
// it pairs with the Manage-data menu in the landing header, and it answers
// "find me that run" rather than "how are we doing".
//
// BASELINE UPDATES ARE NOT RUNS. They are events with an incidental `status`,
// and every rate on this screen excludes them — including them once made the
// pass rate move when nothing had been executed at all.

import { Panel, TONE } from "../../theme";
import { facetLabel } from "../../lib/stats-categories";
import type {
  CaptureOverheadSummary,
  RunDayCount,
  RunRecord,
  RunTotals,
} from "../../lib/recorder-types";
import { DrillRow, ExitRow } from "./rows";

// ── Daily pass/fail buckets for the chart ──────────────────────────────

export interface DayBucket {
  key: string;
  label: string;
  passed: number;
  failed: number;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * @param prunedDays Days whose runs the capped index no longer holds. Pruning
 *  takes the OLDEST records, so on a suite that fits a thousand runs inside a
 *  week these are this week's own early days — and without them the chart draws
 *  a suite that ramped up over the week when it did nothing of the kind. They
 *  contribute counts and no identity, which is all a stacked bar needs.
 */
export function buildDailyBuckets(
  runs: RunRecord[],
  prunedDays: readonly RunDayCount[] = [],
): DayBucket[] {
  const map = new Map<string, DayBucket>();
  const bucketFor = (at: number): DayBucket => {
    const d = new Date(at);
    const key = dayKey(d);
    let b = map.get(key);
    if (!b) {
      b = { key, label: `${d.getMonth() + 1}/${d.getDate()}`, passed: 0, failed: 0 };
      map.set(key, b);
    }
    return b;
  };
  for (const r of runs) {
    if (r.kind === "baseline-update") continue; // exclude from pass/fail chart
    const b = bucketFor(r.startedAt);
    if (r.status === "passed") b.passed++;
    else b.failed++;
  }
  // Pruned days land in the same buckets by the same rule — `dayStart` is local
  // midnight, so it keys to its own day.
  for (const day of prunedDays) {
    const b = bucketFor(day.dayStart);
    b.passed += day.passed;
    b.failed += day.failed;
  }
  // Always show the last 7 calendar days (inclusive of today), even days with
  // no runs, so gaps are visible instead of the chart skipping straight to
  // the next day that has data.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets: DayBucket[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    buckets.push(
      map.get(key) ?? { key, label: `${d.getMonth() + 1}/${d.getDate()}`, passed: 0, failed: 0 },
    );
  }
  return buckets;
}

export function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="gl-kpi">
      <span className="gl-kpi-label">{label}</span>
      <span className="gl-kpi-value">{value}</span>
      {hint ? <span className="gl-kpi-hint">{hint}</span> : null}
    </div>
  );
}

/** ms → a compact human duration ("380 ms", "1.4 s"). */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** What the "Capture screenshots" toggle actually costs, measured rather than
 *  assumed. Hidden entirely until at least one instrumented capture run or
 *  accessibility run exists — a11y can be on with screenshots off. */
export function CaptureOverheadPanel({ summary }: { summary: CaptureOverheadSummary }) {
  if (summary.capturedRuns === 0 && summary.a11yRuns === 0) return null;
  const sharePct = Math.round(summary.captureShareOfRun * 100);
  const delta =
    summary.meanUncapturedDurationMs !== null
      ? summary.meanCapturedDurationMs - summary.meanUncapturedDurationMs
      : null;
  return (
    <Panel
      title="Capture overhead"
      id={
        summary.capturedRuns > 0
          ? `${summary.capturedRuns} captured ${summary.capturedRuns === 1 ? "run" : "runs"} · ${summary.totalShots} screenshots`
          : `${summary.a11yRuns} accessibility ${summary.a11yRuns === 1 ? "run" : "runs"}`
      }
      pad={10}
    >
      <div className="gl-kpis">
        {summary.capturedRuns > 0 ? (
          <StatCard
            label="Screenshot time per run"
            value={fmtMs(summary.meanCaptureMs)}
            hint={`${sharePct}% of a captured run`}
          />
        ) : null}
        {/* Reported on its own axis. Folding axe's cost into the screenshot
            number would make "capture is expensive" the wrong conclusion — the
            a11y check is usually the larger of the two by some way. */}
        {summary.a11yRuns > 0 ? (
          <StatCard
            label="Accessibility time per run"
            value={fmtMs(summary.meanA11yMs)}
            hint={`${Math.round(summary.a11yShareOfRun * 100)}% of such a run · ${fmtMs(
              summary.meanMsPerA11yCheck,
            )} per check`}
          />
        ) : null}
        {summary.capturedRuns > 0 ? (
          <StatCard label="Per screenshot" value={fmtMs(summary.meanMsPerShot)} />
        ) : null}
        {summary.capturedRuns > 0 ? (
          <StatCard
            label="Captured vs normal run"
            value={
              delta === null
                ? fmtMs(summary.meanCapturedDurationMs)
                : `${delta >= 0 ? "+" : "−"}${fmtMs(Math.abs(delta))}`
            }
            hint={
              summary.meanUncapturedDurationMs === null
                ? "no uncaptured runs to compare"
                : `${fmtMs(summary.meanCapturedDurationMs)} vs ${fmtMs(summary.meanUncapturedDurationMs)}`
            }
          />
        ) : null}
      </div>
    </Panel>
  );
}

export function PassFailChart({ buckets }: { buckets: DayBucket[] }) {
  const maxTotal = Math.max(1, ...buckets.map((b) => b.passed + b.failed));
  return (
    <Panel
      title="Pass / fail over time"
      pad={10}
      right={
        <div className="gl-legend">
          <span className="gl-legend-item">
            <span className="gl-legend-dot" style={{ background: TONE.phos }} />
            Passed
          </span>
          <span className="gl-legend-item">
            <span className="gl-legend-dot" style={{ background: TONE.red }} />
            Failed
          </span>
        </div>
      }
    >
      <div className="gl-chart">
        {buckets.map((b) => {
          const total = b.passed + b.failed;
          const totalPct = (total / maxTotal) * 100;
          const passPct = total > 0 ? (b.passed / total) * 100 : 0;
          return (
            <div key={b.key} className="gl-chart-col">
              <div className="gl-chart-plot">
                {total > 0 ? (
                  <div
                    className="gl-chart-stack"
                    style={{ height: `${totalPct}%` }}
                    title={`${b.label}: ${b.passed} passed, ${b.failed} failed`}
                  >
                    <div style={{ height: `${100 - passPct}%`, background: TONE.red }} />
                    <div style={{ height: `${passPct}%`, background: TONE.phos }} />
                  </div>
                ) : (
                  // A day with no runs draws its floor rather than nothing, so
                  // the gap reads as "nothing happened" and not as a chart that
                  // failed to render.
                  <div className="gl-chart-floor" title={`${b.label}: no runs`} />
                )}
              </div>
              <span className="gl-chart-tick">{b.label}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ── The dashboard ─────────────────────────────────────────────────────

/** Executions. A baseline update is an event, not a run. */
export function executions(runs: RunRecord[]): RunRecord[] {
  return runs.filter((r) => r.kind !== "baseline-update");
}

export function runsIn(runs: RunRecord[], facet: string): RunRecord[] {
  if (facet === "failed") return executions(runs).filter((r) => r.status === "failed");
  if (facet === "passed") return executions(runs).filter((r) => r.status === "passed");
  return [];
}

/** en-GB-agnostic thousands grouping. Four figures is where an ungrouped count
 *  starts being read as a different number at a glance. */
function fmtCount(n: number): string {
  return n.toLocaleString();
}

export function OutcomesDashboard({
  runs,
  totals,
  overhead,
  onDrill,
}: {
  runs: RunRecord[];
  /** Lifetime counts. The three cards below are the only place on this screen
   *  that can state them: everything else here — the chart, the drill lists —
   *  is drawn from run RECORDS, and the pruned ones no longer exist to draw. */
  totals?: RunTotals;
  overhead?: CaptureOverheadSummary;
  onDrill: (facet: string) => void;
}) {
  const real = executions(runs);
  if (real.length === 0 && (totals?.runs ?? 0) === 0) {
    return (
      <Panel title="Outcomes">
        <p className="gl-panel-note">
          No runs yet. Run a test from its detail page and its result appears here.
        </p>
      </Panel>
    );
  }

  const retainedPassed = runsIn(runs, "passed").length;
  const retainedFailed = runsIn(runs, "failed").length;
  // THE CARDS COUNT EVERY RUN; THE LISTS BELOW COUNT WHAT IS STILL ON DISK.
  // Falling back to the retained counts is what the cards showed before totals
  // existed, and is what they show for the moment before the query resolves.
  const total = totals?.runs ?? real.length;
  const passed = totals?.passed ?? retainedPassed;
  const failed = totals?.failed ?? retainedFailed;
  const pruned = totals?.pruned ?? 0;
  const buckets = buildDailyBuckets(runs, totals?.prunedDays);

  return (
    <>
      {/* Chart FIRST. The shape of the last week is the thing you can read
          without reading — a rising red band answers "is something wrong?"
          before any number does. */}
      {buckets.length > 0 ? <PassFailChart buckets={buckets} /> : null}

      {/* NO "PASS RATE" CARD HERE, and its absence is the point. The category
          head directly above states the rate at 32px — it IS this category's
          headline — and a card repeating it two inches lower is the same figure
          twice within one screenful, which makes a reader look for the
          difference between them. On the landing the cards had no such head
          above them, so the card was the only place the rate appeared. */}
      <div className="gl-kpis">
        {/* EVERY RUN EVER, not the run list's length. The list is capped, so
            counting it made this card climb to 1000 and stop — the suite kept
            running and the headline number did not move. The hint is not
            decoration: without it the card and the lists below simply disagree,
            and a disagreement with no explanation reads as a bug. */}
        <StatCard
          label="Total runs"
          value={fmtCount(total)}
          hint={
            pruned > 0
              ? `${fmtCount(totals?.retained ?? real.length)} kept in history · ${fmtCount(pruned)} older ${pruned === 1 ? "run" : "runs"} counted but no longer stored`
              : undefined
          }
        />
        <StatCard label="Passed" value={fmtCount(passed)} />
        <StatCard label="Failed" value={fmtCount(failed)} />
      </div>

      <Panel
        title="By outcome"
        // Says out loud that the rows below count a narrower thing than the
        // cards above: they open lists, and a list cannot show a run whose
        // record was pruned.
        id={pruned > 0 ? `most recent ${fmtCount(totals?.retained ?? real.length)} runs` : undefined}
      >
        {/* RETAINED COUNTS, deliberately — each row opens the list of exactly
            these runs, and a row that promises 240 and then shows 84 is worse
            than one that promises what it can deliver. */}
        <DrillRow
          label={facetLabel("outcomes", "failed")}
          count={retainedFailed}
          detail="Runs whose assertions did not all pass"
          tone={retainedFailed > 0 ? "red" : "phos"}
          onClick={() => onDrill("failed")}
        />
        <DrillRow
          label={facetLabel("outcomes", "passed")}
          count={retainedPassed}
          detail="Runs that completed with every assertion passing"
          tone="phos"
          onClick={() => onDrill("passed")}
        />
      </Panel>

      {overhead ? <CaptureOverheadPanel summary={overhead} /> : null}
    </>
  );
}

export function OutcomesLeaf({
  facet,
  runs,
  onOpenTest,
}: {
  facet: string;
  runs: RunRecord[];
  onOpenTest: (id: string) => void;
}) {
  if (facet !== "failed" && facet !== "passed") {
    return (
      <Panel title="Unknown outcome">
        <p className="gl-panel-note">
          “{facet}” is not a run outcome. Go back and pick one from the list.
        </p>
      </Panel>
    );
  }
  // Newest first: the run you are looking for after a failure is almost always
  // the one that just happened.
  const rows = [...runsIn(runs, facet)].sort((a, b) => b.startedAt - a.startedAt);
  return (
    <Panel title={facetLabel("outcomes", facet)} id={`${rows.length}`}>
      {rows.length === 0 ? (
        <p className="gl-panel-note">No run has this outcome.</p>
      ) : (
        rows.map((r) => (
          <ExitRow
            key={r.id}
            name={r.testName}
            detail={`${fmtDateTime(r.startedAt)} · ${fmtMs(r.durationMs)}`}
            onOpen={() => onOpenTest(r.testId)}
          />
        ))
      )}
    </Panel>
  );
}
