import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  ScrollArea,
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
  ImageOff,
  TriangleAlert,
  X,
} from "lucide-react";

import { api } from "../lib/api";
import type {
  ReplayStep,
  ReplayStepStatus,
  RunReplay,
  RunReplaySummary,
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

// ── Screenshot pane for the currently-selected step ─────────────────────
function StepScreenshot({
  testId,
  runId,
  step,
}: {
  testId: string;
  runId: string;
  step: ReplayStep;
}) {
  const file = step.screenshot;
  const shotQuery = useQuery({
    queryKey: ["shot", testId, runId, file],
    queryFn: () => api.artifacts.readShot(testId, runId, file as string),
    enabled: Boolean(file),
    staleTime: 5 * 60 * 1000,
  });

  if (!file) {
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

  if (shotQuery.isLoading) {
    return <div className="h-full w-full animate-pulse rounded-md bg-control-subtle" />;
  }

  const src = shotQuery.data;
  if (!src) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <ImageOff className="size-8 text-tertiary" />
        <Text color="secondary">Screenshot not available</Text>
        <Text variant="small" color="tertiary">
          The artifact may have been pruned by retention.
        </Text>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={`Screenshot for step ${step.index + 1}`}
      className="max-h-full max-w-full rounded-md object-contain shadow-sm ring-1 ring-inset ring-token-border"
    />
  );
}

// ── Right pane: the scrubber/timeline for one run ───────────────────────
function ReplayViewer({ summary }: { summary: RunReplaySummary }) {
  const replayQuery = useQuery<RunReplay | null>({
    queryKey: ["replay", summary.testId, summary.runId],
    queryFn: () => api.artifacts.getReplay(summary.testId, summary.runId),
  });
  const replay = replayQuery.data;

  const [current, setCurrent] = React.useState(0);
  // When a run loads (or changes), jump straight to the failure — the main
  // debugging value — or to the first step for a passing run.
  React.useEffect(() => {
    if (!replay) return;
    setCurrent(replay.failedIndex ?? 0);
  }, [replay]);

  const steps = replay?.steps ?? [];
  const clamp = React.useCallback(
    (i: number) => Math.max(0, Math.min(steps.length - 1, i)),
    [steps.length],
  );

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

  const step = steps[clamp(current)];
  const idx = clamp(current);

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
          </div>
          <Text variant="small" color="tertiary">
            {fmtDateTime(replay.startedAt)}
          </Text>
        </div>
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

      {/* Screenshot */}
      <div className="min-h-0 flex-1 p-4">
        <div className="flex h-full items-center justify-center rounded-lg border border-token-border bg-token-surface p-3">
          <StepScreenshot testId={summary.testId} runId={summary.runId} step={step} />
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
        <Text variant="small" color="tertiary" className="shrink-0">
          {statusLabel(step.status)}
        </Text>
      </div>

      {/* Timeline scrubber */}
      <div className="border-t border-separator px-4 py-3">
        <ScrollArea className="w-full">
          <div className="flex items-end gap-1 pb-1">
            {steps.map((s) => {
              const active = s.index === idx;
              const failed = s.index === replay.failedIndex;
              return (
                <button
                  key={s.index}
                  type="button"
                  onClick={() => setCurrent(s.index)}
                  aria-label={`Step ${s.index + 1}: ${statusLabel(s.status)}`}
                  aria-current={active ? "true" : undefined}
                  title={`${s.index + 1}. ${s.label}`}
                  className={`group flex min-w-[22px] shrink-0 flex-col items-center gap-1 rounded-md px-1 pb-1 pt-0.5 ${
                    active ? "bg-accent-10 ring-1 ring-inset ring-accent" : "hover:bg-control-subtle"
                  }`}
                >
                  <span className="flex h-4 items-center justify-center">
                    {failed ? <TriangleAlert className="size-3.5 text-support-red" /> : null}
                  </span>
                  <span
                    className={`w-full rounded-sm ${statusBar(s.status)} ${
                      failed ? "h-7" : "h-5"
                    }`}
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
          description="Turn on “Capture screenshots” when you run a test, then come back here to replay it step by step and see where it failed."
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
