// Tools for handing this app's state to someone helping you.
//
// Debug screenshots used to open the third FieldSet, above "Check accessibility
// by default" and the Auto-Heal block — so the first thing under a heading-less
// divider was a developer utility, and the a11y default it sat next to actually
// belonged with the other per-test defaults. It has been moved there; this pane
// is what was genuinely left over.

import { Button, Switch } from "@glaze/core/components";

import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

export function AdvancedPane() {
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
