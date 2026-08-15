// Visual diff — the category dashboard and its leaf.
//
// It counts against the SAME set of runs the tile counts against:
// `latestCaptures` is one function, called by `summariseVisual` and by this
// screen. A dashboard that re-derived "the latest capture per test" would drift
// the first time either rule changed, and the symptom is a tile reading "6
// steps" over a list of four — one suite, two answers, nothing logged.
//
// ANALYTICS HERE, OPERATIONS THERE (docs/plans/stats-categories.md §6).
// Accepting a new baseline is the thing you actually do about a visual change,
// and it lives in the Visual view. This screen counts and hands off;
// `check:stats-categories` proves it carries no accept.

import { Panel } from "../../theme";
import { latestCaptures, facetLabel } from "../../lib/stats-categories";
import type { RunReplaySummary } from "../../lib/recorder-types";
import { DrillRow, ExitRow } from "./rows";

/** The two states a captured test can be in. Ids reach the URL; the labels
 *  come from `FACET_LABELS` so the breadcrumb and these rows agree. */
const VISUAL_FACETS = [
  { id: "changed", detail: "At least one step differs from its pinned screenshot" },
  { id: "clean", detail: "Every captured step matches its baseline" },
] as const;

export function capturesIn(replays: RunReplaySummary[], facet: string): RunReplaySummary[] {
  const latest = latestCaptures(replays);
  if (facet === "changed") return latest.filter((r) => r.changedSteps > 0);
  if (facet === "clean") return latest.filter((r) => r.changedSteps === 0);
  return [];
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function VisualDashboard({
  replays,
  onDrill,
  onOpenVisual,
}: {
  replays: RunReplaySummary[];
  onDrill: (facet: string) => void;
  onOpenVisual: () => void;
}) {
  const latest = latestCaptures(replays);

  if (latest.length === 0) {
    return (
      <Panel title="By state">
        <p className="gl-panel-note">
          No test has been captured yet. Switch on “Capture screenshots” beside Run test, then run a
          test.
        </p>
      </Panel>
    );
  }

  return (
    <>
      <Panel title="By state" id={`${latest.length} captured`}>
        {VISUAL_FACETS.map((f) => (
          <DrillRow
            key={f.id}
            label={facetLabel("visual", f.id)}
            count={capturesIn(replays, f.id).length}
            detail={f.detail}
            tone={f.id === "changed" ? "amber" : "phos"}
            onClick={() => onDrill(f.id)}
          />
        ))}
      </Panel>
      <Panel title="Acting on these">
        <div className="gl-exit">
          <div className="gl-rowline">
            <div className="gl-rowline-main">Visual</div>
            <div className="gl-rowline-sub">
              Compare a step against its baseline, mask a region, or accept the change
            </div>
          </div>
          <button type="button" className="gl-exit-go" onClick={onOpenVisual}>
            Open Visual ›
          </button>
        </div>
      </Panel>
    </>
  );
}

export function VisualLeaf({
  facet,
  replays,
  onOpenTest,
}: {
  facet: string;
  replays: RunReplaySummary[];
  onOpenTest: (id: string) => void;
}) {
  const meta = VISUAL_FACETS.find((f) => f.id === facet);
  if (!meta) {
    return (
      <Panel title="Unknown state">
        <p className="gl-panel-note">
          “{facet}” is not a visual state. Go back and pick one from the list.
        </p>
      </Panel>
    );
  }
  const rows = capturesIn(replays, facet);
  return (
    <Panel title={facetLabel("visual", facet)} id={`${rows.length}`}>
      {rows.length === 0 ? (
        <p className="gl-panel-note">No captured test is in this state.</p>
      ) : (
        rows.map((r) => (
          <ExitRow
            key={`${r.testId}:${r.runId}`}
            name={r.testName}
            detail={`${r.changedSteps} of ${r.stepCount} ${
              r.stepCount === 1 ? "step" : "steps"
            } changed · captured ${when(r.startedAt)}`}
            onOpen={() => onOpenTest(r.testId)}
          />
        ))
      )}
    </Panel>
  );
}
