// Shared test wrapper for views that consume the AI debug store.
//
// The provider sits above the router in the real app, so any view rendered in
// isolation needs it here too. Kept in one place because the alternative — each
// suite wrapping ad hoc — is how a provider ends up subtly configured
// differently per test, and then a store bug reproduces in one suite only.

import * as React from "react";

import { AiDebugProvider } from "../main/ai-debug-store";

export function withAiDebug(node: React.ReactNode): React.ReactElement {
  return <AiDebugProvider>{node}</AiDebugProvider>;
}

/** The `api.aiDebug` / `api.llm` surface the provider touches on mount, for
 *  suites whose api mock is otherwise unrelated to AI debugging. Every method
 *  resolves so hydration completes instead of hanging the effect. */
export function aiDebugApiMock() {
  return {
    aiDebug: {
      list: async () => [],
      save: async (session: unknown) => session,
      remove: async () => ({ removed: 0 }),
      clear: async () => ({ removed: 0 }),
    },
    llm: {
      getConfig: async () => ({ provider: "ollama", model: null, baseUrls: {} }),
      status: async () => ({ online: false, models: [] }),
      setConfig: async () => ({}),
      chat: async () => ({ requestId: "req-test" }),
      cancel: async () => {},
      isActive: async () => ({ active: false }),
    },
  };
}
