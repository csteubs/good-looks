// A RUN RECORD FROM ANOTHER MACHINE, made safe to store here (R12).
//
// ── Why this exists ────────────────────────────────────────────────────────
// A suite that runs forty times a week in a container produces forty run
// histories that die with their containers, while Stability, the flake verdict
// and step health — the surfaces that make the app worth opening — are built
// from the handful of runs somebody triggered by hand. `good-looks ingest`
// carries those runs back. This module is the boundary they cross.
//
// ── It is an INGRESS BOUNDARY, in the strongest sense this repo uses ───────
// A run record arrives as JSON, from a directory a CI job produced, downloaded
// as an artifact zip by whoever is running the command. Treat it exactly like
// an imported project or a captured step: something that becomes an input to
// code running on the user's machine.
//
// TWO FIELDS ARE DANGEROUS, and both in the way this codebase has been bitten
// before — a stored path used without a containment check:
//
//   - `logFile` IS AN ABSOLUTE PATH, written by the machine that produced the
//     run. `runHistoryStore.readLog` does `readFileSync(rec.logFile)` with no
//     check at all, and `searchLogs` reads EVERY live record's `logFile` and
//     returns an excerpt around each match. So a record carrying
//     `logFile: "/etc/shadow"` would let the app's log search read arbitrary
//     files on disk, and the run panel's "view log" display them. (A home
//     directory path is the realistic case; it is not written here because
//     `check:repo-hygiene` refuses one, correctly.) This module NEVER carries the
//     incoming value: the field is absent from what it returns, and the caller
//     — which is the half that knows where logs live here — supplies a local
//     path it derived itself.
//
//     That is the same rule `shared/script-path.mjs` applies to `scriptPath`,
//     and for the same reason: a path is only meaningful on the machine that
//     wrote it, so the honest move is to re-derive it on the machine reading.
//
//   - `id` BECOMES A FILENAME. The log is written to `<logs>/<id>.log`, so an
//     id of `../../../etc/cron.d/x` is a write outside the store. It is
//     validated as a safe token here rather than escaped at the call site,
//     because an escape is a thing one of several callers can forget.
//
// ── Rebuild, never filter ──────────────────────────────────────────────────
// The same rule as `normalizeRawStep` and every other boundary here. Spreading
// the input and overwriting known keys carries every unknown key with it, so
// the next field wired into a surface is silently a hole again. Everything
// below names the field it copies.
//
// ── One bad field does not lose the run ────────────────────────────────────
// Optional fields are judged INDEPENDENTLY: a record whose `note` is a payload
// still has a real status and a real timestamp, and dropping the whole thing
// would be this guard destroying the evidence it exists to carry. Required
// fields are the exception, and deliberately: a record with no usable `status`
// or `startedAt` cannot be half-ingested — it is skipped, counted, and
// reported, rather than stored with a value nobody supplied.

import { normalizeSiteHealthSummary } from "./site-health.mjs";
import { normalizeRunProvenance } from "./run-provenance.mjs";
import { normalizeRunTrigger } from "./run-trigger.mjs";
import { isRunDigest } from "./steps-digest.mjs";

/**
 * The most a free-text field on an ingested record may be.
 *
 * Generous next to a test name and far under a size that would matter to a
 * store read whole on every write.
 */
export const INGEST_MAX_TEXT = 500;

/** Control characters, which no legitimate name, id or URL contains. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Ids that may be used as a filename.
 *
 * Deliberately NOT `isUuid`, though every id this application writes today is
 * one. The rule that has to hold is "this cannot escape the logs directory or
 * name something other than itself", and a shape rule that is stricter than the
 * property it protects starts refusing legitimate records the day some other
 * path mints an id differently.
 *
 * The first character must be alphanumeric, which is what rejects `.` and `..`
 * without a special case for them; the class excludes both separators, so no
 * traversal is expressible.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Is this a value we are willing to use as part of a filename?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIngestableRunId(value) {
  if (typeof value !== "string") return false;
  if (!SAFE_ID.test(value)) return false;
  // Belt and braces over the character class above. A separator can never reach
  // here, and the day someone widens SAFE_ID for a legitimate reason, this is
  // the line that still refuses the thing the widening was not about.
  return !value.includes("/") && !value.includes("\\");
}

/**
 * One free-text field, or undefined.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function text(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > INGEST_MAX_TEXT) return undefined;
  if (CONTROL_CHARS.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * One finite number, or undefined. `min` bounds it where a negative is not a
 * value but a corruption — a run cannot have lasted minus four seconds, and a
 * negative duration reaching a chart renders as an axis nobody can read.
 *
 * @param {unknown} value
 * @param {number} [min]
 * @returns {number | undefined}
 */
function num(value, min = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < min) return undefined;
  return value;
}

/**
 * One boolean, or undefined. Strictly typed rather than coerced: `"false"` is a
 * string a JSON store can hold and truthiness would read it as yes.
 *
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
function bool(value) {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * One member of a closed vocabulary, or undefined.
 *
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @returns {string | undefined}
 */
function oneOf(value, allowed) {
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

const STATUSES = ["passed", "failed"];
const KINDS = ["run", "baseline-update"];
const BROWSERS = ["chromium", "firefox", "webkit"];
const SPEEDS = ["fast", "medium", "slow", "crawl"];
const ENDED_BY = ["user", "process-timeout"];
const REASON_BY = ["user", "auto"];

/**
 * Narrow one foreign run record to something this library will store.
 *
 * Returns `null` when the record cannot be stored at all, which means one of
 * its REQUIRED fields is missing or unusable. Everything else is best-effort per
 * field.
 *
 * `logFile` IS NOT PART OF THE RESULT. That is the point of the module and not
 * an oversight: the caller derives a local path from the (now validated) id and
 * sets it, so no foreign path can reach a store whose readers do not bound it.
 * The type declares the return without it for exactly that reason — a caller
 * that forgets does not compile.
 *
 * `hasTrace` is dropped unconditionally, which is a decision rather than an
 * omission: ingest carries run records and their logs, not Playwright traces,
 * so a carried `hasTrace: true` would light up an Open Trace button pointing at
 * a file that was never copied. Absent is the truth here.
 *
 * `failedStepIndex` and `stepCount` are dropped too, and that is worth a note
 * because a real CI record carries them: `mcp/run-tests.mjs` writes both, the
 * app's `RunRecord` declares neither, and nothing app-side reads them off a run.
 * They are the runner's own result fields that happen to land in the file.
 * Carrying undeclared keys into the app's store is the "rebuild, never filter"
 * rule broken in slow motion, and the flake verdict — the surface R12 exists to
 * feed — reads none of them (`id`, `testId`, `status`, `startedAt`, `kind`,
 * `endedBy`, `runBrowser`, `datasetId`, `datasetName`, and that is the list).
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
export function normalizeIngestedRun(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = /** @type {Record<string, unknown>} */ (value);

  // ── Required. A record missing any of these is not half-ingested. ────────
  if (!isIngestableRunId(raw.id)) return null;
  const testId = text(raw.testId);
  const testName = text(raw.testName);
  const status = oneOf(raw.status, STATUSES);
  const startedAt = num(raw.startedAt, 1);
  const finishedAt = num(raw.finishedAt, 1);
  const durationMs = num(raw.durationMs);
  const exitCode = num(raw.exitCode);
  if (
    testId === undefined ||
    testName === undefined ||
    status === undefined ||
    startedAt === undefined ||
    finishedAt === undefined ||
    durationMs === undefined ||
    exitCode === undefined
  ) {
    return null;
  }

  /** @type {Record<string, unknown>} */
  const out = {
    id: raw.id,
    testId,
    testName,
    // The site the test points at. Kept as capped text rather than run through a
    // URL gate: this is the value the record already held for display, and a
    // recorded test's url is not followed by anything on this machine.
    url: text(raw.url) ?? "",
    status,
    exitCode,
    startedAt,
    finishedAt,
    durationMs,
    // Re-derived by the caller from the log it actually copied. A foreign byte
    // count would describe a file this machine does not have.
    logBytes: 0,
  };

  // ── Optional, each judged on its own ─────────────────────────────────────
  const opt = (key, v) => {
    if (v !== undefined) out[key] = v;
  };

  opt("captureArtifacts", bool(raw.captureArtifacts));
  opt("runHeadless", bool(raw.runHeadless));
  opt("runBrowser", oneOf(raw.runBrowser, BROWSERS));
  opt("baseUrl", text(raw.baseUrl));
  opt("speed", oneOf(raw.speed, SPEEDS));
  opt("batchId", text(raw.batchId));
  opt("healedSteps", num(raw.healedSteps));
  opt("healFailedSteps", num(raw.healFailedSteps));
  // Tabs the run's browser opened. A CI run is where a `_blank` link meets
  // the follow-the-newest-tab fixture most often, and the count is the only
  // trace of it that outlives the log.
  opt("tabsOpened", num(raw.tabsOpened));
  // R24, and the reason it is not optional-in-spirit: CI is where `--retries`
  // is actually used, so a run that recovered on a retry is exactly the run
  // this command carries back — and without these two it arrives looking like
  // a clean pass. The flake verdict would then read a green history for a test
  // that went red on every run in the container.
  opt("attempt", num(raw.attempt));
  opt("passedOnRetry", bool(raw.passedOnRetry));
  opt("testTimeoutMs", num(raw.testTimeoutMs));
  opt("datasetId", text(raw.datasetId));
  opt("datasetName", text(raw.datasetName));
  opt("a11yMs", num(raw.a11yMs));
  opt("a11yChecks", num(raw.a11yChecks));
  opt("a11yNewSteps", num(raw.a11yNewSteps));
  opt("aiChecksPassed", num(raw.aiChecksPassed));
  opt("aiChecksFailed", num(raw.aiChecksFailed));
  opt("aiChecksUnevaluated", num(raw.aiChecksUnevaluated));
  opt("captureOverheadMs", num(raw.captureOverheadMs));
  opt("shotCount", num(raw.shotCount));
  // The per-host Site Health summary, rebuilt through its own gate: a CI run
  // is where most readings will come from, and the series in the Site Health
  // view is built from THIS field (the per-page artifact travels beside the
  // log, keyed by the same validated ids, and is admitted by the app's reader).
  opt("siteHealth", normalizeSiteHealthSummary(raw.siteHealth));
  // Only when it names a run we would also accept, because it is an id that
  // joins back to one — a value that could never match anything is noise that
  // renders as a broken link.
  opt("replayOfRunId", isIngestableRunId(raw.replayOfRunId) ? raw.replayOfRunId : undefined);
  opt("failureReasonId", text(raw.failureReasonId));
  opt("failureReasonBy", oneOf(raw.failureReasonBy, REASON_BY));
  opt("failureReasonSignal", text(raw.failureReasonSignal));
  opt("endedBy", oneOf(raw.endedBy, ENDED_BY));
  // Through the vocabularies they already have, rather than a second copy of
  // either. An unrecognised trigger from a newer writer narrows to absent, and
  // absent is honestly unknown.
  opt("trigger", normalizeRunTrigger(raw.trigger));
  opt("provenance", normalizeRunProvenance(raw.provenance));
  // WHAT THE RUN EXECUTED, and one of the few foreign fields that is fully
  // meaningful here: a digest is derived from content, not from the machine, so
  // a container's `s1:…` compares against a laptop's on equal terms. CI is also
  // where a test is most likely to have been edited between two runs somebody
  // is looking at, which is the reading this field exists to protect.
  //
  // Through its own grammar rather than `text()`: it is a bounded token, and an
  // over-long or mis-shaped one stored here would be compared against a good
  // digest for the rest of that run's life.
  opt("stepsDigest", isRunDigest(raw.stepsDigest) ? raw.stepsDigest : undefined);
  opt("failedStepLabel", text(raw.failedStepLabel));
  opt("kind", oneOf(raw.kind, KINDS));
  opt("note", text(raw.note));
  opt("testDeleted", bool(raw.testDeleted));

  return out;
}

/**
 * Split incoming records into the ones to store and the ones already here.
 *
 * DEDUPED BY ID, which is what makes `ingest` safe to run twice — and it will
 * be run twice, because the natural way to use it is to point it at whatever
 * artifact directory is on hand and let it work out what is new. An id-keyed
 * skip is also what stops a second ingest from doubling a test's run count and
 * manufacturing flake out of arithmetic.
 *
 * Records are normalized here rather than by the caller, so "unusable" and
 * "already present" are counted apart. A caller that sees `skipped > 0` has
 * been handed something it could not read; one that sees `duplicate > 0` has
 * simply run the command before, and those two deserve different sentences.
 *
 * Duplicates are detected within the incoming batch as well as against what is
 * already stored: a directory holding the same run twice is a real thing (two
 * artifact zips unpacked over each other), and without the second check both
 * copies would be fresh.
 *
 * @param {Iterable<string>} localIds ids already in this library
 * @param {unknown[]} incoming raw records, straight off disk
 * @returns {{fresh: Record<string, unknown>[], duplicate: number, unusable: number}}
 */
export function planIngest(localIds, incoming) {
  const seen = new Set(localIds);
  /** @type {Record<string, unknown>[]} */
  const fresh = [];
  let duplicate = 0;
  let unusable = 0;

  for (const candidate of Array.isArray(incoming) ? incoming : []) {
    const record = normalizeIngestedRun(candidate);
    if (!record) {
      unusable++;
      continue;
    }
    const id = /** @type {string} */ (record.id);
    if (seen.has(id)) {
      duplicate++;
      continue;
    }
    seen.add(id);
    fresh.push(record);
  }

  return { fresh, duplicate, unusable };
}
