// Every piece of state the Settings window holds, and every handler that
// writes one — lifted out of `settings-view.tsx` when that file was split into
// panes.
//
// It is one controller rather than per-pane state on purpose. Two of these
// loads have side effects that used to fire when the WINDOW opened, not when a
// section was looked at: the LLM auto-probe can rewrite the configured model if
// the stored one is no longer installed, and the settings load is what every
// pane's "differs from default" count reads. Moving either into the pane that
// renders it would mean a stale model is repaired only if you happen to click
// AI, and a modified-count that is blank until you visit the pane.
//
// The ~20 individual `useState`s the old view kept for RecorderSettings fields
// collapse into one object plus `save(patch)`. The patch shape is unchanged —
// still one key per call to `recorder:setSettings`, which the backend merges —
// so nothing about what crosses IPC moved.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "@ui";
import type { NativeThemeInfo } from "../lib/host-types";

import { api } from "../lib/api";
import type { LlmProvider, LlmProviderStatus } from "../lib/llm-types";
import type { ArtifactUsage, RecorderSettings } from "../lib/recorder-types";
import { formatBytes } from "../lib/settings-schema";

export type ThemeSource = "system" | "light" | "dark";

export interface WebhookStatus {
  hasUrl: boolean;
  host: string | null;
}

export interface SettingsController {
  /** Persisted recorder settings. Partial because it is empty until the load
   *  resolves — panes read through `??` defaults exactly as the old view did. */
  settings: Partial<RecorderSettings>;
  /** True once `recorder:getSettings` has settled either way. The nav waits on
   *  this before drawing modified-counts, or every pane flashes one. */
  loaded: boolean;
  /** Optimistic write: local state updates first, then IPC. A failure toasts
   *  and leaves the optimistic value in place — same as before the split.
   *  Rolling back would fight the user's next keystroke. */
  save: (patch: Partial<RecorderSettings>) => Promise<void>;

  themeSource: ThemeSource;
  setTheme: (source: string) => Promise<void>;

  provider: LlmProvider;
  model: string | null;
  llmStatus: LlmProviderStatus | null;
  baseUrl: string;
  hasApiKey: boolean;
  /** Whether an LM Studio API token is stored. Only meaningful for LM Studio. */
  hasLmStudioToken: boolean;
  testing: boolean;
  savingKey: boolean;
  defaultUrlFor: (p: LlmProvider) => string;
  setBaseUrl: (value: string) => void;
  commitBaseUrl: (value: string) => Promise<void>;
  changeProvider: (value: string) => Promise<void>;
  saveApiKey: (key: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  saveLmStudioToken: (token: string) => Promise<void>;
  clearLmStudioToken: () => Promise<void>;
  testConnection: () => Promise<void>;
  changeModel: (value: string) => Promise<void>;

  webhookStatus: WebhookStatus;
  webhookBusy: boolean;
  saveWebhookUrl: (url: string) => Promise<boolean>;
  clearWebhookUrl: () => Promise<void>;
  testWebhook: () => Promise<void>;

  artifactUsage: ArtifactUsage | null;
  pruning: boolean;
  pruneNow: () => Promise<void>;

  debugShortcut: string;
  capturing: boolean;
  captureNow: () => Promise<void>;
}

const Ctx = createContext<SettingsController | null>(null);

/** Read the controller. Throws rather than handing back a null-shaped object:
 *  a pane rendered outside the provider would otherwise show every control at
 *  its fallback value and silently save nothing. */
export function useSettingsController(): SettingsController {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSettingsController must be used inside <SettingsProvider>");
  return ctx;
}

function defaultUrlFor(p: LlmProvider): string {
  return p === "anthropic"
    ? "https://api.anthropic.com"
    : p === "lmstudio"
      ? "http://127.0.0.1:1234"
      : "http://127.0.0.1:11434";
}

export function useSettingsControllerState(): SettingsController {
  const [settings, setSettings] = useState<Partial<RecorderSettings>>({});
  const [loaded, setLoaded] = useState(false);

  const [themeSource, setThemeSource] = useState<ThemeSource>("system");

  const [provider, setProvider] = useState<LlmProvider>("ollama");
  const [model, setModel] = useState<string | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmProviderStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [hasLmStudioToken, setHasLmStudioToken] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const autoFetchInflight = useRef(0);

  // The URL itself is a bearer credential and is never read back from the
  // backend — only whether one exists, and its host.
  const [webhookStatus, setWebhookStatus] = useState<WebhookStatus>({ hasUrl: false, host: null });
  const [webhookBusy, setWebhookBusy] = useState(false);

  const [artifactUsage, setArtifactUsage] = useState<ArtifactUsage | null>(null);
  const [pruning, setPruning] = useState(false);

  const [debugShortcut, setDebugShortcut] = useState("");
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    /**
     * Start one load, independently of the others.
     *
     * The `try` matters as much as the `.catch`: these calls are made
     * synchronously inside the effect, so a surface that THROWS rather than
     * rejecting — a preload that didn't expose it, an IPC channel removed in a
     * later version — would abort the effect at that line and skip every load
     * after it. The window would then open with no settings at all because
     * something unrelated was missing. Each load is independently optional;
     * the one that isn't (`recorder:getSettings`) reports through `loaded`.
     */
    const load = <T,>(run: () => Promise<T>, apply: (value: T) => void, done?: () => void) => {
      try {
        run()
          .then(apply)
          .catch(() => {
            /* every one of these has a usable fallback */
          })
          .finally(() => done?.());
      } catch {
        done?.();
      }
    };

    load(
      () => api.llm.getConfig(),
      (cfg) => {
        setProvider(cfg.provider);
        setModel(cfg.model);
        setBaseUrl((cfg.baseUrls?.[cfg.provider] ?? "").trim() || defaultUrlFor(cfg.provider));
      },
    );
    load(
      () => api.llm.hasApiKey(),
      ({ hasKey }) => setHasApiKey(hasKey),
    );
    load(
      () => api.llm.hasLmStudioToken(),
      ({ hasToken }) => setHasLmStudioToken(hasToken),
    );
    load(
      () => api.recorder.getSettings(),
      // A RESOLVED null is not the same as a rejection and doesn't reach the
      // catch: an IPC handler that returns nothing (removed channel, backend
      // mid-upgrade) would put null straight into state, and the first pane to
      // read a key off it takes the whole window down. Every pane already
      // treats a missing key as its default, so an empty object is the right
      // shape for "we have nothing".
      (loadedSettings) =>
        setSettings(
          loadedSettings && typeof loadedSettings === "object" ? loadedSettings : {},
        ),
      () => setLoaded(true),
    );
    load(
      () => api.alerts.status(),
      setWebhookStatus,
    );
    load(
      () => api.artifacts.usage(),
      setArtifactUsage,
    );
    load(
      () => api.debug.shortcut(),
      setDebugShortcut,
    );
  }, []);

  const save = useCallback(async (patch: Partial<RecorderSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    try {
      await api.recorder.setSettings(patch);
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  }, []);

  // ── Theme ─────────────────────────────────────────────────────────────────

  const refreshThemeInfo = useCallback(async () => {
    try {
      const info: NativeThemeInfo = await window.glazeAPI.nativeTheme.getInfo();
      setThemeSource((info?.themeSource as ThemeSource) ?? "system");
    } catch (error) {
      toast.error(`Failed to get theme info: ${error}`);
    }
  }, []);

  useEffect(() => {
    void refreshThemeInfo();
  }, [refreshThemeInfo]);

  const setTheme = useCallback(
    async (value: string) => {
      const source = value as ThemeSource;
      try {
        await window.glazeAPI.nativeTheme.setThemeSource(source);
        await refreshThemeInfo();
      } catch (error) {
        toast.error(`Failed to set theme: ${error}`);
      }
    },
    [refreshThemeInfo],
  );

  // ── LLM provider ──────────────────────────────────────────────────────────

  const changeProvider = useCallback(async (value: string) => {
    const next: LlmProvider =
      value === "lmstudio" ? "lmstudio" : value === "anthropic" ? "anthropic" : "ollama";
    setProvider(next);
    setLlmStatus(null);
    setModel(null);
    setBaseUrl(defaultUrlFor(next));
    try {
      // Switching providers resets the newly-selected provider to its default URL.
      await api.llm.setConfig({ provider: next, model: null, baseUrls: { [next]: "" } });
    } catch (error) {
      toast.error(`Failed to save provider: ${error}`);
    }
  }, []);

  const saveApiKey = useCallback(
    async (raw: string) => {
      const key = raw.trim();
      if (!key) return;
      setSavingKey(true);
      try {
        await api.llm.setApiKey(key);
        setHasApiKey(true);
        // Refresh status so the model list populates.
        const status = await api.llm.status("anthropic");
        setLlmStatus(status);
        if (status.reachable) {
          const nextModel = status.models.some((m) => m.id === model)
            ? model
            : (status.models[0]?.id ?? null);
          setModel(nextModel);
          await api.llm.setConfig({ model: nextModel });
        }
        toast.success(
          status.reachable ? "Connected to Claude." : (status.error ?? "Saved, but not reachable."),
        );
      } catch (error) {
        toast.error(`Failed to save API key: ${error}`);
      } finally {
        setSavingKey(false);
      }
    },
    [model],
  );

  const clearApiKey = useCallback(async () => {
    try {
      await api.llm.clearApiKey();
      setHasApiKey(false);
      setLlmStatus(null);
      setModel(null);
      await api.llm.setConfig({ model: null });
      toast.success("API key removed.");
    } catch (error) {
      toast.error(`Failed to remove API key: ${error}`);
    }
  }, []);

  // Saving a token has to re-probe explicitly: the auto-probe effect below is
  // keyed on provider + base URL, and neither of those changed — so without
  // this the model list stays empty after the one action that unblocks it.
  const saveLmStudioToken = useCallback(
    async (raw: string) => {
      const token = raw.trim();
      if (!token) return;
      setSavingKey(true);
      try {
        await api.llm.setLmStudioToken(token);
        setHasLmStudioToken(true);
        const status = await api.llm.status("lmstudio");
        setLlmStatus(status);
        if (status.reachable) {
          const nextModel = status.models.some((m) => m.id === model)
            ? model
            : (status.models[0]?.id ?? null);
          setModel(nextModel);
          await api.llm.setConfig({ model: nextModel });
        }
        toast.success(
          status.reachable
            ? "Connected to LM Studio."
            : (status.error ?? "Saved, but not reachable."),
        );
      } catch (error) {
        toast.error(`Failed to save API token: ${error}`);
      } finally {
        setSavingKey(false);
      }
    },
    [model],
  );

  const clearLmStudioToken = useCallback(async () => {
    try {
      await api.llm.clearLmStudioToken();
      setHasLmStudioToken(false);
      // Re-probe rather than blanking the status: without a token the server may
      // well be reachable (authentication off is the default), and showing
      // "Offline" for a server that answers is the same lie in reverse.
      setLlmStatus(await api.llm.status("lmstudio"));
      toast.success("API token removed.");
    } catch (error) {
      toast.error(`Failed to remove API token: ${error}`);
    }
  }, []);

  const commitBaseUrl = useCallback(
    async (value: string) => {
      setBaseUrl(value);
      const trimmed = value.trim();
      const override = trimmed && trimmed !== defaultUrlFor(provider) ? trimmed : "";
      try {
        await api.llm.setConfig({ baseUrls: { [provider]: override } });
      } catch (error) {
        toast.error(`Failed to save server URL: ${error}`);
      }
    },
    [provider],
  );

  const testConnection = useCallback(async () => {
    setTesting(true);
    try {
      const status = await api.llm.status(provider);
      setLlmStatus(status);
      if (status.reachable) {
        // Keep the chosen model if it's still present, else default to the first.
        const stillValid = status.models.some((m) => m.id === model);
        const nextModel = stillValid ? model : (status.models[0]?.id ?? null);
        setModel(nextModel);
        await api.llm.setConfig({ model: nextModel });
        toast.success(
          status.models.length
            ? `Connected. ${status.models.length} model${status.models.length === 1 ? "" : "s"} available.`
            : "Connected, but no models are loaded.",
        );
      } else {
        toast.error(status.error ?? "Connection failed.");
      }
    } catch (error) {
      toast.error(`Connection failed: ${error}`);
    } finally {
      setTesting(false);
    }
  }, [provider, model]);

  // Auto-fetch available models whenever the provider or server URL changes,
  // so the model list populates without a manual "Test connection" click.
  useEffect(() => {
    if (!baseUrl) return;
    const handle = ++autoFetchInflight.current;
    let cancelled = false;
    (async () => {
      try {
        const status = await api.llm.status(provider);
        if (cancelled || handle !== autoFetchInflight.current) return;
        setLlmStatus(status);
        if (status.reachable) {
          const stillValid = status.models.some((m) => m.id === model);
          const nextModel = stillValid ? model : (status.models[0]?.id ?? null);
          if (nextModel !== model) {
            setModel(nextModel);
            await api.llm.setConfig({ model: nextModel });
          }
        }
      } catch {
        /* ignore — user can retry with Test connection */
      }
    })();
    return () => {
      cancelled = true;
    };
    // `model` is deliberately absent from the deps: it is read to decide
    // whether the stored model is still valid, but the effect also SETS it, so
    // depending on it would re-trigger the probe on every repair.
  }, [provider, baseUrl]);

  const changeModel = useCallback(async (value: string) => {
    setModel(value);
    try {
      await api.llm.setConfig({ model: value });
    } catch (error) {
      toast.error(`Failed to save model: ${error}`);
    }
  }, []);

  // ── Webhook ───────────────────────────────────────────────────────────────

  /** Resolves true when the URL was accepted, so the pane knows whether to
   *  clear its input. Clearing on failure would lose what the user pasted. */
  const saveWebhookUrl = useCallback(async (url: string) => {
    setWebhookBusy(true);
    try {
      const next = await api.alerts.setWebhookUrl(url);
      setWebhookStatus(next);
      toast.success(`Webhook saved${next.host ? ` — sending to ${next.host}` : ""}.`);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to save webhook: ${error}`);
      return false;
    } finally {
      setWebhookBusy(false);
    }
  }, []);

  const clearWebhookUrl = useCallback(async () => {
    setWebhookBusy(true);
    try {
      setWebhookStatus(await api.alerts.clearWebhookUrl());
      toast.success("Webhook removed.");
    } catch (error) {
      toast.error(`Failed to remove webhook: ${error}`);
    } finally {
      setWebhookBusy(false);
    }
  }, []);

  const testWebhook = useCallback(async () => {
    setWebhookBusy(true);
    try {
      await api.alerts.test();
      toast.success("Test alert sent.");
    } catch (error) {
      // Surfaced rather than swallowed — the point of a test button is to find
      // out that it doesn't work.
      toast.error(error instanceof Error ? error.message : `Test alert failed: ${error}`);
    } finally {
      setWebhookBusy(false);
    }
  }, []);

  // ── Artifacts ─────────────────────────────────────────────────────────────

  const pruneNow = useCallback(async () => {
    setPruning(true);
    try {
      const { removedRuns, freedBytes } = await api.artifacts.pruneNow();
      setArtifactUsage(await api.artifacts.usage());
      toast.success(
        removedRuns > 0
          ? `Deleted ${removedRuns} run${removedRuns === 1 ? "" : "s"}, freeing ${formatBytes(freedBytes)}.`
          : "Nothing to clean up — every run is within your limits.",
      );
    } catch (error) {
      toast.error(`Cleanup failed: ${error}`);
    } finally {
      setPruning(false);
    }
  }, []);

  // ── Debug capture ─────────────────────────────────────────────────────────

  const captureNow = useCallback(async () => {
    setCapturing(true);
    try {
      const session = await api.debug.capture();
      if (session.error) toast.error(session.error);
      else {
        // Say what it actually got. "Saved" alone leaves you wondering whether
        // it caught the window you cared about.
        const names = session.shots.map((s) => s.window).join(", ");
        toast.success(
          `Captured ${session.shots.length} ${session.shots.length === 1 ? "window" : "windows"}: ${names}`,
        );
      }
    } catch (error) {
      toast.error(`Capture failed: ${error}`);
    } finally {
      setCapturing(false);
    }
  }, []);

  return {
    settings,
    loaded,
    save,
    themeSource,
    setTheme,
    provider,
    model,
    llmStatus,
    baseUrl,
    hasApiKey,
    hasLmStudioToken,
    testing,
    savingKey,
    defaultUrlFor,
    setBaseUrl,
    commitBaseUrl,
    changeProvider,
    saveApiKey,
    clearApiKey,
    saveLmStudioToken,
    clearLmStudioToken,
    testConnection,
    changeModel,
    webhookStatus,
    webhookBusy,
    saveWebhookUrl,
    clearWebhookUrl,
    testWebhook,
    artifactUsage,
    pruning,
    pruneNow,
    debugShortcut,
    capturing,
    captureNow,
  };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const controller = useSettingsControllerState();
  return <Ctx.Provider value={controller}>{children}</Ctx.Provider>;
}

/** Test seam: render a pane against a hand-built controller without the async
 *  loads. Production code always goes through `SettingsProvider`. */
export function SettingsControllerProvider({
  value,
  children,
}: {
  value: SettingsController;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
