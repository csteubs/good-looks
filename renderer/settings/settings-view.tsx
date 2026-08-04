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
import type { TestSpeed } from "../lib/recorder-types";

const SPEEDS: TestSpeed[] = ["slow", "medium", "fast"];
const SPEED_LABEL: Record<TestSpeed, string> = { slow: "Slow", medium: "Medium", fast: "Fast" };

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
  const [defaultRunSpeed, setDefaultRunSpeed] = useState<TestSpeed>("slow");
  const [defaultCaptureArtifacts, setDefaultCaptureArtifacts] = useState(false);

  // ── Auto-Heal settings ──────────────────────────────────────────────
  const [autoHealEnabled, setAutoHealEnabled] = useState(true);
  const [autoHealRetries, setAutoHealRetries] = useState(3);
  const [autoHealTimeout, setAutoHealTimeout] = useState(4000);

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
        setDefaultRunSpeed(settings.defaultRunSpeed ?? "slow");
        setDefaultCaptureArtifacts(settings.defaultCaptureArtifacts ?? false);
        setAutoHealEnabled(settings.autoHealEnabled ?? true);
        setAutoHealRetries(settings.autoHealRetries ?? 3);
        setAutoHealTimeout(settings.autoHealAttemptTimeoutMs ?? 4000);
      })
      .catch(() => {
        /* fall back to defaults */
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

  const handleAutoHealTimeoutChange = async (value: string) => {
    const ms = Math.max(1000, Math.min(30000, Math.round(Number(value) || 4000)));
    setAutoHealTimeout(ms);
    try {
      await api.recorder.setSettings({ autoHealAttemptTimeoutMs: ms });
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
          </FieldGroup>
        </FieldSet>

        <FieldSet>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="auto-heal-enabled">Auto-Heal</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  When a step's locator can't be found during replay, automatically search the page
                  for alternative target elements using all locator strategies plus context from
                  past runs. The best match is auto-applied; all candidates appear in the Console
                  for you to choose from.
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
      </div>
    </ScrollArea>
  );
}
