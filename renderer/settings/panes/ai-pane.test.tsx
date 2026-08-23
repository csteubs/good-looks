// Tests for the AI pane.
//
// The Anthropic API key is the window's other write-only credential. It is
// never read back from the backend, so the only place one can linger is this
// component's own input state — which is why "clears the field after saving"
// is a security assertion here and not a tidiness one.
//
// The provider radio drives which half of the pane exists at all, so most of
// the rest is about not showing a local-server control to someone on Claude,
// or vice versa.

import { describe, it, expect } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";

import { makeController, renderPane } from "../__tests__/harness";
import { AiPane } from "./ai-pane";

const REACHABLE = {
  provider: "ollama" as const,
  reachable: true,
  models: [
    { id: "qwen2.5:7b", label: "Qwen 2.5 7B" },
    { id: "llama3.1:8b", label: "Llama 3.1 8B" },
  ],
  baseUrl: "http://127.0.0.1:11434",
};

describe("provider selection", () => {
  it("offers all three providers", () => {
    renderPane(<AiPane />);
    // Scoped to the provider RadioGroup: the role rows below offer the same
    // provider names as toggle items, which also carry role="radio".
    const group = within(document.getElementById("llm-provider") as HTMLElement);
    for (const name of ["Ollama", "LM Studio", "Claude"]) {
      expect(group.getByRole("radio", { name }), name).toBeTruthy();
    }
  });

  it("switches provider", async () => {
    const { controller } = renderPane(<AiPane />);
    fireEvent.click(within(document.getElementById("llm-provider") as HTMLElement).getByRole("radio", { name: "Claude" }));
    await waitFor(() => expect(controller.changeProvider).toHaveBeenCalledWith("anthropic"));
  });

  it("promises no data leaves the machine on a local provider", () => {
    renderPane(<AiPane />);
    expect(screen.getByText(/No data leaves your computer/i)).toBeTruthy();
  });

  it("says where prompts go on Claude", () => {
    // The counterpart claim. Getting these two swapped would be a privacy
    // statement that is exactly backwards.
    const controller = makeController({ provider: "anthropic" });
    renderPane(<AiPane />, { controller });
    expect(screen.getByText(/api\.anthropic\.com/i)).toBeTruthy();
    expect(screen.queryByText(/No data leaves your computer/i)).toBeNull();
  });
});

describe("local server controls", () => {
  it("shows the server URL for a local provider", () => {
    renderPane(<AiPane />);
    expect(screen.getByLabelText(/server url/i)).toBeTruthy();
  });

  it("hides the server URL on Claude", () => {
    const controller = makeController({ provider: "anthropic" });
    renderPane(<AiPane />, { controller });
    expect(screen.queryByLabelText(/server url/i)).toBeNull();
  });

  it("edits locally and commits on blur", () => {
    // Committing per keystroke would write a config for every partial URL and
    // re-probe the server on each one.
    const { controller } = renderPane(<AiPane />);
    const field = screen.getByLabelText(/server url/i);
    fireEvent.change(field, { target: { value: "http://127.0.0.1:9999" } });
    expect(controller.setBaseUrl).toHaveBeenCalledWith("http://127.0.0.1:9999");
    expect(controller.commitBaseUrl).not.toHaveBeenCalled();

    fireEvent.blur(field, { target: { value: "http://127.0.0.1:9999" } });
    expect(controller.commitBaseUrl).toHaveBeenCalledWith("http://127.0.0.1:9999");
  });

  it("tests the connection", async () => {
    const { controller } = renderPane(<AiPane />);
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    await waitFor(() => expect(controller.testConnection).toHaveBeenCalledTimes(1));
  });

  it("shows online when reachable", () => {
    const controller = makeController({ llmStatus: REACHABLE });
    renderPane(<AiPane />, { controller });
    expect(screen.getByText(/online/i)).toBeTruthy();
  });

  it("shows the reason it is offline rather than a bare status", () => {
    const controller = makeController({
      llmStatus: { ...REACHABLE, reachable: false, models: [], error: "Could not reach Ollama." },
    });
    renderPane(<AiPane />, { controller });
    expect(screen.getByText(/offline/i)).toBeTruthy();
    expect(screen.getByText(/Could not reach Ollama\./)).toBeTruthy();
  });

  it("shows the default URL as a hint when nothing is wrong", () => {
    renderPane(<AiPane />);
    expect(screen.getByText(/Default: http:\/\/127\.0\.0\.1:11434/)).toBeTruthy();
  });
});

describe("the API key is write-only", () => {
  it("is masked", () => {
    const controller = makeController({ provider: "anthropic" });
    renderPane(<AiPane />, { controller });
    expect(screen.getByLabelText(/api key/i).getAttribute("type")).toBe("password");
  });

  it("hands the key over and clears the field", async () => {
    // The only copy of the key in the renderer is this input's value; the
    // backend never hands one back. Leaving it there keeps a credential in
    // component state for the rest of the session.
    const controller = makeController({ provider: "anthropic" });
    renderPane(<AiPane />, { controller });
    const field = screen.getByLabelText(/api key/i) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "sk-ant-SECRET" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(controller.saveApiKey).toHaveBeenCalledWith("sk-ant-SECRET"));
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("refuses to save an empty or whitespace key", () => {
    const controller = makeController({ provider: "anthropic" });
    renderPane(<AiPane />, { controller });
    const save = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "   " } });
    expect(save.disabled).toBe(true);
  });

  it("never renders a stored key", () => {
    // `hasApiKey` is a boolean; there is no way to get the key itself back.
    const controller = makeController({ provider: "anthropic", hasApiKey: true });
    renderPane(<AiPane />, { controller });
    expect((screen.getByLabelText(/api key/i) as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toMatch(/sk-ant-/);
  });

  it("offers Clear only once a key is stored", () => {
    const { unmount } = renderPane(<AiPane />, {
      controller: makeController({ provider: "anthropic" }),
    });
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
    unmount();

    const controller = makeController({ provider: "anthropic", hasApiKey: true });
    renderPane(<AiPane />, { controller });
    expect(screen.getByRole("button", { name: /clear/i })).toBeTruthy();
  });

  it("clears the stored key", async () => {
    const controller = makeController({ provider: "anthropic", hasApiKey: true });
    renderPane(<AiPane />, { controller });
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    await waitFor(() => expect(controller.clearApiKey).toHaveBeenCalledTimes(1));
  });

  it("reports not connected when a stored key fails to reach Claude", () => {
    const controller = makeController({
      provider: "anthropic",
      hasApiKey: true,
      llmStatus: { ...REACHABLE, provider: "anthropic", reachable: false, models: [] },
    });
    renderPane(<AiPane />, { controller });
    expect(screen.getByText(/not connected/i)).toBeTruthy();
  });
});

describe("LM Studio API token", () => {
  // The token only exists because LM Studio can be configured to require one,
  // in which case every request 401s and the provider is simply unusable. The
  // field is therefore LM-Studio-only: Ollama has no such setting, and offering
  // a credential field for it would invite people to invent a problem.
  it("offers the token field only on LM Studio", () => {
    const lms = renderPane(<AiPane />, { controller: makeController({ provider: "lmstudio" }) });
    expect(screen.getByLabelText(/api token/i)).toBeTruthy();
    lms.unmount();

    renderPane(<AiPane />, { controller: makeController({ provider: "ollama" }) });
    expect(screen.queryByLabelText(/api token/i)).toBeNull();
  });

  it("is absent on Claude, which uses the API key field instead", () => {
    renderPane(<AiPane />, { controller: makeController({ provider: "anthropic" }) });
    expect(screen.queryByLabelText(/api token/i)).toBeNull();
    expect(screen.getByLabelText(/api key/i)).toBeTruthy();
  });

  it("saves the token and clears the field afterwards", async () => {
    // Same reasoning as the Anthropic key: the backend never hands it back, so
    // this input is the only place a copy could linger for the session.
    const controller = makeController({ provider: "lmstudio" });
    renderPane(<AiPane />, { controller });
    const field = screen.getByLabelText(/api token/i) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "lms-SECRET" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(controller.saveLmStudioToken).toHaveBeenCalledWith("lms-SECRET"));
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("never renders a stored token, and masks what is typed", () => {
    const controller = makeController({ provider: "lmstudio", hasLmStudioToken: true });
    renderPane(<AiPane />, { controller });
    const field = screen.getByLabelText(/api token/i) as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.type).toBe("password");
  });

  it("refuses to save an empty or whitespace token", () => {
    const controller = makeController({ provider: "lmstudio" });
    renderPane(<AiPane />, { controller });
    const save = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: "  " } });
    expect(save.disabled).toBe(true);
  });

  it("offers Clear only once a token is stored, and clears it", async () => {
    const { unmount } = renderPane(<AiPane />, {
      controller: makeController({ provider: "lmstudio" }),
    });
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
    unmount();

    const controller = makeController({ provider: "lmstudio", hasLmStudioToken: true });
    renderPane(<AiPane />, { controller });
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    await waitFor(() => expect(controller.clearLmStudioToken).toHaveBeenCalledTimes(1));
  });

  it("surfaces the backend's auth message on the server row rather than a bare Offline", () => {
    // The whole point of the decoded 401 is that it reaches a human. The row
    // shows `llmStatus.error` in place of the default-URL summary, so a status
    // dot alone would strand the one sentence that says what to do.
    const controller = makeController({
      provider: "lmstudio",
      llmStatus: {
        provider: "lmstudio",
        reachable: false,
        models: [],
        baseUrl: "http://127.0.0.1:1234",
        hasToken: false,
        error: "LM Studio requires an API token and none is saved. Paste the token from LM Studio (Developer → server settings) into Settings → AI, or turn authentication off there.",
      },
    });
    renderPane(<AiPane />, { controller });
    expect(screen.getByText(/requires an API token and none is saved/i)).toBeTruthy();
  });
});

describe("model picker", () => {
  it("is absent until a provider is reachable", () => {
    renderPane(<AiPane />);
    expect(screen.queryByRole("combobox", { name: /model/i })).toBeNull();
  });

  it("is absent when reachable but no models are loaded", () => {
    // "Connected, but no models are loaded" — an empty picker would read as a
    // broken control rather than an empty Ollama.
    const controller = makeController({ llmStatus: { ...REACHABLE, models: [] } });
    renderPane(<AiPane />, { controller });
    expect(screen.queryByRole("combobox", { name: /model/i })).toBeNull();
  });

  it("shows the selected model", () => {
    const controller = makeController({ llmStatus: REACHABLE, model: "llama3.1:8b" });
    renderPane(<AiPane />, { controller });
    expect(screen.getByRole("combobox", { name: /model/i }).textContent).toContain("Llama 3.1 8B");
  });
});

describe("the experimental rows have left this pane", () => {
  // B4 moved both into their own Experiments pane — they change how a RUN
  // behaves, and nobody asking "why did my script change?" would look for the
  // answer under which model answers questions. Asserted here rather than
  // deleted, because the failure mode of the move is a row rendering in BOTH
  // panes: two switches writing the same key, and whichever the user did not
  // touch keeps reporting the old value until it re-renders.
  it("no longer renders either toggle", () => {
    renderPane(<AiPane />);
    expect(screen.queryByRole("switch", { name: /keep a running AI debug job/i })).toBeNull();
    expect(screen.queryByRole("switch", { name: /apply AI debug fixes automatically/i })).toBeNull();
  });

  it("no longer carries an Experimental section heading", () => {
    renderPane(<AiPane />);
    expect(screen.queryByText("Experimental")).toBeNull();
  });
});

describe("search filtering", () => {
  it("shows only the matched row", () => {
    renderPane(<AiPane />, { matchedIds: ["llm-server-url"] });
    expect(screen.getByRole("textbox", { name: /server url/i })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Ollama" })).toBeNull();
  });
});
