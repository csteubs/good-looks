// Flake and failure analytics in Stats, below the pass/fail chart and the
// summary cards.
//
// The pass rate above cannot answer the question people bring to it.
// A test at 50% might alternate on every run — unstable, next result is a coin
// toss — or it might have worked ten times, broken, and stayed broken, which is
// a regression with a date on it. This panel exists to tell those apart, so its
// job is to say WHICH, in words, before it shows any number.

import * as React from "react";
import { Badge, Button, Text, Tooltip, TooltipContent, TooltipTrigger } from "@glaze/core/components";
import { Activity, ChevronDown, ChevronRight, Wand2 } from "lucide-react";

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
    color: "red" | "orange" | "yellow" | "green" | "secondary";
    hint: string;
    rule: string;
  }
> = {
  flaky: {
    label: "Flaky",
    color: "orange",
    hint: "Passes and fails without the test changing. The next result is a coin toss.",
    rule: "Mixed results that flipped between passing and failing 2 or more times.",
  },
  "data-dependent": {
    label: "Data-dependent",
    color: "yellow",
    hint: "Fails consistently on particular dataset rows and passes on the rest — reliable, and telling you something true about that data.",
    rule: "Every dataset row is consistent with itself: some always pass, others always fail.",
  },
  "changed-since": {
    label: "Broke recently",
    color: "red",
    hint: "Was passing, started failing, and has stayed that way. A regression with a date on it.",
    rule: "Exactly one flip, and the most recent run failed.",
  },
  "still-failing": {
    label: "Consistently failing",
    color: "red",
    hint: "Has failed every run in the window. Broken rather than unstable.",
    rule: "Every run in the window failed.",
  },
  fixed: {
    label: "Fixed",
    color: "green",
    hint: "Was failing, now passing, and has stayed that way.",
    rule: "Exactly one flip, and the most recent run passed.",
  },
  stable: {
    label: "Stable",
    color: "green",
    hint: "Passed every run in the window.",
    rule: "No failures in the window.",
  },
  unknown: {
    label: "Too few runs",
    color: "secondary",
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

function TestRow({ test }: { test: TestFlake }) {
  const [open, setOpen] = React.useState(false);
  const v = VERDICT_COPY[test.verdict];

  // Always expandable. An earlier version gated this on having step or dataset
  // detail, which made the verdict's EXPLANATION unreachable for the plainest
  // case — a test that just alternates. That explanation is the most useful
  // thing here, so there is always something behind the row.
  return (
    <div className="rounded-md border border-separator">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-control-subtle"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-tertiary" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-tertiary" />
        )}
        <Text variant="small" className="min-w-0 flex-1 truncate font-medium">
          {test.testName}
        </Text>
        {test.healedRuns > 0 ? (
          <Badge color="secondary" title={`Auto-Heal substituted a locator in ${test.healedRuns} runs`}>
            <Wand2 className="size-3" />
            {test.healedRuns}
          </Badge>
        ) : null}
        {/* The badge is a word the user is expected to act on, and none of the
            seven are self-explanatory — "Flaky" and "Broke recently" describe
            the same 50% pass rate. The tooltip carries both the meaning and the
            rule that produced it.

            The trigger is a SPAN, not the Badge directly: this whole row is a
            <button>, and a button inside a button is invalid markup that
            swallows the inner click. Hover is therefore the only opener —
            keyboard users get the identical text in the expanded body below,
            which is what the row's own button opens. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0">
              <Badge color={v.color}>{v.label}</Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-[260px] leading-snug">
            {v.hint} {v.rule}
          </TooltipContent>
        </Tooltip>
        <Text variant="small" color="tertiary" className="w-28 shrink-0 text-right tabular-nums">
          {test.passed}/{test.runs} passed
        </Text>
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-separator px-3 py-2">
          <Text variant="small" color="secondary">
            {v.hint}
          </Text>
          {/* The same rule the tooltip shows. Hover is unavailable to a keyboard
              or touch user, so the expanded row has to carry it too. */}
          <Text variant="small" color="tertiary">
            {v.rule}
          </Text>
          {/* The transition count is the actual measure, so it's shown as one —
              a pass rate can't distinguish alternating from broken-and-stayed. */}
          <Text variant="small" color="tertiary">
            Changed between passing and failing {test.transitions}{" "}
            {test.transitions === 1 ? "time" : "times"} across {test.runs} runs.
          </Text>

          {test.failingDatasets.length > 0 ? (
            <div className="flex flex-col gap-1">
              <Text variant="small" className="font-medium">
                Failing rows
              </Text>
              {test.failingDatasets.map((d) => (
                <div key={d.id} className="flex items-center gap-2">
                  <Text variant="small" className="min-w-0 flex-1 truncate">
                    {d.name}
                  </Text>
                  <Text variant="small" color="tertiary" className="tabular-nums">
                    failed {d.failed}/{d.runs}
                  </Text>
                </div>
              ))}
            </div>
          ) : null}

          {test.steps.length > 0 ? (
            <div className="flex flex-col gap-1">
              <Text variant="small" className="font-medium">
                Steps involved
              </Text>
              {test.steps.slice(0, 6).map((s) => (
                <div key={s.stepId} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-secondary">
                    {s.label}
                  </code>
                  {s.failures > 0 ? (
                    <Text variant="small" color="tertiary" className="tabular-nums">
                      failed {s.failures}×
                    </Text>
                  ) : null}
                  {s.heals > 0 ? (
                    <Badge color="secondary" title="Auto-Heal had to substitute a locator here">
                      <Wand2 className="size-3" />
                      {s.heals}×
                    </Badge>
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
    <div className="flex flex-col gap-1 rounded-md border border-separator px-3 py-2">
      <div className="flex items-center gap-2">
        <Badge color={cluster.count > 1 ? "orange" : "secondary"}>
          {cluster.count} {cluster.count === 1 ? "run" : "runs"}
        </Badge>
        {cluster.stepLabel ? (
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-secondary">
            {cluster.stepLabel}
          </code>
        ) : (
          <div className="flex-1" />
        )}
        <Text variant="small" color="tertiary">
          {fmtWhen(cluster.lastSeenAt)}
        </Text>
      </div>
      <Text variant="small" className="break-words">
        {cluster.example || cluster.signature}
      </Text>
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
    <div className="rounded-lg border border-separator bg-panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-secondary" />
          <Text variant="small" className="font-medium">
            Stability
          </Text>
        </div>
        <Text variant="small" color="tertiary">
          {report.analysedTests} {report.analysedTests === 1 ? "test" : "tests"} over the last{" "}
          {report.windowRuns} {report.windowRuns === 1 ? "run" : "runs"}
          {/* Say so when the window is capped, rather than presenting a partial
              history as the whole one. */}
          {report.windowRuns >= report.windowCap ? ` (capped at ${report.windowCap})` : ""}
        </Text>
      </div>

      {interesting.length === 0 && !showAll ? (
        <Text variant="small" color="tertiary">
          Every test with enough runs is passing consistently.
        </Text>
      ) : (
        // No ScrollArea here, deliberately. This panel already lives inside the
        // page-level one in stats-view, and a nested scroller broke twice over:
        //
        //   • The SDK's ScrollArea needs a DEFINITE height — its viewport sizes
        //     against the root. Given only `max-h-72` there was nothing to size
        //     against, so nothing clipped: the list overflowed its box and
        //     painted on top of the "Show all" button and the Failure causes
        //     section, while the parent still reserved only 288px for it.
        //   • Even at a fixed height it would be wrong for this content —
        //     expanding a row has to grow the panel, and a nested scroller
        //     traps that growth behind a second scrollbar.
        //
        // Sizing to content and letting the page scroll is what every other
        // panel on this view does.
        <div className="flex flex-col gap-1.5">
          {shown.map((t) => (
            <TestRow key={t.testId} test={t} />
          ))}
        </div>
      )}

      {report.tests.length > interesting.length ? (
        <Button
          size="small"
          variant="ghost"
          className="mt-2"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll
            ? "Show only unstable tests"
            : `Show all ${report.tests.length} tests`}
        </Button>
      ) : null}

      {report.clusters.length > 0 ? (
        <div className="mt-4 flex flex-col gap-1.5">
          <Text variant="small" className="font-medium">
            Failure causes
          </Text>
          {/* Grouped, because one root cause across twenty runs is one problem.
              Ungrouped, the run history shows it as twenty. */}
          <Text variant="small" color="tertiary">
            Grouped by step and error, so a single cause reads as one problem.
          </Text>
          <div className="flex flex-col gap-1.5 pt-1">
            {report.clusters.slice(0, 5).map((c, i) => (
              <ClusterRow key={i} cluster={c} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
