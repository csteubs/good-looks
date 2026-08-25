// WHAT GETS WRITTEN BESIDE A SPEC BEFORE IT RUNS, and which of it a CI run gets.
//
// Two questions, one file, because they drifted the moment there were two
// runners. `docs/plans/test-runner-improvements.md` calls fixtures NOT OPTIONAL
// for the CLI: "a CLI that runs fixture-free is a CLI that reports failures the
// app would have healed, and the team's conclusion will be that the CI
// integration is flaky."
//
// ── The bug this exists to end ─────────────────────────────────────────────
// `glaze-runtime.mjs` is not a capability. A generated spec that uses ANY helper
// — `glazeCapture`, `glazeScrollTo`, `glazeA11yGate`, totp — emits
// `import { … } from "./glaze-runtime.mjs"` at the top, so the file is a hard
// DEPENDENCY of the spec. Until now only `playwright-runner.ts` wrote it, which
// means an MCP or CLI run worked exactly when the app happened to have run that
// test on the same machine first, and failed at module load everywhere else —
// most notably on a fresh CI container, where nothing has ever opened the app.
// Nothing reported it as a missing fixture; the spec simply did not load.
//
// ── Why a table rather than a function per fixture ─────────────────────────
// `mcp/playwright-config.mjs` records the shape: two processes writing the same
// path in the same directory, where whichever ran last wins. A list both sides
// iterate cannot disagree about WHICH files exist, which is the half that fails
// silently — a missing file is an import error at run time, not a diff.

import { captureFixtureSource } from "./capture-fixture-source.mjs";
import { GLAZE_RUNTIME_FILE, glazeRuntimeSource } from "./glaze-runtime-source.mjs";
import { HEAL_FIXTURE_FILE, healFixtureSource } from "./heal-fixture-source.mjs";
import { SETTLE_FIXTURE_FILE, settleFixtureSource } from "./settle-fixture-source.mjs";
import {
  SIGNATURE_FIXTURE_FILE,
  signatureFixtureSource,
} from "./signature-fixture-source.mjs";
import { stepReporterSource } from "./step-reporter-source.mjs";
import {
  USER_PAGE_FIXTURE_FILE,
  userPageFixtureSource,
} from "./user-page-fixture-source.mjs";

/** The capture fixture's filename. Spelled here as well as in the runner
 *  because the spec REDIRECT interpolates it, and a second spelling would
 *  redirect an import at a file nobody wrote. */
export const CAPTURE_FIXTURE_FILE = "glaze-capture.mjs";

/** The step reporter's filename, as the Playwright CLI is told to load it. */
export const STEP_REPORTER_FILE = "step-reporter.mjs";

/**
 * Written for EVERY run, whoever starts it.
 *
 * The runtime is here rather than under a gate because a spec importing it has
 * already been generated — the decision was made when the test was recorded, not
 * when it is run, and a runner that "decides" not to write it is a runner that
 * fails to load the spec.
 */
export const ALWAYS_WRITTEN = [
  { file: GLAZE_RUNTIME_FILE, source: glazeRuntimeSource },
  { file: STEP_REPORTER_FILE, source: stepReporterSource },
];

/**
 * Written when any capability needs them. They are written together rather than
 * per capability because the capture fixture IMPORTS the other three: writing
 * `glaze-capture.mjs` without `glaze-settle.mjs` beside it is an import error,
 * not a disabled feature. Whether each one DOES anything is decided by the
 * environment, not by whether the file exists.
 */
export const CAPABILITY_FIXTURES = [
  { file: CAPTURE_FIXTURE_FILE, source: captureFixtureSource },
  { file: HEAL_FIXTURE_FILE, source: healFixtureSource },
  { file: SETTLE_FIXTURE_FILE, source: settleFixtureSource },
  { file: SIGNATURE_FIXTURE_FILE, source: signatureFixtureSource },
  { file: USER_PAGE_FIXTURE_FILE, source: userPageFixtureSource },
];

/**
 * WHAT AN UNATTENDED RUN GETS, decided per capability and in writing — which is
 * what R8 asks for, because "which fixtures are on in CI" is a product decision
 * and not one to infer from whichever branch happened to be easiest.
 *
 * Each entry says what it is, whether an MCP/CLI run turns it on, and why. The
 * `why` is the load-bearing column: two of these are OFF for reasons that will
 * stop being true, and one is off for a reason that will not.
 */
export const CI_FIXTURE_POLICY = [
  {
    capability: "spec runtime",
    onInCi: true,
    why: "Not a capability — a generated spec IMPORTS it. Absent, the spec does not load at all.",
  },
  {
    capability: "step reporter",
    onInCi: true,
    why: "Costs nothing and is what makes per-step progress reportable at all.",
  },
  {
    capability: "screenshots",
    onInCi: "when the test asks",
    why: "Useful as a CI artifact, and the test already carries the preference.",
  },
  {
    capability: "accessibility",
    onInCi: "when the test asks",
    why: "Same: a useful CI artifact, already a per-test choice.",
  },
  {
    capability: "console and network",
    onInCi: "when the test asks",
    why:
      "Recorded, but note the MCP still WITHHOLDS the logs from get_run_logs whenever any " +
      "test in the library declares a secret — this process has no values to redact with.",
  },
  {
    capability: "page settling",
    onInCi: "when the run is at crawl",
    why: "Pure pacing, and it follows the resolved speed like any other run.",
  },
  {
    capability: "Auto-Heal",
    onInCi: false,
    why:
      "The heal fixture does nothing without a heal MAP, and the map holds a probe script per " +
      "step built from the recorder's locator engine — TypeScript the app compiles, which a " +
      "plain-.mjs server cannot import. R8 set the switch anyway and pointed the map at a file " +
      "nothing writes, so every unattended run installed healing and healed nothing (R49). Off " +
      "is the honest state, and the run says so. R51 LANDED, so the map is now buildable here and " +
      "turning this on is the next change rather than a blocked one; the WRITEBACK stays off " +
      "regardless — that would " +
      "edit a tests.json which dies with the container, so the fix would be lost and the run " +
      "would still report a heal it did not keep.",
  },
  {
    capability: "user stylesheet / init script",
    onInCi: true,
    why: "Plain settings with no secret in them, and a page that renders differently without them.",
  },
  {
    capability: "signature headers",
    onInCi: false,
    why:
      "The header VALUES are encrypted to the app and unreadable here, so the run says it went " +
      "unsigned. R7 SHIPPED (#260) and did not reach this: it gave test SECRETS an environment " +
      "contract, not signature headers. Extending the same contract to header values is the " +
      "remaining work — until then this stays off, which is a constraint and not a preference.",
  },
  {
    capability: "overlay dismissal",
    onInCi: false,
    why:
      "Its source embeds the recorder's locator engine, which lives in shared/locator-engine.mjs " +
      "as of R51 — so this is no longer blocked, it is unbuilt. dismiss-fixture-source.ts is " +
      "still main/-side TypeScript and has to be reachable from this process before a run can " +
      "install the watcher. Same next change as Auto-Heal above.",
  },
];

/**
 * Redirect a spec's `@playwright/test` import onto the capture fixture.
 *
 * Only the module specifier changes, so LINE NUMBERS are preserved — the step
 * line map and every screenshot's step attribution are built from them.
 *
 * Returns null when there is nothing to redirect, which is the honest answer for
 * an imported spec that reaches Playwright some other way: running the original
 * unmodified is right, and pretending otherwise would rewrite someone else's
 * project.
 */
export function redirectToCaptureFixture(source) {
  const redirected = source.replace(
    /from\s+["']@playwright\/test["']/,
    `from "./${CAPTURE_FIXTURE_FILE}"`,
  );
  return redirected === source ? null : redirected;
}
