// The two role rows: what each resting state reads as, what a provider click
// writes, and that Autocomplete never offers a hosted provider.
//
// The model picker is the native-menu-backed Select, so its options never
// enter the DOM; the displayed value and the hint copy are what is asserted,
// the way the chat model row's test does it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";

import { makeController, renderPane } from "../__tests__/harness";
import type { LlmConfig, LlmModel } from "../../lib/llm-types";
import { RoleSlotRows, NO_MODEL_HINT, NO_MODELS_LISTED } from "./ai-role-rows";

const llm = vi.hoisted(() => ({
  getConfig: vi.fn<() => Promise<LlmConfig>>(),
  setConfig: vi.fn<(p: unknown) => Promise<LlmConfig>>(),
  listModels: vi.fn<() => Promise<LlmModel[]>>(),
}));
vi.mock("../../lib/api", () => ({ api: { llm } }));

const BASE: LlmConfig = {
  provider: "ollama",
  model: "llama3.1:8b",
  baseUrls: {},
  roles: { chat: { provider: "ollama", model: "llama3.1:8b" } },
};

beforeEach(() => {
  llm.getConfig.mockReset().mockResolvedValue(BASE);
  llm.setConfig.mockReset().mockImplementation(async () => BASE);
  llm.listModels.mockReset().mockResolvedValue([]);
});

function renderRows(config: LlmConfig = BASE) {
  llm.getConfig.mockResolvedValue(config);
  return renderPane(<RoleSlotRows />, {
    controller: makeController({ provider: "ollama", model: "llama3.1:8b" }),
  });
}

describe("RoleSlotRows", () => {
  it("reads 'Same as chat' and 'Off' when neither slot is set, naming the chat model", async () => {
    renderRows();
    await waitFor(() => expect(llm.getConfig).toHaveBeenCalled());
    expect(screen.getByRole("radio", { name: "Same as chat" }).getAttribute("data-state")).toBe("on");
    expect(screen.getByRole("radio", { name: "Off" }).getAttribute("data-state")).toBe("on");
    expect(screen.getByTestId("llm-role-instant-using").textContent).toContain("Using the chat model: Ollama · llama3.1:8b.");
    expect(screen.getByTestId("llm-role-autocomplete-using").textContent).toContain("Off.");
    // No model picker until a provider is chosen.
    expect(screen.queryByLabelText("Instant helpers model")).toBeNull();
  });

  it("offers Claude for instant helpers and never for autocomplete", () => {
    renderRows();
    const instant = screen.getByLabelText("Instant helpers provider");
    const auto = screen.getByLabelText("Autocomplete provider");
    expect(instant.textContent).toContain("Claude");
    expect(auto.textContent).not.toContain("Claude");
    expect(auto.textContent).toContain("Ollama");
    expect(auto.textContent).toContain("LM Studio");
  });

  it("a provider click writes that role alone, with no model yet", async () => {
    renderRows();
    const instant = within(screen.getByLabelText("Instant helpers provider"));
    fireEvent.click(instant.getByRole("radio", { name: "LM Studio" }));
    await waitFor(() =>
      expect(llm.setConfig).toHaveBeenCalledWith({ roles: { instant: { provider: "lmstudio", model: null } } }),
    );
    expect(llm.setConfig).toHaveBeenCalledTimes(1);
  });

  it("turning autocomplete on writes a local slot, and 'Off' clears it with null", async () => {
    renderRows({ ...BASE, roles: { ...BASE.roles, autocomplete: { provider: "ollama", model: "qwen2.5-coder:1.5b" } } });
    await waitFor(() => expect(screen.getByTestId("llm-role-autocomplete-using").textContent).toContain("Using Ollama · qwen2.5-coder:1.5b."));
    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(llm.setConfig).toHaveBeenCalledWith({ roles: { autocomplete: null } }));

    llm.setConfig.mockClear();
    fireEvent.click(within(screen.getByLabelText("Autocomplete provider")).getByRole("radio", { name: "LM Studio" }));
    await waitFor(() =>
      expect(llm.setConfig).toHaveBeenCalledWith({ roles: { autocomplete: { provider: "lmstudio", model: null } } }),
    );
  });

  it("shows the picker with the saved model once a slot is set, even when the server lists nothing", async () => {
    llm.listModels.mockResolvedValue([{ id: "other", label: "other" }]);
    renderRows({ ...BASE, roles: { ...BASE.roles, instant: { provider: "ollama", model: "qwen2.5:3b" } } });
    const picker = await screen.findByLabelText("Instant helpers model");
    await waitFor(() => expect(picker.textContent).toContain("qwen2.5:3b"));
    expect(screen.queryByTestId("llm-role-instant-hint")).toBeNull();
  });

  it("asks for a model when the slot has none, and says so when the server cannot be listed", async () => {
    llm.listModels.mockResolvedValue([{ id: "qwen2.5-coder:1.5b", label: "qwen2.5-coder:1.5b" }]);
    renderRows({ ...BASE, roles: { ...BASE.roles, autocomplete: { provider: "ollama", model: null } } });
    await waitFor(() => expect(screen.getByTestId("llm-role-autocomplete-hint").textContent).toContain(NO_MODEL_HINT));

    llm.listModels.mockRejectedValue(new Error("ECONNREFUSED"));
    renderRows({ ...BASE, roles: { ...BASE.roles, instant: { provider: "lmstudio", model: null } } });
    await waitFor(() => expect(screen.getByTestId("llm-role-instant-hint").textContent).toContain(NO_MODELS_LISTED));
  });
});
