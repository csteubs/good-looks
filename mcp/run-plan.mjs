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

import { armedRulesFor } from "../shared/overlay-rules.mjs";
import { normalizeSignatureHost, signatureState } from "../shared/shopify-signature.mjs";
import { manualProxyFor, playwrightProxyEnv, proxySettingsFrom } from "../shared/proxy-config.mjs";
import { slowMoFor } from "../shared/run-pacing.mjs";
import { stripAnsi } from "../shared/strip-ansi.mjs";
// The SAME redaction the app applies — R7 requires that whatever supplies a
// secret to a run also feeds the redaction, and two spellings of it is a
// second chance to get the longest-first rule wrong.
import { redact } from "../shared/secret-redaction.mjs";

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

/**
 * The host this test would present a Shopify crawler signature at, or null.
 *
 * Exact host match and an expiry re-check, both delegated to the shared module
 * — the app decides where a signature may be sent, and a second opinion here
 * would be a second rule to keep in step.
 */
export function signatureHostFor(test, signatures = [], nowMs = Date.now()) {
  const host = normalizeSignatureHost(test?.url || test?.baseUrl || "");
  if (!host || !Array.isArray(signatures)) return null;
  const entry = signatures.find((s) => s?.host === host);
  if (!entry) return null;
  // An expired signature would not have been sent by the app either, so
  // reporting it as something this run missed would be false.
  return signatureState({ expiresAt: entry.expiresAt, nowMs }) === "expired" ? null : host;
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
export function runEnv({
  base,
  browsersPath,
  nodeModules,
  speed,
  testTimeoutMs,
  outputDir,
  vars,
  baseUrl,
  settings,
}) {
  return {
    ...base,
    PLAYWRIGHT_BROWSERS_PATH: browsersPath,
    NODE_PATH: nodeModules,
    PW_SLOWMO_MS: String(slowMoFor(speed)),
    PW_TEST_TIMEOUT_MS: String(testTimeoutMs),
    // Playwright derives its scratch directory from the SPEC's path by default,
    // so two concurrent runs of one spec would write to — and clean — the same
    // folder mid-flight. run_batch runs several tests at once, so each run
    // names its own.
    ...(outputDir ? { PW_OUTPUT_DIR: outputDir } : {}),
    // What an IMPORTED spec's relative navigations resolve against, carried on
    // its own record. Recorded tests navigate absolutely and have none.
    //
    // Set here as well as in the app because the two write the SAME config file
    // and it reads `PW_BASE_URL` — an MCP-driven run of an imported test would
    // otherwise fail on its first `goto` while the identical run from the app
    // passed, which is exactly the app/MCP drift check:mcp-parity exists for.
    ...(baseUrl ? { PW_BASE_URL: baseUrl } : {}),
    ...(vars && Object.keys(vars).length > 0 ? { GLAZE_VARS: JSON.stringify(vars) } : {}),
    // Settings → Proxy, when it covers test traffic — the SAME shared rule the
    // app's runner applies, which is what keeps a run's network path identical
    // whichever process spawned it. The password argument is null and always
    // will be: it is encrypted to the app (the secrets argument again), so a
    // run through an authenticating proxy goes without credentials and
    // describeRun says so up front rather than letting the 407 speak for it.
    ...(settings ? playwrightProxyEnv(proxySettingsFrom(settings), null) : {}),
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
export function sanitizeOutput(output, secrets = []) {
  // REDACTION FIRST, then the escape stripping. A credential split across an
  // ANSI colour boundary would survive a redaction that ran after stripping
  // only if the escape sat inside the value, which it cannot — but running it
  // first also means a value is gone before anything downstream can hold a
  // partially-processed copy, and ordering a security step last is how one
  // eventually gets skipped.
  //
  // `secrets` defaults to none, so every caller predating R7 behaves exactly as
  // it did. What must never happen is a caller that SUPPLIES a secret to a run
  // and then omits it here: the value is typed into the page, so it comes back
  // out in a Playwright error, an assertion diff or a content dump, and this is
  // the single choke point everything written or returned passes through.
  // `check:ci-secrets` pins that the two travel together.
  return stripAnsi(redact(output, secrets));
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
export function describeRun(
  test,
  settings = {},
  {
    speed,
    timeoutMs,
    timeoutRaised,
    signatures = [],
    overlayRules = [],
    nowMs = Date.now(),
    // WHICH capabilities this run actually got (R8). Absent means none, which
    // is what every caller predating the fixture work meant and still means —
    // so an old caller keeps reporting exactly what it reported before, and
    // only a runner that DOES write the fixtures says so.
    //
    // Passed in rather than inferred: whether a fixture fired is a fact about
    // the run that just happened, and a second derivation here could disagree
    // with the run — the failure `executeTest` returning its own `speed` was
    // added to prevent, one field over.
    ran = {},
  } = {},
) {
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
  if (wants.screenshots && !ran.screenshots) {
    skipped.push(
      "Screenshot capture — this run took none, so it does not appear in the Visual tab, " +
        "seeds no baseline and diffs against none.",
    );
  }
  if (wants.accessibility && !ran.accessibility) skipped.push("Accessibility checks — axe was not injected.");
  if (wants.consoleAndNetwork && !ran.consoleAndNetwork) {
    skipped.push("Console and network recording — no console.json or network.json was written.");
  }
  if (wants.autoHeal && !ran.autoHeal) {
    skipped.push(
      "Run-time Auto-Heal — a step whose locator has gone stale fails here rather than being " +
        "healed past, so this run can fail where an app run of the same test passes.",
    );
  }
  if (wants.pageSettling && !ran.pageSettling) {
    skipped.push(
      "Crawl page-settling — the slower step delay applied, but no waiting for load, network " +
        "quiet and paint after each action.",
    );
  }
  // Standing overlay rules. Named only when one actually applies to this
  // test's host — a blanket "overlay rules do not run here" on every run of
  // every test is the kind of caveat people learn to skip past, and then miss
  // the one time it matters.
  const armedHere = armedRulesFor(overlayRules, test?.url ?? "");
  if (armedHere.length > 0) {
    const named = armedHere.map((r) => r.label || r.host).join(", ");
    skipped.push(
      `Overlay rules (${named}) — this server writes no fixtures, so the banner they dismiss ` +
        "is left on the page here. A step that acts on something the banner covers can fail " +
        "in this run and pass in an app run of the same test.",
    );
  }
  const secrets = secretVariableNames(test);
  if (secrets.length > 0) {
    skipped.push(
      `Secret variables (${secrets.join(", ")}) — their values are encrypted to the app and ` +
        "unreadable from here, so the spec resolved them to empty strings.",
    );
  }
  // The same shape as the secrets note above, and for the same reason: this
  // server has no Electron and therefore no safeStorage, so it cannot read the
  // signature's value however much it would like to. What it CAN read is the
  // plaintext register beside it, which is the whole reason that file exists —
  // without it "no signature configured" and "one is configured and I can't
  // read it" are the same silence.
  const signedHost = signatureHostFor(test, signatures, nowMs);
  if (signedHost) {
    skipped.push(
      `The Shopify crawler signature (${signedHost}) — its value is encrypted to the app and ` +
        "unreadable from here, so this run was made unsigned. The store may throttle or block it, " +
        "which means a failure here can be a pass from the app. Run it from the app.",
    );
  }
  // The same shape a fourth time. The proxy itself DID apply (runEnv hands the
  // shared rule's PW_PROXY_* through), but its password is encrypted to the
  // app — so a proxy that authenticates will refuse this run at the tunnel.
  // Going through the proxy without credentials is deliberate: going direct
  // instead could SUCCEED on an open network, and a run that quietly took a
  // network path the settings forbid is this file's least favourite failure.
  const testProxy = manualProxyFor(proxySettingsFrom(settings), "test");
  if (testProxy && testProxy.username) {
    skipped.push(
      `Proxy credentials (${testProxy.url}) — the proxy password is encrypted to the app and ` +
        "unreadable from here, so this run went through the proxy unauthenticated. A proxy that " +
        "requires the login will refuse the run; run it from the app.",
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
