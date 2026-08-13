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
import { stepDurations } from "../../shared/metrics-query.mjs";
import { metricsStore } from "./metrics-store.js";
import { runHistoryStore } from "./run-history-store.js";
import { redactWithSnapshot } from "./secret-redaction.js";

export interface EmitResult {
  /** Where it landed, or null when the user cancelled the save dialog. */
  path: string | null;
  bytes: number;
  /** How many runs (or rows) went in — so the panel can say "12 runs" rather
   *  than leaving the user to guess what the file covers. */
  count: number;
  cancelled: boolean;
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
  opts: { testId?: string } = {},
): Promise<EmitResult> {
  const meta = EMITTERS.find((e) => e.id === emitterId);
  if (!meta) throw new Error(`unknown emitter: ${emitterId}`);

  const { text, count } = build(emitterId, opts);

  const chosen = await dialog.showSaveDialog({
    defaultPath: emitFileName(emitterId, stamp),
    filters: [{ name: meta.label, extensions: [meta.extension] }],
  });
  if (chosen.canceled || !chosen.filePath) {
    return { path: null, bytes: 0, count, cancelled: true };
  }

  // A write that fails must not take the app down with it — a full disk or a
  // read-only folder is the user's environment, not a bug, and the panel says
  // so. Rethrown as a plain message because the raw error carries the path
  // twice and reads like a stack trace in a toast.
  try {
    writeFileSync(chosen.filePath, text, "utf8");
  } catch (err) {
    logger.warn("report", `could not write ${chosen.filePath}: ${String(err)}`);
    throw new Error(`Could not write that file: ${String(err)}`);
  }
  return {
    path: chosen.filePath,
    bytes: Buffer.byteLength(text, "utf8"),
    count,
    cancelled: false,
  };
}

/**
 * Gather and emit, with redaction applied.
 *
 * EVERY BRANCH PASSES `redactWithSnapshot`. There is no default here and no
 * shared options object one branch could forget to spread — a missed redactor
 * is a secret in a file the user is about to send somewhere, and it would look
 * exactly like a file that had been redacted. `check:emit-redaction` pins that
 * this file never reaches for `NO_REDACTION`.
 */
function build(emitterId: EmitterId, opts: { testId?: string }): { text: string; count: number } {
  if (NEEDS_ROWS.has(emitterId)) {
    const rows = stepDurations(metricsStore.handle(), {
      testId: opts.testId,
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
  const all = runHistoryStore.listLive() as unknown as EmitRun[];
  const runs = opts.testId ? all.filter((r) => r.testId === opts.testId) : all;
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
