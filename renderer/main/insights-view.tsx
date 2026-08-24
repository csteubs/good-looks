// The Insights view (route /insights) — the scheduled AI reports, newest
// first, with the full report as the detail.
//
// Master/detail like Heals, and the same reasoning: a report's detail is wide
// (sections, a stats strip, recommendations, a disclosure) and a list row that
// tried to carry it would be unreadable at any width.
//
// Two trust rules shape the detail pane. The NUMBERS strip renders from
// `report.stats` — computed by the backend's facts builder — never from the
// model's prose, so a hallucinated figure cannot reach a number the user
// reads. And every action button's VERB is fixed per kind here; the model
// contributes only the reason sentence beside it, so its output can relabel
// nothing. An action whose test has since been deleted renders disabled with
// the name the report recorded — the report is history and history doesn't
// rewrite, but a button must never act on a guess.
//
// Sections render as plain paragraphs (split on blank lines) — model text is
// never interpreted as markup, the same rule the AI debug panel follows.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollArea, toast } from "@ui";
import { Bug, ChartColumn, CircleDot, ExternalLink, FileDown, Images, Newspaper, Play, Settings2, Trash2, Wand2 } from "lucide-react";

import { Btn, Panel } from "../theme";
import { api } from "../lib/api";
import { IssueComposeDialog } from "../components/issue-compose-dialog";
import type {
  InsightAction,
  InsightActionKind,
  InsightReport,
  InsightReportSummary,
  InsightStats,
  TestRecord,
} from "../lib/recorder-types";
import { INSIGHTS_CADENCE_LABELS } from "../lib/recorder-types";
import { useRecorder } from "./recorder-store";
import { requestAiDebugFor } from "./insight-intents";

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The fixed verb for each action kind. The model never writes button text. */
const ACTION_VERBS: Record<InsightActionKind, { verb: string; icon: React.ReactElement }> = {
  "run-test": { verb: "Run test", icon: <Play aria-hidden="true" /> },
  "debug-test": { verb: "Debug with AI", icon: <Bug aria-hidden="true" /> },
  "open-test": { verb: "Open test", icon: <ExternalLink aria-hidden="true" /> },
  "open-stats": { verb: "Open Stats", icon: <ChartColumn aria-hidden="true" /> },
  "open-heals": { verb: "Open Heals", icon: <Wand2 aria-hidden="true" /> },
  "open-visual": { verb: "Open Visual", icon: <Images aria-hidden="true" /> },
  "open-settings-integrations": { verb: "Open Settings", icon: <Settings2 aria-hidden="true" /> },
};

const TEST_SCOPED: ReadonlySet<InsightActionKind> = new Set([
  "run-test",
  "debug-test",
  "open-test",
]);

/** The stats strip's rows, in display order. Null values (metrics DB was
 *  unavailable at generation) are SKIPPED rather than shown as 0 — absence of
 *  evidence stays absent. */
function statRows(stats: InsightStats): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const push = (label: string, value: number | null, suffix = "") => {
    if (value === null) return;
    rows.push({ label, value: `${value}${suffix}` });
  };
  push("Runs", stats.runs);
  push("Failed", stats.failed);
  push("Previous period", stats.previousRuns);
  push("Possible flake", stats.flakyRuns);
  push("Healed steps", stats.healedSteps);
  push("Heal failures", stats.healFailures);
  push("Visual changes", stats.visualChanges);
  push("New failure signatures", stats.newClusters);
  push("New a11y violations", stats.a11yNewSteps);
  push("Tests created", stats.testsCreated);
  push("Unreviewed changes", stats.unreviewedScriptChanges);
  push("Signature warnings", stats.expiringSignatures);
  return rows;
}

function ReportRow({
  summary,
  selected,
  onSelect,
}: {
  summary: InsightReportSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "" : undefined}
      className="gl-insights-row"
    >
      <span className="gl-insights-row-icon">
        <Newspaper aria-hidden="true" />
        {/* The unread dot — presence is the signal, like the job ticker. */}
        {!summary.read ? <span className="gl-insights-unread" aria-label="Unread" /> : null}
      </span>
      <span className="gl-insights-row-main">
        <span className="gl-insights-row-title">{summary.headline}</span>
        <span className="gl-insights-row-sub">
          {INSIGHTS_CADENCE_LABELS[summary.cadence]} · {fmtWhen(summary.generatedAt)}
          {summary.degraded ? " · unformatted" : ""}
        </span>
      </span>
    </button>
  );
}

function ActionRow({
  action,
  liveTest,
  onAct,
}: {
  action: InsightAction;
  liveTest: TestRecord | undefined;
  onAct: () => void;
}) {
  const { verb, icon } = ACTION_VERBS[action.kind];
  const needsTest = TEST_SCOPED.has(action.kind);
  const dead = needsTest && !liveTest;
  return (
    <div className="gl-insights-action">
      <span className="gl-insights-action-label">
        {action.label}
        {needsTest ? (
          <span className="gl-insights-action-test">
            {liveTest?.name ?? action.testName ?? action.testId}
          </span>
        ) : null}
      </span>
      <Btn
        tone="ghost"
        disabled={dead}
        title={dead ? "This test no longer exists" : undefined}
        onClick={onAct}
      >
        {icon}
        {verb}
      </Btn>
    </div>
  );
}

function ReportDetail({
  report,
  testsById,
  onAction,
}: {
  report: InsightReport;
  testsById: Map<string, TestRecord>;
  onAction: (action: InsightAction) => void;
}) {
  const rows = statRows(report.stats);
  const sentChars = report.sending.reduce((n, s) => n + s.chars, 0);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="gl-insights-report">
        <h2 className="gl-insights-headline">{report.headline}</h2>

        {report.degraded ? (
          <p className="gl-insights-degraded">
            The model's answer didn't follow the report format, so it is shown as plain text and
            carries no action buttons.
          </p>
        ) : null}

        {rows.length > 0 ? (
          <dl className="gl-insights-stats">
            {rows.map((row) => (
              <div key={row.label} className="gl-insights-stat">
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {report.sections.map((section, i) => (
          <section key={i} className="gl-insights-section">
            {section.title ? <h3>{section.title}</h3> : null}
            {section.body
              .split(/\n{2,}/)
              .map((p) => p.trim())
              .filter(Boolean)
              .map((paragraph, j) => (
                <p key={j}>{paragraph}</p>
              ))}
          </section>
        ))}

        {report.actions.length > 0 ? (
          <section className="gl-insights-section">
            <h3>Recommended</h3>
            <div className="gl-insights-actions">
              {report.actions.map((action, i) => (
                <ActionRow
                  key={i}
                  action={action}
                  liveTest={action.testId ? testsById.get(action.testId) : undefined}
                  onAct={() => onAction(action)}
                />
              ))}
            </div>
          </section>
        ) : null}

        <footer className="gl-insights-meta">
          <p className="gl-note">
            {report.provider} · {report.model} · {Math.round(report.durationMs / 1000)}s ·{" "}
            {report.promptChars.toLocaleString()} characters sent,{" "}
            {report.answerChars.toLocaleString()} back
          </p>
          {/* What left the machine, category by category — stored with the
              report at generation, so it describes THIS send. */}
          <div className="gl-insights-sending">
            <p className="gl-note">Sent to the provider ({sentChars.toLocaleString()} characters):</p>
            <ul>
              {report.sending.map((item) => (
                <li key={item.label} className="gl-note">
                  {item.label} — {item.chars.toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        </footer>
      </div>
    </ScrollArea>
  );
}

export function InsightsView() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { run } = useRecorder();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const summaries = useQuery({
    queryKey: ["insight-reports"],
    queryFn: () => api.insights.list(),
  });
  const status = useQuery({
    queryKey: ["insights-status"],
    queryFn: () => api.insights.status(),
  });
  const settings = useQuery({
    queryKey: ["recorder-settings"],
    queryFn: () => api.recorder.getSettings(),
  });
  const tests = useQuery({ queryKey: ["tests"], queryFn: () => api.tests.list() });

  const list = summaries.data ?? [];
  const shownId = selectedId ?? list[0]?.id ?? null;
  const report = useQuery({
    queryKey: ["insight-report", shownId],
    queryFn: () => (shownId ? api.insights.get(shownId) : Promise.resolve(null)),
    enabled: shownId !== null,
  });

  // Opening a report is reading it. Backend-confirmed rather than optimistic:
  // the push comes back and clears the rail dot everywhere at once.
  const shown = report.data ?? null;
  React.useEffect(() => {
    if (shown && !shown.read) void api.insights.markRead(shown.id);
  }, [shown]);

  const generateNow = useMutation({
    mutationFn: () => api.insights.generateNow(),
    onSuccess: (res) => {
      if (res.started) return;
      toast.error(
        res.reason === "alreadyRunning"
          ? "A report is already being written."
          : "Turn on AI insights in Settings → Alerts first.",
      );
    },
    onError: (err: unknown) => toast.error(String(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.insights.delete(id),
    onSuccess: () => {
      setSelectedId(null);
      void qc.invalidateQueries({ queryKey: ["insight-reports"] });
    },
    onError: (err: unknown) => toast.error(String(err)),
  });

  const exportPdf = useMutation({
    mutationFn: (id: string) => api.insights.exportPdf(id),
    onSuccess: (res) => {
      // Null = the save dialog was cancelled — the user closed a dialog, and
      // telling them what they just did reads as the app not having noticed.
      if (res) toast.success(`Saved ${res.path}`);
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : String(err)),
  });

  // The report being filed as an issue. The dialog is the SAME one visual and
  // a11y defects file through — destination pickers, consent, dedup — with the
  // report as the body instead of evidence.
  const [filingReportId, setFilingReportId] = React.useState<string | null>(null);

  const testsById = React.useMemo(
    () => new Map((tests.data ?? []).map((t) => [t.id, t])),
    [tests.data],
  );

  const onAction = React.useCallback(
    (action: InsightAction) => {
      switch (action.kind) {
        case "run-test": {
          if (!action.testId || !testsById.has(action.testId)) return;
          run(action.testId, undefined, testsById.get(action.testId)?.runHeadless);
          void navigate({ to: "/test/$id", params: { id: action.testId } });
          return;
        }
        case "debug-test": {
          if (!action.testId || !testsById.has(action.testId)) return;
          // Recorded, then consumed by the detail view once its run context
          // exists — the SAME open path as the Output panel's button, Sending
          // strip and manual send included.
          requestAiDebugFor(action.testId);
          void navigate({ to: "/test/$id", params: { id: action.testId } });
          return;
        }
        case "open-test": {
          if (!action.testId || !testsById.has(action.testId)) return;
          void navigate({ to: "/test/$id", params: { id: action.testId } });
          return;
        }
        case "open-stats":
          void navigate({ to: "/stats" });
          return;
        case "open-heals":
          void navigate({ to: "/heals" });
          return;
        case "open-visual":
          void navigate({ to: "/visual" });
          return;
        case "open-settings-integrations":
          void navigate({ to: "/settings/$pane", params: { pane: "integrations" } });
          return;
      }
    },
    [navigate, run, testsById],
  );

  const enabled = settings.data?.aiInsightsEnabled ?? false;
  const generating = status.data?.generating ?? false;
  const lastError = status.data?.lastError ?? null;

  const emptyCopy = (() => {
    if (summaries.isLoading) return "Loading…";
    if (generating) return "Writing the report now — it appears here when it's done.";
    if (!enabled) {
      return "Reports are off. Turn on AI insights in Settings → Alerts and the app writes a periodic summary of your suite's trends, risks and recommended fixes with your configured AI provider.";
    }
    if (lastError) {
      return `The last attempt failed: ${lastError.message} It retries within the hour, or generate one now.`;
    }
    return "No reports yet. The first one generates within a couple of minutes, or generate one now.";
  })();

  return (
    <div className="gl-insights">
      <Panel
        title="Reports"
        id={
          generating
            ? "writing…"
            : list.length > 0
              ? `${list.length} report${list.length === 1 ? "" : "s"}`
              : undefined
        }
        right={
          enabled ? (
            <Btn tone="ghost" disabled={generating || generateNow.isPending} onClick={() => generateNow.mutate()}>
              Generate now
            </Btn>
          ) : (
            <Btn
              tone="ghost"
              onClick={() => void navigate({ to: "/settings/$pane", params: { pane: "alerts" } })}
            >
              Open Alerts settings
            </Btn>
          )
        }
        className="gl-insights-list"
      >
        {list.length === 0 ? (
          <p className="gl-insights-empty gl-note">{emptyCopy}</p>
        ) : (
          <>
            {lastError ? (
              <p className="gl-insights-error gl-note">
                Last attempt failed: {lastError.message}
              </p>
            ) : null}
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col">
                {list.map((summary) => (
                  <ReportRow
                    key={summary.id}
                    summary={summary}
                    selected={summary.id === shownId}
                    onSelect={() => setSelectedId(summary.id)}
                  />
                ))}
              </div>
            </ScrollArea>
          </>
        )}
      </Panel>

      <Panel
        title="Report"
        id={shown ? `${INSIGHTS_CADENCE_LABELS[shown.cadence]} · ${fmtWhen(shown.generatedAt)}` : undefined}
        right={
          shown ? (
            <>
              <Btn
                tone="ghost"
                disabled={exportPdf.isPending}
                title="Save this report as a PDF"
                onClick={() => exportPdf.mutate(shown.id)}
              >
                <FileDown aria-hidden="true" />
                PDF
              </Btn>
              <Btn
                tone="ghost"
                title="File this report as an issue in the configured tracker"
                onClick={() => setFilingReportId(shown.id)}
              >
                <CircleDot aria-hidden="true" />
                File issue
              </Btn>
              <Btn tone="ghost" disabled={remove.isPending} onClick={() => remove.mutate(shown.id)}>
                <Trash2 aria-hidden="true" />
                Delete
              </Btn>
            </>
          ) : undefined
        }
        className="gl-insights-detail"
      >
        {shown === null ? (
          <p className="gl-insights-empty gl-note">
            {list.length === 0 ? "The report appears here." : "Select a report to read it."}
          </p>
        ) : (
          <ReportDetail report={shown} testsById={testsById} onAction={onAction} />
        )}
      </Panel>

      <IssueComposeDialog
        source={filingReportId ? { kind: "insight-report", reportId: filingReportId } : null}
        open={filingReportId !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setFilingReportId(null);
        }}
      />
    </div>
  );
}
