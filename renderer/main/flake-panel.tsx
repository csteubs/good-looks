// Flake and failure analytics, above the pass/fail chart in Stats.
//
// The pass rate this sits above cannot answer the question people bring to it.
// A test at 50% might alternate on every run — unstable, next result is a coin
// toss — or it might have worked ten times, broken, and stayed broken, which is
// a regression with a date on it. This panel exists to tell those apart, so its
// job is to say WHICH, in words, before it shows any number.

import * as React from "react";
import { Badge, Button, ScrollArea, Text } from "@glaze/core/components";
import { Activity, ChevronDown, ChevronRight, Wand2 } from "lucide-react";

import type { FailureCluster, StabilityVerdict, TestFlake } from "../lib/recorder-types";

/** Plain-language verdicts. The label is the finding — a user should be able to
 *  act on the badge alone without decoding a percentage. */
const VERDICT: Record<
  StabilityVerdict,
  { label: string; color: "red" | "orange" | "yellow" | "green" | "secondary"; hint: string }
> = {
  flaky: {
    label: "Flaky",
    color: "orange",
    hint: "Passes and fails without the test changing. The next result is a coin toss.",
  },
  "data-dependent": {
    label: "Data-dependent",
    color: "yellow",
    hint: "Fails consistently on particular dataset rows and passes on the rest — reliable, and telling you something true about that data.",
  },
  "changed-since": {
    label: "Broke recently",
    color: "red",
    hint: "Was passing, started failing, and has stayed that way. A regression with a date on it.",
  },
  "still-failing": {
    label: "Consistently failing",
    color: "red",
    hint: "Has failed every run in the window. Broken rather than unstable.",
  },
  fixed: { label: "Fixed", color: "green", hint: "Was failing, now passing, and has stayed that way." },
  stable: { label: "Stable", color: "green", hint: "Passed every run in the window." },
  unknown: { label: "Too few runs", color: "secondary", hint: "Not enough runs yet to say anything." },
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
  const v = VERDICT[test.verdict];

  // Always expandable. An earlier version gated this on having step or dataset
  // detail, which made the verdict's EXPLANATION unreachable for the plainest
  // case — a test that just alternates. That explanation is the most useful
  // thing here, so there is always something behind the row.
  return (
    <div className="rounded-md border border-token-border">
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
        <Badge color={v.color} title={v.hint}>
          {v.label}
        </Badge>
        <Text variant="small" color="tertiary" className="w-28 shrink-0 text-right tabular-nums">
          {test.passed}/{test.runs} passed
        </Text>
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-separator px-3 py-2">
          <Text variant="small" color="secondary">
            {v.hint}
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
    <div className="flex flex-col gap-1 rounded-md border border-token-border px-3 py-2">
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
    <div className="rounded-lg border border-token-border bg-token-surface-raised p-4">
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
        <ScrollArea className="max-h-72">
          <div className="flex flex-col gap-1.5 pr-1">
            {shown.map((t) => (
              <TestRow key={t.testId} test={t} />
            ))}
          </div>
        </ScrollArea>
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
