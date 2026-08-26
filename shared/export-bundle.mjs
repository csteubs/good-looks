// WHAT MAY LEAVE THE LIBRARY (R10).
//
// ── What this is for ──────────────────────────────────────────────────────
// `good-looks export --out DIR` writes a directory a build server can run: the
// Action's `library` input points straight at it. The store it is written FROM
// holds a great deal more than that — run history, logs, screenshots, the
// metrics DB, the heal journal, insight reports, an LLM API key, a webhook
// URL, a Shopify signature and the encrypted secrets themselves. None of that
// is a runner's business and most of it is a credential.
//
// ── Why an allowlist, in both directions ──────────────────────────────────
// A denylist of files not to copy is right the day it is written and silently
// wrong the day a new store file lands beside the others — and the new file is
// the one nobody has thought about yet. So the FILES are named positively, and
// so are the FIELDS: an exported record is REBUILT from named keys rather than
// spread and pruned, which is the rule `main/recorder/types.ts` already applies
// at the capture boundary and for the same reason. Spreading carries every
// unknown key with it, and the next field added to `TestRecord` would ship
// without anyone deciding that it should.
//
// The rule for which fields: **a field is exported because a run reads it.**
// Not "because it seems harmless" — a field no runner reads is inert in the
// bundle, and inert-but-present is how this repo has shipped bugs before
// (R49's heal map installed itself and healed nothing). `check:export-egress`
// asserts every key of `TestRecord` is either exported or listed as
// deliberately withheld, so a new field fails the gate until someone decides.
//
// ── Author paths never travel ─────────────────────────────────────────────
// `scriptPath` and `sourceDir` are stored ABSOLUTE, from the machine that
// recorded the test — under that machine's home directory. A bundle is
// committed to a repository or uploaded as a CI artifact, so shipping them
// would put a username and a directory layout in both. They are rewritten to
// the position INSIDE the bundle, which is what a reader on the other machine
// can act on anyway: `shared/script-path.mjs` derives a spec's position from
// the record rather than trusting the stored path, which is the mechanism that
// makes a copied library work at all.
//
// `sourceDir` is rewritten rather than dropped, and that is not cosmetic. The
// unattended runner reads it as a BOOLEAN — "is this someone else's Playwright
// project" — and skips every fixture when it is set, because instrumenting an
// imported spec would rewrite their code rather than ours. Dropping the field
// would flip an imported test from uninstrumented to instrumented on the
// runner, which is a behaviour change dressed as a redaction.
//
// ── Pure ──────────────────────────────────────────────────────────────────
// Strings and records in, strings and records out. `node:path` only, the same
// allowance `shared/script-path.mjs` takes. WHERE the files are is the disk
// half's problem (`cli/export.mjs`); WHAT may cross is this.

import * as path from "node:path";

import { IMPORTED_SEGMENT, isSafeId, scriptRelSegments } from "./script-path.mjs";

/**
 * Every file a bundle contains, relative to its root.
 *
 * Two entries, and the list is exhaustive: `recorder/tests.json` is the record
 * of what to run, and `recorder/scripts/` holds the specs. `recorder/browsers/`
 * is deliberately absent even though a run needs one — it is hundreds of
 * megabytes of platform-specific binary, and `good-looks install` puts the
 * right one on the runner in seconds.
 */
export const BUNDLE_TESTS_FILE = "recorder/tests.json";
export const BUNDLE_SCRIPTS_DIR = "recorder/scripts";

/**
 * The record fields a bundle carries, because the unattended run path reads
 * them.
 *
 * Cross-referenced against `mcp/run-tests.mjs`, `mcp/run-plan.mjs` and
 * `mcp/select-tests.mjs` — the three modules a `good-looks run` goes through.
 * `hidden` is here for the last of those: it is what makes `--all` mean the
 * same set on the runner as in the app.
 */
export const EXPORTED_FIELDS = Object.freeze([
  "id",
  "name",
  "url",
  "createdAt",
  "updatedAt",
  "steps",
  "scriptPath",
  "sourceDir",
  "speed",
  "baseUrl",
  "hidden",
  "tags",
  "group",
  "a11yChecks",
  "recordLogs",
  "captureArtifacts",
  "testTimeoutMs",
  "variables",
  "datasets",
]);

/**
 * Fields deliberately NOT exported, each with the reason, because "we forgot"
 * and "we decided" look identical in a list that only names what is kept.
 *
 * `check:export-egress` reads this and `EXPORTED_FIELDS` together and requires
 * that between them they account for every key of `TestRecord`.
 */
export const WITHHELD_FIELDS = Object.freeze({
  sourceRoot: "an absolute path on the authoring machine, and nothing on the run path reads it",
  runHeadless: "a CI run is headless regardless, and the runner writes the field onto the record itself",
  basicAuth: "baked into the generated spec's test.use() at generation time, so the spec already carries it",
  saveSession: "a saved login session is a state file in the store, and the store does not travel",
  useSessionFrom: "points at that same saved session file, which is not in the bundle to point at",
  visualThreshold: "the visual diff runs in the app, against a baseline no bundle has room for",
  visualMasks: "part of that same diff, which does not happen on the runner",
  visualElementSteps: "part of that same diff, which does not happen on the runner",
  a11yBaseline: "accepted violations are a judgement made in the app about runs the app holds",
  stepsDiverged: "authoring state: whether the script and the steps have drifted apart HERE",
  stepsDivergedReason: "authoring state, and meaningless once the spec is the thing being run",
  stepsDivergedDismissed: "authoring state: a warning this machine's user has already signed off",
  scriptEdited: "the app's own note that a human edited the spec; the runner executes the file either way",
  runBrowser: "the test's preferred browser, which the CLI does not honour — `--browser` decides a CI run",
  isFlow: "nothing on the run path filters on it, so it would be inert; a flow's spec runs like any other",
  flowParams: "a flow's steps are inlined into each caller's spec at generation time, so nothing reads these here",
});

/**
 * A path as it is written INTO a bundle: forward slashes, always.
 *
 * A library authored on Windows stores `\` and one authored on macOS stores
 * `/`, and the bundle is read on whichever runner it lands on. Writing the
 * separator of the exporting machine would make a bundle that only works on
 * machines like the one it came from — which is the class of bug this whole
 * item exists to end.
 *
 * @param {string[]} segments
 * @returns {string}
 */
export function bundlePath(segments) {
  return segments.join("/");
}

/**
 * One exported test record, or null when it cannot be exported at all.
 *
 * Null for an id no path can be built from — the same refusal
 * `scriptRelSegments` makes, and for the same reason: there is no safe default,
 * and inventing one would put a spec somewhere nobody asked for.
 *
 * @param {Record<string, unknown>} record
 * @returns {{record: Record<string, unknown>, specSegments: string[]} | null}
 */
export function bundleRecord(record) {
  const segments = scriptRelSegments(record);
  if (!segments) return null;

  const out = /** @type {Record<string, unknown>} */ ({});
  for (const key of EXPORTED_FIELDS) {
    if (record?.[key] !== undefined) out[key] = record[key];
  }

  // The spec's position inside THIS bundle, never the author's path.
  out.scriptPath = bundlePath(segments);

  // A secret variable's VALUE is documented as never living on the record —
  // it is encrypted in `test-secrets.bin` and only the app can read it. That
  // is a convention the app maintains, not a property of the file: this reads
  // a `tests.json` off disk, which someone can hand-edit and which a bundle
  // being re-exported already carried once. Stripping it costs nothing and
  // turns "should not be there" into "cannot be there".
  if (Array.isArray(out.variables)) {
    out.variables = out.variables.map((v) =>
      v?.kind === "secret" && v?.value !== undefined
        ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "value"))
        : v,
    );
  }

  // Truthy-and-pathless for an imported test, absent for a recorded one — the
  // boolean the runner actually asks it, without the home directory.
  if (record?.sourceDir !== undefined) {
    out.sourceDir = segments[0] === IMPORTED_SEGMENT ? bundlePath([IMPORTED_SEGMENT, record.id]) : "";
  }
  if (out.sourceDir === "") delete out.sourceDir;

  return { record: out, specSegments: segments };
}

/**
 * What one test contributes to the bundle's scripts directory.
 *
 * A recorded test contributes its own spec. An IMPORTED one contributes its
 * whole sandbox: the spec relative-imports its siblings, and a spec copied
 * without them fails to load rather than failing a test. `import-service.ts`
 * built that directory precisely so the relative positions survive a copy, and
 * this is the copy it was built for.
 *
 * @param {Record<string, unknown>} record
 * @returns {{kind: "file", segments: string[]} | {kind: "tree", segments: string[]} | null}
 */
export function specSource(record) {
  const segments = scriptRelSegments(record);
  if (!segments) return null;
  if (segments[0] === IMPORTED_SEGMENT && isSafeId(record?.id)) {
    return { kind: "tree", segments: [IMPORTED_SEGMENT, String(record.id)] };
  }
  return { kind: "file", segments };
}

/**
 * Names of the secret variables a test declares.
 *
 * The same reading `mcp/run-plan.mjs` makes — a secret's VALUE is encrypted to
 * the app and is never on the record, so a bundle can carry the NAME and
 * nothing else. Spelled here rather than imported from `mcp/` because `shared/`
 * may not depend on it, and re-derived rather than guessed: a bundle that
 * silently omitted this would hand a CI operator a suite that fails at a login
 * form with nothing pointing at the cause.
 *
 * @param {Record<string, unknown>} record
 * @returns {string[]}
 */
export function secretNames(record) {
  const vars = Array.isArray(record?.variables) ? record.variables : [];
  return vars.filter((v) => v?.kind === "secret").map((v) => String(v?.name ?? "")).filter(Boolean);
}

/**
 * Plan a bundle from a library's `tests.json`.
 *
 * Returns the records to write, the specs to copy, and the tests that need
 * something the bundle cannot carry. `needsSecrets` is a WARNING, not an
 * exclusion: a suite of thirty tests where two want a password is a suite
 * twenty-eight of which run on the runner today, and refusing the whole export
 * over that would be refusing the feature. The two are named, with the
 * variable each wants, so nobody discovers it from a failing assertion.
 *
 * @param {unknown} tests
 * @returns {{records: Record<string, unknown>[], specs: ({kind: string, segments: string[], id: string})[], unusable: {id: unknown, name: unknown}[], needsSecrets: {id: string, name: string, names: string[]}[]}}
 */
export function planExport(tests) {
  const all = Array.isArray(tests) ? tests : [];
  const records = [];
  const specs = [];
  const unusable = [];
  const needsSecrets = [];

  for (const test of all) {
    const built = bundleRecord(test);
    const source = built ? specSource(test) : null;
    if (!built || !source) {
      unusable.push({ id: test?.id, name: test?.name });
      continue;
    }
    records.push(built.record);
    specs.push({ ...source, id: String(test.id) });
    const names = secretNames(test);
    if (names.length > 0) {
      needsSecrets.push({ id: String(test.id), name: String(test?.name ?? test.id), names });
    }
  }

  return { records, specs, unusable, needsSecrets };
}

/**
 * Where a spec lands inside the bundle, given the bundle root.
 *
 * @param {string} root
 * @param {string[]} segments
 * @returns {string}
 */
export function bundleSpecPath(root, segments) {
  return path.join(root, BUNDLE_SCRIPTS_DIR, ...segments);
}
