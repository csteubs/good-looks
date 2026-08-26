// `--junit <path>` — the CLI's half of R1, and the FIRST emit path that cannot
// reach the app's redactor.
//
// ── Why this is not `emitReportTo` ───────────────────────────────────────
// `main/services/report-emitter.ts` already writes a report to a named path
// without a dialog. It is unreachable from here: it imports `@shell/backend`,
// the metrics DB, the run-history store and `redactWithSnapshot`, and this is
// plain `.mjs` running under Node with no Electron anywhere. So the emitters —
// which are pure, and shared for exactly this reason — are called directly, and
// everything the app's path does around them has to be done again here, on this
// side's terms.
//
// ── The scope is a SECURITY boundary, not a convenience ──────────────────
// The report is built from the RESULTS of one invocation, in memory. It never
// reads run history, and it takes no store — which is why it cannot be widened
// by a caller who means well.
//
// The reason is redaction. This process redacts with the secret values IT
// resolved, through `resolveCiSecrets` (R7): the environment and `--secrets-file`.
// A run the APP produced took its secrets from an encrypted store this process
// cannot read, so their values are not in hand and could not be redacted out.
// A report scoped to "every run of this test" would happily include one, and
// the file would look exactly like a file that had been redacted — the failure
// `check:emit-redaction` was written against, one process over.
//
// So the rule is structural: results in, XML out, no store parameter to widen.
//
// ── And the caller supplies VALUES, never a redactor ─────────────────────
// The same rule `emitReportTo` follows on the app's side. A caller that could
// pass a redactor could pass an identity function, and nothing about the file
// would look different. `check:emit-redaction` pins both halves.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { junitXml } from "../shared/emitters.mjs";
import { redact } from "../shared/secret-redaction.mjs";

/**
 * Turn one invocation's results into JUnit XML.
 *
 * @param {readonly object[]} results the `outcome.results` array — this
 *        invocation's runs and nothing else
 * @param {{secretValues?: readonly string[], suiteName?: string}} options
 *        `secretValues` are the values this process resolved for the tests it
 *        ran, and are the whole redaction budget available here
 * @returns {string}
 */
export function junitReportFor(results, { secretValues = [], suiteName } = {}) {
  const values = [...new Set(secretValues.filter((v) => typeof v === "string" && v !== ""))];
  return junitXml(
    (Array.isArray(results) ? results : []).map((r) => ({
      // Named explicitly rather than spread. A result also carries `vars` on
      // some paths and a dataset row's values have no business in a file that
      // leaves the machine — a spread would carry every field added later,
      // silently, which is how the capture boundary keeps being re-opened.
      testId: r.testId,
      testName: r.testName,
      status: r.status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      failedStepIndex: r.failedStepIndex,
      stepCount: r.stepCount,
      note: r.note,
    })),
    {
      ...(suiteName ? { suiteName } : {}),
      // NOT a parameter. See the header.
      redact: (text) => redact(text, values),
    },
  );
}

/**
 * Write it.
 *
 * The path may be RELATIVE, unlike the app's `emitReportTo`, and that is a
 * difference in what "here" means rather than an inconsistency. Under Electron
 * the cwd is wherever the bundle happened to be launched from, so a relative
 * path lands somewhere nobody chose; for a CLI the cwd is the shell the
 * operator typed in, and `--junit results.xml` in a CI workspace is the normal
 * spelling.
 *
 * @returns {{path: string, bytes: number, count: number}}
 * @throws {Error} a sentence, when the file cannot be written
 */
export function writeJunitReport(destination, results, options = {}) {
  const path = resolve(destination);
  const text = junitReportFor(results, options);
  try {
    writeFileSync(path, text, "utf-8");
  } catch (error) {
    // The path and the reason. Rethrown as a sentence because the raw error
    // repeats the path and reads like a stack trace in a CI log.
    throw new Error(`Could not write ${path}: ${error.code ?? String(error)}`);
  }
  return {
    path,
    bytes: Buffer.byteLength(text, "utf-8"),
    count: Array.isArray(results) ? results.length : 0,
  };
}
