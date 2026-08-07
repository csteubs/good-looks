// Accessibility tab on a test's detail view.
//
// The results existed long before this panel did — they were reachable only by
// leaving the test, opening the Visual view, finding the right run and scrubbing
// to a step. So a user who switched the check on, ran the test and stayed where
// they were saw nothing, which is indistinguishable from a feature that does
// nothing. This tab puts the answer next to the toggle that asks for it.
//
// It describes the most recent run that CHECKED (see `latestA11yRun`), not the
// most recent run: a later run with the toggle off must not blank the results.
//
// One rule governs the copy: never let "found nothing" and "measured nothing"
// render the same. A check that completed zero checks is reported as a fault.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  EmptyState,
  ScrollArea,
  Text,
  toast,
} from "@ui";
import { Accessibility, RotateCcw, Stamp, TriangleAlert } from "lucide-react";

import { api } from "../lib/api";
import { countA11ySteps, latestA11yRun } from "../lib/a11y-format";
import { A11yBadge, A11yViolationList } from "./a11y-violations";
import type { ReplayStep, RunReplay, TestRecord } from "../lib/recorder-types";

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StepViolations({
  step,
  onAccept,
  busy,
}: {
  step: ReplayStep;
  onAccept: () => void;
  busy: boolean;
}) {
  if (!step.a11y) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-separator p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Text weight="medium" className="min-w-0 truncate">
          {step.label || `Step ${step.index + 1}`}
        </Text>
        <A11yBadge result={step.a11y} />
        <div className="flex-1" />
        {step.a11y.newKeys.length > 0 ? (
          <AlertDialog
            trigger={
              <Button size="small" variant="glass" disabled={busy}>
                <Stamp className="size-3.5" />
                Accept these issues
              </Button>
            }
            title="Accept this step's accessibility issues?"
            description="They stop being flagged for this step on future runs. Existing acceptances are kept — this only adds."
            confirmLabel="Accept"
            confirmVariant="accent"
            onConfirm={onAccept}
          />
        ) : null}
      </div>
      <A11yViolationList result={step.a11y} />
    </div>
  );
}

export function A11yPanel({ test }: { test: TestRecord }) {
  const qc = useQueryClient();
  // Shares the ["runs"] key with Stats, so opening this tab usually costs no
  // round trip at all.
  const runsQuery = useQuery({ queryKey: ["runs"], queryFn: api.runs.list });
  const latest = React.useMemo(
    () => latestA11yRun(runsQuery.data ?? [], test.id),
    [runsQuery.data, test.id],
  );
  const replayQuery = useQuery({
    queryKey: ["replay", test.id, latest?.id],
    queryFn: () => api.artifacts.getReplay(test.id, latest?.id as string),
    enabled: Boolean(latest),
  });

  const patch = (next: RunReplay | null) => {
    if (!next) return;
    qc.setQueryData(["replay", test.id, latest?.id], next);
    // The run list badges the same numbers, and the Visual view reads the same
    // replay — leaving either stale would show two different answers.
    void qc.invalidateQueries({ queryKey: ["replays"] });
    void qc.invalidateQueries({ queryKey: ["runs"] });
  };

  const acceptStep = useMutation({
    mutationFn: (stepId: string) => api.a11y.acceptStep(test.id, latest?.id as string, stepId),
    onSuccess: (next) => {
      patch(next);
      toast.success("Accessibility issues accepted for this step.");
    },
    onError: (err: unknown) => toast.error(String(err)),
  });

  const acceptRun = useMutation({
    mutationFn: () => api.a11y.acceptRun(test.id, latest?.id as string),
    onSuccess: (next) => {
      patch(next);
      toast.success("Accessibility issues accepted for this run.");
    },
    onError: (err: unknown) => toast.error(String(err)),
  });

  const resetBaseline = useMutation({
    mutationFn: () => api.a11y.resetBaseline(test.id),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["replays"] });
      toast.success(
        res.cleared > 0
          ? "Accepted issues cleared. The next run reports everything again."
          : "There was nothing accepted for this test.",
      );
    },
    onError: (err: unknown) => toast.error(String(err)),
  });

  const busy = acceptStep.isPending || acceptRun.isPending;

  if (runsQuery.isLoading || (Boolean(latest) && replayQuery.isLoading)) {
    return (
      <div className="p-4">
        <Text variant="small" color="tertiary">
          Loading…
        </Text>
      </div>
    );
  }

  if (!latest) {
    return (
      <EmptyState
        title="No accessibility results yet"
        description={
          test.a11yChecks
            ? "This test checks accessibility, but hasn’t been run since that was turned on. Run it and the results appear here."
            : "Switch on “Check accessibility” beside Run test, then run this test. Results appear here."
        }
      />
    );
  }

  const replay = replayQuery.data;
  const steps = (replay?.steps ?? []).filter((s) => s.a11y);
  const newSteps = countA11ySteps(replay?.steps ?? []);
  const checks = latest.a11yChecks ?? 0;

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Accessibility className="size-4 text-tertiary" />
          <Text weight="medium">Last checked {fmtWhen(latest.startedAt)}</Text>
          {checks > 0 ? (
            <Badge variant="secondary">
              {checks} check{checks === 1 ? "" : "s"}
            </Badge>
          ) : null}
          <div className="flex-1" />
          {newSteps > 0 ? (
            <AlertDialog
              trigger={
                <Button size="small" variant="glass" disabled={busy}>
                  <Stamp className="size-3.5" />
                  Accept all in this run
                </Button>
              }
              title="Accept every accessibility issue in this run?"
              description="They stop being flagged on future runs. Use this to establish a starting point on a site with pre-existing issues — new problems introduced later will still show up."
              confirmLabel="Accept all"
              confirmVariant="accent"
              onConfirm={() => acceptRun.mutate()}
            />
          ) : null}
          <AlertDialog
            trigger={
              <Button size="small" variant="ghost" disabled={resetBaseline.isPending}>
                <RotateCcw className="size-3.5" />
                Reset accepted
              </Button>
            }
            title="Forget what this test has accepted?"
            description="Every accessibility issue accepted for this test is unaccepted. Nothing changes until the next run, which will then report all of them again. This is the way back from an over-eager “Accept all”."
            confirmLabel="Reset"
            confirmVariant="destructive"
            onConfirm={() => resetBaseline.mutate()}
          />
        </div>

        {/* The check ran and produced nothing. Reported as the fault it is:
            "no issues found" here would be the most confident possible way of
            being wrong, and is exactly how a broken check hid for months. */}
        {checks === 0 ? (
          <Callout color="red" icon={<TriangleAlert className="size-4" />}>
            The check ran on this run but completed none — no results were produced. Open this run in
            Stats and read its output for the reason.
          </Callout>
        ) : steps.length === 0 ? (
          <Callout color="green" icon={<Accessibility className="size-4" />}>
            No accessibility issues found on this run.
          </Callout>
        ) : newSteps === 0 ? (
          <Callout color="secondary" icon={<Accessibility className="size-4" />}>
            Nothing new. Every issue below has been accepted for this test — the run is clean against
            your baseline, not against the page.
          </Callout>
        ) : (
          <Callout color="orange" icon={<Accessibility className="size-4" />}>
            {newSteps} {newSteps === 1 ? "step has" : "steps have"} accessibility issues that aren’t
            accepted yet. This never affects whether the test passes.
          </Callout>
        )}

        {steps.map((s) => (
          <StepViolations
            key={s.stepId}
            step={s}
            busy={busy}
            onAccept={() => acceptStep.mutate(s.stepId)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
