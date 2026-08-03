import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  NumberInput,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
  Text,
  Toolbar,
  ToolbarContent,
  ToolbarTitle,
} from "@glaze/core/components";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Diff,
  Eye,
  ImageOff,
  Stamp,
  TriangleAlert,
  X,
} from "lucide-react";

import { api } from "../lib/api";
import type {
  ReplayStep,
  ReplayStepStatus,
  RunReplay,
  RunReplaySummary,
  VisualDiff,
  VisualDiffState,
} from "../lib/recorder-types";

// ── Formatting ─────────────────────────────────────────────────────────
function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtPct(ratio: number): string {
  const pct = ratio * 100;
  if (pct === 0) return "0%";
  if (pct < 0.01) return "<0.01%";
  return `${pct.toFixed(2)}%`;
}

// ── Status → colors/labels ─────────────────────────────────────────────
function statusBar(status: ReplayStepStatus): string {
  switch (status) {
    case "passed":
      return "bg-support-green";
    case "failed":
      return "bg-support-red";
    default:
      return "bg-control-subtle";
  }
}

function StatusIcon({ status, className }: { status: ReplayStepStatus; className?: string }) {
  const cls = className ?? "size-3.5";
  if (status === "passed") return <Check className={`${cls} text-support-green`} />;
  if (status === "failed") return <X className={`${cls} text-support-red`} />;
  return <CircleSlash className={`${cls} text-tertiary`} />;
}

function statusLabel(status: ReplayStepStatus): string {
  if (status === "passed") return "Passed";
  if (status === "failed") return "Failed";
  if (status === "skipped") return "Skipped";
  return "Not reported";
}

// ── Visual-diff → badge ─────────────────────────────────────────────────
function diffBadgeColor(state: VisualDiffState): "green" | "orange" | "yellow" | "secondary" {
  switch (state) {
    case "match":
      return "green";
    case "changed":
      return "orange";
    case "unable":
      return "yellow";
    default:
      return "secondary";
  }
}

function DiffBadge({ diff }: { diff: VisualDiff }) {
  let label: string;
  switch (diff.state) {
    case "new-baseline":
      label = "Baseline set";
      break;
    case "match":
      label = "Visual match";
      break;
    case "changed":
      label = `Changed ${fmtPct(diff.ratio ?? 0)}`;
      break;
    default:
      label = "Can’t compare";
  }
  return (
    <Badge color={diffBadgeColor(diff.state)} className="shrink-0" title={diff.reason}>
      {label}
    </Badge>
  );
}

// ── Screenshot pane (current / baseline / diff-overlay) ─────────────────
type ShotMode = "current" | "baseline" | "diff";

function StepScreenshot({
  testId,
  runId,
  step,
  mode,
}: {
  testId: string;
  runId: string;
  step: ReplayStep;
  mode: ShotMode;
}) {
  // Resolve the image source for the active view mode.
  const file =
    mode === "diff" ? (step.diff?.diffFile ?? null) : mode === "current" ? step.screenshot : null;

  const runShotQuery = useQuery({
    queryKey: ["shot", testId, runId, file],
    queryFn: () => api.artifacts.readShot(testId, runId, file as string),
    enabled: mode !== "baseline" && Boolean(file),
    staleTime: 5 * 60 * 1000,
  });
  const baselineQuery = useQuery({
    queryKey: ["baselineShot", testId, step.stepId],
    queryFn: () => api.visual.baselineShot(testId, step.stepId),
    enabled: mode === "baseline",
    staleTime: 5 * 60 * 1000,
  });

  const query = mode === "baseline" ? baselineQuery : runShotQuery;

  if (mode === "current" && !file) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <ImageOff className="size-8 text-tertiary" />
        <Text color="secondary">No screenshot for this step</Text>
        <Text variant="small" color="tertiary" className="max-w-sm">
          {step.status === "skipped" || step.status === "unknown"
            ? "This step didn’t run, so nothing was captured."
            : "Assertions and waits aren’t captured, and a capture can be skipped if it failed."}
        </Text>
      </div>
    );
  }

  if (query.isLoading) {
    return <div className="h-full w-full animate-pulse rounded-md bg-control-subtle" />;
  }

  const src = query.data;
  if (!src) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <ImageOff className="size-8 text-tertiary" />
        <Text color="secondary">
          {mode === "baseline" ? "No baseline for this step" : "Image not available"}
        </Text>
        <Text variant="small" color="tertiary">
          {mode === "baseline"
            ? "This step has no pinned baseline yet."
            : "The artifact may have been pruned by retention."}
        </Text>
      </div>
    );
  }

  const alt =
    mode === "baseline"
      ? `Baseline for step ${step.index + 1}`
      : mode === "diff"
        ? `Visual diff for step ${step.index + 1}`
        : `Screenshot for step ${step.index + 1}`;
  return (
    <img
      src={src}
      alt={alt}
      className="max-h-full max-w-full rounded-md object-contain shadow-sm ring-1 ring-inset ring-token-border"
    />
  );
}

// ── Per-test threshold control ──────────────────────────────────────────
function ThresholdControl({ testId }: { testId: string }) {
  const qc = useQueryClient();
  const thresholdQuery = useQuery({
    queryKey: ["visualThreshold", testId],
    queryFn: () => api.visual.getThreshold(testId),
  });
  const setThreshold = useMutation({
    mutationFn: (v: number) => api.visual.setThreshold(testId, v),
    onSuccess: (v) => qc.setQueryData(["visualThreshold", testId], v),
  });

  return (
    <div
      className="flex items-center gap-1.5"
      title="Percent of pixels allowed to change before a step is flagged. Applies to future runs."
    >
      <Text variant="small" color="tertiary" className="shrink-0">
        Threshold
      </Text>
      <NumberInput
        value={thresholdQuery.data ?? null}
        onValueChange={(v) => {
          if (v !== null) setThreshold.mutate(v);
        }}
        unit="%"
        min={0}
        max={100}
        step={0.1}
        size="small"
        className="w-24"
        disabled={thresholdQuery.isLoading}
      />
    </div>
  );
}

// ── Right pane: the scrubber/timeline for one run ───────────────────────
function ReplayViewer({ summary }: { summary: RunReplaySummary }) {
  const qc = useQueryClient();
  const replayQuery = useQuery<RunReplay | null>({
    queryKey: ["replay", summary.testId, summary.runId],
    queryFn: () => api.artifacts.getReplay(summary.testId, summary.runId),
  });
  const replay = replayQuery.data;

  const [current, setCurrent] = React.useState(0);
  const [mode, setMode] = React.useState<ShotMode>("current");
  // When a run first loads, jump straight to the failure — the main debugging
  // value — or to the first step for a passing run. Guard on runId so later
  // replay mutations (e.g. accepting a baseline) don't yank the user away from
  // the step they're on.
  const jumpedRunId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!replay || jumpedRunId.current === replay.runId) return;
    jumpedRunId.current = replay.runId;
    setCurrent(replay.failedIndex ?? 0);
  }, [replay]);

  const steps = replay?.steps ?? [];
  const clamp = React.useCallback(
    (i: number) => Math.max(0, Math.min(steps.length - 1, i)),
    [steps.length],
  );

  const patchReplay = React.useCallback(
    (next: RunReplay | null) => {
      if (!next) return;
      qc.setQueryData(["replay", summary.testId, summary.runId], next);
      // The baseline changed, so cached baseline images are stale.
      qc.invalidateQueries({ queryKey: ["baselineShot", summary.testId] });
      qc.invalidateQueries({ queryKey: ["replays"] });
    },
    [qc, summary.testId, summary.runId],
  );

  const acceptRun = useMutation({
    mutationFn: () => api.visual.acceptRun(summary.testId, summary.runId),
    onSuccess: patchReplay,
  });
  const acceptStep = useMutation({
    mutationFn: (stepId: string) => api.visual.acceptStep(summary.testId, summary.runId, stepId),
    onSuccess: patchReplay,
  });

  if (replayQuery.isLoading) {
    return (
      <div className="min-w-0 flex-1 p-4">
        <div className="h-full animate-pulse rounded-lg bg-control-subtle" />
      </div>
    );
  }
  if (!replay || steps.length === 0) {
    return (
      <div className="relative min-w-0 flex-1">
        <EmptyState
          title="Replay unavailable"
          description="This run’s artifacts couldn’t be loaded. They may have been removed."
        />
      </div>
    );
  }

  const idx = clamp(current);
  const step = steps[idx];
  const changedCount = steps.filter((s) => s.diff?.state === "changed").length;
  const canDiff = Boolean(step.diff?.diffFile);
  const hasBaselineView =
    step.diff !== undefined && step.diff.state !== "unable" && Boolean(step.screenshot);

  // Reset the view mode when moving to a step that can't show the active mode.
  const effectiveMode: ShotMode =
    (mode === "diff" && !canDiff) || (mode === "baseline" && !hasBaselineView) ? "current" : mode;

  return (
    <div
      className="flex h-full min-w-0 flex-1 flex-col outline-none"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setCurrent((c) => clamp(c - 1));
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          setCurrent((c) => clamp(c + 1));
        }
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-separator px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Text className="truncate font-medium">{replay.testName}</Text>
            <Badge color={replay.status === "passed" ? "green" : "red"} className="shrink-0">
              {replay.status}
            </Badge>
            {changedCount > 0 ? (
              <Badge color="orange" className="shrink-0">
                {changedCount} visual {changedCount === 1 ? "change" : "changes"}
              </Badge>
            ) : null}
          </div>
          <Text variant="small" color="tertiary">
            {fmtDateTime(replay.startedAt)}
          </Text>
        </div>
        <ThresholdControl testId={summary.testId} />
        <div className="flex shrink-0 items-center gap-1">
          <Button
            iconOnly
            variant="glass"
            size="small"
            aria-label="Previous step"
            disabled={idx <= 0}
            onClick={() => setCurrent((c) => clamp(c - 1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Text variant="small-mono" color="secondary" className="w-16 text-center tabular-nums">
            {idx + 1} / {steps.length}
          </Text>
          <Button
            iconOnly
            variant="glass"
            size="small"
            aria-label="Next step"
            disabled={idx >= steps.length - 1}
            onClick={() => setCurrent((c) => clamp(c + 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {/* Failure banner */}
      {replay.failedIndex !== null ? (
        <div className="px-4 pt-3">
          <Callout
            color="red"
            icon={<TriangleAlert className="size-4" />}
            actions={
              idx !== replay.failedIndex ? (
                <Button
                  size="small"
                  variant="glass"
                  onClick={() => setCurrent(replay.failedIndex as number)}
                >
                  Jump to failure
                </Button>
              ) : undefined
            }
          >
            Run failed at step {replay.failedIndex + 1}:{" "}
            <span className="font-mono">{steps[replay.failedIndex]?.label}</span>
          </Callout>
        </div>
      ) : null}

      {/* Visual-change banner */}
      {changedCount > 0 ? (
        <div className="px-4 pt-3">
          <Callout
            color="orange"
            icon={<Eye className="size-4" />}
            actions={
              <Button
                size="small"
                variant="glass"
                disabled={acceptRun.isPending}
                onClick={() => acceptRun.mutate()}
              >
                <Stamp className="size-3.5" />
                Accept run as baseline
              </Button>
            }
          >
            Visual change detected in {changedCount} {changedCount === 1 ? "step" : "steps"} (over{" "}
            {fmtPct((replay.visualThreshold ?? 0) / 100)} threshold). Accept the run to pin these as
            the new baselines.
          </Callout>
        </div>
      ) : null}

      {/* Screenshot */}
      <div className="min-h-0 flex-1 p-4">
        <div className="relative flex h-full items-center justify-center rounded-lg border border-token-border bg-token-surface p-3">
          {/* View-mode toggle — only when there's a baseline to compare against */}
          {hasBaselineView ? (
            <div className="absolute right-3 top-3 z-10">
              <SegmentedControl
                type="single"
                size="small"
                variant="glass"
                value={effectiveMode}
                onValueChange={(v) => v && setMode(v as ShotMode)}
              >
                <SegmentedControlItem value="current">Current</SegmentedControlItem>
                <SegmentedControlItem value="baseline">Baseline</SegmentedControlItem>
                {canDiff ? (
                  <SegmentedControlItem value="diff">
                    <Diff className="size-3.5" />
                    Diff
                  </SegmentedControlItem>
                ) : null}
              </SegmentedControl>
            </div>
          ) : null}
          <StepScreenshot
            testId={summary.testId}
            runId={summary.runId}
            step={step}
            mode={effectiveMode}
          />
        </div>
      </div>

      {/* Current step detail */}
      <div className="flex items-center gap-2 border-t border-separator px-4 py-2">
        <StatusIcon status={step.status} />
        <Badge color="secondary" className="shrink-0">
          {step.type}
        </Badge>
        <Text variant="small-mono" className="min-w-0 flex-1 truncate" title={step.label}>
          {step.label}
        </Text>
        {step.diff ? <DiffBadge diff={step.diff} /> : null}
        {step.diff?.state === "changed" ? (
          <Button
            size="small"
            variant="glass"
            className="shrink-0"
            disabled={acceptStep.isPending}
            onClick={() => acceptStep.mutate(step.stepId)}
          >
            <Stamp className="size-3.5" />
            Accept as baseline
          </Button>
        ) : (
          <Text variant="small" color="tertiary" className="shrink-0">
            {statusLabel(step.status)}
          </Text>
        )}
      </div>

      {/* Timeline scrubber */}
      <div className="border-t border-separator px-4 py-3">
        <ScrollArea className="w-full">
          <div className="flex items-end gap-1 pb-1">
            {steps.map((s) => {
              const active = s.index === idx;
              const failed = s.index === replay.failedIndex;
              const changed = s.diff?.state === "changed";
              return (
                <button
                  key={s.index}
                  type="button"
                  onClick={() => setCurrent(s.index)}
                  aria-label={`Step ${s.index + 1}: ${statusLabel(s.status)}${
                    changed ? ", visual change" : ""
                  }`}
                  aria-current={active ? "true" : undefined}
                  title={`${s.index + 1}. ${s.label}${changed ? " · visual change" : ""}`}
                  className={`group flex min-w-[22px] shrink-0 flex-col items-center gap-1 rounded-md px-1 pb-1 pt-0.5 ${
                    active ? "bg-accent-10 ring-1 ring-inset ring-accent" : "hover:bg-control-subtle"
                  }`}
                >
                  <span className="flex h-4 items-center justify-center">
                    {failed ? (
                      <TriangleAlert className="size-3.5 text-support-red" />
                    ) : changed ? (
                      <Eye className="size-3.5 text-support-orange" />
                    ) : null}
                  </span>
                  <span
                    className={`w-full rounded-sm ${statusBar(s.status)} ${
                      failed || changed ? "h-7" : "h-5"
                    } ${changed && !failed ? "ring-1 ring-inset ring-support-orange" : ""}`}
                  />
                  <Text
                    variant="small-mono"
                    color={active ? "primary" : "tertiary"}
                    className="text-[10px] tabular-nums"
                  >
                    {s.index + 1}
                  </Text>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

// ── Left pane: the list of runs that have artifacts ─────────────────────
function RunList({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: RunReplaySummary[];
  selectedRunId: string | null;
  onSelect: (r: RunReplaySummary) => void;
}) {
  return (
    <ScrollArea className="h-full w-64 shrink-0 border-r border-separator">
      <div className="flex flex-col gap-0.5 p-2">
        {runs.map((r) => {
          const selected = r.runId === selectedRunId;
          return (
            <button
              key={r.runId}
              type="button"
              onClick={() => onSelect(r)}
              className={`flex flex-col gap-1 rounded-md px-2.5 py-2 text-left ${
                selected ? "bg-accent-10 ring-1 ring-inset ring-accent" : "hover:bg-control-subtle"
              }`}
              aria-current={selected ? "true" : undefined}
            >
              <div className="flex items-center gap-2">
                <Badge color={r.status === "passed" ? "green" : "red"} className="shrink-0">
                  {r.status}
                </Badge>
                <Text variant="small" className="min-w-0 flex-1 truncate font-medium">
                  {r.testName}
                </Text>
                {r.changedSteps > 0 ? (
                  <Eye className="size-3.5 shrink-0 text-support-orange" aria-label="visual change" />
                ) : null}
              </div>
              <Text variant="small" color="tertiary">
                {fmtDateTime(r.startedAt)} · {r.stepCount} steps
              </Text>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// ── The Visual tab: replay hub over Phase 1 artifacts ───────────────────
export function VisualView() {
  const qc = useQueryClient();
  const runsQuery = useQuery({ queryKey: ["replays"], queryFn: api.artifacts.list });
  const runs = React.useMemo(() => runsQuery.data ?? [], [runsQuery.data]);
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);

  // Live-refresh when a run completes.
  React.useEffect(() => {
    return api.on("runs:changed", () => {
      qc.invalidateQueries({ queryKey: ["replays"] });
    });
  }, [qc]);

  // Default to the newest run once the list loads (or when the selection
  // disappears, e.g. after retention pruning).
  const selected =
    runs.find((r) => r.runId === selectedRunId) ?? (runs.length > 0 ? runs[0] : null);

  return (
    <div className="relative flex h-full flex-col">
      <Toolbar>
        <ToolbarContent>
          <ToolbarTitle>Visual</ToolbarTitle>
        </ToolbarContent>
      </Toolbar>

      {runs.length === 0 ? (
        <EmptyState
          title="No captured runs yet"
          description="Turn on “Capture screenshots” when you run a test, then come back here to replay it step by step, compare against a baseline, and see where it failed."
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <RunList
            runs={runs}
            selectedRunId={selected?.runId ?? null}
            onSelect={(r) => setSelectedRunId(r.runId)}
          />
          {selected ? (
            <ReplayViewer key={selected.runId} summary={selected} />
          ) : (
            <div className="flex-1" />
          )}
        </div>
      )}
    </div>
  );
}
