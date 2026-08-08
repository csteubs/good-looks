// Batch (suite) runs — pick a set of tests, run them, watch the aggregate
// result.
//
// The batch drives ordinary runs on the backend — one at a time by default, or
// several at once via the "At once" picker — so each test also writes its usual
// RunRecord and shows up in Stats. This view is the driver + live progress, not
// a second history.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
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
import {
  Check,
  CircleDashed,
  Eye,
  EyeOff,
  GripVertical,
  Play,
  Square,
  X,
  SkipForward,
  Loader,
} from "lucide-react";

import { api } from "../lib/api";
import { BrowserIcon } from "../lib/browser-icons";
import { RUN_BROWSERS, RUN_BROWSER_LABELS } from "../lib/recorder-types";
import { ALL_TAGS, UNTAGGED, filterByTag, tagCounts } from "../lib/test-tags";
import { LogInspector } from "./log-inspector";
import { TagCluster } from "./tag-cluster";
import {
  applyOrder,
  isCustomOrder,
  moveToTarget,
  orderIdsOf,
  orderIsStale,
} from "../lib/batch-order";
import {
  BATCH_CONCURRENCY_CHOICES,
  batchConcurrencyLabel,
  choiceFromSetting,
  needsHeadedParallelWarning,
  resolveConcurrency,
  type BatchConcurrencyChoice,
} from "../lib/batch-parallel";
import {
  applyHeadlessToAll,
  buildRunPlan,
  pruneRowOptions,
  resolveRow,
  resultKeyOf,
  rowOptionsAreStale,
  rowStatus,
  setRow,
  setSelection,
  toggleRowBrowser,
  type RowOptionsMap,
} from "../lib/batch-run-plan";
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

export function BatchView() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: tests = [] } = useQuery({ queryKey: ["tests"], queryFn: api.tests.list });
  const settingsQuery = useQuery({
    queryKey: ["recorder-settings"],
    queryFn: () => api.recorder.getSettings(),
  });

  // Selection, engines and headedness — one persisted map keyed by test id, so
  // all three survive a restart. A test with NO entry resolves from its own
  // record and the global defaults (see batch-run-plan), which is why this
  // needed no migration and why a newly recorded test arrives UNTICKED.
  //
  // Unticked is the deliberate reversal of the old behaviour: a fresh test used
  // to be added to the selection automatically and joined the next "Run all"
  // without being asked.
  const [rowOptions, setRowOptions] = React.useState<RowOptionsMap>({});
  const [rowsInited, setRowsInited] = React.useState(false);
  // A finished row's badge opens that run's console output — the row that made
  // you curious shouldn't need a detour through Stats to answer "why".
  const [logRun, setLogRun] = React.useState<{ id: string; title: string } | null>(null);
  React.useEffect(() => {
    if (rowsInited || !settingsQuery.data) return;
    setRowOptions(settingsQuery.data.batchTestOptions ?? {});
    setRowsInited(true);
  }, [rowsInited, settingsQuery.data]);

  // Batch-level run options. `captureArtifacts` and `concurrency` are one-off
  // choices for this run; `runHeadless` is the MASTER for the per-row toggles
  // (see the Headless checkbox below). The browser picker moved into the rows.
  const [runHeadless, setRunHeadless] = React.useState(false);
  const [captureArtifacts, setCaptureArtifacts] = React.useState(false);
  const [concurrency, setConcurrency] = React.useState<BatchConcurrencyChoice>(1);
  const [optionsInited, setOptionsInited] = React.useState(false);
  React.useEffect(() => {
    if (optionsInited || !settingsQuery.data) return;
    setRunHeadless(settingsQuery.data.defaultRunHeadless ?? false);
    setCaptureArtifacts(settingsQuery.data.defaultCaptureArtifacts ?? false);
    setConcurrency(choiceFromSetting(settingsQuery.data.defaultBatchConcurrency));
    setOptionsInited(true);
  }, [optionsInited, settingsQuery.data]);

  // Set when Run is pressed on a headed batch big enough to be worth asking
  // about; holds the number of windows so the dialog can name it.
  const [pendingHeadedRun, setPendingHeadedRun] = React.useState<number | null>(null);

  // User-defined run order, persisted as ids in settings. Held locally while
  // dragging so rows track the pointer without a round trip per frame.
  const [order, setOrder] = React.useState<string[]>([]);
  const [orderInited, setOrderInited] = React.useState(false);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overId, setOverId] = React.useState<string | null>(null);

    // Tag filter over the checklist. Selection is stored by test id, so
  // switching filters never silently drops tests you already ticked. The chips
  // themselves live in TagCluster, which also owns deleting a tag library-wide.
  const [tagFilter, setTagFilter] = React.useState<string>(ALL_TAGS);
  const tags = React.useMemo(() => tagCounts(tests), [tests]);
  React.useEffect(() => {
    if (orderInited || !settingsQuery.data) return;
    setOrder(settingsQuery.data.batchOrder ?? []);
    setOrderInited(true);
  }, [orderInited, settingsQuery.data]);

  // Every test appears exactly once regardless of what was stored, so a test
  // added or deleted since the order was saved can never go missing.
  const orderedTests = React.useMemo(() => applyOrder(tests, order), [tests, order]);

  // Rewrite the stored order once when the library has drifted (a test added or
  // deleted), rather than on every render.
  React.useEffect(() => {
    if (!orderInited || tests.length === 0) return;
    if (!orderIsStale(order, tests)) return;
    const fresh = orderIdsOf(applyOrder(tests, order));
    setOrder(fresh);
    api.recorder.setSettings({ batchOrder: fresh }).catch(() => {});
  }, [orderInited, tests, order]);

  const visibleTests = React.useMemo(
    () => filterByTag(orderedTests, tagFilter),
    [orderedTests, tagFilter],
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

    // Commit a drag: reorder by ID, not by visible index — under a tag filter the
  // visible rows are only a subsequence of the real order.
  const commitDrag = () => {
    if (dragId && overId && dragId !== overId) {
      const next = moveToTarget(orderIdsOf(orderedTests), dragId, overId);
      setOrder(next);
      api.recorder.setSettings({ batchOrder: next }).catch(() => {
        /* best-effort persist; the new order still applies to this session */
      });
    }
    setDragId(null);
    setOverId(null);
  };

  const history = React.useMemo(() => historyQuery.data ?? [], [historyQuery.data]);
  // Nothing live → show the most recent persisted batch, so a restart doesn't
  // present a blank view as though the batch never happened.
  const shown: BatchState | null = batch ?? history[0] ?? null;
  const running = batch?.running ?? false;

  // The globals a row falls back to when the user has never touched it.
  const rowDefaults = React.useMemo(
    () => ({
      defaultRunBrowser: settingsQuery.data?.defaultRunBrowser,
      defaultRunHeadless: settingsQuery.data?.defaultRunHeadless,
    }),
    [settingsQuery.data],
  );

  // Every write goes through here so state and disk never disagree. Persist is
  // best-effort, matching the stored order: the choice still applies to this
  // session if the write fails.
  const commitRows = React.useCallback((next: RowOptionsMap) => {
    setRowOptions(next);
    api.recorder.setSettings({ batchTestOptions: next }).catch(() => {});
  }, []);

  // Drop rows for tests that no longer exist, once on drift rather than every
  // render — the same shape as the stored-order rewrite above.
  React.useEffect(() => {
    if (!rowsInited || tests.length === 0) return;
    const ids = tests.map((t) => t.id);
    if (!rowOptionsAreStale(rowOptions, ids)) return;
    commitRows(pruneRowOptions(rowOptions, ids));
  }, [rowsInited, tests, rowOptions, commitRows]);

  // What Run will actually do. Derived from the ORDERED list, not the library:
  // a batch runs in the order the checklist shows, and one place computes the
  // payload, the run count and whether the headed warning applies.
  const plan = React.useMemo(
    () => buildRunPlan(orderedTests, rowOptions, rowDefaults),
    [orderedTests, rowOptions, rowDefaults],
  );
  const selectedIds = plan.testIds;

  const toggle = (test: { id: string; runBrowser?: RunBrowser }) => {
    const row = resolveRow(test, rowOptions, rowDefaults);
    commitRows(setRow(rowOptions, test, rowDefaults, { selected: !row.selected }));
  };

  // How many tests will actually be in flight. DISTINCT tests, not planned
  // runs: the runner puts every entry for one test in a single lane and runs
  // them one after another, so a three-engine row still opens one window at a
  // time. Counting runs here would warn about windows that never exist.
  const effectiveConcurrency = resolveConcurrency(concurrency, selectedIds.length);

  const startBatch = async () => {
    if (selectedIds.length === 0) return;
    try {
      const res = await api.batch.run(selectedIds, {
        captureArtifacts,
        // Still sent as the fallback for any test the backend finds no row for.
        runHeadless,
        concurrency: effectiveConcurrency,
        perTest: plan.perTest,
      });
      if (res.alreadyRunning) toast.info("A batch is already running.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start the batch.");
    }
  };

  // Ask before opening more than a screenful of real browser windows. Only a
  // batch where EVERY row is headless skips this — one headed row in fifty
  // still opens a window.
  const requestBatch = () => {
    if (selectedIds.length === 0) return;
    if (
      needsHeadedParallelWarning({
        concurrency: effectiveConcurrency,
        runHeadless: plan.allHeadless,
      })
    ) {
      setPendingHeadedRun(effectiveConcurrency);
      return;
    }
    void startBatch();
  };

  // Results grouped by test, because one test can now produce several — three
  // engines, or a dataset sweep. Keying a flat map by testId would collapse
  // them to whichever arrived last, and the row would report one engine's
  // outcome as if it were all of them.
  const resultsFor = React.useMemo(() => {
    const map = new Map<string, BatchTestResult[]>();
    for (const r of shown?.results ?? []) {
      const list = map.get(r.testId);
      if (list) list.push(r);
      else map.set(r.testId, [r]);
    }
    return map;
  }, [shown]);

  // One result per (test, engine), for tinting a row's browser icons.
  const resultByKey = React.useMemo(() => {
    const map = new Map<string, BatchTestResult>();
    for (const r of shown?.results ?? []) map.set(resultKeyOf(r), r);
    return map;
  }, [shown]);

  const summary = shown?.summary;

  // Counted from the results, not read off currentIndex: with several tests in
  // flight there is no single current one, and "Running 3 of 12" needs to mean
  // "3 finished" rather than "the third one".
  const liveCounts = React.useMemo(() => {
    const results = batch?.results ?? [];
    return {
      inFlight: results.filter((r) => r.status === "running").length,
      settled: results.filter((r) => r.status !== "running" && r.status !== "pending").length,
      total: results.length,
    };
  }, [batch]);

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <ToolbarContent>
          <ToolbarTitle>Batch run</ToolbarTitle>
          <ToolbarDescription>
            {running
              ? liveCounts.inFlight > 1
                ? // Parallel: an ordinal would be a lie, so report progress and
                  // how many are in flight.
                  `${liveCounts.settled} of ${liveCounts.total} done · ${liveCounts.inFlight} running`
                : // Sequential: unchanged wording. `settled + 1` is the same
                  // number the old `currentIndex + 1` produced, since with one
                  // test in flight everything before it has finished.
                  `Running ${Math.min(liveCounts.settled + 1, liveCounts.total)} of ${
                    liveCounts.total
                  }…`
              : summary && shown
                ? `${summary.passed} passed · ${summary.failed} failed${
                    summary.skipped > 0 ? ` · ${summary.skipped} skipped` : ""
                  } · ${fmtDuration(summary.durationMs)}`
                : `${selectedIds.length} of ${tests.length} selected${
                    // Runs and tests differ as soon as one row has two engines,
                    // and the run count is what the batch actually does — a
                    // silent 3× is exactly the surprise worth naming.
                    plan.plannedRuns !== selectedIds.length ? ` · ${plan.plannedRuns} runs` : ""
                  }${tagFilter !== ALL_TAGS ? ` · showing ${visibleTests.length}` : ""}`}
          </ToolbarDescription>
        </ToolbarContent>
        <ToolbarActions>
          {/* The batch-wide browser picker used to live here. It moved into the
              rows: a suite that has to run one test on WebKit and the rest on
              Chromium was not expressible with a single choice, and every row
              now always resolves to at least one engine, so a global one would
              have nothing left to decide. */}
          {/* Parallelism, next to the option it most interacts with. Off is the
              default and is byte-for-byte the old sequential behaviour. */}
          <Select
            value={String(concurrency)}
            onValueChange={(v) => setConcurrency(v === "all" ? "all" : Number(v))}
            disabled={running}
          >
            <SelectTrigger
              variant="filled"
              size="small"
              className="w-32"
              aria-label="How many tests to run at once"
            >
              <SelectValue placeholder="Off" />
            </SelectTrigger>
            <SelectContent>
              {BATCH_CONCURRENCY_CHOICES.map((c) => (
                <SelectItem key={String(c)} value={String(c)}>
                  {batchConcurrencyLabel(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex cursor-pointer select-none items-center gap-1.5 pr-1 text-small text-secondary">
            {/* MASTER for the per-row toggles: flipping it overwrites every row.
                The overwrite lives HERE, in the event handler, and must never
                move into an effect keyed on `runHeadless` — the init effect
                above sets this from defaultRunHeadless on every mount, so an
                effect would silently wipe every saved row choice each time the
                user visited this view, with the UI looking correct throughout. */}
            <Checkbox
              checked={runHeadless}
              onCheckedChange={(v) => {
                const next = v === true;
                setRunHeadless(next);
                commitRows(applyHeadlessToAll(rowOptions, tests, rowDefaults, next));
              }}
              disabled={running}
              aria-label="Run every test in this batch headless"
            />
            Headless
          </label>
          <label className="flex cursor-pointer select-none items-center gap-1.5 pr-1 text-small text-secondary">
            {/* Independent of Headless, same as the per-test toggle: headless
                Chromium screenshots exactly as well, and for a batch it's the
                more useful combination — capture a whole suite without a browser
                window stealing focus for every test in it. */}
            <Checkbox
              checked={captureArtifacts}
              onCheckedChange={(v) => setCaptureArtifacts(v === true)}
              disabled={running}
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
              onClick={requestBatch}
              disabled={selectedIds.length === 0}
            >
              <Play className="size-4" />
              Run {selectedIds.length === tests.length ? "all" : selectedIds.length}
            </Button>
          )}
        </ToolbarActions>
      </Toolbar>

      {/* min-h-0 flex-1, NOT h-full. In a flex column h-full resolves to 100% of
          the PARENT, but the Toolbar above has already consumed part of that —
          so the scroll region extended past the bottom of the window by the
          toolbar's height and its last child (the pager) was cut off. flex-1
          claims only the remaining space; min-h-0 is required with it, or a
          flex item refuses to shrink below its content and overflows again. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-5 pb-10">
          {tests.length === 0 ? (
            <EmptyState
              className="py-16"
              title="No tests to run"
              description="Record or import a test first — batch runs execute the tests in your library one after another."
            />
          ) : (
            <>
              <TagCluster
                tests={tests}
                value={tagFilter}
                onChange={setTagFilter}
                disabled={running}
              />

              <div className="flex items-center gap-3">
                <Button
                  variant="glass"
                  size="small"
                  disabled={running}
                  onClick={() =>
                    // Ticks the visible tests rather than replacing the whole
                    // selection, so "select all" under a filter doesn't
                    // silently untick everything hidden.
                    commitRows(setSelection(rowOptions, visibleTests, rowDefaults, true))
                  }
                >
                  {tagFilter === ALL_TAGS ? "Select all" : "Select these"}
                </Button>
                <Button
                  variant="glass"
                  size="small"
                  disabled={running}
                  onClick={() =>
                    commitRows(setSelection(rowOptions, visibleTests, rowDefaults, false))
                  }
                >
                  {tagFilter === ALL_TAGS ? "Select none" : "Deselect these"}
                </Button>
                {/* Drag-to-reorder is otherwise a one-way door: there'd be no
                    way back to library order once you'd rearranged things. */}
                {isCustomOrder(tests, order) ? (
                  <Button
                    variant="glass"
                    size="small"
                    disabled={running}
                    onClick={() => {
                      // Clearing the stored order lets the drift effect rewrite
                      // it as plain library order on the next render.
                      setOrder([]);
                      api.recorder.setSettings({ batchOrder: [] }).catch(() => {});
                    }}
                  >
                    Reset order
                  </Button>
                ) : null}
                <Text variant="small" color="tertiary">
                  {effectiveConcurrency > 1
                    ? `${effectiveConcurrency} tests run at a time, starting in this order.`
                    : "Tests run one at a time, in this order."}
                </Text>
              </div>

              <div className="rounded-lg border border-separator bg-panel">
                {visibleTests.map((t) => {
                  const results = resultsFor.get(t.id) ?? [];
                  const status = rowStatus(results);
                  const isCurrent = status === "running";
                  const row = resolveRow(t, rowOptions, rowDefaults);
                  // Only meaningful once every entry for this test has settled;
                  // a partial sum would tick upward as engines finished and
                  // read as the run getting slower.
                  const durationMs = results.every((r) => r.durationMs !== undefined)
                    ? results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0)
                    : undefined;
                  // The note only makes sense attached to the outcome it
                  // explains, so take it from the result the badge is showing.
                  const badgeResult = results.find((r) => r.status === status);
                  const note = badgeResult?.note;
                  // A settled result that produced a RunRecord can open that
                  // run's console output right here — same log the Stats table
                  // links to, reached from the row that made you curious.
                  const logRunId =
                    status === "passed" || status === "failed"
                      ? badgeResult?.runRecordId
                      : undefined;
                  return (
                    <div
                      key={t.id}
                      onDragEnter={running ? undefined : () => setOverId(t.id)}
                      onDragOver={running ? undefined : (e) => e.preventDefault()}
                      onDrop={running ? undefined : (e) => e.preventDefault()}
                      className={`group/row flex items-center gap-3 border-b border-separator px-3 py-2 last:border-b-0 ${
                        isCurrent ? "bg-accent/10" : ""
                      } ${
                        overId === t.id && dragId !== null && dragId !== t.id
                          ? "border-t-2 border-t-accent"
                          : ""
                      } ${dragId === t.id ? "opacity-50" : ""}`}
                    >
                      {/* Matches the trainer's step list: grip appears on hover,
                          only the handle is draggable so row clicks still work. */}
                      <span
                        draggable={!running}
                        onDragStart={running ? undefined : () => setDragId(t.id)}
                        onDragEnd={running ? undefined : commitDrag}
                        className={`shrink-0 text-tertiary ${
                          running
                            ? "opacity-20"
                            : "cursor-grab opacity-0 group-hover/row:opacity-100 active:cursor-grabbing"
                        }`}
                        aria-label={`Drag to reorder ${t.name}`}
                      >
                        <GripVertical className="size-4" />
                      </span>
                      <Checkbox
                        checked={row.selected}
                        onCheckedChange={() => toggle(t)}
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
                      {/* Engines, icon-only. Deselected stays VISIBLE at low
                          opacity rather than hidden — an engine you can't see
                          is one you can't add back. aria-pressed is the real
                          contract here: it's what a screen reader announces and
                          the only thing worth asserting, since a class name
                          just pins today's styling. */}
                      <span className="flex shrink-0 items-center gap-0.5">
                        {RUN_BROWSERS.map((b) => {
                          const on = row.browsers.includes(b);
                          const engineResult = resultByKey.get(
                            resultKeyOf({ testId: t.id, browser: b }),
                          );
                          return (
                            <button
                              key={b}
                              type="button"
                              aria-pressed={on}
                              disabled={running}
                              aria-label={`Run ${t.name} on ${RUN_BROWSER_LABELS[b]}`}
                              title={RUN_BROWSER_LABELS[b]}
                              onClick={() =>
                                commitRows(
                                  setRow(rowOptions, t, rowDefaults, {
                                    browsers: toggleRowBrowser(row.browsers, b),
                                  }),
                                )
                              }
                              className={`rounded border p-1 transition-opacity ${
                                on
                                  ? "border-accent bg-control-subtle opacity-100"
                                  : "border-transparent opacity-40 hover:opacity-70"
                              } ${running ? "cursor-default" : ""}`}
                            >
                              {/* Tinted by this engine's own outcome, so a row
                                  running three engines can show "chromium
                                  passed, webkit failed" without three rows. */}
                              <BrowserIcon
                                browser={b}
                                labelled={false}
                                className={`size-3.5 shrink-0 ${
                                  engineResult?.status === "failed"
                                    ? "text-support-red"
                                    : engineResult?.status === "passed"
                                      ? "text-support-green"
                                      : ""
                                }`}
                              />
                            </button>
                          );
                        })}
                      </span>
                      {/* Per-row headed/headless. The toolbar checkbox is the
                          master that overwrites all of these at once. */}
                      <button
                        type="button"
                        aria-pressed={row.headless}
                        disabled={running}
                        aria-label={`Run ${t.name} headless`}
                        title={row.headless ? "Headless" : "Headed"}
                        onClick={() =>
                          commitRows(
                            setRow(rowOptions, t, rowDefaults, { headless: !row.headless }),
                          )
                        }
                        className={`shrink-0 rounded border p-1 transition-opacity ${
                          row.headless
                            ? "border-accent bg-control-subtle opacity-100"
                            : "border-transparent opacity-40 hover:opacity-70"
                        } ${running ? "cursor-default" : ""}`}
                      >
                        {row.headless ? (
                          <EyeOff className="size-3.5 shrink-0" />
                        ) : (
                          <Eye className="size-3.5 shrink-0" />
                        )}
                      </button>
                      {durationMs !== undefined ? (
                        <Text variant="small" color="tertiary">
                          {fmtDuration(durationMs)}
                        </Text>
                      ) : null}
                      {status ? (
                        logRunId ? (
                          <button
                            type="button"
                            aria-label={`Open console output for ${t.name}`}
                            title="Open this run's console output"
                            className="shrink-0 cursor-pointer"
                            onClick={() =>
                              setLogRun({ id: logRunId, title: `${t.name} — console output` })
                            }
                          >
                            <StatusBadge status={status} note={note} />
                          </button>
                        ) : (
                          <StatusBadge status={status} note={note} />
                        )
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {shown && !running && summary ? (
                <div className="rounded-lg border border-separator bg-panel p-4">
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
                  <div className="rounded-lg border border-separator bg-panel">
                    {history.map((b: BatchRecord) => (
                      <button
                        key={b.batchId}
                        type="button"
                        disabled={running}
                        onClick={() => setBatch(b)}
                        className={`flex w-full items-center gap-3 border-b border-separator px-3 py-2 text-left last:border-b-0 hover:bg-control-subtle disabled:opacity-50 ${
                          b.batchId === shown?.batchId ? "bg-control-subtle" : ""
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

      {/* Controlled rather than trigger-driven: the Run button has to be able
          to start the batch OUTRIGHT in every other case, so the dialog can't
          be what's wrapped around it. */}
      <AlertDialog
        open={pendingHeadedRun !== null}
        onOpenChange={(open) => {
          if (!open) setPendingHeadedRun(null);
        }}
        size="small"
        title={`Open ${pendingHeadedRun ?? 0} browser windows at once?`}
        description={
          `This batch runs ${pendingHeadedRun ?? 0} tests in parallel with visible browsers, so ` +
          `${pendingHeadedRun ?? 0} windows will open together and take focus as they launch — ` +
          "the machine will be hard to use until the batch finishes. Tick Headless to run the " +
          "same batch invisibly, or lower “At once”."
        }
        confirmLabel="Run anyway"
        onConfirm={() => {
          setPendingHeadedRun(null);
          void startBatch();
        }}
      />

      {logRun ? (
        <LogInspector runId={logRun.id} title={logRun.title} onClose={() => setLogRun(null)} />
      ) : null}
    </div>
  );
}
