// Flake and failure analytics in Stats, below the pass/fail chart and the
// summary cards.
//
// The pass rate above cannot answer the question people bring to it.
// A test at 50% might alternate on every run — unstable, next result is a coin
// toss — or it might have worked ten times, broken, and stayed broken, which is
// a regression with a date on it. This panel exists to tell those apart, so its
// job is to say WHICH, in words, before it shows any number.

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui";
import { ChevronDown, ChevronRight, RotateCw, Wand2 } from "lucide-react";

import { Btn, Panel, TONE, toneSurface } from "../theme";
import type { ToneName } from "../theme";
import { MIN_RUNS_FOR_VERDICT } from "../lib/recorder-types";
import type { FailureCluster, StabilityVerdict, TestFlake } from "../lib/recorder-types";

/** Plain-language verdicts. The label is the finding — a user should be able to
 *  act on the badge alone without decoding a percentage.
 *
 *  `hint` says what the verdict MEANS; `rule` says how it was decided. Both,
 *  because the deciding measure is not the one people assume: a verdict comes
 *  from TRANSITIONS (how often consecutive runs disagree), not from the pass
 *  rate, so 4 passes then 4 failures is a regression while alternating
 *  pass/fail/pass/fail is flaky — and those two have the identical 50%.
 *
 *  `tone` is `null` for `unknown`, which is the one verdict that is not
 *  reporting an outcome — "too few runs" is the absence of a result, and
 *  colouring it would claim one.
 *
 *  FLAKY AND DATA-DEPENDENT SHARE AMBER, and that is not a collapse of the old
 *  orange/yellow pair by accident. The palette has four status hues and they
 *  mean pass, running, caution and fail; inventing a fifth to keep two shades
 *  of caution apart would spend a colour on a distinction the WORD already
 *  makes — and this panel's entire premise is that the word is what you act on.
 *
 *  EXPORTED so the copy itself can be asserted. The tooltip that shows it
 *  cannot be opened in jsdom (Radix's Tooltip needs pointer APIs jsdom lacks —
 *  the same class of problem as the native-menu Select), so testing the hover
 *  is not on offer; testing that the words are right is, and that is the part
 *  that can be wrong. The expanded row renders the same strings, which is the
 *  path a keyboard or touch user takes anyway. */
export const VERDICT_COPY: Record<
  StabilityVerdict,
  {
    label: string;
    tone: ToneName | null;
    hint: string;
    rule: string;
  }
> = {
  flaky: {
    label: "Flaky",
    tone: "amber",
    hint: "Passes and fails without the test changing. The next result is a coin toss.",
    rule: "Mixed results that flipped between passing and failing 2 or more times.",
  },
  "data-dependent": {
    label: "Data-dependent",
    tone: "amber",
    hint: "Fails consistently on particular dataset rows and passes on the rest — reliable, and telling you something true about that data.",
    rule: "Every dataset row is consistent with itself: some always pass, others always fail.",
  },
  "browser-dependent": {
    label: "Engine-dependent",
    tone: "amber",
    hint: "Fails consistently on some engines and passes on the others — a real difference between browsers, not instability.",
    rule: "Every engine is consistent with itself: some always pass, others always fail.",
  },
  "changed-since": {
    label: "Broke recently",
    tone: "red",
    hint: "Was passing, started failing, and has stayed that way. A regression with a date on it.",
    rule: "Exactly one flip, and the most recent run failed.",
  },
  "still-failing": {
    label: "Consistently failing",
    tone: "red",
    hint: "Has failed every run in the window. Broken rather than unstable.",
    rule: "Every run in the window failed.",
  },
  fixed: {
    label: "Fixed",
    tone: "phos",
    hint: "Was failing, now passing, and has stayed that way.",
    rule: "Exactly one flip, and the most recent run passed.",
  },
  stable: {
    label: "Stable",
    tone: "phos",
    hint: "Passed every run in the window.",
    rule: "No failures in the window.",
  },
  unknown: {
    label: "Too few runs",
    tone: null,
    hint: "Not enough runs yet to say anything.",
    rule: `Fewer than ${MIN_RUNS_FOR_VERDICT} runs — too few to tell a flake from a coincidence.`,
  },
};

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The verdict badge.
 *
 *  NOT a `StatusChip`, and the reason is the one shared.css already writes down
 *  for the heal chips: `StatusChip` is fixed at `--gl-status-w` so that a
 *  COLUMN of them has one edge, and these labels are "Flaky" through
 *  "Consistently failing" — twenty characters, which that fixed box would
 *  silently clip. The label IS the finding here, so truncating it to satisfy a
 *  layout contract this row is not part of would remove the thing the panel
 *  exists to say. `.gl-chip-tone` is the variable-width tinted chip for this.
 *
 *  (The width is deliberately not quoted above. `check:status-width` treats a
 *  second copy of the number as a failure wherever it appears, comments
 *  included, and it is right to: a comment naming the wrong pixel count is a
 *  worse artefact than no comment.) */
function VerdictChip({ verdict }: { verdict: StabilityVerdict }) {
  const v = VERDICT_COPY[verdict];
  return (
    <span
      className={v.tone ? "gl-chip-tone" : "gl-chip"}
      style={v.tone ? toneSurface(TONE[v.tone]) : undefined}
    >
      {v.label}
    </span>
  );
}

function TestRow({ test }: { test: TestFlake }) {
  const [open, setOpen] = React.useState(false);
  const v = VERDICT_COPY[test.verdict];

  // Always expandable. An earlier version gated this on having step or dataset
  // detail, which made the verdict's EXPLANATION unreachable for the plainest
  // case — a test that just alternates. That explanation is the most useful
  // thing here, so there is always something behind the row.
  return (
    <div className="gl-flake-row">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="gl-flake-head"
        aria-expanded={open}
      >
        <span className="gl-flake-caret">
          {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        </span>
        <span className="gl-flake-name">{test.testName}</span>
        {test.healedRuns > 0 ? (
          // Neutral, not toned: how often Auto-Heal intervened is a fact about
          // the run, and the verdict beside it is what reports the outcome.
          <span
            className="gl-chip"
            title={`Auto-Heal substituted a locator in ${test.healedRuns} runs`}
          >
            <Wand2 aria-hidden="true" className="gl-mini-icon me-[3px]" />
            {test.healedRuns}
          </span>
        ) : null}
        {test.retriedRuns > 0 ? (
          // Beside the heal chip, and load-bearing rather than decorative: a
          // retried pass is what keeps this test's verdict off "stable", and
          // without the chip that verdict has no visible cause at all — the
          // pass rate reads 100% and the badge says flaky.
          <span
            className="gl-chip"
            title={`Failed and passed on a retry in ${test.retriedRuns} runs`}
          >
            <RotateCw aria-hidden="true" className="gl-mini-icon me-[3px]" />
            {test.retriedRuns}
          </span>
        ) : null}
        {/* The badge is a word the user is expected to act on, and none of the
            seven are self-explanatory — "Flaky" and "Broke recently" describe
            the same 50% pass rate. The tooltip carries both the meaning and the
            rule that produced it.

            The trigger is a SPAN, not the chip directly: this whole row is a
            <button>, and a button inside a button is invalid markup that
            swallows the inner click. Hover is therefore the only opener —
            keyboard users get the identical text in the expanded body below,
            which is what the row's own button opens. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span style={{ flex: "0 0 auto", display: "inline-flex" }}>
              <VerdictChip verdict={test.verdict} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-[260px] leading-snug">
            {v.hint} {v.rule}
          </TooltipContent>
        </Tooltip>
        <span className="gl-flake-count">
          {test.passed}/{test.runs} passed
        </span>
      </button>

      {open ? (
        <div className="gl-flake-body">
          <p className="gl-cost-say">{v.hint}</p>
          {/* The same rule the tooltip shows. Hover is unavailable to a keyboard
              or touch user, so the expanded row has to carry it too. */}
          <p className="gl-note">{v.rule}</p>
          {/* The transition count is the actual measure, so it's shown as one —
              a pass rate can't distinguish alternating from broken-and-stayed. */}
          <p className="gl-note">
            Changed between passing and failing {test.transitions}{" "}
            {test.transitions === 1 ? "time" : "times"} across {test.runs} runs.
          </p>

          {test.failingDatasets.length > 0 ? (
            <div className="gl-flake-group">
              <span className="gl-section-title">Failing rows</span>
              {test.failingDatasets.map((d) => (
                <div key={d.id} className="gl-flake-item">
                  <span className="gl-mono-value" style={{ flex: "1 1 auto" }}>
                    {d.name}
                  </span>
                  <span className="gl-flake-count">
                    failed {d.failed}/{d.runs}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {test.steps.length > 0 ? (
            <div className="gl-flake-group">
              <span className="gl-section-title">Steps involved</span>
              {test.steps.slice(0, 6).map((s) => (
                <div key={s.stepId} className="gl-flake-item">
                  <span className="gl-mono-value" style={{ flex: "1 1 auto" }}>
                    {s.label}
                  </span>
                  {s.failures > 0 ? (
                    <span className="gl-flake-count">failed {s.failures}×</span>
                  ) : null}
                  {s.heals > 0 ? (
                    <span className="gl-chip" title="Auto-Heal had to substitute a locator here">
                      <Wand2 aria-hidden="true" className="gl-mini-icon me-[3px]" />
                      {s.heals}×
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ClusterRow({ cluster }: { cluster: FailureCluster }) {
  return (
    <div className="gl-cluster">
      <div className="gl-cluster-head">
        {/* Toned only once it is a PATTERN. A signature seen in one run is a
            failure the run history already reports; the same signature across
            twelve is the finding this grouping exists to surface. */}
        <span
          className={cluster.count > 1 ? "gl-chip-tone" : "gl-chip"}
          style={cluster.count > 1 ? toneSurface(TONE.amber) : undefined}
        >
          {cluster.count} {cluster.count === 1 ? "run" : "runs"}
        </span>
        {cluster.stepLabel ? (
          <span className="gl-mono-value" style={{ flex: "1 1 auto" }}>
            {cluster.stepLabel}
          </span>
        ) : (
          <span style={{ flex: "1 1 auto" }} />
        )}
        <span className="gl-flake-count">{fmtWhen(cluster.lastSeenAt)}</span>
      </div>
      <p className="gl-cluster-text">{cluster.example || cluster.signature}</p>
    </div>
  );
}

export function FlakePanel({
  report,
}: {
  report: {
    tests: TestFlake[];
    clusters: FailureCluster[];
    analysedTests: number;
    windowRuns: number;
    windowCap: number;
  };
}) {
  const [showAll, setShowAll] = React.useState(false);
  // Hidden entirely until a verdict means something, matching the Capture
  // overhead panel's rule. A "50% flaky" badge computed from two runs is noise
  // wearing a statistic's clothes.
  if (report.analysedTests === 0) return null;

  const interesting = report.tests.filter(
    (t) => t.verdict !== "stable" && t.verdict !== "unknown",
  );
  const shown = showAll ? report.tests : interesting;

  return (
    <Panel
      title="Stability"
      id={
        `${report.analysedTests} ${report.analysedTests === 1 ? "test" : "tests"} over the last ` +
        `${report.windowRuns} ${report.windowRuns === 1 ? "run" : "runs"}` +
        // Say so when the window is capped, rather than presenting a partial
        // history as the whole one.
        (report.windowRuns >= report.windowCap ? ` (capped at ${report.windowCap})` : "")
      }
    >
      {/* No nested scroller, deliberately. This panel already lives inside the
          page-level one in stats-view, and a nested one broke twice over: it
          needs a definite height to clip at all, and even given one it would be
          wrong for this content — expanding a row has to grow the panel, and a
          nested scroller traps that growth behind a second scrollbar. Sizing to
          content and letting the page scroll is what every panel here does. */}
      <div className="gl-flake">
        {interesting.length === 0 && !showAll ? (
          <p className="gl-note">Every test with enough runs is passing consistently.</p>
        ) : (
          shown.map((t) => <TestRow key={t.testId} test={t} />)
        )}

        {report.tests.length > interesting.length ? (
          <div>
            <Btn tone="ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show only unstable tests" : `Show all ${report.tests.length} tests`}
            </Btn>
          </div>
        ) : null}

        {report.clusters.length > 0 ? (
          <div className="gl-flake-group" style={{ marginTop: 4, gap: 5 }}>
            <span className="gl-section-title">Failure causes</span>
            {/* Grouped, because one root cause across twenty runs is one problem.
                Ungrouped, the run history shows it as twenty. */}
            <p className="gl-note">
              Grouped by step and error, so a single cause reads as one problem.
            </p>
            {report.clusters.slice(0, 5).map((c, i) => (
              <ClusterRow key={i} cluster={c} />
            ))}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
