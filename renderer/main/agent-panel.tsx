// The command drawer — the AI tile's surface, mounted under the context band
// on both trainers. One implementation with a per-surface frame class, the
// BarContextZone rule: the two windows describe ONE session's agent run and
// must not drift into describing it differently.
//
// The drawer is the agent's whole conversation: the goal and every
// redirection (the transcript), each verified step as the gate reports it,
// and the assertion-proposal cards, which resolve IN PLACE — a card that
// jumped to the bottom when clicked would be the reflow defect in
// miniature. The input stays LIVE while a run is acting: a message mid-run
// is the mailbox's whole point, and disabling the box while the agent works
// would remove the one control that redirects it.

import * as React from "react";
import { Square, X } from "lucide-react";

import { Btn } from "../theme";
import {
  agentStateLabel,
  type AgentFeedItem,
  type AgentRunView,
} from "../lib/agent-run";

/** Exported for the tests — placeholder copy is unreachable by role query
 *  alone, and the input's whole invitation lives in it. */
export const AGENT_PLACEHOLDER = "Tell the trainer what to do — or click the page.";

const STEP_GLYPH: Record<"ran" | "unchecked" | "failed", string> = {
  ran: "✓",
  unchecked: "○",
  failed: "✕",
};

function proposalOutcome(item: Extract<AgentFeedItem, { kind: "proposal" }>): string {
  if (!item.accepted) return "Dismissed";
  if (item.outcome === "inserted") return "Added to the test";
  if (item.outcome === "failed") return `Didn't hold — ${item.detail ?? "the assertion failed"}`;
  return "Unavailable";
}

export function AgentPanel({
  className,
  run,
  inputDisabled,
  onSubmit,
  onStop,
  onResolveProposal,
  onClose,
  onOpenGenerate,
}: {
  /** Per-surface frame class: "gl-trainer-ai" | "gl-panelwin-ai". */
  className: string;
  run: AgentRunView | null;
  /** True while the page is not ready or the list is not loaded — NOT while
   *  the agent runs; a mid-run message is the mailbox working as designed. */
  inputDisabled: boolean;
  /** The command box's send. The VIEW decides what the text means
   *  (lib/command-parse first, then the agent) — this component only
   *  collects it. */
  onSubmit: (text: string) => void;
  onStop: () => void;
  onResolveProposal: (id: string, accept: boolean) => void;
  onClose: () => void;
  /** Opens the classic Generate Steps dialog — the single-shot batch path
   *  this drawer complements rather than replaces. */
  onOpenGenerate: () => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState("");
  const feedRef = React.useRef<HTMLDivElement | null>(null);
  const itemCount = run?.items.length ?? 0;
  React.useEffect(() => {
    // Follow the newest line; the feed is short-lived working context, not an
    // archive the user scrolls.
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [itemCount]);

  const submit = () => {
    const text = draft.trim();
    if (!text || inputDisabled) return;
    onSubmit(text);
    setDraft("");
  };

  return (
    <div className={className} data-gl="agent-panel">
      <div className="gl-agent-head">
        <span className="gl-agent-title">AI</span>
        {run ? <span className="gl-agent-state">{agentStateLabel(run)}</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {run?.running ? (
            // Filled and red (`.gl-agent-stop`): an OUTLINED square up here
            // read as an empty checkbox in the first screenshot pass.
            <button
              type="button"
              className="gl-icon-btn gl-agent-stop"
              onClick={onStop}
              aria-label="Stop the agent run"
            >
              <Square className="size-3" />
            </button>
          ) : null}
          <Btn onClick={onOpenGenerate} title="Describe a whole batch of steps at once — tried before inserted">
            Generate steps…
          </Btn>
          <button type="button" className="gl-icon-btn" onClick={onClose} aria-label="Close AI panel">
            <X className="size-3.5" />
          </button>
        </span>
      </div>

      {run && run.items.length > 0 ? (
        <div className="gl-agent-feed" ref={feedRef}>
          {run.items.map((item) =>
            item.kind === "say" ? (
              <div key={item.seq} className="gl-agent-say" data-who={item.who}>
                <span className="gl-agent-who">{item.who === "user" ? "You" : "Agent"}</span>
                <span className="min-w-0">{item.text}</span>
              </div>
            ) : item.kind === "step" ? (
              <div key={item.seq} className="gl-agent-step" data-status={item.status}>
                <span className="gl-agent-glyph" aria-hidden>
                  {STEP_GLYPH[item.status]}
                </span>
                <span className="min-w-0">
                  {item.label}
                  {item.detail ? <span className="gl-agent-detail"> — {item.detail}</span> : null}
                </span>
              </div>
            ) : (
              <div key={item.seq} className="gl-agent-proposal">
                <span className="min-w-0 truncate" title={item.label}>
                  {item.label}
                </span>
                {item.resolved ? (
                  <span className="gl-agent-detail ml-auto shrink-0">{proposalOutcome(item)}</span>
                ) : (
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <Btn onClick={() => onResolveProposal(item.id, true)}>Add it</Btn>
                    <Btn onClick={() => onResolveProposal(item.id, false)}>Dismiss</Btn>
                  </span>
                )}
              </div>
            ),
          )}
        </div>
      ) : null}

      <div className="gl-agent-inputrow">
        <input
          className="gl-input gl-agent-input"
          value={draft}
          placeholder={AGENT_PLACEHOLDER}
          aria-label="Tell the trainer what to do"
          disabled={inputDisabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Btn onClick={submit} disabled={inputDisabled || !draft.trim()}>
          Send
        </Btn>
      </div>
    </div>
  );
}
