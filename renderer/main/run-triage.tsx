// One line in the run Output panel: was that the site's fault or ours?
//
// The reasoning is in shared/triage.mjs — this only decides how much of it to
// show. Two constraints shaped that, both from the plan's rules:
//
//   • EVIDENCE FIRST. A verdict word on its own is an assertion; people either
//     believe it or ignore it, and neither is useful. So the strongest piece of
//     evidence is on the same line as the verdict, always, and the rest is one
//     disclosure away. The suggested next step is what most readers act on, so
//     it is never hidden.
//   • `unknown` IS SHOWN. It is tempting to render nothing when the classifier
//     has no opinion, because a row saying "unclear" looks like a broken
//     feature. But an uncaptured failure is exactly the case where the user can
//     DO something — turn capture on and run it again — and hiding the row
//     hides that. Only a null result (metrics unavailable, or no rows for this
//     run) renders nothing, because then there is nothing to act on either.
//
// Deliberately not a Tooltip: Radix tooltips cannot be opened under jsdom, so
// evidence behind one would be untestable, and this is the one part of the
// feature where being wrong is quiet. It is a plain disclosure instead.

import { Text } from "@glaze/core/components";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import type { TriageResult, TriageVerdict } from "../../shared/triage.mjs";

/** The user-facing word for each verdict, and the tone it carries.
 *
 * "Test" rather than "runner": the user wrote the test, and "runner" reads as
 * the Playwright binary — which would send them to look at the wrong thing,
 * exactly the failure this whole feature exists to prevent. */
export const VERDICT_LABEL: Record<TriageVerdict, string> = {
  site: "Likely the site",
  runner: "Likely the test",
  mixed: "Evidence both ways",
  unknown: "Not enough evidence",
};

const VERDICT_CLASS: Record<TriageVerdict, string> = {
  site: "text-warning",
  runner: "text-accent",
  mixed: "text-secondary",
  unknown: "text-tertiary",
};

/** Shown next to the verdict. Rounded to whole percent — the underlying number
 *  is a weighted heuristic, and two decimal places would imply a precision the
 *  evidence does not have. */
export function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}% confident`;
}

export function RunTriage({ runId }: { runId?: string }) {
  const [result, setResult] = useState<TriageResult | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!runId) {
      setResult(null);
      return;
    }
    let current = true;
    setOpen(false);
    // Stale responses are dropped rather than rendered: the panel is re-used
    // across runs, and a slow triage for the PREVIOUS run arriving after the
    // next one started would attribute one run's evidence to another.
    void api.runs
      .triage(runId)
      .then((r) => {
        if (current) setResult(r);
      })
      .catch(() => {
        // Never fatal, on this side too. A run that failed should not also
        // show an error about the thing explaining why it failed.
        if (current) setResult(null);
      });
    return () => {
      current = false;
    };
  }, [runId]);

  if (!result) return null;

  const strongest = result.evidence[0];
  const more = result.evidence.length + result.limits.length - (strongest ? 1 : 0);

  return (
    <div className="border-b border-separator px-4 py-2">
      <div className="flex items-center gap-2">
        <Text variant="small-strong" className={VERDICT_CLASS[result.verdict]}>
          {VERDICT_LABEL[result.verdict]}
        </Text>
        {result.confidence > 0 ? (
          <Text variant="small" className="text-tertiary">
            {confidenceLabel(result.confidence)}
          </Text>
        ) : null}
        {more > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="text-small flex items-center gap-1 text-secondary hover:text-primary"
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {open ? "Less" : `${more} more`}
          </button>
        ) : null}
      </div>

      {strongest ? (
        <Text variant="small" className="text-secondary">
          {strongest.detail}
        </Text>
      ) : null}

      {open ? (
        <div className="mt-1 flex flex-col gap-1">
          {result.evidence.slice(1).map((e) => (
            <Text key={e.signal} variant="small" className="text-secondary">
              {e.detail}
            </Text>
          ))}
          {/* Limits are listed with the evidence, not below it or behind a
              second control. What the capture missed is the reason a verdict
              is soft, and separating the two invites the verdict to be read
              without it. */}
          {result.limits.map((l) => (
            <Text key={l} variant="small" className="text-tertiary">
              {l}
            </Text>
          ))}
        </div>
      ) : null}

      <Text variant="small" className="mt-1 block text-primary">
        {result.suggestedNext}
      </Text>
    </div>
  );
}
