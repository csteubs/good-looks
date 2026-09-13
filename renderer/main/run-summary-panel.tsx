// The five panels a run that did not fail deserves. REDESIGN §6.1.
//
// The reasoning for each state's CONTENT is in `renderer/lib/run-summary.ts`,
// which decides the state and computes the facts. This file only renders them,
// which is the split that lets the interesting claims — "healed beats retry",
// "no median on a first run", "an absent speed is Unknown, never fast" — be
// tested as arithmetic instead of as markup under a DOM with no cascade.
//
// ONE SHAPE FOR ALL FIVE. Each panel is a headline sentence, an optional
// KeyValue grid of the facts behind it, and at most one call to action. They are
// not five layouts; a user who learns where the numbers are on a passed run
// should not have to relearn it on a healed one.
//
// THE COLOUR RULE, which is the part most easily got wrong here. Colour means
// OUTCOME. `passed` is the only one of the five that earns phos. `healed` is
// AMBER even though the run passed, because a healed pass is the run most worth
// distrusting and the one that looks most trustworthy — a mis-heal usually
// succeeds, since clicking the wrong button rarely throws. `retry` is amber
// when it can say the run is flaky or cannot rule it out, and neutral when
// something it can name explains the pass — including the test having changed,
// which makes the pass ordinary rather than suspect.
// `running` takes the holo treatment rather than a hue (running is the ABSENCE
// of an outcome), and `never` is neutral because it is not a result at all.

import { AlertTriangle, ArrowRight, Wrench } from "lucide-react";

import { KeyValue, StatusChip, Temp, Verdict, formatDuration } from "../theme";
import type { ToneName } from "../theme";
import type { HealEntry } from "../lib/recorder-types";
import type {
  HealedSummary,
  NeverSummary,
  PassedSummary,
  RetrySummary,
  RunSummary,
  RunningSummary,
} from "../lib/run-summary";
// The same renderer the Heals view uses. A second way of writing a locator on
// screen is a second thing to keep in step, and the review surfaces are exactly
// where two spellings of the same locator would be read as two locators.
import { formatLocator } from "./refine-selector-dialog";

/** Plural without the "(s)". A count of one reads as a mistake when it is
 *  followed by a plural noun, and this panel's whole job is to be believed. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function NeverPanel({ summary }: { summary: NeverSummary }) {
  return (
    <div className="gl-run-summary" data-gl="run-summary" data-state="never">
      <Verdict
        detail={
          summary.stepCount > 0
            ? `Running it executes ${plural(summary.stepCount, "step")} against the site and records the result.`
            : "There are no steps to run yet — record some, or add one by hand."
        }
      >
        This test has never run
      </Verdict>
      {/* No numbers grid: there are no facts yet, and a table of dashes is a
          worse answer than a sentence. */}
    </div>
  );
}

function RunningPanel({ summary }: { summary: RunningSummary }) {
  // Guarded against a total of zero rather than left to divide — a test whose
  // steps were deleted mid-run would otherwise render a NaN-width bar, which
  // browsers draw as full and reads as "finished".
  const pct = summary.total > 0 ? Math.min(100, (summary.done / summary.total) * 100) : 0;
  return (
    <div className="gl-run-summary" data-gl="run-summary" data-state="running">
      <Verdict
        detail={
          summary.failedSoFar > 0
            ? `${plural(summary.failedSoFar, "step")} has already failed — soft assertions keep the run going.`
            : undefined
        }
      >
        Step {Math.min(summary.done + 1, Math.max(summary.total, 1))} of {summary.total}
        <span className="gl-run-summary-aside">{formatDuration(summary.elapsedMs)} elapsed</span>
      </Verdict>
      {/* A bar rather than a spinner: the question is HOW FAR IN, and a spinner
          answers "still going", which the chip in the head already said. */}
      <div className="gl-run-progress" role="presentation">
        <div className="gl-run-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function PassedPanel({ summary }: { summary: PassedSummary }) {
  const rows = [
    {
      label: "Duration",
      value: <Temp ms={summary.durationMs} median={summary.medianMs} mode="delta" />,
    },
    { label: "Steps", value: String(summary.stepCount) },
    { label: "Screenshots", value: summary.captured ? "Captured" : "Not captured" },
  ];
  if (summary.a11yChecks > 0) {
    rows.push({
      label: "Accessibility",
      value:
        summary.a11yNewSteps > 0
          ? `${plural(summary.a11yChecks, "check")} · ${plural(summary.a11yNewSteps, "new violation")}`
          : `${plural(summary.a11yChecks, "check")} · none new`,
    });
  }
  {
    const aiTotal = summary.aiChecksPassed + summary.aiChecksFailed + summary.aiChecksUnevaluated;
    if (aiTotal > 0) {
      const parts = [`${summary.aiChecksPassed} passed`];
      if (summary.aiChecksFailed > 0) parts.push(`${summary.aiChecksFailed} FAILED`);
      if (summary.aiChecksUnevaluated > 0) parts.push(`${summary.aiChecksUnevaluated} unevaluated`);
      rows.push({ label: "AI checks", value: parts.join(" · ") });
    }
  }
  return (
    <div className="gl-run-summary" data-gl="run-summary" data-state="passed">
      <Verdict
        tone="phos"
        detail={
          summary.medianMs === null
            ? "First run — there is nothing to compare its timing against yet."
            : undefined
        }
      >
        {plural(summary.stepCount, "step")} held
      </Verdict>
      <KeyValue rows={rows} labelWidth={86} />
      {/* Reported here as well as on the Accessibility tab: an unaccepted
          violation nobody opens a tab to find is one nobody finds. */}
      {summary.a11yNewSteps > 0 ? (
        <p className="gl-run-summary-note">
          <AlertTriangle className="size-3" aria-hidden />
          {plural(summary.a11yNewSteps, "step")} found accessibility violations that are not in
          this test&rsquo;s baseline. They never fail a run.
        </p>
      ) : null}
    </div>
  );
}

/** One journal row, read as a sentence. The locator is the whole content, so it
 *  is mono and it is not truncated to a width — a heal you cannot read is a
 *  heal you cannot review. */
function HealRow({ entry }: { entry: HealEntry }) {
  return (
    <li className="gl-run-heal">
      <span className="gl-run-heal-step">{entry.stepLabel}</span>
      <span className="gl-run-heal-swap">
        {entry.originalLocator ? (
          <code className="gl-run-heal-locator">{formatLocator(entry.originalLocator)}</code>
        ) : (
          <span className="gl-note">unknown</span>
        )}
        <ArrowRight className="size-3" aria-hidden />
        <code className="gl-run-heal-locator">{formatLocator(entry.appliedLocator)}</code>
      </span>
      {/* "Suggested" and "applied" are genuinely different runs to have had:
          under suggest mode the test on disk was never changed. */}
      <StatusChip tone={entry.status === "reverted" ? "red" : undefined}>
        {entry.status === "pending"
          ? entry.applied
            ? "Applied"
            : "Suggested"
          : entry.status === "accepted"
            ? "Accepted"
            : "Reverted"}
      </StatusChip>
    </li>
  );
}

function HealedPanel({ summary, onReview }: { summary: HealedSummary; onReview?: () => void }) {
  return (
    <div className="gl-run-summary" data-gl="run-summary" data-state="healed">
      <Verdict
        tone="amber"
        detail="A substituted locator can click the wrong thing and still pass — that is what makes this worth reading."
      >
        Passed, after Auto-Heal changed {plural(summary.healedSteps, "step")}
      </Verdict>
      <KeyValue
        rows={[
          { label: "Healed", value: String(summary.healedSteps) },
          {
            label: "Not healed",
            // Absent means the run predates the field. "0" would claim Auto-Heal
            // tried nothing and failed at nothing, which is evidence this run
            // never produced.
            value: summary.healFailedSteps === null ? "Unknown" : String(summary.healFailedSteps),
          },
          { label: "Unreviewed", value: String(summary.pendingReview) },
        ]}
        labelWidth={86}
      />
      {summary.entries.length > 0 ? (
        <ul className="gl-run-heals">
          {summary.entries.map((e) => (
            <HealRow key={e.id} entry={e} />
          ))}
        </ul>
      ) : (
        // The counter lives on the run record and the rows live in the journal,
        // which retention prunes independently. Say so rather than rendering an
        // empty list that reads as "nothing changed".
        <p className="gl-note">The journal has no rows for this run.</p>
      )}
      {summary.pendingReview > 0 && onReview ? (
        <button type="button" className="gl-run-summary-action" onClick={onReview}>
          <Wrench className="size-3" aria-hidden />
          Review {plural(summary.pendingReview, "change")}
        </button>
      ) : null}
    </div>
  );
}

/** What the Recovered panel says, and how sure it is allowed to sound. */
export interface RetryReading {
  /** The claim, as the verdict's sentence. */
  headline: string;
  /** The evidence behind it. */
  detail: string;
  /** Amber when the pass is worth less than it looks; absent otherwise. */
  tone?: ToneName;
  /** Whether the before → after table of run settings belongs under it. */
  showDifferences: boolean;
}

/**
 * The five readings of a recovered run, as data.
 *
 * A FUNCTION RATHER THAN NESTED TERNARIES IN THE JSX, for two reasons. Five
 * readings crossed with a headline, a detail, a tone and a table is a truth
 * table, and a truth table written as markup is one nobody can check. And
 * `chipFor` in run-output.tsx needs the TONE: the chip and the verdict dot are
 * one judgement about one run, and two spellings of it would eventually
 * disagree on screen — an amber chip over a neutral sentence, or the reverse.
 *
 * ORDER IS THE DESIGN. A changed test dominates a changed setting: if the
 * steps are not the steps that failed, the pacing is a footnote. And every
 * reading below is scoped to evidence this app actually holds — the one that
 * says "flake" is the only one allowed to, and only when `stepsChanged` is
 * literally `false`.
 */
export function retryReading(summary: RetrySummary): RetryReading {
  // R24's: this run failed and passed again without ever ending, so the claim
  // is stronger than any cross-run one — there was no second run to differ in
  // anything, and no comparison was made or needed.
  if (summary.attempt > 0) {
    const attempts =
      summary.attempt === 1 ? "on one retry" : `over ${summary.attempt} retries`;
    return {
      headline: "Passed, on a retry",
      detail: `It failed and passed again inside this run, ${attempts}. Nothing changed in between — same process, same browser, same commit — so the test is flaky.`,
      tone: "amber",
      showDifferences: false,
    };
  }
  // The reading this panel was missing. A pass after the test was edited is an
  // ORDINARY pass, so it takes no amber: nothing here is worth less than it
  // looks, there is simply nothing to conclude about the old failure from it.
  if (summary.stepsChanged === true) {
    return {
      headline: "Passed, after the test changed",
      detail:
        "What this run executed is not what the failing run executed, so the pass is not evidence about that failure. Run it again to see whether it holds.",
      tone: undefined,
      showDifferences: summary.differences.length > 0,
    };
  }
  if (summary.differences.length > 0) {
    return {
      headline: "Passed, after failing last time",
      detail:
        "One of these could be the whole reason it passed. Re-run it under the old settings to find out.",
      tone: undefined,
      showDifferences: true,
    };
  }
  // EARNED, and only here: the run settings matched AND the digests say the
  // test itself did. This sentence used to be printed whenever the settings
  // matched, over tests that had been rewritten in between.
  if (summary.stepsChanged === false) {
    return {
      headline: "Passed, and nothing was different",
      detail:
        "Same engine, same pacing, same budget, and the same steps — so this is flake rather than a fix.",
      tone: "amber",
      showDifferences: false,
    };
  }
  // `null`: one of the two runs predates `stepsDigest`, arrived without it, or
  // the two are under different schemes. The settings claim is still true and
  // is all that may be said — the panel names its own blind spot rather than
  // filling it in, because filling it in is what shipped the wrong sentence.
  return {
    headline: "Passed, and nothing about the run was different",
    detail:
      "Same engine, same pacing, same budget. Whether the test itself changed is not recorded for these two runs, so flake is a reading rather than a finding.",
    tone: "amber",
    showDifferences: false,
  };
}

function RetryPanel({ summary }: { summary: RetrySummary }) {
  const reading = retryReading(summary);
  return (
    <div className="gl-run-summary" data-gl="run-summary" data-state="retry">
      <Verdict tone={reading.tone} detail={reading.detail}>
        {reading.headline}
      </Verdict>
      {reading.showDifferences ? (
        <KeyValue
          rows={summary.differences.map((d) => ({
            label: d.label,
            value: (
              <span className="gl-run-diff">
                <span className="gl-run-diff-before">{d.before}</span>
                <ArrowRight className="size-3" aria-hidden />
                <span>{d.after}</span>
              </span>
            ),
          }))}
          labelWidth={86}
        />
      ) : null}
    </div>
  );
}

export function RunSummaryPanel({
  summary,
  /** Opens the Heals tab. Absent in the contexts that have no tabs. */
  onReview,
}: {
  summary: RunSummary;
  onReview?: () => void;
}) {
  switch (summary.state) {
    case "never":
      return <NeverPanel summary={summary} />;
    case "running":
      return <RunningPanel summary={summary} />;
    case "passed":
      return <PassedPanel summary={summary} />;
    case "healed":
      return <HealedPanel summary={summary} onReview={onReview} />;
    case "retry":
      return <RetryPanel summary={summary} />;
    // `failed` renders nothing here on purpose — RunTriage is that state's
    // panel and it already answers the question. A second panel above it would
    // put a summary of the failure over the diagnosis OF the failure.
    case "failed":
      return null;
  }
}
