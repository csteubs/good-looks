// Theme, plus the flourishes.
//
// The two live together deliberately. "Aesthetic Enhancements" used to be a
// FieldSet whose heading was faked as a label-only row — the only heading in
// the whole window — buried between Auto-Heal and the AI provider. Putting the
// flourishes next to the theme control makes this the pane you visit to decide
// how the app LOOKS, which is the only thing they have in common with each
// other and everything they have in common with the theme.

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Text } from "@ui";
import { Segmented } from "../../theme";

import { applyTypeface, asTypeface } from "../../lib/typeface";
import {
  UI_SCALE_LABELS,
  UI_SCALES,
  UI_TYPEFACE_LABELS,
  UI_TYPEFACES,
} from "../../lib/recorder-types";
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

      {/* TYPOGRAPHY. Two settings that both answer "how is this app set", kept
       *  above the flourishes because they change every screen rather than one.
       *
       *  ONE OF THESE CANNOT BE SEEN IN THE BROWSER PREVIEW. Font size is a
       *  zoom factor applied by the main process to each window's webContents,
       *  and `npm run dev:web` has no main process — the control saves and the
       *  preview does not resize. That is not a bug in the pane; it has to be
       *  checked in `npm run dev`. Typeface works in both. */}
      <PaneSection title="Typography">
        {/* SEGMENTED RATHER THAN A SELECT, and not only for looks. The SDK's
         *  Select is backed by a real macOS menu, so its options never enter
         *  the DOM (CLAUDE.md) — a test can still reach them, by answering the
         *  `glazeAPI.Menu.popup` promise itself, but that is scaffolding a
         *  reader has to understand before they can trust the assertion.
         *  Segmented renders ordinary `<button aria-pressed>` elements, so the
         *  control that decides whether the app is legible is one a plain
         *  click drives — here, and for whoever is debugging it later. */}
        <SettingRow
          id="ui-scale"
          label="Font size"
          summary="How big the app is drawn. Text and the controls around it grow together."
          details="This is a zoom, not a type size: the interface is laid out in whole pixels — 9.5px labels inside 24px controls — so growing the text on its own would push it out of the chrome around it rather than making it easier to read. It applies to this app's own windows only. The browser you record in is never scaled, because its size decides what the site under test renders and what a click lands on."
        >
          <Segmented
            label="Font size"
            value={String(settings.uiScale ?? 1)}
            options={UI_SCALES.map((s) => ({
              value: String(s),
              label: UI_SCALE_LABELS[String(s)] ?? String(s),
            }))}
            onChange={(v) => void save({ uiScale: Number(v) as (typeof UI_SCALES)[number] })}
          />
        </SettingRow>

        <SettingRow
          id="ui-typeface"
          label="Typeface"
          summary="Which pair of faces the interface is set in."
          details="Space Mono and Space Grotesk ship inside the app and are what it was designed in. The other two are faces macOS already has, so choosing them loads nothing and fetches nothing — this app never requests a font over the network. Uppercase labels are letterspaced more in the system and classic pairings, because Space Mono is a wide face and the tighter spacing was chosen for it."
        >
          <Select
            value={asTypeface(settings.uiTypeface)}
            onValueChange={(v) => {
              const next = asTypeface(v);
              // Applied here as well as saved. This was the only thing that
              // worked while Settings was its own window: it did not receive the
              // backend's appearance push — only the main window and the
              // trainer panel do — so without this line the one window the user
              // was looking at was the one that would not change. Settings is a
              // route in the main window now and does get the push; the direct
              // call stays because it lands the change in the same frame as the
              // click rather than after an IPC round trip.
              applyTypeface(next);
              void save({ uiTypeface: next });
            }}
          >
            <SelectTrigger id="ui-typeface" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UI_TYPEFACES.map((t) => (
                <SelectItem key={t} value={t}>
                  {UI_TYPEFACE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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

      {/* THE OPT-IN OWED SINCE §3.5, and it lives here rather than in a
       *  credentials pane because what the user is choosing between is two
       *  ways the sidebar can LOOK. The cost of the prettier one is what the
       *  `risk` block is for.
       *
       *  `risk` and not `summary`: this is the second outbound channel in the
       *  product and the first one nobody has to configure to trigger. In
       *  `summary` it would be one description among thirty. `flag` as well,
       *  so the row is identifiable as an egress row while scrolling past. */}
      <PaneSection title="Site icons">
        <SettingRow
          id="site-icons-from-web"
          label="Fetch site icons from the web"
          flag="leaves this Mac"
          summary="Off, every site in your library draws a generated monogram — two letters on a colour derived from the hostname, computed on this machine."
          risk="On, this app asks icons.duckduckgo.com for an icon for every site in your library, which tells them the hostname of everything you test — including staging and internal hosts. It happens whenever the sidebar draws, not only when you add a test."
        >
          <Switch
            id="site-icons-from-web"
            checked={settings.siteIconsFromWeb ?? false}
            onCheckedChange={(checked) => void save({ siteIconsFromWeb: checked })}
          />
        </SettingRow>
      </PaneSection>
    </>
  );
}
