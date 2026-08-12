// What the suite costs, and what it is worth. REDESIGN §6.4.
//
// The arithmetic is in `renderer/lib/cost-model.ts` and is tested there. This
// renders it, and the one design decision that is entirely this file's is where
// the ASSUMPTIONS live.
//
// THEY ARE ON THE PANEL, NOT IN SETTINGS. Every figure here scales off two
// numbers this app guessed, and the plan's rule is that "a number nobody can
// check is a number nobody believes". A Settings row satisfies the letter of
// that — the value is editable somewhere — and defeats the point: a reader
// looking at "47 hours avoided" has to know the assumption exists, guess that
// Settings is where it lives, and find it, before they can judge whether the
// figure means anything. Putting the two inputs directly under the numbers they
// produce makes the derivation part of the reading rather than a scavenger hunt.
//
// AND THEY ARE NOT PERSISTED, deliberately. They are a lens, not a preference:
// you set them to your team's real numbers, read the panel, and the question is
// answered. Storing them would put a third thing in the settings file that has
// to be migrated, backed up and reasoned about, in exchange for saving one
// number-typing on the rare visit to this panel. The defaults are on screen and
// the edit is two keystrokes.

import { Pencil, RotateCcw } from "lucide-react";
import * as React from "react";

import { Panel, StatusChip, TONE } from "../theme";
import type { RunRecord } from "../lib/recorder-types";
import {
  COST_DEFAULTS,
  MIN_RUNS_FOR_NEVER_CAUGHT,
  coerceAssumption,
  computeCost,
  formatHours,
  formatMinutes,
  formatSpend,
  reviewReason,
  type CostAssumptions,
} from "../lib/cost-model";

/** The sentence under a called-out row. Exported so the test asserts the string
 *  the user reads — a verdict with no reason is an assertion, and this table's
 *  whole job is to be checkable. */
export const REVIEW_COPY = {
  flaky: "Most of its failures look like flake — it is spending time without reporting anything.",
  "never-caught": `Run ${MIN_RUNS_FOR_NEVER_CAUGHT}+ times and never failed. Not a bug, but worth asking what it guards.`,
} as const;

function Figure({
  label,
  value,
  unit,
  note,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  tone?: "amber";
}) {
  return (
    <div className="gl-cost-figure">
      <span className="gl-cost-figure-label">{label}</span>
      <span
        className="gl-cost-figure-value"
        style={tone === "amber" ? { color: TONE.amber } : undefined}
      >
        {value}
        {unit ? <span className="gl-cost-figure-unit">{unit}</span> : null}
      </span>
      {note ? <span className="gl-cost-figure-note">{note}</span> : null}
    </div>
  );
}

/** The two assumptions, stated and editable, under the figures they produce. */
function Assumptions({
  assumptions,
  onChange,
}: {
  assumptions: CostAssumptions;
  onChange: (next: CostAssumptions) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const isDefault =
    assumptions.costPerCiMinute === COST_DEFAULTS.costPerCiMinute &&
    assumptions.minutesPerManualRun === COST_DEFAULTS.minutesPerManualRun;

  if (!editing) {
    return (
      <p className="gl-cost-assume">
        Assuming <strong>{assumptions.costPerCiMinute}</strong> per CI minute and{" "}
        <strong>{assumptions.minutesPerManualRun}</strong> minutes to run one test by hand.
        {isDefault ? " Both are this app's guesses." : null}{" "}
        <button type="button" className="gl-cost-edit" onClick={() => setEditing(true)}>
          <Pencil className="size-3" aria-hidden />
          Edit these
        </button>
      </p>
    );
  }

  return (
    <div className="gl-cost-assume gl-cost-assume-editing">
      <label className="gl-cost-field">
        <span>Cost per CI minute</span>
        <input
          className="gl-cost-input"
          type="text"
          inputMode="decimal"
          autoFocus
          defaultValue={String(assumptions.costPerCiMinute)}
          aria-label="Cost per CI minute"
          onChange={(e) =>
            onChange({
              ...assumptions,
              costPerCiMinute: coerceAssumption("costPerCiMinute", e.target.value),
            })
          }
        />
      </label>
      <label className="gl-cost-field">
        <span>Minutes per manual run</span>
        <input
          className="gl-cost-input"
          type="text"
          inputMode="decimal"
          defaultValue={String(assumptions.minutesPerManualRun)}
          aria-label="Minutes per manual run"
          onChange={(e) =>
            onChange({
              ...assumptions,
              minutesPerManualRun: coerceAssumption("minutesPerManualRun", e.target.value),
            })
          }
        />
      </label>
      <button
        type="button"
        className="gl-cost-edit"
        onClick={() => {
          onChange(COST_DEFAULTS);
          setEditing(false);
        }}
      >
        <RotateCcw className="size-3" aria-hidden />
        Reset
      </button>
      <button type="button" className="gl-cost-edit" onClick={() => setEditing(false)}>
        Done
      </button>
    </div>
  );
}

export function CostPanel({ runs }: { runs: readonly RunRecord[] }) {
  const [assumptions, setAssumptions] = React.useState<CostAssumptions>(COST_DEFAULTS);
  const cost = React.useMemo(() => computeCost(runs, assumptions), [runs, assumptions]);

  if (cost.runs === 0) {
    return (
      <Panel title="Cost" id="what the suite costs">
        <p className="gl-note">
          Nothing has run yet. Cost is derived from run history — every figure here needs
          durations to work from.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="Cost" id={`${cost.runs} runs`}>
      <div className="gl-cost-figures">
        <Figure
          label="CI spend"
          value={formatSpend(cost.spend)}
          note={`${formatMinutes(cost.ciMinutes)} minutes of CI`}
        />
        <Figure
          label="Manual testing avoided"
          value={formatHours(cost.manualHoursAvoided)}
          note={`${cost.runs - cost.failures} passed runs`}
        />
        {/* THE RATIO IS IN ITS OWN UNIT, not in money. Converting saved time to
            currency needs an hourly rate this app was never told, and a dollar
            figure carries more authority than the guess behind it deserves. */}
        <Figure
          label="Return on spend"
          value={cost.hoursPerUnitSpent === null ? "—" : formatHours(cost.hoursPerUnitSpent)}
          unit={cost.hoursPerUnitSpent === null ? undefined : " per 1 spent"}
          note={
            cost.hoursPerUnitSpent === null
              ? "nothing spent yet"
              : "of manual testing bought"
          }
        />
        <Figure
          label="Failures caught"
          value={String(cost.failures)}
          note={cost.failures === 0 ? "none yet" : `${cost.flakeRuns} of them look like flake`}
        />
        {/* Amber, because it is the one figure here that is a cost with nothing
            bought — and amber is what this app spends on "worth your attention"
            everywhere else. */}
        <Figure
          label="Spent on flake"
          value={formatSpend(cost.flakeSpend)}
          note={`${formatMinutes(cost.flakeMinutes)} minutes re-running`}
          tone={cost.flakeSpend > 0 ? "amber" : undefined}
        />
      </div>

      <Assumptions assumptions={assumptions} onChange={setAssumptions} />

      <div className="gl-table-wrap">
        <table className="gl-table" aria-label="Spend by test">
          <thead>
            <tr>
              <th>Test</th>
              <th className="gl-cost-num">Runs</th>
              <th className="gl-cost-num">CI min</th>
              <th className="gl-cost-num">Spend</th>
              <th className="gl-cost-num">Avoided</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {cost.byTest.map((t) => {
              const reason = reviewReason(t);
              return (
                <tr key={t.testId}>
                  <td>
                    <span className="gl-cost-test">{t.testName}</span>
                    {reason ? <span className="gl-cost-why">{REVIEW_COPY[reason]}</span> : null}
                  </td>
                  <td className="gl-cost-num">{t.runs}</td>
                  <td className="gl-cost-num">{formatMinutes(t.ciMinutes)}</td>
                  <td className="gl-cost-num">{formatSpend(t.spend)}</td>
                  <td className="gl-cost-num">{formatHours(t.manualHoursAvoided)}</td>
                  <td>
                    {/* `earning` carries no tone at all. Colour means outcome in
                        this app, and "this test is behaving normally" is not an
                        outcome — a column of green chips would also drown the
                        few rows this table exists to surface. */}
                    <StatusChip tone={t.verdict === "review" ? "amber" : undefined}>
                      {t.verdict === "review" ? "Review" : "Earning"}
                    </StatusChip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
