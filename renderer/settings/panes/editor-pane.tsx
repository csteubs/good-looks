// The Script tab's editor — what it is drawn in, and what a save checks.
//
// Kept apart from Appearance on purpose: Appearance is about the APP, and its
// font-size row is a zoom of every window. The editor's size is its own
// number (a spec is read at a different size from a label), and the rows
// beside it are not appearance at all — whether a save asks Playwright if
// the file loads is a question about the gate, and it sits next to the
// editor because that is where the user meets the answer.
//
// Every control here is a plain button or switch: `Segmented` renders
// `<button aria-pressed>` rows, and the native-menu Select this app uses
// elsewhere cannot be driven in jsdom.

import { Switch } from "@ui";
import { Segmented } from "../../theme";

import { EDITOR_KEYMAP_LABELS, prettyKey, rowsFor } from "../../main/editor-keymaps";
import {
  EDITOR_FONT_SIZE_DEFAULT,
  EDITOR_KEYMAPS,
  type EditorKeymap,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_TAB_SIZES,
  type EditorTabSize,
} from "../../lib/recorder-types";
import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

/** The sizes offered. Every whole pixel in the range would be a row of eleven
 *  buttons; these are the ones a reader reaches for. */
export const EDITOR_FONT_SIZE_OPTIONS: readonly number[] = [11, 12, 13, 14, 15, 16, 18];

export function EditorPane() {
  const { settings, save } = useSettingsController();
  const fontSize = settings.editorFontSize ?? EDITOR_FONT_SIZE_DEFAULT;
  const sizes = EDITOR_FONT_SIZE_OPTIONS.filter((s) => s >= EDITOR_FONT_SIZE_MIN && s <= EDITOR_FONT_SIZE_MAX);
  // A stored size that is not one of the offered buttons (set by hand in the
  // file) still shows as the pressed value rather than as nothing.
  const sizeOptions = (sizes.includes(fontSize) ? sizes : [...sizes, fontSize].sort((a, b) => a - b)).map((s) => ({
    value: String(s),
    label: `${s}px`,
  }));

  return (
    <>
      <PaneSection>
        <SettingRow
          id="editor-font-size"
          label="Font size"
          summary="The size the script is set in. Line height follows it."
          details="This is the editor's own size, not the app zoom in Appearance: a spec is read at a different size from a label. The gutter and the text are sized from the same number, so they cannot drift apart."
        >
          <Segmented
            label="Editor font size"
            value={String(fontSize)}
            options={sizeOptions}
            onChange={(v) => void save({ editorFontSize: Number(v) })}
          />
        </SettingRow>

        <SettingRow
          id="editor-line-wrap"
          label="Wrap long lines"
          summary="Off: a long line scrolls sideways. On: it folds onto the next row."
          details="A spec's long lines are locator chains and logged URLs. Off by default because a wrapped chain hides where the statement ends, which is the thing the eye is looking for when a step fails."
        >
          <Switch
            id="editor-line-wrap"
            checked={settings.editorLineWrap ?? false}
            onCheckedChange={(checked) => void save({ editorLineWrap: checked })}
          />
        </SettingRow>

        <SettingRow
          id="editor-line-numbers"
          label="Line numbers"
          summary="The number beside every line. The run and coverage marks stay either way."
        >
          <Switch
            id="editor-line-numbers"
            checked={settings.editorLineNumbers ?? true}
            onCheckedChange={(checked) => void save({ editorLineNumbers: checked })}
          />
        </SettingRow>

        <SettingRow
          id="editor-keymap"
          label="Keymap"
          summary="Which editor's keys the Script tab answers to. ⌘K stays the command palette in every preset, and ⌘I is inline AI."
          details={
            <table className="gl-keymap-table" aria-label="Bindings in this keymap">
              <tbody>
                {rowsFor(settings.editorKeymap ?? "default").map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td>
                      <kbd>{prettyKey(r.key)}</kbd>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          <Segmented
            label="Keymap"
            value={settings.editorKeymap ?? "default"}
            options={EDITOR_KEYMAPS.map((k) => ({ value: k, label: EDITOR_KEYMAP_LABELS[k] }))}
            onChange={(v) => void save({ editorKeymap: v as EditorKeymap })}
          />
        </SettingRow>

        <SettingRow
          id="editor-tab-size"
          label="Tab size"
          summary="How wide a tab is drawn, and how far Tab indents."
          details="Generated scripts are written with two spaces; four matches most hand-written Playwright projects an imported suite comes from."
        >
          <Segmented
            label="Tab size"
            value={String(settings.editorTabSize ?? 2)}
            options={EDITOR_TAB_SIZES.map((t) => ({ value: String(t), label: `${t} spaces` }))}
            onChange={(v) => void save({ editorTabSize: Number(v) as EditorTabSize })}
          />
        </SettingRow>
      </PaneSection>

      <PaneSection
        title="Saving"
        description="What the Script tab asks before it writes a draft over the test's script."
      >
        <SettingRow
          id="editor-check-on-save"
          label="Check with Playwright before saving"
          summary="Hands the draft to the Playwright CLI and refuses a save it cannot load."
          details="About half a second: the same CLI a run uses loads the draft, resolves its imports and collects its tests without starting a browser, so a missing bracket or a module that does not resolve is reported on its line instead of as “No tests found” on the next run. It does not check types. Off, Save still refuses a draft that something else has overwritten on disk, and still asks before saving statements the Steps tab will stop tracking."
        >
          <Switch
            id="editor-check-on-save"
            checked={settings.editorCheckOnSave ?? true}
            onCheckedChange={(checked) => void save({ editorCheckOnSave: checked })}
          />
        </SettingRow>

        <SettingRow
          id="editor-format-on-save"
          label="Format on save"
          summary="TypeScript's own formatter over the draft before it is checked and saved: two-space indent, the generator's style. Needs the type service (the Script tab says ‘Types ready’)."
        >
          <Switch
            id="editor-format-on-save"
            checked={settings.editorFormatOnSave ?? true}
            onCheckedChange={(checked) => void save({ editorFormatOnSave: checked })}
          />
        </SettingRow>
      </PaneSection>
    </>
  );
}
