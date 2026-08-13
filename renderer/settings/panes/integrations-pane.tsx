// Services this app connects to, and what leaves this Mac.
//
// The pane exists to make one question answerable in one place: what does this
// app talk to? Before it, the answer was spread across three — the webhook was
// filed under Alerts beside three purely local notifications, and the GitHub
// token had no settings UI at all, reachable only from inside the branch
// switcher, where nobody auditing the app would think to look.
//
// The local notification rows deliberately did NOT move here with the webhook.
// They send nothing anywhere, and a pane whose subject is outbound connections
// is weaker for listing three things that aren't.
//
// Every credential field here is write-only in the same way: the value goes
// renderer→backend, is stored encrypted, and is never read back. Each input
// keeps its value in THIS component and clears on success, so a pasted key does
// not linger in shared state for the rest of the session — same reason the AI
// pane holds its own.
//
// "Saved" and "works" are rendered as separate claims for Linear, because they
// are separate facts: `hasKey` is local and cheap, `account` is the result of
// asking. A pane that collapsed them would either call a working key broken
// while offline, or keep saying Connected after the key was revoked.

import { useState } from "react";
import {
  AlertDialog,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Status,
  Switch,
} from "@ui";

import { useSettingsController } from "../settings-controller";
import { SettingRow, useRowVisible } from "../setting-row";
import { PaneSection } from "../pane-section";

/** Sentinel for "no default", since a Select cannot carry an empty value as a
 *  selectable option — an empty string reads as "nothing chosen" and the row
 *  would render its placeholder instead of the choice the user made. */
const NONE = "__none__";

export function IntegrationsPane() {
  const {
    settings,
    save,
    webhookStatus,
    webhookBusy,
    saveWebhookUrl,
    clearWebhookUrl,
    testWebhook,
    issuesStatus,
    issuesVocabulary,
    issuesBusy,
    issueContainers,
    issueSubContainers,
    issueDefaults,
    connectIssues,
    verifyIssues,
    disconnectIssues,
    setIssueDefaults,
    hasGithubToken,
    githubBusy,
    saveGithubToken,
    clearGithubToken,
  } = useSettingsController();

  const [keyInput, setKeyInput] = useState("");
  const [webhookInput, setWebhookInput] = useState("");
  const [githubInput, setGithubInput] = useState("");
  const [confirmEnableOpen, setConfirmEnableOpen] = useState(false);
  const urlRowVisible = useRowVisible("alert-webhook-url");
  const teamRowVisible = useRowVisible("linear-default-team");
  const projectRowVisible = useRowVisible("linear-default-project");

  // Falls back rather than rendering "undefined Team" during the first paint.
  //
  // `keyHelpUrl` is deliberately EMPTY here rather than a copy of the real one.
  // The URL has exactly one source of truth — the provider that knows it — and
  // a transcribed copy is right the day it is written and silently wrong
  // afterwards. It also keeps `check:renderer-egress` meaningful: an absolute
  // URL appearing in this tree should always be worth a second look, and a
  // decorative one in a fallback would train the next person to allowlist it.
  const vocab = issuesVocabulary ?? {
    name: "Linear",
    container: "Team",
    subContainer: "Project",
    keyHelpUrl: "",
    keyPlaceholder: "lin_api_…",
  };

  const connected = !!issuesStatus.account;

  const onConnect = async () => {
    const ok = await connectIssues(keyInput);
    // Only clear on success — wiping the field after a rejected key loses what
    // was pasted and gives nothing to correct.
    if (ok) setKeyInput("");
  };

  const onSaveWebhook = async () => {
    const ok = await saveWebhookUrl(webhookInput);
    if (ok) setWebhookInput("");
  };

  const onSaveGithub = async () => {
    const ok = await saveGithubToken(githubInput);
    if (ok) setGithubInput("");
  };

  // A project scoped to no container is offered under every team: the provider
  // reports null when it genuinely spans teams, and hiding it would make a
  // legitimate destination unreachable.
  const projectsForTeam = issueSubContainers.filter(
    (p) => p.containerId === null || p.containerId === issueDefaults.containerId,
  );

  return (
    <PaneSection>
      <SettingRow
        id="linear-connection"
        label={vocab.name}
        flag="leaves this Mac"
        stacked
        // No `details` here, deliberately. `SettingRow` drops the disclosure on
        // a flagged row — a credential warning must never be one click away —
        // so the "only when you click it" sentence lives in the summary, where
        // it is always on screen. It is the whole distinction between this row
        // and the webhook below: that one sends on its own, this one does not.
        summary={
          <>
            {connected
              ? `Connected as ${issuesStatus.account?.accountName}${
                  issuesStatus.account?.workspaceName
                    ? ` in ${issuesStatus.account.workspaceName}`
                    : ""
                }. The key is stored encrypted and never shown again; paste a new one to replace it.`
              : issuesStatus.hasKey
                ? (issuesStatus.error ??
                  "A key is saved but hasn't been verified yet. Test the connection to check it.")
                : `Paste a personal API key${
                    vocab.keyHelpUrl ? ` from ${vocab.keyHelpUrl}` : ""
                  }. It's treated as a secret: stored encrypted on this Mac and never read back into this window.`}{" "}
            Nothing goes to {vocab.name} on its own — sending a defect is{" "}
            <strong>always something you click</strong>, and you see the screenshots that go with
            it before they leave.
          </>
        }
      >
        <div className="flex w-full items-center gap-2">
          {issuesStatus.hasKey ? (
            <Status variant={connected ? "success" : "error"}>
              {connected ? "Connected" : "Not connected"}
            </Status>
          ) : null}
          <Input
            id="linear-connection"
            type="password"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={issuesStatus.hasKey ? "••••••••" : vocab.keyPlaceholder}
            disabled={issuesBusy}
            className="min-w-0 flex-1"
          />
          {/* Three credential rows share this pane, so every button carries an
              accessible name that says WHICH credential it acts on. Without it
              a screen reader announces "Save, Save, Save" and the visible text
              is the only thing that disambiguates them. */}
          <Button
            variant="secondary"
            aria-label={`Save ${vocab.name} API key`}
            onClick={() => void onConnect()}
            disabled={issuesBusy || keyInput.trim().length === 0}
          >
            {issuesBusy ? "Saving…" : "Save"}
          </Button>
          {issuesStatus.hasKey ? (
            <>
              <Button
                variant="secondary"
                aria-label={`Test the ${vocab.name} connection`}
                onClick={() => void verifyIssues()}
                disabled={issuesBusy}
              >
                Test connection
              </Button>
              <Button
                variant="secondary"
                aria-label={`Disconnect ${vocab.name}`}
                onClick={() => void disconnectIssues()}
                disabled={issuesBusy}
              >
                Disconnect
              </Button>
            </>
          ) : null}
        </div>
      </SettingRow>

      {connected && teamRowVisible ? (
        <SettingRow
          id="linear-default-team"
          label={`Default ${vocab.container.toLowerCase()}`}
          nested
          summary={`Where issues go unless you pick somewhere else when sending. ${issueContainers.length} ${
            issueContainers.length === 1
              ? vocab.container.toLowerCase()
              : `${vocab.container.toLowerCase()}s`
          } available.`}
        >
          <Select
            value={issueDefaults.containerId ?? NONE}
            onValueChange={(v) =>
              void setIssueDefaults({ containerId: v === NONE ? null : v })
            }
          >
            <SelectTrigger id="linear-default-team" className="w-64">
              <SelectValue placeholder={`Choose a ${vocab.container.toLowerCase()}…`} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Ask me each time</SelectItem>
              {issueContainers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.key ? `${c.key} — ${c.name}` : c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      ) : null}

      {connected && issueDefaults.containerId && projectRowVisible ? (
        <SettingRow
          id="linear-default-project"
          label={`Default ${vocab.subContainer.toLowerCase()}`}
          nested
          summary={`Optional. Clears itself when you change the ${vocab.container.toLowerCase()}, since a ${vocab.subContainer.toLowerCase()} belongs to one.`}
        >
          <Select
            value={issueDefaults.subContainerId ?? NONE}
            onValueChange={(v) =>
              void setIssueDefaults({ subContainerId: v === NONE ? null : v })
            }
          >
            <SelectTrigger id="linear-default-project" className="w-64">
              <SelectValue placeholder={`No ${vocab.subContainer.toLowerCase()}`} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No {vocab.subContainer.toLowerCase()}</SelectItem>
              {projectsForTeam.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      ) : null}

      <SettingRow
        id="alert-webhook-enabled"
        label="Send alerts to a webhook"
        flag="leaves this Mac"
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
              aria-label="Save webhook URL"
              onClick={() => void onSaveWebhook()}
              disabled={webhookBusy || webhookInput.trim().length === 0}
            >
              Save
            </Button>
            {webhookStatus.hasUrl ? (
              <>
                <Button
                  variant="secondary"
                  aria-label="Send a test alert to the webhook"
                  onClick={() => void testWebhook()}
                  disabled={webhookBusy}
                >
                  Send test
                </Button>
                <Button
                  variant="secondary"
                  aria-label="Remove webhook URL"
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

      <SettingRow
        id="github-token"
        label="GitHub token"
        stacked
        summary={
          hasGithubToken
            ? "Saved — stored encrypted on this Mac and never shown again. Paste a new one to replace it."
            : "Optional. Only used to list pull requests in the branch switcher. Without one, public repositories still work at GitHub's unauthenticated rate limit."
        }
        details="A token buys two things: private repositories, which answer 404 rather than 403 without one — so the failure reads as 'no such repository' rather than 'you aren't allowed' — and the authenticated rate limit, which matters because 60 requests an hour is shared with everything else on this machine's IP."
      >
        <div className="flex w-full items-center gap-2">
          <Input
            id="github-token"
            type="password"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={githubInput}
            onChange={(e) => setGithubInput(e.target.value)}
            placeholder={hasGithubToken ? "••••••••" : "ghp_…"}
            disabled={githubBusy}
            className="min-w-0 flex-1"
          />
          <Button
            variant="secondary"
            aria-label="Save GitHub token"
            onClick={() => void onSaveGithub()}
            disabled={githubBusy || githubInput.trim().length === 0}
          >
            Save
          </Button>
          {hasGithubToken ? (
            <Button
              variant="secondary"
              aria-label="Remove GitHub token"
              onClick={() => void clearGithubToken()}
              disabled={githubBusy}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </SettingRow>
    </PaneSection>
  );
}
