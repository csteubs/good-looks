import { useState, useEffect, useRef } from "react";
import {
  Button,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SegmentedControl,
  SegmentedControlItem,
  Status,
  Switch,
  Toolbar,
  ToolbarContent,
  ToolbarTitle,
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
  FieldSet,
  toast,
} from "@glaze/core/components";
import type { NativeThemeInfo } from "@glaze/core/ipc";

import { api } from "../lib/api";
import type { LlmProvider, LlmProviderStatus } from "../lib/llm-types";
import type { ArtifactUsage, RunBrowser, TestSpeed } from "../lib/recorder-types";
import { RUN_BROWSERS, RUN_BROWSER_LABELS } from "../lib/recorder-types";

const SPEEDS: TestSpeed[] = ["slow", "medium", "fast"];
const SPEED_LABEL: Record<TestSpeed, string> = { slow: "Slow", medium: "Medium", fast: "Fast" };

/** Human-readable size for the screenshot-storage readout (KB/MB/GB, 1 decimal
 *  once past KB so "0.6 MB" reads better than "614 KB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function SettingsView() {
  const [themeInfo, setThemeInfo] = useState<NativeThemeInfo | null>(null);
  const [_isLoading, setIsLoading] = useState(true);

  // ── Local LLM provider settings ─────────────────────────────────────
  const [provider, setProvider] = useState<LlmProvider>("ollama");
  const [model, setModel] = useState<string | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmProviderStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string>("");
  const autoFetchInflight = useRef(0);

  // ── Claude (Anthropic) API key ──────────────────────────────────────
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);

  const defaultUrlFor = (p: LlmProvider) =>
    p === "anthropic"
      ? "https://api.anthropic.com"
      : p === "lmstudio"
        ? "http://127.0.0.1:1234"
        : "http://127.0.0.1:11434";

  // ── Trainer settings ─────────────────────────────────────────────────
  const [showUrlBar, setShowUrlBar] = useState(true);
  const [trainerPanelEnabled, setTrainerPanelEnabled] = useState(false);
  const [defaultRunSpeed, setDefaultRunSpeed] = useState<TestSpeed>("slow");
  const [defaultCaptureArtifacts, setDefaultCaptureArtifacts] = useState(false);
  const [defaultRecordLogs, setDefaultRecordLogs] = useState(false);
  const [recordAllHeaders, setRecordAllHeaders] = useState(false);
  const [keepRunningAiDebugJobs, setKeepRunningAiDebugJobs] = useState(false);
  const [defaultRunHeadless, setDefaultRunHeadless] = useState(false);
  const [defaultRunBrowser, setDefaultRunBrowser] = useState<RunBrowser>("chromium");
  const [artifactRetainedRuns, setArtifactRetainedRuns] = useState(10);
  const [artifactRetentionDays, setArtifactRetentionDays] = useState(0);
  const [notifyOnRunIssues, setNotifyOnRunIssues] = useState(false);
  // Outgoing webhook alerts. The URL itself is a bearer credential and is never
  // read back from the backend — only whether one exists, and its host.
  const [alertWebhookEnabled, setAlertWebhookEnabled] = useState(false);
  const [webhookStatus, setWebhookStatus] = useState<{ hasUrl: boolean; host: string | null }>({
    hasUrl: false,
    host: null,
  });
  const [webhookInput, setWebhookInput] = useState("");
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [artifactUsage, setArtifactUsage] = useState<ArtifactUsage | null>(null);
  const [pruning, setPruning] = useState(false);

  // ── Auto-Heal settings ──────────────────────────────────────────────
  const [autoHealEnabled, setAutoHealEnabled] = useState(true);
  const [autoHealRetries, setAutoHealRetries] = useState(3);
  const [autoHealTimeout, setAutoHealTimeout] = useState(4000);
  const [autoHealApply, setAutoHealApply] = useState<"suggest" | "apply">("suggest");
  const [defaultA11y, setDefaultA11y] = useState(false);
  const [debugScreenshots, setDebugScreenshots] = useState(false);
  const [debugShortcut, setDebugShortcut] = useState("");
  const [capturing, setCapturing] = useState(false);

  // ── Aesthetic Enhancement features ──────────────────────────────────
  const [disabledEnhancements, setDisabledEnhancements] = useState<string[]>([]);

  useEffect(() => {
    api.llm
      .getConfig()
      .then((cfg) => {
        setProvider(cfg.provider);
        setModel(cfg.model);
        setBaseUrl((cfg.baseUrls?.[cfg.provider] ?? "").trim() || defaultUrlFor(cfg.provider));
      })
      .catch(() => {
        /* fall back to defaults */
      });
    api.llm
      .hasApiKey()
      .then(({ hasKey }) => setHasApiKey(hasKey))
      .catch(() => {
        /* assume no key */
      });
    api.recorder
      .getSettings()
      .then((settings) => {
        setShowUrlBar(settings.showUrlBar);
        setTrainerPanelEnabled(settings.trainerPanelEnabled);
        setDefaultRunSpeed(settings.defaultRunSpeed ?? "slow");
        setDefaultCaptureArtifacts(settings.defaultCaptureArtifacts ?? false);
        setDefaultRecordLogs(settings.defaultRecordLogs ?? false);
        setRecordAllHeaders(settings.recordAllHeaders ?? false);
        setKeepRunningAiDebugJobs(settings.keepRunningAiDebugJobs ?? false);
        setDefaultRunHeadless(settings.defaultRunHeadless ?? false);
        setDefaultRunBrowser(settings.defaultRunBrowser ?? "chromium");
        setArtifactRetainedRuns(settings.artifactRetainedRuns ?? 10);
        setArtifactRetentionDays(settings.artifactRetentionDays ?? 0);
        setNotifyOnRunIssues(settings.notifyOnRunIssues ?? false);
        setAlertWebhookEnabled(settings.alertWebhookEnabled ?? false);
        api.alerts
          .status()
          .then(setWebhookStatus)
          .catch(() => {});
        setAutoHealEnabled(settings.autoHealEnabled ?? true);
        setAutoHealRetries(settings.autoHealRetries ?? 3);
        setAutoHealTimeout(settings.autoHealAttemptTimeoutMs ?? 4000);
        setAutoHealApply(settings.autoHealApply ?? "suggest");
        setDefaultA11y(settings.defaultA11yChecks ?? false);
        setDebugScreenshots(settings.debugScreenshots ?? false);
        void api.debug.shortcut().then(setDebugShortcut).catch(() => setDebugShortcut(""));
        setDisabledEnhancements(settings.disabledAestheticEnhancements ?? []);
      })
      .catch(() => {
        /* fall back to defaults */
      });
    api.artifacts
      .usage()
      .then(setArtifactUsage)
      .catch(() => {
        /* usage readout is optional — omit it if unavailable */
      });
  }, []);

  const handleShowUrlBarChange = async (checked: boolean) => {
    setShowUrlBar(checked);
    try {
      await api.recorder.setSettings({ showUrlBar: checked });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleTrainerPanelChange = async (checked: boolean) => {
    setTrainerPanelEnabled(checked);
    try {
      await api.recorder.setSettings({ trainerPanelEnabled: checked });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleDefaultRunSpeedChange = (value: string) => {
    const next = value as TestSpeed;
    setDefaultRunSpeed(next);
    api.recorder.setSettings({ defaultRunSpeed: next }).catch((error) => {
      toast.error(`Failed to save setting: ${error}`);
    });
  };

  const handleDefaultCaptureArtifactsChange = async (checked: boolean) => {
    setDefaultCaptureArtifacts(checked);
    try {
      await api.recorder.setSettings({ defaultCaptureArtifacts: checked });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleDefaultRecordLogsChange = async (checked: boolean) => {
    setDefaultRecordLogs(checked);
    try {
      await api.recorder.setSettings({ defaultRecordLogs: checked });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleRecordAllHeadersChange = async (checked: boolean) => {
    setRecordAllHeaders(checked);
    try {
      await api.recorder.setSettings({ recordAllHeaders: checked });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleKeepRunningAiDebugJobsChange = async (checked: boolean) => {
    setKeepRunningAiDebugJobs(checked);
    try {
      await api.recorder.setSettings({ keepRunningAiDebugJobs: checked });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleDefaultRunHeadlessChange = async (checked: boolean) => {
    setDefaultRunHeadless(checked);
    try {
      await api.recorder.setSettings({ defaultRunHeadless: checked });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleAlertWebhookEnabledChange = async (checked: boolean) => {
    setAlertWebhookEnabled(checked);
    try {
      await api.recorder.setSettings({ alertWebhookEnabled: checked });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleSaveWebhookUrl = async () => {
    setWebhookBusy(true);
    try {
      const next = await api.alerts.setWebhookUrl(webhookInput);
      setWebhookStatus(next);
      setWebhookInput("");
      toast.success(`Webhook saved${next.host ? ` — sending to ${next.host}` : ""}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to save webhook: ${error}`);
    } finally {
      setWebhookBusy(false);
    }
  };

  const handleClearWebhookUrl = async () => {
    setWebhookBusy(true);
    try {
      setWebhookStatus(await api.alerts.clearWebhookUrl());
      toast.success("Webhook removed.");
    } catch (error) {
      toast.error(`Failed to remove webhook: ${error}`);
    } finally {
      setWebhookBusy(false);
    }
  };

  const handleTestWebhook = async () => {
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
  };

  const handleDefaultRunBrowserChange = async (browser: RunBrowser) => {
    setDefaultRunBrowser(browser);
    try {
      await api.recorder.setSettings({ defaultRunBrowser: browser });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleArtifactRetainedRunsChange = async (value: string) => {
    const n = Math.max(1, Math.min(50, Math.round(Number(value) || 10)));
    setArtifactRetainedRuns(n);
    try {
      await api.recorder.setSettings({ artifactRetainedRuns: n });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handlePruneNow = async () => {
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
  };

  const handleArtifactRetentionDaysChange = async (value: string) => {
    const n = Math.max(0, Math.min(365, Math.round(Number(value) || 0)));
    setArtifactRetentionDays(n);
    try {
      await api.recorder.setSettings({ artifactRetentionDays: n });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleNotifyOnRunIssuesChange = async (checked: boolean) => {
    setNotifyOnRunIssues(checked);
    try {
      await api.recorder.setSettings({ notifyOnRunIssues: checked });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleAutoHealEnabledChange = async (checked: boolean) => {
    setAutoHealEnabled(checked);
    try {
      await api.recorder.setSettings({ autoHealEnabled: checked });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleAutoHealRetriesChange = async (value: string) => {
    const n = Math.max(1, Math.min(10, Math.round(Number(value) || 3)));
    setAutoHealRetries(n);
    try {
      await api.recorder.setSettings({ autoHealRetries: n });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleDebugScreenshotsChange = async (checked: boolean) => {
    setDebugScreenshots(checked);
    try {
      await api.recorder.setSettings({ debugScreenshots: checked });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleCaptureNow = async () => {
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
  };

  const handleDefaultA11yChange = async (checked: boolean) => {
    setDefaultA11y(checked);
    try {
      await api.recorder.setSettings({ defaultA11yChecks: checked });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleAutoHealApplyChange = async (checked: boolean) => {
    const mode = checked ? "apply" : "suggest";
    setAutoHealApply(mode);
    try {
      await api.recorder.setSettings({ autoHealApply: mode });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleAutoHealTimeoutChange = async (value: string) => {
    const ms = Math.max(1000, Math.min(30000, Math.round(Number(value) || 4000)));
    setAutoHealTimeout(ms);
    try {
      await api.recorder.setSettings({ autoHealAttemptTimeoutMs: ms });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleToggleEnhancement = async (id: string, enabled: boolean) => {
    const next = enabled
      ? disabledEnhancements.filter((e) => e !== id)
      : [...disabledEnhancements, id];
    setDisabledEnhancements(next);
    try {
      await api.recorder.setSettings({ disabledAestheticEnhancements: next });
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  };

  const handleProviderChange = async (value: string) => {
    const next: LlmProvider =
      value === "lmstudio" ? "lmstudio" : value === "anthropic" ? "anthropic" : "ollama";
    setProvider(next);
    setLlmStatus(null);
    setModel(null);
    const nextUrl = defaultUrlFor(next);
    setBaseUrl(nextUrl);
    try {
      // Switching providers resets the newly-selected provider to its default URL.
      await api.llm.setConfig({ provider: next, model: null, baseUrls: { [next]: "" } });
    } catch (error) {
      toast.error(`Failed to save provider: ${error}`);
    }
  };

  const handleSaveApiKey = async () => {
    const key = apiKeyInput.trim();
    if (!key) return;
    setSavingKey(true);
    try {
      await api.llm.setApiKey(key);
      setHasApiKey(true);
      setApiKeyInput(""); // don't hold the key in renderer state
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
  };

  const handleClearApiKey = async () => {
    try {
      await api.llm.clearApiKey();
      setHasApiKey(false);
      setApiKeyInput("");
      setLlmStatus(null);
      setModel(null);
      await api.llm.setConfig({ model: null });
      toast.success("API key removed.");
    } catch (error) {
      toast.error(`Failed to remove API key: ${error}`);
    }
  };

  const handleBaseUrlChange = async (value: string) => {
    setBaseUrl(value);
    const trimmed = value.trim();
    const override = trimmed && trimmed !== defaultUrlFor(provider) ? trimmed : "";
    try {
      await api.llm.setConfig({ baseUrls: { [provider]: override } });
    } catch (error) {
      toast.error(`Failed to save server URL: ${error}`);
    }
  };

  const handleTestConnection = async () => {
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
  };

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
  }, [provider, baseUrl]);

  const handleModelChange = async (value: string) => {
    setModel(value);
    try {
      await api.llm.setConfig({ model: value });
    } catch (error) {
      toast.error(`Failed to save model: ${error}`);
    }
  };

  // Close settings window on Escape, unless an interactive element is focused or a popover is open
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;

      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }

      if (document.querySelector("[data-radix-popper-content-wrapper]")) {
        return;
      }

      event.preventDefault();
      window.glazeAPI.glaze.ipc.invoke("window:closeSettings");
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const refreshThemeInfo = async () => {
    try {
      const info = await window.glazeAPI.nativeTheme.getInfo();
      setThemeInfo(info);
    } catch (error) {
      toast.error(`Failed to get theme info: ${error}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refreshThemeInfo();
  }, []);

  const handleThemeChange = async (value: string) => {
    const source = value as "system" | "light" | "dark";
    try {
      await window.glazeAPI.nativeTheme.setThemeSource(source);
      await refreshThemeInfo();
    } catch (error) {
      toast.error(`Failed to set theme: ${error}`);
    }
  };

  return (
    <ScrollArea
      toolbar={
        <Toolbar>
          <ToolbarContent>
            <ToolbarTitle>Settings</ToolbarTitle>
          </ToolbarContent>
        </Toolbar>
      }
    >
      <div className="px-4 flex flex-col gap-8 mb-8">
        <FieldSet>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="theme">Theme</FieldLabel>
              </FieldContent>
              <RadioGroup
                value={themeInfo?.themeSource ?? "system"}
                onValueChange={handleThemeChange}
                orientation="horizontal"
              >
                <Label>
                  <RadioGroupItem value="system" />
                  Auto
                </Label>
                <Label>
                  <RadioGroupItem value="light" />
                  Light
                </Label>
                <Label>
                  <RadioGroupItem value="dark" />
                  Dark
                </Label>
              </RadioGroup>
            </Field>
          </FieldGroup>
        </FieldSet>

        <FieldSet>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="show-url-bar">Show URL bar in training window</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Displays the current page's URL in the training window's title bar while
                  recording.
                </p>
              </FieldContent>
              <Switch
                id="show-url-bar"
                checked={showUrlBar}
                onCheckedChange={handleShowUrlBarChange}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="trainer-panel">Dock the trainer to the browser</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Opens the step list and tools in a narrow panel pinned beside the training
                  browser, so you don't have to switch windows for every step. The panel follows
                  the browser when you move or resize it, and can be undocked. Docking narrows
                  the training browser to make room.
                </p>
              </FieldContent>
              <Switch
                id="trainer-panel"
                checked={trainerPanelEnabled}
                onCheckedChange={handleTrainerPanelChange}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="default-run-speed">Default run speed</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Playback speed for new recordings. Adds a delay between actions so runs are
                  watchable; slow by default. Each test can still be overridden from its sidebar
                  menu.
                </p>
              </FieldContent>
              <SegmentedControl
                id="default-run-speed"
                value={defaultRunSpeed}
                onValueChange={handleDefaultRunSpeedChange}
                variant="filled"
                size="small"
              >
                {SPEEDS.map((s) => (
                  <SegmentedControlItem key={s} value={s}>
                    {SPEED_LABEL[s]}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="default-capture-artifacts">Capture screenshots by default</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Default value of the “Capture screenshots” toggle for new tests. Each test
                  remembers its own choice once you toggle it in the test view.
                </p>
              </FieldContent>
              <Switch
                id="default-capture-artifacts"
                checked={defaultCaptureArtifacts}
                onCheckedChange={handleDefaultCaptureArtifactsChange}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="default-record-logs">
                  Record console &amp; network by default
                </FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Default value of the “Record console &amp; network” toggle for new tests. Stores
                  the page&apos;s console output and its request URLs with each run, so
                  &ldquo;Debug with AI&rdquo; can offer them when the model asks. Off by default:
                  it is page-controlled data kept on disk. Nothing is ever sent to a model without
                  your explicit approval.
                </p>
              </FieldContent>
              <Switch
                id="default-record-logs"
                checked={defaultRecordLogs}
                onCheckedChange={handleDefaultRecordLogsChange}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="record-all-headers">
                  Record all request headers (may include credentials)
                </FieldLabel>
                <p className="text-sm text-muted-foreground">
                  By default only a safe allowlist of headers is stored — content type, caching and
                  CORS — and every other header is recorded by name with its value omitted. Turn
                  this on only if you need a header outside that set: it will store Authorization,
                  Cookie and anything else the page sends.
                </p>
              </FieldContent>
              <Switch
                id="record-all-headers"
                checked={recordAllHeaders}
                disabled={!defaultRecordLogs}
                onCheckedChange={handleRecordAllHeadersChange}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="artifact-retained-runs">Screenshot history per test</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  How many runs' screenshots to keep for each test before the oldest are deleted
                  (1–50). Pinned visual baselines are never deleted.
                  {artifactUsage
                    ? ` Currently using ${formatBytes(artifactUsage.bytes)} across ${artifactUsage.runs} ${
                        artifactUsage.runs === 1 ? "run" : "runs"
                      }.`
                    : ""}
                </p>
              </FieldContent>
              <Input
                id="artifact-retained-runs"
                type="number"
                min={1}
                max={50}
                step={1}
                className="w-24"
                value={artifactRetainedRuns}
                onChange={(e) => handleArtifactRetainedRunsChange(e.target.value)}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="notify-run-issues">Notify when a run has problems</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Shows a macOS notification when a run fails or a step changes visually. Clean runs
                  stay quiet. Nothing is sent anywhere — the notification is local to this Mac.
                </p>
              </FieldContent>
              <Switch
                id="notify-run-issues"
                checked={notifyOnRunIssues}
                onCheckedChange={handleNotifyOnRunIssuesChange}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="alert-webhook-enabled">Send alerts to a webhook</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  POSTs a short summary to a URL you choose when a run fails, a step changes
                  visually, or a batch finishes with failures. Works with Slack and Discord incoming
                  webhooks. This is the only thing that sends data off this Mac{" "}
                  <strong>automatically</strong> — and it sends a{" "}
                  <strong>summary only</strong>: test name, status, the failing step&apos;s label,
                  counts and timing. Run logs are never included, since they can contain page
                  content and values typed during recording. (Separately, if you pick Claude as the
                  AI provider above, &ldquo;Debug with AI&rdquo; sends the test script and the
                  failing run&apos;s output to Anthropic — but only when you click it.)
                </p>
              </FieldContent>
              <Switch
                id="alert-webhook-enabled"
                checked={alertWebhookEnabled}
                onCheckedChange={handleAlertWebhookEnabledChange}
                disabled={!webhookStatus.hasUrl}
              />
            </Field>
            <Field>
              <FieldContent>
                <FieldLabel htmlFor="alert-webhook-url">Webhook URL</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  {webhookStatus.hasUrl
                    ? `Saved — alerts go to ${webhookStatus.host ?? "the configured host"}. The URL is stored encrypted and never shown again; paste a new one to replace it.`
                    : "Paste an incoming-webhook URL (https://). It's treated as a secret: stored encrypted on this Mac and never read back into this window."}
                </p>
              </FieldContent>
              <div className="flex items-center gap-2">
                <Input
                  id="alert-webhook-url"
                  type="password"
                  value={webhookInput}
                  onChange={(e) => setWebhookInput(e.target.value)}
                  placeholder="https://hooks.slack.com/services/…"
                  disabled={webhookBusy}
                  className="flex-1"
                />
                <Button
                  variant="secondary"
                  onClick={handleSaveWebhookUrl}
                  disabled={webhookBusy || webhookInput.trim().length === 0}
                >
                  Save
                </Button>
                {webhookStatus.hasUrl ? (
                  <>
                    <Button variant="secondary" onClick={handleTestWebhook} disabled={webhookBusy}>
                      Send test
                    </Button>
                    <Button variant="secondary" onClick={handleClearWebhookUrl} disabled={webhookBusy}>
                      Remove
                    </Button>
                  </>
                ) : null}
              </div>
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="artifact-retention-days">Delete screenshots older than</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Days to keep captured screenshots, on top of the history limit above — a run is
                  kept only if it satisfies both. 0 disables the age rule. Pinned visual baselines
                  are never deleted.
                </p>
              </FieldContent>
              <Input
                id="artifact-retention-days"
                type="number"
                min={0}
                max={365}
                step={1}
                className="w-24"
                value={artifactRetentionDays}
                onChange={(e) => handleArtifactRetentionDaysChange(e.target.value)}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Apply retention now</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Deletes anything already past the limits above, across every test. Retention also
                  runs automatically when the app launches and after each test run.
                </p>
              </FieldContent>
              <Button variant="secondary" onClick={handlePruneNow} disabled={pruning}>
                {pruning ? "Cleaning up…" : "Clean up now"}
              </Button>
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="default-run-headless">Run tests in headless mode</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Runs tests without opening a visible browser window. Only affects test runs —
                  the trainer always opens a visible browser. Each test remembers its own choice
                  once you toggle it in the test view.
                </p>
              </FieldContent>
              <Switch
                id="default-run-headless"
                checked={defaultRunHeadless}
                onCheckedChange={handleDefaultRunHeadlessChange}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="default-run-browser">Browser</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Which browser engine test runs use. Each engine downloads once, on its first
                  run. Only affects test runs — the trainer always records in the app&apos;s own
                  browser. Each test remembers its own choice once you pick one in the test view.
                </p>
              </FieldContent>
              <Select
                value={defaultRunBrowser}
                onValueChange={(v) => handleDefaultRunBrowserChange(v as RunBrowser)}
              >
                <SelectTrigger id="default-run-browser" className="w-36">
                  <SelectValue placeholder="Chromium" />
                </SelectTrigger>
                <SelectContent>
                  {RUN_BROWSERS.map((b) => (
                    <SelectItem key={b} value={b}>
                      {RUN_BROWSER_LABELS[b]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        </FieldSet>

        <FieldSet>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="debug-screenshots">Debug screenshots</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Press{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    {debugShortcut || "⌘⌥⇧S"}
                  </code>{" "}
                  at any time to save a picture of every open app window, so you can hand it to
                  Claude Code or another MCP client. That works whether or not this is on.
                  <br />
                  Turning this on additionally lets a connected client ASK for a fresh screenshot
                  and get one back — useful when someone is helping you with a UI problem. It keeps
                  a small watcher running while enabled, which is why it's off by default.
                </p>
              </FieldContent>
              <Switch
                id="debug-screenshots"
                checked={debugScreenshots}
                onCheckedChange={handleDebugScreenshotsChange}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Capture now</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Take one immediately, without the shortcut.
                </p>
              </FieldContent>
              <Button variant="secondary" disabled={capturing} onClick={handleCaptureNow}>
                {capturing ? "Capturing…" : "Capture"}
              </Button>
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="default-a11y">Check accessibility by default</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Runs axe against the page after each action and reports WCAG violations per step
                  in the Visual tab. It never fails a run — a third-party widget shouldn't be able
                  to turn your suite red overnight. Off by default because the check usually costs
                  more per step than everything else the step does; each test has its own toggle.
                </p>
              </FieldContent>
              <Switch
                id="default-a11y"
                checked={defaultA11y}
                onCheckedChange={handleDefaultA11yChange}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="auto-heal-enabled">Auto-Heal</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  When a step's locator can't be found during replay, automatically search the page
                  for alternative target elements using all locator strategies plus context from
                  past runs, matched against what the element looked like when the step was
                  recorded. Applies during trainer replays and real runs. Every heal is recorded on
                  the test's Heals tab, with a one-click way back.
                </p>
              </FieldContent>
              <Switch
                id="auto-heal-enabled"
                checked={autoHealEnabled}
                onCheckedChange={handleAutoHealEnabledChange}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="auto-heal-apply">Apply heals automatically</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Off (recommended): a heal gets the step past its failure and is recorded on the
                  test's Heals tab for you to apply or discard — your saved test is not changed. On:
                  the new locator is written to the step straight away. Worth knowing before you
                  turn this on: a wrong heal usually still succeeds, because clicking the wrong
                  button rarely raises an error.
                </p>
              </FieldContent>
              <Switch
                id="auto-heal-apply"
                checked={autoHealApply === "apply"}
                onCheckedChange={handleAutoHealApplyChange}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="auto-heal-retries">Heal attempts</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  How many times the engine retries finding candidates before giving up (1–10).
                </p>
              </FieldContent>
              <Input
                id="auto-heal-retries"
                type="number"
                min={1}
                max={10}
                step={1}
                className="w-24"
                value={autoHealRetries}
                onChange={(e) => handleAutoHealRetriesChange(e.target.value)}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="auto-heal-timeout">Per-attempt timeout (ms)</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  How long to wait before a single heal attempt is considered timed-out
                  (1000–30000 ms; 1000 ms = 1 second).
                </p>
              </FieldContent>
              <Input
                id="auto-heal-timeout"
                type="number"
                min={1000}
                max={30000}
                step={500}
                className="w-32"
                value={autoHealTimeout}
                onChange={(e) => handleAutoHealTimeoutChange(e.target.value)}
              />
            </Field>
          </FieldGroup>
        </FieldSet>

        <FieldSet>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="ai-thinking-gif">Aesthetic Enhancements</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Optional visual flourishes. Turn any off if you prefer a plainer interface —
                  more are on the way.
                </p>
              </FieldContent>
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="ai-thinking-gif">AI thinking gif</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  While the AI is processing, the glitch gif eases in to fill the debug window
                  over 5 seconds, then eases back out when the response arrives. Window
                  background turns black while active.
                </p>
              </FieldContent>
              <Switch
                id="ai-thinking-gif"
                checked={!disabledEnhancements.includes("aiThinkingGif")}
                onCheckedChange={(checked) => handleToggleEnhancement("aiThinkingGif", checked)}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="home-black-hole">Home screen animation</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  A looping hand-drawn black hole animation on the home screen, above the "Record a
                  Playwright test" text. Switches between a light and dark ink drawing to match the
                  app theme.
                </p>
              </FieldContent>
              <Switch
                id="home-black-hole"
                checked={!disabledEnhancements.includes("homeBlackHole")}
                onCheckedChange={(checked) => handleToggleEnhancement("homeBlackHole", checked)}
              />
            </Field>
          </FieldGroup>
        </FieldSet>

        <FieldSet>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="llm-provider">AI provider</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  {provider === "anthropic"
                    ? "Use Claude via your Anthropic account. Prompts are sent to api.anthropic.com over HTTPS."
                    : "Use a local LLM running on your machine. No data leaves your computer."}
                </p>
              </FieldContent>
              <RadioGroup
                value={provider}
                onValueChange={handleProviderChange}
                orientation="horizontal"
              >
                <Label>
                  <RadioGroupItem value="ollama" />
                  Ollama
                </Label>
                <Label>
                  <RadioGroupItem value="lmstudio" />
                  LM Studio
                </Label>
                <Label>
                  <RadioGroupItem value="anthropic" />
                  Claude
                </Label>
              </RadioGroup>
            </Field>

            {provider !== "anthropic" && (
              <>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="llm-server-url">Server URL</FieldLabel>
                    <p className="text-sm text-muted-foreground">
                      {llmStatus && !llmStatus.reachable
                        ? (llmStatus.error ?? "Not reachable")
                        : `Default: ${defaultUrlFor(provider)}`}
                    </p>
                  </FieldContent>
                  <div className="flex items-center gap-2">
                    {llmStatus && (
                      <Status variant={llmStatus.reachable ? "success" : "error"}>
                        {llmStatus.reachable ? "Online" : "Offline"}
                      </Status>
                    )}
                    <Button variant="muted" onClick={handleTestConnection} disabled={testing}>
                      {testing ? "Testing…" : "Test connection"}
                    </Button>
                  </div>
                </Field>

                <Field orientation="horizontal">
                  <FieldContent>
                    <Input
                      id="llm-server-url"
                      className="w-72"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      placeholder={defaultUrlFor(provider)}
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      onBlur={(e) => handleBaseUrlChange(e.target.value)}
                    />
                  </FieldContent>
                </Field>
              </>
            )}

            {provider === "anthropic" && (
              <>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="anthropic-key">API key</FieldLabel>
                    <p className="text-sm text-muted-foreground">
                      {hasApiKey
                        ? "Stored encrypted on this Mac. Enter a new key to replace it."
                        : "Paste a key from console.anthropic.com. Stored encrypted on this Mac."}
                    </p>
                  </FieldContent>
                  <div className="flex items-center gap-2">
                    {hasApiKey && (
                      <Status variant={llmStatus?.reachable === false ? "error" : "success"}>
                        {llmStatus?.reachable === false ? "Not connected" : "Connected"}
                      </Status>
                    )}
                    {hasApiKey && (
                      <Button variant="muted" onClick={handleClearApiKey}>
                        Clear
                      </Button>
                    )}
                  </div>
                </Field>

                <Field orientation="horizontal">
                  <FieldContent>
                    <div className="flex items-center gap-2">
                      <Input
                        id="anthropic-key"
                        type="password"
                        className="w-72"
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        placeholder="sk-ant-…"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                      />
                      <Button
                        onClick={handleSaveApiKey}
                        disabled={savingKey || !apiKeyInput.trim()}
                      >
                        {savingKey ? "Saving…" : "Save"}
                      </Button>
                    </div>
                  </FieldContent>
                </Field>
              </>
            )}

            {llmStatus?.reachable && llmStatus.models.length > 0 && (
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Model</FieldLabel>
                </FieldContent>
                <Select value={model ?? ""} onValueChange={handleModelChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a model…" />
                  </SelectTrigger>
                  <SelectContent>
                    {llmStatus.models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </FieldGroup>
        </FieldSet>

        <FieldSet>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="keep-running-ai-debug-jobs">
                  Experimental: keep a running AI debug job when a test is re-run
                </FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Re-running a test normally clears its AI debug session, so each run starts from a
                  blank slate. With this on, a job that is still working survives the re-run instead
                  of being cancelled — reachable from the AI debug chip and marked as belonging to
                  the previous run. Finished answers are still cleared either way. Useful with a
                  slow local model, at the cost of a session on screen that describes output you can
                  no longer see.
                </p>
              </FieldContent>
              <Switch
                id="keep-running-ai-debug-jobs"
                checked={keepRunningAiDebugJobs}
                onCheckedChange={handleKeepRunningAiDebugJobsChange}
              />
            </Field>
          </FieldGroup>
        </FieldSet>
      </div>
    </ScrollArea>
  );
}
