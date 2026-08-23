// The model behind Debug with AI and Generate from prompt.
//
// The API key input keeps its value in THIS component rather than in the
// controller, and clears it the moment the save succeeds. The key is
// write-only by design — the backend stores it encrypted and never hands it
// back — so the renderer holding one in shared state for the rest of the
// session would be the only place it lingers.

import { useState } from "react";
import {
  Button,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Status,
} from "@ui";

import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";
import { RoleSlotRows } from "./ai-role-rows";

export function AiPane() {
  const {
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
  } = useSettingsController();

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");

  const onSaveKey = async () => {
    await saveApiKey(apiKeyInput);
    // Don't hold the key in renderer state once it's been handed over.
    setApiKeyInput("");
  };

  const onSaveToken = async () => {
    await saveLmStudioToken(tokenInput);
    setTokenInput("");
  };

  return (
    <PaneSection>
      <SettingRow
        id="llm-provider"
        label="AI provider"
        summary={
          provider === "anthropic"
            ? "Use Claude via your Anthropic account. Prompts are sent to api.anthropic.com over HTTPS."
            : "Use a local LLM running on your machine. No data leaves your computer."
        }
      >
        <RadioGroup
          id="llm-provider"
          value={provider}
          onValueChange={(v) => void changeProvider(v)}
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
      </SettingRow>

      {provider !== "anthropic" ? (
        <SettingRow
          id="llm-server-url"
          label="Server URL"
          summary={
            llmStatus && !llmStatus.reachable
              ? (llmStatus.error ?? "Not reachable")
              : `Default: ${defaultUrlFor(provider)}`
          }
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            {llmStatus ? (
              <Status variant={llmStatus.reachable ? "success" : "error"}>
                {llmStatus.reachable ? "Online" : "Offline"}
              </Status>
            ) : null}
            <Input
              id="llm-server-url"
              className="w-64"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={defaultUrlFor(provider)}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={(e) => void commitBaseUrl(e.target.value)}
            />
            <Button variant="muted" onClick={() => void testConnection()} disabled={testing}>
              {testing ? "Testing…" : "Test connection"}
            </Button>
          </div>
        </SettingRow>
      ) : null}

      {/* No Status chip here on purpose: the Server URL row above already
          reports Online/Offline for this provider, and a second indicator for
          the same connection is how you end up with two that disagree. */}
      {provider === "lmstudio" ? (
        <SettingRow
          id="lmstudio-token"
          label="API token"
          summary={
            hasLmStudioToken
              ? "Stored encrypted on this Mac. Enter a new token to replace it."
              : "Only needed if you turned authentication on in LM Studio (Developer → server settings). Stored encrypted on this Mac."
          }
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Input
              id="lmstudio-token"
              type="password"
              className="w-56"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={hasLmStudioToken ? "••••••••" : "Paste token…"}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
            <Button onClick={() => void onSaveToken()} disabled={savingKey || !tokenInput.trim()}>
              {savingKey ? "Saving…" : "Save"}
            </Button>
            {hasLmStudioToken ? (
              <Button variant="muted" onClick={() => void clearLmStudioToken()}>
                Clear
              </Button>
            ) : null}
          </div>
        </SettingRow>
      ) : null}

      {provider === "anthropic" ? (
        <SettingRow
          id="anthropic-key"
          label="API key"
          summary={
            hasApiKey
              ? "Stored encrypted on this Mac. Enter a new key to replace it."
              : "Paste a key from console.anthropic.com. Stored encrypted on this Mac."
          }
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            {hasApiKey ? (
              <Status variant={llmStatus?.reachable === false ? "error" : "success"}>
                {llmStatus?.reachable === false ? "Not connected" : "Connected"}
              </Status>
            ) : null}
            <Input
              id="anthropic-key"
              type="password"
              className="w-56"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="sk-ant-…"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
            <Button onClick={() => void onSaveKey()} disabled={savingKey || !apiKeyInput.trim()}>
              {savingKey ? "Saving…" : "Save"}
            </Button>
            {hasApiKey ? (
              <Button variant="muted" onClick={() => void clearApiKey()}>
                Clear
              </Button>
            ) : null}
          </div>
        </SettingRow>
      ) : null}

      {llmStatus?.reachable && llmStatus.models.length > 0 ? (
        <SettingRow id="llm-model" label="Model">
          <Select value={model ?? ""} onValueChange={(v) => void changeModel(v)}>
            <SelectTrigger id="llm-model" className="w-56">
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
        </SettingRow>
      ) : null}

      {/* The chat slot is the provider + model above; the other two roles. */}
      <RoleSlotRows />
    </PaneSection>
  );
}
