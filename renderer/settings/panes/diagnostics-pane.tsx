// Diagnostics — tools for handing this app's state to someone helping you.
//
// RENAMED FROM "ADVANCED" IN B4, and the rename is the point rather than
// tidying. "Advanced" is a promise about difficulty and it attracts everything
// nobody could place: it becomes the pane where settings go to be lost, and a
// user reading it cannot tell whether the contents are dangerous, experimental
// or simply obscure. What is actually in here is a screenshot shortcut and a
// capture button — tools for producing evidence for whoever is helping you.
// That is diagnostics, and naming it that is what stops the next unplaceable
// setting landing here by default (it has somewhere else to go now: the
// Experiments pane, which is where a flag that changes how a RUN behaves
// belongs — see REDESIGN §B4).
//
// Debug screenshots used to open the third FieldSet, above "Check accessibility
// by default" and the Auto-Heal block — so the first thing under a heading-less
// divider was a developer utility, and the a11y default it sat next to actually
// belonged with the other per-test defaults. It has been moved there; this pane
// is what was genuinely left over.

import { Button, Switch } from "@ui";

import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

export function DiagnosticsPane() {
  const { settings, save, debugShortcut, capturing, captureNow } = useSettingsController();

  return (
    <PaneSection>
      <SettingRow
        id="debug-screenshots"
        label="Debug screenshots"
        summary={
          <>
            Press{" "}
            <code className="bg-control-subtle rounded px-1 py-0.5 text-xs">
              {debugShortcut || "⌘⌥⇧S"}
            </code>{" "}
            at any time to save a picture of every open app window, so you can hand it to Claude Code
            or another MCP client. That works whether or not this is on.
          </>
        }
        details="Turning this on additionally lets a connected client ASK for a fresh screenshot and get one back — useful when someone is helping you with a UI problem. It keeps a small watcher running while enabled, which is why it's off by default."
      >
        <Switch
          id="debug-screenshots"
          checked={settings.debugScreenshots ?? false}
          onCheckedChange={(checked) => void save({ debugScreenshots: checked })}
        />
      </SettingRow>

      <SettingRow
        id="debug-capture-now"
        label="Capture now"
        summary="Take one immediately, without the shortcut."
      >
        <Button variant="secondary" disabled={capturing} onClick={() => void captureNow()}>
          {capturing ? "Capturing…" : "Capture"}
        </Button>
      </SettingRow>
    </PaneSection>
  );
}
