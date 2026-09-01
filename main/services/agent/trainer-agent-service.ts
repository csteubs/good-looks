// The trainer agent: drives the LIVE recording session toward a goal the
// user typed, one verified step at a time. mabl-style agency with this
// repo's own spine — the model PROPOSES, `tryStep` (the verify gate
// verifyAndInsertSteps loops over) DISPOSES, and nothing enters the step
// list that has not just worked against the real page.
//
// Dependency-injected like insights-service: `createTrainerAgentService` is
// pure against `TrainerAgentDeps`, the real bindings sit at the bottom, and
// the unit tests stub the lot — LLM, executor, probes — to pin the state
// machine, the retry budget, the mailbox and the proposal flow without a
// page or a model in the room.
//
// THE MAILBOX IS THE INTERRUPTION MODEL. `say()` never reaches mid-flight
// work: it queues, and the loop drains the queue between steps and before
// every planning turn — so a redirection lands before the next step, never
// inside one. `stop()` is the one exception: it flips a flag every stage
// checks, and the loop finishes at the next boundary.
//
// STATES. idle → (start) → planning → acting → … → done|stopped, with two
// waits: `recovering` is planning again with failure evidence in hand, and
// `awaiting-user` means the agent cannot proceed without the user (three
// straight failures, an LLM error, or a turn that proposed nothing) — the
// run stays alive, and a say() resumes it.

import { randomUUID } from "node:crypto";

import type { RawStep, Step } from "../../recorder/types.js";
import type { LlmMessage } from "../llm/types.js";
import type { TryStepOutcome } from "../recorder-service.js";
import type { PageSummary } from "./page-summary.js";
import {
  AGENT_TURN_SCHEMA,
  buildAgentMessages,
  normalizeAgentTurn,
} from "./agent-prompts.js";

export type AgentState =
  | "idle"
  | "planning"
  | "acting"
  | "recovering"
  | "awaiting-user"
  | "done"
  | "stopped";

export type AgentFinishReason = "goal" | "stopped" | "budget" | "session-ended" | "error";

export type AgentEvent =
  | { kind: "state"; state: AgentState }
  | { kind: "say"; who: "user" | "agent"; text: string }
  | { kind: "step"; label: string; status: "ran" | "unchecked" | "failed"; detail?: string }
  | { kind: "proposal"; id: string; label: string }
  | {
      kind: "proposal-resolved";
      id: string;
      accepted: boolean;
      outcome?: "inserted" | "failed" | "unavailable";
      detail?: string;
    }
  | { kind: "finished"; reason: AgentFinishReason; note?: string };

/** One event as it is pushed and as the snapshot replays it. `seq` orders
 *  a late-opening window's snapshot against the pushes it then receives. */
export interface AgentEventRecord {
  runId: string;
  seq: number;
  at: number;
  event: AgentEvent;
}

export interface AgentRunSnapshot {
  runId: string | null;
  running: boolean;
  state: AgentState;
  events: AgentEventRecord[];
}

/** Hard caps. Attempts is a CONSECUTIVE-failure budget (a success resets
 *  it): three straight tries that did not run means the agent's model of
 *  the page is wrong, and a fourth guess teaches it nothing the probe
 *  evidence has not. The totals bound the blast radius of a bad goal. */
export const AGENT_ATTEMPTS_PER_STEP = 3;
export const AGENT_MAX_INSERTED = 12;
export const AGENT_MAX_TURNS = 10;
export const AGENT_TURN_TIMEOUT_MS = 120_000;
const AWAIT_POLL_MS = 2_000;
const MAX_EVENTS = 300;
const MAX_GOAL = 2_000;
const GROUP_LABEL_MAX = 80;

export interface TrainerAgentDeps {
  completeJson: (
    params: {
      messages: LlmMessage[];
      role: "chat";
      temperature: number;
      schema: object;
      schemaName?: string;
    },
    opts: { timeoutMs: number },
  ) => Promise<{ value: unknown }>;
  /** Belt-and-braces redaction, the insights pattern: the llm service
   *  redacts again on send, but a context builder should not rely on it. */
  refreshRedaction: () => Promise<void>;
  redact: (text: string) => string;
  /** THE verify gate — recorderService.tryStep. */
  tryStep: (input: unknown, onInsert?: () => void) => Promise<TryStepOutcome>;
  /** For the group/endGroup markers only. */
  insertStep: (raw: RawStep) => void;
  /** Live-session snapshot, or null when none is recording. */
  session: () => { steps: Step[]; liveUrl: string } | null;
  pageSummary: () => Promise<PageSummary | null>;
  /** Evidence lines for a failed step — the heal probe, rendered and capped. */
  probeFailedStep: (raw: unknown) => Promise<string[]>;
  describeStep: (step: Step) => string;
  /** Normalize a proposed assertion through the ingest boundary and label
   *  it; null refuses the proposal. */
  normalizeProposal: (raw: unknown) => { raw: RawStep; label: string } | null;
  push: (record: AgentEventRecord) => void;
  now?: () => number;
}

interface Proposal {
  id: string;
  raw: RawStep;
  label: string;
  resolved: boolean;
}

interface Run {
  id: string;
  goal: string;
  state: AgentState;
  running: boolean;
  seq: number;
  events: AgentEventRecord[];
  mailbox: string[];
  stopRequested: boolean;
  inserted: number;
  turns: number;
  failStreak: number;
  groupOpen: boolean;
  evidence: string[];
  proposals: Map<string, Proposal>;
  wake: (() => void) | null;
}

export interface TrainerAgentService {
  start(goal: unknown): { ok: true; runId: string } | { ok: false; reason: string };
  say(text: unknown): boolean;
  stop(): boolean;
  resolveProposal(id: unknown, accept: unknown): Promise<{ ok: boolean; detail?: string }>;
  snapshot(): AgentRunSnapshot;
}

export function createTrainerAgentService(deps: TrainerAgentDeps): TrainerAgentService {
  const now = deps.now ?? Date.now;
  let run: Run | null = null;
  // Serializes every tryStep — the loop's and a proposal accept's — so two
  // verified tries can never interleave on the live page.
  let executing: Promise<unknown> = Promise.resolve();

  function emit(r: Run, event: AgentEvent): void {
    const record: AgentEventRecord = { runId: r.id, seq: ++r.seq, at: now(), event };
    r.events.push(record);
    if (r.events.length > MAX_EVENTS) r.events.splice(0, r.events.length - MAX_EVENTS);
    deps.push(record);
  }

  function setState(r: Run, state: AgentState): void {
    if (r.state === state) return;
    r.state = state;
    emit(r, { kind: "state", state });
  }

  function finish(r: Run, reason: AgentFinishReason, note?: string): void {
    if (!r.running) return;
    r.running = false;
    setState(r, reason === "stopped" ? "stopped" : "done");
    emit(r, { kind: "finished", reason, ...(note ? { note } : {}) });
  }

  function wake(r: Run): void {
    const w = r.wake;
    r.wake = null;
    w?.();
  }

  /** Wait for say()/stop(), or `ms` — the poll that lets an awaiting run
   *  notice a session that ended underneath it. */
  function waitForWake(r: Run, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (r.wake === release) r.wake = null;
        resolve();
      }, ms);
      const release = () => {
        clearTimeout(timer);
        resolve();
      };
      r.wake = release;
    });
  }

  /** Park the run until the user says something, stops it, or the session
   *  dies — WITHOUT replanning on the poll ticks: a bare timeout wake must
   *  not burn a turn, or the whole budget goes while the user is at lunch.
   *  The loop top re-checks stop/session after this returns, so callers
   *  just `continue`. */
  async function awaitUser(r: Run): Promise<void> {
    setState(r, "awaiting-user");
    while (r.running && !r.stopRequested && r.mailbox.length === 0) {
      if (!deps.session()) return;
      await waitForWake(r, AWAIT_POLL_MS);
    }
  }

  function gatedTryStep(input: unknown, onInsert?: () => void): Promise<TryStepOutcome> {
    const next = executing.then(() => deps.tryStep(input, onInsert));
    executing = next.catch(() => {});
    return next;
  }

  function openGroupHook(r: Run): () => void {
    return () => {
      if (r.groupOpen) return;
      r.groupOpen = true;
      deps.insertStep({
        type: "group",
        label: r.goal.length > GROUP_LABEL_MAX ? r.goal.slice(0, GROUP_LABEL_MAX - 1) + "…" : r.goal,
      });
    };
  }

  async function planningTurn(r: Run, sess: { steps: Step[]; liveUrl: string }) {
    const summary = await deps.pageSummary();
    const userNotes = r.mailbox.splice(0);
    const messages = buildAgentMessages({
      goal: r.goal,
      url: sess.liveUrl,
      title: summary?.title ?? "",
      stepsTail: sess.steps.map((s) => deps.describeStep(s)),
      summary,
      userNotes,
      evidence: r.evidence,
      remainingSteps: AGENT_MAX_INSERTED - r.inserted,
    });
    await deps.refreshRedaction();
    const redacted = messages.map((m) => ({ ...m, content: deps.redact(m.content) }));
    r.turns++;
    const completion = await deps.completeJson(
      // The chat slot, said so — the run goes where the user's conversations
      // go, and the insights precedent is the comment style too.
      { messages: redacted, role: "chat", temperature: 0.2, schema: AGENT_TURN_SCHEMA, schemaName: "agent_turn" },
      { timeoutMs: AGENT_TURN_TIMEOUT_MS },
    );
    return normalizeAgentTurn(completion.value);
  }

  async function runLoop(r: Run): Promise<void> {
    try {
      while (r.running) {
        if (r.stopRequested) return finish(r, "stopped");
        const sess = deps.session();
        if (!sess) return finish(r, "session-ended", "The recording session ended.");
        if (r.turns >= AGENT_MAX_TURNS) {
          return finish(r, "budget", "Turn budget spent — the goal needs more than this run allows.");
        }
        if (r.inserted >= AGENT_MAX_INSERTED) {
          return finish(r, "budget", `Step budget spent (${AGENT_MAX_INSERTED} inserted).`);
        }

        setState(r, r.evidence.length > 0 ? "recovering" : "planning");
        let turn;
        try {
          turn = await planningTurn(r, sess);
        } catch (err) {
          emit(r, {
            kind: "say",
            who: "agent",
            text: `I couldn't reach the model: ${String((err as Error)?.message ?? err).slice(0, 300)}`,
          });
          await awaitUser(r);
          continue;
        }
        r.evidence = [];
        if (turn.note) emit(r, { kind: "say", who: "agent", text: turn.note });

        for (const rawAssert of turn.assertions) {
          const normalized = deps.normalizeProposal(rawAssert);
          if (!normalized) continue;
          const proposal: Proposal = { id: randomUUID(), ...normalized, resolved: false };
          r.proposals.set(proposal.id, proposal);
          emit(r, { kind: "proposal", id: proposal.id, label: proposal.label });
        }

        if (turn.steps.length === 0) {
          if (turn.done) return finish(r, "goal", turn.note || undefined);
          if (r.mailbox.length > 0) continue;
          if (!turn.note) {
            emit(r, { kind: "say", who: "agent", text: "I need more direction to continue." });
          }
          await awaitUser(r);
          continue;
        }

        setState(r, "acting");
        let failed = false;
        for (const raw of turn.steps) {
          if (r.stopRequested || r.inserted >= AGENT_MAX_INSERTED) break;
          const outcome = await gatedTryStep(raw, openGroupHook(r));
          if (outcome.status === "no-session") return finish(r, "session-ended");
          if (outcome.status === "skipped") {
            emit(r, {
              kind: "step",
              label: "(refused)",
              status: "failed",
              detail: "The proposed step is not a valid recorder step.",
            });
            r.failStreak++;
            r.evidence = ["The last proposed step was refused by the recorder's step model — it never ran."];
            failed = true;
            break;
          }
          emit(r, { kind: "step", ...outcome.result });
          if (outcome.status === "failed") {
            r.failStreak++;
            r.evidence = [
              `FAILED STEP: ${outcome.result.label}`,
              `ERROR: ${(outcome.result.detail ?? "the step did not run").slice(0, 300)}`,
              ...(await deps.probeFailedStep(raw).catch(() => [])),
            ];
            failed = true;
            break;
          }
          r.inserted++;
          r.failStreak = 0;
          // A word from the user outranks the rest of this turn's plan.
          if (r.mailbox.length > 0) break;
        }

        if (failed && r.failStreak >= AGENT_ATTEMPTS_PER_STEP) {
          emit(r, {
            kind: "say",
            who: "agent",
            text: "I'm stuck — three straight tries failed. Tell me how to proceed, or stop the run.",
          });
          await awaitUser(r);
          // A user message is a fresh start on the streak. awaitUser only
          // returns on a message, a stop or a dead session, and the loop top
          // handles the other two.
          if (r.mailbox.length > 0) r.failStreak = 0;
          continue;
        }

        if (!failed && turn.done && r.mailbox.length === 0) {
          return finish(r, "goal", turn.note || undefined);
        }
      }
    } catch (err) {
      emit(r, {
        kind: "say",
        who: "agent",
        text: `The run hit an unexpected error: ${String((err as Error)?.message ?? err).slice(0, 300)}`,
      });
      finish(r, "error");
    } finally {
      if (r.groupOpen) {
        try {
          deps.insertStep({ type: "endGroup" });
        } catch {
          /* the session may be gone; the group is then moot */
        }
        r.groupOpen = false;
      }
      if (r.running) finish(r, "error");
    }
  }

  return {
    start(goal: unknown) {
      const text = typeof goal === "string" ? goal.trim().slice(0, MAX_GOAL) : "";
      if (!text) return { ok: false, reason: "Say what the agent should do." };
      // A run whose session died while it waited is finished, not blocking.
      if (run?.running && !deps.session()) finish(run, "session-ended");
      if (run?.running) return { ok: false, reason: "An agent run is already in progress." };
      if (!deps.session()) return { ok: false, reason: "No recording session is running." };
      const r: Run = {
        id: randomUUID(),
        goal: text,
        state: "idle",
        running: true,
        seq: 0,
        events: [],
        mailbox: [],
        stopRequested: false,
        inserted: 0,
        turns: 0,
        failStreak: 0,
        groupOpen: false,
        evidence: [],
        proposals: new Map(),
        wake: null,
      };
      run = r;
      emit(r, { kind: "say", who: "user", text });
      void runLoop(r);
      return { ok: true, runId: r.id };
    },

    say(text: unknown): boolean {
      const r = run;
      const msg = typeof text === "string" ? text.trim().slice(0, MAX_GOAL) : "";
      if (!r || !r.running || !msg) return false;
      emit(r, { kind: "say", who: "user", text: msg });
      r.mailbox.push(msg);
      wake(r);
      return true;
    },

    stop(): boolean {
      const r = run;
      if (!r || !r.running) return false;
      r.stopRequested = true;
      wake(r);
      return true;
    },

    async resolveProposal(id: unknown, accept: unknown): Promise<{ ok: boolean; detail?: string }> {
      const r = run;
      const pid = typeof id === "string" ? id : "";
      const proposal = r?.proposals.get(pid);
      if (!r || !proposal || proposal.resolved) {
        return { ok: false, detail: "That proposal is no longer available." };
      }
      proposal.resolved = true;
      if (accept !== true) {
        emit(r, { kind: "proposal-resolved", id: pid, accepted: false });
        return { ok: true };
      }
      // Through the same gate as everything else — accepted means TRIED, and
      // inserted only when the assertion actually held on the live page.
      const outcome = await gatedTryStep(proposal.raw);
      if (outcome.status === "inserted") {
        emit(r, { kind: "proposal-resolved", id: pid, accepted: true, outcome: "inserted" });
        return { ok: true };
      }
      const detail =
        outcome.status === "failed"
          ? (outcome.result.detail ?? "the assertion did not hold")
          : "the session is no longer live";
      emit(r, {
        kind: "proposal-resolved",
        id: pid,
        accepted: true,
        outcome: outcome.status === "failed" ? "failed" : "unavailable",
        detail,
      });
      return { ok: false, detail };
    },

    snapshot(): AgentRunSnapshot {
      if (!run) return { runId: null, running: false, state: "idle", events: [] };
      return { runId: run.id, running: run.running, state: run.state, events: [...run.events] };
    },
  };
}

// ── The real bindings ────────────────────────────────────────────────
// Kept at the bottom the way insights-service keeps its own: everything
// above is pure against the deps, and everything the app actually wires is
// visible in one block.

import { llmService } from "../llm-service.js";
import { recorderService } from "../recorder-service.js";
import { refreshSecretSnapshot, redactWithSnapshot } from "../secret-redaction.js";
import { describeStep } from "../script-generator.js";
import { normalizeRawStep } from "../../recorder/types.js";
import { sendToMain } from "../app-window.js";

/** Page-value assert kinds whose whole meaning is their value — an empty one
 *  generates nothing and asserts nothing, so a proposal shaped that way is
 *  refused here the way the composer and parse-llm-response refuse it.
 *  Exported for the suggestion strip's bindings, which apply the same rule. */
export const PAGE_VALUE_ASSERTS = new Set(["url", "urlEndsWith", "urlIs", "urlPathIs", "title", "titleContains"]);

export const trainerAgentService: TrainerAgentService = createTrainerAgentService({
  completeJson: (params, opts) => llmService.completeJson(params, opts),
  refreshRedaction: () => refreshSecretSnapshot(),
  redact: (text) => redactWithSnapshot(text),
  tryStep: (input, onInsert) => recorderService.tryStep(input, onInsert),
  insertStep: (raw) => void recorderService.insertStep(raw),
  session: () => {
    const state = recorderService.getState();
    if (!state.recording) return null;
    return { steps: recorderService.getSteps(), liveUrl: state.liveUrl ?? state.url ?? "" };
  },
  pageSummary: () => recorderService.agentPageSummary(),
  probeFailedStep: async (raw) => {
    const candidates = await recorderService.agentProbeStep(raw);
    if (candidates.length === 0) return [];
    return [
      "WHAT THE PAGE OFFERS INSTEAD (probe candidates, best first):",
      ...candidates.map(
        (c) => `  CANDIDATE ${JSON.stringify(c.locator)}${c.description ? ` — ${c.description}` : ""}`,
      ),
    ];
  },
  describeStep: (step) => describeStep(step),
  normalizeProposal: (raw) => {
    const clean = normalizeRawStep(raw);
    if (!clean || clean.type !== "assert") return null;
    if (clean.assert && PAGE_VALUE_ASSERTS.has(clean.assert) && !(clean.value ?? "").trim()) return null;
    return {
      raw: clean,
      label: describeStep({ id: "", timestamp: 0, ...clean }),
    };
  },
  push: (record) => sendToMain("agent:event", record),
});
