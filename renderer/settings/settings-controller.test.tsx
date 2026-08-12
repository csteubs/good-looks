// Tests for the Settings controller.
//
// This is where the async behaviour that used to be spread through a
// 1,359-line component now lives, so it is where the failures that are
// invisible on screen now live too:
//
//   • A load that THROWS rather than rejecting used to abort the effect and
//     skip every load after it — the window would open with no settings
//     because something unrelated was missing.
//   • The LLM auto-probe rewrites the configured model when the stored one is
//     gone. Getting its in-flight guard wrong means an old probe's answer
//     overwrites a newer one, and the model silently reverts.
//   • `save` is optimistic and deliberately does NOT roll back on failure.
//
// The panes are tested against a hand-built controller; this file is the only
// place the real one runs.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

import type { RecorderSettings } from "../lib/recorder-types";
import { useSettingsControllerState } from "./settings-controller";

const setSettings = vi.fn(async (_u: Partial<RecorderSettings>) => ({}) as RecorderSettings);
const setLlmConfig = vi.fn(async () => ({ provider: "ollama", model: "", baseUrls: {} }));

let getSettings: () => Promise<Partial<RecorderSettings>>;
let llmStatus: () => Promise<unknown>;
let debugShortcut: () => Promise<string>;
let alertsStatus: () => Promise<{ hasUrl: boolean; host: string | null }>;
let artifactsUsage: () => Promise<{ bytes: number; runs: number; tests: number }>;

vi.mock("../lib/api", () => ({
  api: {
    recorder: {
      getSettings: () => getSettings(),
      setSettings: (u: Partial<RecorderSettings>) => setSettings(u),
    },
    alerts: {
      status: () => alertsStatus(),
      setWebhookUrl: async (url: string) => ({ hasUrl: true, host: new URL(url).host }),
      clearWebhookUrl: async () => ({ hasUrl: false, host: null }),
      test: async () => ({ ok: true }),
    },
    llm: {
      getConfig: async () => ({ provider: "ollama", model: "qwen", baseUrls: {} }),
      setConfig: () => setLlmConfig(),
      status: () => llmStatus(),
      detect: async () => [],
      setApiKey: async () => ({ hasKey: true }),
      clearApiKey: async () => ({ hasKey: false }),
      hasApiKey: async () => ({ hasKey: false }),
      setLmStudioToken: async () => ({ hasToken: true }),
      clearLmStudioToken: async () => ({ hasToken: false }),
      hasLmStudioToken: async () => ({ hasToken: false }),
    },
    artifacts: {
      usage: () => artifactsUsage(),
      pruneNow: async () => ({ removedRuns: 2, freedBytes: 2048 }),
    },
    debug: {
      shortcut: () => debugShortcut(),
      capture: async () => ({ shots: [{ window: "Main" }], error: null }),
      dir: async () => "/tmp",
    },
  },
}));

const REACHABLE = {
  provider: "ollama",
  reachable: true,
  models: [{ id: "qwen", label: "Qwen" }],
  baseUrl: "http://127.0.0.1:11434",
};

beforeEach(() => {
  vi.clearAllMocks();
  getSettings = async () => ({ defaultRunHeadless: true, artifactRetainedRuns: 25 });
  llmStatus = async () => REACHABLE;
  debugShortcut = async () => "⌘⌥⇧S";
  alertsStatus = async () => ({ hasUrl: false, host: null });
  artifactsUsage = async () => ({ bytes: 1024, runs: 1, tests: 1 });
  (window as unknown as { glazeAPI: Record<string, unknown> }).glazeAPI = {
    glaze: { ipc: { invoke: vi.fn(async () => {}) } },
  };
});

describe("loading", () => {
  it("exposes the stored settings", async () => {
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.settings.defaultRunHeadless).toBe(true);
    expect(result.current.settings.artifactRetainedRuns).toBe(25);
  });

  it("reports loaded even when the settings load fails", async () => {
    // `loaded` gates the modified-counts. Left false forever they never appear.
    getSettings = async () => {
      throw new Error("nope");
    };
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.settings).toEqual({});
  });

  it("asks the host nothing about the theme", async () => {
    // The app is dark only (REDESIGN §0), so the controller no longer loads a
    // theme source — and the `nativeTheme` preload surface it used is gone.
    // Asserted as a NEGATIVE on the bridge rather than on a removed field,
    // because the failure this guards is the load being restored quietly: it
    // would throw on a bridge that no longer has the method, and the controller
    // swallows its load errors, so nothing would surface but a missing setting.
    const bridge = (window as unknown as { glazeAPI: Record<string, unknown> }).glazeAPI;
    expect("nativeTheme" in bridge).toBe(false);
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
  });

  it("keeps loading the rest when one surface THROWS synchronously", async () => {
    // The bug this guards: these calls are made synchronously inside the
    // effect, so a missing preload surface aborts the effect at that line and
    // every load after it never starts. The window then opens with no settings
    // because `api.debug` was absent.
    debugShortcut = () => {
      throw new Error("api.debug is not defined");
    };
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.settings.artifactRetainedRuns).toBe(25);
    expect(result.current.debugShortcut).toBe("");
  });

  it("keeps loading the rest when one surface rejects", async () => {
    artifactsUsage = async () => {
      throw new Error("no artifacts");
    };
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.artifactUsage).toBeNull();
    expect(result.current.settings.artifactRetainedRuns).toBe(25);
  });

  it("survives every surface failing at once", async () => {
    getSettings = async () => {
      throw new Error("x");
    };
    llmStatus = async () => {
      throw new Error("x");
    };
    debugShortcut = async () => {
      throw new Error("x");
    };
    alertsStatus = async () => {
      throw new Error("x");
    };
    artifactsUsage = async () => {
      throw new Error("x");
    };
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.webhookStatus).toEqual({ hasUrl: false, host: null });
  });
});

describe("save", () => {
  it("sends the patch verbatim", async () => {
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.save({ defaultRunHeadless: false });
    });
    expect(setSettings).toHaveBeenCalledWith({ defaultRunHeadless: false });
  });

  it("updates local state before the IPC resolves", async () => {
    // Optimistic: a switch that waited for the round trip would visibly lag.
    let release: () => void = () => {};
    setSettings.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve({} as RecorderSettings);
      }),
    );
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => {
      void result.current.save({ defaultRunHeadless: false });
    });
    await waitFor(() => expect(result.current.settings.defaultRunHeadless).toBe(false));
    await act(async () => {
      release();
    });
  });

  it("merges rather than replacing", async () => {
    // Every pane writes independently; a replace would drop the other keys.
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.save({ defaultRunHeadless: false });
    });
    expect(result.current.settings.artifactRetainedRuns).toBe(25);
  });

  it("keeps the optimistic value when the write fails", async () => {
    // Deliberate: rolling back would fight the user's next keystroke, and the
    // toast already tells them it didn't stick.
    setSettings.mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.save({ defaultRunHeadless: false });
    });
    expect(result.current.settings.defaultRunHeadless).toBe(false);
  });

  it("does not reject when the write fails", async () => {
    // Callers use `void save(...)`; a rejection would be an unhandled one.
    setSettings.mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await expect(
      act(async () => {
        await result.current.save({ defaultRunHeadless: false });
      }),
    ).resolves.not.toThrow();
  });
});

describe("the LLM auto-probe", () => {
  it("populates status on mount", async () => {
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.llmStatus?.reachable).toBe(true));
  });

  it("keeps a stored model that is still installed", async () => {
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.llmStatus).toBeTruthy());
    expect(result.current.model).toBe("qwen");
  });

  it("repairs a stored model that is gone", async () => {
    // The side effect that has to happen when the WINDOW opens, not when the
    // AI pane is looked at — which is why this state is in the controller and
    // not in the pane.
    llmStatus = async () => ({
      ...REACHABLE,
      models: [{ id: "llama3.1:8b", label: "Llama" }],
    });
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.model).toBe("llama3.1:8b"));
    expect(setLlmConfig).toHaveBeenCalled();
  });

  it("leaves the model alone when the provider is unreachable", async () => {
    // Clearing it because Ollama happens to be down would lose the choice.
    llmStatus = async () => ({ ...REACHABLE, reachable: false, models: [] });
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.llmStatus?.reachable).toBe(false));
    expect(result.current.model).toBe("qwen");
  });

  it("changing provider resets the model and the URL", async () => {
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.changeProvider("anthropic");
    });
    expect(result.current.provider).toBe("anthropic");
    expect(result.current.baseUrl).toBe("https://api.anthropic.com");
  });

  it("maps an unknown provider name to Ollama rather than storing it", async () => {
    // The value comes from a radio group, but the handler takes a string.
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.changeProvider("not-a-provider");
    });
    expect(result.current.provider).toBe("ollama");
  });
});

describe("base URL", () => {
  it("edits without persisting", async () => {
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    setLlmConfig.mockClear();
    act(() => result.current.setBaseUrl("http://127.0.0.1:9999"));
    expect(result.current.baseUrl).toBe("http://127.0.0.1:9999");
    expect(setLlmConfig).not.toHaveBeenCalled();
  });

  it("persists an override on commit", async () => {
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    setLlmConfig.mockClear();
    await act(async () => {
      await result.current.commitBaseUrl("http://127.0.0.1:9999");
    });
    expect(setLlmConfig).toHaveBeenCalled();
  });

  it("stores the default URL as no override at all", async () => {
    // Persisting the default verbatim would pin the app to today's default if
    // it ever changed.
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.commitBaseUrl("http://127.0.0.1:11434");
    });
    expect(result.current.baseUrl).toBe("http://127.0.0.1:11434");
  });
});

describe("webhook", () => {
  it("reports success so the pane can clear its field", async () => {
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveWebhookUrl("https://hooks.example.com/x");
    });
    expect(ok).toBe(true);
    expect(result.current.webhookStatus).toEqual({ hasUrl: true, host: "hooks.example.com" });
  });

  it("reports failure so the pane keeps what was typed", async () => {
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let ok: boolean | undefined;
    await act(async () => {
      // Not a URL — `new URL()` in the mock throws, standing in for the
      // backend's own scheme rejection.
      ok = await result.current.saveWebhookUrl("nonsense");
    });
    expect(ok).toBe(false);
    expect(result.current.webhookStatus.hasUrl).toBe(false);
  });

  it("clears the stored URL", async () => {
    alertsStatus = async () => ({ hasUrl: true, host: "hooks.example.com" });
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.webhookStatus.hasUrl).toBe(true));
    await act(async () => {
      await result.current.clearWebhookUrl();
    });
    expect(result.current.webhookStatus).toEqual({ hasUrl: false, host: null });
  });

  it("never exposes the URL itself, only the host", async () => {
    alertsStatus = async () => ({ hasUrl: true, host: "hooks.example.com" });
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.webhookStatus.hasUrl).toBe(true));
    expect(Object.keys(result.current.webhookStatus).slice().sort()).toEqual(["hasUrl", "host"]);
  });
});

describe("artifacts", () => {
  it("re-reads usage after a prune, so the readout is not stale", async () => {
    let usageCalls = 0;
    artifactsUsage = async () => {
      usageCalls += 1;
      return { bytes: usageCalls === 1 ? 4096 : 1024, runs: 1, tests: 1 };
    };
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.artifactUsage?.bytes).toBe(4096));
    await act(async () => {
      await result.current.pruneNow();
    });
    expect(result.current.artifactUsage?.bytes).toBe(1024);
  });

  it("clears the busy flag even when the prune fails", async () => {
    // A stuck `pruning` leaves the button disabled with no way back.
    artifactsUsage = async () => {
      throw new Error("gone");
    };
    const { result } = renderHook(() => useSettingsControllerState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.pruneNow();
    });
    expect(result.current.pruning).toBe(false);
  });
});
