// The two role rows under Settings → AI: "Instant helpers" and "Autocomplete".
//
// The chat slot IS the pane's provider + model rows above these (the store
// keeps the flat pair and `roles.chat` in step), so only the other two roles
// get a row here. Each is a provider choice plus a model picker, and each has
// a named resting state that is spelled by ABSENCE in the config: instant
// absent means "Same as chat" (the service falls back to the flat pair), and
// autocomplete absent means "Off". Writing a slot back as `null` is how a row
// returns to that state — see `LlmConfigPatch`.
//
// Autocomplete offers local providers only. Ghost text is requested on every
// pause in typing, with the script around the caret as the prompt; a hosted
// provider would mean every such pause leaves the machine. The store refuses
// a hosted autocomplete slot too (`check:editor-egress`), so this row not
// offering one is the visible half of a rule enforced below it.
//
// These rows read the config themselves rather than through the settings
// controller: the controller's LLM surface is the chat slot, and threading
// two more slots through it would give every pane test two more fields to
// fill in for rows only this pane renders. Tests mock `api`, as
// alerts-pane's do.

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  SegmentedControl,
  SegmentedControlItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@ui";

import { api } from "../../lib/api";
import type { LlmProvider, LlmRoleSlot } from "../../lib/llm-types";
import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";

type SlotRole = "instant" | "autocomplete";

export const PROVIDER_LABEL: Record<LlmProvider, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  anthropic: "Claude",
};

const ALL_PROVIDERS: LlmProvider[] = ["ollama", "lmstudio", "anthropic"];
const LOCAL_PROVIDERS: LlmProvider[] = ["ollama", "lmstudio"];

/** Exported so a test can assert the copy without driving a native menu. */
export const ROLE_COPY: Record<SlotRole, { label: string; resting: string; summary: string }> = {
  instant: {
    label: "Instant helpers",
    resting: "Same as chat",
    summary:
      "Quick one-shot jobs: explain the failure at the cursor, sort a rewrite, read a screenshot. A small, fast model suits these; the chat model is fine too.",
  },
  autocomplete: {
    label: "Autocomplete",
    resting: "Off",
    summary:
      "Ghost text while you edit a script, from a fill-in-the-middle code model on this Mac. Local providers only: every pause in typing asks for a completion, and a hosted provider would send each one off the machine.",
  },
};

export const NO_MODEL_HINT = "Pick a model. A code model (qwen2.5-coder, starcoder2, codellama) completes best; a chat model will guess.";
export const NO_MODELS_LISTED = "Could not list models — is the server running?";

export const LLM_CONFIG_KEY = ["llm", "config"] as const;

export function RoleSlotRows() {
  return (
    <>
      <RoleSlotRow role="instant" />
      <RoleSlotRow role="autocomplete" />
    </>
  );
}

function RoleSlotRow({ role }: { role: SlotRole }) {
  const { provider: chatProvider, model: chatModel } = useSettingsController();
  const qc = useQueryClient();
  const config = useQuery({ queryKey: LLM_CONFIG_KEY, queryFn: () => api.llm.getConfig() });
  const slot: LlmRoleSlot | null = config.data?.roles?.[role] ?? null;
  const providers = role === "autocomplete" ? LOCAL_PROVIDERS : ALL_PROVIDERS;
  const models = useQuery({
    queryKey: ["llm", "models", slot?.provider ?? null],
    queryFn: () => api.llm.listModels(slot!.provider),
    enabled: slot !== null,
    retry: false,
  });

  const write = async (next: LlmRoleSlot | null) => {
    try {
      await api.llm.setConfig({ roles: { [role]: next } });
      await qc.invalidateQueries({ queryKey: LLM_CONFIG_KEY });
    } catch (err) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const copy = ROLE_COPY[role];
  const id = `llm-role-${role}`;
  const using = slot
    ? `Using ${PROVIDER_LABEL[slot.provider]}${slot.model ? ` · ${slot.model}` : ""}.`
    : role === "instant"
      ? `Using the chat model: ${PROVIDER_LABEL[chatProvider]}${chatModel ? ` · ${chatModel}` : ""}.`
      : "Off.";

  const listed = models.data ?? [];
  // The configured model stays pickable even when the server does not list
  // it (offline, or unloaded) — otherwise the picker would show blank for a
  // choice that is in fact saved.
  const options = slot?.model && !listed.some((m) => m.id === slot.model) ? [{ id: slot.model, label: slot.model }, ...listed] : listed;

  let hint: string | null = null;
  if (slot && models.isError) hint = NO_MODELS_LISTED;
  else if (slot && !slot.model && models.isSuccess) hint = role === "autocomplete" ? NO_MODEL_HINT : "Pick a model.";

  return (
    <SettingRow
      id={id}
      label={copy.label}
      summary={
        <>
          {copy.summary} <span data-testid={`${id}-using`}>{using}</span>
          {hint ? <span data-testid={`${id}-hint`}> {hint}</span> : null}
        </>
      }
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        <SegmentedControl
          id={id}
          aria-label={`${copy.label} provider`}
          value={slot ? slot.provider : "none"}
          onValueChange={(v) => {
            if (v === "none") void write(null);
            else if (v !== slot?.provider) void write({ provider: v as LlmProvider, model: null });
          }}
        >
          <SegmentedControlItem value="none">{copy.resting}</SegmentedControlItem>
          {providers.map((p) => (
            <SegmentedControlItem key={p} value={p}>
              {PROVIDER_LABEL[p]}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        {slot ? (
          <Select
            value={slot.model ?? ""}
            onValueChange={(v) => void write({ provider: slot.provider, model: v || null })}
          >
            <SelectTrigger className="w-56" aria-label={`${copy.label} model`}>
              <SelectValue placeholder={models.isPending ? "Listing models…" : "Choose a model"} />
            </SelectTrigger>
            <SelectContent>
              {options.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
    </SettingRow>
  );
}
