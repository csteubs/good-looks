// Reads a defect off disk and hands the pure builder plain data.
//
// The impure half of the split. Everything that decides what an issue SAYS
// lives in `payload.ts` and can be checked; everything that decides what is
// AVAILABLE to say lives here. Keeping them apart is what lets
// `check:issue-payload` construct hostile inputs by hand.
//
// Two rules this file owns, both of which fail silently if forgotten:
//
//   • The RAW RUN LOG never leaves this file. `readLog` is called for exactly
//     one purpose — to find the failure line — and what continues onward is the
//     line, reduced by `errorSignature`. The full text is never returned.
//   • Network entries are dropped whole when `RunLogs.headersFiltered` is
//     false. That flag means the run was captured with
//     `GLAZE_RECORD_ALL_HEADERS=1`, so its `network.json` holds real
//     Authorization and Cookie values — and that is exactly the run someone
//     debugging an authentication failure would have produced.

import { logger } from "@shell/backend";

import { artifactStore, type ReplayStep } from "../artifact-store.js";
import { baselineStore } from "../baseline-store.js";
import { firstErrorLine } from "../../../shared/error-signature.mjs";
import { keysOf, selectLatestA11yRuns } from "../../../shared/a11y-rollup.mjs";
import { runHistoryStore } from "../run-history-store.js";
import { testStore } from "../test-store.js";
import { insightReportStore } from "../insight-report-store.js";
import {
  insightReportIssueTitle,
  insightReportMarkdown,
} from "../insights/insight-report-markdown.js";
import type { DefectSource, DraftAttachment, IssueDraft } from "../../../renderer/lib/issue-types.js";
import type { UploadImage } from "./types.js";
import { buildIssueDraft, type BuildInput, type DraftContext, type FailureConsoleLine, type FailureRequest } from "./payload.js";

/** Console types that carry a diagnosis. Everything else is page chatter, and
 *  page chatter is arbitrary page-authored text going to a third party. */
const DIAGNOSTIC_CONSOLE = new Set(["error", "pageerror"]);

/** Kept in step with `payload.ts`'s own caps — this bounds what is read, that
 *  bounds what is rendered, and neither should depend on the other being right. */
const MAX_ENTRIES = 25;

function stepOf(testId: string, runId: string, stepId: string): ReplayStep | null {
  const replay = artifactStore.readReplay(testId, runId);
  if (!replay) return null;
  return replay.steps.find((s) => s.stepId === stepId) ?? null;
}

function contextFor(testId: string, runId: string, step: ReplayStep | null): DraftContext {
  const test = testStore.get(testId);
  const replay = artifactStore.readReplay(testId, runId);
  const run = runHistoryStore.list().find((r) => r.id === runId);
  return {
    testName: test?.name ?? replay?.testName ?? "Untitled test",
    // The TEST's start URL, never a page URL from the run: a run-time URL can
    // carry a session token in its query, and the start URL is what identifies
    // the test anyway.
    testUrl: test?.url ?? replay?.url ?? "",
    stepLabel: step?.label ?? null,
    browser: run?.runBrowser,
  };
}

/**
 * One image the dialog will show before the send.
 *
 * The preview is a data URL, the same way every other screenshot reaches this
 * renderer — there is no `app://` route for run artifacts and inventing one for
 * a thumbnail strip would be a second way to read the same files.
 *
 * It is a PREVIEW ONLY. The upload re-reads the file from disk by the same
 * coordinate, so what is sent cannot be substituted by anything the renderer
 * hands back; the round trip carries no image data in the sending direction.
 */
function attachmentFor(
  testId: string,
  runId: string,
  file: string | null | undefined,
  label: string,
): DraftAttachment | null {
  if (!file) return null;
  const buf = artifactStore.readShot(testId, runId, file);
  if (!buf?.byteLength) return null;
  return {
    label,
    file,
    previewUrl: `data:image/png;base64,${buf.toString("base64")}`,
    bytes: buf.byteLength,
  };
}

/** The pinned baseline, which lives in its own directory rather than the run's
 *  — `pruneRuns` never touches it, which is the whole point of pinning. */
function baselineAttachment(testId: string, stepId: string): DraftAttachment | null {
  const buf = baselineStore.readShot(testId, stepId);
  if (!buf?.byteLength) return null;
  return {
    label: "Baseline",
    file: `baseline:${stepId}`,
    previewUrl: `data:image/png;base64,${buf.toString("base64")}`,
    bytes: buf.byteLength,
  };
}

export const defectLoader = {
  /**
   * Assemble the draft for one defect.
   *
   * Returns null when the coordinate does not resolve — a pruned run, a step
   * that no longer exists, a rule id that is not on that step. Null rather than
   * a throw because every one of those is an ordinary consequence of retention
   * doing its job, not an error worth a stack trace.
   */
  build(source: DefectSource): IssueDraft | null {
    try {
      if (source.kind === "a11y") return buildA11y(source);
      if (source.kind === "visual") return buildVisual(source);
      if (source.kind === "insight-report") return buildInsightReport(source);
      return buildFailure(source);
    } catch (err) {
      logger.warn("issues", "Could not assemble an issue draft", {
        kind: source.kind,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },

  /**
   * Re-read the approved images at send time.
   *
   * Takes FILENAMES, not bytes. The renderer showed the user a preview and
   * hands back which ones they kept; the bytes are read here, from the same
   * coordinate the draft was built from. That means an image cannot be
   * substituted on the way back, and the sending direction of IPC never
   * carries image data at all.
   *
   * Anything not in the draft's own attachment set is ignored rather than
   * fetched: `file` is a filename that becomes a path, so it is treated as
   * untrusted input even though this app wrote it. `readShot` refuses a
   * traversing name, and this refuses a name the draft never offered — two
   * bounds, because either one alone is the kind that gets removed as
   * redundant.
   */
  readImages(source: DefectSource, files: readonly string[]): UploadImage[] {
    if (files.length === 0) return [];
    // A report draft offers no attachments, so any filename arriving here for
    // one is a name the draft never offered — refused wholesale.
    if (source.kind === "insight-report") return [];
    const offered = new Map(
      (defectLoader.build(source)?.attachments ?? []).map((a) => [a.file, a.label]),
    );
    const out: UploadImage[] = [];
    for (const file of files) {
      const label = offered.get(file);
      if (label === undefined) {
        logger.warn("issues", "Refused an image the draft never offered", { kind: source.kind });
        continue;
      }
      const bytes = file.startsWith("baseline:")
        ? baselineStore.readShot(source.testId, file.slice("baseline:".length))
        : artifactStore.readShot(source.testId, source.runId, file);
      if (!bytes?.byteLength) continue;
      out.push({
        label,
        // Named for a reader opening the issue, not for our directory layout.
        filename: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`,
        bytes,
        contentType: "image/png",
      });
    }
    return out;
  },
};

/**
 * An insights report, filed whole. Everything in the body comes from the
 * STORED report — content that was summary-shaped and secret-redacted at
 * generation — so unlike the defect builders there is no log to withhold and
 * no image to consent to. A missing id answers null like a pruned run does:
 * the report was deleted, and the dialog says the evidence is gone.
 */
function buildInsightReport(
  source: Extract<DefectSource, { kind: "insight-report" }>,
): IssueDraft | null {
  const report = insightReportStore.get(source.reportId);
  if (!report) return null;
  return {
    source,
    title: insightReportIssueTitle(report),
    body: insightReportMarkdown(report),
    attachments: [],
    notices: report.degraded
      ? ["The model's answer didn't follow the report format, so the body is unstructured text."]
      : [],
  };
}

/**
 * Every current occurrence of one rule, for a rule-scoped draft.
 *
 * The SAME selection the Accessibility view's board is drawn from
 * (`selectLatestA11yRuns`), and the same "only new" filter the rollup applies —
 * a site whose violations are all accepted is not something to file. Counts
 * only; node selectors from OTHER steps stay out of the body, which keeps a
 * rule-scoped issue's element list scoped to the frame its screenshot shows.
 */
function ruleOccurrences(ruleId: string): { testName: string; stepLabel: string | null; nodes: number }[] {
  const out: { testName: string; stepLabel: string | null; nodes: number }[] = [];
  for (const run of selectLatestA11yRuns(runHistoryStore.list())) {
    const replay = artifactStore.readReplay(run.testId, run.id);
    if (!replay) continue;
    for (const step of replay.steps) {
      if (!step.a11y) continue;
      const newKeys = new Set(step.a11y.newKeys);
      for (const v of step.a11y.violations) {
        if (v.id !== ruleId) continue;
        const hits = keysOf(v).filter((k) => newKeys.has(k)).length;
        if (hits === 0) continue;
        out.push({ testName: replay.testName, stepLabel: step.label ?? null, nodes: hits });
      }
    }
  }
  return out;
}

function buildA11y(source: Extract<DefectSource, { kind: "a11y" }>): IssueDraft | null {
  const step = stepOf(source.testId, source.runId, source.stepId);
  const violation = step?.a11y?.violations.find((v) => v.id === source.ruleId);
  if (!step || !violation) return null;

  const input: BuildInput = {
    source,
    context: contextFor(source.testId, source.runId, step),
    defect: {
      kind: "a11y",
      ruleId: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes ?? [],
      ...(source.scope === "rule" ? { occurrences: ruleOccurrences(source.ruleId) } : {}),
    },
  };
  const draft = buildIssueDraft(input);
  // The anchor step's screenshot, when one was captured: a rule-scoped issue
  // still benefits from one concrete picture, and the anchor is the site the
  // view chose to represent the rule.
  const shot =
    source.scope === "rule"
      ? attachmentFor(source.testId, source.runId, step.screenshot, "Example")
      : null;
  return shot ? { ...draft, attachments: [shot] } : draft;
}

function buildVisual(source: Extract<DefectSource, { kind: "visual" }>): IssueDraft | null {
  const step = stepOf(source.testId, source.runId, source.stepId);
  if (!step?.diff) return null;
  const replay = artifactStore.readReplay(source.testId, source.runId);

  const draft = buildIssueDraft({
    source,
    context: contextFor(source.testId, source.runId, step),
    defect: {
      kind: "visual",
      changedFraction: step.diff.ratio ?? 0,
      maskedCount: step.diff.maskedCount ?? 0,
      // Stored as a percent; the builder speaks in fractions.
      // The step's own threshold first: the replay-level one is what the run
      // used overall, while a step compared element-scoped may have used another.
      threshold:
        typeof step.diff.threshold === "number"
          ? step.diff.threshold / 100
          : typeof replay?.visualThreshold === "number"
            ? replay.visualThreshold / 100
            : null,
    },
  });

  // All three, in the order a reviewer needs them: what it should look like,
  // what it does, and what moved.
  const attachments = [
    baselineAttachment(source.testId, step.stepId),
    attachmentFor(source.testId, source.runId, step.screenshot, "This run"),
    attachmentFor(source.testId, source.runId, step.diff.diffFile, "Difference"),
  ].filter((a): a is DraftAttachment => a !== null);

  return { ...draft, attachments };
}

function buildFailure(source: Extract<DefectSource, { kind: "failure" }>): IssueDraft | null {
  const replay = artifactStore.readReplay(source.testId, source.runId);
  if (!replay) return null;

  // The failing step, when one is named or the replay knows which it was.
  const step =
    (source.stepId ? replay.steps.find((s) => s.stepId === source.stepId) : null) ??
    (replay.failedIndex !== null
      ? (replay.steps.find((s) => s.index === replay.failedIndex) ?? null)
      : null);

  // The ONLY use of the raw log, and only its failure line leaves this scope.
  let rawError = "";
  try {
    rawError = firstErrorLine(runHistoryStore.readLog(source.runId)) ?? "";
  } catch {
    /* a pruned log is not an error — the rest of the draft still stands */
  }

  const heal = step
    ? (artifactStore.readHealFailures(source.testId, source.runId).find((h) => h.stepId === step.stepId) ?? null)
    : null;

  const logs = artifactStore.readLogs(source.testId, source.runId);
  const headersFiltered = logs?.headersFiltered !== false;
  const action = step?.actionIndex;

  const consoleLines: FailureConsoleLine[] =
    logs && action !== undefined
      ? logs.console
          .filter((c) => c.step === action && DIAGNOSTIC_CONSOLE.has(c.type))
          .slice(0, MAX_ENTRIES)
          .map((c) => ({ type: c.type, text: c.text }))
      : [];

  // Dropped WHOLE when headers were not filtered. Not narrowed, not stripped —
  // the entries are not read at all, so there is nothing to forget to remove.
  const network: FailureRequest[] =
    logs && headersFiltered && action !== undefined
      ? logs.network
          .filter((n) => n.step === action && (!n.ok || n.status === 0 || n.status >= 400))
          .slice(0, MAX_ENTRIES)
          .map((n) => ({ method: n.method, url: n.url, status: n.status }))
      : [];

  const draft = buildIssueDraft({
    source,
    context: contextFor(source.testId, source.runId, step ?? null),
    defect: {
      kind: "failure",
      rawError,
      healOutcome: heal?.outcome ?? null,
      healLocator: heal?.originalLocator ? JSON.stringify(heal.originalLocator).slice(0, 200) : null,
      console: consoleLines,
      network,
      headersFiltered,
    },
  });

  // The screenshot at the moment of failure, when there is one. It is the
  // substitute for the log this deliberately does not send.
  const shot = step ? attachmentFor(source.testId, source.runId, step.screenshot, "At failure") : null;
  return { ...draft, attachments: shot ? [shot] : [] };
}
