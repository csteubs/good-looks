// The shipped defaults for how a run goes, and the wiring that makes them
// reachable (R18).
//
// WHY THESE ARE CHECKS. Every one of them is invisible when broken. Re-seeding
// a recording's `speed` doesn't fail anything — it just pins each new test to
// the default of the day it was recorded, so a user who later changes the
// setting finds their library unmoved and no error anywhere. Pointing a batch
// row back at `defaultRunHeadless` doesn't fail anything either — it just opens
// sixty windows. And resolving the pace by hand at the call site is how an
// unrecognised speed reaches `SLOW_MO_MS` as a key it does not have, which runs
// the test at FULL SPEED: the opposite of what the caller asked for, silently.
//
// The decisions themselves are pure functions with their own unit tests
// (`main/services/run-pacing.test.ts`). What source can say, and only source
// can say, is that the app still calls them.
//
// Run with: npm run check:run-defaults

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

let failures = 0;
function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** Source with line comments stripped, so a rule never matches its own
 *  explanation — the trap `check:emit-redaction` went red on. */
function code(rel: string): string {
  return readFileSync(join(root, rel), "utf8")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

// ── A recording inherits its speed rather than pinning it ────────────────
{
  const recorder = code("main/services/recorder-service.ts");
  assert(
    !/\bspeed:\s*recorderSettingsStore\.get\(\)\.defaultRunSpeed/.test(recorder),
    "a new recording does not stamp the default speed onto the record — absent means inherit",
  );
  // The sibling seeds are still there, because they are NOT the same case: a
  // capture preference and an engine are choices about this test, while the
  // speed was being copied out of a setting the user can change later.
  assert(
    /captureArtifacts:\s*recorderSettingsStore\.get\(\)\.defaultCaptureArtifacts/.test(recorder),
    "…while the capture preference is still seeded, which was never the complaint",
  );
}

// ── The runner resolves the pace through the shared rule ─────────────────
{
  const runner = code("main/services/playwright-runner.ts");
  assert(
    /resolveRunSpeed\(/.test(runner),
    "the runner resolves the pace through `resolveRunSpeed`",
  );
  assert(
    !/rec\.speed\s*\?\?\s*"fast"/.test(runner),
    "…and not by the old two-layer fallback, which skipped the setting entirely",
  );
  assert(
    /speed\?:\s*TestSpeed/.test(runner),
    "a caller can pace one run without editing the test",
  );

  const handlers = code("main/handlers/index.ts");
  assert(
    /speed:\s*isTestSpeed\(params\.speed\)/.test(handlers),
    "`runner:run` validates the speed at the IPC boundary rather than forwarding it",
  );
}

// ── A batch's headless default is its own ────────────────────────────────
{
  const batch = code("renderer/main/batch-view.tsx");
  assert(
    /defaultRunHeadless:\s*settingsQuery\.data\?\.defaultBatchHeadless/.test(batch),
    "batch rows fall back to the BATCH's headless default, not the single run's",
  );

  const store = code("main/services/recorder-settings-store.ts");
  assert(
    /defaultBatchHeadless:\s*true/.test(store),
    "…which ships on: sixty ticked tests are sixty windows that each steal focus",
  );
  assert(
    /defaultRunHeadless:\s*false/.test(store),
    "…while a single run still ships headed, because watching one is usually the point",
  );
  assert(
    /defaultBatchConcurrency:\s*defaultConcurrencyForMachine\(\)/.test(store),
    "the batch concurrency default is seeded from the machine, not from the constant 1",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll run-default checks passed.");
