// Global recorder + runner state, fed by backend push events. Live recording
// steps and run output are ephemeral streams, so they live here rather than in
// React Query (which owns persisted test data).

import * as React from "react";

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@ui";

import { api, type SuggestionsPayload } from "../lib/api";
import {
  applyAgentEvent,
  reduceAgentEvents,
  type AgentEventRecord,
  type AgentRunView,
} from "../lib/agent-run";
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
  FlowScopePayload,
  RecorderState,
  ReplayLogEvent,
  RunBrowser,
  TestSpeed,
  Step,
  VariableKind,
  VerifiedStepsResult,
} from "../lib/recorder-types";

export type RunStepStatus = "running" | "passed" | "failed";

/** The per-step map as a run LEAVES it: nothing is still `running`.
 *
 *  A step's status comes from a `begin`/`end` pair the reporter writes, and the
 *  `end` is not guaranteed to arrive. Stop sends SIGKILL, so the reporter is
 *  dead before it can close the step it opened; a browser crash or a
 *  process-timeout kill ends the same way. Without this the row kept its
 *  spinner after the run had finished — cyan rail, `Loader2` turning, no red on
 *  the description — and the AI debug prompt (which reads the earliest `failed`
 *  index) had no failing step to point at.
 *
 *  The exit code decides the settled value. Non-zero: the open step is the one
 *  that was under way when the run died, which is the failing step. Zero: the
 *  run passed, so whatever it was doing passed with it — marking it failed
 *  would put a red row under a green verdict. Steps that never began stay
 *  absent; they did not run, and an unmarked row is how that is shown. */
export function settleStepStatus(
  stepStatus: Record<number, RunStepStatus>,
  code: number,
): Record<number, RunStepStatus> {
  let settled: Record<number, RunStepStatus> | null = null;
  for (const [key, status] of Object.entries(stepStatus)) {
    if (status !== "running") continue;
    if (!settled) settled = { ...stepStatus };
    settled[Number(key)] = code === 0 ? "passed" : "failed";
  }
  return settled ?? stepStatus;
}

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
  /** The 1-based spec line each reported step index last ran from — what
   *  the Script IDE paints run status on. Absent for a run that reported
   *  nothing yet. */
  stepLines?: Record<number, number>;
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
  /** Extract a contiguous run of session steps into a new flow test,
   *  replacing them with a runFlow call. Rejects with a showable message. */
  extractFlow: (stepIds: string[], name: string) => Promise<void>;
  /** The open inline-flow scope's working copy of the flow's steps, or null.
   *  Fed by the `recorder:flowScope` push — never by `recorder:steps`, whose
   *  payload stays the session's own list. */
  flowScope: FlowScopePayload | null;
  /** Open a runFlow row's flow for inline editing. Rejects with a showable
   *  message (deleted flow, self-call). */
  enterFlowScope: (stepId: string) => Promise<void>;
  /** Commit and close the open scope; toasts what happened. */
  exitFlowScope: () => Promise<void>;
  /** Move the insert cursor within the open scope. */
  setFlowCursor: (index: number) => void;
  /** Run a batch of AI-proposed steps against the live page, inserting each
   *  only once it has worked (grouped under `label`, the prompt), and mark what
   *  landed as new so the step list can glow it. Separate from `insertStep`
   *  because only this path produces steps the user did not write themselves
   *  — and the only path that VERIFIES before inserting. Resolves with what
   *  happened to each step; the dialog renders that as its activity log. */
  verifyGeneratedSteps: (steps: RawStep[], label: string) => Promise<VerifiedStepsResult>;
  /** The trainer agent's run as this window sees it, or null before any run.
   *  `agentRun?.running` is a controls gate on both trainers — while the
   *  agent drives the page, every other mutation waits. */
  agentRun: AgentRunView | null;
  /** Start a run toward a typed goal. The service refuses (with a showable
   *  reason) over a live run or without a session. */
  startAgent: (goal: string) => Promise<{ ok: boolean; runId?: string; reason?: string }>;
  /** Queue a mid-run message — drained between steps, never mid-flight. */
  sayToAgent: (text: string) => Promise<boolean>;
  stopAgent: () => Promise<boolean>;
  /** Resolve an assertion-proposal card. Accepting TRIES the assertion on
   *  the live page through the same gate as everything else. */
  resolveAgentProposal: (id: string, accept: boolean) => Promise<{ ok: boolean; detail?: string }>;
  /** The AI suggestion strip's standing offers — empty when the setting is
   *  off, no session is live, or nothing is on offer. Label and id only:
   *  the raw step never crosses into the renderer. */
  aiSuggestions: SuggestionsPayload["suggestions"];
  /** Take a suggestion. The step is TRIED on the live page through the same
   *  verify gate as everything else and inserted only on success; a failure
   *  is toasted here so both trainers get it for free. */
  acceptSuggestion: (id: string) => Promise<void>;
  dismissSuggestion: (id: string) => void;
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
  /** `speed` paces THIS run only and is never written back to the test — see
   *  `playwrightRunner.start`. */
  run: (
    id: string,
    captureArtifacts?: boolean,
    headless?: boolean,
    browser?: RunBrowser,
    speed?: TestSpeed,
  ) => void;
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
  // The trainer agent's run, reduced from `agent:event` pushes — see
  // lib/agent-run.ts for why a reducer, and the effect below for the seed a
  // late-opening window needs.
  const [agentRun, setAgentRun] = React.useState<AgentRunView | null>(null);
  // The suggestion strip's offers, replaced WHOLESALE by every
  // `suggest:changed` push — the main-process service owns membership and
  // staleness; this is a mirror, never a merge.
  const [aiSuggestions, setAiSuggestions] = React.useState<SuggestionsPayload["suggestions"]>([]);
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
  const [flowScope, setFlowScope] = React.useState<FlowScopePayload | null>(null);
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
    const offState = api.on<RecorderState>("recorder:state", (s) => {
      setState(s);
      // The state is the authority on WHETHER a scope is open; the flowScope
      // push carries its contents. A discard tears the session down without a
      // dedicated scope push, so the null here is what closes the expansion.
      if (!s.flowScope) setFlowScope(null);
    });
    // The backend now owns step ordering (insert/reorder/edit), so it broadcasts
    // the whole list after every change and we replace our copy.
    const offSteps = api.on<Step[]>("recorder:steps", (steps) => receiveSteps(steps ?? []));
    // The inline-flow scope's working copy, whole, on its own channel — see
    // the backend's broadcastFlowScope for why it never rides recorder:steps.
    const offFlowScope = api.on<FlowScopePayload | null>("recorder:flowScope", (scope) =>
      setFlowScope(scope ?? null),
    );
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
    const offSignature = api.on<{
      host: string;
      reason: "expired" | "unreadable" | "other-host";
      /** `other-host` only: what IS registered, so the toast can name it. */
      registered?: string[];
    }>("recorder:signatureNotSent", ({ host, reason, registered }) => {
      if (reason === "expired") {
        toast.warning(
          `The Shopify crawler signature for ${host} has expired, so it wasn't sent. Create a new one in your Shopify admin — signatures last three months and can't be renewed.`,
        );
        return;
      }
      if (reason === "unreadable") {
        toast.warning(
          `A Shopify crawler signature is registered for ${host} but couldn't be read on this Mac, so it wasn't sent.`,
        );
        return;
      }
      // The wrong-domain case, worded like the run's own line: a signature
      // covers one authority, so naming what IS registered is the whole
      // message — the user is one edit away from a working recording, and
      // without the list they cannot see which edit.
      toast.warning(
        `No Shopify crawler signature for ${host}. One is registered for ${(registered ?? []).join(", ")} — a signature is bound to one domain and can't be used for another.`,
      );
    });
    // A standing overlay rule taught from the training browser's context menu.
    // Surfaced because the action has NO visible result in the step list — it
    // deliberately records no step — so without this the user cannot tell a
    // saved rule from a misclick.
    const offOverlayRule = api.on<{ ok: boolean; message: string }>(
      "recorder:overlayRuleSaved",
      ({ ok, message }) => {
        if (ok) toast.success(message);
        else toast.warning(message);
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
      line?: number;
    }>("runner:step", ({ runId, index, status, ok, line }) => {
      setRuns((prev) => {
        const cur = prev[runId] ?? { lines: [], running: true, code: null, stepStatus: {}, startedAt: Date.now() };
        const stepStatus = { ...cur.stepStatus };
        if (status === "begin") {
          stepStatus[index] = "running";
        } else {
          stepStatus[index] = ok ? "passed" : "failed";
        }
        const stepLines =
          typeof line === "number" && line > 0 ? { ...(cur.stepLines ?? {}), [index]: line } : cur.stepLines;
        return { ...prev, [runId]: { ...cur, stepStatus, ...(stepLines ? { stepLines } : {}) } };
      });
    });
    const offDone = api.on<{ runId: string; code: number; recordId?: string }>(
      "runner:done",
      ({ runId, code, recordId }) => {
        setRuns((prev) => {
          const cur = prev[runId] ?? { lines: [], running: false, code, stepStatus: {}, startedAt: Date.now() };
          return {
            ...prev,
            [runId]: {
              ...cur,
              running: false,
              code,
              recordId,
              finishedAt: Date.now(),
              stepStatus: settleStepStatus(cur.stepStatus, code),
            },
          };
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

    // The trainer agent's event stream, applied incrementally; the ask seeds
    // a window that opened mid-run (the recorder:getSteps argument again —
    // the run's earlier pushes reached windows that existed then). The
    // reducer's seq guard makes the overlap between the snapshot and a push
    // that raced it harmless.
    const offAgent = api.on<AgentEventRecord>("agent:event", (record) => {
      setAgentRun((prev) => applyAgentEvent(prev, record));
    });
    // Through a resolved promise (the composer's countMatches pattern), so a
    // bridge that lacks the call degrades to "no run" rather than crashing
    // the provider every view in the window hangs off.
    void Promise.resolve()
      .then(() => api.agent.getRun())
      .then((snap) => {
        if (snap?.runId) {
          setAgentRun((prev) => (prev ? prev : reduceAgentEvents(snap.events)));
        }
      })
      .catch(() => {});

    // The suggestion strip: pushes replace the offers wholesale, and the ask
    // seeds a window that opened while offers were standing. Same resolved-
    // promise hardening as the agent seed — a bridge without the call means
    // "no offers", not a crashed provider.
    const offSuggest = api.on<SuggestionsPayload>("suggest:changed", (payload) => {
      setAiSuggestions(payload?.suggestions ?? []);
    });
    void Promise.resolve()
      .then(() => api.suggest.get())
      .then((payload) => {
        const seeded = payload?.suggestions ?? [];
        if (seeded.length > 0) setAiSuggestions((prev) => (prev.length > 0 ? prev : seeded));
      })
      .catch(() => {});

    return () => {
      offSuggest();
      offAgent();
      offState();
      offSteps();
      offFlowScope();
      offPicked();
      offCaptured();
      offCtx();
      offBlocked();
      offSignature();
      offOverlayRule();
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

  const extractFlow = React.useCallback(
    async (stepIds: string[], name: string) => {
      clearNewSteps();
      // Awaited so the caller can surface the backend's refusal (a taken name,
      // a selection the service re-validates) in the dialog it came from.
      await api.recorder.extractFlow(stepIds, name);
    },
    [clearNewSteps],
  );

  const enterFlowScope = React.useCallback(async (stepId: string) => {
    try {
      await api.recorder.enterFlowScope(stepId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);
  const exitFlowScope = React.useCallback(async () => {
    try {
      const result = await api.recorder.exitFlowScope();
      if (!result) return;
      if (result.orphaned) {
        toast.error(`“${result.name}” was deleted while you edited it — the edits were dropped.`);
      } else if (result.committed) {
        toast.success(
          `Flow “${result.name}” updated — used by ${result.callers} test${result.callers === 1 ? "" : "s"}.` +
            (result.conflict
              ? " It had also been edited elsewhere; this session's version won."
              : ""),
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);
  const setFlowCursor = React.useCallback((index: number) => {
    void api.recorder.setFlowCursor(index);
  }, []);

  const verifyGeneratedSteps = React.useCallback(
    async (steps: RawStep[], label: string) => {
      const before = liveStepsRef.current;
      // One IPC call: the backend runs the steps in order against the live
      // page and inserts each as it works, so ordering is its problem and not
      // a race between invokes here.
      const outcome = await api.recorder.verifySteps(steps, label);
      // Re-read rather than waiting for the `recorder:steps` push. The push
      // and the invoke reply are different channels with no ordering guarantee
      // between them, and the diff needs the settled list — if it ran a beat
      // early it would mark only the first of the inserted steps.
      const after = await api.recorder.getSteps().catch(() => null);
      if (after) {
        receiveSteps(after);
        // What actually landed — a failed step and everything after it did
        // not, and normalization can drop one the model produced — so this
        // diffs the list instead of assuming all of `steps` did.
        setNewStepIds(computeNewStepIds(before, after));
      }
      return outcome;
    },
    [receiveSteps],
  );
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
  const run = React.useCallback((id: string, captureArtifacts?: boolean, headless?: boolean, browser?: RunBrowser, speed?: TestSpeed) => {
    // The run is the natural end of the "look what the AI changed" moment:
    // whatever glows now gets judged by the run's result instead.
    clearNewSteps();
    setRunEpoch((n) => n + 1);
    setRuns((prev) => ({
      ...prev,
      [id]: { lines: [], running: true, code: null, stepStatus: {}, startedAt: Date.now() },
    }));
    // headed = not headless — the trainer path is unaffected (separate channel).
    api.runner.run(id, !headless, captureArtifacts, headless, browser, speed).catch(() => {});
  }, [clearNewSteps]);
  const stopRun = React.useCallback((id: string) => void api.runner.stop(id), []);

  // The agent's actions are thin: the SERVICE owns validity (a start over a
  // live run, a say with no run), and its answer carries the reason — the
  // command box shows it rather than re-deriving the rules here.
  const startAgent = React.useCallback((goal: string) => api.agent.start(goal), []);
  const sayToAgent = React.useCallback((text: string) => api.agent.say(text), []);
  const stopAgent = React.useCallback(() => api.agent.stop(), []);
  const resolveAgentProposal = React.useCallback(
    (id: string, accept: boolean) => api.agent.resolveProposal(id, accept),
    [],
  );

  // A session ending strands whatever offers were showing — the page they
  // describe is gone, and the service only clears its own copy on the next
  // capture. Mirror-side cleanup, so the next session never opens on chips
  // from the last one.
  const recording = state.recording;
  React.useEffect(() => {
    if (!recording) setAiSuggestions([]);
  }, [recording]);

  const acceptSuggestion = React.useCallback(async (id: string) => {
    const result = await api.suggest
      .accept(id)
      .catch(() => ({ ok: false, detail: undefined as string | undefined }));
    // Only the failure is toasted: success shows itself as the inserted step.
    if (!result.ok) {
      toast.error(
        result.detail
          ? `That suggestion didn't work: ${result.detail}`
          : "That suggestion didn't work on the live page.",
      );
    }
  }, []);
  const dismissSuggestion = React.useCallback((id: string) => {
    // Optimistic: a dismissed chip must not linger under the click while the
    // round-trip settles; the confirming push replaces the list anyway.
    setAiSuggestions((prev) => prev.filter((s) => s.id !== id));
    void api.suggest.dismiss(id).catch(() => {});
  }, []);

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
    extractFlow,
    flowScope,
    enterFlowScope,
    exitFlowScope,
    setFlowCursor,
    verifyGeneratedSteps,
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
    agentRun,
    startAgent,
    sayToAgent,
    stopAgent,
    resolveAgentProposal,
    aiSuggestions,
    acceptSuggestion,
    dismissSuggestion,
  };

  return <RecorderContext.Provider value={value}>{children}</RecorderContext.Provider>;
}
