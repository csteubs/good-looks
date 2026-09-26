// Accessibility — the category dashboard and its severity leaf.
//
// This is the ask's worked example (docs/plans/stats-categories.md): a severity
// breakdown that opens the rules behind one severity, and from a rule the test
// that violates it.
//
// THE SEVERITIES OVERLAP AND THE SCREEN SAYS SO. A step carrying a critical and
// a moderate violation is counted under both, so the four counts add up to more
// than the headline. Filing each step under its worst severity only would make
// them partition neatly and would hide every moderate rule that happens to
// share a step with a critical one — which is the rule you were looking for
// when you opened "Moderate". `rollupA11y` states this in the same words.
//
// THREE LEVELS, NOT FOUR (plan §11 Q1). The trail stops at severity → rules,
// and a rule row exits to the test. A fourth level breaking a rule down into
// the individual steps that violate it is more route surface for a screen the
// user opens to answer "which test do I go fix", and the test detail view
// already shows exactly that breakdown.

import { Panel } from "../../theme";
import { facetLabel } from "../../lib/stats-categories";
import type { A11yRollup, A11yRuleRollup } from "../../../shared/a11y-rollup.mjs";
import { IMPACTS } from "../../../shared/a11y-rollup.mjs";
import { DrillRow, ExitRow } from "./rows";

/** Severity → tone. Critical and serious are red because they are the two the
 *  user is expected to act on; moderate and minor are amber. NEVER a tone that
 *  reads as a run outcome on the board itself — the a11y TILE is capped at
 *  amber precisely because these findings are reported, never enforced. Inside
 *  the category, where nothing is being compared to a pass/fail, severity is
 *  free to say what axe says. */
function toneFor(impact: string): "red" | "amber" {
  return impact === "critical" || impact === "serious" ? "red" : "amber";
}

export function rulesAt(rollup: A11yRollup, impact: string): A11yRuleRollup[] {
  return rollup.rules.filter((r) => r.impact === impact);
}

/** One row per rule per test. A rule that fires on four tests is four things to
 *  fix in four places, and a single row exiting to one of them would be picking
 *  a test out of a hat. */
export function ruleRows(
  rules: A11yRuleRollup[],
): { key: string; rule: A11yRuleRollup; testId: string; testName: string; steps: number; nodes: number }[] {
  const out = [];
  for (const rule of rules) {
    const byTest = new Map<string, { testName: string; steps: number; nodes: number }>();
    for (const site of rule.where) {
      const prev = byTest.get(site.testId);
      if (prev) {
        prev.steps++;
        prev.nodes += site.nodes;
      } else {
        byTest.set(site.testId, {
          testName: site.testName ?? "deleted test",
          steps: 1,
          nodes: site.nodes,
        });
      }
    }
    for (const [testId, agg] of byTest) {
      out.push({
        key: `${rule.impact}|${rule.id}|${testId}`,
        rule,
        testId,
        testName: agg.testName,
        steps: agg.steps,
        nodes: agg.nodes,
      });
    }
  }
  return out;
}

export function A11yDashboard({
  rollup,
  onDrill,
}: {
  rollup: A11yRollup;
  onDrill: (facet: string) => void;
}) {
  if (rollup.checkedRuns === 0) {
    return (
      <Panel title="By severity">
        <p className="gl-panel-note">
          No run has completed an accessibility check yet. Switch on “Check accessibility” in
          Options, beside Run test, then run a test.
        </p>
      </Panel>
    );
  }

  if (rollup.stepsWithNew === 0) {
    return (
      <Panel title="By severity" id={`${rollup.checkedRuns} checked`}>
        <p className="gl-panel-note">
          No unaccepted violations. Everything axe found on the steps it checked is in the accepted
          baseline.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="By severity" id="a step can be in more than one">
      {rollup.byImpact.map((row) => (
        <DrillRow
          key={row.impact}
          label={facetLabel("a11y", row.impact)}
          count={row.steps}
          detail={
            row.rules === 0
              ? "No rule at this severity"
              : `${row.rules} ${row.rules === 1 ? "rule" : "rules"} across the steps that carry them`
          }
          tone={row.steps > 0 ? toneFor(row.impact) : null}
          onClick={() => onDrill(row.impact)}
        />
      ))}
    </Panel>
  );
}

export function A11yLeaf({
  facet,
  rollup,
  onOpenTest,
}: {
  facet: string;
  rollup: A11yRollup;
  onOpenTest: (id: string) => void;
}) {
  if (!IMPACTS.includes(facet as (typeof IMPACTS)[number])) {
    return (
      <Panel title="Unknown severity">
        <p className="gl-panel-note">
          “{facet}” is not an accessibility severity. Go back and pick one from the list.
        </p>
      </Panel>
    );
  }
  const rows = ruleRows(rulesAt(rollup, facet));
  return (
    <Panel title={facetLabel("a11y", facet)} id={`${rows.length}`}>
      {rows.length === 0 ? (
        <p className="gl-panel-note">No unaccepted violation at this severity.</p>
      ) : (
        rows.map((row) => (
          <ExitRow
            key={row.key}
            // The rule's help text, with its axe id after it. The help text is
            // what the finding MEANS; the id is what you search for, and the
            // Visual view's badges name it too.
            name={`${row.rule.help} (${row.rule.id})`}
            detail={`${row.testName} · ${row.steps} ${
              row.steps === 1 ? "step" : "steps"
            } · ${row.nodes} ${row.nodes === 1 ? "element" : "elements"}`}
            onOpen={() => onOpenTest(row.testId)}
          />
        ))
      )}
    </Panel>
  );
}
