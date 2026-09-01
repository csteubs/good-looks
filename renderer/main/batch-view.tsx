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
import {
  Bell,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GripVertical,
  Play,
  Square,
  Timer,
} from "lucide-react";

import { Btn, Menu, MenuItem, Panel, StatusChip, TONE, toneSurface } from "../theme";
import { api } from "../lib/api";
import { MAX_ROUTINE_MESSAGE, RUN_BROWSERS, RUN_BROWSER_LABELS } from "../lib/recorder-types";
import { ALL_TAGS, UNTAGGED, filterByTag, tagCounts } from "../lib/test-tags";
import { LogInspector } from "./log-inspector";
import { useRecorder } from "./recorder-store";
import { SchedulePicker } from "./schedule-picker";
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
  selectionState,
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
  lastTestIdBefore,
  nextPolicy,
  POLICY_LABELS,
  rowsFromRoutine,
  sameSteps,
  stepsFromRows,
} from "../lib/routine-rows";
import type {
  BranchOf,
  GroupOf,
  PolicyMap,
  RoutineBranch,
  RoutineGroup,
  RoutineNotify,
  RoutineWait,
} from "../lib/routine-rows";
import { createRoutine, randomSuffix } from "../lib/create-routine";
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

/** What a freshly added pause is set to: thirty seconds.
 *
 *  A length had to be chosen. Thirty seconds is long enough to be the thing
 *  somebody wanted (let a deploy settle, let a queue drain) and short enough
 *  that adding one by accident is not a job that appears to hang. */
const DEFAULT_WAIT_MS = 30_000;

/** The durations a pause can be set to. An ENUMERATION, for the same reason the
 *  schedule is one: every value comes from a control that cannot produce a bad
 *  one, so there is no way to type a wait that outlives the run's patience. The
 *  top of this list is `MAX_ROUTINE_WAIT_MS`. */
const WAIT_CHOICES = [5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 3_600_000];

/** What a freshly added message says until the user writes their own. Something
 *  had to be there — an empty message is a step the store drops, so a blank
 *  default would make "add a message" appear to do nothing. */
const DEFAULT_MESSAGE = "Reached this point";

function fmtWait(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
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
  // Pending cross-test proposals — the outcome panel's one-line pointer. In
  // RUN_DERIVED_KEYS, so a routine finishing refreshes it with everything else.
  const { data: allProposals = [] } = useQuery({
    queryKey: ["propagations", "all"],
    queryFn: () => api.propagation.listAll(),
  });
  const pendingProposals = allProposals.filter((p) => p.status === "pending").length;
  const settingsQuery = useQuery({
    queryKey: ["recorder-settings"],
    queryFn: () => api.recorder.getSettings(),
  });
  // The saved jobs. ROUTINES.md capability 1: this screen is now ONE Routine's
  // editor rather than the app's single implicit checklist, and the picker
  // below is what makes the others reachable.
  const routinesQuery = useQuery({ queryKey: ["routines"], queryFn: api.routines.list });
  const routines = React.useMemo(() => routinesQuery.data ?? [], [routinesQuery.data]);
  // Which one is open. HELD IN THE STORE rather than here, because the rail
  // selects it and this view edits it — see `openRoutineId` in recorder-store
  // for why not the router. Null until the list arrives, and null FOREVER for a
  // user with none, which is the state the migration leaves anyone who never
  // ticked a row: an empty screen with a "New routine" button, not an error and
  // not an invented Routine nobody asked for.
  const { openRoutineId: openId, setOpenRoutineId: setOpenId } = useRecorder();
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
  // What each step in the job does when it fails. Held apart from `rowOptions`
  // for the reason `PolicyMap` gives: a row's engines survive being unticked as
  // scratch, a policy is a statement about the job and does not.
  const [policies, setPolicies] = React.useState<PolicyMap>({});
  // The job's groups, and who is in them. docs/ROUTINES.md capability 3's first
  // slice: a group is pure structure over test steps, and its only run-time
  // meaning is `skipGroup`. Two maps rather than one nested list for the same
  // reason `policies` is separate — the checklist stays a FLAT ordered list of
  // rows, and the nesting is redrawn from `groupOf` at render time, so drag to
  // reorder never has to learn about containers.
  const [groups, setGroups] = React.useState<RoutineGroup[]>([]);
  const [groupOf, setGroupOf] = React.useState<GroupOf>({});
  // The job's pauses, each pinned to the row it follows. A wait is not a row —
  // it has no test to draw one from — so it rides beside the order rather than
  // in it, the same shape a group header takes.
  const [waits, setWaits] = React.useState<RoutineWait[]>([]);
  // The job's messages, pinned the same way as its pauses.
  const [notifies, setNotifies] = React.useState<RoutineNotify[]>([]);
  // The job's two-way choices, and which side each branched row is on. Same
  // split as groups: the checklist stays flat and the structure is redrawn.
  const [branches, setBranches] = React.useState<RoutineBranch[]>([]);
  const [branchOf, setBranchOf] = React.useState<BranchOf>({});
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
        toast.info("Routine stopped.");
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
      // THE BATCH'S default, not the single run's (R18). Sixty ticked tests
      // used to open sixty windows, each stealing focus as it launched, because
      // a batch row inherited the toggle that exists for watching ONE run.
      defaultRunHeadless: settingsQuery.data?.defaultBatchHeadless,
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
    setPolicies(rows.policies);
    setGroups(rows.groups);
    setGroupOf(rows.groupOf);
    setWaits(rows.waits);
    setNotifies(rows.notifies);
    setBranches(rows.branches);
    setBranchOf(rows.branchOf);
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
  /**
   * The freshest version of the open Routine this view knows about.
   *
   * `openRoutine` is the QUERY's answer, and invalidation is asynchronous — so
   * between a save going out and its round trip landing, the query still holds
   * the pre-edit record. Anything that reads the Routine to decide what to do
   * next has to look here instead, or it decides against a version that is one
   * edit behind.
   */
  const freshestRoutine = React.useCallback(
    (): Routine | null =>
      (inFlight.current > 0 ? pending.current : null) ??
      (qc.getQueryData<Routine[]>(["routines"]) ?? []).find((r) => r.id === openId) ??
      openRoutine,
    [qc, openId, openRoutine],
  );

  const saveRoutine = React.useCallback(
    (patch: Partial<Routine>) => {
      if (!openId) return;
      const base = freshestRoutine();
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
  const newRoutine = React.useCallback(async () => {
    try {
      // `createRoutine` is shared with the rail's `+`: "make a new job" spelled
      // twice is how one of them starts producing Routines the other cannot
      // open — a different id scheme, a different name, different defaults.
      const created = await createRoutine(
        routines,
        settingsQuery.data,
        Date.now(),
        randomSuffix(),
      );
      await qc.invalidateQueries({ queryKey: ["routines"] });
      if (created) setOpenId(created.id);
    } catch {
      toast.error("Could not create a routine.");
    }
  }, [routines, settingsQuery.data, qc, setOpenId]);

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
    (
      nextOrder: string[],
      nextRows: RowOptionsMap,
      nextPolicies: PolicyMap = policies,
      nextGroups: RoutineGroup[] = groups,
      nextGroupOf: GroupOf = groupOf,
      nextWaits: RoutineWait[] = waits,
      nextNotifies: RoutineNotify[] = notifies,
      nextBranches: RoutineBranch[] = branches,
      nextBranchOf: BranchOf = branchOf,
    ) => {
      setOrder(nextOrder);
      setRowOptions(nextRows);
      setPolicies(nextPolicies);
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
      const steps = stepsFromRows(
        nextOrder,
        nextRows,
        tests,
        rowDefaults,
        nextPolicies,
        nextGroups,
        nextGroupOf,
        nextWaits,
        nextNotifies,
        nextBranches,
        nextBranchOf,
      );
      // PRUNED TO WHAT IS ACTUALLY IN THE JOB, and set as state rather than
      // left to the next re-seed. `stepsFromRows` already drops the policy of
      // an unticked row on the way out, so without this the two disagree:
      // untick a "stop on fail" row and tick it again before the Routine query
      // comes back, and the screen shows the policy while the stored job has
      // no such step — and `sameSteps` then reads the pair as unchanged and
      // writes nothing, so the divergence persists rather than settling.
      const flat = steps.flatMap((st) =>
        st.kind === "group" ? st.steps : st.kind === "test" ? [st] : [],
      );
      setPolicies(Object.fromEntries(flat.map((st) => [st.testId, st.onFailure])));
      // Pinned back to the row each one follows, so a wait survives the
      // round-trip through the checklist's flat order. Read off the STORED
      // steps rather than kept from before the save, for the reason the
      // policies are: what came back is what the store actually kept.
      setWaits(
        steps.flatMap((st, i) =>
          st.kind === "wait"
            ? [{ id: st.id, ms: st.ms, after: lastTestIdBefore(steps, i) }]
            : [],
        ),
      );
      setNotifies(
        steps.flatMap((st, i) =>
          st.kind === "notify"
            ? [
                {
                  id: st.id,
                  channel: st.channel,
                  message: st.message,
                  after: lastTestIdBefore(steps, i),
                },
              ]
            : [],
        ),
      );
      setBranches(
        steps.flatMap((st, i) =>
          st.kind === "branch"
            ? [{ id: st.id, on: st.on, after: lastTestIdBefore(steps, i) }]
            : [],
        ),
      );
      setBranchOf(
        Object.fromEntries(
          steps.flatMap((st) =>
            st.kind === "branch"
              ? [
                  ...st.then.map((c) => [c.testId, { id: st.id, side: "then" as const }] as const),
                  ...st.else.map((c) => [c.testId, { id: st.id, side: "else" as const }] as const),
                ]
              : [],
          ),
        ),
      );
      setGroupOf(
        Object.fromEntries(
          steps.flatMap((st) =>
            st.kind === "group" ? st.steps.map((c) => [c.testId, st.id] as const) : [],
          ),
        ),
      );
      // The groups themselves come off the STEPS, like every list above, rather
      // than by filtering what was already in state. Same rule the store uses —
      // a group with no members cannot be saved, so keeping it here would show
      // a header that vanishes on the next reload — but stated once, in the one
      // shape all five lists take. Filtering `prev` also could not contain a
      // group just created, and leaned on the Routine query re-seeding to put
      // its header on screen; deriving does not need that to have happened.
      setGroups(
        steps.flatMap((st) => (st.kind === "group" ? [{ id: st.id, label: st.label }] : [])),
      );
      if (!openRoutine) return;
      // Compared against the FRESHEST record, not against `openRoutine`. The
      // query's answer is one edit behind while a save is in flight, so an edit
      // that returns the job to the shape the cache still holds read as
      // "unchanged" and was dropped — add a pause and immediately remove it,
      // and the pause stayed. The write below already patches onto the freshest
      // base; this guard has to ask the same question of the same record, or it
      // vetoes writes that `saveRoutine` would have made correctly.
      const current = freshestRoutine();
      if (current && sameSteps(steps, current.steps)) return;
      saveRoutine({ steps });
    },
    [
      tests,
      rowDefaults,
      openRoutine,
      saveRoutine,
      freshestRoutine,
      policies,
      groups,
      groupOf,
      waits,
      notifies,
      branches,
      branchOf,
    ],
  );

  /** Flip one row's failure policy. Only ever reached from a ticked row — the
   *  control does not render on one that is not in the job, because a policy
   *  about a step that does not exist has nothing to say. */
  const togglePolicy = React.useCallback(
    (testId: string) =>
      persist(order, rowOptions, {
        ...policies,
        [testId]: nextPolicy(policies[testId], Boolean(groupOf[testId])),
      }),
    [order, rowOptions, policies, groupOf, persist],
  );

  /** Put a row in a group, or take it out. `groupId === ""` means top level.
   *
   *  Creating one is the SAME gesture as joining one — a group with no members
   *  cannot be saved (the store drops it), so an "add group" button that made
   *  an empty one would make a header that disappeared on the next read.
   *
   *  Joining a group takes the row OFF any branch it was on. A row can be in a
   *  group or on one side of a branch and never both; `stepsFromRows` already
   *  enforces that, but enforcing it only there would mean a row left in both
   *  shows one structure on screen and is saved into the other — the
   *  screen/disk divergence this view has already produced twice. */
  const assignGroup = React.useCallback(
    (testId: string, groupId: string, label?: string) => {
      const nextGroupOf = { ...groupOf };
      if (groupId) nextGroupOf[testId] = groupId;
      else delete nextGroupOf[testId];
      const nextGroups =
        groupId && !groups.some((g) => g.id === groupId)
          ? [...groups, { id: groupId, label: label ?? "Group" }]
          : groups;
      const nextBranchOf = { ...branchOf };
      if (groupId) delete nextBranchOf[testId];
      // A row leaving a group takes its `skipGroup` with it: outside a group
      // that policy has nothing to skip, so leaving it set would show a policy
      // the run cannot honour. `continue` is what it degrades to anyway.
      const nextPolicies =
        !groupId && policies[testId] === "skipGroup"
          ? { ...policies, [testId]: "continue" as const }
          : policies;
      persist(
        order,
        rowOptions,
        nextPolicies,
        nextGroups,
        nextGroupOf,
        waits,
        notifies,
        branches,
        nextBranchOf,
      );
    },
    [order, rowOptions, policies, groups, groupOf, waits, notifies, branches, branchOf, persist],
  );

  /** Add a pause after this row, or take the one that is there away.
   *
   *  A TOGGLE rather than an "add" that stacks. Two pauses in a row is
   *  expressible in the store and means nothing a single longer one does not,
   *  so the row's control is "is there a wait here", which is a question with
   *  an answer on screen. */
  const toggleWait = React.useCallback(
    (afterId: string) => {
      const existing = waits.find((w) => w.after === afterId);
      persist(
        order,
        rowOptions,
        policies,
        groups,
        groupOf,
        existing
          ? waits.filter((w) => w.id !== existing.id)
          : [...waits, { id: `w-${randomSuffix()}`, ms: DEFAULT_WAIT_MS, after: afterId }],
      );
    },
    [order, rowOptions, policies, groups, groupOf, waits, persist],
  );

  const setWaitMs = React.useCallback(
    (id: string, ms: number) =>
      persist(
        order,
        rowOptions,
        policies,
        groups,
        groupOf,
        waits.map((w) => (w.id === id ? { ...w, ms } : w)),
      ),
    [order, rowOptions, policies, groups, groupOf, waits, persist],
  );

  /** Add a message after this row, or take the one that is there away. Same
   *  toggle shape as the pause, and for the same reason: "is there a message
   *  here" is a question with an answer on screen. A new one starts on the
   *  DESKTOP channel — the local one — so adding a step never sends anything
   *  off the machine until the user says so. */
  const toggleNotify = React.useCallback(
    (afterId: string) => {
      const existing = notifies.find((n) => n.after === afterId);
      persist(
        order,
        rowOptions,
        policies,
        groups,
        groupOf,
        waits,
        existing
          ? notifies.filter((n) => n.id !== existing.id)
          : [
              ...notifies,
              {
                id: `n-${randomSuffix()}`,
                channel: "desktop" as const,
                message: DEFAULT_MESSAGE,
                after: afterId,
              },
            ],
      );
    },
    [order, rowOptions, policies, groups, groupOf, waits, notifies, persist],
  );

  const setNotify = React.useCallback(
    (id: string, patch: Partial<Pick<RoutineNotify, "channel" | "message">>) =>
      persist(
        order,
        rowOptions,
        policies,
        groups,
        groupOf,
        waits,
        notifies.map((n) => (n.id === id ? { ...n, ...patch } : n)),
      ),
    [order, rowOptions, policies, groups, groupOf, waits, notifies, persist],
  );

  /** Put a row on one side of a branch, or take it out.
   *
   *  Creating and joining are the same gesture, like a group's — the store
   *  drops a branch with nothing on either side, so an "add branch" button
   *  would make a header that vanished on the next read.
   *
   *  It does NOT have to clear the row's group, where `assignGroup` above has
   *  to clear its branch. The asymmetry is `stepsFromRows`: a branch claims a
   *  row before a group can, so joining one already takes the row out of any
   *  group, and `persist` re-derives `groupOf` from the steps it emitted. The
   *  other direction has no such backstop — the branch would win, and clicking
   *  "New group…" on a branched row would do nothing at all. */
  const assignBranch = React.useCallback(
    (testId: string, branchId: string, side: "then" | "else") => {
      const nextBranchOf = { ...branchOf };
      if (branchId) nextBranchOf[testId] = { id: branchId, side };
      else delete nextBranchOf[testId];
      const nextBranches =
        branchId && !branches.some((b) => b.id === branchId)
          ? [...branches, { id: branchId, on: "anyFailed" as const, after: "" }]
          : branches;
      // Same reasoning as leaving a group: `skipGroup` outside a group has
      // nothing to skip, and a branch side is not a group. This one is NOT
      // redundant — the policy is read from `policies`, which nothing else
      // reconciles, so it would show a control the run cannot honour.
      const nextPolicies =
        branchId && policies[testId] === "skipGroup"
          ? { ...policies, [testId]: "continue" as const }
          : policies;
      persist(
        order,
        rowOptions,
        nextPolicies,
        groups,
        groupOf,
        waits,
        notifies,
        nextBranches,
        nextBranchOf,
      );
    },
    [order, rowOptions, policies, groups, groupOf, waits, notifies, branches, branchOf, persist],
  );

  /** Flip a branch's condition. Two values, so a toggle rather than a menu. */
  const flipBranch = React.useCallback(
    (branchId: string) =>
      persist(
        order,
        rowOptions,
        policies,
        groups,
        groupOf,
        waits,
        notifies,
        branches.map((b) =>
          b.id === branchId
            ? { ...b, on: b.on === "anyFailed" ? ("allPassed" as const) : ("anyFailed" as const) }
            : b,
        ),
        branchOf,
      ),
    [order, rowOptions, policies, groups, groupOf, waits, notifies, branches, branchOf, persist],
  );

  const renameGroup = React.useCallback(
    (groupId: string, label: string) =>
      persist(
        order,
        rowOptions,
        policies,
        groups.map((g) => (g.id === groupId ? { ...g, label } : g)),
        groupOf,
      ),
    [order, rowOptions, policies, groups, groupOf, persist],
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

  // What the checklist's master tick draws, over the VISIBLE tests — see
  // `selectionState`. "Is everything selected?" was previously a question the
  // user answered by scanning rows; the box answers it.
  const masterState = React.useMemo(
    () => selectionState(rowOptions, visibleTests, rowDefaults),
    [rowOptions, visibleTests, rowDefaults],
  );

  /** The visible label, and the STEM of the accessible name below it.
   *
   *  The name has to CONTAIN the visible text — a speech-input user says what
   *  they can see, and a control whose name shares no words with its label is
   *  one they cannot reach (WCAG 2.5.3). The two buttons this replaced got that
   *  for free, since their name WAS their text; building the name separately is
   *  what put them at risk of drifting apart, so they are built from one stem. */
  const masterText = tagFilter === ALL_TAGS ? "Select all" : "Select all shown";

  /** WHICH SET the master tick acts on, spelled out for the tooltip and the
   *  accessible name.
   *
   *  STABLE — it does not flip to "Deselect" once everything is ticked, the way
   *  the two buttons' labels did. A checkbox's name says what it is; its
   *  CHECKED STATE says what a click will do, and a name that changed under the
   *  user would be announced as a different control each time. The count is
   *  deliberately absent from the visible label too: the toolbar already reads
   *  "N of M selected" over the whole library, and a second count over the
   *  visible subset would read as that one contradicting itself. */
  const masterLabel = `${masterText}: ${visibleTests.length} ${
    visibleTests.length === 1 ? "test" : "tests"
  }`;

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
      if (res.alreadyRunning) toast.info("A routine is already running.");
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
      toast.error(err instanceof Error ? err.message : "Failed to start the routine.");
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
                  void newRoutine();
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

        {openRoutine ? (
          <SchedulePicker
            schedule={openRoutine.schedule}
            disabled={running}
            onChange={(schedule) => saveRoutine({ schedule })}
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
              aria-label="Run every test in this routine headless"
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
              aria-label="Capture screenshots during this routine"
            />
            Capture screenshots
          </label>
        </div>

        {running ? (
          <Btn tone="stop" className="gl-batch-run" onClick={() => void api.batch.stop()}>
            <Square aria-hidden="true" />
            Stop
          </Btn>
        ) : (
          // The floor is on both this and Stop, not just here: the label
          // carries the selection count and Stop replaces the button outright,
          // so without it the toolbar's width tracked whatever was ticked.
          <Btn
            tone="go"
            className="gl-batch-run"
            onClick={requestBatch}
            disabled={selectedIds.length === 0}
          >
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
                    // Reaches INSIDE groups, and drops a group left empty by
                    // the removal — the store would refuse to keep one anyway,
                    // so leaving it here would show a header that disappears on
                    // the next read.
                    steps: (openRoutine?.steps ?? [])
                      .map((step) =>
                        step.kind === "group"
                          ? {
                              ...step,
                              steps: step.steps.filter(
                                (c) => !broken.some((b) => b.testId === c.testId),
                              ),
                            }
                          : step,
                      )
                      .filter((step) =>
                        step.kind === "group"
                          ? step.steps.length > 0
                          : step.kind !== "test" ||
                            !broken.some((b) => b.testId === step.testId),
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
                {/* ONE CONTROL WHERE SELECT ALL AND SELECT NONE WERE TWO
                    BUTTONS (#74). A tri-state box reports the answer as well as
                    changing it, which two buttons could not: neither of them
                    ever said whether everything was already ticked.

                    IT ACTS ON THE VISIBLE TESTS, and the label says which set
                    those are. Ticking the visible subset rather than replacing
                    the whole selection is what stops "select all" under a tag
                    filter from silently unticking everything hidden — the
                    property the two buttons had and the one a rewrite is most
                    likely to lose. */}
                <label className="gl-batch-master" title={masterLabel}>
                  <Checkbox
                    className="gl-batch-master-box"
                    checked={
                      masterState === "all"
                        ? true
                        : masterState === "some"
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={() =>
                      commitRows(
                        setSelection(
                          rowOptions,
                          visibleTests,
                          rowDefaults,
                          masterState !== "all",
                        ),
                      )
                    }
                    disabled={running || visibleTests.length === 0}
                    aria-label={masterLabel}
                  />
                  {masterText}
                </label>
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
                {visibleTests.map((t, visibleIndex) => {
                  // A GROUP HEADER IS DRAWN BEFORE ITS FIRST VISIBLE MEMBER,
                  // rather than being a row in `order`. The checklist stays a
                  // flat ordered list — which is what lets drag-to-reorder stay
                  // exactly what it was — and the nesting is redrawn from
                  // `groupOf`, the same way `stepsFromRows` rebuilds it.
                  //
                  // Keyed on the PREVIOUS VISIBLE row, not the previous row in
                  // `order`: under a tag filter the visible rows are a
                  // subsequence, and asking `order` would draw the header above
                  // a member that is filtered out — or omit it entirely.
                  const branchMember = branchOf[t.id];
                  const branch = branchMember
                    ? branches.find((b) => b.id === branchMember.id)
                    : undefined;
                  // A header per SIDE, drawn above that side's first visible
                  // row — the same rule the group header follows, applied twice
                  // because a branch has two runs of rows rather than one.
                  const prevBranch = visibleTests[visibleIndex - 1]
                    ? branchOf[visibleTests[visibleIndex - 1].id]
                    : undefined;
                  // Which sides this branch actually HAS. A branch keeps
                  // existing with rows on only one side — the store drops it
                  // only when both are empty — and the two headers say
                  // different things in that case. See the render below.
                  const sidesOf = (id: string) => {
                    const members = Object.values(branchOf).filter((m) => m.id === id);
                    return {
                      then: members.some((m) => m.side === "then"),
                      else: members.some((m) => m.side === "else"),
                    };
                  };
                  const branchHead =
                    branch &&
                    branchMember &&
                    (!prevBranch ||
                      prevBranch.id !== branchMember.id ||
                      prevBranch.side !== branchMember.side)
                      ? { branch, side: branchMember.side, sides: sidesOf(branchMember.id) }
                      : undefined;
                  const groupId = groupOf[t.id];
                  const prev = visibleTests[visibleIndex - 1];
                  const groupHead =
                    groupId && (!prev || groupOf[prev.id] !== groupId)
                      ? groups.find((g) => g.id === groupId)
                      : undefined;
                  const waitAfter = waits.find((w) => w.after === t.id);
                  const notifyAfter = notifies.find((n) => n.after === t.id);
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
                    <React.Fragment key={t.id}>
                    {branchHead ? (
                      <div className="gl-batch-branch" data-testid="routine-branch">
                        <GitBranch aria-hidden="true" />
                        {/* THE CONDITION GOES ON WHICHEVER HEADER COMES FIRST.
                            Normally that is the "then" side and the second
                            header is a plain "Otherwise". But a branch survives
                            with rows on ONE side only — take the last row off
                            the "then" side and the store keeps the branch — and
                            an "Otherwise" alone is a header that names a side
                            without naming what it is otherwise TO, with the
                            condition then unreachable: no control on screen
                            flips it back. So a lone "else" header carries the
                            condition, read NEGATED, because negated is literally
                            what runs. */}
                        {branchHead.side === "then" || !branchHead.sides.then ? (
                          <button
                            type="button"
                            className="gl-batch-branch-cond"
                            disabled={running}
                            aria-label={`Condition for the branch before ${t.name}`}
                            title="Click to flip the condition"
                            onClick={() => flipBranch(branchHead.branch.id)}
                          >
                            {(branchHead.branch.on === "anyFailed") ===
                            (branchHead.side === "then")
                              ? "If anything failed"
                              : "If everything passed"}
                          </button>
                        ) : (
                          <span className="gl-batch-branch-cond" data-otherwise="">
                            Otherwise
                          </span>
                        )}
                        {/* SAID OUT LOUD, because it is the one thing about a
                            branch that surprises people: both sides are queued
                            and one is always skipped, so the run count above is
                            a maximum rather than a promise. With one side there
                            is no other side to run, and saying there is would
                            be the wrong surprise. */}
                        <span className="gl-batch-wait-note">
                          {branchHead.sides.then && branchHead.sides.else
                            ? "only one side runs"
                            : "otherwise nothing runs"}
                        </span>
                      </div>
                    ) : null}
                    {groupHead ? (
                      <div className="gl-batch-group" data-testid="routine-group">
                        <input
                          className="gl-batch-group-name"
                          aria-label={`Name of group ${groupHead.label}`}
                          defaultValue={groupHead.label}
                          disabled={running}
                          // COMMITTED ON BLUR, not per keystroke: a Routine's
                          // `updatedAt` is what the rail sorts by, and writing
                          // on every character would re-date the job eleven
                          // times for one rename. `defaultValue` because the
                          // seed re-runs on every save and a controlled value
                          // would fight the caret.
                          onBlur={(e) => {
                            const next = e.target.value.trim();
                            if (next !== "" && next !== groupHead.label) {
                              renameGroup(groupHead.id, next);
                            } else {
                              e.target.value = groupHead.label;
                            }
                          }}
                        />
                        <span className="gl-batch-group-count">
                          {Object.values(groupOf).filter((g) => g === groupHead.id).length} in group
                        </span>
                      </div>
                    ) : null}
                    <div
                      onDragEnter={running ? undefined : () => setOverId(t.id)}
                      onDragOver={running ? undefined : (e) => e.preventDefault()}
                      onDrop={running ? undefined : (e) => e.preventDefault()}
                      className="gl-batch-row"
                      data-grouped={groupId || branchMember ? "" : undefined}
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
                      {/* WHAT STRUCTURE THIS STEP IS PART OF — one menu, because
                          it is one question. A row can be in a group or on one
                          side of a branch and never both; `stepsFromRows`
                          already enforces that, so offering two controls was
                          asking one question twice and cost a cell the row did
                          not have. Second time this phase; the lesson stuck.

                          Creating and joining are the SAME gesture for both: the
                          store drops an empty group and an empty branch, so an
                          "add" button would make a header that disappeared on
                          the next read.

                          A MENU RATHER THAN DRAG-INTO-CONTAINER. The checklist
                          is a flat ordered list and its drag handle reorders it;
                          teaching that same gesture to also mean "put inside"
                          would make the two indistinguishable at the moment of
                          the drop, which is the moment it matters. */}
                      {row.selected ? (
                        // A MARK, NOT THE GROUP'S NAME. The name is already on
                        // the header this row is indented under, and repeating
                        // it here cost more width than the row had: with a
                        // name-width cell the status chip fell off the end of
                        // every row. Same trade the grip makes — a small
                        // affordance whose accessible name does the talking.
                        <Menu
                          value={
                            branchMember
                              ? branchMember.side === "then"
                                ? "◄"
                                : "►"
                              : groupOf[t.id]
                                ? "▣"
                                : "·"
                          }
                          label={`Structure for ${t.name}`}
                          width={24}
                          disabled={running}
                          className="gl-batch-groupmark"
                        >
                          {(close) => [
                            <MenuItem
                              key="none"
                              label="On its own"
                              selected={!groupOf[t.id] && !branchMember}
                              onSelect={() => {
                                if (branchMember) assignBranch(t.id, "", "then");
                                else assignGroup(t.id, "");
                                close();
                              }}
                            />,
                            ...groups.map((g) => (
                              <MenuItem
                                key={g.id}
                                label={g.label}
                                selected={groupOf[t.id] === g.id}
                                onSelect={() => {
                                  assignGroup(t.id, g.id);
                                  close();
                                }}
                              />
                            )),
                            <MenuItem
                              key="new"
                              label="New group…"
                              onSelect={() => {
                                assignGroup(
                                  t.id,
                                  `g-${randomSuffix()}`,
                                  `Group ${groups.length + 1}`,
                                );
                                close();
                              }}
                            />,
                            ...branches.flatMap((b) =>
                              (["then", "else"] as const).map((side) => (
                                <MenuItem
                                  key={`${b.id}-${side}`}
                                  label={
                                    side === "then" ? "Branch: if matched" : "Branch: otherwise"
                                  }
                                  selected={branchMember?.id === b.id && branchMember.side === side}
                                  onSelect={() => {
                                    assignBranch(t.id, b.id, side);
                                    close();
                                  }}
                                />
                              )),
                            ),
                            <MenuItem
                              key="new-branch"
                              label="New branch…"
                              onSelect={() => {
                                assignBranch(t.id, `b-${randomSuffix()}`, "then");
                                close();
                              }}
                            />,
                          ]}
                        </Menu>
                      ) : (
                        <span className="gl-batch-group-gap" aria-hidden="true" />
                      )}
                      {/* WHAT HAPPENS AFTER THIS ROW. Only on a row that is in
                          the job: a pause after a step that does not run is a
                          join with nothing on one side of it.

                          ONE CONTROL, TWO ANSWERS. A pause and a message are
                          the same kind of thing — a step that is not a run,
                          inserted after this row — so "what happens after this
                          step" is one question and deserves one cell. It was
                          two, and the row overflowed: this checklist has taken
                          four new cells across capability 3, and the honest
                          response to running out of width is to stop asking two
                          questions where there is one. A menu rather than a
                          cycle, because both answers can be true at once. */}
                      {row.selected ? (
                        <Menu
                          value={waitAfter || notifyAfter ? "▸" : "·"}
                          label={`After ${t.name}`}
                          width={24}
                          disabled={running}
                          className="gl-batch-aftermark"
                        >
                          {(close) => [
                            <MenuItem
                              key="wait"
                              label="Pause here"
                              selected={Boolean(waitAfter)}
                              onSelect={() => {
                                toggleWait(t.id);
                                close();
                              }}
                            />,
                            <MenuItem
                              key="notify"
                              label="Say something"
                              selected={Boolean(notifyAfter)}
                              onSelect={() => {
                                toggleNotify(t.id);
                                close();
                              }}
                            />,
                          ]}
                        </Menu>
                      ) : (
                        <span className="gl-batch-waitmark-gap" aria-hidden="true" />
                      )}
                      {/* WHAT THIS STEP'S FAILURE DOES TO THE REST OF THE JOB.
                          docs/ROUTINES.md: "continue" must stay the default or
                          migrating the old Batch changes its behaviour
                          silently, and "stopRoutine" is what makes a setup step
                          mean anything — seed the data, and if that fails, do
                          not go on to test against data that is not there.

                          ONLY ON A ROW THAT IS IN THE JOB. An unticked row is
                          not a step, and a policy about a step that does not
                          exist has nothing to say. This is also what keeps the
                          row from gaining a ninth cell on the forty rows that
                          are only in the list so they can be added.

                          AMBER, on the same terms `Headed` above claims it: the
                          palette rule is that colour means OUTCOME, and this is
                          the second setting allowed to break it because it
                          changes what happens to OTHER work. Scanning a routine
                          for where it can abort is worth a hue; the default
                          carries none. */}
                      {row.selected ? (
                        <button
                          type="button"
                          aria-pressed={(policies[t.id] ?? "continue") !== "continue"}
                          disabled={running}
                          aria-label={`What happens if ${t.name} fails`}
                          title={
                            policies[t.id] === "stopRoutine"
                              ? "If this fails, the rest of the routine does not run"
                              : policies[t.id] === "skipGroup"
                                ? "If this fails, the rest of this group does not run"
                                : "If this fails, the routine carries on"
                          }
                          onClick={() => togglePolicy(t.id)}
                          className="gl-batch-policy"
                          style={
                            (policies[t.id] ?? "continue") !== "continue"
                              ? toneSurface(TONE.amber)
                              : undefined
                          }
                        >
                          {POLICY_LABELS[policies[t.id] ?? "continue"]}
                        </button>
                      ) : (
                        // A SPACER, not nothing. Omitting the cell entirely
                        // slides every column after it — engines, headless,
                        // duration — left by the width of the control, so the
                        // checklist's columns jump between ticked and unticked
                        // rows and the list stops reading as a table. Found by
                        // looking at it; no test on this screen could have.
                        <span className="gl-batch-policy-gap" aria-hidden="true" />
                      )}
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
                    {/* THE PAUSE, drawn BETWEEN rows because that is what it is:
                        a join in the job, not a step with an outcome. Giving it
                        a row's furniture — a checkbox, engines, a status chip —
                        would promise a result it can never have. */}
                    {notifyAfter ? (
                      <div className="gl-batch-wait" data-testid="routine-notify">
                        <Bell aria-hidden="true" />
                        <input
                          className="gl-batch-message"
                          // DISTINCT from the toggle's label. Two controls with
                          // the same accessible name is a screen reader reading
                          // the same thing twice with no way to tell them apart
                          // — and the reason the first version of the test
                          // reported "found multiple elements".
                          aria-label={`Text of the message after ${t.name}`}
                          defaultValue={notifyAfter.message}
                          maxLength={MAX_ROUTINE_MESSAGE}
                          disabled={running}
                          // Committed on blur, like the group name and for the
                          // same reason: `updatedAt` is what the rail sorts by,
                          // and writing per keystroke re-dates the job once per
                          // character.
                          onBlur={(e) => {
                            const next = e.target.value.trim();
                            if (next !== "" && next !== notifyAfter.message) {
                              setNotify(notifyAfter.id, { message: next });
                            } else {
                              e.target.value = notifyAfter.message;
                            }
                          }}
                        />
                        <Menu
                          value={notifyAfter.channel === "webhook" ? "Webhook" : "Desktop"}
                          label={`Where the message after ${t.name} goes`}
                          width={110}
                          disabled={running}
                        >
                          {(close) =>
                            (["desktop", "webhook"] as const).map((c) => (
                              <MenuItem
                                key={c}
                                label={c === "webhook" ? "Webhook" : "Desktop"}
                                selected={c === notifyAfter.channel}
                                onSelect={() => {
                                  setNotify(notifyAfter.id, { channel: c });
                                  close();
                                }}
                              />
                            ))
                          }
                        </Menu>
                        {/* SAID OUT LOUD, because this is the one control on
                            this screen that sends data off the machine. The
                            webhook is configured in Settings and the step is
                            inert until it is — the same promise the run and
                            batch alerts make, stated where the choice is. */}
                        <span className="gl-batch-wait-note">
                          {notifyAfter.channel === "webhook"
                            ? "leaves this machine"
                            : "stays on this machine"}
                        </span>
                        <button
                          type="button"
                          className="gl-batch-wait-remove"
                          disabled={running}
                          aria-label={`Remove the message after ${t.name}`}
                          onClick={() => toggleNotify(t.id)}
                        >
                          Remove
                        </button>
                      </div>
                    ) : null}
                    {waitAfter ? (
                      <div className="gl-batch-wait" data-testid="routine-wait">
                        <Timer aria-hidden="true" />
                        <Menu
                          value={fmtWait(waitAfter.ms)}
                          label={`Length of the pause after ${t.name}`}
                          width={90}
                          disabled={running}
                        >
                          {(close) =>
                            WAIT_CHOICES.map((ms) => (
                              <MenuItem
                                key={ms}
                                label={fmtWait(ms)}
                                selected={ms === waitAfter.ms}
                                onSelect={() => {
                                  setWaitMs(waitAfter.id, ms);
                                  close();
                                }}
                              />
                            ))
                          }
                        </Menu>
                        <span className="gl-batch-wait-note">
                          everything above finishes first
                        </span>
                        <button
                          type="button"
                          className="gl-batch-wait-remove"
                          disabled={running}
                          aria-label={`Remove the pause after ${t.name}`}
                          onClick={() => toggleWait(t.id)}
                        >
                          Remove
                        </button>
                      </div>
                    ) : null}
                    </React.Fragment>
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
                  {pendingProposals > 0 ? (
                    // The routine's runs may have minted cross-test proposals
                    // (a heal on one test proposing the same fix for its
                    // siblings). One line and one door — review itself lives
                    // in the Heals view, beside the evidence; this editor
                    // grows no review UI (docs/plans/preemptive-updates.md).
                    <p className="gl-note">
                      {pendingProposals} suggested update{pendingProposals === 1 ? "" : "s"} for
                      other tests {pendingProposals === 1 ? "waits" : "wait"} on review —{" "}
                      <button
                        type="button"
                        className="gl-linklike"
                        onClick={() => navigate({ to: "/heals" })}
                      >
                        review them
                      </button>
                      .
                    </p>
                  ) : null}
                </Panel>
              ) : null}

              {history.length > 0 ? (
                <Panel
                  title="Previous runs"
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
                              ? "Cleared 1 run."
                              : `Cleared ${res.removed} runs.`,
                          );
                        } catch (err) {
                          toast.error(
                            err instanceof Error ? err.message : "Failed to clear the run history.",
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
          `This routine runs ${pendingHeadedRun ?? 0} tests in parallel with visible browsers, so ` +
          `${pendingHeadedRun ?? 0} windows will open together and take focus as they launch — ` +
          "the machine will be hard to use until the routine finishes. Tick Headless to run the " +
          "same routine invisibly, or lower “At once”."
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
