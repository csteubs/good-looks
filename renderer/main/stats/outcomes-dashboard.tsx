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
import type { CaptureOverheadSummary, RunRecord } from "../../lib/recorder-types";
import { DrillRow, ExitRow } from "./rows";

// ── Daily pass/fail buckets for the chart ──────────────────────────────

export interface DayBucket {
  key: string;
  label: string;
  passed: number;
  failed: number;
}

export function buildDailyBuckets(runs: RunRecord[]): DayBucket[] {
  const map = new Map<string, DayBucket>();
  for (const r of runs) {
    if (r.kind === "baseline-update") continue; // exclude from pass/fail chart
    const d = new Date(r.startedAt);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    let b = map.get(key);
    if (!b) {
      b = { key, label: `${d.getMonth() + 1}/${d.getDate()}`, passed: 0, failed: 0 };
      map.set(key, b);
    }
    if (r.status === "passed") b.passed++;
    else b.failed++;
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
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
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

export function OutcomesDashboard({
  runs,
  overhead,
  onDrill,
}: {
  runs: RunRecord[];
  overhead?: CaptureOverheadSummary;
  onDrill: (facet: string) => void;
}) {
  const real = executions(runs);
  if (real.length === 0) {
    return (
      <Panel title="Outcomes">
        <p className="gl-panel-note">
          No runs yet. Run a test from its detail page and its result appears here.
        </p>
      </Panel>
    );
  }

  const passed = runsIn(runs, "passed").length;
  const failed = runsIn(runs, "failed").length;
  const buckets = buildDailyBuckets(runs);

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
        <StatCard label="Total runs" value={String(real.length)} />
        <StatCard label="Passed" value={String(passed)} />
        <StatCard label="Failed" value={String(failed)} />
      </div>

      <Panel title="By outcome">
        <DrillRow
          label={facetLabel("outcomes", "failed")}
          count={failed}
          detail="Runs whose assertions did not all pass"
          tone={failed > 0 ? "red" : "phos"}
          onClick={() => onDrill("failed")}
        />
        <DrillRow
          label={facetLabel("outcomes", "passed")}
          count={passed}
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
