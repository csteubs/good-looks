// The model picker in "Generate test from prompt".
//
// Two things are pinned here, and both fail silently in the real app.
//
// 1. WHICH MODEL THE GENERATION RUNS ON. The dialog used to re-read the
//    app-wide default at send time, so a per-test choice had nowhere to live.
//    Now the picked model is what `llm.chat` receives — and if that wiring
//    broke, the dialog would still show the chosen name while a different model
//    wrote the spec. Nothing on screen would contradict it.
//
// 2. WHETHER THE MODEL IS IN MEMORY. On LM Studio a cold model produces no
//    output for as long as loading takes, which from here is indistinguishable
//    from a hang. The badge is the only warning, and a badge that says the wrong
//    thing is worse than none.
//
// The SDK's Select is native-menu-backed, so its options never enter the DOM
// and a choice can't be driven in jsdom (see CLAUDE.md). What IS observable is
// the trigger's displayed value and what `llm.chat` was handed, which is the
// contract that matters.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { LlmConfig, LlmModel, LlmProviderStatus } from "../lib/llm-types";
import { GenerateTestDialog } from "./generate-test-dialog";

const chat = vi.fn(async (_params: unknown) => ({ requestId: "req-1" }));

let config: LlmConfig = { provider: "lmstudio", model: "qwen3-8b", baseUrls: {} };
let recorderSettings: { defaultRunBrowser?: string } = {};
let status: LlmProviderStatus = {
  provider: "lmstudio",
  reachable: true,
  baseUrl: "http://127.0.0.1:1234",
  models: [],
};

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

vi.mock("../lib/api", () => ({
  api: {
    llm: {
      getConfig: async () => config,
      status: async () => status,
      chat: (params: unknown) => chat(params),
      cancel: async () => {},
    },
    tests: { createFromPrompt: vi.fn() },
    recorder: { getSettings: async () => recorderSettings },
    on: () => () => {},
  },
}));

/** The model list the provider reports, with load state where it has one. */
function withModels(models: LlmModel[], overrides: Partial<LlmProviderStatus> = {}) {
  status = { ...status, models, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  config = { provider: "lmstudio", model: "qwen3-8b", baseUrls: {} };
  recorderSettings = {};
  status = {
    provider: "lmstudio",
    reachable: true,
    baseUrl: "http://127.0.0.1:1234",
    models: [],
  };
});

function open() {
  render(<GenerateTestDialog open onOpenChange={vi.fn()} />);
}

/** Fill the required fields and press Generate. */
async function generate() {
  fireEvent.change(screen.getByPlaceholderText("https://example.com"), {
    target: { value: "https://example.com" },
  });
  fireEvent.change(screen.getByPlaceholderText(/Go to the URL/), {
    target: { value: "Log in and assert the dashboard" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));
  await waitFor(() => expect(chat).toHaveBeenCalled());
  return chat.mock.calls[0]?.[0] as { model?: string };
}

describe("model picker", () => {
  it("offers a model to generate with", async () => {
    // The gap this closes: the dialog asked for a name, URL, speed and
    // viewport, and gave no way to say which model should write the test.
    withModels([{ id: "qwen3-8b", label: "qwen3-8b" }]);
    open();
    await waitFor(() => expect(screen.getByText("Model")).toBeTruthy());
  });

  it("starts on the configured default", async () => {
    withModels([
      { id: "gemma-3-27b", label: "gemma-3-27b" },
      { id: "qwen3-8b", label: "qwen3-8b" },
    ]);
    open();
    await waitFor(() => expect(screen.getByText("qwen3-8b")).toBeTruthy());
  });

  it("generates with the picked model rather than re-reading the default", async () => {
    withModels([{ id: "qwen3-8b", label: "qwen3-8b" }]);
    open();
    await waitFor(() => expect(screen.getByText("qwen3-8b")).toBeTruthy());

    expect((await generate()).model).toBe("qwen3-8b");
  });

  it("falls back to a real model when the configured one is gone", async () => {
    // Deleted or renamed in the provider since it was chosen. Sending it
    // anyway fails mid-generation, naming a model the user doesn't recognize.
    config = { provider: "lmstudio", model: "deleted-model", baseUrls: {} };
    withModels([
      { id: "gemma-3-27b", label: "gemma-3-27b", loaded: false },
      { id: "qwen3-8b", label: "qwen3-8b", loaded: true },
    ]);
    open();

    // Prefers one already in memory over merely the first in the list.
    await waitFor(() => expect(screen.getByText("qwen3-8b")).toBeTruthy());
    expect((await generate()).model).toBe("qwen3-8b");
  });

  it("keeps the configured model when the provider can't be reached", async () => {
    // No list to choose from is not a reason to change what gets sent.
    withModels([], { reachable: false, error: "Could not reach LM Studio." });
    open();

    await waitFor(() => expect(screen.getByText("Could not reach LM Studio.")).toBeTruthy());
    expect((await generate()).model).toBe("qwen3-8b");
  });
});

describe("load state", () => {
  it("says when the selected model is already in memory", async () => {
    withModels([{ id: "qwen3-8b", label: "qwen3-8b", loaded: true }]);
    open();
    await waitFor(() => expect(screen.getByText("Loaded")).toBeTruthy());
    expect(screen.queryByText("Not loaded")).toBeNull();
  });

  it("warns that a cold model stalls before it answers", async () => {
    // The whole point: no output for a long time is the expected behaviour
    // here, not a hang, and only this says so.
    config = { provider: "lmstudio", model: "gemma-3-27b", baseUrls: {} };
    withModels([{ id: "gemma-3-27b", label: "gemma-3-27b", loaded: false }]);
    open();

    await waitFor(() => expect(screen.getByText("Not loaded")).toBeTruthy());
    expect(screen.getByText(/loads on the first request/i)).toBeTruthy();
  });

  it("claims nothing for a provider that doesn't report load state", async () => {
    // Ollama and Claude never say. Showing "Not loaded" there would be a
    // confident lie about a fact we don't have, and unfixable from the UI.
    config = { provider: "ollama", model: "llama3.2", baseUrls: {} };
    withModels([{ id: "llama3.2", label: "llama3.2" }], { provider: "ollama" });
    open();

    await waitFor(() => expect(screen.getByText("llama3.2")).toBeTruthy());
    expect(screen.queryByText("Loaded")).toBeNull();
    expect(screen.queryByText("Not loaded")).toBeNull();
  });
});

// ── The browser picker ────────────────────────────────────────────────────
describe("browser picker", () => {
  it("offers an engine, seeded from the global default", async () => {
    recorderSettings = { defaultRunBrowser: "webkit" };
    render(<GenerateTestDialog open onOpenChange={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "WebKit" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
  });
});
