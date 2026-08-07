// The training window you record in.
//
// All three of these describe the browser window the TRAINER opens — as
// distinct from the one a test RUN opens, which is Test defaults. The old flat
// list interleaved them, so "Dock the trainer to the browser" sat two rows
// above "Capture screenshots by default" with nothing marking the change of
// subject.

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from "@glaze/core/components";

import {
  DEFAULT_VIEWPORT_PRESET_ID,
  VIEWPORT_PRESETS,
  presetIdForViewport,
  viewportForPresetId,
} from "../../lib/viewport-presets";
import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

export function RecordingPane() {
  const { settings, save } = useSettingsController();

  return (
    <PaneSection>
      <SettingRow
        id="show-url-bar"
        label="Show URL bar in training window"
        summary="Shows the current page's URL in the training window's title bar while recording."
      >
        <Switch
          id="show-url-bar"
          checked={settings.showUrlBar ?? true}
          onCheckedChange={(checked) => void save({ showUrlBar: checked })}
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
    </PaneSection>
  );
}
