// Being told what happened: local notifications, and the scheduled AI report.
//
// This pane's claim used to be "deliberately ALL local, and each row says so"
// — three notifications and nothing else. AI insights changed that claim ON
// PURPOSE rather than around it: the report rows below can send a summary of
// recent activity to the configured AI provider on a schedule, with nobody
// reviewing the individual send, and a pane still titled "on this Mac" over
// that switch would be the inaccurate disclosure that is worse than none.
// What survives of the old claim is per-row: the three notification rows are
// still local and still say so, and the enable row's `risk` block states
// exactly what leaves and where it goes, provider-aware.
//
// The wording of the webhook row was corrected once (2026-08-06) after it said
// webhooks were "the only feature that sends anything off this Mac" — false,
// because Debug with AI on the Claude provider sends the script and the failing
// run's output to Anthropic. Both halves of that correction travelled with the
// row to `integrations-pane.tsx`; don't shorten them without re-reading
// DECISIONS.md.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Switch, toast } from "@ui";

import { Segmented } from "../../theme";
import { api } from "../../lib/api";
import type { InsightsCadence } from "../../lib/recorder-types";
import { INSIGHTS_CADENCES, INSIGHTS_CADENCE_LABELS } from "../../lib/recorder-types";
import { useSettingsController } from "../settings-controller";
import { SettingRow, useRowVisible } from "../setting-row";
import { PaneSection } from "../pane-section";

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** What the enable row must disclose, by provider. Local runtimes are
 *  loopback servers, so the summary stays on the Mac; Claude is hosted, and
 *  the sentence says so plainly. (Deliberately not the phrase the old
 *  no-outbound guard greps for — the guard now watches for credential and
 *  webhook controls, and this copy names the destination instead.) */
function riskFor(provider: string): string {
  const payload =
    "Each report sends a summary of recent activity — run and failure counts, test names, error signatures, site hosts — to the configured AI provider without a per-send review. Never run logs, console or network captures, script sources, or secret values.";
  if (provider === "anthropic") {
    return `${payload} With Claude selected, that summary goes to api.anthropic.com.`;
  }
  return `${payload} With a local provider selected, it goes to your own server on this machine.`;
}

export function AlertsPane() {
  const { settings, save, provider } = useSettingsController();
  const qc = useQueryClient();
  const enabled = settings.aiInsightsEnabled ?? false;
  const cadence: InsightsCadence = settings.aiInsightsCadence ?? "weekly";
  const cadenceVisible = useRowVisible("ai-insights-cadence");
  const notifyVisible = useRowVisible("notify-insights-ready");
  const generateVisible = useRowVisible("ai-insights-generate-now");

  // The scheduler's own readout — last report, last failure, in flight. The
  // settings window doesn't receive the `insights:changed` push (it goes to
  // the main window), so this polls briefly while a generation is running.
  const status = useQuery({
    queryKey: ["insights-status"],
    queryFn: () => api.insights.status(),
    enabled,
    refetchInterval: (query) => (query.state.data?.generating ? 1500 : false),
  });

  const generateNow = useMutation({
    mutationFn: () => api.insights.generateNow(),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["insights-status"] });
      if (!res.started && res.reason === "alreadyRunning") {
        toast.error("A report is already being written.");
      }
    },
    onError: (err: unknown) => toast.error(String(err)),
  });

  const generating = status.data?.generating ?? false;
  const lastGeneratedAt = status.data?.lastGeneratedAt ?? null;
  const lastError = status.data?.lastError ?? null;

  return (
    <>
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

      <PaneSection
        title="AI insights"
        description="A scheduled report on your suite: trends, risks, site changes, app release notes, and recommended fixes — written by the AI provider configured in the AI pane."
      >
        <SettingRow
          id="ai-insights-enabled"
          label="AI insights report"
          summary="Generate a report on a schedule, and after launch when one was missed. Reports live in the Insights view."
          risk={riskFor(provider)}
        >
          <Switch
            id="ai-insights-enabled"
            checked={enabled}
            onCheckedChange={(checked) => void save({ aiInsightsEnabled: checked })}
          />
        </SettingRow>

        {enabled && cadenceVisible ? (
          <SettingRow
            id="ai-insights-cadence"
            label="Report frequency"
            nested
            summary="How often a report generates. Reports only generate while the app is open; a period missed while it was closed is written shortly after the next launch."
          >
            <Segmented
              label="Report frequency"
              value={cadence}
              options={INSIGHTS_CADENCES.map((c) => ({
                value: c,
                label: INSIGHTS_CADENCE_LABELS[c],
              }))}
              onChange={(v) => void save({ aiInsightsCadence: v })}
            />
          </SettingRow>
        ) : null}

        {enabled && notifyVisible ? (
          <SettingRow
            id="notify-insights-ready"
            label="Notify when a report is ready"
            nested
            summary="Shows a macOS notification when a scheduled report finishes. The notification itself is local to this Mac."
          >
            <Switch
              id="notify-insights-ready"
              checked={settings.notifyOnInsightsReady ?? true}
              onCheckedChange={(checked) => void save({ notifyOnInsightsReady: checked })}
            />
          </SettingRow>
        ) : null}

        {enabled && generateVisible ? (
          <SettingRow
            id="ai-insights-generate-now"
            label="Generate a report now"
            nested
            summary={
              generating
                ? "Writing the report now…"
                : lastError
                  ? `Last attempt failed: ${lastError.message}`
                  : lastGeneratedAt
                    ? `Last report: ${fmtWhen(lastGeneratedAt)}.`
                    : "No report yet — the first one generates within a minute or two."
            }
          >
            <Button
              variant="secondary"
              disabled={generating || generateNow.isPending}
              onClick={() => void generateNow.mutate()}
            >
              {generating ? "Writing…" : "Generate now"}
            </Button>
          </SettingRow>
        ) : null}
      </PaneSection>
    </>
  );
}
