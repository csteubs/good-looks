// Renderer hook for a single streaming llm:chat request. Subscribes to the
// llm:chunk/done/error push events (see main/services/llm-service.ts) filtered
// by the request's own requestId, so multiple hook instances don't cross-talk.

import * as React from "react";

import { api } from "./api";
import type { LlmMessage, LlmProvider } from "./llm-types";

export type LlmChatStatus = "idle" | "streaming" | "done" | "error" | "cancelled";

export function useLlmChat() {
  const [content, setContent] = React.useState("");
  // A reasoning model's thinking, accumulated SEPARATELY from the answer.
  // Merging them would present a model's scratchpad as its conclusion — and
  // the "Apply fix" path downstream reads the answer as a diff.
  const [reasoning, setReasoning] = React.useState("");
  const [status, setStatus] = React.useState<LlmChatStatus>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const requestIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const offChunk = api.on<{ requestId: string; delta: string; reasoning?: boolean }>(
      "llm:chunk",
      ({ requestId, delta, reasoning: isReasoning }) => {
        if (requestId !== requestIdRef.current) return;
        if (isReasoning) setReasoning((r) => r + delta);
        else setContent((c) => c + delta);
      },
    );
    const offDone = api.on<{ requestId: string; cancelled?: boolean }>("llm:done", ({ requestId, cancelled }) => {
      if (requestId !== requestIdRef.current) return;
      setStatus(cancelled ? "cancelled" : "done");
    });
    const offError = api.on<{ requestId: string; message: string }>("llm:error", ({ requestId, message }) => {
      if (requestId !== requestIdRef.current) return;
      setStatus("error");
      setError(message);
    });
    return () => {
      offChunk();
      offDone();
      offError();
    };
  }, []);

  // `options` lets callers pin the model (and other per-request params) to the
  // value they just polled from llm:getConfig, so the displayed "Thinking with
  // {model}" name matches the model the backend actually uses instead of a
  // value captured once at dialog open that may have gone stale.
  const start = React.useCallback(
    async (messages: LlmMessage[], options?: { model?: string; provider?: LlmProvider; temperature?: number }) => {
      setContent("");
      setReasoning("");
      setError(null);
      setStatus("streaming");
      try {
        const { requestId } = await api.llm.chat({ messages, ...options });
        requestIdRef.current = requestId;
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const stop = React.useCallback(() => {
    if (requestIdRef.current) void api.llm.cancel(requestIdRef.current);
  }, []);

  return { content, reasoning, status, error, start, stop };
}
