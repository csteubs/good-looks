// What the suite costs, and what it is worth. REDESIGN §6.4.
//
// The arithmetic is in `renderer/lib/cost-model.ts` and is tested there. This
// renders it, and the one design decision that is entirely this file's is what
// it says about the ASSUMPTIONS behind the figures.
//
// THEY ARE STATED HERE AND SET IN SETTINGS → COST. The rule they exist to
// satisfy is the plan's — "a number nobody can check is a number nobody
// believes" — and stating them under the figures they produce is what
// satisfies it: a reader of "128h avoided" can see, without going anywhere,
// exactly what that claim rests on.
//
// EDITING THEM MOVED, and this file used to argue at length that it never
// should. The argument was that a Settings row makes the reader hunt for what
// produced the number. What it missed is the other half: an assumption you have
// to retype on every visit is one nobody sets twice, so the panel was in
// practice always read at the shipped guess — the exact outcome the design was
// trying to prevent. Persisting them costs one hunt, once, and the hunt is
// signposted by the button below the sentence. The sentence stays.

import { SlidersHorizontal } from "lucide-react";
import * as React from "react";

import { Panel, StatusChip, TONE } from "../theme";
import type { CostCurrency, RunRecord } from "../lib/recorder-types";
import { DENSE_PAGE_SIZE, clampPage, pageSlice } from "../lib/paginate";
import { Pager } from "./pager";
import {
  COST_DEFAULTS,
  MIN_RUNS_FOR_NEVER_CAUGHT,
  computeCost,
  formatHours,
  formatMinutes,
  formatRate,
  formatSpend,
  reviewReason,
  type CostAssumptions,
} from "../lib/cost-model";
import { currencySymbol } from "../../shared/cost-units.mjs";

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

/** Opens the Settings window on the Cost pane.
 *
 *  Deep-linked, not just "open Settings": the button's whole job is to answer
 *  "where do these numbers come from", and landing the reader on Appearance to
 *  find out is the scavenger hunt this panel spent its first design arguing
 *  against. */
function openCostSettings(): void {
  void window.glazeAPI.glaze.ipc.invoke("window:openSettings", "cost");
}

/** The two assumptions, stated in prose under the figures they produce. */
export function Assumptions({
  assumptions,
  currency,
}: {
  assumptions: CostAssumptions;
  currency: CostCurrency;
}) {
  const isDefault =
    assumptions.costPerCiMinute === COST_DEFAULTS.costPerCiMinute &&
    assumptions.minutesPerManualRun === COST_DEFAULTS.minutesPerManualRun;

  return (
    <p className="gl-cost-assume">
      {/* `formatRate`, not `formatSpend`: the rate is 0.008 and two decimals
          would render it as "<$0.01" — a sentence that exists to make the
          figures checkable, withholding the number. */}
      Assumes <strong>{formatRate(assumptions.costPerCiMinute, currency)}</strong> per CI minute
      and <strong>{assumptions.minutesPerManualRun}</strong> minutes to run one test by hand.
      {isDefault ? " Both are this app's guesses." : null}{" "}
      <button type="button" className="gl-cost-edit" onClick={openCostSettings}>
        <SlidersHorizontal className="size-3" aria-hidden />
        Edit in Settings
      </button>
    </p>
  );
}

export function CostPanel({
  runs,
  // Both come from persisted settings, and both have a default so the panel
  // renders honestly while the settings query is still in flight — the shipped
  // guesses are exactly what it would show anyway.
  assumptions = COST_DEFAULTS,
  currency = "usd",
}: {
  runs: readonly RunRecord[];
  assumptions?: CostAssumptions;
  currency?: CostCurrency;
}) {
  const [page, setPage] = React.useState(1);
  const cost = React.useMemo(() => computeCost(runs, assumptions), [runs, assumptions]);

  // Clamped, not trusted: retention prunes runs and a test can be deleted, so
  // the list can shrink under the page you are standing on — and an unclamped
  // page renders an empty table, which reads as "my history vanished".
  const safePage = clampPage(page, cost.byTest.length, DENSE_PAGE_SIZE);
  const visible = pageSlice(cost.byTest, safePage, DENSE_PAGE_SIZE);

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
          value={formatSpend(cost.spend, currency)}
          note={`${formatMinutes(cost.ciMinutes)} minutes of CI`}
        />
        <Figure
          label="Manual testing avoided"
          value={formatHours(cost.manualHoursAvoided)}
          note={`${cost.runs - cost.failures} passed runs`}
        />
        {/* THE RATIO'S VALUE IS STILL TIME, not money, and a currency picker
            does not change that: converting saved hours into cash needs an
            hourly rate this app was never told. The currency reaches only the
            DENOMINATOR — "per $1 spent" — which is a price the user did give
            it. */}
        <Figure
          label="Return on spend"
          value={cost.hoursPerUnitSpent === null ? "—" : formatHours(cost.hoursPerUnitSpent)}
          unit={
            cost.hoursPerUnitSpent === null
              ? undefined
              : ` per ${currencySymbol(currency)}1 spent`
          }
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
          value={formatSpend(cost.flakeSpend, currency)}
          note={`${formatMinutes(cost.flakeMinutes)} minutes re-running`}
          tone={cost.flakeSpend > 0 ? "amber" : undefined}
        />
      </div>

      <Assumptions assumptions={assumptions} currency={currency} />

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
            {visible.map((t) => {
              const reason = reviewReason(t);
              return (
                <tr key={t.testId}>
                  <td>
                    <span className="gl-cost-test">{t.testName}</span>
                    {reason ? <span className="gl-cost-why">{REVIEW_COPY[reason]}</span> : null}
                  </td>
                  <td className="gl-cost-num">{t.runs}</td>
                  <td className="gl-cost-num">{formatMinutes(t.ciMinutes)}</td>
                  <td className="gl-cost-num">{formatSpend(t.spend, currency)}</td>
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

      {/* `size` is not optional here even though it looks it: `Pager` computes
          its own counts, so a pager left at the default 50 over a table sliced
          at 25 reports half the pages and hides the rest behind a Next button
          that never enables. */}
      <Pager
        page={safePage}
        total={cost.byTest.length}
        onPage={setPage}
        label="tests"
        size={DENSE_PAGE_SIZE}
      />
    </Panel>
  );
}
