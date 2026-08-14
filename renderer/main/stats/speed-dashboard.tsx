// Speed & cost — the category dashboard and its leaf.
//
// TWO PANELS, TWO QUESTIONS, AND THEY ARE NOT THE SAME ONE. "Where the time
// goes" is about the suite: how much of a run is instrumentation you could
// switch off. The drill below it is about a step: which ones got slower than
// they used to be. A screen that merged them would answer neither, because the
// suite total moves when you add a test and a step's median does not.
//
// `SuiteCostPanel` is the panel the Stats landing already renders, imported
// rather than reimplemented — it is the same question asked in the same words,
// and a second copy would be the place the two answers start to differ.
//
// THE UNAVAILABLE STATE IS LOAD-BEARING HERE. Both this category and Step
// health read the metrics DB, which is a derived shadow that may fail to open
// (CLAUDE.md). `SuiteCostPanel` renders NOTHING when `available` is false, so
// this screen must say the sentence itself — an empty dashboard reads as "no
// slow steps", which is a confident all-clear nobody measured.

import { Panel } from "../../theme";
import { METRICS_UNAVAILABLE, facetLabel } from "../../lib/stats-categories";
import { SuiteCostPanel, formatSeconds } from "../suite-cost-panel";
import type { StepDurationRow } from "../../../shared/metrics-query.mjs";
import type { CostBreakdown } from "../../../shared/step-insights.mjs";
import { DrillRow, ExitRow } from "./rows";

export interface Slowness {
  available: boolean;
  cost: CostBreakdown;
  rows: StepDurationRow[];
  slowed: StepDurationRow[];
}

/** How much slower, in the form the row already carries. `changeRatio` is
 *  recent ÷ previous, so 2 is "twice as long as it used to take". */
function slowerBy(row: StepDurationRow): string {
  if (row.changeRatio === null) return "no comparable window";
  return `${row.changeRatio.toFixed(1)}× slower`;
}

function stepName(row: StepDurationRow): string {
  return row.label ?? row.type ?? row.stepId;
}

export function SpeedDashboard({
  slowness,
  onDrill,
}: {
  slowness: Slowness;
  onDrill: (facet: string) => void;
}) {
  if (!slowness.available) {
    return (
      <Panel title="Speed & cost">
        <p className="gl-panel-note">{METRICS_UNAVAILABLE}</p>
      </Panel>
    );
  }

  if (slowness.cost.runs === 0) {
    return (
      <Panel title="Speed & cost">
        <p className="gl-panel-note">
          No run has been timed yet. Run a test and its steps start accumulating timings here.
        </p>
      </Panel>
    );
  }

  return (
    <>
      {/* THE DRILL ABOVE THE PANEL, matching Step health and for the same
          reason: the breakdown of the headline comes first, and the table that
          supports it follows. `SuiteCostPanel` lists the same slow steps
          inline, but its rows do not go anywhere — the leaf under this row is
          where each one exits to the test that owns it. */}
      <Panel title="By finding">
        <DrillRow
          label={facetLabel("speed", "slower")}
          count={slowness.slowed.length}
          detail="Median duration moved enough between two windows to report"
          tone={slowness.slowed.length > 0 ? "amber" : "phos"}
          onClick={() => onDrill("slower")}
        />
      </Panel>
      <SuiteCostPanel
        cost={slowness.cost}
        rows={slowness.rows}
        slowed={slowness.slowed}
        available={slowness.available}
      />
    </>
  );
}

export function SpeedLeaf({
  facet,
  slowness,
  onOpenTest,
}: {
  facet: string;
  slowness: Slowness;
  onOpenTest: (id: string) => void;
}) {
  if (facet !== "slower") {
    return (
      <Panel title="Unknown breakdown">
        <p className="gl-panel-note">
          “{facet}” is not a Speed &amp; cost breakdown. Go back and pick one from the list.
        </p>
      </Panel>
    );
  }
  if (!slowness.available) {
    return (
      <Panel title={facetLabel("speed", "slower")}>
        <p className="gl-panel-note">{METRICS_UNAVAILABLE}</p>
      </Panel>
    );
  }
  const rows = slowness.slowed;
  return (
    <Panel title={facetLabel("speed", "slower")} id={`${rows.length}`}>
      {rows.length === 0 ? (
        <p className="gl-panel-note">No step’s median has moved enough to report.</p>
      ) : (
        rows.map((r) => (
          <ExitRow
            key={r.stepId}
            name={stepName(r)}
            detail={`${r.testName ?? "deleted test"} · ${formatSeconds(
              r.previousP50Ms ?? 0,
            )} → ${formatSeconds(r.recentP50Ms ?? 0)} · ${slowerBy(r)}`}
            onOpen={() => onOpenTest(r.testId)}
          />
        ))
      )}
    </Panel>
  );
}
