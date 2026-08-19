// Global recorder + runner state, fed by backend push events. Live recording
// steps and run output are ephemeral streams, so they live here rather than in
// React Query (which owns persisted test data).

import * as React from "react";

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@ui";

import { api } from "../lib/api";
import { newStepIds as computeNewStepIds } from "../lib/diff-steps";
import { invalidateRunDerived } from "../lib/run-derived-cache";
import type {
  DebugCaptureSession,
  AssertKind,
  BatchState,
  ContextAction,
  DebugEntry,
  DebugLogLine,
  HealSuggestion,
  Locator,
  PickedElement,
  RawStep,
  RecorderState,
  ReplayLogEvent,
  RunBrowser,
  Step,
  VariableKind,
} from "../lib/recorder-types";

export type RunStepStatus = "running" | "passed" | "failed";

/** How long a replayed step's pass/fail outline stays on its row.
 *
 *  Deliberately the same 2500ms as the per-row replay tint in step-row.tsx, so
 *  the outline and the background clear together — two ephemeral highlights on
 *  one row expiring a beat apart reads as a rendering glitch. */
export const REPLAY_FLASH_MS = 2500;

/** One step's result within a live "Replay from current step" run. */
export interface ReplayConsoleStep {
  index: number;
  stepLabel: string;
  ok: boolean;
  error?: string;
  logs: DebugLogLine[];
  /** Auto-Heal result for this step, if the engine ran. */
  heal?: HealSuggestion;
}

/** Live state of a "Replay from current step" run, driven by recorder:replayLog. */
export interface ReplayRun {
  running: boolean;
  startIndex: number;
  total: number;
  ran: number;
  passed: number;
  failedAtIndex: number;
  steps: ReplayConsoleStep[];
  startedAt: number;
  finishedAt: number | null;
  error?: string;
}

export interface RunInfo {
  lines: string[];
  running: boolean;
  code: number | null;
  /** Per-step run status, keyed by step index (0-based). */
  stepStatus: Record<number, RunStepStatus>;
  /** Artifact id for this execution, once it finishes. Distinct from the map
   *  key, which is the TEST id — every run of a test shares that. */
  recordId?: string;
  /** When this execution STARTED. Identifies the run from the first moment,
   *  where recordId only arrives at the end — so anything keyed on "which run
   *  is this" is stable for the whole run instead of changing under it. */
  startedAt: number;
  /** When it ENDED. Undefined while running.
   *
   *  Added for §6.8's ticker, which holds a failure in the strip for a few
   *  seconds after the fact. Measuring that hold from `startedAt` expires a run
   *  that took longer than the window before it has even finished — which kills
   *  the one notice the ticker exists to give, a long run that failed while the
   *  user was on another screen. */
  finishedAt?: number;
}

const EMPTY_STATE: RecorderState = {
  recording: false,
  paused: false,
  assertMode: null,
  stepCount: 0,
  testId: null,
  url: null,
  liveUrl: null,
  name: null,
  editing: false,
  assertSoft: false,
  cursor: 0,
  refineMode: false,
  replaying: false,
  pageReady: false,
  loading: false,
};

interface RecorderContextValue {
  state: RecorderState;
  liveSteps: Step[];
  /** True once THIS window holds the session's step list.
   *
   *  `recorder:steps` is a push whose first fire happens inside `recorder:start`,
   *  so a window created later in the session (the docked panel) never sees it.
   *  Controls must stay inert until the list is actually here — acting on a step
   *  list you have not received yet edits the wrong position, or nothing. */
  stepsLoaded: boolean;
  /** Ids of steps the AI just added to the list (Generate Steps), so the step
   *  rows can glow. Empty for steps the user added by hand: they know what they
   *  just typed, and highlighting it would be noise. */
  newStepIds: Set<string>;
  /**
   * The id of the step that most recently ARRIVED in the list, whatever put it
   * there — a click captured in the training browser, an Add step, an AI batch.
   *
   * Distinct from `newStepIds`, which is a claim about PROVENANCE ("the AI put
   * this here") and holds until the list changes again. This is a claim about
   * RECENCY, and it exists because of where a captured step lands: the insert
   * cursor sits where the browser is, so continuing an existing test writes new
   * steps into the MIDDLE of the list while both trainers auto-scroll to the
   * bottom. The row that changed was off-screen and unhighlighted, which is
   * indistinguishable from the trainer having recorded nothing at all.
   *
   * Null until a step actually arrives — the initial list of a session is not
   * "steps being added", it is the test showing up, and pointing at its last
   * row would be a lie on every session open.
   */
  lastAddedStepId: string | null;
  runs: Record<string, RunInfo>;
  /** The batch running right now, or null. NOT "the batch being displayed" —
   *  see the state's own note. Owned here so every screen can see it, which is
   *  what §6.8's ticker needs and what `batch-view` alone could not give. */
  liveBatch: BatchState | null;
  /**
   * Which Routine the Batch screen has open. docs/ROUTINES.md, REDESIGN §7.1.
   *
   * HERE RATHER THAN IN THE VIEW because the RAIL selects it and the VIEW edits
   * it — two components with no parent between them but `RootShell`. Routing it
   * through the router was the other option and is worse: this app's router
   * uses memory history, so a path cannot select anything (see CLAUDE.md), and
   * a search param would put a Routine id in a URL nobody can see or share.
   *
   * SESSION-SCOPED, deliberately not persisted. "Reopen on the job you were
   * editing" is a real nicety, but it is a settings field with its own
   * normalizer and its own failure mode (a stored id for a deleted Routine),
   * and it is not what this slice is about. Absent means "not chosen yet", and
   * the view falls back to the first Routine.
   */
  openRoutineId: string | null;
  setOpenRoutineId: (id: string | null) => void;
  /** `viewport` is the New Recording dialog's window-size preset; omitted (or
   *  null) keeps the trainer's default window size. Ignored when `testId` names
   *  an existing test — that session opens at the size the test recorded. */
  start: (
    url: string,
    name: string,
    testId?: string,
    viewport?: { width: number; height: number } | null,
    runBrowser?: RunBrowser,
  ) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  /** Close the training window without saving (discard steps). */
  discardExit: () => void;
  setAssert: (mode: AssertKind | null, soft?: boolean) => void;
  deleteStep: (id: string) => void;
  insertStep: (step: RawStep, index?: number) => void;
  /** Insert a batch of AI-generated steps and mark what landed as new, so the
   *  step list can glow it. Separate from `insertStep` because only this path
   *  produces steps the user did not write themselves. */
  insertGeneratedSteps: (steps: RawStep[]) => Promise<void>;
  reorderStep: (id: string, toIndex: number) => void;
  updateStep: (id: string, patch: Partial<Step>) => void;
  /** Declare a variable on the live session, so a step composed here can
   *  reference it. Rejects with a message meant to be shown to the user — the
   *  backend owns the rules, and the form that called this prints what it says.
   *  Resolves once the new declaration is in `state.variables`. */
  addVariable: (v: { name: string; kind: VariableKind; value?: string }) => Promise<void>;
  /** Apply a user-chosen Auto-Heal candidate locator to a step. */
  applyHeal: (stepId: string, locator: Locator) => void;
  setCursor: (index: number) => void;
  replayStep: (id: string) => Promise<DebugEntry>;
  replayFromStart: () => Promise<{
    ok: boolean;
    stoppedAtIndex: number;
    error?: string;
  }>;
  /** Replay every step in order (auto-run on Edit in Trainer), highlighting each. */
  replayAll: () => Promise<{ ok: boolean; failedAtIndex: number; error?: string }>;
  /** Replay slowly from `startIndex` through the end, streaming each step's
   *  output live to the debug panel's Console tab. */
  replayFromCurrent: (startIndex: number) => Promise<{
    ok: boolean;
    ranCount: number;
    passedCount: number;
    failedAtIndex: number;
    error?: string;
  }>;
  /** Live state of the most recent "Replay from current step" run (or null). */
  replayRun: ReplayRun | null;
  /** True while ANY replay is executing (single step, from-current, etc.) — the
   *  trainer shows "Running" and locks step editing while this is true. */
  executing: boolean;
  /** Per-step status for an in-flight replay, keyed by step index. */
  replayStepStatus: Record<number, RunStepStatus>;
  /** Ephemeral pass/fail outline for a step that JUST finished replaying, keyed
   *  by step index. Distinct from `replayStepStatus`, which persists until the
   *  next run so the finished run stays readable: this is the flash that says
   *  "this one, just now" and clears itself a couple of seconds later. */
  replayFlash: Record<number, "pass" | "fail">;
  /** Persisted per-step debug entries (latest attempt per step), for the debug panel. */
  debugEntries: DebugEntry[];
  /** Remove one step's debug entry (persists via backend). */
  clearDebugEntry: (id: string) => void;
  picked: PickedElement | null;
  /** id of the step currently being refined (Refine Selector), or null */
  refiningStepId: string | null;
  startRefine: (stepId?: string | null) => void;
  endRefine: () => void;
  clearPicked: () => void;
  /** The most recent right-click test-tools action from the training browser
   *  (assertion/wait/refine/add-step), with the picked element + prefills.
   *  The trainer opens the Add-step dialog from this; null when idle. */
  contextAction: ContextAction | null;
  clearContextAction: () => void;
  run: (id: string, captureArtifacts?: boolean, headless?: boolean, browser?: RunBrowser) => void;
  stopRun: (id: string) => void;
  /** Counts calls to `run`. The "the AI added these" glow lasts until the next
   *  test run, not on a timer — views holding their own new-step sets watch
   *  this to clear them the moment a run starts. */
  runEpoch: number;
}

const RecorderContext = React.createContext<RecorderContextValue | null>(null);

export function useRecorder(): RecorderContextValue {
  const ctx = React.useContext(RecorderContext);
  if (!ctx) throw new Error("useRecorder must be used within RecorderProvider");
  return ctx;
}

/**
 * What to do when a recording finishes.
 *
 * Injected rather than done here, because the provider now mounts in TWO
 * windows: the main window, which navigates to the finished test and
 * invalidates its queries, and the trainer panel, which has no router to
 * navigate and no test list to invalidate. Calling `useNavigate` in the
 * provider would throw outright in the panel — a router hook is not optional at
 * runtime just because the value is unused.
 */
export type OnRecordingFinished = (testId: string) => void;

export function RecorderProvider({
  children,
  onFinished,
}: {
  children: React.ReactNode;
  onFinished?: OnRecordingFinished;
}) {
  const [state, setState] = React.useState<RecorderState>(EMPTY_STATE);
  const [liveSteps, setLiveSteps] = React.useState<Step[]>([]);
  const [stepsLoaded, setStepsLoaded] = React.useState(false);
  const [newStepIds, setNewStepIds] = React.useState<Set<string>>(() => new Set());
  const [lastAddedStepId, setLastAddedStepId] = React.useState<string | null>(null);
  // The list as the LAST push left it, for spotting what arrived in the next
  // one. Its own ref rather than `liveStepsRef` below: that one is written
  // during render, so two pushes landing between renders would both diff
  // against the same stale list and the second arrival would go unnoticed.
  // `null` means "no list yet this session", which is not the same as `[]`.
  const prevStepsRef = React.useRef<Step[] | null>(null);
  /** Record a freshly received list and point at whatever is new in it. */
  const receiveSteps = React.useCallback((next: Step[]) => {
    const prev = prevStepsRef.current;
    prevStepsRef.current = next;
    setLiveSteps(next);
    setStepsLoaded(true);
    if (!prev) return;
    // Ids are the right key HERE (unlike diff-steps, which cannot use them):
    // these lists come from one session's own in-memory steps, where an id is
    // minted once and never re-parsed.
    const had = new Set(prev.map((s) => s.id));
    const added = next.filter((s) => !had.has(s.id));
    if (added.length > 0) setLastAddedStepId(added[added.length - 1].id);
  }, []);
  const [runEpoch, setRunEpoch] = React.useState(0);
  // Mirror of liveSteps for the callbacks below. They are created once (empty
  // dep arrays, so the trainer's props don't rebuild on every captured step),
  // which means reading `liveSteps` from their closure would read the list as
  // it was when the provider first rendered — i.e. empty.
  const liveStepsRef = React.useRef<Step[]>([]);
  liveStepsRef.current = liveSteps;
  const [picked, setPicked] = React.useState<PickedElement | null>(null);
  const [refiningStepId, setRefiningStepId] = React.useState<string | null>(null);
  const [contextAction, setContextAction] = React.useState<ContextAction | null>(null);
  const [debugEntries, setDebugEntries] = React.useState<DebugEntry[]>([]);
  const [runs, setRuns] = React.useState<Record<string, RunInfo>>({});
  // THE LIVE BATCH, OWNED HERE FOR THE SAME REASON `runs:changed` IS. Batch
  // progress arrived only on `batch:progress`, and the only subscriber was
  // `batch-view` — a ROUTE component. On any other screen nothing was
  // listening, so a batch you started and walked away from was invisible from
  // everywhere except the one page you had left.
  //
  // Distinct from the batch VIEW's own `batch` state, which is "the record I am
  // displaying" and can be a historical one the user picked out of the list.
  // Those are two different questions that happened to share a variable; this
  // is only ever "what is running now".
  const [liveBatch, setLiveBatch] = React.useState<BatchState | null>(null);
  // See the interface: the rail selects it, the Batch view edits it.
  const [openRoutineId, setOpenRoutineId] = React.useState<string | null>(null);
  // Per-step status for an in-flight trainer replayAll (auto-run on Edit in
  // Trainer), keyed by step index. Cleared when a new run starts.
  const [replayStepStatus, setReplayStepStatus] = React.useState<Record<number, RunStepStatus>>({});
  // Ephemeral pass/fail outline, keyed by step index. Every entry owns a timer
  // that removes it; the timers are held so they can be cancelled, because a
  // step replayed twice in quick succession would otherwise have the FIRST
  // run's timer clear the second run's flash early.
  const [replayFlash, setReplayFlash] = React.useState<Record<number, "pass" | "fail">>({});
  const flashTimers = React.useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  React.useEffect(() => {
    const timers = flashTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);
  // Live "Replay from current step" run, streamed from the backend.
  const [replayRun, setReplayRun] = React.useState<ReplayRun | null>(null);
  // True while any replay (single step / from-current) is in flight — drives
  // the "Running" status and locks step editing.
  const [executing, setExecuting] = React.useState(false);
  // Held in a ref so a caller passing an inline arrow doesn't retear down and
  // re-subscribe every push listener on each render.
  const finishedRef = React.useRef(onFinished);
  finishedRef.current = onFinished;
  // Both windows that mount this provider (main and trainer) have their own
  // QueryClientProvider, so this is safe in either — the trainer's client is a
  // separate cache, which is fine: the caches it invalidates are read in the
  // window that owns them.
  const qc = useQueryClient();

  React.useEffect(() => {
    const offState = api.on<RecorderState>("recorder:state", (s) => setState(s));
    // The backend now owns step ordering (insert/reorder/edit), so it broadcasts
    // the whole list after every change and we replace our copy.
    const offSteps = api.on<Step[]>("recorder:steps", (steps) => receiveSteps(steps ?? []));
    const offPicked = api.on<PickedElement>("recorder:picked", (p) => setPicked(p));
    // The debug-screenshot shortcut fires with no visible effect otherwise —
    // you press a key and nothing happens, which is indistinguishable from the
    // shortcut not being registered at all. (It once WASN'T, and this is how
    // that presented.) The toast names the windows so you know it caught the
    // one you meant.
    const offCaptured = api.on<DebugCaptureSession>("debug:captured", (session) => {
      if (session.error) toast.error(session.error);
      else {
        const names = session.shots.map((s) => s.window).join(", ");
        toast.success(
          `Screenshot saved — ${session.shots.length} ${session.shots.length === 1 ? "window" : "windows"}: ${names}`,
        );
      }
    });
    // Right-click test-tools menu in the training browser: the backend resolves
    // the element under the cursor and pushes the chosen action; the trainer
    // opens the Add-step dialog prefilled from it.
    const offCtx = api.on<ContextAction>("recorder:contextAction", (a) => setContextAction(a));
    // A navigation that tried to leave the training window. Surfaced rather
    // than logged quietly: when this protection fails the damage happens in
    // ANOTHER application, where the app can neither see nor undo it — so the
    // one time it engages, the user should know it did.
    const offBlocked = api.on<{ url: string; reason: string }>(
      "recorder:navigationBlocked",
      ({ url, reason }) => {
        toast.warning(
          `Kept inside the training window: ${url || "a navigation"} (${reason})`,
        );
      },
    );
    // A Shopify crawler signature that is registered for the host being
    // recorded but was NOT sent. Surfaced now rather than left to the run,
    // because this recording will be throttled or blocked for its whole life —
    // and knowing that at step one is what makes it worth abandoning.
    const offSignature = api.on<{ host: string; reason: "expired" | "unreadable" }>(
      "recorder:signatureNotSent",
      ({ host, reason }) => {
        toast.warning(
          reason === "expired"
            ? `The Shopify crawler signature for ${host} has expired, so it wasn't sent. Create a new one in your Shopify admin — signatures last three months and can't be renewed.`
            : `A Shopify crawler signature is registered for ${host} but couldn't be read on this Mac, so it wasn't sent.`,
        );
      },
    );
    const offFinished = api.on<{ testId: string }>("recorder:finished", ({ testId }) => {
      setLiveSteps([]);
      setStepsLoaded(false);
      prevStepsRef.current = null;
      setLastAddedStepId(null);
      finishedRef.current?.(testId);
    });
    const offOut = api.on<{ runId: string; chunk: string }>("runner:output", ({ runId, chunk }) => {
      setRuns((prev) => {
        const cur = prev[runId] ?? { lines: [], running: true, code: null, stepStatus: {}, startedAt: Date.now() };
        return { ...prev, [runId]: { ...cur, lines: [...cur.lines, chunk] } };
      });
    });
    const offStep = api.on<{
      runId: string;
      index: number;
      status: "begin" | "end";
      ok: boolean;
    }>("runner:step", ({ runId, index, status, ok }) => {
      setRuns((prev) => {
        const cur = prev[runId] ?? { lines: [], running: true, code: null, stepStatus: {}, startedAt: Date.now() };
        const stepStatus = { ...cur.stepStatus };
        if (status === "begin") {
          stepStatus[index] = "running";
        } else {
          stepStatus[index] = ok ? "passed" : "failed";
        }
        return { ...prev, [runId]: { ...cur, stepStatus } };
      });
    });
    const offDone = api.on<{ runId: string; code: number; recordId?: string }>(
      "runner:done",
      ({ runId, code, recordId }) => {
        setRuns((prev) => {
          const cur = prev[runId] ?? { lines: [], running: false, code, stepStatus: {}, startedAt: Date.now() };
          return { ...prev, [runId]: { ...cur, running: false, code, recordId, finishedAt: Date.now() } };
        });
      },
    );
    // The run history changed on disk — a run persisted, or history was
    // deleted. The backend has broadcast this since run history existed, but
    // the only subscribers were StatsView and VisualView, both of which are
    // ROUTE components: on any other route nothing was listening, so the
    // shared ["runs"] cache kept serving the list from whenever it was last
    // fetched. That is the sidebar's stale status dot — a failing test re-run
    // until it passed stayed red until the window was reopened, while the run
    // panel one pane over showed the pass. Subscribing here puts it on the
    // provider that is mounted for the whole session instead.
    //
    // THE SAME ARGUMENT APPLIES TO THE OTHER FIVE CACHES A RUN WRITES, and for
    // a long time it was only made for `["runs"]` — so Stability, Auto-Heal and
    // Visual went stale exactly as the status dot used to. `run-derived-cache`
    // now names all six in one place; see its header for what belongs there.
    const offRunsChanged = api.on("runs:changed", () => {
      invalidateRunDerived(qc);
    });
    // An AI debug attempt started or settled. NOT in RUN_DERIVED_KEYS: nothing
    // a run does writes this file — the AI debug store does, on its own
    // schedule — so it goes stale on its own event. It is subscribed HERE for
    // the same reason everything above it is: the reader is somebody standing
    // on the Stats board while a minimized job finishes, which is precisely
    // when a route-level subscription would be unmounted.
    const offAiDebugHistory = api.on("aiDebug:historyChanged", () => {
      void qc.invalidateQueries({ queryKey: ["ai-debug-history"] });
    });
    // A failure reason was created, renamed or disabled — in the Settings
    // window, which is why it cannot be a route-level subscription here: the
    // reader is whatever run label or Stats breakdown is on screen in THIS
    // window when the rename happens. NOT in RUN_DERIVED_KEYS: nothing a run
    // does writes the definitions; assignments live on run records and ride
    // `runs:changed` above.
    const offFailureReasons = api.on("failureReasons:changed", () => {
      void qc.invalidateQueries({ queryKey: ["failure-reasons"] });
    });
    // An insights report was generated, read, or deleted — or a generation
    // started or failed. NOT in RUN_DERIVED_KEYS: the insights service writes
    // its own store on its own schedule, nothing a run does touches it. It is
    // subscribed HERE and not in the Insights view because the reader that
    // matters is the rail's unread dot, which renders on EVERY route — a
    // view-level subscription is the "refresh this if the user happens to be
    // looking" bug run-derived-cache.ts documents.
    const offInsights = api.on("insights:changed", () => {
      void qc.invalidateQueries({ queryKey: ["insight-reports"] });
      void qc.invalidateQueries({ queryKey: ["insight-report"] });
      void qc.invalidateQueries({ queryKey: ["insights-status"] });
    });
    // A batch already running when this window opened. `batch:progress` fires
    // on every test transition so it would self-seed within seconds, but "the
    // ticker is blank until the next test finishes" is a blank ticker during
    // exactly the long test somebody wanted to know about.
    void api.batch
      .status()
      .then((s) => setLiveBatch(s ?? null))
      .catch(() => {});
    const offBatchProgress = api.on("batch:progress", (payload) => {
      setLiveBatch(payload as BatchState);
    });
    const offBatchDone = api.on("batch:done", (payload) => {
      setLiveBatch(payload as BatchState);
      // Every member wrote its own RunRecord, so history and the sidebar's
      // status dots are stale. This used to live in `batch-view`, where it only
      // fired if you happened to be looking at it — the same shape of bug as
      // the one `runs:changed` above was moved here to fix.
      //
      // Each member also pushed its own `runs:changed`, so the six derived
      // caches are already handled above. Repeating them here is deliberate
      // belt-and-braces: `batch:done` is the one event that fires when a
      // ROUTINE finishes on a schedule, and a batch that ends without a final
      // member push (stopped, or blocked before its first test) would otherwise
      // leave the board describing the run before it.
      invalidateRunDerived(qc);
      // Not run-derived: the batch index is its own store, written once per
      // batch rather than once per run.
      void qc.invalidateQueries({ queryKey: ["batch-history"] });
    });
    const offDebug = api.on<{ testId: string; entries: DebugEntry[] }>(
      "recorder:debugLogs",
      ({ entries }) => setDebugEntries(entries ?? []),
    );
    const offReplayStep = api.on<{
      index: number;
      status: "begin" | "end";
      ok: boolean;
    }>("recorder:replayStep", ({ index, status, ok }) => {
      setReplayStepStatus((prev) => ({
        ...prev,
        [index]: status === "begin" ? "running" : ok ? "passed" : "failed",
      }));
      // The flash is keyed off "end" rather than the replay's start: a step can
      // legitimately take seconds (a conditional wait runs up to its timeout),
      // and a flash timed from the start would already be gone by the time the
      // step it describes actually finished.
      if (status === "begin") {
        const pending = flashTimers.current.get(index);
        if (pending) {
          clearTimeout(pending);
          flashTimers.current.delete(index);
        }
        setReplayFlash((prev) => {
          if (!(index in prev)) return prev;
          const next = { ...prev };
          delete next[index];
          return next;
        });
        return;
      }
      setReplayFlash((prev) => ({ ...prev, [index]: ok ? "pass" : "fail" }));
      const timer = setTimeout(() => {
        flashTimers.current.delete(index);
        setReplayFlash((prev) => {
          if (!(index in prev)) return prev;
          const next = { ...prev };
          delete next[index];
          return next;
        });
      }, REPLAY_FLASH_MS);
      flashTimers.current.set(index, timer);
    });
    // Live "Replay from current step" streaming: build the run model up as each
    // phase arrives so the Console tab can show output as the test runs.
    const offReplayLog = api.on<ReplayLogEvent>("recorder:replayLog", (ev) => {
      if (ev.phase === "start") {
        setReplayRun({
          running: true,
          startIndex: ev.startIndex,
          total: ev.total,
          ran: 0,
          passed: 0,
          failedAtIndex: -1,
          steps: [],
          startedAt: Date.now(),
          finishedAt: null,
        });
      } else if (ev.phase === "step") {
        setReplayRun((prev) =>
          prev
            ? {
                ...prev,
                ran: prev.ran + 1,
                passed: prev.passed + (ev.ok ? 1 : 0),
                steps: [
                  ...prev.steps,
                  {
                    index: ev.index,
                    stepLabel: ev.stepLabel,
                    ok: ev.ok,
                    error: ev.error,
                    logs: ev.logs,
                    heal: ev.heal,
                  },
                ],
              }
            : prev,
        );
      } else {
        setReplayRun((prev) =>
          prev
            ? {
                ...prev,
                running: false,
                ran: ev.ran,
                passed: ev.passed,
                failedAtIndex: ev.failedAtIndex,
                finishedAt: Date.now(),
                error: ev.error,
              }
            : prev,
        );
      }
    });

    api.recorder.getState().then(setState).catch(() => {});
    // Ask, rather than only listening. The initial `recorder:steps` push fires
    // during `recorder:start`; a window opened after that (the docked panel is
    // created once the page is ready) would otherwise show an empty step list
    // until the user happened to mutate something.
    api.recorder
      .getSteps()
      .then((steps) => receiveSteps(steps ?? []))
      .catch(() => {});

    return () => {
      offState();
      offSteps();
      offPicked();
      offCaptured();
      offCtx();
      offBlocked();
      offSignature();
      offFinished();
      offOut();
      offStep();
      offDone();
      offRunsChanged();
      offAiDebugHistory();
      offFailureReasons();
      offInsights();
      offBatchProgress();
      offBatchDone();
      offDebug();
      offReplayStep();
      offReplayLog();
    };
    // Subscribe once. `onFinished` is read through a ref precisely so it cannot
    // appear here — a changing callback would tear down and re-subscribe every
    // push listener, and a step captured during that gap is simply lost.
  }, []);

  // Load persisted debug logs whenever the active session's test changes, so
  // the panel shows prior replay diagnostics after reopening the trainer.
  React.useEffect(() => {
    if (!state.testId) {
      setDebugEntries([]);
      return;
    }
    api.recorder.getDebugLogs(state.testId).then(setDebugEntries).catch(() => {});
  }, [state.testId]);

  const start = React.useCallback(
    async (
      url: string,
      name: string,
      testId?: string,
      viewport?: { width: number; height: number } | null,
      runBrowser?: RunBrowser,
    ) => {
      setLiveSteps([]);
      // A new session's list has nothing to do with the last one's highlight.
      setNewStepIds(new Set());
      setLastAddedStepId(null);
      prevStepsRef.current = null;
      await api.recorder.start(url, name, testId, viewport, runBrowser);
    },
    [],
  );
  const pause = React.useCallback(() => void api.recorder.pause(), []);
  const resume = React.useCallback(() => void api.recorder.resume(), []);
  const stop = React.useCallback(() => void api.recorder.stop(), []);
  const discardExit = React.useCallback(() => void api.recorder.discardExit(), []);
  const setAssert = React.useCallback(
    (mode: AssertKind | null, soft = false) => void api.recorder.setAssert(mode, soft),
    [],
  );
  // Any hand mutation of the list retires the "the AI added these" highlight:
  // once the user is editing, the claim is no longer about a change made behind
  // their back, and the tracked ids may not even be in the list any more.
  const clearNewSteps = React.useCallback(() => {
    setNewStepIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  // These mutations are echoed back via the recorder:steps broadcast, so there's
  // no optimistic local update — the backend list is the source of truth.
  const deleteStep = React.useCallback(
    (id: string) => {
      clearNewSteps();
      void api.recorder.deleteStep(id);
    },
    [clearNewSteps],
  );
  const insertStep = React.useCallback(
    (step: RawStep, index?: number) => {
      clearNewSteps();
      void api.recorder.insertStep(step, index);
    },
    [clearNewSteps],
  );
  const reorderStep = React.useCallback(
    (id: string, toIndex: number) => {
      clearNewSteps();
      void api.recorder.reorderStep(id, toIndex);
    },
    [clearNewSteps],
  );
  const updateStep = React.useCallback(
    (id: string, patch: Partial<Step>) => {
      clearNewSteps();
      void api.recorder.updateStep(id, patch);
    },
    [clearNewSteps],
  );

  const insertGeneratedSteps = React.useCallback(async (steps: RawStep[]) => {
    const before = liveStepsRef.current;
    // Sequential, not `forEach`: each insert lands at the session cursor and
    // advances it, so firing them concurrently leaves the order up to whichever
    // IPC call the backend happens to service first.
    for (const step of steps) {
      await api.recorder.insertStep(step);
    }
    // Re-read rather than waiting for the `recorder:steps` push. The push and
    // the invoke reply are different channels with no ordering guarantee
    // between them, and the diff needs the settled list — if it ran a beat
    // early it would mark only the first of the inserted steps.
    const after = await api.recorder.getSteps().catch(() => null);
    if (!after) return;
    receiveSteps(after);
    // Normalization backend-side can drop a step the model produced, so this
    // diffs what actually landed instead of assuming all of `steps` did.
    setNewStepIds(computeNewStepIds(before, after));
  }, [receiveSteps]);
  const addVariable = React.useCallback(
    async (v: { name: string; kind: VariableKind; value?: string }) => {
      // The reply IS the new state, applied here rather than waiting for the
      // broadcast: the caller selects the variable it just created as soon as
      // this resolves, and a picker that does not yet list it would drop the
      // selection on the next render.
      setState(await api.recorder.addVariable(v));
    },
    [],
  );
  const applyHeal = React.useCallback(
    (stepId: string, locator: Locator) => void api.recorder.applyHeal(stepId, locator),
    [],
  );
  const setCursor = React.useCallback((index: number) => void api.recorder.setCursor(index), []);
  const replayStep = React.useCallback(async (id: string) => {
    setExecuting(true);
    try {
      const entry = await api.recorder.replayStep(id);
      // The backend pushes the full list via recorder:debugLogs, but update
      // locally too so the panel reacts before the push round-trips.
      setDebugEntries((prev) => {
        const next = prev.filter((e) => e.stepId !== entry.stepId);
        next.push(entry);
        return next;
      });
      return entry;
    } finally {
      setExecuting(false);
    }
  }, []);
  const replayFromStart = React.useCallback(async () => {
    setExecuting(true);
    try {
      const res = await api.recorder.replayFromStart();
      // The backend persists + pushes per-step entries during the run; refresh
      // from the store so the panel reflects every replayed step.
      if (state.testId) {
        api.recorder.getDebugLogs(state.testId).then(setDebugEntries).catch(() => {});
      }
      return res;
    } finally {
      setExecuting(false);
    }
  }, [state.testId]);
  const replayAll = React.useCallback(async () => {
    setExecuting(true);
    setReplayStepStatus({});
    try {
      const res = await api.recorder.replayAll();
      if (state.testId) {
        api.recorder.getDebugLogs(state.testId).then(setDebugEntries).catch(() => {});
      }
      return res;
    } finally {
      setExecuting(false);
    }
  }, [state.testId]);
  const replayFromCurrent = React.useCallback(async (startIndex: number) => {
    // Reset row highlighting for a fresh run; the live console is reset by the
    // backend's "start" replayLog event.
    setExecuting(true);
    setReplayStepStatus({});
    try {
      const res = await api.recorder.replayFromCurrent(startIndex);
      if (state.testId) {
        api.recorder.getDebugLogs(state.testId).then(setDebugEntries).catch(() => {});
      }
      return res;
    } finally {
      setExecuting(false);
    }
  }, [state.testId]);
  const clearDebugEntry = React.useCallback((id: string) => {
    api.recorder.clearDebugLog(id).then(setDebugEntries).catch(() => {});
  }, []);
  const startRefine = React.useCallback((stepId: string | null = null) => {
    setRefiningStepId(stepId);
    void api.recorder.startRefine();
  }, []);
  const endRefine = React.useCallback(() => {
    setRefiningStepId(null);
    void api.recorder.endRefine();
  }, []);
  const clearPicked = React.useCallback(() => setPicked(null), []);
  const run = React.useCallback((id: string, captureArtifacts?: boolean, headless?: boolean, browser?: RunBrowser) => {
    // The run is the natural end of the "look what the AI changed" moment:
    // whatever glows now gets judged by the run's result instead.
    clearNewSteps();
    setRunEpoch((n) => n + 1);
    setRuns((prev) => ({
      ...prev,
      [id]: { lines: [], running: true, code: null, stepStatus: {}, startedAt: Date.now() },
    }));
    // headed = not headless — the trainer path is unaffected (separate channel).
    api.runner.run(id, !headless, captureArtifacts, headless, browser).catch(() => {});
  }, [clearNewSteps]);
  const stopRun = React.useCallback((id: string) => void api.runner.stop(id), []);

  const value: RecorderContextValue = {
    state,
    liveSteps,
    stepsLoaded,
    newStepIds,
    lastAddedStepId,
    runs,
    liveBatch,
    openRoutineId,
    setOpenRoutineId,
    start,
    pause,
    resume,
    stop,
    setAssert,
    deleteStep,
    insertStep,
    insertGeneratedSteps,
    reorderStep,
    updateStep,
    addVariable,
    applyHeal,
    setCursor,
    replayStep,
    replayFromStart,
    replayAll,
    replayFromCurrent,
    replayRun,
    executing,
    replayStepStatus,
    replayFlash,
    debugEntries,
    clearDebugEntry,
    picked,
    refiningStepId,
    startRefine,
    endRefine,
    clearPicked,
    contextAction,
    clearContextAction: () => setContextAction(null),
    discardExit,
    run,
    stopRun,
    runEpoch,
  };

  return <RecorderContext.Provider value={value}>{children}</RecorderContext.Provider>;
}
