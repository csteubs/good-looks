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

import { Text } from "@glaze/core/components";
import { TrendingUp } from "lucide-react";

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
    <div className="rounded-lg border border-separator bg-panel">
      <div className="flex items-baseline gap-2 border-b border-separator px-3 py-2">
        <Text variant="small-strong">Where the time goes</Text>
        <Text variant="small" color="tertiary">
          {cost.runs} run{cost.runs === 1 ? "" : "s"}, {formatSeconds(cost.totalMs)} total
        </Text>
      </div>

      <div className="flex flex-col gap-3 p-3">
        {cost.totalMs > 0 ? (
          <>
            <div className="flex h-2 overflow-hidden rounded-full bg-separator">
              <div
                className="bg-support-orange"
                style={{ width: `${(cost.captureMs / cost.totalMs) * 100}%` }}
                title={`Screenshot capture: ${formatSeconds(cost.captureMs)}`}
              />
              <div
                className="bg-accent"
                style={{ width: `${(cost.a11yMs / cost.totalMs) * 100}%` }}
                title={`Accessibility checks: ${formatSeconds(cost.a11yMs)}`}
              />
            </div>
            <Text variant="small" className="block text-secondary">
              {/* The sentence the panel exists to be able to say. */}
              <strong className="text-primary">{formatSeconds(cost.instrumentedMs)}</strong> of{" "}
              {formatSeconds(cost.totalMs)} ({Math.round(cost.instrumentedShare * 100)}%) is
              instrumentation you can switch off — {formatSeconds(cost.captureMs)} capturing{" "}
              {cost.shots} screenshot{cost.shots === 1 ? "" : "s"} and {formatSeconds(cost.a11yMs)}{" "}
              on accessibility checks.
            </Text>
          </>
        ) : null}

        {cost.bySpeed.length > 0 ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {cost.bySpeed.map((s) => (
              <Text key={s.speed} variant="small" color="tertiary">
                <span className="capitalize">{s.speed}</span>: {formatSeconds(s.totalMs)} over{" "}
                {s.runs} run{s.runs === 1 ? "" : "s"}
              </Text>
            ))}
          </div>
        ) : null}
      </div>

      <div className="border-t border-separator px-3 py-2">
        <Text variant="small-strong" className="block">
          Steps that got slower
        </Text>
      </div>

      {reason ? (
        <Text variant="small" color="tertiary" className="block px-3 pb-3">
          {reason}
        </Text>
      ) : slowed.length === 0 ? (
        <Text variant="small" color="tertiary" className="block px-3 pb-3">
          No step’s median has moved enough to report. That is the good answer.
        </Text>
      ) : (
        <div className="flex flex-col">
          {slowed.map((r) => (
            <div
              key={`${r.testId}:${r.stepId}`}
              className="flex items-center gap-2 border-t border-separator/50 px-3 py-2"
            >
              <TrendingUp className="size-3.5 shrink-0 text-support-orange" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-small" title={r.label ?? r.stepId}>
                  {r.label ?? r.stepId}
                </div>
                <Text variant="small" color="tertiary" className="block truncate">
                  {r.testName ?? r.testId}
                </Text>
              </div>
              <Text variant="small" className="shrink-0 tabular-nums text-secondary">
                {formatMs(r.previousP50Ms)} → {formatMs(r.recentP50Ms)}
                <span className="ml-2 text-support-orange">
                  {r.changeRatio ? `${r.changeRatio.toFixed(1)}×` : ""}
                </span>
              </Text>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
