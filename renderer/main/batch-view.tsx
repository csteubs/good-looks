// Batch (suite) runs — pick a set of tests, run them back to back, watch the
// aggregate result.
//
// The batch drives ordinary runs sequentially on the backend, so each test also
// writes its usual RunRecord and shows up in Stats. This view is the driver +
// live progress, not a second history.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  Toolbar,
  ToolbarActions,
  ToolbarContent,
  ToolbarDescription,
  ToolbarTitle,
  toast,
} from "@glaze/core/components";
import { Check, CircleDashed, Play, Square, X, SkipForward, Loader } from "lucide-react";

import { api } from "../lib/api";
import { RUN_BROWSERS, RUN_BROWSER_LABELS } from "../lib/recorder-types";
import { ALL_TAGS, UNTAGGED, filterByTag, tagCounts, untaggedCount } from "../lib/test-tags";
import type {
  BatchRecord,
  BatchState,
  BatchTestResult,
  BatchTestStatus,
  RunBrowser,
} from "../lib/recorder-types";

function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function StatusBadge({ status, note }: { status: BatchTestStatus; note?: string }) {
  switch (status) {
    case "passed":
      return (
        <Badge color="green">
          <Check className="size-3" />
          Passed
        </Badge>
      );
    case "failed":
      return (
        <Badge color="red">
          <X className="size-3" />
          Failed
        </Badge>
      );
    case "running":
      return (
        <Badge color="secondary">
          <Loader className="size-3 animate-spin" />
          Running
        </Badge>
      );
    case "skipped":
      return (
        <Badge color="secondary" title={note}>
          <SkipForward className="size-3" />
          Skipped
        </Badge>
      );
    default:
      return (
        <Badge color="secondary">
          <CircleDashed className="size-3" />
          Queued
        </Badge>
      );
  }
}

/** One filter chip in the tag row. Shows its test count so an empty group is
 *  obvious before you click it. */
function TagChip({
  label,
  count,
  active,
  disabled,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-0.5 text-small transition-colors disabled:opacity-50 ${
        active
          ? "border-accent bg-accent/15 text-primary"
          : "border-token-border text-secondary hover:bg-token-hover"
      }`}
    >
      {label} · {count}
    </button>
  );
}

export function BatchView() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: tests = [] } = useQuery({ queryKey: ["tests"], queryFn: api.tests.list });
  const settingsQuery = useQuery({
    queryKey: ["recorder-settings"],
    queryFn: () => api.recorder.getSettings(),
  });

  // Selection. Defaults to every test once the library loads; a test added
  // later is not auto-selected, so an in-progress choice isn't disturbed.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [seeded, setSeeded] = React.useState(false);
  React.useEffect(() => {
    if (seeded || tests.length === 0) return;
    setSelected(new Set(tests.map((t) => t.id)));
    setSeeded(true);
  }, [seeded, tests]);

  // Batch-level run options. Deliberately NOT persisted to each test: a suite
  // run is a one-off choice ("run everything headless on WebKit"), and writing
  // it back would silently rewrite every test's saved preference.
  const [runHeadless, setRunHeadless] = React.useState(false);
  const [captureArtifacts, setCaptureArtifacts] = React.useState(false);
  const [browser, setBrowser] = React.useState<RunBrowser>("chromium");
  const [optionsInited, setOptionsInited] = React.useState(false);
  React.useEffect(() => {
    if (optionsInited || !settingsQuery.data) return;
    setRunHeadless(settingsQuery.data.defaultRunHeadless ?? false);
    setCaptureArtifacts(settingsQuery.data.defaultCaptureArtifacts ?? false);
    setBrowser(settingsQuery.data.defaultRunBrowser ?? "chromium");
    setOptionsInited(true);
  }, [optionsInited, settingsQuery.data]);

  // Tag filter over the checklist. Selection is stored by test id, so
  // switching filters never silently drops tests you already ticked.
  const [tagFilter, setTagFilter] = React.useState<string>(ALL_TAGS);
  const tags = React.useMemo(() => tagCounts(tests), [tests]);
  const untagged = React.useMemo(() => untaggedCount(tests), [tests]);
  const visibleTests = React.useMemo(
    () => filterByTag(tests, tagFilter),
    [tests, tagFilter],
  );

  const [batch, setBatch] = React.useState<BatchState | null>(null);
  // Persisted batch history — survives restarts, unlike the live state above.
  const historyQuery = useQuery({ queryKey: ["batch-history"], queryFn: api.batch.list });

  // Pick up a batch already running when this view mounts (the run continues on
  // the backend while the user is off in another view).
  React.useEffect(() => {
    api.batch
      .status()
      .then((s) => setBatch(s))
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    const offProgress = api.on("batch:progress", (payload) => {
      setBatch(payload as BatchState);
    });
    const offDone = api.on("batch:done", (payload) => {
      const state = payload as BatchState;
      setBatch(state);
      // Each test wrote its own RunRecord, so Stats/history are now stale.
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["captureOverhead"] });
      qc.invalidateQueries({ queryKey: ["batch-history"] });
      if (state.stopped) {
        toast.info("Batch stopped.");
      } else if (state.summary.failed > 0) {
        toast.error(
          `${state.summary.failed} of ${state.summary.total} failed.`,
        );
      } else {
        toast.success(`All ${state.summary.passed} passed.`);
      }
    });
    return () => {
      offProgress();
      offDone();
    };
  }, [qc]);

  // A filter pinned to a tag nobody uses anymore would show an empty list with
  // no obvious way back — fall back to "All".
  React.useEffect(() => {
    if (tagFilter === ALL_TAGS || tagFilter === UNTAGGED) return;
    if (!tags.some((t) => t.tag.toLowerCase() === tagFilter.toLowerCase())) {
      setTagFilter(ALL_TAGS);
    }
  }, [tags, tagFilter]);

  const history = React.useMemo(() => historyQuery.data ?? [], [historyQuery.data]);
  // Nothing live → show the most recent persisted batch, so a restart doesn't
  // present a blank view as though the batch never happened.
  const shown: BatchState | null = batch ?? history[0] ?? null;
  const running = batch?.running ?? false;
  const selectedIds = tests.filter((t) => selected.has(t.id)).map((t) => t.id);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startBatch = async () => {
    if (selectedIds.length === 0) return;
    try {
      const res = await api.batch.run(selectedIds, {
        captureArtifacts,
        runHeadless,
        browser,
      });
      if (res.alreadyRunning) toast.info("A batch is already running.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start the batch.");
    }
  };

  // Live results are keyed by testId so each row can show its own outcome
  // while the batch is mid-flight.
  const resultFor = React.useMemo(() => {
    const map = new Map<string, BatchTestResult>();
    for (const r of shown?.results ?? []) map.set(r.testId, r);
    return map;
  }, [shown]);

  const summary = shown?.summary;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <ToolbarContent>
          <ToolbarTitle>Batch run</ToolbarTitle>
          <ToolbarDescription>
            {running
              ? `Running ${(batch?.currentIndex ?? 0) + 1} of ${batch?.results.length ?? 0}…`
              : summary && shown
                ? `${summary.passed} passed · ${summary.failed} failed${
                    summary.skipped > 0 ? ` · ${summary.skipped} skipped` : ""
                  } · ${fmtDuration(summary.durationMs)}`
                : `${selectedIds.length} of ${tests.length} selected${
                    tagFilter !== ALL_TAGS ? ` · showing ${visibleTests.length}` : ""
                  }`}
          </ToolbarDescription>
        </ToolbarContent>
        <ToolbarActions>
          <Select
            value={browser}
            onValueChange={(v) => setBrowser(v as RunBrowser)}
            disabled={running}
          >
            <SelectTrigger
              variant="filled"
              size="small"
              className="w-32"
              aria-label="Browser engine for this batch"
            >
              <SelectValue placeholder="Chromium" />
            </SelectTrigger>
            <SelectContent>
              {RUN_BROWSERS.map((b) => (
                <SelectItem key={b} value={b}>
                  {RUN_BROWSER_LABELS[b]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex cursor-pointer select-none items-center gap-1.5 pr-1 text-small text-secondary">
            <Checkbox
              checked={runHeadless}
              onCheckedChange={(v) => setRunHeadless(v === true)}
              disabled={running}
              aria-label="Run this batch headless"
            />
            Headless
          </label>
          <label className="flex cursor-pointer select-none items-center gap-1.5 pr-1 text-small text-secondary">
            <Checkbox
              checked={runHeadless ? false : captureArtifacts}
              onCheckedChange={(v) => {
                if (runHeadless) return;
                setCaptureArtifacts(v === true);
              }}
              disabled={running || runHeadless}
              aria-label="Capture screenshots during this batch"
            />
            Capture screenshots
          </label>
          {running ? (
            <Button variant="destructive" onClick={() => void api.batch.stop()}>
              <Square className="size-4" />
              Stop
            </Button>
          ) : (
            <Button
              variant="accent"
              onClick={() => void startBatch()}
              disabled={selectedIds.length === 0}
            >
              <Play className="size-4" />
              Run {selectedIds.length === tests.length ? "all" : selectedIds.length}
            </Button>
          )}
        </ToolbarActions>
      </Toolbar>

      <ScrollArea className="h-full">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-5">
          {tests.length === 0 ? (
            <EmptyState
              className="py-16"
              title="No tests to run"
              description="Record or import a test first — batch runs execute the tests in your library one after another."
            />
          ) : (
            <>
              {tags.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <TagChip
                    label="All"
                    count={tests.length}
                    active={tagFilter === ALL_TAGS}
                    disabled={running}
                    onClick={() => setTagFilter(ALL_TAGS)}
                  />
                  {tags.map((t) => (
                    <TagChip
                      key={t.tag.toLowerCase()}
                      label={t.tag}
                      count={t.count}
                      active={tagFilter.toLowerCase() === t.tag.toLowerCase()}
                      disabled={running}
                      onClick={() => setTagFilter(t.tag)}
                    />
                  ))}
                  {untagged > 0 ? (
                    <TagChip
                      label="Untagged"
                      count={untagged}
                      active={tagFilter === UNTAGGED}
                      disabled={running}
                      onClick={() => setTagFilter(UNTAGGED)}
                    />
                  ) : null}
                </div>
              ) : null}

              <div className="flex items-center gap-3">
                <Button
                  variant="glass"
                  size="small"
                  disabled={running}
                  onClick={() =>
                    // Adds the visible tests to the selection rather than
                    // replacing it, so "select all" under a filter doesn't
                    // silently deselect everything hidden.
                    setSelected((prev) => {
                      const next = new Set(prev);
                      for (const t of visibleTests) next.add(t.id);
                      return next;
                    })
                  }
                >
                  {tagFilter === ALL_TAGS ? "Select all" : "Select these"}
                </Button>
                <Button
                  variant="glass"
                  size="small"
                  disabled={running}
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      for (const t of visibleTests) next.delete(t.id);
                      return next;
                    })
                  }
                >
                  {tagFilter === ALL_TAGS ? "Select none" : "Deselect these"}
                </Button>
                <Text variant="small" color="tertiary">
                  Tests run one at a time, in this order.
                </Text>
              </div>

              <div className="rounded-lg border border-token-border bg-token-surface-raised">
                {visibleTests.map((t) => {
                  const result = resultFor.get(t.id);
                  const isCurrent = result?.status === "running";
                  return (
                    <div
                      key={t.id}
                      className={`flex items-center gap-3 border-b border-token-border px-3 py-2 last:border-b-0 ${
                        isCurrent ? "bg-accent/10" : ""
                      }`}
                    >
                      <Checkbox
                        checked={selected.has(t.id)}
                        onCheckedChange={() => toggle(t.id)}
                        disabled={running}
                        aria-label={`Include ${t.name} in the batch`}
                      />
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-small font-medium hover:underline"
                        title={t.name}
                        onClick={() => navigate({ to: "/test/$id", params: { id: t.id } })}
                      >
                        {t.name}
                      </button>
                      {(t.tags ?? []).length > 0 ? (
                        <span className="flex shrink-0 items-center gap-1">
                          {(t.tags ?? []).slice(0, 2).map((tag) => (
                            <Badge key={tag.toLowerCase()} color="secondary">
                              {tag}
                            </Badge>
                          ))}
                          {(t.tags ?? []).length > 2 ? (
                            <Text variant="small" color="tertiary">
                              +{(t.tags ?? []).length - 2}
                            </Text>
                          ) : null}
                        </span>
                      ) : null}
                      {result?.durationMs !== undefined ? (
                        <Text variant="small" color="tertiary">
                          {fmtDuration(result.durationMs)}
                        </Text>
                      ) : null}
                      {result ? <StatusBadge status={result.status} note={result.note} /> : null}
                    </div>
                  );
                })}
              </div>

              {shown && !running && summary ? (
                <div className="rounded-lg border border-token-border bg-token-surface-raised p-4">
                  <Text variant="small" className="mb-1 block font-medium">
                    {shown.stopped
                      ? "Batch stopped"
                      : summary.failed > 0
                        ? "Batch finished with failures"
                        : "Batch passed"}
                  </Text>
                  <Text variant="small" color="secondary">
                    {fmtDateTime(shown.startedAt)} · {summary.passed} passed · {summary.failed}{" "}
                    failed · {summary.skipped} skipped · {fmtDuration(summary.durationMs)} total.
                    Each test also appears in Stats as its own run.
                  </Text>
                </div>
              ) : null}

              {history.length > 0 ? (
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <Text variant="small" className="font-medium">
                      Previous batches
                    </Text>
                    <Text variant="small" color="tertiary">
                      {history.length}
                    </Text>
                    <Button
                      variant="glass"
                      size="small"
                      className="ml-auto"
                      disabled={running}
                      onClick={async () => {
                        try {
                          const res = await api.batch.clearHistory();
                          setBatch(null);
                          qc.invalidateQueries({ queryKey: ["batch-history"] });
                          toast.success(
                            res.removed === 1
                              ? "Cleared 1 batch."
                              : `Cleared ${res.removed} batches.`,
                          );
                        } catch (err) {
                          toast.error(
                            err instanceof Error ? err.message : "Failed to clear batch history.",
                          );
                        }
                      }}
                    >
                      Clear history
                    </Button>
                  </div>
                  <div className="rounded-lg border border-token-border bg-token-surface-raised">
                    {history.map((b: BatchRecord) => (
                      <button
                        key={b.batchId}
                        type="button"
                        disabled={running}
                        onClick={() => setBatch(b)}
                        className={`flex w-full items-center gap-3 border-b border-token-border px-3 py-2 text-left last:border-b-0 hover:bg-token-hover disabled:opacity-50 ${
                          b.batchId === shown?.batchId ? "bg-token-hover" : ""
                        }`}
                      >
                        <Text variant="small" color="secondary" className="w-32 shrink-0">
                          {fmtDateTime(b.startedAt)}
                        </Text>
                        <Text variant="small" className="min-w-0 flex-1 truncate">
                          {b.summary.total} {b.summary.total === 1 ? "test" : "tests"} ·{" "}
                          {fmtDuration(b.summary.durationMs)}
                        </Text>
                        {b.stopped ? (
                          <Badge color="secondary">Stopped</Badge>
                        ) : b.summary.failed > 0 ? (
                          <Badge color="red">{b.summary.failed} failed</Badge>
                        ) : (
                          <Badge color="green">{b.summary.passed} passed</Badge>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
