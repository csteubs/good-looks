// Being told when a run goes wrong, on this Mac.
//
// Three local notifications, and nothing else. The webhook that used to live
// here moved to Integrations, which is the one pane that answers "what does
// this app talk to?" — and the answer is weaker for listing three things that
// talk to nothing.
//
// What is left is deliberately ALL local, and each row says so. That is the
// pane's whole claim now, and it is why the notification rows did not move with
// the webhook: they are the opposite of an integration.
//
// The wording of the webhook row was corrected once (2026-08-06) after it said
// webhooks were "the only feature that sends anything off this Mac" — false,
// because Debug with AI on the Claude provider sends the script and the failing
// run's output to Anthropic. Both halves of that correction travelled with the
// row to `integrations-pane.tsx`; don't shorten them without re-reading
// DECISIONS.md.

import { Switch } from "@ui";

import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

export function AlertsPane() {
  const { settings, save } = useSettingsController();

  return (
    <PaneSection>
      <SettingRow
        id="notify-run-issues"
        label="Notify when a run has problems"
        summary="Shows a macOS notification when a run fails or a step changes visually. Clean runs stay quiet."
        details="Nothing is sent anywhere — the notification is local to this Mac."
      >
        <Switch
          id="notify-run-issues"
          checked={settings.notifyOnRunIssues ?? false}
          onCheckedChange={(checked) => void save({ notifyOnRunIssues: checked })}
        />
      </SettingRow>

      <SettingRow
        id="notify-batch-done"
        label="Notify when a batch finishes"
        summary="Shows a macOS notification when a batch run ends, whether it passed or failed."
        details="A batch is a job you start and walk away from, so this reports success too. While it's on, tests inside a batch don't each post their own notification — you get one for the suite. Local to this Mac."
      >
        <Switch
          id="notify-batch-done"
          checked={settings.notifyOnBatchDone ?? true}
          onCheckedChange={(checked) => void save({ notifyOnBatchDone: checked })}
        />
      </SettingRow>

      <SettingRow
        id="notify-ai-debug-done"
        label="Notify when an AI debug job finishes"
        summary="Shows a macOS notification when a minimized AI debug job finishes or fails."
        details="Fires on success too — a minimized job is one you walked away from, and 'the answer is ready' is the message you were waiting for. Jobs you're watching in their open dialog stay quiet. Local to this Mac."
      >
        <Switch
          id="notify-ai-debug-done"
          checked={settings.notifyOnAiDebugDone ?? false}
          onCheckedChange={(checked) => void save({ notifyOnAiDebugDone: checked })}
        />
      </SettingRow>

    </PaneSection>
  );
}
