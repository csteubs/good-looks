// `good-looks run` — the CLI as the THIRD CALLER of the run path.
//
// docs/plans/test-runner-improvements.md §3.3 makes that the load-bearing
// decision, and `mcp/run-plan.mjs` records why: the app's runner and the MCP's
// had already silently diverged in four ways by 2026-08-07, and
// `check:mcp-parity` exists to stop a third. So there is no runner here. This
// file resolves a data directory, calls `runSelection`, and turns the result
// into text and a number.
//
// That it CAN is the whole point of the extraction (#255): the batch driver
// used to return MCP tool content at every exit, so the only thing that could
// call it was an MCP tool. It returns a result now, and this is the second
// thing rendering one.
//
// `install` (R11) lives here too, for one reason: without it the CLI's answer
// to a missing browser is the MCP's — "run a test once from the app" — which is
// useless advice on a CI runner, the entire audience of this binary.
//
// ── What is deliberately not here ────────────────────────────────────────
// `--results-out` (R13), `--retries`, `--fail-fast`, and the `report`,
// `export`, `eject` and `ingest` subcommands are each their own ranked item.
//
// `--junit` IS here as of R1 — see `cli/junit.mjs`, which is where the reason
// it could not simply call the app's `emitReportTo` is written down.
//
// ── What arrived since, and changed the paragraph above ──────────────────
// `--base-url` IS here as of R5. It overrides what RELATIVE navigations resolve
// against — which only an imported spec has, since a recorded test navigates to
// the absolute URL the recorder watched — and the run REPORTS when the override
// reached tests it cannot affect, rather than changing nothing quietly.
//
// `--secrets-file` IS here as of R7 (#260) — see `cli/args.mjs`. R7 narrowed
// the skip rather than removing it: a test is skipped only for the secret names
// that actually resolved to nothing, and the note NAMES the variables to set
// rather than saying "secrets are unavailable". It is never run with a blank.
// A suite in which everything skipped then exits 3, not 0 (#261) — a green
// pipeline that executed nothing is the failure this binary exists to avoid.
//
// What R7 did NOT extend to is signature headers, whose values are still
// encrypted to the app and unreadable here; see `shared/run-fixtures.mjs`.

import process from "node:process";
import { readFileSync } from "node:fs";

import { ambientCiSecretValues, resolveCiSecrets } from "../shared/ci-secrets.mjs";
import { resolveDataDir } from "../mcp/data-dir.mjs";
import { createStore } from "../mcp/store.mjs";
import { createRunner } from "../mcp/run-tests.mjs";
import { EXIT, exitCodeFor } from "./exit.mjs";
import { writeJunitReport } from "./junit.mjs";

/**
 * The sentence for a refusal.
 *
 * Rendered from the REASON rather than passed through from the runner, which is
 * what the extraction bought: the MCP renders the same four reasons into text
 * an agent reads, and this renders them into text a person reads at a terminal
 * with a CI log around it. Neither had to become the other's wording.
 *
 * @param {object} outcome a `{ok:false}` result from `runSelection`
 */
export function refusalMessage(outcome) {
  switch (outcome.reason) {
    case "no-match":
      // The message names the selector that ACTUALLY applied, because the
      // commonest cause is a selector that no longer matches anything — a tag
      // renamed from `smoke` to `Smoke` — and "no tests matched" without saying
      // what was asked for sends people to the wrong file.
      return (
        `No tests matched ${outcome.how}. Nothing ran.\n` +
        `  This is exit ${EXIT.NO_MATCH} rather than a pass: a suite of zero tests is not a green suite.`
      );
    case "unknown-browser":
      return `Unknown browser: ${outcome.browser}`;
    case "no-playwright":
      return (
        `Could not find @playwright/test under ${outcome.projectRoot}/node_modules.\n` +
        `  The CLI runs the bundled Playwright rather than one on your PATH.`
      );
    case "no-browser":
      // The MCP tells an agent to run a test once from the app. That is useless
      // advice on a CI runner, which is the whole audience of this binary and
      // has no app — so R11 exists mostly to make this sentence able to name a
      // command instead.
      return (
        `${outcome.browser} is not installed.\n` +
        `  Run: good-looks install ${outcome.browser}\n` +
        `  (add --with-deps on a Linux CI image that has no system libraries.)`
      );
    default:
      // Not reachable through `runSelection`'s own union, and deliberately not
      // an assertion: a CLI's last act should be to say something, not to throw
      // a stack trace at a CI log.
      return `The run could not start (${outcome.reason ?? "no reason given"}).`;
  }
}

/** The human summary of a run that happened. One line per test, then a total —
 *  short enough to read in a CI log without folding, since that is where it
 *  will be read. */
function humanReport(outcome) {
  const lines = [];
  for (const r of outcome.results) {
    const mark = r.status === "passed" ? "✓" : r.status === "skipped" ? "–" : "✗";
    const name = r.datasetName ? `${r.testName} [${r.datasetName}]` : r.testName;
    const ms = typeof r.durationMs === "number" ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : "";
    lines.push(`  ${mark} ${name}${ms}${r.note ? `\n      ${r.note}` : ""}`);
  }
  const s = outcome.summary;
  lines.push("");
  lines.push(
    `  ${s.passed} passed, ${s.failed} failed` +
      (s.skipped ? `, ${s.skipped} skipped` : "") +
      ` in ${(s.durationMs / 1000).toFixed(1)}s on ${outcome.browser}`,
  );
  // Named explicitly, because a skip does NOT fail the run and someone reading
  // a green pipeline deserves to know a test in it did not execute. Silence
  // here is how a secret-bearing test quietly stops being covered.
  if (s.skipped > 0) {
    lines.push(`  ${s.skipped} test(s) were skipped and did not run. See the notes above.`);
  }
  if (outcome.missing.length > 0) {
    // Ids that matched nothing. Reported even on a pass, and NOT folded into
    // exit code 2 — some tests did run, so calling it an empty selection would
    // be a lie in the other direction. "Run these 5" must never quietly run 4
    // and report success.
    lines.push(`  Not found: ${outcome.missing.join(", ")}`);
  }
  if (outcome.fixturesSkipped.length > 0) {
    lines.push(`  Not applied to this run: ${outcome.fixturesSkipped.join(", ")}`);
  }
  return lines.join("\n");
}

/** What a dry run prints. Deliberately shaped like the real report — same
 *  ordering, same names, same dataset-row rendering — so that comparing "what
 *  would run" with "what ran" is reading, not translation. */
function dryReport(outcome) {
  const lines = [`  Would run ${outcome.plan.length} test(s) on ${outcome.browser}:`];
  for (const p of outcome.plan) {
    const name = p.datasetName ? `${p.testName} [${p.datasetName}]` : p.testName;
    lines.push(`    ${name} (${p.speed})${p.wouldSkip ? ` — SKIPPED: ${p.wouldSkip}` : ""}`);
  }
  lines.push("");
  lines.push(`  ${outcome.parallel} at a time.`);
  if (outcome.missing.length > 0) {
    lines.push(`  Not found: ${outcome.missing.join(", ")}`);
  }
  // A fact, not a refusal — see runSelection. Someone dry-running on a fresh CI
  // container has no browser yet, and that is precisely when they want the
  // answer; but they also want to be told, since the real run will refuse.
  if (!outcome.browserInstalled) {
    lines.push(
      `  ${outcome.browser} is not installed — a real run would stop here. ` +
        `Run: good-looks install ${outcome.browser}`,
    );
  }
  lines.push("  Nothing was run and nothing was recorded.");
  return lines.join("\n");
}

/** The machine-readable form, for `--json`. The same fields the MCP tool
 *  reports, so a pipeline switching between them reads one shape. */
function jsonReport(outcome) {
  return JSON.stringify(
    {
      batchId: outcome.batchId,
      browser: outcome.browser,
      parallel: outcome.parallel,
      ...(outcome.missing.length > 0 ? { missingTestIds: outcome.missing } : {}),
      summary: outcome.summary,
      ...(outcome.fixturesSkipped.length > 0 ? { fixturesSkipped: outcome.fixturesSkipped } : {}),
      results: outcome.results.map((r) => ({
        testId: r.testId,
        testName: r.testName,
        status: r.status,
        durationMs: r.durationMs,
        runId: r.runRecordId,
        ...(r.datasetId ? { datasetId: r.datasetId, datasetName: r.datasetName } : {}),
        ...(r.note ? { note: r.note } : {}),
      })),
    },
    null,
    2,
  );
}

/**
 * `good-looks install <browser>` (R11).
 *
 * The reason a CLI needs its own installer at all: this app keeps its browsers
 * under the user's data directory rather than in Playwright's machine-wide
 * cache, so `npx playwright install` puts an engine somewhere no run looks. The
 * runner owns that path and the spawn; this reports them.
 *
 * @returns {Promise<number>} an exit code from the same contract
 */
export async function installCommand({ browser, withDeps }, { out, err, env = process.env } = {}) {
  let dataDir;
  try {
    dataDir = resolveDataDir(env);
  } catch (error) {
    err(String(error.message ?? error));
    return EXIT.CANNOT_START;
  }

  // No secrets: installing a browser runs no test, so there is nothing to
  // supply and nothing to redact.
  const { isBrowserInstalled, installBrowser } = createRunner({
    dataDir,
    store: createStore(dataDir),
  });

  // Idempotent, and says so. An install step in a pipeline runs on every job,
  // and re-downloading a browser that is already there is minutes per job.
  if (isBrowserInstalled(browser)) {
    out(`${browser} is already installed.`);
    return EXIT.PASSED;
  }

  out(`Installing ${browser}…`);
  // Streamed as it arrives rather than collected: a browser download is the
  // longest thing this binary does, and a minute of silence reads as a hang.
  const result = await installBrowser(browser, { withDeps, onOutput: (s) => out(s.trimEnd()) });

  if (!result.ok) {
    err(
      result.reason === "no-playwright"
        ? "Could not find the bundled @playwright/test to install with."
        : `Installing ${browser} failed${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""}: ${result.reason}`,
    );
    return EXIT.CANNOT_START;
  }

  // Asked again rather than trusting exit 0. `playwright install` can succeed
  // while leaving nothing this app's own detection recognises — a mismatched
  // revision is exactly the bug shared/browser-install.mjs was written for —
  // and reporting success then is how "install it, then it is still not
  // installed" becomes a loop with no error in it.
  if (!isBrowserInstalled(browser)) {
    err(
      `${browser} still is not detected after a successful install.\n` +
        `  It went to ${dataDir}/recorder/browsers, which is where runs look; ` +
        `the revision there may not match the bundled Playwright's.`,
    );
    return EXIT.CANNOT_START;
  }

  out(`${browser} installed.`);
  return EXIT.PASSED;
}

/**
 * Run the selection and report it.
 *
 * `out` and `err` are injected so this is drivable from a test without
 * capturing the process's own streams, and it RETURNS the exit code rather than
 * calling `process.exit` — the entry point owns that, so nothing here can end
 * the process halfway through writing a report.
 *
 * @param {object} options parsed by `cli/args.mjs`
 * @param {{out: (s: string) => void, err: (s: string) => void, env?: object}} io
 * @returns {Promise<number>}
 */
export async function runCommand(options, { out, err, env = process.env } = {}) {
  let dataDir;
  try {
    dataDir = resolveDataDir(env);
  } catch (error) {
    // `resolveDataDir` throws a sentence naming every path it looked in and the
    // override that fixes it — the reader is usually looking at a CI log with
    // no other context, which is the same reason the MCP keeps this message.
    err(String(error.message ?? error));
    return EXIT.CANNOT_START;
  }

  const store = createStore(dataDir);

  // The secrets file, read HERE rather than in the parser or the runner: the
  // parser stays pure and testable, and the runner should be handed values
  // rather than a path it has to trust. A read failure is a refusal, never a
  // silent empty map — running a suite with no credentials because a path was
  // mistyped is the shape of failure R7 exists to end.
  let secretFile = {};
  if (options.secretsFile) {
    try {
      const parsed = JSON.parse(readFileSync(options.secretsFile, "utf-8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        err(`--secrets-file must contain a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}.`);
        return EXIT.CANNOT_START;
      }
      secretFile = parsed;
    } catch (error) {
      // The path and the reason, never the contents — this is a credential
      // file, and an error that quotes what it could not parse is a leak.
      err(`Could not read --secrets-file ${options.secretsFile}: ${error.code ?? "unreadable"}`);
      return EXIT.CANNOT_START;
    }
  }

  const { runSelection } = createRunner({
    dataDir,
    store,
    secretEnv: env,
    secretFile,
    // WHICH ENTRY POINT this is (R6). Until this existed the shared runner wrote
    // `"mcp"` for every caller, so every run of the GitHub Action landed in the
    // app's history as "Started by an MCP client".
    //
    // `cli` rather than `ci`, which is what the plan's note anticipated: this
    // same command is what the documentation tells a developer to try on their
    // laptop first, and recording that as CI would invent evidence for the one
    // filter the value exists to serve. Which MACHINE it ran on is `provenance`
    // below, and that answer comes from the environment rather than from a
    // guess about the entry point.
    trigger: "cli",
    // The environment the CLI was invoked with, not `process.env` — the same
    // one the secrets come from, so a caller that isolates one isolates both.
    provenanceEnv: env,
  });

  const outcome = await runSelection({
    testIds: options.testIds,
    tag: options.tag,
    group: options.group,
    browser: options.browser,
    allDatasets: options.allDatasets,
    parallel: options.parallel,
    // R24. Undefined unless asked for, and `runArgs` omits the flag entirely
    // at 0 — a spec that configures its own retries keeps them either way.
    retries: options.retries,
    speed: options.speed,
    // R5. Already normalized by the parser; `executeTest` runs it through the
    // same gate again because `runSelection` is callable from anywhere in this
    // process and "the caller validated it" is how an unchecked value gets in.
    baseUrl: options.baseUrl,
    // R5's other half: what actually re-points a RECORDED test, since
    // `use.baseURL` resolves relative navigations and a recorded `goto` is
    // absolute. See DECISIONS 2026-08-22, which measured that.
    vars: options.vars,
    dryRun: options.dryRun,
  });

  if (!outcome.ok) {
    err(refusalMessage(outcome));
    return exitCodeFor(outcome);
  }

  if (outcome.dryRun) {
    // JSON.stringify of the plan itself, not a re-shaped copy: a pipeline that
    // reads this is reading what the runner planned.
    out(options.json ? JSON.stringify(outcome, null, 2) : dryReport(outcome));
    return exitCodeFor(outcome);
  }

  out(options.json ? jsonReport(outcome) : humanReport(outcome));

  if (options.junit) {
    try {
      // The values THIS PROCESS resolved, for the tests in this report, through
      // the same `resolveCiSecrets` that supplied them to the runs — R7's rule
      // that whatever feeds a secret to a run also feeds the redaction. Nothing
      // else is readable here: an app run's secrets live in an encrypted store
      // this process cannot open, which is exactly why the report is scoped to
      // runs this invocation produced and is built from their results rather
      // than from run history.
      //
      // Plus what the ENVIRONMENT supplied without any test declaring it. The
      // mailbox token is the one that arrives that way — the `emailCode` step
      // reads `GLAZE_MAILBOX_TOKEN` itself — so it is present on the runner,
      // sent as a bearer, and named by nothing in `test.variables`. A 401 or a
      // timeout inside that step quotes the request, and this report is a file
      // a CI system publishes.
      const byId = new Map(store.listTests().map((t) => [t.id, t]));
      const secretValues = [
        ...new Set([
          ...outcome.results.flatMap((r) => {
            const test = byId.get(r.testId);
            return test ? resolveCiSecrets(test, { env, fileValues: secretFile }).values : [];
          }),
          ...ambientCiSecretValues(env),
        ]),
      ];
      const written = writeJunitReport(options.junit, outcome.results, { secretValues });
      out(`JUnit report: ${written.path} (${written.count} test${written.count === 1 ? "" : "s"})`);
    } catch (error) {
      // Loud, and it does NOT change the exit code. R2's contract is about the
      // RUN — 0 means the tests passed — and overloading it with "and the
      // report wrote" makes the number ambiguous in the one place a pipeline
      // reads it. A CI step that ingests the file fails on its own when it is
      // missing, which is the honest place for that failure to land.
      err(String(error.message ?? error));
    }
  }

  return exitCodeFor(outcome);
}
