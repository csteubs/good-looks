// Renderer hook for a single streaming llm:chat request. Subscribes to the
// llm:chunk/done/error push events (see main/services/llm-service.ts) filtered
// by the request's own requestId, so multiple hook instances don't cross-talk.

import * as React from "react";

import { api } from "./api";
import type { LlmMessage } from "./llm-types";

export type LlmChatStatus = "idle" | "streaming" | "done" | "error" | "cancelled";

export function useLlmChat() {
  const [content, setContent] = React.useState("");
  const [status, setStatus] = React.useState<LlmChatStatus>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const requestIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const offChunk = api.on<{ requestId: string; delta: string }>("llm:chunk", ({ requestId, delta }) => {
      if (requestId !== requestIdRef.current) return;
      setContent((c) => c + delta);
    });
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

  const start = React.useCallback(async (messages: LlmMessage[]) => {
    setContent("");
    setError(null);
    setStatus("streaming");
    try {
      const { requestId } = await api.llm.chat({ messages });
      requestIdRef.current = requestId;
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const stop = React.useCallback(() => {
    if (requestIdRef.current) void api.llm.cancel(requestIdRef.current);
  }, []);

  return { content, status, error, start, stop };
}
