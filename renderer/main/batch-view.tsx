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
import { applyOrder, isCustomOrder, moveToTarget, orderIdsOf } from "../lib/batch-order";
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
import {
  brokenSteps,
  rowsFromRoutine,
  sameSteps,
  stepsFromRows,
} from "../lib/routine-rows";
import { batchBelongsToRoutine } from "../../shared/routine-migration.mjs";
import type {
  BatchRecord,
  BatchState,
  BatchTestResult,
  BatchTestStatus,
  Routine,
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
  // The saved jobs. ROUTINES.md capability 1: this screen is now ONE Routine's
  // editor rather than the app's single implicit checklist, and the picker
  // below is what makes the others reachable.
  const routinesQuery = useQuery({ queryKey: ["routines"], queryFn: api.routines.list });
  const routines = React.useMemo(() => routinesQuery.data ?? [], [routinesQuery.data]);
  // Which one is open. Null until the list arrives — and null FOREVER for a
  // user with none, which is the state the migration leaves anyone who never
  // ticked a row. That is an empty screen with a "New routine" button, not an
  // error, and not an invented Routine nobody asked for.
  const [openId, setOpenId] = React.useState<string | null>(null);
  const openRoutine = React.useMemo(
    () => routines.find((r) => r.id === openId) ?? null,
    [routines, openId],
  );
  React.useEffect(() => {
    if (routines.length === 0) return;
    // Also covers the open Routine being deleted from under us: `openId` stops
    // resolving, and falling back to the first is better than a blank screen
    // reporting a job that no longer exists.
    if (openId !== null && routines.some((r) => r.id === openId)) return;
    setOpenId(routines[0].id);
  }, [routines, openId]);

  // Selection, engines and headedness — one persisted map keyed by test id, so
  // all three survive a restart. A test with NO entry resolves from its own
  // record and the global defaults (see batch-run-plan), which is why this
  // needed no migration and why a newly recorded test arrives UNTICKED.
  //
  // Unticked is the deliberate reversal of the old behaviour: a fresh test used
  // to be added to the selection automatically and joined the next "Run all"
  // without being asked.
  const [rowOptions, setRowOptions] = React.useState<RowOptionsMap>({});
  // A finished row's badge opens that run's console output — the row that made
  // you curious shouldn't need a detour through Stats to answer "why".
  const [logRun, setLogRun] = React.useState<{ id: string; title: string } | null>(null);
  // Which past batch has its drawer open. One at a time: the drawer lists every
  // test in that batch, and two open at once turns the history into a wall.
  const [expandedBatchId, setExpandedBatchId] = React.useState<string | null>(null);

  // Batch-level run options. `captureArtifacts` and `concurrency` are one-off
  // choices for this run; `runHeadless` is the MASTER for the per-row toggles
  // (see the Headless checkbox below). The browser picker moved into the rows.
  const [runHeadless, setRunHeadless] = React.useState(false);
  const [captureArtifacts, setCaptureArtifacts] = React.useState(false);
  const [concurrency, setConcurrency] = React.useState<BatchConcurrencyChoice>(1);
  const [optionsInited, setOptionsInited] = React.useState<string | null>(null);
  // `captureArtifacts` and `concurrency` are the ROUTINE'S now — a saved job
  // that forgot how many lanes it runs in is a saved job in name only, and the
  // spec puts both on `Routine.defaults`. They fall back to the global settings
  // for a user with no Routine yet, which is also what a brand-new one is
  // created with. `runHeadless` stays a bulk EDIT of the rows rather than a
  // stored field: it has always been a master switch, not a value.
  React.useEffect(() => {
    if (!settingsQuery.data) return;
    const key = openId ?? "";
    if (optionsInited === key) return;
    setRunHeadless(settingsQuery.data.defaultRunHeadless ?? false);
    setCaptureArtifacts(
      openRoutine
        ? openRoutine.defaults.captureArtifacts
        : (settingsQuery.data.defaultCaptureArtifacts ?? false),
    );
    setConcurrency(
      choiceFromSetting(
        openRoutine ? openRoutine.defaults.concurrency : settingsQuery.data.defaultBatchConcurrency,
      ),
    );
    setOptionsInited(key);
  }, [optionsInited, settingsQuery.data, openRoutine, openId]);

  // Set when Run is pressed on a headed batch big enough to be worth asking
  // about; holds the number of windows so the dialog can name it.
  const [pendingHeadedRun, setPendingHeadedRun] = React.useState<number | null>(null);

  // User-defined run order, persisted as ids in settings. Held locally while
  // dragging so rows track the pointer without a round trip per frame.
  const [order, setOrder] = React.useState<string[]>([]);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overId, setOverId] = React.useState<string | null>(null);

    // Tag filter over the checklist. Selection is stored by test id, so
  // switching filters never silently drops tests you already ticked. The chips
  // themselves live in TagCluster, which also owns deleting a tag library-wide.
  const [tagFilter, setTagFilter] = React.useState<string>(ALL_TAGS);
  const tags = React.useMemo(() => tagCounts(tests), [tests]);

  // Every test appears exactly once regardless of what was stored, so a test
  // added or deleted since the order was saved can never go missing.
  const orderedTests = React.useMemo(() => applyOrder(tests, order), [tests, order]);


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
      // The cache invalidation that used to be here moved to `recorder-store`
      // in §6.8, along with the live-batch subscription: doing it from a ROUTE
      // component meant it only happened if the user was on this screen when
      // the batch finished. The toasts stay — they are this view's own report
      // of a batch it started, not a fact about the cache.
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


  // SCOPED TO THE OPEN ROUTINE. This screen is one job's editor, and a history
  // listing every job's runs under it is the same lie as a checklist showing
  // another Routine's ticks. Batches with no `routineId` — everything run
  // before Routines shipped, plus the MCP's `run_batch` — belong to the
  // migrated Routine, which IS the old implicit checklist; see
  // `ORPHAN_BATCH_OWNER` for why the alternatives are worse.
  const history = React.useMemo(
    () => (historyQuery.data ?? []).filter((b) => batchBelongsToRoutine(b, openId)),
    [historyQuery.data, openId],
  );
  // THE LIVE BATCH IS SCOPED TOO, not just the history. Results are keyed by
  // testId, so a batch started from another Routine would paint ITS outcomes
  // onto whichever rows this one happens to share — a row reporting a pass it
  // never had. The top strip's job ticker (§6.8) still reports that batch
  // globally, which is where a fact about the whole app belongs; here the
  // screen simply looks idle, and pressing Run answers "a batch is already
  // running" rather than pretending otherwise.
  const mine = batch && batchBelongsToRoutine(batch, openId) ? batch : null;
  // Nothing live → show the most recent persisted batch, so a restart doesn't
  // present a blank view as though the batch never happened.
  const shown: BatchState | null = mine ?? history[0] ?? null;
  const running = mine?.running ?? false;

  // The globals a row falls back to when the user has never touched it.
  const rowDefaults = React.useMemo(
    () => ({
      defaultRunBrowser: settingsQuery.data?.defaultRunBrowser,
      defaultRunHeadless: settingsQuery.data?.defaultRunHeadless,
    }),
    [settingsQuery.data],
  );

  // ── The open Routine, opened into the checklist ─────────────────────
  //
  // RE-SEEDED WHENEVER THE ROUTINE OR THE LIBRARY CHANGES, and that is safe
  // precisely because every gesture below persists immediately: what the job
  // contains goes to the Routine, what an unticked row remembers goes to the
  // settings scratch. There is no unsaved state for a re-seed to lose, so this
  // also replaces the two "drift" effects that used to rewrite storage when a
  // test was added or deleted — `rowsFromRoutine` only ever emits rows for
  // tests that exist.
  //
  // THE KEY INCLUDES `updatedAt`, and that is not belt-and-braces. Without it:
  // untick a row, then have the library refetch before the Routine query has
  // caught up, and the re-seed reads the STALE Routine — the unticked test
  // comes back, silently, and the next gesture writes it into the job. The
  // stored `updatedAt` moving is precisely the signal that the record on screen
  // is behind the one on disk. It also means every save re-seeds from what was
  // actually stored rather than from what was sent, which is what makes the
  // store's own rebuild (a dropped step, two steps collapsed) visible instead
  // of appearing to have been accepted.
  const libraryKey = React.useMemo(() => tests.map((t) => t.id).join("\u0000"), [tests]);
  const [seedKey, setSeedKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!settingsQuery.data || routinesQuery.data === undefined) return;
    const key = `${openId ?? ""}|${openRoutine?.updatedAt ?? 0}|${libraryKey}`;
    if (seedKey === key) return;
    const rows = rowsFromRoutine(
      openRoutine,
      tests,
      {
        defaultRunBrowser: settingsQuery.data.defaultRunBrowser,
        defaultRunHeadless: settingsQuery.data.defaultRunHeadless,
      },
      settingsQuery.data.batchTestOptions ?? {},
      settingsQuery.data.batchOrder ?? [],
    );
    setOrder(rows.order);
    setRowOptions(rows.rowOptions);
    setSeedKey(key);
  }, [settingsQuery.data, routinesQuery.data, openRoutine, openId, tests, libraryKey, seedKey]);

  // Steps naming a test the library no longer has. Kept by the store on
  // purpose (ROUTINES open question 4) so a saved job never silently shrinks;
  // the checklist cannot draw a row for a test that is gone, so they are
  // reported above it instead.
  const broken = React.useMemo(() => brokenSteps(openRoutine, tests), [openRoutine, tests]);

  // The last payload sent, and how many saves are still in flight. See
  // `saveRoutine` — two edits made before the first round trip lands would
  // otherwise clobber each other.
  const pending = React.useRef<Routine | null>(null);
  const inFlight = React.useRef(0);
  React.useEffect(() => {
    pending.current = null;
    inFlight.current = 0;
  }, [openId]);

  // The name, held locally while it is being typed. Committed on blur and on
  // Enter — see the field itself for why not per keystroke.
  const [nameDraft, setNameDraft] = React.useState("");
  React.useEffect(() => {
    setNameDraft(openRoutine?.name ?? "");
  }, [openRoutine?.id, openRoutine?.name]);

  // Which Routine the confirm dialog is about. Held as the RECORD, not the id,
  // so the dialog can name it even in the frame where the list has already
  // moved on.
  const [pendingDelete, setPendingDelete] = React.useState<Routine | null>(null);

  /**
   * Write the open Routine.
   *
   * THE BASE COMES FROM THE CACHE, NOT FROM THE CLOSURE. Two edits in quick
   * succession — tick Headless, then tick Capture — both render before either
   * save has come back, so a handler spreading the `openRoutine` it captured
   * would write the OLD steps back over the new ones. The second edit appears
   * to work and silently undoes the first; nothing errors and the screen looks
   * right until the next reload. Reading the freshest record at call time is
   * what makes each patch a patch.
   *
   * Returns nothing: the invalidation is what puts the STORED version — the one
   * the backend rebuilt, possibly with a step dropped — back on screen, rather
   * than the payload we hoped for.
   */
  const saveRoutine = React.useCallback(
    (patch: Partial<Routine>) => {
      if (!openId) return;
      const base =
        // What we last SENT, while anything is still in flight. The cache is
        // not enough on its own: invalidation is asynchronous, so a second
        // patch issued before the first round trip lands would read the
        // pre-edit record out of it and write the old value straight back.
        (inFlight.current > 0 ? pending.current : null) ??
        (qc.getQueryData<Routine[]>(["routines"]) ?? []).find((r) => r.id === openId) ??
        openRoutine;
      if (!base) return;
      const next = { ...base, ...patch };
      pending.current = next;
      inFlight.current++;
      api.routines
        .save(next)
        .then(() => qc.invalidateQueries({ queryKey: ["routines"] }))
        .catch(() => toast.error("Could not save this routine."))
        .finally(() => {
          // Dropped to zero means the cache is authoritative again — and it has
          // to become authoritative, or a change made ELSEWHERE (a deleted test
          // tombstoning a step) would be overwritten by a stale local copy on
          // the next edit.
          inFlight.current = Math.max(0, inFlight.current - 1);
          if (inFlight.current === 0) pending.current = null;
        });
    },
    [openId, openRoutine, qc],
  );

  const commitName = React.useCallback(() => {
    if (!openRoutine) return;
    const next = nameDraft.trim();
    // An empty name is not a rename, it is a half-finished one. Snapping back
    // is what makes the field safe to clear and retype.
    if (next === "" || next === openRoutine.name) {
      setNameDraft(openRoutine.name);
      return;
    }
    saveRoutine({ name: next });
  }, [nameDraft, openRoutine, saveRoutine]);

  /** A new, empty Routine, opened immediately.
   *
   *  EMPTY, not "a copy of what is on screen". The tick boxes are how a test
   *  joins a job, and pre-filling would make the first thing a new Routine does
   *  be something the user has to undo. Its defaults come from the global
   *  settings, which is where a first Routine's would have come from too. */
  const createRoutine = React.useCallback(async () => {
    const stamp = Date.now();
    const taken = new Set(routines.map((r) => r.name));
    let name = "New routine";
    for (let n = 2; taken.has(name); n++) name = `New routine ${n}`;
    try {
      const created = await api.routines.save({
        id: `routine-${stamp}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        createdAt: stamp,
        updatedAt: stamp,
        steps: [],
        defaults: {
          captureArtifacts: settingsQuery.data?.defaultCaptureArtifacts ?? false,
          concurrency: settingsQuery.data?.defaultBatchConcurrency ?? 1,
        },
      });
      await qc.invalidateQueries({ queryKey: ["routines"] });
      if (created) setOpenId(created.id);
    } catch {
      toast.error("Could not create a routine.");
    }
  }, [routines, settingsQuery.data, qc]);

  // ── Every write, in one place ───────────────────────────────────────
  //
  // TWO STORES, ONE AUTHORITY EACH. What the JOB is — which tests, in what
  // order, on which engines, headed or not — goes to the Routine. What a row
  // REMEMBERS while it is not in the job goes to `batchTestOptions`, which is
  // where it already lived: untick a row that ran on WebKit and tick it again,
  // and the choice is still there rather than silently reset to Chromium.
  //
  // The Routine write is SKIPPED when the steps did not change. The view
  // commits on every tick, drag and engine click, and `updatedAt` is what the
  // picker sorts by and what a schedule will one day compare against — writing
  // on a change that changed nothing would re-date a job for opening it.
  //
  // Both persists are best-effort, matching what the stored order always did:
  // the choice still applies to this session if the write fails.
  const persist = React.useCallback(
    (nextOrder: string[], nextRows: RowOptionsMap) => {
      setOrder(nextOrder);
      setRowOptions(nextRows);
      const liveIds = tests.map((t) => t.id);
      api.recorder
        .setSettings({
          batchOrder: nextOrder,
          // Pruned on the way out rather than by an effect watching for drift:
          // stateless, so it cannot loop, and a re-imported test is new again
          // rather than inheriting a choice nobody remembers.
          batchTestOptions: pruneRowOptions(nextRows, liveIds),
        })
        .catch(() => {});
      if (!openRoutine) return;
      const steps = stepsFromRows(nextOrder, nextRows, tests, rowDefaults, openRoutine.steps);
      if (sameSteps(steps, openRoutine.steps)) return;
      saveRoutine({ steps });
    },
    [tests, rowDefaults, openRoutine, saveRoutine],
  );

  /** A row change: the order is untouched. */
  const commitRows = React.useCallback(
    (next: RowOptionsMap) => persist(order, next),
    [order, persist],
  );

  // Commit a drag: reorder by ID, not by visible index — under a tag filter the
  // visible rows are only a subsequence of the real order.
  const commitDrag = () => {
    if (dragId && overId && dragId !== overId) {
      persist(moveToTarget(orderIdsOf(orderedTests), dragId, overId), rowOptions);
    }
    setDragId(null);
    setOverId(null);
  };


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

  // RUNS THE SAVED ROUTINE, not the screen. The backend re-reads the record and
  // builds the queue from it, so what runs is what is stored — if those ever
  // disagree, the run is right and the screen is stale, which is the only
  // direction that is recoverable. It also means a Routine started from
  // anywhere else does exactly the same thing.
  const startBatch = async () => {
    if (!openId || selectedIds.length === 0) return;
    try {
      const res = await api.routines.run(openId);
      if (res.alreadyRunning) toast.info("A batch is already running.");
      // A NOTE, NOT A FAILURE. The run still did most of what was asked; the
      // alternative — refusing — lets one deleted test disable a suite. Saying
      // nothing is what would make this feature untrustworthy.
      else if (res.skipped.length > 0) {
        toast.info(
          res.skipped.length === 1
            ? "1 step skipped — its test has been deleted."
            : `${res.skipped.length} steps skipped — their tests have been deleted.`,
        );
      }
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
    const results = mine?.results ?? [];
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
      {/* ── The open Routine ──────────────────────────────────────────────
          The name is an ordinary editable field rather than a title with a
          pencil beside it: this screen only ever shows ONE Routine, so the
          name is a property of what you are looking at, and a second click to
          reach it buys nothing. It commits on blur and on Enter, never per
          keystroke — a save per character would re-date the job continuously
          and put a write on the disk for every letter. */}
      <div className="gl-batch-controls">
        <Menu
          value={openRoutine ? openRoutine.name : "No routine"}
          label="Which routine to edit"
          disabled={running}
          width={200}
        >
          {(close) => (
            <>
              {routines.map((r) => (
                <MenuItem
                  key={r.id}
                  label={r.name}
                  consequence={
                    r.steps.length === 1 ? "1 test" : `${r.steps.length} tests`
                  }
                  selected={r.id === openId}
                  onSelect={() => {
                    setOpenId(r.id);
                    close();
                  }}
                />
              ))}
              <MenuItem
                label="New routine…"
                consequence="An empty job you tick tests into"
                onSelect={() => {
                  close();
                  void createRoutine();
                }}
              />
              {openRoutine ? (
                <MenuItem
                  label={`Delete "${openRoutine.name}"`}
                  consequence="The tests are untouched — only the job goes"
                  onSelect={() => {
                    close();
                    setPendingDelete(openRoutine);
                  }}
                />
              ) : null}
            </>
          )}
        </Menu>
        {openRoutine ? (
          // A PLAIN INPUT, not the `Input` primitive. That one carries its own
          // light chrome, and its utilities win over a theme class by source
          // order — so the name rendered as the brightest thing on a screen
          // whose subject is the checklist below it. The theme layer owns this
          // one instead; `check:renderer-classes` proves the class resolves.
          <input
            type="text"
            value={nameDraft}
            disabled={running}
            aria-label="Routine name"
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              // Escape abandons the edit rather than committing it — the only
              // way back from a half-typed rename you did not mean to start.
              if (e.key === "Escape") setNameDraft(openRoutine.name);
            }}
            className="gl-routine-name"
          />
        ) : null}

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
                  saveRoutine({
                    defaults: {
                      ...(openRoutine?.defaults ?? { captureArtifacts: false }),
                      // Stored as the NUMBER the picker means, so "All at once"
                      // survives as the ceiling rather than as a word this
                      // module would have to re-interpret on the backend.
                      concurrency: resolveConcurrency(c, tests.length || 1),
                    },
                  });
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
              onCheckedChange={(v) => {
                const next = v === true;
                setCaptureArtifacts(next);
                saveRoutine({
                  defaults: { ...(openRoutine?.defaults ?? { concurrency: 1 }), captureArtifacts: next },
                });
              }}
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
          {/* STEPS WITH NO ROW. The store keeps a step whose test was deleted
              (ROUTINES open question 4) so a saved job never silently shrinks —
              but the checklist cannot draw a row for a test that does not
              exist, so they are reported here, above it, and removed from
              here. Without this the job would be one step longer than the
              screen and nothing would say so. */}
          {broken.length > 0 ? (
            <Panel title="Deleted tests still in this routine">
              <p className="gl-note" style={{ padding: "0 0 8px" }}>
                {broken.length === 1
                  ? "One step names a test that no longer exists. It is skipped when this routine runs."
                  : `${broken.length} steps name tests that no longer exist. They are skipped when this routine runs.`}
              </p>
              <Btn
                tone="ghost"
                disabled={running}
                onClick={() =>
                  saveRoutine({
                    steps: (openRoutine?.steps ?? []).filter(
                      (step) => !broken.some((b) => b.testId === step.testId),
                    ),
                  })
                }
              >
                Remove {broken.length === 1 ? "it" : "them"}
              </Btn>
            </Panel>
          ) : null}

          {routines.length === 0 ? (
            <p className="gl-note" style={{ padding: "40px 0", textAlign: "center" }}>
              No routines yet. A routine is a saved job — the tests it runs, the engines they run
              on, and how many go at once. Make one from the menu above.
            </p>
          ) : tests.length === 0 ? (
            <p className="gl-note" style={{ padding: "40px 0", textAlign: "center" }}>
              No tests to run. Record or import a test first — a routine runs the tests in your
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
                    onClick={() =>
                      // RESETS THE JOB'S ORDER TOO, not just the scratch one.
                      // The routine's steps lead the list, so clearing
                      // `batchOrder` alone left the button visible and inert —
                      // a control that does nothing is worse than no control.
                      // Committing library order through `persist` rewrites the
                      // steps in that order, which is what the button says.
                      persist(orderIdsOf(applyOrder(tests, [])), rowOptions)
                    }
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

      {/* Deleting a JOB, not tests, and the description has to say so — the
          checklist right above it is a list of tests with tick boxes, and
          "Delete Smoke?" beside it reads like it might take them with it. */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        size="small"
        title={`Delete “${pendingDelete?.name ?? ""}”?`}
        description={
          "The routine goes; the tests in it are untouched and stay in your library. " +
          "Its past runs stay in Stats."
        }
        confirmLabel="Delete routine"
        onConfirm={() => {
          const doomed = pendingDelete;
          setPendingDelete(null);
          if (!doomed) return;
          api.routines
            .remove(doomed.id)
            .then(() => {
              // Clearing the open id lets the effect above fall back to the
              // first surviving Routine, rather than this view holding an id
              // that resolves to nothing.
              setOpenId(null);
              return qc.invalidateQueries({ queryKey: ["routines"] });
            })
            .catch(() => toast.error("Could not delete this routine."));
        }}
      />

      {logRun ? (
        <LogInspector runId={logRun.id} title={logRun.title} onClose={() => setLogRun(null)} />
      ) : null}
    </div>
  );
}
