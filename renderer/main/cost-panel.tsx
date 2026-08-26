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
import { useNavigate } from "@tanstack/react-router";

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
  formatNetMinutes,
  formatRate,
  formatSpend,
  reviewReason,
  type CostAssumptions,
} from "../lib/cost-model";
import type { SavingsAssumptions, SavingsSummary } from "../lib/ai-debug-stats";
import {
  COST_DEFAULT_HOURLY_RATE,
  COST_DEFAULT_MINUTES_PER_MANUAL_DEBUG,
} from "../../shared/cost-units.mjs";

/** The sentence under a called-out row. Exported so the test asserts the string
 *  the user reads — a verdict with no reason is an assertion, and this table's
 *  whole job is to be checkable. */
export const REVIEW_COPY = {
  flaky: "Most of its failures look like flake — it is spending time without reporting anything.",
  "never-caught": `Run ${MIN_RUNS_FOR_NEVER_CAUGHT}+ times and never failed. Not a bug, but worth asking what it guards.`,
} as const;

/** One figure, and — when `math` is given — the arithmetic behind it.
 *
 *  HOVER (OR FOCUS) SWAPS THE NOTE FOR THE MATH, in place. This is the stat-card
 *  derivation convention: every derived figure should be able to show, on the
 *  card itself, the calculation that produced it with its live operands — the
 *  panel-wide assumptions sentence tells the reader the inputs, this tells them
 *  the multiplication. Both spans are always in the DOM (CSS does the swap), so
 *  tests assert the derivation string directly rather than simulating hover —
 *  which jsdom cannot do anyway. A card with math is focusable, because a
 *  keyboard user is owed the same answer a mouse hover gets. */
function Figure({
  label,
  value,
  note,
  math,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  math?: string;
  tone?: "amber" | "green";
}) {
  return (
    <div
      className={math ? "gl-cost-figure gl-cost-figure-derives" : "gl-cost-figure"}
      tabIndex={math ? 0 : undefined}
    >
      <span className="gl-cost-figure-label">{label}</span>
      <span
        className="gl-cost-figure-value"
        style={
          tone === "amber"
            ? { color: TONE.amber }
            : tone === "green"
              ? { color: TONE.phos }
              : undefined
        }
      >
        {value}
      </span>
      {/* One grid cell, two occupants: the slot is sized by the TALLER of the
          two from first paint, so the swap moves nothing — the convention's
          whole promise. `visibility`, not `display`, is what makes that true. */}
      {note || math ? (
        <span className="gl-cost-figure-cap">
          {note ? <span className="gl-cost-figure-note">{note}</span> : null}
          {math ? <span className="gl-cost-figure-math">{math}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/** The debug-savings tile's copy, exported for the same reason `REVIEW_COPY`
 *  is: these strings are the tile's whole contract in its empty and negative
 *  states, and a test that asserts them asserts what the user actually reads.
 *  `noneKept` is the AI Debug dashboard's own phrase — two surfaces describing
 *  one rule should not describe it in two vocabularies. */
export const DEBUG_TILE_COPY = {
  waiting: "waiting on the debug history",
  noneKept: "no kept fix to claim time for",
  kept: (n: number) => `${n} kept ${n === 1 ? "fix" : "fixes"}, minus the wait`,
  negative: "net cost, not saving",
} as const;

/** The Debugging avoided tile's whole state, derived in one place so its four
 *  cases can be read together. The order is the honesty ladder: still loading
 *  ("—", waiting), nothing kept ("—", nothing to claim — with the RULE as its
 *  hover math, because a dash whose derivation is invisible reads as broken),
 *  a net figure in time (no hourly rate stated), a net figure in money (the
 *  user priced their hour). Negative goes amber in both units. */
export function debugTileFrom(
  savings: SavingsSummary | undefined,
  assumptions: SavingsAssumptions,
  currency: CostCurrency,
): { value: string; note: string; math?: string; tone?: "amber" | "green" } {
  if (!savings) return { value: "—", note: DEBUG_TILE_COPY.waiting };
  const { countedFixes, waitedMinutes, netMinutes, netValue } = savings;
  if (countedFixes === 0) {
    return {
      value: "—",
      note: DEBUG_TILE_COPY.noneKept,
      math: `kept fixes × ${assumptions.minutesPerManualDebug} min − time waiting on the model`,
    };
  }
  const negative = netMinutes < 0;
  const note = negative ? DEBUG_TILE_COPY.negative : DEBUG_TILE_COPY.kept(countedFixes);
  const tone = negative ? ("amber" as const) : undefined;
  // No "kept" in the equation — the note directly above it says "N kept
  // fixes", and the repeated word is what pushed this math to a third line,
  // which sizes the whole row (the caption slot reserves the math's height).
  const gross = `${countedFixes} × ${assumptions.minutesPerManualDebug} min − ${formatMinutes(waitedMinutes)} min wait`;
  if (netValue === null) {
    return { value: formatNetMinutes(netMinutes), note, tone, math: `${gross} = ${formatNetMinutes(netMinutes)}` };
  }
  // The money value is ABSOLUTE with the note carrying the sign — the AI Debug
  // dashboard's spelling, matched so the two surfaces print one number one way.
  // The math line keeps the sign, because it is the arithmetic.
  const money = formatSpend(Math.abs(netValue), currency);
  return {
    value: money,
    note,
    // Green on a positive money saving, matching the CI savings tile — the
    // panel's two dollar figures that are savings read in one colour. The
    // time-mode value stays neutral: green is spent on money here, for now.
    tone: tone ?? "green",
    math: `(${gross}) × ${formatRate(assumptions.hourlyRate, currency)}/h = ${negative ? "−" : ""}${money}`,
  };
}

/** Opens Settings on the Cost pane.
 *
 *  Deep-linked, not just "open Settings": the button's whole job is to answer
 *  "where do these numbers come from", and landing the reader on the board to
 *  find out is the scavenger hunt this panel spent its first design arguing
 *  against.
 *
 *  A NAVIGATION SINCE SETTINGS BECAME A VIEW. It was
 *  `window:openSettings("cost")`, which opened a second window and left this
 *  one behind; now the trail says Home › Settings › Cost and Back returns to
 *  the figures that sent you. */
function useOpenCostSettings(): () => void {
  const navigate = useNavigate();
  return React.useCallback(
    () => void navigate({ to: "/settings/$pane", params: { pane: "cost" } }),
    [navigate],
  );
}

/** The assumptions, stated in prose under the figures they produce. The hourly
 *  rate joins the sentence ONLY when the user has stated one — zero means
 *  "don't say" (`shared/cost-units.mjs`), and a sentence that read "and your
 *  hour at $0" would be the app inventing a wage. */
export function Assumptions({
  assumptions,
  debugAssumptions,
  currency,
}: {
  assumptions: CostAssumptions;
  debugAssumptions: SavingsAssumptions;
  currency: CostCurrency;
}) {
  const openCostSettings = useOpenCostSettings();
  // The blanket claim drops the moment ANY number here is the user's own —
  // including the hourly rate, which is never a guess: zero is "unset" and
  // anything else was typed. "All are this app's guesses" over a wage the user
  // stated would be the sentence disowning the one number it did not invent.
  const isDefault =
    assumptions.costPerCiMinute === COST_DEFAULTS.costPerCiMinute &&
    assumptions.minutesPerManualRun === COST_DEFAULTS.minutesPerManualRun &&
    debugAssumptions.minutesPerManualDebug === COST_DEFAULT_MINUTES_PER_MANUAL_DEBUG &&
    debugAssumptions.hourlyRate === COST_DEFAULT_HOURLY_RATE;

  return (
    <p className="gl-cost-assume">
      {/* `formatRate`, not `formatSpend`: the rate is 0.008 and two decimals
          would render it as "<$0.01" — a sentence that exists to make the
          figures checkable, withholding the number. */}
      Assumes <strong>{formatRate(assumptions.costPerCiMinute, currency)}</strong> per CI minute,{" "}
      <strong>{assumptions.minutesPerManualRun}</strong> minutes to run one test by hand, and{" "}
      <strong>{debugAssumptions.minutesPerManualDebug}</strong> minutes to debug one failure
      {debugAssumptions.hourlyRate > 0 ? (
        <>
          , with your hour at{" "}
          <strong>{formatRate(debugAssumptions.hourlyRate, currency)}</strong>
        </>
      ) : null}
      .{isDefault ? " All are this app's guesses." : null}{" "}
      <button type="button" className="gl-cost-edit" onClick={openCostSettings}>
        <SlidersHorizontal className="size-3" aria-hidden />
        Edit in Settings
      </button>
    </p>
  );
}

export function CostPanel({
  runs,
  // All come from persisted settings, and all have a default so the panel
  // renders honestly while the settings query is still in flight — the shipped
  // guesses are exactly what it would show anyway.
  assumptions = COST_DEFAULTS,
  debugAssumptions = {
    minutesPerManualDebug: COST_DEFAULT_MINUTES_PER_MANUAL_DEBUG,
    hourlyRate: COST_DEFAULT_HOURLY_RATE,
  },
  // UNDEFINED MEANS "STILL LOADING", never "nothing saved" — the debug history
  // and script-change queries resolve after the run history does, and rendering
  // their gap as a zero would tell the user the feature wasted their time.
  debugSavings,
  currency = "usd",
}: {
  runs: readonly RunRecord[];
  assumptions?: CostAssumptions;
  debugAssumptions?: SavingsAssumptions;
  debugSavings?: SavingsSummary;
  currency?: CostCurrency;
}) {
  const [page, setPage] = React.useState(1);
  const cost = React.useMemo(() => computeCost(runs, assumptions), [runs, assumptions]);

  // Clamped, not trusted: retention prunes runs and a test can be deleted, so
  // the list can shrink under the page you are standing on — and an unclamped
  // page renders an empty table, which reads as "my history vanished".
  const safePage = clampPage(page, cost.byTest.length, DENSE_PAGE_SIZE);
  const visible = pageSlice(cost.byTest, safePage, DENSE_PAGE_SIZE);

  const debugTile = debugTileFrom(debugSavings, debugAssumptions, currency);

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
        {/* SAVINGS, not a bill. Every run counted here executed on this
            machine, so nobody was invoiced for it — the figure is what those
            minutes WOULD have cost at the CI rate in Settings, which is money
            the user did not spend. */}
        <Figure
          label="CI cost savings"
          value={formatSpend(cost.spend, currency)}
          tone="green"
          note={`${formatMinutes(cost.ciMinutes)} minutes of CI`}
          math={`${formatMinutes(cost.ciMinutes)} min × ${formatRate(assumptions.costPerCiMinute, currency)}/min = ${formatSpend(cost.spend, currency)}`}
        />
        <Figure
          label="Manual testing avoided"
          value={formatHours(cost.manualHoursAvoided)}
          note={`${cost.runs - cost.failures} passed runs`}
          math={`${cost.runs - cost.failures} passes × ${assumptions.minutesPerManualRun} min = ${formatHours(cost.manualHoursAvoided)}`}
        />
        {/* WHAT AI DEBUG GAVE BACK, priced only if the user said what an hour
            is worth. This tile surfaces `summariseSavings` — the AI Debug
            dashboard's own figure, one arithmetic with two readers, never a
            re-derivation — and inherits its two refusals: only a KEPT fix
            counts (a diagnosis nobody applied saved nothing, and a reverted
            one cost time), and the wait on the model is subtracted. With no
            hourly rate the value stays in time; with one it is money, which is
            what makes this the panel's one figure where savings turn into a
            number a manager recognises. It CAN be negative, and amber is how
            this panel already says "cost with nothing bought". */}
        <Figure
          label="Debugging avoided"
          value={debugTile.value}
          note={debugTile.note}
          math={debugTile.math}
          tone={debugTile.tone}
        />
        <Figure
          label="Failures caught"
          value={String(cost.failures)}
          // Gated on the flake count as well as the failure count: since R24 a
          // retried pass is flake without ever being a failure, so "none yet"
          // sat above a non-zero flake spend in the tile below it.
          note={
            cost.flakeRuns > 0
              ? `${cost.flakeRuns} look like flake`
              : cost.failures === 0
                ? "none yet"
                : "none look like flake"
          }
          math={`${cost.failures} of ${cost.runs} runs failed`}
        />
        {/* Amber, because it is the one figure here that is a cost with nothing
            bought — and amber is what this app spends on "worth your attention"
            everywhere else. */}
        <Figure
          label="Spent on flake"
          value={formatSpend(cost.flakeSpend, currency)}
          note={`${formatMinutes(cost.flakeMinutes)} minutes re-running`}
          math={`${formatMinutes(cost.flakeMinutes)} min re-run × ${formatRate(assumptions.costPerCiMinute, currency)}/min = ${formatSpend(cost.flakeSpend, currency)}`}
          tone={cost.flakeSpend > 0 ? "amber" : undefined}
        />
      </div>

      <Assumptions
        assumptions={assumptions}
        debugAssumptions={debugAssumptions}
        currency={currency}
      />

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
