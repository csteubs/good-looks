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

import { Text } from "@glaze/core/components";
import { Columns3 } from "lucide-react";

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
    <div className="rounded-lg border border-separator bg-panel">
      <div className="flex items-baseline gap-2 border-b border-separator px-3 py-2">
        <Text variant="small-strong">Cross-browser divergence</Text>
        <Text variant="small" color="tertiary">
          {/* "No step disagrees" is a claim about a COMPARISON, and it may only
              be made when one happened. A suite that has only ever run on
              Chromium has compared nothing, and saying it agrees across engines
              there is the most misleading thing this panel could do — so the
              reassurance is withheld and the count below carries the message. */}
          {diverging.length > 0
            ? `${diverging.length} step${diverging.length === 1 ? "" : "s"} disagree`
            : steps.some((s) => s.verdict === "clean")
              ? "no step disagrees across engines"
              : "nothing has been compared across engines yet"}
        </Text>
      </div>

      {diverging.map((s) => (
        <div
          key={`${s.testId}:${s.stepId}`}
          className="flex items-start gap-2 border-b border-separator/50 px-3 py-2"
        >
          <Columns3
            className={`mt-0.5 size-3.5 shrink-0 ${
              s.verdict === "single-engine" ? "text-accent" : "text-support-orange"
            }`}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-small" title={s.label ?? s.stepId}>
              {s.label ?? s.stepId}
            </div>
            <Text variant="small" color="tertiary" className="block truncate">
              {s.testName ?? s.testId}
            </Text>
            <Text variant="small" className="block text-secondary">
              {VERDICT_COPY[s.verdict]}
              {": "}
              {/* Both sides named. "Fails on webkit" alone leaves the reader
                  asking "compared with what?", and the answer is the evidence. */}
              <span className="text-support-red">{s.failingBrowsers.join(", ")}</span>
              {s.passingBrowsers.length > 0 ? (
                <>
                  {" · passes on "}
                  <span className="text-support-green">{s.passingBrowsers.join(", ")}</span>
                </>
              ) : null}
            </Text>
          </div>
        </div>
      ))}

      {untested > 0 ? (
        <Text variant="small" color="tertiary" className="block px-3 py-2">
          {untested} step{untested === 1 ? " has" : "s have"} only ever run on one engine, so
          nothing can be said about {untested === 1 ? "it" : "them"} either way.
        </Text>
      ) : null}
    </div>
  );
}
