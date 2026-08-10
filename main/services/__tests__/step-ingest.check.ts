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
  buildStepStructures,
  MAX_STRUCTURE_CANDIDATES,
  MAX_STRUCTURE_MATCHES,
  MAX_STRUCTURE_STEPS,
  MAX_STEPS_PER_DRAIN,
  normalizePickedElement,
  normalizeRawStep,
  normalizeRawSteps,
  normalizeStep,
  normalizeStepMatches,
  normalizeStepStructures,
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
    assertEqual(
      normalizeRawStep({ type: "wait", waitUntil: "evil" })?.waitUntil,
      undefined,
      "an unknown waitUntil kind is dropped",
    );
    assertEqual(
      normalizeRawStep({ type: "wait", waitUntil: "enabled" })?.waitUntil,
      "enabled",
      "…while a real one survives",
    );
    // The wait vocabulary is a SUPERSET of the condition vocabulary, and the two
    // are checked against separate lists on purpose. If `cond` were ever widened
    // to the wait list, an `if` step would accept predicates conditionExpr has
    // no branch for and silently fall through to its `visible` default.
    assertEqual(
      normalizeRawStep({ type: "if", cond: "count" })?.cond,
      undefined,
      "a wait-only predicate is NOT accepted as an if-condition",
    );
    assertEqual(
      normalizeRawStep({ type: "state", elementState: "evil" })?.elementState,
      undefined,
      "an unknown element state is dropped",
    );
    assertEqual(
      normalizeRawStep({ type: "state", elementState: "hover" })?.elementState,
      "hover",
      "…while a real one survives",
    );
    assertEqual(
      normalizeRawStep({ type: "assert", assert: "css", cssMatch: "evil" })?.cssMatch,
      undefined,
      "an unknown css match mode is dropped",
    );
  }

  // ── 4c. cssProp is checked for SHAPE, not just length ────────────────────
  //
  // It is the one free string with a known grammar, and it reaches the
  // generator as the first argument of `toHaveCSS`. `q()` would quote a hostile
  // value safely today, but "safe through the current sink" is a property of
  // today's generator rather than of the data — the same argument that made
  // every numeric field go through `int()` as well as `num()`.
  {
    const bad = [
      NODE_CODE,
      'color"); require("child_process").execSync("id"); ("',
      "background color",
      "background_color",
      "1color",
      "",
      "color;",
      "a".repeat(101),
    ];
    for (const v of bad) {
      assertEqual(
        normalizeRawStep({ type: "assert", assert: "css", cssProp: v })?.cssProp,
        undefined,
        `a malformed cssProp is dropped: ${JSON.stringify(v.slice(0, 24))}`,
      );
    }
    for (const v of ["color", "background-color", "-webkit-line-clamp", "--brand-accent"]) {
      assertEqual(
        normalizeRawStep({ type: "assert", assert: "css", cssProp: v })?.cssProp,
        v,
        `a real cssProp survives: ${v}`,
      );
    }
    // A camelCase name is syntactically VALID and deliberately allowed through
    // — refusing it here would be the boundary second-guessing CSS rather than
    // checking it. It reads as "" from getPropertyValue, which the trainer's
    // replay log calls out by name. That split is the point: the boundary
    // rejects what is malformed, the UI warns about what is merely wrong.
    assertEqual(
      normalizeRawStep({ type: "assert", assert: "css", cssProp: "backgroundColor" })?.cssProp,
      "backgroundColor",
      "a camelCase property is syntactically valid and is not dropped here",
    );
  }

  // ── 4b. timeoutMs is a numeral field, so it gets the count treatment ──────
  //
  // It reaches the generator concatenated into `{ timeout: … }`, which is the
  // same sink shape that made `count` an RCE.
  {
    assertEqual(
      normalizeRawStep({ type: "wait", waitUntil: "visible", timeoutMs: NODE_CODE })?.timeoutMs,
      undefined,
      "a forged timeoutMs is dropped at the boundary",
    );
    assertEqual(
      normalizeRawStep({ type: "wait", waitUntil: "visible", timeoutMs: NaN })?.timeoutMs,
      undefined,
      "NaN is not a timeout",
    );
    assertEqual(
      normalizeRawStep({ type: "wait", waitUntil: "visible", timeoutMs: -1 })?.timeoutMs,
      undefined,
      "a negative timeout is dropped",
    );
    assertEqual(
      normalizeRawStep({ type: "wait", waitUntil: "visible", timeoutMs: 2500 })?.timeoutMs,
      2500,
      "…while a real timeout survives",
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
  // A conditional wait's timeout is the newest numeral field on this path, and
  // `recorder:updateStep` copies its allowlisted fields WITHOUT re-normalizing
  // them — so the generator, not the boundary, is what stands between a forged
  // timeout and the spec.
  {
    const poisoned = [
      { id: "s1", timestamp: 0, type: "wait", waitUntil: "enabled", locator: { k: "testid", v: "x" }, timeoutMs: NODE_CODE },
    ] as unknown as Step[];
    const line = lineWith(specFor(poisoned), "toBeEnabled");
    assertEqual(
      line,
      'await expect(page.getByTestId("x")).toBeEnabled({ timeout: 10000 }); // wait until',
      "a poisoned timeout emits the fallback numeral, not code",
    );
    assert(!line.includes("require("), "…and no injected call survives into the spec");
  }
  {
    const poisoned = [
      { id: "s1", timestamp: 0, type: "wait", waitUntil: "hidden", locator: { k: "testid", v: "x" }, timeoutMs: "0 }); evil(); ({" },
    ] as unknown as Step[];
    const spec = specFor(poisoned);
    assert(!spec.includes("evil("), "a poisoned timeout on the native waitFor form is inert too");
  }
  // `cssProp` is the newest string field concatenated into a call ARGUMENT, and
  // like `timeoutMs` it arrives via `recorder:updateStep`, which copies its
  // allowlisted fields without re-normalizing. So the generator re-checks the
  // property's shape itself rather than relying on the boundary having seen it.
  {
    const poisoned = [
      {
        id: "s1",
        timestamp: 0,
        type: "assert",
        assert: "css",
        locator: { k: "testid", v: "x" },
        cssProp: 'color"); require("child_process").execSync("id"); ("',
        cssMatch: "is",
        value: "red",
      },
    ] as unknown as Step[];
    const spec = specFor(poisoned);
    assert(!spec.includes("require("), "a poisoned cssProp never reaches the spec");
    assert(!spec.includes("toHaveCSS"), "…and the step emits no line at all rather than a broken one");
  }
  // The same field routed through the `contains` arm, which builds a RegExp
  // rather than a plain string — a second sink, with a second escaper.
  //
  // Asserting the absence of "require(" would pass here for the WRONG reason:
  // `reEscape` turns `(` into `\(`, so the substring is gone whether or not the
  // value escaped its literal. The property that actually matters is that the
  // emitted statement still parses as ONE statement — an injection is by
  // definition a value that closes its literal and opens new syntax, so a value
  // that cannot change the parse cannot inject.
  {
    for (const value of [
      '"), (function(){ return require("child_process") })(), new RegExp("',
      '\\"); evil(); ("',
      "rgb(0, 0, 0)",
      "`${evil()}`",
    ]) {
      const poisoned = [
        {
          id: "s1",
          timestamp: 0,
          type: "assert",
          assert: "css",
          locator: { k: "testid", v: "x" },
          cssProp: "color",
          cssMatch: "contains",
          value,
        },
      ] as unknown as Step[];
      const line = lineWith(specFor(poisoned), "toHaveCSS");
      assert(line.startsWith("await expect("), `a css contains value stays inside its call: ${JSON.stringify(value.slice(0, 20))}`);
      let statements = -1;
      try {
        // Parsed, not pattern-matched. If the value broke out, this is two or
        // more statements (or a syntax error) instead of one.
        const fn = new Function("expect", "page", `return (async () => { ${line} });`);
        statements = typeof fn === "function" ? 1 : 0;
      } catch {
        statements = 0;
      }
      assertEqual(statements, 1, `…and the emitted line is still a single parseable statement`);
      assert(
        (line.match(/toHaveCSS/g) ?? []).length === 1,
        "…with exactly one toHaveCSS call on it",
      );
    }
  }
  // The state a `state` step applies selects a fixed call rather than being
  // concatenated, so an unrecognized one must emit NOTHING rather than reaching
  // the source text.
  {
    const poisoned = [
      { id: "s1", timestamp: 0, type: "state", elementState: "hover(); evil(); //", locator: { k: "testid", v: "x" } },
    ] as unknown as Step[];
    const spec = specFor(poisoned);
    assert(!spec.includes("evil("), "an unrecognized elementState never reaches the spec");
    assert(!spec.includes(".hover("), "…and emits no line at all");
  }

  // The predicate itself selects a fixed string rather than being concatenated,
  // so an unrecognized one must degrade to the legacy wait rather than reaching
  // the source text.
  {
    const poisoned = [
      { id: "s1", timestamp: 0, type: "wait", waitUntil: "evil(); //", locator: { k: "testid", v: "x" }, waitMs: 250 },
    ] as unknown as Step[];
    const spec = specFor(poisoned);
    assert(!spec.includes("evil("), "an unrecognized waitUntil never reaches the spec");
    assert(spec.includes("waitForTimeout(250)"), "…and the step falls back to its duration");
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

  // ── 9. Auto-Heal's record of the page is normalized too ──────────────────
  //
  // A THIRD reader of page-authored data, and the least obvious one: the probe
  // runs inside the page, so every description and locator it reports is
  // chosen by the site. It is read back off disk rather than off the queue
  // attribute, which changes nothing — writeHealFailures persists the
  // fixture's JSON verbatim. It now feeds an LLM prompt whose answer the user
  // can apply to their script with one click.
  {
    const entries = normalizeStepStructures([
      {
        stepIndex: 4,
        stepLabel: "Click button",
        outcome: "exhausted",
        method: "click",
        originalLocator: { k: "role", role: "button", name: "Pause" },
        candidates: [
          { locator: { k: "testid", v: "go" }, description: "button#go", score: 0.9, matchedPastRun: true },
          { locator: { k: "evil", v: "x" }, description: "nope", score: 1, matchedPastRun: true },
        ],
        extra: NODE_CODE,
      },
      { outcome: "not-a-real-outcome", stepIndex: 0 },
    ]) as unknown as Record<string, unknown>[];

    assertEqual(entries.length, 1, "an entry with an unknown outcome is rejected");
    assert(!("extra" in (entries[0] ?? {})), "an unknown key does not survive");
    assertEqual(
      (entries[0]?.candidates as unknown[])?.length,
      1,
      "a candidate with an unknown locator kind is dropped",
    );

    // A score is what the payload sorts and labels as ranking. A made-up 1
    // would put a hostile candidate at the top of a list the model reads as
    // "best match first", so an out-of-range one is zeroed, not clamped.
    const scored = normalizeStepStructures([
      {
        outcome: "exhausted",
        candidates: [
          { locator: { k: "css", v: "#a" }, score: 99 },
          { locator: { k: "css", v: "#b" }, score: "1" },
        ],
      },
    ]);
    assertEqual(scored[0].candidates[0].score, 0, "an out-of-range score is dropped to zero");
    assertEqual(scored[0].candidates[1].score, 0, "a string score is dropped to zero");

    // Unbounded on the page's side: a site with thousands of similar elements
    // must not become a prompt with thousands of lines.
    const flood = normalizeStepStructures(
      Array.from({ length: MAX_STRUCTURE_STEPS + 5 }, () => ({
        outcome: "exhausted",
        candidates: Array.from({ length: MAX_STRUCTURE_CANDIDATES + 10 }, () => ({
          locator: { k: "css", v: "#x" },
        })),
      })),
    );
    assertEqual(flood.length, MAX_STRUCTURE_STEPS, "the step list is capped");
    assertEqual(
      flood[0].candidates.length,
      MAX_STRUCTURE_CANDIDATES,
      "the candidate list is capped per step",
    );
    assertEqual(normalizeStepStructures("nope"), [], "a non-array is rejected");
    assertEqual(normalizeStepStructures([null, 4, "x"]), [], "non-object entries are rejected");
  }

  // ── 10. What the locator actually matched is page text, verbatim ─────────
  //
  // The most directly page-authored data in the app: these fields ARE the
  // site's DOM — its text, ids and class names, read straight off the elements
  // and sent to a model whose answer is one click from the user's script.
  {
    const sets = normalizeStepMatches([
      {
        stepIndex: 4,
        stepLabel: "Click button",
        method: "click",
        matchCount: 10,
        originalLocator: { k: "role", role: "button", name: "Pause" },
        matches: [
          { index: 0, tag: "button", testid: "go", text: "Pause", classes: ["a", "b"], ancestors: ["main"], visible: true, enabled: true, rect: { x: 1, y: 2, w: 3, h: 4 } },
          { tag: "", text: "no tag" },
          { index: 2, tag: "button", rect: { x: 1, y: 2, w: 3 } },
        ],
        extra: NODE_CODE,
      },
    ]);
    assertEqual(sets.length, 1, "a match set normalizes");
    assert(!("extra" in (sets[0] as unknown as Record<string, unknown>)), "an unknown key does not survive");
    assertEqual(sets[0].matchCount, 10, "the true match count is kept");
    // A blank tag is not an element description. Dropped rather than defaulted:
    // an empty line among the matches is one the model counts as a choice.
    assertEqual(sets[0].matches.length, 2, "a descriptor with no tag is dropped");
    assertEqual(sets[0].matches[1].rect, undefined, "a partial rect is dropped whole, not half-kept");
    // Defaults follow the DOM: `disabled` is the property that exists, so a
    // missing field must not tell the model an element cannot be clicked.
    assertEqual(sets[0].matches[1].enabled, true, "a missing enabled flag reads as enabled");
    assertEqual(sets[0].matches[1].visible, false, "a missing visible flag reads as not visible");

    const flood = normalizeStepMatches([
      {
        matchCount: 9999,
        matches: Array.from({ length: MAX_STRUCTURE_MATCHES + 20 }, () => ({
          tag: "div",
          text: "x".repeat(5000),
          classes: Array.from({ length: 50 }, (_, i) => "c" + i),
          ancestors: Array.from({ length: 50 }, (_, i) => "a" + i),
        })),
      },
    ]);
    assertEqual(flood[0].matches.length, MAX_STRUCTURE_MATCHES, "the match list is capped");
    assert(flood[0].matches[0].text!.length <= 200, "a long text is truncated");
    assertEqual(flood[0].matches[0].classes.length, 3, "the class list is capped");
    assertEqual(flood[0].matches[0].ancestors.length, 3, "the ancestor list is capped");
    assertEqual(normalizeStepMatches("nope"), [], "a non-array is rejected");
  }

  // ── 11. The two records join on the step they describe ───────────────────
  //
  // Either can exist without the other: a locator that was ambiguous and then
  // HEALED leaves matches and no heal failure, and a run from before matches
  // existed leaves the reverse.
  {
    const merged = buildStepStructures(
      [{ stepIndex: 4, stepLabel: "Click button", outcome: "exhausted", candidates: [{ locator: { k: "css", v: "#a" }, score: 0.5 }] }],
      [{ stepIndex: 4, stepLabel: "Click button", matchCount: 10, matches: [{ tag: "button" }] }],
    );
    assertEqual(merged.length, 1, "one record per step, not one per file");
    assertEqual(merged[0].matches.length, 1, "the matches survive the join");
    assertEqual(merged[0].candidates.length, 1, "the heal candidates survive the join");
    assertEqual(merged[0].outcome, "exhausted", "the heal outcome survives the join");

    const healOnly = buildStepStructures([{ stepIndex: 1, outcome: "no-candidates" }], []);
    assertEqual(healOnly.length, 1, "a heal failure with no match record still reports");
    assertEqual(healOnly[0].matches.length, 0, "…with no matches invented for it");

    const matchOnly = buildStepStructures([], [{ stepIndex: 2, matches: [{ tag: "button" }] }]);
    assertEqual(matchOnly.length, 1, "a match record with no heal failure still reports");
    assertEqual(matchOnly[0].outcome, undefined, "…and claims no heal outcome it does not have");

    const many = buildStepStructures(
      [],
      Array.from({ length: MAX_STRUCTURE_STEPS + 5 }, (_, i) => ({ stepIndex: i, matches: [] })),
    );
    assertEqual(many.length, MAX_STRUCTURE_STEPS, "the joined list is capped");
    assertEqual(many[0].stepIndex, 0, "…in step order");
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll step-ingest checks passed");
}

main();
