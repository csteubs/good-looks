// The inline AI panel: what it sends, what it shows, and what Apply hands
// back. The chat is the real hook over a mocked `api`, with the push channels
// driven by hand — so a streamed answer is a sequence of chunks, the way the
// backend sends one.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { ScriptAiPanel, extractReplacement, hostedCapAllows, resetHostedCapForTesting, HOSTED_CAP_MESSAGE, HOSTED_PER_MINUTE } from "./script-ai-panel";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (p: unknown) => void>();
  return {
    handlers,
    chat: vi.fn<(params: unknown) => Promise<{ requestId: string; provider: string; model: string }>>(async () => ({ requestId: "r1", provider: "ollama", model: "m" })),
    cancel: vi.fn(async () => {}),
    getConfig: vi.fn(async () => ({ provider: "ollama", model: "qwen", baseUrls: {}, roles: { chat: { provider: "ollama", model: "qwen" } } })),
    previewScript: vi.fn(async () => ({ tracked: true, steps: 1, skipped: 0, stepRanges: [], skippedRanges: [], newlySkipped: [] as string[], stepList: [] })),
  };
});
vi.mock("../lib/api", () => ({
  api: {
    llm: { chat: mocks.chat, cancel: mocks.cancel, getConfig: mocks.getConfig },
    tests: { previewScript: mocks.previewScript },
    on: (channel: string, handler: (p: unknown) => void) => {
      mocks.handlers.set(channel, handler);
      return () => mocks.handlers.delete(channel);
    },
  },
}));

function budget(): HTMLElement {
  return document.querySelector('[data-gl="ai-budget"]') as HTMLElement;
}

function push(channel: string, payload: unknown) {
  act(() => mocks.handlers.get(channel)?.(payload));
}

const SPEC = 'import { test } from "@playwright/test";\ntest("t", async ({ page }) => {\n  await page.goto("https://a.example");\n});\n';

function renderPanel(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  mocks.chat.mockClear();
  mocks.previewScript.mockClear();
  mocks.getConfig.mockClear();
  resetHostedCapForTesting();
});

describe("<ScriptAiPanel /> rewrite", () => {
  it("sends the instruction on the chat slot, shows the budget line, and applies the whole file", async () => {
    const onApply = vi.fn();
    renderPanel(
      <ScriptAiPanel mode="rewrite" testId="t1" testName="T" testUrl="https://a.example" script={SPEC} selection={null} caretLine={1} failure={null} onApply={onApply} onClose={() => {}} />,
    );
    expect(screen.getByText("Rewrite the whole file")).toBeTruthy();
    await waitFor(() => expect(budget().textContent).toContain("Ollama · qwen"));
    expect(budget().textContent).toMatch(/Sending the whole file · ≈\d+ tokens/);

    const input = screen.getByLabelText("What should change?") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Add a heading assertion" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1));
    const params = mocks.chat.mock.calls[0][0] as unknown as { role: string; messages: { content: string }[] };
    expect(params.role).toBe("chat");
    expect(params.messages[1].content).toContain("Request: Add a heading assertion");

    const fixed = SPEC.replace("});\n", '  await expect(page.getByRole("heading")).toBeVisible();\n});\n');
    push("llm:chunk", { requestId: "r1", delta: "Here you go.\n```ts\n" + fixed });
    push("llm:chunk", { requestId: "r1", delta: "```\n" });
    push("llm:done", { requestId: "r1" });

    await screen.findByText(/Review \(\+1 \/ −0 lines\)/);
    expect(screen.getByText("Here you go.")).toBeTruthy();
    await waitFor(() => expect(mocks.previewScript).toHaveBeenCalledWith("t1", fixed));
    fireEvent.click(screen.getByRole("button", { name: "Apply to the editor" }));
    expect(onApply).toHaveBeenCalledWith(fixed, { affordance: "inline-rewrite", provider: "ollama", model: "qwen", promptVersion: "inline-1" });
  });

  it("a selection rewrite splices the block into the span, and says when the step list loses statements", async () => {
    mocks.previewScript.mockResolvedValueOnce({ tracked: true, steps: 1, skipped: 1, stepRanges: [], skippedRanges: [], newlySkipped: ["await page.waitForTimeout(1)"], stepList: [] });
    const onApply = vi.fn<(next: string, meta: unknown) => void>();
    const from = SPEC.indexOf("  await page.goto");
    const to = SPEC.indexOf("\n});");
    renderPanel(
      <ScriptAiPanel mode="rewrite" testId="t1" testName="T" testUrl="https://a.example" script={SPEC} selection={{ from, to, text: SPEC.slice(from, to) }} caretLine={3} failure={null} onApply={onApply} onClose={() => {}} />,
    );
    expect(screen.getByText("Rewrite lines 3–3")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("What should change in the selection?"), { target: { value: "wait first" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1));
    push("llm:chunk", { requestId: "r1", delta: "```ts\n  await page.waitForTimeout(1);\n  await page.goto(\"https://a.example\");\n```" });
    push("llm:done", { requestId: "r1" });
    await screen.findByText(/Review/);
    await screen.findByText("1 new statement the step list can't show — it still runs, but reads as code.");
    fireEvent.click(screen.getByRole("button", { name: "Apply to the editor" }));
    const next = onApply.mock.calls[0][0];
    expect(next).toBe(SPEC.slice(0, from) + '  await page.waitForTimeout(1);\n  await page.goto("https://a.example");' + SPEC.slice(to));
  });

  it("an answer with no applicable block says so instead of offering Apply", async () => {
    renderPanel(
      <ScriptAiPanel mode="rewrite" testId="t1" testName="T" testUrl="https://a.example" script={SPEC} selection={null} caretLine={1} failure={null} onApply={() => {}} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText("What should change?"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1));
    push("llm:chunk", { requestId: "r1", delta: "Change line 3 to use getByRole." });
    push("llm:done", { requestId: "r1" });
    await screen.findByText(/The answer had no complete file to apply/);
    expect(screen.queryByRole("button", { name: "Apply to the editor" })).toBeNull();
  });

  it("caps hosted requests from the editor", async () => {
    mocks.getConfig.mockResolvedValue({ provider: "anthropic", model: "claude", baseUrls: {}, roles: { chat: { provider: "anthropic", model: "claude" } } });
    const now = Date.now();
    for (let i = 0; i < HOSTED_PER_MINUTE; i++) expect(hostedCapAllows(now + i)).toBe(true);
    renderPanel(
      <ScriptAiPanel mode="rewrite" testId="t1" testName="T" testUrl="https://a.example" script={SPEC} selection={null} caretLine={1} failure={null} onApply={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(budget().textContent).toContain("Claude"));
    fireEvent.change(screen.getByLabelText("What should change?"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await screen.findByText(HOSTED_CAP_MESSAGE);
    expect(mocks.chat).not.toHaveBeenCalled();
    // The window slides: a minute on, the cap allows again.
    expect(hostedCapAllows(now + 61_000)).toBe(true);
  });
});

describe("<ScriptAiPanel /> explain", () => {
  it("asks on the instant slot straight away and shows prose; Escape closes", async () => {
    const onClose = vi.fn();
    renderPanel(
      <ScriptAiPanel mode="explain" testId="t1" testName="T" testUrl="https://a.example" script={SPEC} selection={null} caretLine={3} failure={{ index: 0, label: "Open https://a.example", output: "Error: net::ERR" }} onApply={() => {}} onClose={onClose} />,
    );
    expect(screen.getByText("Explain the failure at line 3")).toBeTruthy();
    await waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1));
    const params = mocks.chat.mock.calls[0][0] as unknown as { role: string; messages: { content: string }[] };
    expect(params.role).toBe("instant");
    expect(params.messages[1].content).toContain("Failed step: 1 — Open https://a.example");
    expect(params.messages[1].content).toContain('Caret: line 3: await page.goto("https://a.example");');
    expect(screen.queryByLabelText("What should change?")).toBeNull();
    push("llm:chunk", { requestId: "r1", delta: "The page never loaded." });
    push("llm:done", { requestId: "r1" });
    await screen.findByText("The page never loaded.");
    fireEvent.keyDown(screen.getByRole("region", { name: "Explain the failure" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("extractReplacement", () => {
  it("wants a whole file for the file scope and any closed block for a selection", () => {
    expect(extractReplacement("```ts\nawait x();\n```", false)).toBeNull();
    expect(extractReplacement("```ts\nawait x();\n```", true)).toBe("await x();");
    expect(extractReplacement("```ts\nawait x();", true)).toBeNull();
  });
});
