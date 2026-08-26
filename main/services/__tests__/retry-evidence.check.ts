// One attempt's evidence must survive the next one (R24a).
//
//   npm run check:retry-evidence
//
// ── What breaks, and why nothing else notices ──────────────────────────────
// Playwright re-runs a failed test from the top. The capture fixture is a
// `page` fixture, so every attempt re-enters it with its step counter back at
// 0 — and it wrote into one fixed directory. Attempt 2's screenshots,
// manifest, console and network went straight over attempt 1's, and the run's
// scratch dir (holding both attempts' traces) was deleted at run end. The
// attempt destroyed is always the one that FAILED, because a retry only
// happens after a failure.
//
// The whole suite stays green through that. The run passes, the record says
// passed, the manifest parses, and the screenshots are of a page that worked.
// The only thing wrong is that the evidence of the failure is gone, and there
// is nothing to compare against to notice.
//
// ── Why a check rather than only unit tests ────────────────────────────────
// The writers do not meet anywhere a unit test can reach them. The capture
// fixture only exists as a string written next to the specs and loaded inside
// a Playwright worker; the reporter is a second such string; the runner is
// compiled app code that imports `@shell/backend`. This file executes the two
// strings for real and reads the third, which is the most that can be checked
// on a laptop in a second.
//
// The end-to-end proof — two attempts actually leaving two sets of files —
// is `e2e/retry-evidence.spec.ts`, which needs a browser and is not part of
// the local gate.

import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { resolve } from "node:path";

import {
  attemptArtifactDir,
  attemptDirName,
  parseAttemptDirName,
} from "../../../shared/attempt-artifacts.mjs";
import { retryFields } from "../../../shared/run-attempts.mjs";
import { splitStepMarkers, STEP_MARKER } from "../../../shared/step-marker.mjs";
import { captureFixtureSource } from "../../../shared/capture-fixture-source.mjs";
import { stepReporterSource } from "../../../shared/step-reporter-source.mjs";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    console.error(`FAIL ${label}`);
    failures++;
  }
}

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
const runner = read("main/services/playwright-runner.ts");
const reporterTs = read("main/services/step-reporter.ts");
const mcpRunner = read("mcp/run-tests.mjs");
const cliRun = read("cli/run.mjs");
const cliArgs = read("cli/args.mjs");
const runPlan = read("mcp/run-plan.mjs");

// ── 1. The fixture resolves a different directory per attempt ──────────────
//
// Executed from the SHIPPED STRING, not re-implemented. A test that
// re-implemented this would verify something that never runs — the fixture is
// written to disk at run time and loaded by Playwright's own transform.
{
  // `attemptArtifactDir` in the fixture closes over `DIR` and `path`, so it is
  // compiled with both supplied — the same shape Playwright's module scope
  // gives it.
  const start = captureFixtureSource.indexOf("const ATTEMPT_DIR_PREFIX =");
  const end = captureFixtureSource.indexOf("\n}\n", captureFixtureSource.indexOf("function attemptArtifactDir("));
  assert(start > -1 && end > start, "fixture: found its attempt-directory code");

  const body = captureFixtureSource.slice(start, end + 2);
  const compile = (dir: string) =>
    new Function(
      "path",
      "DIR",
      `${body}\nreturn attemptArtifactDir;`,
    )(nodePath, dir) as (attempt: number) => string;

  const fixtureDir = compile("/artifacts/t1/r1");

  assert(
    fixtureDir(0) === "/artifacts/t1/r1",
    "fixture: attempt 0 keeps the run directory every existing reader points at",
  );
  assert(
    fixtureDir(1) !== fixtureDir(0) && fixtureDir(2) !== fixtureDir(1),
    "fixture: each later attempt gets a directory of its own",
  );
  // The property that matters, stated as itself: no two attempts collide.
  const dirs = [0, 1, 2, 3].map(fixtureDir);
  assert(new Set(dirs).size === dirs.length, "fixture: no two attempts write to one directory");

  // And the fixture's spelling is the APP's. This is the join that cannot be
  // checked any other way: the fixture writes these directories from inside a
  // worker and the app reads them from compiled TypeScript, so a drift is not
  // a wrong path — it is the app reading an empty directory and reporting that
  // the run captured nothing.
  assert(
    [0, 1, 2, 7].every((n) => fixtureDir(n) === attemptArtifactDir("/artifacts/t1/r1", n)),
    "fixture: …and resolves the same directory the app does, for every attempt",
  );
  assert(
    [1, 2, 7].every((n) => parseAttemptDirName(attemptDirName(n)) === n),
    "shared: an attempt directory reads back as the attempt that wrote it",
  );
}

// ── 2. The fixture writes this run's files into THAT directory ─────────────
//
// Resolving the right directory buys nothing if the manifest still goes to the
// fixed one. Each of these was a `path.join(DIR, …)` before R24a.
{
  for (const file of ["manifest.json", "console.json", "network.json"]) {
    assert(
      captureFixtureSource.includes(`path.join(ctx.dir, "${file}")`),
      `fixture: writes ${file} into this attempt's directory`,
    );
    assert(
      !captureFixtureSource.includes(`path.join(DIR, "${file}")`),
      `fixture: …and no longer into the fixed one`,
    );
  }
  // Screenshots were already relative to ctx.dir; what changed is what ctx.dir
  // IS. Stated so a change that re-pins it to DIR fails here.
  assert(
    /ctx = \{ dir: attemptDir,/.test(captureFixtureSource),
    "fixture: the capture context is rooted at this attempt's directory",
  );
  assert(
    /attemptNo = normalizeAttempt\(testInfo\.retry\)/.test(captureFixtureSource),
    "fixture: reads the attempt from testInfo.retry, per test",
  );
}

// ── 3. Both reporter copies report which attempt ran ───────────────────────
//
// `result` was present and underscore-prefixed in both — the parameter was
// there the whole time and simply unread. Executed rather than grepped: the
// shipped string is the one that runs, and "the fix landed in the copy nobody
// executes" is a real way for this to come back.
{
  const emitted: unknown[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const capture = (chunk: string | Uint8Array): boolean => {
    const text = String(chunk);
    if (text.startsWith(STEP_MARKER)) {
      emitted.push(JSON.parse(text.slice(STEP_MARKER.length)));
      return true;
    }
    return realWrite(chunk as string);
  };

  const step = { category: "pw:api", title: "click", location: { file: "/s.spec.ts", line: 7 }, error: undefined, duration: 3 };
  const test = { location: { file: "/s.spec.ts" } };

  const drive = (Reporter: new () => { onStepBegin: Function; onStepEnd: Function }): unknown[] => {
    emitted.length = 0;
    const r = new Reporter();
    // Swapped rather than mocked: the shipped reporter writes to the real
    // process.stdout, which is the only channel it has.
    (process.stdout as unknown as { write: unknown }).write = capture;
    try {
      r.onStepBegin(test, { retry: 2 }, step);
      r.onStepEnd(test, { retry: 2 }, step);
    } finally {
      (process.stdout as unknown as { write: unknown }).write = realWrite;
    }
    return [...emitted];
  };

  const shipped = new Function(
    stepReporterSource.replace(/export default StepReporter;\s*$/, "return StepReporter;"),
  )() as new () => { onStepBegin: Function; onStepEnd: Function };
  const shippedPayloads = drive(shipped);

  assert(shippedPayloads.length === 2, "reporter: the shipped string reports a begin and an end");
  assert(
    shippedPayloads.every((p) => (p as { attempt?: unknown }).attempt === 2),
    "reporter: …and both carry the attempt Playwright reported",
  );

  // The typed reference, which nothing executes at run time but everything
  // reads. It is imported rather than compiled from source because it is real
  // TypeScript; the two are kept in step by hand, which is exactly why this
  // compares their OUTPUT rather than their text.
  assert(
    /onStepBegin\(test: TestCase, result: TestResult/.test(reporterTs) &&
      /attempt: result\.retry/.test(reporterTs),
    "reporter: the typed reference reads result.retry too",
  );
  assert(
    !/_result/.test(reporterTs) && !/_result/.test(stepReporterSource),
    "reporter: neither copy still discards the result parameter",
  );
}

// ── 4. The attempt survives the stream ─────────────────────────────────────
//
// The marker travels on the same stdout as Playwright's own output. Carrying
// the field is worth nothing if the parser drops it.
{
  const line = (payload: Record<string, unknown>) =>
    STEP_MARKER + JSON.stringify(payload) + "\n";
  const { markers } = splitStepMarkers(
    "",
    line({ event: "end", line: 4, ok: false, attempt: 0 }) +
      line({ event: "end", line: 4, ok: true, attempt: 1 }),
  );
  assert(markers.length === 2, "stream: both attempts' transitions come through");
  assert(
    markers[0]?.attempt === 0 && markers[1]?.attempt === 1,
    "stream: …and each keeps the attempt it was reported under",
  );
  const legacy = splitStepMarkers("", line({ event: "begin", line: 1 }));
  assert(
    legacy.markers.length === 1 && legacy.markers[0].attempt === 0,
    "stream: a marker with no attempt is attempt 0, not a dropped step",
  );
}

// ── 5. The runner keeps the attempts apart ─────────────────────────────────
//
// Source-level: `playwright-runner.ts` imports `@shell/backend`, so this check
// cannot execute it. The behaviour is covered by the unit tests around
// findTraceZips; what is pinned here is the shape those depend on.
{
  assert(
    /const stepStatusMaps = new Map<string, AttemptStatuses>\(\);/.test(runner),
    "runner: per-step outcomes are keyed by attempt, not flat",
  );
  assert(
    /emitStep\(runId, stepIndex, marker\.event, marker\.ok, marker\.line, marker\.attempt\)/.test(runner),
    "runner: …and the marker's attempt is what keys them",
  );
  assert(
    /const statuses = byAttempt\.get\(0\) \?\? \{\};/.test(runner),
    "runner: the replay is built from attempt 0 — the attempt that failed",
  );

  // The trace gate. `retain-on-failure` keeps a trace for each FAILED attempt,
  // and a run that passes on retry exits 0 — so gating on the exit code
  // deleted the failing attempt's trace with the scratch dir, every time.
  assert(
    !/if \(!outputDir \|\| exitCode === 0\) return false;/.test(runner),
    "runner: the trace gate is no longer the exit code",
  );
  assert(
    /if \(!outputDir \|\| !anyAttemptFailed\) return false;/.test(runner),
    "runner: …it is whether any attempt failed",
  );
  assert(
    /findTraceZips\(outputDir\)/.test(runner),
    "runner: salvages every attempt's trace, not the first one the walk finds",
  );
}

// ── 6. The RECORD says a run retried (R24) ─────────────────────────────────
//
// R24a made the evidence survive a retry. This is the other half: a run that
// recovered has to SAY so, or `docs/ROUTINES.md`'s refusal stands — "a retry
// stacked on top makes a flaky test look stable, which is precisely the signal
// the Stability panel exists to give".
{
  // Both runners derive the attempt from the marker stream rather than from
  // Playwright's summary line, and both stamp it through the same module. Two
  // spellings of "did this run retry" is a board that disagrees with a digest.
  for (const [name, src] of [
    ["app", runner],
    ["unattended", mcpRunner],
  ] as const) {
    assert(
      /retryFields\(\{ status[^}]*maxAttempt \}\)/.test(src),
      `${name} runner: stamps the retry fields through shared/run-attempts.mjs`,
    );
  }
  assert(
    /const maxAttempt = byAttempt\.size > 0 \? Math\.max\(\.\.\.byAttempt\.keys\(\)\) : 0;/.test(runner),
    "app runner: reads the attempt off the attempt-keyed status map R24a built",
  );
  assert(
    /if \(marker\.attempt > maxAttempt\) maxAttempt = marker\.attempt;/.test(mcpRunner),
    "unattended runner: reads it off the marker stream, not Playwright's summary line",
  );

  // Executed, not grepped: the rule itself.
  assert(
    Object.keys(retryFields({ status: "passed", maxAttempt: 0 })).length === 0,
    "a run that never retried writes NEITHER field — 0 would be indistinguishable from absent",
  );
  assert(
    retryFields({ status: "passed", maxAttempt: 1 }).passedOnRetry === true,
    "…a run that failed and then passed is marked as such",
  );
  assert(
    retryFields({ status: "failed", maxAttempt: 2 }).passedOnRetry === undefined,
    "…and a run that retried and STILL failed is not called a recovery",
  );
}

// ── 7. `--retries` actually reaches Playwright ─────────────────────────────
//
// Four hops between the flag and the process, and every one of them is a name
// that can be misspelt into silence. The failure mode is a CLI that accepts
// `--retries 2`, runs each test once, and reports the intermittent as a real
// failure — which is exactly what the caller asked it not to do.
{
  assert(/"--retries",/.test(cliArgs), "args: --retries is a value flag, so it consumes its number");
  assert(/retries: options\.retries,/.test(cliRun), "run: the parsed value is handed to runSelection");
  assert(
    /^\s*retries,$/m.test(mcpRunner),
    "runner: runSelection and executeTest both destructure it",
  );
  assert(
    /\.\.\.\(retries > 0 \? \[`--retries=\$\{retries\}`\] : \[\]\)/.test(runPlan),
    "runArgs: emits the flag only when asked, so a spec's own retries survive",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll retry-evidence checks passed.");
