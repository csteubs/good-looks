// Integration tests for the Settings window shell.
//
// The panes are covered individually against a hand-built controller (see
// panes/*.test.tsx). What is left for this file is everything that only exists
// when the real thing is assembled: navigation, the search wiring that spans
// the sidebar AND the rows, the reset footer, Escape-to-close, and the fact
// that a control in a pane still reaches `recorder:setSettings` through the
// real provider rather than through a spy.
//
// The webhook and API-key write-only assertions that used to live here moved to
// panes/alerts-pane.test.tsx and panes/ai-pane.test.tsx, where the controls now
// are. They did not go away.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { RecorderSettings } from "../lib/recorder-types";
import { SETTINGS_DEFAULTS } from "../lib/settings-schema";
import { SettingsView } from "./settings-view";

const setSettings = vi.fn(async (_u: Partial<RecorderSettings>) => ({}) as RecorderSettings);
const closeSettings = vi.fn(async () => {});

let settings: Partial<RecorderSettings> = {};

vi.mock("../lib/api", () => ({
  api: {
    recorder: {
      getSettings: async () => settings as RecorderSettings,
      setSettings: (u: Partial<RecorderSettings>) => setSettings(u),
    },
    alerts: {
      status: async () => ({ hasUrl: false, host: null }),
      setWebhookUrl: async () => ({ hasUrl: true, host: "hooks.example.com" }),
      clearWebhookUrl: async () => ({ hasUrl: false, host: null }),
      test: async () => ({ ok: true }),
    },
    llm: {
      getConfig: async () => ({ provider: "ollama", model: "", baseUrls: {} }),
      setConfig: async () => ({ provider: "ollama", model: "", baseUrls: {} }),
      status: async () => ({ provider: "ollama", reachable: true, models: [], baseUrl: "http://x" }),
      detect: async () => [],
      setApiKey: async () => ({ hasKey: true }),
      clearApiKey: async () => ({ hasKey: false }),
      hasApiKey: async () => ({ hasKey: false }),
    },
    artifacts: {
      usage: async () => ({ bytes: 0, runs: 0, tests: 0 }),
      pruneNow: async () => ({ removedRuns: 0, freedBytes: 0 }),
    },
    debug: {
      shortcut: async () => "⌘⌥⇧S",
      capture: async () => ({ shots: [], error: null }),
      dir: async () => "/tmp",
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  settings = { ...SETTINGS_DEFAULTS, batchOrder: [] };
  (window as unknown as { glazeAPI: Record<string, unknown> }).glazeAPI = {
    glaze: { ipc: { invoke: closeSettings } },
    nativeTheme: {
      getInfo: vi.fn(async () => ({ themeSource: "system", shouldUseDarkColors: false })),
      setThemeSource: vi.fn(async () => {}),
    },
  };
});

/** Settings runs six async loads on mount. Anchor on the sidebar, which is
 *  rendered before any of them resolve, then let the pane settle. */
async function renderSettings() {
  render(<SettingsView />);
  await screen.findByText("Test defaults");
  // The default pane is Appearance; wait for a control it owns.
  await screen.findByRole("switch", { name: /ai thinking gif/i });
}

/** `SidebarListItem` activates on MOUSE-DOWN, not a bare click — see
 *  settings-nav.test.tsx. */
async function goToPane(title: string) {
  fireEvent.mouseDown(screen.getByRole("button", { name: new RegExp(title, "i") }));
  await screen.findByRole("heading", { name: new RegExp(title, "i") });
}

function search(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/search settings/i), { target: { value } });
}

describe("navigation", () => {
  it("opens on Appearance", async () => {
    await renderSettings();
    expect(screen.getByRole("heading", { name: /appearance/i })).toBeTruthy();
  });

  it("shows only the selected pane's controls", async () => {
    await renderSettings();
    // Headless lives in Test defaults, not Appearance.
    expect(screen.queryByRole("switch", { name: /headless/i })).toBeNull();
    await goToPane("Test defaults");
    expect(screen.getByRole("switch", { name: /headless/i })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /ai thinking gif/i })).toBeNull();
  });

  it("puts the pane's name in the window toolbar", async () => {
    await renderSettings();
    await goToPane("Storage");
    expect(screen.getByRole("heading", { name: /storage/i })).toBeTruthy();
  });

  it("shows the pane subtitle", async () => {
    await renderSettings();
    await goToPane("Test defaults");
    // The fact that used to be repeated in half the row descriptions.
    expect(screen.getByText(/Every one can be overridden per test/i)).toBeTruthy();
  });

  it("reaches every pane", async () => {
    await renderSettings();
    for (const title of [
      "Recording",
      "Test defaults",
      "Auto-Heal",
      "Storage",
      "AI",
      "Alerts",
      "Advanced",
      "Appearance",
    ]) {
      await goToPane(title);
    }
  });
});

describe("a control still reaches the backend", () => {
  it("persists through the real provider, not a spy", async () => {
    await renderSettings();
    await goToPane("Test defaults");
    fireEvent.click(screen.getByRole("switch", { name: /headless/i }));
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ defaultRunHeadless: true }),
      ),
    );
  });

  it("sends one key per call, so the backend merge is unambiguous", async () => {
    // Every feature writes settings independently; a patch carrying unrelated
    // keys would let one pane's stale copy overwrite another's write.
    await renderSettings();
    await goToPane("Test defaults");
    fireEvent.click(screen.getByRole("switch", { name: /headless/i }));
    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    expect(Object.keys(setSettings.mock.calls[0][0])).toEqual(["defaultRunHeadless"]);
  });

  it("reflects a stored value rather than a hardcoded default", async () => {
    settings = { ...settings, defaultTestTimeoutMs: 180_000 };
    await renderSettings();
    await goToPane("Test defaults");
    const input = screen.getByRole("spinbutton", {
      name: /default test timeout/i,
    }) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("180"));
  });

  it("survives a settings load that resolves to nothing", async () => {
    // A RESOLVED null does not reach the catch. It used to go straight into
    // state, and the first pane to read a key off it crashed the window — the
    // sidebar still rendered, so the failure looked like a blank content area
    // rather than an error.
    settings = null as unknown as Partial<RecorderSettings>;
    render(<SettingsView />);
    expect(await screen.findByText("Test defaults")).toBeTruthy();
    // The PANE, not just the sidebar.
    expect(await screen.findByRole("switch", { name: /ai thinking gif/i })).toBeTruthy();
  });
});

describe("search", () => {
  it("narrows the sidebar to panes that hold a match", async () => {
    await renderSettings();
    search("headers");
    await waitFor(() => expect(screen.queryByText("Storage")).toBeNull());
    // By role, not by text: the search also moves the selection to this pane,
    // so its title is on screen twice — sidebar row and window toolbar. A bare
    // getByText would fail as ambiguous and read as "the row vanished".
    expect(screen.getByRole("button", { name: /test defaults/i })).toBeTruthy();
  });

  it("narrows the pane to the matching rows", async () => {
    settings = { ...settings, defaultRecordLogs: true };
    await renderSettings();
    search("headers");
    expect(
      await screen.findByRole("switch", { name: /include all request headers/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /headless/i })).toBeNull();
  });

  it("moves off a pane the search emptied", async () => {
    // Staying put would show an empty pane beside a sidebar advertising
    // matches elsewhere.
    await renderSettings();
    expect(screen.getByRole("heading", { name: /appearance/i })).toBeTruthy();
    search("webkit");
    await waitFor(() => expect(screen.getByRole("heading", { name: /test defaults/i })).toBeTruthy());
  });

  it("shows an empty state when nothing matches", async () => {
    await renderSettings();
    search("zzzznotasetting");
    expect(await screen.findByText(/No settings match/i)).toBeTruthy();
  });

  it("names the query in the empty state", async () => {
    await renderSettings();
    search("zzzznotasetting");
    expect(await screen.findByText(/zzzznotasetting/)).toBeTruthy();
  });

  it("restores the whole window when the search is cleared", async () => {
    await renderSettings();
    search("headers");
    await waitFor(() => expect(screen.queryByText("Storage")).toBeNull());
    search("");
    await waitFor(() => expect(screen.getByText("Storage")).toBeTruthy());
    expect(screen.getByRole("switch", { name: /ai thinking gif/i })).toBeTruthy();
  });

  it("treats a whitespace-only query as no search", async () => {
    await renderSettings();
    search("   ");
    await waitFor(() => expect(screen.getByText("Storage")).toBeTruthy());
    expect(screen.queryByText(/No settings match/i)).toBeNull();
  });
});

describe("the reset footer", () => {
  it("is absent when the pane is at its defaults", async () => {
    await renderSettings();
    await goToPane("Auto-Heal");
    expect(screen.queryByRole("button", { name: /reset section/i })).toBeNull();
  });

  it("appears once something differs", async () => {
    settings = { ...settings, autoHealRetries: 9 };
    await renderSettings();
    await goToPane("Auto-Heal");
    expect(await screen.findByText(/1 setting differs from the default/i)).toBeTruthy();
  });

  it("counts more than one", async () => {
    settings = { ...settings, autoHealRetries: 9, autoHealEnabled: false };
    await renderSettings();
    await goToPane("Auto-Heal");
    expect(await screen.findByText(/2 settings differ from the default/i)).toBeTruthy();
  });

  it("writes every one of the pane's keys back to its default", async () => {
    settings = { ...settings, autoHealRetries: 9 };
    await renderSettings();
    await goToPane("Auto-Heal");
    fireEvent.click(await screen.findByRole("button", { name: /reset section/i }));
    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    expect(setSettings).toHaveBeenCalledWith({
      autoHealEnabled: true,
      autoHealApply: "suggest",
      autoHealRetries: 3,
      autoHealAttemptTimeoutMs: 4000,
    });
  });

  it("never touches a credential", async () => {
    // safeStorage holds the webhook URL and the API key; this window cannot
    // read one back, so it must not be able to delete one either.
    settings = { ...settings, notifyOnRunIssues: true };
    await renderSettings();
    await goToPane("Alerts");
    fireEvent.click(await screen.findByRole("button", { name: /reset section/i }));
    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    const patch = setSettings.mock.calls[0][0];
    expect(Object.keys(patch).slice().sort()).toEqual(["alertWebhookEnabled", "notifyOnRunIssues"]);
  });

  it("is hidden while a search is running", async () => {
    // The footer describes a whole pane; with the pane filtered to two rows it
    // would be counting settings that aren't on screen.
    settings = { ...settings, autoHealRetries: 9 };
    await renderSettings();
    await goToPane("Auto-Heal");
    await screen.findByRole("button", { name: /reset section/i });
    search("heal");
    await waitFor(() => expect(screen.queryByRole("button", { name: /reset section/i })).toBeNull());
  });
});

describe("escape closes the window", () => {
  it("closes on Escape", async () => {
    await renderSettings();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeSettings).toHaveBeenCalledWith("window:closeSettings");
  });

  it("does not close while a text field has focus", async () => {
    // Escape in a field is the field's own — clearing it, or dismissing its
    // completion — and must not take the window with it.
    await renderSettings();
    await goToPane("Storage");
    const input = screen.getByLabelText(/screenshot history per test/i);
    input.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it("does not close when a popover is open", async () => {
    await renderSettings();
    const popper = document.createElement("div");
    popper.setAttribute("data-radix-popper-content-wrapper", "");
    document.body.appendChild(popper);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeSettings).not.toHaveBeenCalled();
    popper.remove();
  });

  it("ignores an Escape another handler already dealt with", async () => {
    await renderSettings();
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it("ignores other keys", async () => {
    await renderSettings();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(closeSettings).not.toHaveBeenCalled();
  });
});
