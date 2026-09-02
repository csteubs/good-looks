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
import {
  DISMISS_FIXTURE_FILE,
  dismissFixtureSource,
} from "./dismiss-fixture-source.mjs";
import { GLAZE_RUNTIME_FILE, glazeRuntimeSource } from "./glaze-runtime-source.mjs";
import { HEAL_FIXTURE_FILE, healFixtureSource } from "./heal-fixture-source.mjs";
import { SETTLE_FIXTURE_FILE, settleFixtureSource } from "./settle-fixture-source.mjs";
import {
  SIGNATURE_FIXTURE_FILE,
  signatureFixtureSource,
} from "./signature-fixture-source.mjs";
import { stepReporterSource } from "./step-reporter-source.mjs";
import { TABS_FIXTURE_FILE, tabsFixtureSource } from "./tabs-fixture-source.mjs";
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
  // The FIFTH, and it was missing. `glaze-capture.mjs` imports this one exactly
  // as unconditionally as the other four, so an unattended run that wrote the
  // set without it wrote a capture fixture whose imports could not resolve —
  // the spec did not load, and Playwright reported "no tests found" rather than
  // a missing file. It worked on a machine where the app had run, because the
  // app writes it; it failed on every fresh CI container. That is the R8 failure
  // this table was created to end, arriving inside the table.
  //
  // It could not be here before R51: this module is imported by the MCP, and
  // the dismissal fixture embeds the recorder's locator engine, which was
  // compiled TypeScript until then. `check:ci-fixtures` now derives the list
  // from the capture fixture's own imports rather than transcribing it.
  { file: DISMISS_FIXTURE_FILE, source: dismissFixtureSource },
  // The SIXTH: tab following. Imported by the capture fixture exactly as
  // unconditionally as the others, so it ships with them for the same reason.
  { file: TABS_FIXTURE_FILE, source: tabsFixtureSource },
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
    why:
      "Costs nothing, and it is what lets a run say WHICH STEP failed. Written since R8 and " +
      "LOADED since 2026-08-26 — `runArgs` passed no `--reporter`, so no marker was ever " +
      "emitted and this row described the app rather than this path. Written-but-unwired is R49's " +
      "shape without the switch: everything present, nothing connected, no error anywhere. The " +
      "run records the failing step as an INDEX, not a label — the reporter reports a line and " +
      "carries no title, and `describeStep` is app-side.",
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
    onInCi: "suggest only",
    why:
      "Run-time healing is ON, and it is on for the first time: R8 set the switch and pointed " +
      "the map at a file nothing writes, so every unattended run installed healing and healed " +
      "nothing (R49). The map is what the fixture needs — it rethrows untouched for a key it " +
      "cannot find — and it holds a probe per step built from the recorder's locator engine, " +
      "which R51 put in shared/ where this process can reach it. Without healing a run fails on " +
      "a stale locator the app would have healed past, the false red that makes a team distrust " +
      "CI. The WRITEBACK is not on and cannot be: it would edit a tests.json which dies with the " +
      "container, so the fix would be lost and the run would still report a heal it did not keep.",
  },
  {
    capability: "tab following",
    onInCi: true,
    why:
      "A recorded journey is linear — the trainer forces every navigation into its one " +
      "window — so a run has to follow the newest tab or a click that opens one strands every " +
      "later step on the opener. Nothing to configure and no secret in it; the only gate is " +
      "`!imported`, because an imported spec that manages its own popups means `page` as the " +
      "opener from then on.",
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
    onInCi: "when the test's Handle pop-ups option is on (the default)",
    why:
      "ON as of R51 + this change, gated since Handle pop-ups shipped. The host's taught rules " +
      "and the built-in Klaviyo/DataGrail handlers are armed through the same " +
      "`armedPopupRulesFor` the app and the trainer call, and the gate is the test's own " +
      "`handlePopups` field with `defaultHandlePopups` underneath — so a test that keeps its " +
      "pop-up in the app keeps it here too. The fixture itself is written on EVERY capability run " +
      "whether or not a rule fires, because the capture fixture imports it unconditionally: it is " +
      "a dependency, not a capability, and leaving it out was breaking the load.",
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
