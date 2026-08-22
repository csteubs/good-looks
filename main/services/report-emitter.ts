// Running the emitters, and writing what they produce. REDESIGN §6.5 / §7.3.
//
// `shared/emitters.mjs` decides what the bytes ARE; this decides what goes in,
// redacts it, and puts it on disk. The split is the reason the emitters could be
// shared with the MCP at all — they are pure, and everything impure is here.
//
// THE RENDERER NEVER SEES THE EMITTED TEXT, and that is the load-bearing shape
// of this file rather than an implementation detail. Redaction runs through
// `redactWithSnapshot`, which reads an encrypted store and cannot leave the main
// process; if the panel asked for the text and saved it itself, the un-redacted
// payload would cross the IPC boundary first and the redaction would be a
// formality applied to a copy. So the panel asks for an EMIT — a verb — and gets
// back a path and a byte count. There is no channel here that returns content.

import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { dialog, logger } from "@shell/backend";

import {
  EMITTERS,
  emitFileName,
  githubAnnotations,
  junitXml,
  otlpTrace,
  stepMetricsCsv,
  stepMetricsNdjson,
  ticketMarkdown,
} from "../../shared/emitters.mjs";
import type { EmitRow, EmitRun, EmitterId } from "../../shared/emitters.mjs";
import type { RunRecord } from "../recorder/types.js";
import { stepDurations } from "../../shared/metrics-query.mjs";
import { metricsStore } from "./metrics-store.js";
import { runHistoryStore } from "./run-history-store.js";
import { redactWithSnapshot } from "./secret-redaction.js";
import { failureReasonStore } from "./failure-reason-store.js";
import { resolveFailureReason } from "../../shared/failure-reasons.mjs";

export interface EmitResult {
  /** Where it landed, or null when the user cancelled the save dialog. */
  path: string | null;
  bytes: number;
  /** How many runs (or rows) went in — so the panel can say "12 runs" rather
   *  than leaving the user to guess what the file covers. */
  count: number;
  cancelled: boolean;
}

/**
 * Which runs a report covers.
 *
 * WHY THIS EXISTS AT ALL: `build` used to read the whole retained run history
 * and filter only by `testId`, so a JUnit file emitted after a twelve-test
 * routine described every run the machine had ever kept — up to MAX_RECORDS of
 * them. The file was valid, the CI dashboard ingested it happily, and it showed
 * four thousand test cases including failures from three months earlier. That
 * is worse than no export: it looks like it worked.
 *
 * Every field is optional and they AND together. An empty scope is the whole
 * live history, which is what every existing caller passes and therefore what
 * they keep getting.
 */
export interface EmitScope {
  /** Only this test's runs. */
  testId?: string;
  /** Only the runs of one batch or routine run — `RunRecord.batchId`. */
  batchId?: string;
  /** Runs started at or after this epoch-ms instant. */
  since?: number;
  /** Runs started at or before this epoch-ms instant. */
  until?: number;
  /** Exactly these run ids, and nothing else. */
  runIds?: readonly string[];
}

/** Does this run fall inside the scope? Undefined fields do not constrain, so
 *  `{}` admits everything. */
function inScope(run: RunRecord, scope: EmitScope, runIds: ReadonlySet<string> | null): boolean {
  if (scope.testId !== undefined && run.testId !== scope.testId) return false;
  if (scope.batchId !== undefined && run.batchId !== scope.batchId) return false;
  if (runIds && !runIds.has(run.id)) return false;
  // `startedAt` is required on the record, but a hand-edited run-history.json is
  // reachable and a NaN comparison is false in both directions — which would
  // silently drop the row from a bounded window while keeping it in an
  // unbounded one. Treat an unusable timestamp as out of any bounded scope, and
  // let it through when no bound was asked for.
  const startedAt = typeof run.startedAt === "number" ? run.startedAt : NaN;
  if (scope.since !== undefined && !(startedAt >= scope.since)) return false;
  if (scope.until !== undefined && !(startedAt <= scope.until)) return false;
  return true;
}

/** What each emitter reads. Split because the two metrics emitters take DB rows
 *  and the other four take runs, and a single "gather everything" would query
 *  the metrics DB to write a JUnit file. */
const NEEDS_ROWS: ReadonlySet<string> = new Set(["ndjson", "csv"]);

/**
 * Emit one format and save it.
 *
 * `stamp` is passed in rather than read from the clock, so the caller owns the
 * filename it is about to show the user and a test can assert one.
 */
export async function emitReport(
  emitterId: EmitterId,
  stamp: string,
  scope: EmitScope = {},
): Promise<EmitResult> {
  const meta = EMITTERS.find((e) => e.id === emitterId);
  if (!meta) throw new Error(`unknown emitter: ${emitterId}`);

  // Built BEFORE the dialog opens, so `count` is available to report even when
  // the user cancels — the panel says "12 runs" on a cancel too, and a cancel
  // is an answer rather than a failure.
  const { text, count } = buildReport(emitterId, scope);

  const chosen = await dialog.showSaveDialog({
    defaultPath: emitFileName(emitterId, stamp),
    filters: [{ name: meta.label, extensions: [meta.extension] }],
  });
  if (chosen.canceled || !chosen.filePath) {
    return { path: null, bytes: 0, count, cancelled: true };
  }
  return writeEmitted(chosen.filePath, text, count);
}

/**
 * The same emit, to a path the caller already knows — no dialog, no window, no
 * person.
 *
 * THIS IS THE HALF THAT MAKES THE EMITTERS REACHABLE FROM A PIPELINE. Six
 * correct emitters have existed since 2026-08-12 and the only way to obtain a
 * file was `dialog.showSaveDialog`, which needs a running app, an open window
 * and somebody choosing a folder. None of those exist inside a container, so a
 * scheduled routine, a headless run and a CI job could all produce results and
 * none of them could produce a report. See R1 in
 * docs/plans/test-runner-improvements.md.
 *
 * MAIN-PROCESS ONLY, AND DELIBERATELY NOT AN IPC CHANNEL. The renderer must not
 * name the destination: `report:emit` is a verb precisely so the un-redacted
 * text never crosses the boundary, and a channel taking a path would let the
 * renderer choose where bytes land. The callers this exists for — the run-end
 * report, and the CLI when it arrives — all live on this side already.
 * `check:emit-redaction` pins both halves of that.
 */
export function emitReportTo(
  emitterId: EmitterId,
  absolutePath: string,
  scope: EmitScope = {},
): EmitResult {
  if (!EMITTERS.some((e) => e.id === emitterId)) {
    throw new Error(`unknown emitter: ${emitterId}`);
  }
  // Relative paths resolve against the process cwd, which under Electron is
  // wherever the app happened to be launched from. A caller that means "here"
  // can say so; one that forgot should not silently write into a directory
  // neither of us picked.
  if (!absolutePath || !isAbsolute(absolutePath)) {
    throw new Error(`report destination must be an absolute path: ${String(absolutePath)}`);
  }
  const { text, count } = buildReport(emitterId, scope);
  return writeEmitted(absolutePath, text, count);
}

/** Put the bytes on disk. Shared by both destinations so the failure behaviour
 *  cannot drift between "the user picked a folder" and "a setting named one". */
function writeEmitted(path: string, text: string, count: number): EmitResult {
  // A write that fails must not take the app down with it — a full disk or a
  // read-only folder is the user's environment, not a bug, and the panel says
  // so. Rethrown as a plain message because the raw error carries the path
  // twice and reads like a stack trace in a toast.
  try {
    writeFileSync(path, text, "utf8");
  } catch (err) {
    logger.warn("report", `could not write ${path}: ${String(err)}`);
    throw new Error(`Could not write that file: ${String(err)}`);
  }
  return { path, bytes: Buffer.byteLength(text, "utf8"), count, cancelled: false };
}

/**
 * Gather and emit, with redaction applied. Exported because both destinations
 * call it and a test can then assert what a scope selects without standing up a
 * save dialog.
 *
 * EVERY BRANCH PASSES `redactWithSnapshot`. There is no default here and no
 * shared options object one branch could forget to spread — a missed redactor
 * is a secret in a file the user is about to send somewhere, and it would look
 * exactly like a file that had been redacted. `check:emit-redaction` pins that
 * this file never reaches for `NO_REDACTION`.
 */
export function buildReport(
  emitterId: EmitterId,
  scope: EmitScope = {},
): { text: string; count: number } {
  if (NEEDS_ROWS.has(emitterId)) {
    // The scope goes to the QUERY rather than being applied to its output. The
    // rows come back aggregated per step (a median and a p95 over a window of
    // runs), so filtering them afterwards would drop whole steps while leaving
    // the surviving numbers computed over runs outside the scope — a p95 for
    // "this batch" that quietly averaged in last month.
    const rows = stepDurations(metricsStore.handle(), {
      testId: scope.testId,
      batchId: scope.batchId,
      since: scope.since,
      until: scope.until,
      runIds: scope.runIds,
    }) as unknown as EmitRow[];
    const text =
      emitterId === "csv"
        ? stepMetricsCsv(rows, { redact: redactWithSnapshot })
        : stepMetricsNdjson(rows, { redact: redactWithSnapshot });
    return { text, count: rows.length };
  }

  // `listLive` rather than `list`: a run whose test has been deleted carries a
  // tombstone with its name dropped, and a report row reading "undefined" is
  // worse than one fewer row. The store's own comment makes the distinction —
  // the aggregate counters want `list`, everything that NAMES a run wants this,
  // and a report is nothing but names.
  //
  // Filtered as RunRecords and cast afterwards, because `batchId` is on the
  // record and not on `EmitRun` — casting first would leave the scope reading a
  // field the type says is not there.
  const runIds = scope.runIds ? new Set(scope.runIds) : null;
  // The reason is stored as an ID and resolved at display time, so that a
  // renamed custom reason updates every historical run. A report is a display,
  // so it resolves too — and the emitters cannot do it themselves, being pure
  // and unable to reach the store. Read once for the whole report rather than
  // per run.
  const customReasons = failureReasonStore.list();
  const runs = runHistoryStore
    .listLive()
    .filter((r) => inScope(r, scope, runIds))
    .map((r) => {
      const reason = resolveFailureReason(r.failureReasonId, customReasons);
      return reason ? { ...r, failureReason: reason.name } : r;
    }) as unknown as EmitRun[];
  switch (emitterId) {
    case "junit":
      return { text: junitXml(runs, { redact: redactWithSnapshot }), count: runs.length };
    case "github":
      return { text: githubAnnotations(runs, { redact: redactWithSnapshot }), count: runs.length };
    case "ticket":
      return { text: ticketMarkdown(runs, { redact: redactWithSnapshot }), count: runs.length };
    case "otlp":
      return { text: otlpTrace(runs, { redact: redactWithSnapshot }), count: runs.length };
    default:
      throw new Error(`unhandled emitter: ${emitterId}`);
  }
}
