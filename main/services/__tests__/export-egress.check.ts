// What may leave the library (R10) — the source-level half.
//
// `main/services/cli-export.test.ts` proves a bundle built from a store full of
// credentials carries none of them. That is the behavioural half and it is the
// stronger one. This exists for the two things a behavioural test structurally
// cannot see:
//
//   1. A FIELD NOBODY HAS DECIDED ABOUT. `EXPORTED_FIELDS` and
//      `WITHHELD_FIELDS` are a pair of lists, and the risk is not that one is
//      wrong — it is that `TestRecord` grows a fourteenth optional field and
//      neither list mentions it. The behavioural test builds a fixture, so it
//      only ever sees fields somebody wrote into the fixture. This reads the
//      TYPE and requires every key of it to appear in one list or the other, so
//      a new field fails the gate until a person decides which.
//
//   2. A SECOND WAY OUT. The export writes files, which makes it an egress
//      path in the sense §3.5 of the plan means: "every CI proposal above adds
//      an egress path". The disk half must go through the shared allowlist
//      rather than reaching for the store's own directory — a `cpSync` of
//      `recorder/` would pass every test that names the files it excludes.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXPORTED_FIELDS, WITHHELD_FIELDS } from "../../../shared/export-bundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

let failures = 0;
function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}
const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");

// ── 1. Every field of TestRecord has been decided about ──────────────

/**
 * The keys of `TestRecord`, read out of the interface body.
 *
 * By text rather than by the type system, because this check runs under `tsx`
 * with no program: a field is `name?: Type;` at the start of a line inside the
 * one interface, and every JSDoc line above it starts with `*`.
 */
function testRecordKeys(source: string): string[] {
  const start = source.indexOf("export interface TestRecord {");
  if (start === -1) return [];
  const body = source.slice(start, source.indexOf("\n}", start));
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]);
}

const keys = testRecordKeys(read("main/recorder/types.ts"));
// Without this the loop below passes by iterating over nothing — the shape this
// repository keeps meeting, and the reason every scan here states its own size.
assert(keys.length >= 20, `TestRecord's fields were read (found ${keys.length})`);

const exported = new Set(EXPORTED_FIELDS);
const withheld = new Set(Object.keys(WITHHELD_FIELDS));
const undecided = keys.filter((k) => !exported.has(k) && !withheld.has(k));
assert(
  undecided.length === 0,
  "every field of TestRecord is either exported or listed as withheld — a new " +
    "field must not ship in a bundle because nobody looked. Undecided: " +
    (undecided.join(", ") || "none"),
);

// And the lists do not name a field that no longer exists, which is how a list
// stops describing the thing it claims to cover.
const stale = [...exported, ...withheld].filter((f) => !keys.includes(f));
assert(
  stale.length === 0,
  `neither list names a field TestRecord no longer has. Stale: ${stale.join(", ") || "none"}`,
);

// ── 2. Nothing is exported that a run does not read ──────────────────
//
// The rule the module states: "a field is exported because a run reads it". A
// field nobody reads is inert in the bundle, and inert-but-present is how R49
// shipped a heal map that installed itself and healed nothing.

const runSources = ["mcp/run-tests.mjs", "mcp/run-plan.mjs", "mcp/select-tests.mjs"]
  .map(read)
  .join("\n");
// `id`, `name` and the timestamps are read through destructuring and through
// the record's own identity rather than as `test.x`, so they are exempted by
// name rather than by widening the pattern until it matches everything.
const READ_ELSEWHERE = new Set(["id", "name", "createdAt", "updatedAt"]);
const unread = EXPORTED_FIELDS.filter(
  (f) => !READ_ELSEWHERE.has(f) && !new RegExp(`\\.${f}\\b`).test(runSources),
);
assert(
  unread.length === 0,
  "every exported field is one the unattended run path reads — a field no runner " +
    `reads is inert in the bundle. Unread: ${unread.join(", ") || "none"}`,
);

// ── 3. The disk half goes through the allowlist ──────────────────────

const cli = read("cli/export.mjs");
assert(
  /from "\.\.\/shared\/export-bundle\.mjs"/.test(cli),
  "cli/export.mjs decides what may cross through shared/export-bundle.mjs",
);
// A recursive copy of the store's own directory would carry run history, logs,
// artifacts, the metrics DB and the encrypted secrets, and would pass any test
// that lists the files it means to exclude.
const bulk = [...cli.matchAll(/\b(cpSync|cp)\s*\(/g)].map((m) => m[1]);
assert(
  bulk.length === 0,
  `the export never bulk-copies a directory from the store (found ${bulk.join(", ") || "none"}) — ` +
    "it copies the specs it planned, one at a time",
);
// Each store file that must never travel, asserted by NAME. Redundant with the
// allowlist by design: this is the list a reader checks against, and it fails
// loudly if someone reaches for one of these directly.
for (const forbidden of [
  "recorder-settings.json",
  "run-history.json",
  "test-secrets.bin",
  "alert-webhook.bin",
  "shopify-signatures",
  "heal-journal.json",
  "insight-reports.json",
  "metrics.db",
  "artifacts",
  "browsers",
]) {
  assert(
    !new RegExp(`["'\`][^"'\`]*${forbidden.replace(".", "\\.")}`).test(cli),
    `cli/export.mjs never names ${forbidden} as something to copy`,
  );
}

// ── 4. No author path can be written into a bundle ───────────────────

const shared = read("shared/export-bundle.mjs");
assert(
  /out\.scriptPath = bundlePath\(segments\)/.test(shared),
  "an exported record's scriptPath is the position INSIDE the bundle, never the stored one",
);
assert(
  !EXPORTED_FIELDS.includes("sourceRoot"),
  "sourceRoot — an absolute path on the authoring machine — is not exported",
);
assert(
  /kind === "secret"/.test(shared) && /!== "value"/.test(shared),
  "a secret variable's value is stripped, so a hand-edited tests.json cannot carry one out",
);

// ── 5. The relative-path refusal that made a bundle safe to read ─────
//
// A bundle's scriptPath is RELATIVE, and `path.resolve` completes a relative
// path against `process.cwd()`. Without this refusal `resolveScriptPath` would
// answer differently depending on where the process was started, and hand its
// caller back the relative string — which the caller turns into a `../../..`
// walk out of the library with `path.relative`.

assert(
  /if \(!path\.isAbsolute\(candidate\)\) return false;/.test(read("shared/script-path.mjs")),
  "isInsideScripts refuses a relative candidate, so a bundle's own paths cannot become cwd-dependent",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll export-egress checks passed.");
