// The training window you record in.
//
// All three of these describe the browser window the TRAINER opens — as
// distinct from the one a test RUN opens, which is Test defaults. The old flat
// list interleaved them, so "Dock the trainer to the browser" sat two rows
// above "Capture screenshots by default" with nothing marking the change of
// subject.

import * as React from "react";
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Text } from "@ui";

import {
  DEFAULT_VIEWPORT_PRESET_ID,
  VIEWPORT_PRESETS,
  presetIdForViewport,
  viewportForPresetId,
} from "../../lib/viewport-presets";
import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

/** The suggestion strip's disclosure — the alerts pane's riskFor shape: one
 *  sentence of what goes, one of what never goes, one naming the
 *  destination. `risk`, not `details`, because it has no closed state to
 *  hide in, and check:agent-egress is what keeps the first two sentences
 *  true. */
function suggestionRiskFor(provider: string): string {
  const payload =
    "After each recorded step, this sends the step list's descriptions and a bounded inventory of the page's visible controls — tags, roles, labels, visible text — to the configured AI provider, without a per-send review. Never what you type into a field, page HTML, run logs, script sources, headers, or secret values.";
  if (provider === "anthropic") {
    return `${payload} With Claude selected, that goes to api.anthropic.com.`;
  }
  return `${payload} With a local provider selected, it goes to your own server on this machine.`;
}

export function RecordingPane() {
  const { settings, save, provider } = useSettingsController();
  const [cssDraft, setCssDraft] = React.useState<string | null>(null);
  const [jsDraft, setJsDraft] = React.useState<string | null>(null);

  // Draft-local, saved on blur/Enter: the store normalizes hard (grammar,
  // dedupe, cap), and saving per keystroke would delete a half-typed
  // "data-c" out from under the user — the variables panel's lesson.
  const [tidDraft, setTidDraft] = React.useState(
    (settings.extraTestIdAttributes ?? []).join(", "),
  );
  const [tidSeeded, setTidSeeded] = React.useState(settings.extraTestIdAttributes);
  if (tidSeeded !== settings.extraTestIdAttributes) {
    setTidSeeded(settings.extraTestIdAttributes);
    setTidDraft((settings.extraTestIdAttributes ?? []).join(", "));
  }
  const commitTid = () =>
    void save({
      extraTestIdAttributes: tidDraft
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== ""),
    });

  return (
    <PaneSection>
      <SettingRow
        id="show-url-bar"
        label="Show URL bar in training window"
        summary="Adds a bar above the page showing where you are, with a button to assert on it."
        details="The bar is read-only: every navigation in a recording is either the opening step or the result of one of your actions, so typing an address would produce a test that replays a different journey than the one you recorded. Turning this off gives the page the full window."
      >
        <Switch
          id="show-url-bar"
          checked={settings.showUrlBar ?? true}
          onCheckedChange={(checked) => void save({ showUrlBar: checked })}
        />
      </SettingRow>

      <SettingRow
        id="user-stylesheet"
        label="Page stylesheet"
        summary="CSS added to every page the trainer loads and to every page of a recorded test's runs. Hide a chat widget, pin a banner, make a fixed header static."
        details="Both halves, by design: a widget hidden only while recording is a test that passes in the trainer and fails in the run. In a run the stylesheet is added on every document's domcontentloaded and load; in the trainer on dom-ready. Imported specs are never touched."
      >
        <textarea
          id="user-stylesheet"
          className="gl-setting-textarea"
          rows={4}
          spellCheck={false}
          placeholder="#chat-widget, .cookie-banner { display: none !important; }"
          value={cssDraft ?? settings.userStylesheet ?? ""}
          onChange={(e) => setCssDraft(e.target.value)}
          onBlur={() => {
            if (cssDraft !== null && cssDraft !== (settings.userStylesheet ?? "")) void save({ userStylesheet: cssDraft });
            setCssDraft(null);
          }}
        />
      </SettingRow>

      <SettingRow
        id="user-init-script"
        label="Page init script"
        summary="JavaScript run in every page the trainer loads and in every page of a recorded test's runs — before the page's own code in a run, on dom-ready in the trainer."
        risk="This is your code, and it runs on every site the trainer visits and every page a run opens, with that page's own access: its cookies, its storage, its network. Nothing here reaches the app or Node. Keep it to what every site you test needs."
        flag="runs code in every page"
      >
        <textarea
          id="user-init-script"
          className="gl-setting-textarea"
          rows={4}
          spellCheck={false}
          placeholder="window.__consentGiven = true;"
          value={jsDraft ?? settings.userInitScript ?? ""}
          onChange={(e) => setJsDraft(e.target.value)}
          onBlur={() => {
            if (jsDraft !== null && jsDraft !== (settings.userInitScript ?? "")) void save({ userInitScript: jsDraft });
            setJsDraft(null);
          }}
        />
      </SettingRow>

      <SettingRow
        id="trainer-panel"
        label="Dock the trainer to the browser"
        summary="Pins the step list and tools beside the training browser, so you don't switch windows for every step."
        details="The panel follows the browser when you move or resize it, and can be undocked. Docking narrows the training browser to make room."
      >
        <Switch
          id="trainer-panel"
          checked={settings.trainerPanelEnabled ?? false}
          onCheckedChange={(checked) => void save({ trainerPanelEnabled: checked })}
        />
      </SettingRow>

      <SettingRow
        id="ai-suggestions-enabled"
        label="AI step suggestions"
        summary="Offer suggested next steps as chips in the trainer after each recorded step. A taken suggestion is tried on the live page before it is inserted."
        risk={suggestionRiskFor(provider)}
        flag="sends page summaries"
      >
        <Switch
          id="ai-suggestions-enabled"
          checked={settings.aiSuggestionsEnabled ?? false}
          onCheckedChange={(checked) => void save({ aiSuggestionsEnabled: checked })}
        />
      </SettingRow>

      <SettingRow
        id="default-window-size"
        label="Default window size"
        summary="The size the browser opens at for new recordings."
        details="The size is recorded with the test, so it replays at the size it was recorded at. “Default” fits the window to your screen and records no size."
      >
        <Select
          value={presetIdForViewport(settings.defaultWindowSize ?? null) || DEFAULT_VIEWPORT_PRESET_ID}
          onValueChange={(value) => void save({ defaultWindowSize: viewportForPresetId(value) })}
        >
          <SelectTrigger id="default-window-size" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VIEWPORT_PRESETS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        id="extra-testid-attributes"
        label="Extra test-id attributes"
        summary="Attribute names the recorder treats as test ids, beyond data-testid — your team's own convention."
        details="Comma-separated, lowercase data-* names (data-cy, data-qa). data-testid, data-test-id and data-test are always probed. A step recorded off an extra attribute keeps working if the list changes later — the attribute is stored on the step. Names outside the data-* grammar are dropped on save, because they end up inside selectors in the generated spec."
      >
        <div className="flex flex-col items-end gap-1">
          <Input
            id="extra-testid-attributes"
            aria-label="Extra test-id attributes"
            value={tidDraft}
            placeholder="data-cy, data-qa"
            className="w-64 font-mono"
            onChange={(e) => setTidDraft(e.target.value)}
            onBlur={commitTid}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTid();
            }}
          />
          <Text size="small" className="text-tertiary">
            Saved: {(settings.extraTestIdAttributes ?? []).join(", ") || "none"}
          </Text>
        </div>
      </SettingRow>
    </PaneSection>
  );
}
