// Standalone regression check for the capture-queue trust boundary.
//
// The injected capture script hands steps back through a DOM ATTRIBUTE on
// documentElement. The DOM belongs to the page, and the page is an arbitrary
// website, so everything arriving on that channel is attacker input — the page
// can write the attribute itself.
//
// That would be unremarkable if steps were only ever displayed. They aren't:
// they are compiled into a .spec.ts which Playwright later EXECUTES in Node
// with the user's privileges. Strings were always escaped through
// JSON.stringify; the numeric fields were interpolated raw, on the strength of
// their TypeScript type. A type is not a runtime check, and a page writing
//   { type: "assert", assert: "count", count: "0); <node code>; (" }
// got that code into the generated spec verbatim.
//
// Two independent properties are pinned here, and BOTH matter:
//   • the boundary rejects it — nothing malformed reaches the step list;
//   • the generator can't emit it anyway — because tests recorded before the
//     boundary existed are already on disk, and are regenerated from their
//     stored steps.
// Either one alone leaves a live path. Run with:
//   npm run check:step-ingest

import {
  MAX_STEPS_PER_DRAIN,
  normalizePickedElement,
  normalizeRawStep,
  normalizeRawSteps,
  normalizeStep,
} from "../../recorder/types.js";
import { generateSpec } from "../script-generator.js";
import type { Step, TestRecord } from "../../recorder/types.js";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(
      `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  } else {
    console.log(`ok   ${label}`);
  }
}

/** The exact payload shape a hostile page would write into data-pw-queue. */
const NODE_CODE = "0); require('child_process').execSync('touch /tmp/pwned'); expect(1).toBe(1";

/** Generate a spec from steps that bypassed the boundary — i.e. steps already
 *  stored on disk from before it existed. */
function specFor(steps: Step[]): string {
  return generateSpec({
    id: "t1",
    name: "Demo",
    url: "https://example.com",
    createdAt: 0,
    updatedAt: 0,
    steps,
    scriptPath: "/tmp/demo.spec.ts",
  } as TestRecord);
}

function lineWith(spec: string, needle: string): string {
  return (spec.split("\n").find((l) => l.includes(needle)) ?? "").trim();
}

function main(): void {
  // ── 1. The boundary rejects forged numerics ──────────────────────────────
  {
    const forged = normalizeRawStep({
      type: "assert",
      assert: "count",
      locator: { k: "testid", v: "x" },
      count: NODE_CODE,
    });
    assert(forged !== null, "a step with a forged count is still a usable step");
    assertEqual(forged?.count, undefined, "…but the forged count is DROPPED, not carried");

    const vp = normalizeRawStep({ type: "viewport", width: "1); evil(); (", height: 800 });
    assertEqual(vp?.width, undefined, "a forged viewport width is dropped");
    assertEqual(vp?.height, 800, "…while the legitimate height beside it survives");
  }

  // ── 2. Numbers that are numbers, but not usable numerals ─────────────────
  //
  // `String(NaN)`/`String(Infinity)` are valid JS identifiers-ish tokens that
  // would emit `toHaveCount(NaN)`, and 1e21 stringifies to exponential form.
  // None of these is what anyone recorded.
  {
    assertEqual(
      normalizeRawStep({ type: "assert", assert: "count", count: NaN })?.count,
      undefined,
      "NaN is not a count",
    );
    assertEqual(
      normalizeRawStep({ type: "assert", assert: "count", count: Infinity })?.count,
      undefined,
      "Infinity is not a count",
    );
    assertEqual(
      normalizeRawStep({ type: "assert", assert: "count", count: 3.7 })?.count,
      3,
      "a float count is truncated to an integer",
    );
    assertEqual(
      normalizeRawStep({ type: "viewport", width: -5, height: 800 })?.width,
      undefined,
      "a negative viewport width is dropped",
    );
  }

  // ── 3. Unknown fields are not carried through ────────────────────────────
  //
  // The reason the normalizer REBUILDS rather than filters. Spreading the input
  // and overwriting known keys would carry every unknown key along with it, so
  // the next field wired into the generator would silently be a hole again.
  {
    const out = normalizeRawStep({
      type: "click",
      locator: { k: "testid", v: "ok" },
      __proto__: { polluted: true },
      somethingNew: NODE_CODE,
      count: 5,
    }) as Record<string, unknown> | null;
    assert(out !== null, "a click step normalizes");
    assert(!("somethingNew" in (out ?? {})), "an unknown key does NOT survive normalization");
    assertEqual(
      Object.keys(out ?? {}).sort(),
      ["count", "locator", "type"],
      "only known keys are rebuilt onto the step",
    );
  }

  // ── 4. Enum fields are allowlisted ───────────────────────────────────────
  {
    assertEqual(normalizeRawStep({ type: "nope" }), null, "an unknown step type is rejected outright");
    assertEqual(normalizeRawStep(null), null, "null is not a step");
    assertEqual(normalizeRawStep("click"), null, "a bare string is not a step");
    assertEqual(normalizeRawStep([]), null, "an array is not a step");
    assertEqual(
      normalizeRawStep({ type: "assert", assert: "evil" })?.assert,
      undefined,
      "an unknown assert kind is dropped",
    );
    assertEqual(
      normalizeRawStep({ type: "click", locator: { k: "evil", v: "x" } })?.locator,
      undefined,
      "an unknown locator kind is dropped",
    );
    assertEqual(
      normalizeRawStep({ type: "if", cond: "evil" })?.cond,
      undefined,
      "an unknown condition kind is dropped",
    );
  }

  // ── 5. The drain is bounded ──────────────────────────────────────────────
  {
    const many = Array.from({ length: MAX_STEPS_PER_DRAIN + 50 }, () => ({ type: "click" }));
    assertEqual(
      normalizeRawSteps(many).length,
      MAX_STEPS_PER_DRAIN,
      "a drain is capped, so a page can't push unbounded steps in one poll",
    );
    assertEqual(normalizeRawSteps("nope"), [], "a non-array queue drains to nothing");
    assertEqual(
      normalizeRawSteps([{ type: "click" }, { type: "nope" }, { type: "goto", url: "u" }]).length,
      2,
      "unusable steps are skipped without taking the usable ones with them",
    );
  }

  // ── 6. normalizeStep keeps identity ──────────────────────────────────────
  //
  // A step list is edited in place. Minting a fresh id here would detach the
  // step from everything keyed to it — the heal journal, visual masks.
  {
    const kept = normalizeStep({ id: "s1", timestamp: 42, type: "click", count: 2 });
    assertEqual(kept?.id, "s1", "an existing step id is preserved");
    assertEqual(kept?.timestamp, 42, "…and so is its timestamp");
    assertEqual(normalizeStep({ type: "click" }), null, "a step with no id is rejected");
    assertEqual(
      normalizeStep({ id: "s1", timestamp: 0, type: "assert", assert: "count", count: NODE_CODE })?.count,
      undefined,
      "the Step form drops a forged count too",
    );
  }

  // ── 7. The generator cannot emit a non-numeral ───────────────────────────
  //
  // Independent of the boundary: these steps stand in for ones already stored
  // on disk, recorded before the boundary existed. Regenerating a test reads
  // them straight out of tests.json.
  {
    const poisoned = [
      { id: "s1", timestamp: 0, type: "assert", assert: "count", locator: { k: "testid", v: "x" }, count: NODE_CODE },
    ] as unknown as Step[];
    const line = lineWith(specFor(poisoned), "toHaveCount");
    assertEqual(
      line,
      'await expect(page.getByTestId("x")).toHaveCount(0);',
      "a poisoned count emits the fallback numeral, not code",
    );
    assert(!line.includes("require("), "…and no injected call survives into the spec");
  }
  {
    const poisoned = [
      { id: "s1", timestamp: 0, type: "viewport", width: "0, height: 0}); evil(); ({", height: 800 },
    ] as unknown as Step[];
    const line = lineWith(specFor(poisoned), "setViewportSize");
    assertEqual(
      line,
      "await page.setViewportSize({ width: 1280, height: 800 });",
      "a poisoned viewport emits the fallback numerals",
    );
    assert(!line.includes("evil("), "…and no injected call survives into the spec");
  }
  {
    const poisoned = [
      { id: "s1", timestamp: 0, type: "wait", waitMs: "100); evil(); (" },
    ] as unknown as Step[];
    const spec = specFor(poisoned);
    assert(!spec.includes("evil("), "a poisoned waitMs cannot reach the spec either");
  }

  // Legitimate values still render exactly as before — the fix must not have
  // quietly changed what a normal recording generates.
  {
    const ok = [
      { id: "s1", timestamp: 0, type: "assert", assert: "count", locator: { k: "testid", v: "x" }, count: 3 },
      { id: "s2", timestamp: 0, type: "viewport", width: 375, height: 812 },
    ] as unknown as Step[];
    const spec = specFor(ok);
    assertEqual(
      lineWith(spec, "toHaveCount"),
      'await expect(page.getByTestId("x")).toHaveCount(3);',
      "a real count is unchanged",
    );
    assertEqual(
      lineWith(spec, "setViewportSize"),
      "await page.setViewportSize({ width: 375, height: 812 });",
      "a real viewport is unchanged",
    );
  }

  // ── 8. The picked-element channel is normalized too ──────────────────────
  //
  // Same page-writable attribute. Not exploitable through today's sinks, which
  // is a property of the current generator rather than of the data.
  {
    const picked = normalizePickedElement({
      tag: "button",
      description: "button#go",
      candidates: [{ k: "testid", v: "go" }, { k: "evil", v: "x" }],
      css: { color: "red", bad: 42 },
      attributes: { id: "go" },
      extra: NODE_CODE,
    }) as Record<string, unknown> | null;
    assert(picked !== null, "a picked element normalizes");
    assertEqual(
      (picked?.candidates as unknown[])?.length,
      1,
      "an unknown locator kind is dropped from the candidate list",
    );
    assertEqual(picked?.css, { color: "red" }, "a non-string css value is dropped");
    assert(!("extra" in (picked ?? {})), "an unknown key does not survive");
    assertEqual(normalizePickedElement("nope"), null, "a non-object picked element is rejected");
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll step-ingest checks passed");
}

main();
