// Being told when a run goes wrong.
//
// Two rows and a credential. The webhook URL keeps its full explanation in
// `summary` rather than behind a disclosure, for the same reason
// `record-all-headers` does: it is the only thing in this app that sends data
// off the Mac automatically, and a claim like that behind a "More" link is a
// claim most people never read.
//
// Turning the webhook ON confirms first; turning it OFF does not. The reasons
// are on the switch itself.
//
// The URL row is `stacked` rather than horizontal: its control is a field plus
// three buttons, and in a right-hand column that cluster squeezed the label
// column until "Webhook URL" broke in two and its summary rendered one word
// per line.
//
// The wording was corrected once already (2026-08-06) after saying webhooks
// were "the only feature that sends anything off this Mac" — which is false,
// because Debug with AI on the Claude provider sends the script and the failing
// run's output to Anthropic. Both halves of that correction are preserved
// verbatim below; don't shorten them without re-reading DECISIONS.md.

import { useState } from "react";
import { AlertDialog, Button, Input, Switch } from "@glaze/core/components";

import { useSettingsController } from "../settings-controller";
import { SettingRow, useRowVisible } from "../setting-row";
import { PaneSection } from "../pane-section";

export function AlertsPane() {
  const { settings, save, webhookStatus, webhookBusy, saveWebhookUrl, clearWebhookUrl, testWebhook } =
    useSettingsController();
  const [webhookInput, setWebhookInput] = useState("");
  const [confirmEnableOpen, setConfirmEnableOpen] = useState(false);
  const urlRowVisible = useRowVisible("alert-webhook-url");

  const onSave = async () => {
    const ok = await saveWebhookUrl(webhookInput);
    // Only clear on success — wiping the field after a rejected URL loses what
    // the user pasted and gives them nothing to correct.
    if (ok) setWebhookInput("");
  };

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
        details="A batch is a job you start and walk away from, so this reports success too. While it's on, tests inside a batch don't each post their own notification — you get one for the suite."
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

      <SettingRow
        id="alert-webhook-enabled"
        label="Send alerts to a webhook"
        danger="leaves this Mac"
        summary={
          <>
            POSTs a short summary to a URL you choose when a run fails, a step changes visually, or a
            batch finishes with failures. Works with Slack and Discord incoming webhooks. This is the
            only thing that sends data off this Mac <strong>automatically</strong> — and it sends a{" "}
            <strong>summary only</strong>: test name, status, the failing step&apos;s label, counts
            and timing. Run logs are never included, since they can contain page content and values
            typed during recording. (Separately, if you pick Claude as the AI provider, &ldquo;Debug
            with AI&rdquo; sends the test script and the failing run&apos;s output to Anthropic — but
            only when you click it.)
          </>
        }
      >
        <Switch
          id="alert-webhook-enabled"
          checked={settings.alertWebhookEnabled ?? false}
          // ON asks first; OFF does not. Turning this on starts sending data
          // off the Mac on a schedule the user no longer controls — every
          // failing run from here on — so it gets the one confirmation in this
          // window. Turning it off only stops that, and a confirmation on the
          // way out would train people to click through the one on the way in.
          // The switch stays driven by the saved setting, so it does not flip
          // until the save lands.
          onCheckedChange={(checked) => {
            if (checked) setConfirmEnableOpen(true);
            else void save({ alertWebhookEnabled: false });
          }}
          disabled={!webhookStatus.hasUrl}
        />
        <AlertDialog
          open={confirmEnableOpen}
          onOpenChange={setConfirmEnableOpen}
          size="medium"
          title="Start sending alerts off this Mac?"
          description={`Alerts will POST to ${
            webhookStatus.host ?? "the configured host"
          } automatically whenever a run fails, a step changes visually, or a batch finishes with failures — you won't be asked again each time. Each POST is a summary only: test name, status, the failing step's label, counts and timing. Run logs are never included.`}
          confirmLabel="Send alerts"
          confirmVariant="accent"
          // Returned, not fired-and-forgotten: the footer awaits it and leaves
          // the dialog open if the save throws, rather than closing over a
          // switch that never moved.
          onConfirm={() => save({ alertWebhookEnabled: true })}
        />
      </SettingRow>

      {urlRowVisible ? (
        <SettingRow
          id="alert-webhook-url"
          label="Webhook URL"
          nested
          stacked
          summary={
            webhookStatus.hasUrl
              ? `Saved — alerts go to ${webhookStatus.host ?? "the configured host"}. The URL is stored encrypted and never shown again; paste a new one to replace it.`
              : "Paste an incoming-webhook URL (https://). It's treated as a secret: stored encrypted on this Mac and never read back into this window."
          }
        >
          <div className="flex w-full items-center gap-2">
            <Input
              id="alert-webhook-url"
              type="password"
              value={webhookInput}
              onChange={(e) => setWebhookInput(e.target.value)}
              placeholder="https://hooks.slack.com/services/…"
              disabled={webhookBusy}
              className="min-w-0 flex-1"
            />
            <Button
              variant="secondary"
              onClick={() => void onSave()}
              disabled={webhookBusy || webhookInput.trim().length === 0}
            >
              Save
            </Button>
            {webhookStatus.hasUrl ? (
              <>
                <Button variant="secondary" onClick={() => void testWebhook()} disabled={webhookBusy}>
                  Send test
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void clearWebhookUrl()}
                  disabled={webhookBusy}
                >
                  Remove
                </Button>
              </>
            ) : null}
          </div>
        </SettingRow>
      ) : null}
    </PaneSection>
  );
}
