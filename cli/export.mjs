// `good-looks export --out DIR` — package this library into something a build
// server can run (R10).
//
// ── The problem it solves ──────────────────────────────────────────────────
// The Action's `library` input wants "the folder holding recorder/", and until
// now the only way to produce one was to copy the app's data directory by hand
// and hope. That directory holds run history, logs, screenshots, the metrics
// DB, an LLM API key, a webhook URL and the encrypted secrets store — so the
// hand-copy is a credential leak waiting for someone in a hurry, and a `.gitignore`
// is not a security boundary.
//
// ── Where the safety lives ─────────────────────────────────────────────────
// In `shared/export-bundle.mjs`, not here. That module decides WHAT may cross —
// which files, which fields, and that no path from the authoring machine
// travels. This file does the disk work and nothing else, the same split
// `ingest` has between `shared/run-ingest.mjs` and `cli/ingest.mjs`. It is in
// `shared/` rather than beside this file because the plan's §3 says the app
// will export too ("the app exports; the app never imports its own export"),
// and two allowlists is the drift this repo keeps paying for.
//
// ── What it deliberately does not do ───────────────────────────────────────
// No archive. A directory is diffable, greppable and can be committed; a
// tarball is a thing you have to open before you can see what you shipped, and
// what you shipped is the whole point of the review this command exists to make
// possible.
//
// No `--check` mode yet — the plan's "fail when a committed spec does not match
// what the store would generate". That needs the generator, which is compiled
// TypeScript and unreachable from here; it wants its own change.

import fs from "node:fs";
import path from "node:path";

import { readJsonFile } from "../mcp/data-dir.mjs";
import {
  BUNDLE_SCRIPTS_DIR,
  BUNDLE_TESTS_FILE,
  bundleSpecPath,
  planExport,
} from "../shared/export-bundle.mjs";
import { scriptsDirFor } from "../shared/script-path.mjs";
import { EXIT } from "./exit.mjs";

/**
 * Copy one file, making its parent directory.
 *
 * @param {string} from
 * @param {string} to
 */
function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/**
 * Copy a directory tree, refusing to follow a symlink out of it.
 *
 * An imported test's sandbox holds files that came from somebody else's
 * repository, and `copyFileSync` FOLLOWS a symlink — so a project shipping
 * `helpers.js -> ~/.ssh/id_rsa` would put that file's contents in the bundle.
 * The same rule `copyRelativeImports` applies on the way in, applied on the way
 * out, where the destination is a thing somebody commits.
 *
 * @param {string} from
 * @param {string} to
 * @returns {{files: number, skipped: string[]}}
 */
function copyTree(from, to) {
  let files = 0;
  const skipped = [];
  const walk = (src, dest) => {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.push(s);
        continue;
      }
      if (entry.isDirectory()) {
        walk(s, d);
        continue;
      }
      if (!entry.isFile()) continue;
      copyFile(s, d);
      files++;
    }
  };
  walk(from, to);
  return { files, skipped };
}

/**
 * Whether `dir` is empty enough to write a bundle into.
 *
 * A bundle is written by name, so an existing directory holding somebody's work
 * is a refusal rather than a merge: the two failure modes of guessing are
 * "silently mixed two libraries" and "silently deleted one", and neither is
 * something a command should decide on your behalf.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function isEmptyEnough(dir) {
  if (!fs.existsSync(dir)) return true;
  const entries = fs.readdirSync(dir).filter((n) => n !== ".DS_Store");
  return entries.length === 0;
}

/**
 * Write a portable bundle of this library into `out`.
 *
 * @param {{out: string, dryRun: boolean, json: boolean, force: boolean}} options
 * @param {{out: (s: string) => void, err: (s: string) => void, dataDir: string}} deps
 * @returns {number} an exit code
 */
export function exportCommand({ out: outDir, dryRun, json, force }, { out, err, dataDir }) {
  const root = path.resolve(outDir);
  const recorderDir = path.join(dataDir, "recorder");
  const scriptsDir = scriptsDirFor(recorderDir);

  // Exporting into the library it is read from would write tests.json over
  // itself, one truncated field at a time.
  if (path.resolve(dataDir) === root || path.resolve(recorderDir) === root) {
    err(`That is this library's own directory (${root}).`);
    err("Export somewhere else — the bundle is a copy, not a rearrangement.");
    return EXIT.CANNOT_START;
  }

  const tests = readJsonFile(dataDir, "recorder/tests.json", []);
  if (!Array.isArray(tests) || tests.length === 0) {
    err(`No tests in ${path.join(dataDir, "recorder", "tests.json")}.`);
    // 2, not 3. This is the empty-selection code, and it exists for exactly
    // this shape: a bundle of nothing is indistinguishable from a bundle that
    // worked, right up until the pipeline reports a clean pass over no tests.
    return EXIT.NO_MATCH;
  }

  if (!dryRun && !force && !isEmptyEnough(root)) {
    err(`${root} already has files in it.`);
    err("Pass --force to write into it anyway, or choose an empty directory.");
    return EXIT.CANNOT_START;
  }

  const { records, specs, unusable, needsSecrets } = planExport(tests);

  // A record whose spec is not on this disk is EXCLUDED, not carried. A bundle
  // holding a test whose spec never arrives reports "no tests found" on the
  // runner, which reads as a broken library rather than a missing file — the
  // confident-answer-about-nothing shape this whole area keeps producing.
  const kept = [];
  const missing = [];
  const symlinked = [];
  let specFiles = 0;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const from = path.join(scriptsDir, ...spec.segments);
    const to = bundleSpecPath(root, spec.segments);
    if (!fs.existsSync(from)) {
      missing.push({ id: spec.id, at: from });
      continue;
    }
    if (spec.kind === "tree") {
      if (!dryRun) {
        const result = copyTree(from, to);
        specFiles += result.files;
        symlinked.push(...result.skipped);
      } else {
        specFiles++;
      }
    } else {
      if (!dryRun) copyFile(from, to);
      specFiles++;
    }
    kept.push(records[i]);
  }

  if (kept.length === 0) {
    err(`None of the ${records.length} test(s) have a spec under ${scriptsDir}.`);
    return EXIT.NO_MATCH;
  }

  if (!dryRun) {
    const testsFile = path.join(root, BUNDLE_TESTS_FILE);
    fs.mkdirSync(path.dirname(testsFile), { recursive: true });
    fs.writeFileSync(testsFile, `${JSON.stringify(kept, null, 2)}\n`, "utf-8");
  }

  const summary = {
    exported: kept.length,
    specFiles,
    into: root,
    missingSpecs: missing.map((m) => m.id),
    unusable: unusable.length,
    needsSecrets,
    symlinksSkipped: symlinked.length,
    dryRun,
  };

  if (json) {
    out(JSON.stringify(summary, null, 2));
    return EXIT.PASSED;
  }

  out(`${dryRun ? "Would export" : "Exported"} ${kept.length} test(s) to ${root}`);
  out(`  ${BUNDLE_TESTS_FILE} and ${specFiles} file(s) under ${BUNDLE_SCRIPTS_DIR}/`);
  if (missing.length > 0) {
    out(`  ${missing.length} left out — no spec on this disk:`);
    for (const m of missing.slice(0, 10)) out(`    ${m.id} (looked in ${m.at})`);
  }
  if (unusable.length > 0) {
    out(`  ${unusable.length} left out — the record names no usable id`);
  }
  if (symlinked.length > 0) {
    // Named rather than silent: a symlink in an imported project is somebody
    // else's decision, and a bundle that quietly dropped it will fail on the
    // runner with a missing import.
    out(`  ${symlinked.length} symlink(s) not followed — a bundle copies files, not link targets`);
  }
  if (needsSecrets.length > 0) {
    // The whole export is still written. A suite of thirty where two want a
    // password is twenty-eight tests that run on the runner today, and
    // refusing over the two would be refusing the feature. But nobody should
    // discover this from a failing assertion at a login form.
    out("");
    out(`${needsSecrets.length} test(s) will not run until CI supplies their secrets:`);
    for (const t of needsSecrets) out(`  ${t.name} — ${t.names.join(", ")}`);
    out("Set them as environment variables on the runner. See `good-looks run --help`.");
  }
  out("");
  out(`Run it with:  good-looks run --all   (with GOOD_LOOKS_USERDATA=${root})`);

  return EXIT.PASSED;
}

/** Usage, printed for `--help` and beside a refusal. */
export const EXPORT_USAGE = `Usage: good-looks export --out <dir> [--force] [--dry-run] [--json]

Write a portable copy of this library — the tests and their specs, and nothing
else — into a directory a build server can run. It is what the GitHub Action's
\`library\` input wants.

Only recorder/tests.json and recorder/scripts/ are written. Run history, logs,
screenshots, the metrics database, saved sessions, API keys, webhook URLs and
the encrypted secrets store all stay where they are.

Secret VALUES never travel; a test that declares one is exported and named, so
you know which variables the runner has to be given.

Options:
  --out <dir>  where to write the bundle. Required
  --force      write into a directory that already has files in it
  --dry-run    report what would be written and write nothing
  --json       print the summary as JSON

Browsers are not copied — they are hundreds of megabytes and platform-specific.
Run \`good-looks install chromium\` on the runner instead.
`;

/** @param {string} message */
const fail = (message) => ({ ok: /** @type {const} */ (false), error: message });

/**
 * Parse `good-looks export --out <dir> [--force] [--dry-run] [--json]`.
 *
 * `--out` is a NAMED flag rather than a positional, unlike `ingest`'s
 * directory, and the asymmetry is deliberate: ingest READS the directory you
 * name and export WRITES it. A positional that is easy to typo is a different
 * risk when the command creates what it is pointed at.
 *
 * @param {string[]} argv arguments AFTER the subcommand
 * @returns {{ok: true, options: {out: string, force: boolean, dryRun: boolean, json: boolean}} | {ok: false, error: string} | {ok: "help"}}
 */
export function parseExportArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { ok: "help" };

  let outDir;
  let force = false;
  let dryRun = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--out") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) return fail("--out needs a directory.");
      if (outDir !== undefined) return fail(`Export to one directory at a time — got "${outDir}" and "${value}".`);
      outDir = value;
      continue;
    }
    // An unknown flag is a REFUSAL, as everywhere in this CLI. A misspelt
    // option must not quietly become "export with defaults" — here that would
    // mean writing a directory somewhere nobody asked for.
    if (arg.startsWith("-")) return fail(`Unknown option "${arg}".`);
    return fail(`Unexpected argument "${arg}". Name the directory with --out.`);
  }

  if (outDir === undefined) return fail("Where to? Pass --out <dir>.");
  return { ok: true, options: { out: outDir, force, dryRun, json } };
}
