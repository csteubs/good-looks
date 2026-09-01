// The renderer's model of a trainer-agent run, built by REDUCING the typed
// events the backend pushes (`agent:event`) — mirrors of the shapes in
// main/services/agent/trainer-agent-service.ts, hand-kept like every other
// main/renderer pair in lib/recorder-types.ts.
//
// A reducer rather than fields on the push, for the late-window problem the
// recorder already solved for steps: a window that opens mid-run missed
// every earlier push, so it seeds from the `agent:getRun` snapshot (the same
// event list, replayed) and then applies live pushes on top. `seq` is what
// makes that safe — an event at or below the last applied seq is a replay
// of something already in the view, never new information.

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

/** One row of the drawer's feed, in arrival order. Proposals stay in place
 *  and gain their resolution rather than moving — a card that jumps when
 *  clicked is the reflow rule all over again. */
export type AgentFeedItem =
  | { kind: "say"; seq: number; who: "user" | "agent"; text: string }
  | { kind: "step"; seq: number; label: string; status: "ran" | "unchecked" | "failed"; detail?: string }
  | {
      kind: "proposal";
      seq: number;
      id: string;
      label: string;
      resolved: boolean;
      accepted?: boolean;
      outcome?: "inserted" | "failed" | "unavailable";
      detail?: string;
    };

export interface AgentRunView {
  runId: string;
  running: boolean;
  state: AgentState;
  items: AgentFeedItem[];
  finishedReason?: AgentFinishReason;
  finishedNote?: string;
  lastSeq: number;
}

/** Apply one pushed record. A record for a DIFFERENT run replaces the view —
 *  a new start is a new conversation; a stale or duplicate seq is dropped. */
export function applyAgentEvent(view: AgentRunView | null, record: AgentEventRecord): AgentRunView | null {
  if (!record || typeof record.seq !== "number") return view;
  let v: AgentRunView;
  if (!view || view.runId !== record.runId) {
    v = { runId: record.runId, running: true, state: "idle", items: [], lastSeq: 0 };
  } else {
    if (record.seq <= view.lastSeq) return view;
    v = { ...view, items: [...view.items] };
  }
  v.lastSeq = record.seq;
  const e = record.event;
  switch (e.kind) {
    case "state":
      v.state = e.state;
      break;
    case "say":
      v.items.push({ kind: "say", seq: record.seq, who: e.who, text: e.text });
      break;
    case "step":
      v.items.push({ kind: "step", seq: record.seq, label: e.label, status: e.status, detail: e.detail });
      break;
    case "proposal":
      v.items.push({ kind: "proposal", seq: record.seq, id: e.id, label: e.label, resolved: false });
      break;
    case "proposal-resolved":
      v.items = v.items.map((item) =>
        item.kind === "proposal" && item.id === e.id
          ? { ...item, resolved: true, accepted: e.accepted, outcome: e.outcome, detail: e.detail }
          : item,
      );
      break;
    case "finished":
      v.running = false;
      v.finishedReason = e.reason;
      if (e.note) v.finishedNote = e.note;
      break;
  }
  return v;
}

/** Replay a snapshot's event list into a view — the late-window seed. */
export function reduceAgentEvents(records: AgentEventRecord[]): AgentRunView | null {
  let view: AgentRunView | null = null;
  for (const record of records) view = applyAgentEvent(view, record);
  return view;
}

/** The state line the drawer shows — one spelling for both surfaces. */
export function agentStateLabel(view: AgentRunView): string {
  if (!view.running) {
    switch (view.finishedReason) {
      case "goal":
        return "Done";
      case "stopped":
        return "Stopped";
      case "budget":
        return "Stopped at the step budget";
      case "session-ended":
        return "The session ended";
      default:
        return "Ended with an error";
    }
  }
  switch (view.state) {
    case "planning":
      return "Planning…";
    case "acting":
      return "Acting on the page…";
    case "recovering":
      return "Recovering from a failed step…";
    case "awaiting-user":
      return "Waiting for you";
    default:
      return "Starting…";
  }
}
