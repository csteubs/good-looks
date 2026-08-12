// Which steps disagree across engines.
//
// A step that fails only on WebKit is a different bug report from one that
// fails everywhere, and the existing views cannot tell them apart: run history
// is per run, and a per-test pass rate averages the engines together into a
// number that describes none of them.
//
// The panel shows ONLY the steps that diverge. Everything else is either clean
// (nothing to say) or `insufficient` — run on one engine only — and that last
// group is summarised as a count rather than listed. It is the majority of rows
// on a young history, and a table where nine tenths of the rows say "we don't
// know" trains people to stop reading it. The count still appears, because
// "only ever tried on chromium" is exactly the thing this panel should nudge
// about, and hiding it entirely would make a one-engine suite look clean.

import { Columns3 } from "lucide-react";

import { Panel, TONE } from "../theme";
import type { DivergentStep } from "../../shared/step-insights.mjs";

/** The sentence for each verdict. Exported so tests assert the copy the user
 *  reads rather than a class name. */
export const VERDICT_COPY: Record<string, string> = {
  "single-engine": "Fails on one engine only",
  mixed: "Fails on some engines",
  "all-engines": "Fails on every engine tried",
};

export function DivergencePanel({
  steps,
  available,
}: {
  steps: DivergentStep[];
  available: boolean;
}) {
  if (!available) return null;

  const diverging = steps.filter(
    (s) => s.verdict === "single-engine" || s.verdict === "mixed" || s.verdict === "all-engines",
  );
  const untested = steps.filter((s) => s.verdict === "insufficient").length;

  // Nothing to say at all — not even a "no divergence" reassurance, which would
  // be false on a suite that has only ever run on one engine.
  if (diverging.length === 0 && untested === 0) return null;

  return (
    <Panel
      title="Cross-browser divergence"
      // "No step disagrees" is a claim about a COMPARISON, and it may only be
      // made when one happened. A suite that has only ever run on Chromium has
      // compared nothing, and saying it agrees across engines there is the most
      // misleading thing this panel could do — so the reassurance is withheld
      // and the count below carries the message.
      id={
        diverging.length > 0
          ? `${diverging.length} step${diverging.length === 1 ? "" : "s"} disagree`
          : steps.some((s) => s.verdict === "clean")
            ? "no step disagrees across engines"
            : "nothing has been compared across engines yet"
      }
    >
      {diverging.map((s) => (
        <div key={`${s.testId}:${s.stepId}`} className="gl-diverge-row">
          {/* Cyan for the single-engine case is deliberate and is the one hue
              the selection rule allows outside an outcome: the palette declares
              it "running / live / focus", and this mark is pointing at a
              comparison rather than reporting a result. Amber for the rest,
              which ARE reporting one. */}
          <span
            className="gl-diverge-icon"
            style={{ color: s.verdict === "single-engine" ? TONE.cyan : TONE.amber }}
          >
            <Columns3 aria-hidden="true" />
          </span>
          <div className="gl-rowline">
            <div className="gl-rowline-main" title={s.label ?? s.stepId}>
              {s.label ?? s.stepId}
            </div>
            <div className="gl-rowline-sub">{s.testName ?? s.testId}</div>
            <p className="gl-diverge-verdict">
              {VERDICT_COPY[s.verdict]}
              {": "}
              {/* Both sides named. "Fails on webkit" alone leaves the reader
                  asking "compared with what?", and the answer is the evidence. */}
              <span className="gl-fail-list">{s.failingBrowsers.join(", ")}</span>
              {s.passingBrowsers.length > 0 ? (
                <>
                  {" · passes on "}
                  <span className="gl-pass-list">{s.passingBrowsers.join(", ")}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
      ))}

      {untested > 0 ? (
        <p className="gl-panel-note">
          {untested} step{untested === 1 ? " has" : "s have"} only ever run on one engine, so
          nothing can be said about {untested === 1 ? "it" : "them"} either way.
        </p>
      ) : null}
    </Panel>
  );
}
