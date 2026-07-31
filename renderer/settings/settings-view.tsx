import { useState, useEffect } from "react";
import {
  Button,
  Label,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
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

export function SettingsView() {
  const [themeInfo, setThemeInfo] = useState<NativeThemeInfo | null>(null);
  const [_isLoading, setIsLoading] = useState(true);

  // ── Local LLM provider settings ─────────────────────────────────────
  const [provider, setProvider] = useState<LlmProvider>("ollama");
  const [model, setModel] = useState<string | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmProviderStatus | null>(null);
  const [testing, setTesting] = useState(false);

  // ── Trainer settings ─────────────────────────────────────────────────
  const [showUrlBar, setShowUrlBar] = useState(true);

  useEffect(() => {
    api.llm
      .getConfig()
      .then((cfg) => {
        setProvider(cfg.provider);
        setModel(cfg.model);
      })
      .catch(() => {
        /* fall back to defaults */
      });
    api.recorder
      .getSettings()
      .then((settings) => setShowUrlBar(settings.showUrlBar))
      .catch(() => {
        /* fall back to default (on) */
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

  const handleProviderChange = async (value: string) => {
    const next = value === "lmstudio" ? "lmstudio" : "ollama";
    setProvider(next);
    setLlmStatus(null);
    setModel(null);
    try {
      await api.llm.setConfig({ provider: next, model: null });
    } catch (error) {
      toast.error(`Failed to save provider: ${error}`);
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
          </FieldGroup>
        </FieldSet>

        <FieldSet>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="llm-provider">Local AI provider</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Use a local LLM running on your machine. No data leaves your computer.
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
              </RadioGroup>
            </Field>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Connection</FieldLabel>
                {llmStatus ? (
                  <p className="text-sm text-muted-foreground">
                    {llmStatus.reachable
                      ? `Connected at ${llmStatus.baseUrl}`
                      : (llmStatus.error ?? "Not reachable")}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {provider === "ollama"
                      ? "Default: http://127.0.0.1:11434"
                      : "Default: http://127.0.0.1:1234"}
                  </p>
                )}
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

            {llmStatus?.reachable && llmStatus.models.length > 0 && (
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Model</FieldLabel>
                </FieldContent>
                <RadioGroup value={model ?? ""} onValueChange={handleModelChange}>
                  {llmStatus.models.map((m) => (
                    <Label key={m.id}>
                      <RadioGroupItem value={m.id} />
                      {m.label}
                    </Label>
                  ))}
                </RadioGroup>
              </Field>
            )}
          </FieldGroup>
        </FieldSet>
      </div>
    </ScrollArea>
  );
}
