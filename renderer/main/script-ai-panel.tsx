// Inline AI in the Script tab: ⌘K rewrite, and "explain the failure".
//
// Rendered between the script bar and the editor while open. A rewrite is
// an instruction over the whole file or the current selection; the answer's
// one fenced block becomes a diff, and Apply puts it into the EDIT BUFFER —
// never on disk. The pre-save check, the divergence confirm and the
// stale-base refusal all still stand between the model's text and the
// file, and Save records the change as `ai-inline` so the Heals tab says
// who wrote it. Explain is prose only, on the instant slot.
//
// Three small rules live here rather than in the prompt builders:
//   - the budget line: what is about to be sent and roughly how many tokens,
//     before the user sends it (a whole 2000-line spec is a choice, not a
//     surprise);
//   - the hosted cap: at most HOSTED_PER_MINUTE editor requests a minute when
//     the chat slot is a hosted provider — an editor affordance is the one
//     place a user can spend money by holding a key down;
//   - the skipped-statement note: after a rewrite, the preview handler says
//     how many of the new file's statements the step list cannot show. They
//     still run; the user should know they will read as code from now on.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { DiffView } from "../components/diff-view";
import { api } from "../lib/api";
import { diffLines, diffSummary } from "../lib/line-diff";
import {
  INLINE_PROMPT_VERSION,
  buildExplainMessages,
  buildRewriteMessages,
  estimateTokens,
} from "../lib/llm-prompts";
import type { LlmConfig } from "../lib/llm-types";
import { extractCorrectedScript, parseResponse } from "../lib/parse-llm-response";
import { useLlmChat } from "../lib/use-llm-chat";
import { Btn } from "../theme";

export type ScriptAiMode = "rewrite" | "explain";

export interface ScriptAiSelection {
  from: number;
  to: number;
  text: string;
}

export interface ScriptAiApplyMeta {
  affordance: "inline-rewrite";
  provider?: string;
  model?: string;
  promptVersion: string;
}

export interface ScriptAiPanelProps {
  mode: ScriptAiMode;
  testId: string;
  testName: string;
  testUrl: string;
  /** The script as the editor holds it now. */
  script: string;
  selection: ScriptAiSelection | null;
  caretLine: number;
  /** The last run's failure, for Explain. */
  failure: { index?: number; label?: string; output: string } | null;
  instructions?: string;
  onApply: (next: string, meta: ScriptAiApplyMeta) => void;
  onClose: () => void;
}

export const HOSTED_PER_MINUTE = 6;
export const HOSTED_CAP_MESSAGE = `Hosted requests from the editor are capped at ${HOSTED_PER_MINUTE} a minute. Wait a moment, or switch the chat slot to a local model.`;

const sentAt: number[] = [];
/** True when one more hosted request now would exceed the cap; records the
 *  request otherwise. Module state on purpose: the cap is per app, not per
 *  panel mount. `now` is injectable for tests. */
export function hostedCapAllows(now: number = Date.now()): boolean {
  while (sentAt.length && now - sentAt[0] > 60_000) sentAt.shift();
  if (sentAt.length >= HOSTED_PER_MINUTE) return false;
  sentAt.push(now);
  return true;
}
export function resetHostedCapForTesting(): void {
  sentAt.length = 0;
}

/** The replacement text in a rewrite answer: the whole file when the scope
 *  was the file (the same bar the debug panel's Apply uses — a closed fence
 *  holding an import and a test()), or the first closed block when the scope
 *  was a selection. */
export function extractReplacement(answer: string, scoped: boolean): string | null {
  if (!scoped) return extractCorrectedScript(answer);
  const block = parseResponse(answer).find((s) => s.type === "code" && s.closed);
  if (!block || block.type !== "code") return null;
  return block.content.replace(/\s+$/, "");
}

/** The answer with its code blocks removed — what reads as the model's
 *  sentence rather than its code. */
function proseOf(answer: string): string {
  return parseResponse(answer)
    .filter((s) => s.type === "text")
    .map((s) => (s.type === "text" ? s.content : ""))
    .join("\n")
    .trim();
}

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < Math.min(offset, text.length); i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const PROVIDER_LABEL: Record<string, string> = { ollama: "Ollama", lmstudio: "LM Studio", anthropic: "Claude" };

export function ScriptAiPanel(props: ScriptAiPanelProps): React.ReactElement {
  const { mode, testId, testName, testUrl, script, selection, caretLine, failure, instructions, onApply, onClose } = props;
  const chat = useLlmChat();
  const [instruction, setInstruction] = React.useState("");
  const [capMessage, setCapMessage] = React.useState<string | null>(null);
  const [skippedNote, setSkippedNote] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const rootRef = React.useRef<HTMLElement | null>(null);

  const config = useQuery({ queryKey: ["llm", "config"], queryFn: () => api.llm.getConfig(), staleTime: 30_000 });
  const slotFor = (role: "chat" | "instant"): { provider: string; model: string | null } | null => {
    const c: LlmConfig | undefined = config.data;
    if (!c) return null;
    return c.roles?.[role] ?? c.roles?.chat ?? { provider: c.provider, model: c.model };
  };
  const slot = slotFor(mode === "rewrite" ? "chat" : "instant");

  const scoped = selection !== null;
  const messages = React.useMemo(() => {
    if (mode === "rewrite") {
      return buildRewriteMessages({ testName, testUrl, script, selection, instruction, instructions });
    }
    const lines = script.split("\n");
    return buildExplainMessages({
      testName,
      testUrl,
      script,
      caretLine,
      caretStatement: lines[caretLine - 1] ?? "",
      failedStepIndex: failure?.index,
      failedStepLabel: failure?.label,
      output: failure?.output ?? "",
      instructions,
    });
  }, [mode, testName, testUrl, script, selection, instruction, instructions, caretLine, failure]);
  const tokens = estimateTokens(messages.map((m) => m.content).join("\n"));

  const send = React.useCallback(async () => {
    if (mode === "rewrite" && !instruction.trim()) return;
    if (slot?.provider === "anthropic" && !hostedCapAllows()) {
      setCapMessage(HOSTED_CAP_MESSAGE);
      return;
    }
    setCapMessage(null);
    setSkippedNote(null);
    await chat.start(messages, { role: mode === "rewrite" ? "chat" : "instant" });
  }, [mode, instruction, slot?.provider, chat, messages]);

  // Explain asks straight away — there is nothing to type.
  const askedRef = React.useRef(false);
  React.useEffect(() => {
    if (mode !== "explain" || askedRef.current) return;
    askedRef.current = true;
    void send();
  }, [mode, send]);

  React.useEffect(() => {
    if (mode === "rewrite") inputRef.current?.focus();
  }, [mode]);

  const replacement = React.useMemo(
    () => (mode === "rewrite" && chat.status === "done" ? extractReplacement(chat.content, scoped) : null),
    [mode, chat.status, chat.content, scoped],
  );
  const before = scoped ? selection!.text : script;
  const nextScript = React.useMemo(() => {
    if (replacement === null) return null;
    return scoped ? script.slice(0, selection!.from) + replacement + script.slice(selection!.to) : replacement;
  }, [replacement, scoped, script, selection]);
  const diff = React.useMemo(() => (replacement === null ? null : diffLines(before, replacement)), [before, replacement]);
  const summary = diff ? diffSummary(diff) : null;

  // What the step list will make of the new file. A preview that cannot run
  // says nothing rather than blocking the apply.
  React.useEffect(() => {
    if (nextScript === null) return;
    let cancelled = false;
    api.tests
      .previewScript(testId, nextScript)
      .then((p) => {
        if (cancelled) return;
        const n = p.newlySkipped.length;
        setSkippedNote(
          n === 0 ? null : n === 1 ? "1 new statement the step list can't show — it still runs, but reads as code." : `${n} new statements the step list can't show — they still run, but read as code.`,
        );
      })
      .catch(() => {
        /* the preview is advisory */
      });
    return () => {
      cancelled = true;
    };
  }, [nextScript, testId]);

  const apply = () => {
    if (nextScript === null) return;
    onApply(nextScript, {
      affordance: "inline-rewrite",
      provider: slot?.provider,
      model: slot?.model ?? undefined,
      promptVersion: INLINE_PROMPT_VERSION,
    });
  };

  const title =
    mode === "explain"
      ? `Explain the failure at line ${caretLine}`
      : scoped
        ? `Rewrite lines ${lineOf(script, selection!.from)}–${lineOf(script, Math.max(selection!.from, selection!.to - 1))}`
        : "Rewrite the whole file";
  const slotLabel = slot ? `${PROVIDER_LABEL[slot.provider] ?? slot.provider}${slot.model ? ` · ${slot.model}` : ""}` : "no model";
  const prose = proseOf(chat.content);

  return (
    <section
      ref={rootRef}
      className="gl-script-ai"
      role="region"
      aria-label={mode === "explain" ? "Explain the failure" : "Rewrite with AI"}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (chat.status === "streaming") chat.stop();
          onClose();
        }
      }}
    >
      <div className="gl-script-ai-head">
        <span className="gl-script-ai-title">{title}</span>
        <span className="gl-script-ai-meta" data-gl="ai-budget">
          {scoped ? "Sending the selection and the file for context" : mode === "explain" ? "Sending the file and the run output" : "Sending the whole file"}
          {` · ≈${fmtTokens(tokens)} tokens · ${slotLabel}`}
        </span>
        <Btn onClick={onClose} aria-label="Close">
          Close
        </Btn>
      </div>
      {mode === "rewrite" ? (
        <div className="gl-script-ai-input">
          <textarea
            ref={inputRef}
            rows={2}
            aria-label="What should change?"
            placeholder={scoped ? "What should change in the selection?" : "What should change?"}
            value={instruction}
            disabled={chat.status === "streaming"}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {chat.status === "streaming" ? (
            <Btn tone="stop" onClick={chat.stop}>
              Stop
            </Btn>
          ) : (
            <Btn tone="ai" onClick={() => void send()} disabled={!instruction.trim()}>
              {chat.status === "done" || chat.status === "error" ? "Ask again" : "Ask"}
            </Btn>
          )}
        </div>
      ) : null}
      {capMessage ? (
        <p className="gl-script-ai-note" role="status">
          {capMessage}
        </p>
      ) : null}
      {chat.status === "streaming" && !chat.content ? (
        <p className="gl-script-ai-note" role="status">
          Thinking…
        </p>
      ) : null}
      {chat.status === "error" ? (
        <p className="gl-script-ai-note" role="alert">
          {chat.error}
        </p>
      ) : null}
      {prose ? <p className="gl-script-ai-answer">{prose}</p> : null}
      {mode === "rewrite" && chat.status === "done" && replacement === null ? (
        <p className="gl-script-ai-note" role="status">
          {scoped ? "The answer had no code block to apply." : "The answer had no complete file to apply — ask for the whole file, or select the lines to change."}
        </p>
      ) : null}
      {diff ? (
        <div className="gl-script-ai-review">
          <div className="gl-script-ai-head">
            <span className="gl-script-ai-title">
              Review{summary ? ` (+${summary.added} / −${summary.removed} lines)` : ""}
            </span>
            {skippedNote ? (
              <span className="gl-script-ai-meta" role="status">
                {skippedNote}
              </span>
            ) : null}
            <Btn tone="go" onClick={apply}>
              Apply to the editor
            </Btn>
          </div>
          <DiffView diff={diff} />
        </div>
      ) : null}
    </section>
  );
}
