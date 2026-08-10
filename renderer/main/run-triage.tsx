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

import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { Verdict } from "../theme";
import type { ToneName } from "../theme";
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

/**
 * The dot beside each verdict, and TWO OF THE FOUR HAVE NO TONE AT ALL.
 *
 * `site` is amber and `runner` is red because those are calls: caution, go and
 * look at the site; or the failure is in the test you wrote. But "evidence both
 * ways" and "not enough evidence" are the classifier declining to call it, and
 * painting either one a colour would have this component assert something the
 * reasoning behind it refused to. `Verdict` draws a neutral dot for `undefined`
 * — the same contract `StatusChip` uses for a state that is real but is not a
 * result.
 *
 * Not phos/red for site/runner as "their fault / our fault" either: the run has
 * already failed, and a green dot anywhere on a failed run's panel reads as a
 * pass no matter what the sentence next to it says.
 */
const VERDICT_TONE: Record<TriageVerdict, ToneName | undefined> = {
  site: "amber",
  runner: "red",
  mixed: undefined,
  unknown: undefined,
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
    <div className="gl-triage">
      {/* The `Verdict` primitive, which is exactly this shape: a tone dot, a
          claim in a sentence, and the evidence under it. Sans and prose rather
          than the design's usual mono uppercase — .12em tracking on a full
          clause is genuinely slower to read, and this is the line on the screen
          most likely to be READ rather than scanned. */}
      <Verdict
        tone={VERDICT_TONE[result.verdict]}
        detail={strongest ? strongest.detail : undefined}
      >
        {VERDICT_LABEL[result.verdict]}
        {result.confidence > 0 ? (
          <span className="gl-triage-confidence">{confidenceLabel(result.confidence)}</span>
        ) : null}
      </Verdict>

      {more > 0 ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="gl-triage-more"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {open ? "Less" : `${more} more`}
        </button>
      ) : null}

      {open ? (
        <div className="gl-triage-rest">
          {result.evidence.slice(1).map((e) => (
            <p key={e.signal} className="gl-triage-line">
              {e.detail}
            </p>
          ))}
          {/* Limits are listed with the evidence, not below it or behind a
              second control. What the capture missed is the reason a verdict
              is soft, and separating the two invites the verdict to be read
              without it. */}
          {result.limits.map((l) => (
            <p key={l} className="gl-triage-line gl-triage-limit">
              {l}
            </p>
          ))}
        </div>
      ) : null}

      <p className="gl-triage-next">{result.suggestedNext}</p>
    </div>
  );
}
