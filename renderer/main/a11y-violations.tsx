// Shared presentation for accessibility violations.
//
// Two views render these now — the Visual view's step detail and the test's own
// Accessibility tab — and they must not drift. The impact colours ARE the triage
// (a "minor" and a "critical" that look alike defeat the point of ranking them),
// and the new-vs-accepted split is the whole verdict, so a second hand-written
// copy would eventually disagree with the first about which issues matter.
//
// The pure half — ranking, keying, counting — lives in renderer/lib/a11y-format.
// This file is only the pixels.

import { Accessibility, Send } from "lucide-react";

import { Btn, TONE, toneSurface } from "../theme";
import { worstNewImpact } from "../lib/a11y-format";
import type { A11yResult, A11yViolation } from "../lib/recorder-types";

/**
 * The tone an impact level takes, ranked the way axe ranks it.
 *
 * THREE RANKS FOR FOUR LEVELS, and that is the palette's rule rather than a
 * shortcut. Colour means outcome here (tokens.css), so a level only takes a hue
 * when the hue says something true about it: `critical` is the one to read first
 * (red), `serious` is the prompt to look (amber), and `moderate` and `minor` are
 * findings with nothing urgent to report — they take no hue and are told apart
 * by the word in the chip, exactly as `Accepted` and `Reverted` are on the Heals
 * list. What must never happen is a "minor" that looks like a "critical", and
 * this maps those to the two ends.
 *
 * `undefined` means the neutral chip. Exported because the panel and the Visual
 * view must agree about what an impact looks like, which is this file's whole
 * reason to exist.
 */
export const IMPACT_TONE: Record<A11yViolation["impact"], "red" | "amber" | undefined> = {
  critical: "red",
  serious: "amber",
  moderate: undefined,
  minor: undefined,
};

/** One impact chip, tinted or not. `.gl-chip-tone` takes its colours inline
 *  from `toneSurface` — the one place that derivation happens. */
function ImpactChip({ impact }: { impact: A11yViolation["impact"] }) {
  const tone = IMPACT_TONE[impact];
  return tone ? (
    <span className="gl-chip-tone" style={toneSurface(TONE[tone])}>
      {impact}
    </span>
  ) : (
    <span className="gl-chip">{impact}</span>
  );
}

/** Compact "N accessibility issues" chip for a step row. */
export function A11yBadge({ result }: { result: A11yResult }) {
  const isNew = result.newKeys.length;
  if (isNew === 0) {
    // Checked and found nothing unaccepted. Worth saying explicitly — silence
    // reads as "the check didn't run", which is a different thing entirely.
    // Neutral: "nothing outstanding" is not an outcome the run turned on.
    return (
      <span className="gl-chip">
        <Accessibility className="gl-mini-icon" aria-hidden="true" />
        {result.acceptedCount > 0 ? `${result.acceptedCount} accepted` : "No a11y issues"}
      </span>
    );
  }
  const worst = worstNewImpact(result);
  // Amber when the worst new issue is not itself critical: an accessibility
  // finding never decides whether the run passed, so caution is the strongest
  // claim it can make on its own.
  const tone = (worst ? IMPACT_TONE[worst] : undefined) ?? "amber";
  return (
    <span className="gl-chip-tone" style={toneSurface(TONE[tone])}>
      <Accessibility className="gl-mini-icon" aria-hidden="true" />
      {isNew} new a11y issue{isNew === 1 ? "" : "s"}
    </span>
  );
}

/**
 * The violations themselves, newest-first is not a thing here — axe's order is
 * kept, but already-accepted ones are dimmed and labelled.
 *
 * Accepted violations are SHOWN rather than hidden: "6 issues, 6 accepted" is
 * useful and honest, while a step that looks empty claims the page is clean.
 *
 * `filing` is optional, and its absence is what keeps this component usable in
 * the places where filing makes no sense. When present, each NEW violation gets
 * a Send button — accepted ones do not, because filing a defect the team
 * already decided to live with is the opposite of useful.
 */
export function A11yViolationList({
  result,
  filing,
}: {
  result: A11yResult;
  filing?: {
    /** Called with the axe rule id. The caller owns the run and step, so it can
     *  build the coordinate — this component never sees one. */
    onSend: (ruleId: string) => void;
    /** Rule ids already filed, mapped to their issue identifier. */
    filed?: Record<string, string>;
  };
}) {
  const newSet = new Set(result.newKeys);
  return (
    <div className="gl-a11y-list">
      {result.violations.map((v, i) => {
        const isNew = v.nodes.length
          ? v.nodes.some((t) => newSet.has(`${v.id}|${t}`))
          : newSet.has(`${v.id}|`);
        const already = filing?.filed?.[v.id];
        return (
          <div key={i} className="gl-a11y-item" data-accepted={isNew ? undefined : ""}>
            <div className="gl-a11y-head">
              <ImpactChip impact={v.impact} />
              <code className="gl-a11y-rule">{v.id}</code>
              {!isNew ? <span className="gl-chip">accepted</span> : null}
              {filing && isNew ? (
                <span className="gl-a11y-send">
                  {already ? (
                    <span className="gl-chip">Filed as {already}</span>
                  ) : (
                    <Btn
                      tone="ghost"
                      aria-label={`Send ${v.id} to the issue tracker`}
                      onClick={() => filing.onSend(v.id)}
                    >
                      <Send aria-hidden="true" />
                      Send
                    </Btn>
                  )}
                </span>
              ) : null}
            </div>
            <p className="gl-a11y-help">{v.help}</p>
            {v.nodes.length > 0 ? (
              <div className="gl-a11y-nodes">
                {v.nodes.map((t, j) => (
                  <code key={j} className="gl-a11y-node">
                    {t}
                  </code>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
