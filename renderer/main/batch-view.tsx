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
import { AlertDialog, Checkbox, ScrollArea, toast } from "@ui";
import { ChevronDown, ChevronRight, GripVertical, Play, Square } from "lucide-react";

import { Btn, Menu, MenuItem, Panel, StatusChip, TONE, toneSurface } from "../theme";
import { api } from "../lib/api";
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
  batchConcurrencyConsequence,
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
import {
  batchOutcome,
  batchOutcomeLabel,
  batchOutcomeTitle,
  batchOutcomeTone,
} from "../lib/batch-outcome";
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

/** Two letters per engine, not a logo.
 *
 *  Three browser logos at 14px are three coloured blobs — recognisable if you
 *  already know them, meaningless if you do not — and, more to the point, a
 *  logo cannot carry a per-engine RESULT. This cell has to be able to say
 *  "chromium passed, webkit failed" on one row, and two letters can be tinted
 *  where a brand mark cannot. */
const ENGINE_CODE: Record<RunBrowser, string> = {
  chromium: "CR",
  firefox: "FF",
  webkit: "WK",
};

/** The batch's five row states as the design's one chip shape.
 *
 *  `running` takes the holo treatment rather than a hue, and that is the
 *  primitive's rule rather than this screen's: running is the ABSENCE of an
 *  outcome, so a row still in flight must not look like a row that has
 *  finished and reported something. `queued` and `skipped` are neutral for the
 *  same reason — neither is a result. */
function StatusBadge({ status, note }: { status: BatchTestStatus; note?: string }) {
  switch (status) {
    case "passed":
      return <StatusChip tone="phos">Passed</StatusChip>;
    case "failed":
      return <StatusChip tone="red">Failed</StatusChip>;
    case "running":
      return (
        <StatusChip running animated>
          Running
        </StatusChip>
      );
    case "skipped":
      return <StatusChip title={note}>Skipped</StatusChip>;
    default:
      return <StatusChip>Queued</StatusChip>;
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
  // Which past batch has its drawer open. One at a time: the drawer lists every
  // test in that batch, and two open at once turns the history into a wall.
  const [expandedBatchId, setExpandedBatchId] = React.useState<string | null>(null);
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
    <div className="gl-batch">
      {/* THE TOOLBAR IS GONE, like every other reskinned screen: the top strip's
          breadcrumb already says BATCH. What is left is the controls, and the
          status line that used to be the toolbar's description — same strings,
          because they are what the tests and the user both read. */}
      <div className="gl-batch-controls">
        {/* Parallelism, and the one control on this screen that stopped being a
            native menu. The SDK `Select` is kept everywhere else — but a native
            menu item is a STRING, and the whole point here is the second line.
            "8" cannot say "a laptop will thrash and report failures it caused",
            which is a failure mode that looks exactly like a flaky suite from
            the run report. REDESIGN §8.2 names this swap, and the upside is
            that the options are finally real DOM. */}
        <Menu
          value={batchConcurrencyLabel(concurrency)}
          label="How many tests to run at once"
          disabled={running}
          width={132}
        >
          {(close) =>
            BATCH_CONCURRENCY_CHOICES.map((c) => (
              <MenuItem
                key={String(c)}
                label={batchConcurrencyLabel(c)}
                consequence={batchConcurrencyConsequence(c)}
                selected={String(c) === String(concurrency)}
                onSelect={() => {
                  setConcurrency(c);
                  close();
                }}
              />
            ))
          }
        </Menu>

        {/* One bordered box, two cells: both answer "how should this batch
            run?", and two loose checkboxes in a row read as two unrelated
            questions. */}
        <div className="gl-batch-cluster">
          <label className="gl-batch-cluster-cell" data-on={runHeadless ? "" : undefined}>
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
          <label className="gl-batch-cluster-cell" data-on={captureArtifacts ? "" : undefined}>
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
        </div>

        {running ? (
          <Btn tone="stop" onClick={() => void api.batch.stop()}>
            <Square aria-hidden="true" />
            Stop
          </Btn>
        ) : (
          <Btn tone="go" onClick={requestBatch} disabled={selectedIds.length === 0}>
            <Play aria-hidden="true" />
            Run {selectedIds.length === tests.length ? "all" : selectedIds.length}
          </Btn>
        )}

        <span className="gl-batch-note">
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
        </span>
      </div>

      {/* min-h-0 flex-1, NOT h-full. In a flex column h-full resolves to 100% of
          the PARENT, but the Toolbar above has already consumed part of that —
          so the scroll region extended past the bottom of the window by the
          toolbar's height and its last child (the pager) was cut off. flex-1
          claims only the remaining space; min-h-0 is required with it, or a
          flex item refuses to shrink below its content and overflows again. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-5 pb-10">
          {tests.length === 0 ? (
            <p className="gl-note" style={{ padding: "40px 0", textAlign: "center" }}>
              No tests to run. Record or import a test first — a batch runs the tests in your
              library, in the order this list shows.
            </p>
          ) : (
            <>
              <TagCluster
                tests={tests}
                value={tagFilter}
                onChange={setTagFilter}
                disabled={running}
              />

              <div className="gl-batch-controls">
                <Btn
                  tone="ghost"
                  disabled={running}
                  onClick={() =>
                    // Ticks the visible tests rather than replacing the whole
                    // selection, so "select all" under a filter doesn't
                    // silently untick everything hidden.
                    commitRows(setSelection(rowOptions, visibleTests, rowDefaults, true))
                  }
                >
                  {tagFilter === ALL_TAGS ? "Select all" : "Select these"}
                </Btn>
                <Btn
                  tone="ghost"
                  disabled={running}
                  onClick={() =>
                    commitRows(setSelection(rowOptions, visibleTests, rowDefaults, false))
                  }
                >
                  {tagFilter === ALL_TAGS ? "Select none" : "Deselect these"}
                </Btn>
                {/* Drag-to-reorder is otherwise a one-way door: there'd be no
                    way back to library order once you'd rearranged things. */}
                {isCustomOrder(tests, order) ? (
                  <Btn
                    tone="ghost"
                    disabled={running}
                    onClick={() => {
                      // Clearing the stored order lets the drift effect rewrite
                      // it as plain library order on the next render.
                      setOrder([]);
                      api.recorder.setSettings({ batchOrder: [] }).catch(() => {});
                    }}
                  >
                    Reset order
                  </Btn>
                ) : null}
                <span className="gl-batch-note">
                  {effectiveConcurrency > 1
                    ? `${effectiveConcurrency} tests run at a time, starting in this order.`
                    : "Tests run one at a time, in this order."}
                </span>
              </div>

              <Panel title="Checklist">
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
                      className="gl-batch-row"
                      data-running={isCurrent ? "" : undefined}
                      data-dragging={dragId === t.id ? "" : undefined}
                      data-drop-target={
                        overId === t.id && dragId !== null && dragId !== t.id ? "" : undefined
                      }
                    >
                      {/* Matches the trainer's step list: grip appears on hover,
                          only the handle is draggable so row clicks still work. */}
                      <span
                        draggable={!running}
                        onDragStart={running ? undefined : () => setDragId(t.id)}
                        onDragEnd={running ? undefined : commitDrag}
                        className="gl-batch-grip"
                        data-locked={running ? "" : undefined}
                        aria-label={`Drag to reorder ${t.name}`}
                      >
                        <GripVertical aria-hidden="true" />
                      </span>
                      <Checkbox
                        checked={row.selected}
                        onCheckedChange={() => toggle(t)}
                        disabled={running}
                        aria-label={`Include ${t.name} in the batch`}
                      />
                      {/* The one cell that gives, and it keeps a floor. As the
                          only flexible cell in a row of fixed furniture it took
                          the entire squeeze and reached width zero — a row with
                          no name at all, which makes the checkbox beside it
                          meaningless. See screens.css. */}
                      <button
                        type="button"
                        className="gl-batch-name"
                        title={t.name}
                        onClick={() => navigate({ to: "/test/$id", params: { id: t.id } })}
                      >
                        {t.name}
                      </button>
                      <span className="gl-batch-tags">
                        {(t.tags ?? []).slice(0, 2).map((tag) => (
                          <span key={tag.toLowerCase()} className="gl-chip">
                            {tag}
                          </span>
                        ))}
                        {(t.tags ?? []).length > 2 ? (
                          <span className="gl-batch-time">+{(t.tags ?? []).length - 2}</span>
                        ) : null}
                      </span>
                      {/* Engines as two-letter codes. Deselected stays VISIBLE
                          at low contrast rather than hidden — an engine you
                          can't see is one you can't add back. `aria-pressed` is
                          the real contract: it's what a screen reader announces
                          and what the stylesheet selects on, so there is no
                          second class that could disagree. */}
                      <span className="gl-batch-engines">
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
                              className="gl-batch-engine"
                              // Tinted by this engine's OWN outcome, so a row
                              // running three engines can report "chromium
                              // passed, webkit failed" without three rows.
                              style={
                                engineResult?.status === "failed"
                                  ? { color: TONE.red, opacity: 1 }
                                  : engineResult?.status === "passed"
                                    ? { color: TONE.phos, opacity: 1 }
                                    : undefined
                              }
                            >
                              {ENGINE_CODE[b]}
                            </button>
                          );
                        })}
                      </span>
                      {/* HEADED IS AMBER — the one place on this row where a hue
                          marks a setting rather than a result, and it earns it:
                          a headed batch opens a real window per test and takes
                          focus as each launches. That is caution. */}
                      <button
                        type="button"
                        aria-pressed={row.headless}
                        disabled={running}
                        aria-label={`Run ${t.name} headless`}
                        title={row.headless ? "Headless" : "Headed — a real window opens"}
                        onClick={() =>
                          commitRows(
                            setRow(rowOptions, t, rowDefaults, { headless: !row.headless }),
                          )
                        }
                        className="gl-batch-window"
                        style={row.headless ? undefined : toneSurface(TONE.amber)}
                      >
                        {row.headless ? "Headless" : "Headed"}
                      </button>
                      <span className="gl-batch-time">
                        {durationMs !== undefined ? fmtDuration(durationMs) : null}
                      </span>
                      {logRunId ? (
                        <button
                          type="button"
                          aria-label={`Open console output for ${t.name}`}
                          title="Open this run's console output"
                          className="gl-batch-status"
                          data-clickable=""
                          onClick={() =>
                            setLogRun({ id: logRunId, title: `${t.name} — console output` })
                          }
                        >
                          <StatusBadge status={status!} note={note} />
                        </button>
                      ) : (
                        <span className="gl-batch-status">
                          {status ? <StatusBadge status={status} note={note} /> : null}
                        </span>
                      )}
                    </div>
                  );
                })}
              </Panel>

              {shown && !running && summary ? (
                <Panel
                  title={batchOutcomeTitle(batchOutcome(shown))}
                  // The verdict was previously carried by the heading ALONE, so
                  // the one moment the view most needs a colour — the batch
                  // finishing — was the one place it had none.
                  right={
                    <StatusChip tone={batchOutcomeTone(batchOutcome(shown)) ?? undefined}>
                      {batchOutcomeLabel(shown)}
                    </StatusChip>
                  }
                  pad
                >
                  <p className="gl-note">
                    {fmtDateTime(shown.startedAt)} · {summary.passed} passed · {summary.failed}{" "}
                    failed · {summary.skipped} skipped · {fmtDuration(summary.durationMs)} total.
                    Each test also appears in Stats as its own run.
                  </p>
                </Panel>
              ) : null}

              {history.length > 0 ? (
                <Panel
                  title="Previous batches"
                  id={String(history.length)}
                  right={
                    <Btn
                      tone="ghost"
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
                    </Btn>
                  }
                >
                  {history.map((b: BatchRecord) => {
                    const expanded = expandedBatchId === b.batchId;
                    return (
                      <React.Fragment key={b.batchId}>
                        <button
                          type="button"
                          disabled={running}
                          // The row does TWO things and they are deliberately
                          // the same gesture: it expands the drawer AND makes
                          // that batch the one the checklist above is showing
                          // results for. Splitting them into a caret and a row
                          // would be two affordances for "look at this batch".
                          onClick={() => {
                            setBatch(b);
                            setExpandedBatchId(expanded ? null : b.batchId);
                          }}
                          aria-expanded={expanded}
                          className="gl-batch-history-row"
                          data-selected={b.batchId === shown?.batchId ? "" : undefined}
                        >
                          <span className="gl-batch-history-caret" aria-hidden="true">
                            {expanded ? (
                              <ChevronDown className="size-3" />
                            ) : (
                              <ChevronRight className="size-3" />
                            )}
                          </span>
                          <span className="gl-batch-history-when">
                            {fmtDateTime(b.startedAt)}
                          </span>
                          <span className="gl-batch-history-what">
                            {b.summary.total} {b.summary.total === 1 ? "test" : "tests"} ·{" "}
                            {fmtDuration(b.summary.durationMs)}
                          </span>
                          <span className="gl-batch-status">
                            {/* Amber vs red is what tells a suite with a
                                problem in it apart from a suite that never ran
                                — scanning history, that is the difference
                                between one bad test and a broken base URL. */}
                            <StatusChip tone={batchOutcomeTone(batchOutcome(b)) ?? undefined}>
                              {batchOutcomeLabel(b)}
                            </StatusChip>
                          </span>
                        </button>
                        {/* The drawer. Presentation over data `batch-history-store`
                            already keeps: what that batch ran and what it ran
                            under. Before this, the settings a past batch used
                            were simply not visible anywhere — "it passed last
                            week" and "it passed last week HEADLESS" are
                            different facts, and only one of them was on screen. */}
                        {expanded ? (
                          <div className="gl-batch-drawer">
                            {/* WHAT IS NOT HERE, and why: the design asks the
                                drawer to show "the settings it ran under" as
                                well, on the stated grounds that
                                `batch-history-store` already keeps them. It does
                                not — `BatchRecord` has no `captureArtifacts` and
                                no `concurrency`, so there is nothing to render
                                and inventing a plausible line would be worse
                                than omitting one. What the record DOES carry per
                                result is the engine, which is the most useful
                                half of that question and was previously not
                                visible for a past batch at all. The rest wants a
                                backend field; see DECISIONS. */}
                            {b.results.map((r, i) => (
                              <div key={`${r.testId}-${r.browser ?? ""}-${i}`} className="gl-batch-drawer-row">
                                <span className="gl-batch-drawer-name">{r.testName}</span>
                                {r.browser ? (
                                  <span className="gl-chip">{ENGINE_CODE[r.browser]}</span>
                                ) : null}
                                <span className="gl-batch-time">
                                  {r.durationMs !== undefined ? fmtDuration(r.durationMs) : null}
                                </span>
                                <span className="gl-batch-status">
                                  <StatusBadge status={r.status} note={r.note} />
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </React.Fragment>
                    );
                  })}
                </Panel>
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
