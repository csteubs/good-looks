// Standalone regression check for Auto-Heal coverage across the replay paths.
//
// The Auto-Heal engine (main/services/auto-heal.ts) only helps if it actually
// runs when a step's locator fails to resolve. It was originally wired into
// `replayFromCurrent` only, so a locator failure in a single-step preview
// (`replayStep`), in "replay from start" (`replayFromStart`), or in the
// "Edit in Trainer" auto-run (`replayAll`) got no healing at all — the same
// broken locator reported the same failure with no candidates offered.
//
// All four paths now call the shared `healAndRetry` helper, which pairs
// `tryHeal` with the standard "substitute the locator, re-run the replay
// script" wiring. This check reads recorder-service.ts, slices out each replay
// method's body, and verifies each one calls `healAndRetry`. It guards against
// a future edit dropping healing from a path again.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npx tsx main/services/__tests__/auto-heal-wiring.check.ts

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "../recorder-service.ts");
const source = readFileSync(sourcePath, "utf8");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** The four replay entry points, in source order. Each is an `async name(` method
 *  on the recorderService object literal. */
const REPLAY_METHODS = ["replayStep", "replayFromStart", "replayAll", "replayFromCurrent"];

/** Return the source between `async <name>(` and the start of the next replay
 *  method (or end of file) — a coarse but stable slice of that method's body. */
function methodBody(name: string): string | null {
  const start = source.indexOf(`async ${name}(`);
  if (start === -1) return null;
  let end = source.length;
  for (const other of REPLAY_METHODS) {
    if (other === name) continue;
    const otherStart = source.indexOf(`async ${other}(`);
    if (otherStart > start && otherStart < end) end = otherStart;
  }
  // `persistDebug` follows the last replay method — stop there so the slice for
  // `replayFromCurrent` doesn't swallow the rest of the service.
  const persist = source.indexOf("persistDebug(entry: DebugEntry)", start);
  if (persist > start && persist < end) end = persist;
  return source.slice(start, end);
}

// The shared helper must exist — the four call sites all route through it.
assert(
  /async function healAndRetry\(/.test(source),
  "healAndRetry helper is defined",
);
assert(
  /function tryHeal\(/.test(source),
  "tryHeal engine entry point is defined",
);

for (const name of REPLAY_METHODS) {
  const body = methodBody(name);
  assert(body !== null, `found the ${name} method`);
  if (!body) continue;
  assert(
    body.includes("healAndRetry("),
    `${name} invokes Auto-Heal via healAndRetry`,
  );
  // A heal that succeeds must flip the step to passing — otherwise the healed
  // re-run is discarded and the user still sees a failure.
  assert(
    /okWithHeal/.test(body),
    `${name} acts on the healed result (okWithHeal)`,
  );
}

// Structural if/endif steps carry no healable locator; healing them would run
// the probe against a condition rather than a target. The loop paths must guard.
for (const name of ["replayFromStart", "replayAll"]) {
  const body = methodBody(name) ?? "";
  assert(
    /step\.type !== "if"/.test(body),
    `${name} skips Auto-Heal for structural if steps`,
  );
}

// ── A failed heal attempt goes to the artifacts, never to the journal ──
//
// Both kinds of event share one file (heals.json), so the runner has to sort
// them. Getting that wrong is silent in BOTH directions and each is bad in its
// own way: journal a failure and the review list fills with rows whose "revert"
// button has nothing to revert to; classify a heal as a failure and a real
// locator change vanishes from the only place it can be reviewed or undone.
{
  const runner = readFileSync(resolve(here, "../playwright-runner.ts"), "utf8");

  assert(
    /function isHeal\(/.test(runner) && /function isHealFailure\(/.test(runner),
    "the runner sorts heals.json with typed guards, not an inline filter",
  );
  // The backwards-compatibility direction. Every event written before
  // 2026-08-07 has no `outcome`, and every one of those was a heal — reading
  // them the other way would reclassify the whole existing journal as failures.
  assert(
    /\(e\.outcome \?\? "healed"\) === "healed"/.test(runner),
    "an event with no outcome is read as a HEAL (that was the only kind written)",
  );
  // Keyed on the outcomes that exist rather than on "not a heal", so a value
  // this build doesn't recognise is dropped rather than counted as a failure.
  assert(
    /e\.outcome === "exhausted" \|\| e\.outcome === "no-candidates"/.test(runner),
    "a failure is recognised by its own outcomes, not by NOT being a heal",
  );
  assert(
    /artifactStore\.writeHealFailures\(/.test(runner),
    "failures are persisted to the run's artifacts",
  );
  // The journal loop must run over the HEALS, not over everything read.
  assert(
    /const events = all\.filter\(isHeal\);/.test(runner),
    "only heals reach healJournalStore.record",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll auto-heal-wiring checks passed");
