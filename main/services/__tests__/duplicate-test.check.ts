// Standalone regression check for test duplication.
//
// The Vitest suite covers what duplication DOES. This covers the thing that
// rots: `TestRecord` keeps growing, and a copy inherits a field only because
// somebody put it in `DUPLICATED_FIELDS`. Add `lastRunSummary` to the record
// next month and the allowlist doesn't mention it, nothing fails, and the field
// silently isn't copied — or, had the code spread the source instead, silently
// IS, carrying one test's run state into another. Either way there is no error,
// no failing test, and no moment where anyone was asked.
//
// So the exhaustiveness assert is the point of this file: every field of
// `TestRecord` must appear in exactly one of the two lists. Adding a field to
// the record fails the gate until somebody decides whether a copy should carry
// it — which is a 30-second decision at the right moment, versus a bug class
// that surfaces months later as "why does my copy think it passed?".
//
// Also pinned here, because both are security-shaped and neither is visible in
// normal use:
//   • the imported-sandbox copy skips non-regular files rather than reading
//     through a symlink, and still asserts its destination is contained;
//   • the handler copies secrets AND refreshes the redaction snapshot — a copy
//     whose secrets never reached redaction writes that password into a run log
//     in plaintext, which is the exact failure the secret store exists for.
//
// The field list is parsed from the SOURCE of types.ts rather than derived from
// the type, because a TypeScript interface leaves nothing behind at run time —
// there is no value to enumerate.
//
// Bundled with esbuild + the @glaze/core/backend stub — see package.json. Run:
//   npm run check:duplicate-test

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Anchored on the npm-script cwd (the project root), NOT on `import.meta.url`:
// esbuild writes the bundle into node_modules/.cache, which in a worktree is a
// symlink into the MAIN checkout — so a path derived from the module's own
// location reads a different tree than the one being checked, or none at all.
// Same reasoning as trainer-panel.check.ts.
const repoRoot = process.cwd();

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-duplicate-check-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { DUPLICATED_FIELDS, DROPPED_FIELDS } = await import("../duplicate-test.js");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/**
 * The property names declared by `interface <name>` in a source file.
 *
 * Deliberately crude: it takes the interface body and picks off anything
 * shaped like `foo?:` or `foo:` at the start of a line. Nested object literals
 * would fool it, and `TestRecord` has none — every field is a named type. A
 * parser that silently found ZERO fields would make this whole check vacuous,
 * so the count is asserted below rather than trusted.
 */
function interfaceFields(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  if (start < 0) return [];
  const bodyStart = source.indexOf("{", start) + 1;
  let depth = 1;
  let i = bodyStart;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
  }
  const body = source.slice(bodyStart, i - 1);
  const fields: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^\s{2}([A-Za-z_$][\w$]*)\??:/.exec(line);
    if (m) fields.push(m[1]);
  }
  return fields;
}

function main(): void {
  const typesSource = fs.readFileSync(path.join(repoRoot, "main/recorder/types.ts"), "utf-8");
  const serviceSource = fs.readFileSync(
    path.join(repoRoot, "main/services/duplicate-test.ts"),
    "utf-8",
  );
  const handlerSource = fs.readFileSync(path.join(repoRoot, "main/handlers/index.ts"), "utf-8");

  // ── 1. Every TestRecord field is accounted for ───────────────────────────
  const recordFields = interfaceFields(typesSource, "TestRecord");

  // Guard the parser itself. If the shape of types.ts ever defeats it, this
  // check must fail loudly rather than pass with an empty list — a vacuous
  // exhaustiveness check is worse than none, because it reads as coverage.
  assert(
    recordFields.length > 20,
    `parsed a plausible TestRecord field list (${recordFields.length} fields)`,
  );
  for (const anchor of ["id", "name", "steps", "scriptPath", "a11yBaseline"]) {
    assert(recordFields.includes(anchor), `parsed field list includes "${anchor}"`);
  }

  const duplicated = new Set<string>(DUPLICATED_FIELDS);
  const dropped = new Set<string>(DROPPED_FIELDS);

  const unclassified = recordFields.filter((f) => !duplicated.has(f) && !dropped.has(f));
  assert(
    unclassified.length === 0,
    unclassified.length === 0
      ? "every TestRecord field is classified as duplicated or dropped"
      : `every TestRecord field is classified — UNCLASSIFIED: ${unclassified.join(", ")}. ` +
        "Add each to DUPLICATED_FIELDS or DROPPED_FIELDS in main/services/duplicate-test.ts, " +
        "with a comment saying why a copy should or shouldn't carry it.",
  );

  const both = [...duplicated].filter((f) => dropped.has(f));
  assert(both.length === 0, `no field is in both lists${both.length ? `: ${both.join(", ")}` : ""}`);

  const stale = [...duplicated, ...dropped].filter((f) => !recordFields.includes(f));
  assert(
    stale.length === 0,
    `neither list names a field TestRecord no longer has${stale.length ? `: ${stale.join(", ")}` : ""}`,
  );

  // ── 2. The fields whose classification is load-bearing ───────────────────
  //
  // Spelled out rather than left to the exhaustiveness check, which is happy as
  // long as a field is in SOME list. These are the ones where the wrong list is
  // a silent bug rather than a preference.
  assert(
    dropped.has("a11yBaseline"),
    "a11yBaseline is dropped — accepted violations describe the ORIGINAL's runs, and a copy " +
      "carrying them reports a clean page it has never been run against",
  );
  assert(
    dropped.has("hidden"),
    "hidden is dropped — the action navigates to the copy, so inheriting it produces a test " +
      "the user cannot see",
  );
  assert(
    duplicated.has("steps") && duplicated.has("variables") && duplicated.has("datasets"),
    "steps, variables and datasets are copied — they are what the test IS",
  );
  assert(
    duplicated.has("visualMasks") && duplicated.has("visualElementSteps"),
    "visual masks and element-scoped steps are copied — they are per-step settings the user " +
      "drew, not run output",
  );

  // ── 3. The record is rebuilt, not spread ─────────────────────────────────
  //
  // The allowlist only means anything if it is the thing the record is built
  // from. A `...src` anywhere in the construction re-opens the hole the lists
  // exist to close, and every test would still pass.
  assert(
    serviceSource.includes("for (const key of DUPLICATED_FIELDS)"),
    "the copy is built by iterating DUPLICATED_FIELDS",
  );
  assert(
    !/\.\.\.\s*src\b/.test(serviceSource),
    "the source record is never spread into the copy",
  );

  // ── 4. The sandbox copy's two guards ─────────────────────────────────────
  assert(
    serviceSource.includes("if (!entry.isFile())"),
    "the sandbox copy skips anything that is not a regular file, rather than following a symlink",
  );
  assert(
    serviceSource.includes("if (!isInside(to, dest))"),
    "the sandbox copy asserts each destination stays inside the new sandbox",
  );
  assert(
    serviceSource.includes("isInside(scriptsRoot, from)") &&
      serviceSource.includes("isInside(scriptsRoot, to)"),
    "both sandbox roots are checked against the scripts dir",
  );

  // ── 5. The handler's half ────────────────────────────────────────────────
  const handlerBody = handlerSource.slice(handlerSource.indexOf('ipcMain.handle("tests:duplicate"'));
  const duplicateHandler = handlerBody.slice(0, handlerBody.indexOf("ipcMain.handle", 1));
  assert(duplicateHandler.length > 0, "found the tests:duplicate handler");
  assert(
    duplicateHandler.includes("testSecretsStore.copyTest"),
    "tests:duplicate copies the test's stored secrets, so the copy can run",
  );
  assert(
    duplicateHandler.includes("refreshSecretSnapshot"),
    "tests:duplicate refreshes the redaction snapshot — otherwise the copy's password is a " +
      "value redaction was never told about, and it reaches the next run log in plaintext",
  );

  fs.rmSync(userData, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll duplicate-test checks passed");
}

main();
