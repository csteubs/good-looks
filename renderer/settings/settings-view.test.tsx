// Component tests for the Settings window.
//
// 1,015 lines and previously 0% covered. Almost every control here writes to
// persisted state, and the two that matter most are security-relevant: the
// Anthropic API key and the alert webhook URL. Both are write-only by design —
// the renderer can save or clear them but must never be able to read one back —
// so these tests assert on what CROSSES the boundary, not just on what renders.
//
// The rest is a wide surface of small persistence handlers, where the failure
// mode is silent: a toggle that looks right and saves nothing.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { RecorderSettings } from "../lib/recorder-types";
import { SettingsView } from "./settings-view";

const setSettings = vi.fn(async (_u: Partial<RecorderSettings>) => ({}) as RecorderSettings);
const setWebhookUrl = vi.fn(async (_url: string) => ({ hasUrl: true, host: "hooks.example.com" }));
const clearWebhookUrl = vi.fn(async () => ({ hasUrl: false, host: null }));
const testAlert = vi.fn(async () => ({ ok: true }));
const setApiKey = vi.fn(async (_k: string) => ({ hasKey: true }));
const clearApiKey = vi.fn(async () => ({ hasKey: false }));
const setLlmConfig = vi.fn(async () => ({ provider: "ollama", model: "", baseUrls: {} }));

let settings: Partial<RecorderSettings> = {};
let webhookStatus = { hasUrl: false, host: null as string | null };

vi.mock("../lib/api", () => ({
  api: {
    recorder: {
      getSettings: async () => settings as RecorderSettings,
      setSettings: (u: Partial<RecorderSettings>) => setSettings(u),
    },
    alerts: {
      status: async () => webhookStatus,
      setWebhookUrl: (url: string) => setWebhookUrl(url),
      clearWebhookUrl: () => clearWebhookUrl(),
      test: () => testAlert(),
    },
    llm: {
      getConfig: async () => ({ provider: "ollama", model: "", baseUrls: {} }),
      setConfig: () => setLlmConfig(),
      status: async () => ({ provider: "ollama", reachable: true, models: [], baseUrl: "http://x" }),
      detect: async () => [],
      setApiKey: (k: string) => setApiKey(k),
      clearApiKey: () => clearApiKey(),
      hasApiKey: async () => ({ hasKey: false }),
    },
    artifacts: {
      usage: async () => ({ bytes: 0, runs: 0, tests: 0 }),
      pruneNow: async () => ({ removedRuns: 0, freedBytes: 0 }),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  settings = {
    defaultRunBrowser: "chromium",
    defaultRunHeadless: false,
    defaultCaptureArtifacts: false,
    defaultTestTimeoutMs: 60_000,
    notifyOnRunIssues: false,
    alertWebhookEnabled: false,
    autoHealEnabled: true,
    artifactRetainedRuns: 10,
    artifactRetentionDays: 0,
    batchOrder: [],
  };
  webhookStatus = { hasUrl: false, host: null };
  (window as unknown as { glazeAPI: Record<string, unknown> }).glazeAPI = {
    glaze: { ipc: { invoke: vi.fn(async () => {}) } },
    nativeTheme: {
      getInfo: vi.fn(async () => ({ themeSource: "system", shouldUseDarkColors: false })),
      setThemeSource: vi.fn(async () => {}),
    },
  };
});

/** Settings loads several async queries; wait for the form to be live.
 *  Anchored on a UNIQUE control: /browser/i matches the Browser label AND the
 *  headless description ("without opening a visible browser window"), and a
 *  multi-match findBy retries until it times out — which reads as "the
 *  component never rendered" rather than "the query was ambiguous". */
async function renderSettings() {
  render(<SettingsView />);
  await screen.findByRole("combobox", { name: /browser/i });
}

describe("run defaults persist", () => {
  // NOT TESTED HERE: choosing a different browser. The SDK's Select is backed
  // by a NATIVE menu, so its options never enter the DOM — clicking the trigger
  // in jsdom opens nothing to click. Faking a selection would test the fake.
  // The value the control DISPLAYS is asserted below, and the persistence path
  // (recorder:setSettings validating the engine) is covered in
  // main/handlers/handlers.test.ts.

  it("saves the headless default", async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole("switch", { name: /headless/i }));
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ defaultRunHeadless: true })),
    );
  });

  it("reflects a stored setting rather than a hardcoded default", async () => {
    settings = { ...settings, defaultRunBrowser: "webkit" };
    await renderSettings();
    expect(screen.getByRole("combobox", { name: /browser/i }).textContent).toContain("WebKit");
  });

  it("shows that engine's icon on the trigger, not just its name", async () => {
    settings = { ...settings, defaultRunBrowser: "webkit" };
    await renderSettings();
    const trigger = screen.getByRole("combobox", { name: /browser/i });
    expect(trigger.querySelector('[data-browser="webkit"]')).toBeTruthy();
    expect(trigger.querySelector('[data-browser="chromium"]')).toBeNull();
  });

  it("saves the default test timeout in milliseconds", async () => {
    await renderSettings();
    const input = screen.getByRole("spinbutton", {
      name: /default test timeout/i,
    }) as HTMLInputElement;
    expect(input.value).toBe("60");
    fireEvent.change(input, { target: { value: "120" } });
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ defaultTestTimeoutMs: 120_000 }),
      ),
    );
  });

  it("reflects a stored timeout rather than the one-minute default", async () => {
    settings = { ...settings, defaultTestTimeoutMs: 180_000 };
    await renderSettings();
    const input = screen.getByRole("spinbutton", {
      name: /default test timeout/i,
    }) as HTMLInputElement;
    expect(input.value).toBe("180");
  });
});

describe("the alert webhook is write-only", () => {
  it("keeps the enable switch disabled until a URL is configured", async () => {
    // Enabling alerts with no destination would silently do nothing.
    await renderSettings();
    const sw = screen.getByRole("switch", { name: /send alerts to a webhook/i });
    expect(sw.getAttribute("data-disabled") ?? sw.getAttribute("disabled")).not.toBeNull();
  });

  it("enables the switch once a URL exists", async () => {
    webhookStatus = { hasUrl: true, host: "hooks.example.com" };
    await renderSettings();
    const sw = await screen.findByRole("switch", { name: /send alerts to a webhook/i });
    await waitFor(() =>
      expect(sw.getAttribute("data-disabled") ?? sw.getAttribute("disabled")).toBeNull(),
    );
  });

  it("saves a pasted URL and then clears the field", async () => {
    await renderSettings();
    const field = screen.getByLabelText(/webhook url/i);
    fireEvent.change(field, { target: { value: "https://hooks.example.com/services/SECRET" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(setWebhookUrl).toHaveBeenCalledTimes(1));
    // Cleared after saving: the URL is a bearer credential and must not linger
    // on screen.
    await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  });

  it("never renders the stored URL — only its host", async () => {
    webhookStatus = { hasUrl: true, host: "hooks.example.com" };
    await renderSettings();
    await screen.findByText(/hooks\.example\.com/);
    // The backend never returns the URL; assert nothing resembling a token is
    // on screen either.
    expect(document.body.textContent).not.toMatch(/services\/SECRET/);
  });

  it("masks the input so a pasted credential isn't shoulder-readable", async () => {
    await renderSettings();
    expect(screen.getByLabelText(/webhook url/i).getAttribute("type")).toBe("password");
  });

  it("offers Send test and Remove only once configured", async () => {
    await renderSettings();
    expect(screen.queryByRole("button", { name: /send test/i })).toBeNull();

    webhookStatus = { hasUrl: true, host: "hooks.example.com" };
    render(<SettingsView />);
    expect(await screen.findAllByRole("button", { name: /send test/i })).not.toHaveLength(0);
  });

  it("clears the stored URL", async () => {
    webhookStatus = { hasUrl: true, host: "hooks.example.com" };
    await renderSettings();
    fireEvent.click((await screen.findAllByRole("button", { name: /remove/i }))[0]);
    await waitFor(() => expect(clearWebhookUrl).toHaveBeenCalledTimes(1));
  });
});

describe("retention settings", () => {
  it("saves a change to how many runs are kept", async () => {
    await renderSettings();
    const field = screen.getByLabelText(/screenshot history per test/i);
    fireEvent.change(field, { target: { value: "25" } });
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ artifactRetainedRuns: 25 })),
    );
  });

  it("clamps an absurd value rather than persisting it", async () => {
    await renderSettings();
    const field = screen.getByLabelText(/screenshot history per test/i);
    fireEvent.change(field, { target: { value: "9999" } });
    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    // Not .at(-1): this project targets ES2020, where Array.prototype.at
    // doesn't exist in the type lib.
    const calls = setSettings.mock.calls;
    const saved = calls[calls.length - 1][0] as { artifactRetainedRuns: number };
    expect(saved.artifactRetainedRuns).toBeLessThanOrEqual(50);
  });
});

describe("notifications", () => {
  it("saves the local-notification toggle", async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole("switch", { name: /notify when a run has problems/i }));
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ notifyOnRunIssues: true })),
    );
  });
});
