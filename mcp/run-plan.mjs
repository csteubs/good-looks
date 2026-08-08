// What an MCP-driven run is made of: the environment it hands the Playwright
// child, the CLI arguments it invokes, and an honest account of what it did not
// do.
//
// Pure — no filesystem, no process, no spawn — and kept out of server.mjs for
// the same reason select-tests.mjs is: importing server.mjs starts an MCP
// server on stdio, so anything left inline there can only ever be checked by
// scraping the file as text. Everything here is exercised for real by
// `npm run check:mcp-parity`.
//
// THE DRIFT THIS EXISTS TO STOP. This server spawns Playwright itself rather
// than going through main/services/playwright-runner.ts, and by 2026-08-07 the
// two had silently diverged in four ways: no variables or secrets in the env,
// no per-test timeout, no capture fixture, and no ANSI stripping on the log it
// writes. Every one of them failed quietly — the run executed, passed or
// failed, and said nothing about what it had skipped.

import { slowMoFor } from "../shared/run-pacing.mjs";
import { stripAnsi } from "../shared/strip-ansi.mjs";

/**
 * Names of the secret variables a test declares.
 *
 * A secret's VALUE lives in `test-secrets.bin`, encrypted through the native
 * runtime's storage backend, and only the app process can decrypt it — this
 * server has no bridge to that API and never will. So MCP runs cannot supply
 * secrets, and this is what lets a run say so up front instead of finding out
 * at the login form.
 *
 * Before this existed the run went ahead anyway. The generated spec resolves a
 * secret as `process.env.GLAZE_SECRET_<NAME> ?? ""`, so the test typed EMPTY
 * STRINGS into the form and failed on an assertion further down, with nothing
 * in the output connecting that to a missing credential.
 */
export function secretVariableNames(test) {
  return (test?.variables ?? []).filter((v) => v?.kind === "secret").map((v) => v.name);
}

/** The dataset row `datasetId` names, or null. */
export function datasetRow(test, datasetId) {
  if (!datasetId) return null;
  return (test?.datasets ?? []).find((d) => d?.id === datasetId) ?? null;
}

/**
 * Why a run's recorded console + network must not be served from here, or null
 * when they may be.
 *
 * THE LEAK THIS CLOSES. console.json and network.json are stored RAW; the app
 * redacts secret values on the way out (artifact-store.readLogs), because a
 * test that logs in can put a credential in a request header or a query string.
 * Redaction needs the secret values, and those are encrypted to the app — so
 * this process cannot redact, and serving these files would hand out exactly
 * what the app is careful to strip.
 *
 * Keyed on the WHOLE library, not on the run's own test, for the same reason
 * the app's redaction snapshot holds every secret it knows: any run's log can
 * contain any test's secret. That makes this deliberately strict — one secret
 * anywhere disables the tool — and strict is the correct direction for a rule
 * whose failure mode is silent disclosure.
 */
export function consoleNetworkWithheldReason(tests) {
  const withSecrets = (tests ?? []).filter((t) => secretVariableNames(t).length > 0);
  if (withSecrets.length === 0) return null;
  const n = withSecrets.length;
  return (
    "Console and network recordings are withheld here. They are stored raw and the app redacts " +
    "secret values when it reads them, which this server cannot do — secret values are " +
    `encrypted to the app. ${n} test${n === 1 ? "" : "s"} in this library ` +
    `declare${n === 1 ? "s" : ""} a secret variable, and a recorded request header or URL can ` +
    "carry one. Read these from the app's Visual tab, which redacts on the way out."
  );
}

/**
 * The environment for one run's Playwright child process.
 *
 * `GLAZE_VARS` is the single channel for variable values, spread by the
 * generated spec over the defaults it declares — the same one the app uses, and
 * what makes one spec runnable once per dataset row without regenerating the
 * file. Set only when there are values: an empty blob would still be parsed and
 * spread, which is harmless but reads in a process listing as if a sweep were
 * running.
 *
 * There is deliberately NO `GLAZE_SECRET_*` key here, and there cannot be one —
 * see secretVariableNames. check:mcp-parity pins that absence against the
 * generator, so a future edit that starts injecting secrets has to confront the
 * redaction question rather than quietly creating a plaintext-credentials path
 * in a file `get_run_log` serves back.
 */
export function runEnv({ base, browsersPath, nodeModules, speed, testTimeoutMs, vars }) {
  return {
    ...base,
    PLAYWRIGHT_BROWSERS_PATH: browsersPath,
    NODE_PATH: nodeModules,
    PW_SLOWMO_MS: String(slowMoFor(speed)),
    PW_TEST_TIMEOUT_MS: String(testTimeoutMs),
    ...(vars && Object.keys(vars).length > 0 ? { GLAZE_VARS: JSON.stringify(vars) } : {}),
  };
}

/** The Playwright CLI arguments for one run. `--timeout` is authoritative: it
 *  wins over whatever the config declares, matching the app. The env var above
 *  carries the same number for a config-only run. */
export function runArgs({ cliPath, specFile, configPath, browser, testTimeoutMs }) {
  return [
    cliPath,
    "test",
    specFile,
    "--config",
    configPath,
    `--browser=${browser}`,
    `--timeout=${testTimeoutMs}`,
  ];
}

/** Everything written to the log file or returned to the caller passes through
 *  here — one choke point, mirroring the app's `emitOutput`. Playwright's
 *  `line` reporter redraws with cursor-up + erase-line and colours failures;
 *  those bytes are meaningless outside a terminal, and this log is read back by
 *  `get_run_log` straight into an agent's context, where they are budget spent
 *  on cursor movements. */
export function sanitizeOutput(output) {
  return stripAnsi(output);
}

/**
 * What a run did — and, the part that matters, what an app run of the SAME test
 * would have done that this one did not.
 *
 * Everything below the pacing line reaches a run through a Playwright fixture,
 * and a fixture reaches a run by REDIRECTING the spec's `@playwright/test`
 * import to a module the app writes beside the spec. This server runs the spec
 * as it sits on disk, so none of those fixtures load. That is invisible in a
 * Playwright run's output: the test executes normally and passes or fails on
 * its own merits, having quietly skipped every one of them.
 *
 * Reported against what the TEST asks for, not as a flat feature list. A test
 * that never wanted screenshots does not need to be told it got none; a test
 * with "Capture screenshots" switched on very much does, because its runs are
 * the ones that silently stopped appearing in the Visual tab.
 */
export function describeRun(test, settings = {}, { speed, timeoutMs, timeoutRaised } = {}) {
  const wants = {
    screenshots: test?.captureArtifacts ?? settings.defaultCaptureArtifacts ?? false,
    accessibility: test?.a11yChecks ?? settings.defaultA11yChecks ?? false,
    consoleAndNetwork: test?.recordLogs ?? settings.defaultRecordLogs ?? false,
    // Gated on a locator existing, exactly as the app gates it — a test with
    // nothing to heal is not being deprived of anything.
    autoHeal: (settings.autoHealEnabled ?? false) && (test?.steps ?? []).some((s) => s?.locator),
    pageSettling: speed === "crawl",
  };
  const skipped = [];
  if (wants.screenshots) {
    skipped.push(
      "Screenshot capture — this run took none, so it does not appear in the Visual tab, " +
        "seeds no baseline and diffs against none.",
    );
  }
  if (wants.accessibility) skipped.push("Accessibility checks — axe was not injected.");
  if (wants.consoleAndNetwork) {
    skipped.push("Console and network recording — no console.json or network.json was written.");
  }
  if (wants.autoHeal) {
    skipped.push(
      "Run-time Auto-Heal — a step whose locator has gone stale fails here rather than being " +
        "healed past, so this run can fail where an app run of the same test passes.",
    );
  }
  if (wants.pageSettling) {
    skipped.push(
      "Crawl page-settling — the slower step delay applied, but no waiting for load, network " +
        "quiet and paint after each action.",
    );
  }
  const secrets = secretVariableNames(test);
  if (secrets.length > 0) {
    skipped.push(
      `Secret variables (${secrets.join(", ")}) — their values are encrypted to the app and ` +
        "unreadable from here, so the spec resolved them to empty strings.",
    );
  }
  return {
    speed,
    stepDelayMs: slowMoFor(speed),
    testTimeoutMs: timeoutMs,
    ...(timeoutRaised
      ? {
          timeoutNote:
            "Raised to the crawl floor — crawl runs take far longer than the configured limit allows.",
        }
      : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}
