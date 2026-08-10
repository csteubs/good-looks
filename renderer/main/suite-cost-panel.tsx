// Where the suite's time goes, and what got slower.
//
// Two halves of one question, deliberately in one panel:
//
//   • WHAT YOU CHOSE. "Your suite takes 5 minutes" invites nothing. "3m20s of
//     your 5m suite is capture, accessibility and the Slow speed you picked"
//     names three switches. Capture and a11y are MEASURED per run, not
//     estimated, which is what makes the claim safe to put on screen.
//   • WHAT CHANGED. A step whose median doubled while still passing is
//     invisible in every other view, and it is the leading indicator of the
//     timeout failure that arrives a week later.
//
// The speed row is shown as a breakdown rather than folded into the
// instrumentation figure. Slow-motion delay is derivable per run but is spread
// across steps rather than recorded as a total, so adding it to two measured
// numbers would put an estimate and two measurements in the same sentence with
// nothing saying which was which.

import { TrendingUp } from "lucide-react";

import { Panel, TONE } from "../theme";
import type { StepDurationRow } from "../../shared/metrics-query.mjs";
import type { CostBreakdown } from "../../shared/step-insights.mjs";
import { MIN_SAMPLES_FOR_TREND } from "../../shared/step-insights.mjs";
import { formatMs } from "./step-health-panel";

export function formatSeconds(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/** Why the trend column is empty, in words, when it is. Exported so the test
 *  asserts the same string the user reads — and because the reason matters:
 *  "no step has been run twice yet" is a fact about the history, not a bug. */
export function trendUnavailableReason(rows: StepDurationRow[]): string | null {
  if (rows.length === 0) return null;
  const comparable = rows.filter(
    (r) => r.recentRuns >= MIN_SAMPLES_FOR_TREND && r.previousRuns >= MIN_SAMPLES_FOR_TREND,
  );
  if (comparable.length > 0) return null;
  return (
    `No step has ${MIN_SAMPLES_FOR_TREND * 2} timed runs yet, so there is nothing to compare a ` +
    `recent median against. Run the suite a few more times and slowdowns will appear here.`
  );
}

export function SuiteCostPanel({
  cost,
  rows,
  slowed,
  available,
}: {
  cost: CostBreakdown;
  rows: StepDurationRow[];
  slowed: StepDurationRow[];
  available: boolean;
}) {
  if (!available) return null;

  const reason = trendUnavailableReason(rows);

  return (
    <Panel
      title="Where the time goes"
      id={`${cost.runs} run${cost.runs === 1 ? "" : "s"} · ${formatSeconds(cost.totalMs)} total`}
    >
      {cost.totalMs > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 10 }}>
          {/* Amber for capture and violet for accessibility, over a neutral
              total. Amber because capture is the cost you are most likely to
              want back; violet because the a11y check is the one span here that
              is not reporting an outcome at all — it is a mechanism, and the
              palette reserves violet for exactly that. */}
          <div className="gl-cost-bar">
            <div
              style={{
                width: `${(cost.captureMs / cost.totalMs) * 100}%`,
                background: TONE.amber,
              }}
              title={`Screenshot capture: ${formatSeconds(cost.captureMs)}`}
            />
            <div
              style={{ width: `${(cost.a11yMs / cost.totalMs) * 100}%`, background: TONE.violet }}
              title={`Accessibility checks: ${formatSeconds(cost.a11yMs)}`}
            />
          </div>
          <p className="gl-cost-say">
            {/* The sentence the panel exists to be able to say. */}
            <strong>{formatSeconds(cost.instrumentedMs)}</strong> of{" "}
            {formatSeconds(cost.totalMs)} ({Math.round(cost.instrumentedShare * 100)}%) is
            instrumentation you can switch off — {formatSeconds(cost.captureMs)} capturing{" "}
            {cost.shots} screenshot{cost.shots === 1 ? "" : "s"} and {formatSeconds(cost.a11yMs)}{" "}
            on accessibility checks.
          </p>

          {cost.bySpeed.length > 0 ? (
            <div className="gl-cost-speeds">
              {cost.bySpeed.map((s) => (
                <span key={s.speed} className="gl-rowline-sub">
                  {s.speed}: {formatSeconds(s.totalMs)} over {s.runs} run
                  {s.runs === 1 ? "" : "s"}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        style={{
          borderTop: "1px solid var(--gl-line-2)",
          padding: "8px 10px",
        }}
      >
        <span className="gl-section-title">Steps that got slower</span>
      </div>

      {reason ? (
        <p className="gl-panel-note">{reason}</p>
      ) : slowed.length === 0 ? (
        <p className="gl-panel-note">
          No step’s median has moved enough to report. That is the good answer.
        </p>
      ) : (
        <div>
          {slowed.map((r) => (
            <div key={`${r.testId}:${r.stepId}`} className="gl-slowed-row">
              <span className="gl-slowed-icon">
                <TrendingUp aria-hidden="true" />
              </span>
              <div className="gl-rowline">
                <div className="gl-rowline-main" title={r.label ?? r.stepId}>
                  {r.label ?? r.stepId}
                </div>
                <div className="gl-rowline-sub">{r.testName ?? r.testId}</div>
              </div>
              <span className="gl-slowed-delta">
                {formatMs(r.previousP50Ms)} → {formatMs(r.recentP50Ms)}
                {r.changeRatio ? (
                  <span style={{ color: TONE.amber, marginInlineStart: 6 }}>
                    {r.changeRatio.toFixed(1)}×
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
