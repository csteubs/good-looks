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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  toast,
} from "@ui";

import { api } from "../../lib/api";

import type { ShopifySignatureStatus } from "../../lib/recorder-types";
import { useSettingsController } from "../settings-controller";
import { SettingRow, useRowVisible } from "../setting-row";
import { PaneSection } from "../pane-section";

/** Sentinel for "no default", since a Select cannot carry an empty value as a
 *  selectable option — an empty string reads as "nothing chosen" and the row
 *  would render its placeholder instead of the choice the user made. */
const NONE = "__none__";

/** What one registered signature's state reads as, and how loudly.
 *
 *  Five renderings for five facts, and the two that look like errors are the
 *  point of the row existing: an expired or unreadable signature is why a crawl
 *  that used to work has started being throttled, and nothing else in the app
 *  is in a position to say so.
 *
 *  `expiresAt` is unix SECONDS — as the header carries it — against a
 *  millisecond clock. */
export function signatureStatusLabel(
  entry: ShopifySignatureStatus,
  nowMs: number,
): { variant: "success" | "warning" | "error" | "neutral"; text: string } {
  if (entry.state === "unreadable") {
    return { variant: "error", text: "Registered but unreadable on this Mac" };
  }
  if (entry.state === "unknown" || entry.expiresAt === null) {
    return { variant: "neutral", text: "Expiry unknown" };
  }
  const expiresMs = entry.expiresAt * 1000;
  if (entry.state === "expired") {
    return {
      variant: "error",
      text: `Expired on ${new Date(expiresMs).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })}`,
    };
  }
  // Rounded UP, so a signature with eight hours left reads "1 day" rather than
  // "0 days" — which reads as expired, at the exact moment the distinction
  // matters most.
  const days = Math.ceil((expiresMs - nowMs) / (24 * 60 * 60 * 1000));
  const rest = `expires in ${days} ${days === 1 ? "day" : "days"}`;
  return entry.state === "expiring"
    ? { variant: "warning", text: rest.charAt(0).toUpperCase() + rest.slice(1) }
    : { variant: "success", text: `Valid — ${rest}` };
}

export function IntegrationsPane() {
  const {
    settings,
    save,
    signatures,
    signaturesBusy,
    addSignature,
    removeSignature,
    mailbox,
    mailboxBusy,
    saveMailbox,
    clearMailbox,
    testMailbox,
    webhookStatus,
    webhookBusy,
    saveWebhookUrl,
    clearWebhookUrl,
    testWebhook,
    issuesStatus,
    issuesVocabulary,
    issueProviders,
    issuesBusy,
    issueContainers,
    issueSubContainers,
    issueDefaults,
    selectIssueProvider,
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
  // Held HERE rather than in shared state, like every other credential field on
  // this pane: a pasted signature should not linger for the rest of the session.
  const [sigHost, setSigHost] = useState("");
  const [sigInput, setSigInput] = useState("");
  const [sigValue, setSigValue] = useState("");
  // Held HERE, like every other credential field on this pane: a pasted token
  // should not linger for the rest of the session.
  const [mailboxUrlInput, setMailboxUrlInput] = useState("");
  const [mailboxTokenInput, setMailboxTokenInput] = useState("");
  const [confirmEnableOpen, setConfirmEnableOpen] = useState(false);
  const onSaveSignature = async (): Promise<void> => {
    const ok = await addSignature({
      host: sigHost,
      signatureInput: sigInput,
      signature: sigValue,
    });
    // Cleared only on success. A signature is a long paste out of another
    // window, and losing it to a typo'd domain would mean going back for it.
    if (ok) {
      setSigHost("");
      setSigInput("");
      setSigValue("");
    }
  };

  const onSaveMailbox = async (): Promise<void> => {
    const ok = await saveMailbox({
      endpoint: mailboxUrlInput.trim(),
      token: mailboxTokenInput,
    });
    // Cleared only on success, for the signature row's reason: a token is a
    // long paste out of another window, and losing it to a typo'd URL would
    // mean going back for it.
    if (ok) {
      setMailboxUrlInput("");
      setMailboxTokenInput("");
    }
  };

  const urlRowVisible = useRowVisible("alert-webhook-url");
  const slackUrlRowVisible = useRowVisible("insights-slack-url");
  const teamRowVisible = useRowVisible("linear-default-team");
  const projectRowVisible = useRowVisible("linear-default-project");

  // The insights Slack destination. Its own credential and its own read, not
  // the controller's webhook state — see insights-slack-url-store.ts for why
  // the two destinations are deliberately separate.
  const qc = useQueryClient();
  const [slackInput, setSlackInput] = useState("");
  const [confirmSlackOpen, setConfirmSlackOpen] = useState(false);
  const slackStatusQuery = useQuery({
    queryKey: ["insights-slack-status"],
    queryFn: () => api.insightsSlack.status(),
  });
  const slackStatus = slackStatusQuery.data ?? { hasUrl: false, host: null };
  const saveSlack = useMutation({
    mutationFn: (url: string) => api.insightsSlack.setUrl(url),
    onSuccess: (status) => {
      qc.setQueryData(["insights-slack-status"], status);
      setSlackInput("");
      toast.success(`Saved — reports will go to ${status.host ?? "that host"}.`);
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const clearSlack = useMutation({
    mutationFn: () => api.insightsSlack.clearUrl(),
    onSuccess: (status) => {
      qc.setQueryData(["insights-slack-status"], status);
      // The URL is what the toggle is gated on; clearing it leaves the
      // setting behind as a dead switch, so it goes too.
      void save({ insightsSlackEnabled: false });
      toast.success("Removed the insights Slack URL.");
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const testSlack = useMutation({
    mutationFn: () => api.insightsSlack.test(),
    onSuccess: () => toast.success("Test message sent."),
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const slackBusy = saveSlack.isPending || clearSlack.isPending || testSlack.isPending;
  const onSaveSlack = async () => saveSlack.mutateAsync(slackInput).catch(() => {});
  const onClearSlack = async () => clearSlack.mutateAsync().catch(() => {});
  const onTestSlack = async () => testSlack.mutateAsync().catch(() => {});

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
    containerPlural: "Teams",
    subContainer: "Project",
    keyHelpUrl: "",
    keyPlaceholder: "lin_api_…",
    supportsImageUpload: true,
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

  // Always at least the current provider, so the row renders a real choice
  // rather than an empty menu during the first paint.
  const providerOptions = issueProviders.length
    ? issueProviders
    : [{ id: issuesStatus.provider, vocabulary: vocab, hasKey: issuesStatus.hasKey }];

  return (
    <PaneSection>
      {/* The tracker is chosen HERE and nowhere else. The compose dialog
          deliberately has no picker: filing a defect is a moment when someone
          is looking at a failure and wants it recorded, and a destination
          question at that moment is one more thing to get wrong on the way. It
          is a configuration decision, made once, in the window whose whole
          subject is what this app connects to. */}
      <SettingRow
        id="issue-tracker-provider"
        label="Issue tracker"
        summary={`Where “Send to…” files defects from a run, a visual difference or an accessibility violation. Each tracker keeps its own key, its own default destination and its own record of what has already been filed, so switching is reversible and switching back finds everything where you left it.${
          vocab.supportsImageUpload
            ? ""
            : ` ${vocab.name} cannot accept image attachments through its API, so screenshots stay on this Mac and the issue says so.`
        }`}
      >
        <Select
          value={issuesStatus.provider}
          onValueChange={(v) => void selectIssueProvider(v as typeof issuesStatus.provider)}
          disabled={issuesBusy}
        >
          <SelectTrigger id="issue-tracker-provider" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providerOptions.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.hasKey ? `${p.vocabulary.name} — key saved` : p.vocabulary.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

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
          // The plural comes from the provider rather than from appending an
          // "s" here. That worked for exactly as long as "Team" was the only
          // word this could hold, and said "3 repositorys" the first time it
          // was not.
          summary={`Where issues go unless you pick somewhere else when sending. ${issueContainers.length} ${(issueContainers.length === 1
            ? vocab.container
            : vocab.containerPlural
          ).toLowerCase()} available.`}
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
            batch finishes with failures. Works with Slack and Discord incoming webhooks. It sends a{" "}
            <strong>summary only</strong>: test name, status, the failing step&apos;s label, counts
            and timing. Run logs are never included, since they can contain page content and values
            typed during recording. The other automatic sends are opt-in like this one: AI insights
            (Settings → Alerts) sends its summary to your AI provider on a schedule, and the row
            below can post each report&apos;s headline to Slack. (Separately, if you pick Claude as
            the AI provider, &ldquo;Debug with AI&rdquo; sends the test script and the failing
            run&apos;s output to Anthropic — but only when you click it.)
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
        id="insights-slack-enabled"
        label="Post insights reports to Slack"
        flag="leaves this Mac"
        summary={
          <>
            POSTs a short summary — the report&apos;s headline and its counts, never the full text —
            to a Slack incoming webhook whenever a new AI insights report is generated (Settings →
            Alerts). Its own destination, separate from the alert webhook above: an incoming webhook
            is bound to one channel on Slack&apos;s side, so pasting a channel&apos;s webhook URL is
            how you pick the channel.
          </>
        }
      >
        <Switch
          id="insights-slack-enabled"
          checked={settings.insightsSlackEnabled ?? false}
          // Same shape as the alert webhook above: ON asks first, because it
          // starts unattended sends off the Mac; OFF just stops them.
          onCheckedChange={(checked) => {
            if (checked) setConfirmSlackOpen(true);
            else void save({ insightsSlackEnabled: false });
          }}
          disabled={!slackStatus.hasUrl}
        />
        <AlertDialog
          open={confirmSlackOpen}
          onOpenChange={setConfirmSlackOpen}
          size="medium"
          title="Start posting reports to Slack?"
          description={`Each new insights report will POST its headline and counts to ${
            slackStatus.host ?? "the configured host"
          } automatically — you won't be asked per report. The report's full text is never sent; it stays in the app.`}
          confirmLabel="Post reports"
          confirmVariant="accent"
          onConfirm={() => save({ insightsSlackEnabled: true })}
        />
      </SettingRow>

      {slackUrlRowVisible ? (
        <SettingRow
          id="insights-slack-url"
          label="Insights Slack webhook URL"
          nested
          stacked
          summary={
            slackStatus.hasUrl
              ? `Saved — reports go to ${slackStatus.host ?? "the configured host"}. The URL is stored encrypted and never shown again; paste a new one to replace it.`
              : "Paste the incoming-webhook URL for the channel that should receive reports (https://). It's treated as a secret: stored encrypted on this Mac and never read back into this window."
          }
        >
          <div className="flex w-full items-center gap-2">
            <Input
              id="insights-slack-url"
              type="password"
              value={slackInput}
              onChange={(e) => setSlackInput(e.target.value)}
              placeholder="https://hooks.slack.com/services/…"
              disabled={slackBusy}
              className="min-w-0 flex-1"
            />
            <Button
              variant="secondary"
              aria-label="Save insights Slack URL"
              onClick={() => void onSaveSlack()}
              disabled={slackBusy || slackInput.trim().length === 0}
            >
              Save
            </Button>
            {slackStatus.hasUrl ? (
              <>
                <Button
                  variant="secondary"
                  aria-label="Send a test message to the insights channel"
                  onClick={() => void onTestSlack()}
                  disabled={slackBusy}
                >
                  Send test
                </Button>
                <Button
                  variant="secondary"
                  aria-label="Remove insights Slack URL"
                  onClick={() => void onClearSlack()}
                  disabled={slackBusy}
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
        label="GitHub token (branch switcher)"
        stacked
        summary={
          hasGithubToken
            ? "Saved — stored encrypted on this Mac and never shown again. Paste a new one to replace it."
            : "Optional. Only used to list pull requests in the branch switcher. Without one, public repositories still work at GitHub's unauthenticated rate limit."
        }
        details="Separate from the token above, deliberately, even when it is the same token. Disconnecting an issue tracker clears its key — and pointing that at this one would silently stop the branch switcher listing pull requests, in another window, with nothing on screen connecting the two. The scopes also differ: listing pull requests is read-only and works unauthenticated on a public repository, while filing an issue needs write access. A token buys two things here: private repositories, which answer 404 rather than 403 without one — so the failure reads as 'no such repository' rather than 'you aren't allowed' — and the authenticated rate limit, which matters because 60 requests an hour is shared with everything else on this machine's IP."
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

      <SettingRow
        id="shopify-signatures"
        label="Shopify crawler signatures"
        flag="leaves this Mac"
        stacked
        summary={
          <>
            Lets the training browser and test runs reach a Shopify store that would otherwise
            throttle or block automated traffic. Create a signature in your Shopify admin, then
            paste its three values here. Each one is <strong>bound to a single domain</strong> — a
            store answering on both <code>example.com</code> and <code>www.example.com</code> needs
            two — and expires within three months, after which Shopify cannot renew it. The values
            are stored encrypted on this Mac, are sent only to the domain they name, and are kept
            out of recorded request headers even when “record all headers” is on.
          </>
        }
      >
        <div className="flex w-full flex-col gap-3">
          {signatures.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {signatures.map((entry) => {
                const label = signatureStatusLabel(entry, Date.now());
                return (
                  <li key={entry.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{entry.host}</span>
                    <Status variant={label.variant}>{label.text}</Status>
                    <Button
                      variant="secondary"
                      aria-label={`Remove the signature for ${entry.host}`}
                      onClick={() => void removeSignature(entry.id)}
                      disabled={signaturesBusy}
                    >
                      Remove
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <div className="flex w-full flex-col gap-2">
            <Input
              id="shopify-signatures"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={sigHost}
              onChange={(e) => setSigHost(e.target.value)}
              placeholder="shop.example.com"
              aria-label="Store domain"
              disabled={signaturesBusy}
              className="min-w-0"
            />
            <Input
              type="password"
              spellCheck={false}
              value={sigInput}
              onChange={(e) => setSigInput(e.target.value)}
              placeholder="Signature-Input"
              aria-label="Signature-Input"
              disabled={signaturesBusy}
              className="min-w-0"
            />
            <Input
              type="password"
              spellCheck={false}
              value={sigValue}
              onChange={(e) => setSigValue(e.target.value)}
              placeholder="Signature"
              aria-label="Signature"
              disabled={signaturesBusy}
              className="min-w-0"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                aria-label="Save Shopify signature"
                onClick={() => void onSaveSignature()}
                disabled={
                  signaturesBusy ||
                  sigHost.trim().length === 0 ||
                  sigInput.trim().length === 0 ||
                  sigValue.trim().length === 0
                }
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </SettingRow>

      <SettingRow
        id="test-mailbox"
        label="Test mailbox"
        flag="leaves this Mac"
        stacked
        summary={
          <>
            Lets a test read a one-time sign-in code out of email — the only way into a Shopify
            store on the current customer accounts, which have no password at all. Point this at
            the catch-all mailbox Worker in <code>workers/mailbox</code>: the URL ends in{" "}
            <code>/messages</code>, and the token is the one you set on the Worker. The token is
            stored encrypted on this Mac and kept out of run output; the URL is not a credential
            and is shown so a run can say which host it polled.{" "}
            <strong>Sign in once per suite, not once per test</strong> — put the sign-in in one
            test with session saving on and start the others from it, because a store locks a
            customer out for thirty minutes after five rejected codes.
          </>
        }
      >
        <div className="flex w-full flex-col gap-3">
          {mailbox.state !== "none" ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">{mailbox.host}</span>
              <Status variant={mailbox.state === "configured" ? "success" : "warning"}>
                {mailbox.state === "configured" ? "Ready" : "Token unreadable"}
              </Status>
              <Button
                variant="secondary"
                aria-label="Test the mailbox"
                onClick={() => void testMailbox()}
                disabled={mailboxBusy}
              >
                Test
              </Button>
              <Button
                variant="secondary"
                aria-label="Remove the test mailbox"
                onClick={() => void clearMailbox()}
                disabled={mailboxBusy}
              >
                Remove
              </Button>
            </div>
          ) : null}

          <div className="flex w-full flex-col gap-2">
            <Input
              id="test-mailbox"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={mailboxUrlInput}
              onChange={(e) => setMailboxUrlInput(e.target.value)}
              placeholder="https://good-looks-mailbox.example.workers.dev/messages"
              aria-label="Mailbox endpoint URL"
              disabled={mailboxBusy}
              className="min-w-0"
            />
            <Input
              type="password"
              spellCheck={false}
              value={mailboxTokenInput}
              onChange={(e) => setMailboxTokenInput(e.target.value)}
              placeholder="Mailbox token"
              aria-label="Mailbox token"
              disabled={mailboxBusy}
              className="min-w-0"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                aria-label="Save test mailbox"
                onClick={() => void onSaveMailbox()}
                disabled={
                  mailboxBusy ||
                  mailboxUrlInput.trim().length === 0 ||
                  mailboxTokenInput.length === 0
                }
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </SettingRow>
    </PaneSection>
  );
}
