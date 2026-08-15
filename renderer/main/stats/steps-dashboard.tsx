// Step health — the category dashboard and its leaf.
//
// THE THREE FACETS OVERLAP, AND THE SCREEN SAYS SO. A step that fails, gets
// healed and throws a page error is one step and appears in all three lists,
// so the facet counts add up to more than the headline. That is not a bug to
// paper over with a "primary finding" rule: which of the three you are hunting
// is the question you arrived with, and a step that is quietly in two of them
// is the most interesting row on the screen. The panel states the overlap
// instead — and nothing here adds the three together, which
// `check:stats-categories` also independently forbids.
//
// `StepHealthPanel` is the landing's own table, imported rather than rebuilt.
// It already handles the metrics-unavailable state; the drill below it does
// not, so this file says the sentence itself before rendering any count.

import { Panel } from "../../theme";
import { METRICS_UNAVAILABLE, facetLabel } from "../../lib/stats-categories";
import { StepHealthPanel } from "../step-health-panel";
import type { StepHealthRow } from "../../../shared/metrics-query.mjs";
import { DrillRow, ExitRow } from "./rows";

export interface StepHealth {
  available: boolean;
  rows: StepHealthRow[];
}

const STEP_FACETS = [
  { id: "failing", detail: "The step itself failed on at least one run" },
  { id: "healing", detail: "Auto-Heal substituted a locator to keep it running" },
  { id: "throwing", detail: "The page logged an error while the step ran" },
] as const;

export function stepsIn(rows: StepHealthRow[], facet: string): StepHealthRow[] {
  if (facet === "failing") return rows.filter((r) => r.failed > 0);
  if (facet === "healing") return rows.filter((r) => r.heals > 0);
  if (facet === "throwing") return rows.filter((r) => r.pageErrors > 0);
  return [];
}

function stepName(row: StepHealthRow): string {
  return row.label ?? row.type ?? row.stepId;
}

/** What this row contributes to the facet you drilled into — not a summary of
 *  the row, which the table above already gives you. */
function detailFor(row: StepHealthRow, facet: string): string {
  const who = row.testName ?? "deleted test";
  if (facet === "failing") {
    return `${who} · failed ${row.failed} of ${row.runs} ${row.runs === 1 ? "run" : "runs"}`;
  }
  if (facet === "healing") {
    const failures =
      row.healFailures > 0 ? `, ${row.healFailures} could not be rescued` : "";
    return `${who} · healed ${row.heals} ${row.heals === 1 ? "time" : "times"}${failures}`;
  }
  return `${who} · ${row.pageErrors} page ${row.pageErrors === 1 ? "error" : "errors"} over ${
    row.runs
  } ${row.runs === 1 ? "run" : "runs"}`;
}

export function StepsDashboard({
  stepHealth,
  onDrill,
}: {
  stepHealth: StepHealth;
  onDrill: (facet: string) => void;
}) {
  if (!stepHealth.available) {
    return (
      <Panel title="Step health">
        <p className="gl-panel-note">{METRICS_UNAVAILABLE}</p>
      </Panel>
    );
  }

  if (stepHealth.rows.length === 0) {
    return (
      <Panel title="Step health">
        <p className="gl-panel-note">
          No steps recorded yet. Run a test and its steps start accumulating history here.
        </p>
      </Panel>
    );
  }

  return (
    <>
      <Panel title="By finding" id="a step can be in more than one">
        {STEP_FACETS.map((f) => (
          <DrillRow
            key={f.id}
            label={facetLabel("steps", f.id)}
            count={stepsIn(stepHealth.rows, f.id).length}
            detail={f.detail}
            tone={stepsIn(stepHealth.rows, f.id).length > 0 ? "amber" : "phos"}
            onClick={() => onDrill(f.id)}
          />
        ))}
      </Panel>
      <StepHealthPanel rows={stepHealth.rows} available={stepHealth.available} />
    </>
  );
}

export function StepsLeaf({
  facet,
  stepHealth,
  onOpenTest,
}: {
  facet: string;
  stepHealth: StepHealth;
  onOpenTest: (id: string) => void;
}) {
  const meta = STEP_FACETS.find((f) => f.id === facet);
  if (!meta) {
    return (
      <Panel title="Unknown finding">
        <p className="gl-panel-note">
          “{facet}” is not a step-health finding. Go back and pick one from the list.
        </p>
      </Panel>
    );
  }
  if (!stepHealth.available) {
    return (
      <Panel title={facetLabel("steps", facet)}>
        <p className="gl-panel-note">{METRICS_UNAVAILABLE}</p>
      </Panel>
    );
  }
  const rows = stepsIn(stepHealth.rows, facet);
  return (
    <Panel title={facetLabel("steps", facet)} id={`${rows.length}`}>
      {rows.length === 0 ? (
        <p className="gl-panel-note">No step is in this state.</p>
      ) : (
        rows.map((r) => (
          <ExitRow
            key={r.stepId}
            name={stepName(r)}
            detail={detailFor(r, facet)}
            onOpen={() => onOpenTest(r.testId)}
          />
        ))
      )}
    </Panel>
  );
}
