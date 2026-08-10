// Theme, plus the flourishes.
//
// The two live together deliberately. "Aesthetic Enhancements" used to be a
// FieldSet whose heading was faked as a label-only row — the only heading in
// the whole window — buried between Auto-Heal and the AI provider. Putting the
// flourishes next to the theme control makes this the pane you visit to decide
// how the app LOOKS, which is the only thing they have in common with each
// other and everything they have in common with the theme.

import { Switch, Text } from "@ui";

import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

/** Feature ids inside `disabledAestheticEnhancements`. An id absent from the
 *  array means the flourish is ON — the array records what is switched OFF, so
 *  a new flourish ships enabled without a migration. */
const AI_THINKING_GIF = "aiThinkingGif";
const HOME_BLACK_HOLE = "homeBlackHole";

export function AppearancePane() {
  const { settings, save } = useSettingsController();
  const disabled = settings.disabledAestheticEnhancements ?? [];

  const toggleEnhancement = (id: string, enabled: boolean) => {
    const next = enabled ? disabled.filter((e) => e !== id) : [...disabled, id];
    void save({ disabledAestheticEnhancements: next });
  };

  return (
    <>
      <PaneSection>
        {/* THE CONTROL IS GONE AND THE ROW STAYS, deliberately.
         *
         * The app is dark only now (REDESIGN §0): the palette is near-black
         * with phosphor accents, a light variant is a second design rather
         * than a token swap, and the CRT treatment has no light reading. What
         * shipped before was Auto / Light / Dark, so someone who had pinned
         * Light will notice — and a row that answers "where did the theme
         * setting go?" is worth more than the space it costs. It also carries
         * the honest tense: "for now" is a statement about this release, not a
         * promise about the next one.
         *
         * Deleting the row entirely was the alternative and it loses that: the
         * setting would simply be absent, which reads as a bug in a window
         * whose whole job is to enumerate what can be changed. */}
        <SettingRow
          id="theme"
          label="Theme"
          summary="Dark only for now."
          details="The redesign is built on a near-black palette with phosphor accents and two texture layers. A light variant is a different design rather than a swap of colour values — the screenshot bezel in particular has no light reading — so rather than ship a worse version of the same idea there is one theme, and it is this one."
        >
          <Text variant="small" color="secondary">
            Dark
          </Text>
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
      </PaneSection>
    </>
  );
}
