// Theme, plus the flourishes.
//
// The two live together deliberately. "Aesthetic Enhancements" used to be a
// FieldSet whose heading was faked as a label-only row — the only heading in
// the whole window — buried between Auto-Heal and the AI provider. Putting the
// flourishes next to the theme control makes this the pane you visit to decide
// how the app LOOKS, which is the only thing they have in common with each
// other and everything they have in common with the theme.

import { Label, RadioGroup, RadioGroupItem, Switch } from "@glaze/core/components";

import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

/** Feature ids inside `disabledAestheticEnhancements`. An id absent from the
 *  array means the flourish is ON — the array records what is switched OFF, so
 *  a new flourish ships enabled without a migration. */
const AI_THINKING_GIF = "aiThinkingGif";
const HOME_BLACK_HOLE = "homeBlackHole";
const AI_STOP_SPINNER = "aiStopSpinner";

export function AppearancePane() {
  const { settings, save, themeSource, setTheme } = useSettingsController();
  const disabled = settings.disabledAestheticEnhancements ?? [];

  const toggleEnhancement = (id: string, enabled: boolean) => {
    const next = enabled ? disabled.filter((e) => e !== id) : [...disabled, id];
    void save({ disabledAestheticEnhancements: next });
  };

  return (
    <>
      <PaneSection>
        <SettingRow id="theme" label="Theme" summary="Follow the system, or pin one.">
          <RadioGroup id="theme" value={themeSource} onValueChange={setTheme} orientation="horizontal">
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
        </SettingRow>
      </PaneSection>

      <PaneSection
        title="Flourishes"
        description="Optional visual flourishes. Turn any off if you prefer a plainer interface — more are on the way."
      >
        <SettingRow
          id="ai-thinking-gif"
          label="AI thinking gif"
          summary="While the AI is processing, the glitch gif fills the debug window."
          details="It eases in over 5 seconds, then eases back out when the response arrives. The window background turns black while it is active."
        >
          <Switch
            id="ai-thinking-gif"
            checked={disabled.indexOf(AI_THINKING_GIF) === -1}
            onCheckedChange={(checked) => toggleEnhancement(AI_THINKING_GIF, checked)}
          />
        </SettingRow>

        <SettingRow
          id="home-black-hole"
          label="Home screen animation"
          summary="A looping hand-drawn black hole above the “Record a Playwright test” text."
          details="It switches between a light and a dark ink drawing to match the app theme."
        >
          <Switch
            id="home-black-hole"
            checked={disabled.indexOf(HOME_BLACK_HOLE) === -1}
            onCheckedChange={(checked) => toggleEnhancement(HOME_BLACK_HOLE, checked)}
          />
        </SettingRow>

        <SettingRow
          id="ai-stop-spinner"
          label="AI stop-button spinner"
          summary="A ring turns around the stop square while the AI is working."
          details="Turning it off leaves the plain stop square — the button still works, and the orange sparkle still says the model is thinking. The ring never spins for anyone who has asked the system to reduce motion."
        >
          <Switch
            id="ai-stop-spinner"
            checked={disabled.indexOf(AI_STOP_SPINNER) === -1}
            onCheckedChange={(checked) => toggleEnhancement(AI_STOP_SPINNER, checked)}
          />
        </SettingRow>
      </PaneSection>
    </>
  );
}
