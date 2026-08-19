// Standalone regression check: everything the generator writes, the parser can
// read back.
//
// ── The failure this exists to prevent ─────────────────────────────────────
// `parseLocator` reads `.nth(k)` back off a generated locator and USED to
// refuse `.filter()`, `.first()` and `.or()` — "refinements the app has no
// field for". The comment above that code records what happened the one time
// the generator emitted something the parser could not read: the action shape
// did not match, and the WHOLE STEP was dropped on re-parse. Not the index —
// the step. Silently, on every hand edit of the Script tab and every applied AI
// fix, for exactly the steps that needed the refinement.
//
// Element context makes the generator emit chains (`getByTestId("card")
// .filter({hasText:"x"}).getByRole("button").and(page.locator("[data-qa]"))`),
// and the steps that carry them are, by construction, the ambiguous ones — the
// steps a user went out of their way to disambiguate. Losing those would be the
// same bug, aimed at the feature's own output.
//
// ── What is pinned ─────────────────────────────────────────────────────────
// Two properties, and the second is the one with teeth:
//   • parse(generate(steps)) recovers every step, with its context intact;
//   • generate(parse(generate(steps))) === generate(steps) — the source is a
//     FIXED POINT. A parser that reads a chain into a subtly different model
//     satisfies the first property (a step comes back) and fails this one, and
//     it is the difference that a user's next hand edit would silently apply.
//
// Run with: npm run check:locator-roundtrip

import { generateSpec } from "../script-generator.js";
import { parseSpec, parseSpecDetailed } from "../spec-parser.js";
import type { Locator, Step } from "../../recorder/types.js";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** JSON with object keys in a stable order.
 *
 *  The property under test is that the MODEL survives, not that its keys come
 *  back in the order they were written in. The parser builds a context-carrying
 *  locator by spreading (`{...inner, ctx}`) and appends `nth` afterwards, so
 *  `ctx` lands before `nth` where the fixture writes it after — identical data,
 *  different `JSON.stringify` output. Asserting on that would be asserting on
 *  an implementation detail of object construction, and it would fail for a
 *  change that is provably correct. Source-level equality is checked separately
 *  and IS byte-exact, which is where exactness actually matters. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort());
    }
    return val;
  });
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const ok = stable(actual) === stable(expected);
  if (!ok) {
    failures++;
    console.error(
      `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  } else {
    console.log(`ok   ${label}`);
  }
}

function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: "s", timestamp: 0, ...partial } as Step;
}

const gen = (steps: Step[]): string =>
  generateSpec({ name: "ctx", url: "https://example.com", steps });

/** Generate, parse, regenerate — and require all three to agree. */
function roundTrip(loc: Locator, label: string): void {
  const steps = [step({ type: "click", locator: loc })];
  const source = gen(steps);

  const parsed = parseSpecDetailed(source);
  const clicks = parsed.steps.filter((s) => s.type === "click");
  if (clicks.length !== 1) {
    failures++;
    console.error(
      `FAIL ${label} — the step did not survive re-parse (skipped=${parsed.skipped})\n` +
        `  source: ${source.split("\n").find((l) => l.includes("click")) ?? "(no click line)"}`,
    );
    return;
  }

  assertEqual(clicks[0].locator, loc, `${label} — the locator model survives`);

  // The fixed-point property. Compared on SOURCE rather than on the models,
  // because source is what actually runs and what the user edits.
  const regenerated = gen([step({ type: "click", locator: clicks[0].locator })]);
  assertEqual(regenerated, source, `${label} — regenerating is a fixed point`);
}

function main(): void {
  // ── 1. No context: the shapes that already worked keep working ───────────
  roundTrip({ k: "testid", v: "submit" }, "testid");
  roundTrip({ k: "role", role: "button", name: "Log in" }, "role + name");
  roundTrip({ k: "label", v: "Email" }, "label");
  roundTrip({ k: "placeholder", v: "Search" }, "placeholder");
  roundTrip({ k: "text", v: "Save" }, "text");
  roundTrip({ k: "css", v: "#app > button" }, "css");
  roundTrip({ k: "text", v: "Save", nth: 2 }, "text + nth");

  // A generated css path contains BALANCED parens, which the builder scan has
  // to walk past rather than stopping at the first `)`.
  roundTrip({ k: "css", v: "body > section:nth-of-type(1) > button" }, "css with nth-of-type");

  // ── 2. Each context shape alone ──────────────────────────────────────────
  roundTrip(
    { k: "role", role: "button", name: "Edit", ctx: { within: { k: "testid", v: "billing" } } },
    "within",
  );
  roundTrip(
    {
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "role", role: "listitem" }, withinHasText: "Billing" },
    },
    "within + hasText",
  );
  roundTrip(
    { k: "role", role: "button", name: "Edit", ctx: { and: [{ k: "css", v: "[data-qa='edit']" }] } },
    "and",
  );
  roundTrip(
    {
      k: "text",
      v: "Go",
      ctx: { and: [{ k: "css", v: ".a" }, { k: "css", v: ".b" }] },
    },
    "two ands",
  );

  // ── 3. Everything at once, including the index ───────────────────────────
  //
  // `.nth()` is emitted LAST because it indexes whatever precedes it. If the
  // parser reattached it to the container instead of the target, this is the
  // case that catches it.
  roundTrip(
    {
      k: "role",
      role: "button",
      name: "Edit",
      nth: 1,
      ctx: {
        within: { k: "testid", v: "billing" },
        withinHasText: "Billing",
        and: [{ k: "css", v: "[data-qa='edit']" }],
      },
    },
    "within + hasText + and + nth",
  );

  // ── 4. Two role locators in one chain ────────────────────────────────────
  //
  // The trap that made `parseBuilderAt` necessary. `parseRoleOptions` anchors
  // on the FIRST `getByRole(` in whatever string it is given, so a parser that
  // hands it the whole expression reads the CONTAINER's role and name onto the
  // target — producing a step that names the wrong element and still looks
  // perfectly well-formed.
  roundTrip(
    {
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "role", role: "region", name: "Billing" } },
    },
    "role inside a role — the container's name does not leak onto the target",
  );

  // ── 5. Context on kinds other than role ──────────────────────────────────
  roundTrip({ k: "text", v: "Edit", ctx: { within: { k: "css", v: "#billing" } } }, "text within css");
  roundTrip(
    { k: "testid", v: "edit", ctx: { within: { k: "testid", v: "card" } } },
    "testid within testid",
  );
  roundTrip(
    { k: "css", v: "button.edit", ctx: { within: { k: "testid", v: "card" } } },
    "css within testid",
  );

  // ── 6. An xpath is read back as an xpath ─────────────────────────────────
  //
  // The generator writes `locator("xpath=…")`, and the parser used to read that
  // back as a CSS locator whose selector began with "xpath=". It round-tripped
  // by luck — regenerating produced the same source, because Playwright itself
  // reads the prefix — but every consumer that branched on `k` saw the wrong
  // kind, including the heal key and the context resolver.
  roundTrip({ k: "xpath", v: "/html[1]/body[1]/button[2]" }, "xpath");

  // ── 7. Values that have to survive quoting ───────────────────────────────
  roundTrip(
    { k: "role", role: "button", name: "Edit", ctx: { within: { k: "testid", v: 'a"b' } } },
    "a quote in a container's value",
  );
  roundTrip(
    {
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "testid", v: "card" }, withinHasText: "Total: $9.99 (inc. tax)" },
    },
    "punctuation and parens in hasText",
  );

  // ── 7b. A test id that lives on another attribute ────────────────────────
  //
  // `getByTestId` resolves only data-testid (nothing here configures
  // Playwright's testIdAttribute), so a locator recorded off data-test-id or
  // data-test is emitted as an attribute selector — and the parser must read
  // that selector back as the SAME testid locator, or a hand edit of the
  // Script tab silently relabels the step and drops which attribute it meant.
  roundTrip({ k: "testid", attr: "data-test-id", v: "save" }, "testid on data-test-id");
  roundTrip({ k: "testid", attr: "data-test", v: "save" }, "testid on data-test");
  roundTrip({ k: "testid", attr: "data-test", v: 'a"b' }, "a quote in a data-test value");
  roundTrip({ k: "testid", attr: "data-test", v: "a\\b" }, "a backslash in a data-test value");
  roundTrip(
    {
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "testid", attr: "data-test", v: "card" } },
    },
    "a data-test container",
  );
  roundTrip(
    { k: "testid", attr: "data-test-id", v: "edit", nth: 1 },
    "an indexed testid on data-test-id",
  );

  // ── 8. A refinement the model still has no field for is REFUSED ──────────
  //
  // `.filter()` on the target (rather than on a container) has no counterpart
  // in `LocatorContext`. Reading it as a bare locator would drop the filter and
  // regenerate a step matching MORE elements than the script says — the silent
  // widening the original `.nth()` comment warns about. It stays unclassified,
  // which the caller reports as a skip.
  {
    const source = gen([step({ type: "click", locator: { k: "text", v: "Save" } })]).replace(
      'page.getByText("Save")',
      'page.getByText("Save").filter({ hasText: "now" })',
    );
    const parsed = parseSpecDetailed(source);
    assert(
      parsed.steps.filter((s) => s.type === "click").length === 0,
      "a target-level .filter() is refused rather than silently dropped",
    );
    assert(parsed.skipped > 0, "…and is reported as a skip");
  }

  // ── 9. A whole script of context-carrying steps ──────────────────────────
  //
  // Round-tripping one step at a time would not catch a parser that consumed
  // too much of the line and swallowed the NEXT statement.
  {
    const steps: Step[] = [
      step({ type: "goto", url: "https://example.com" }),
      step({
        type: "click",
        locator: { k: "role", role: "button", name: "Edit", ctx: { within: { k: "testid", v: "billing" } } },
      }),
      step({
        type: "fill",
        locator: { k: "label", v: "Card", ctx: { within: { k: "testid", v: "billing" } } },
        value: "4242",
      }),
      step({
        type: "assert",
        assert: "visible",
        locator: {
          k: "text",
          v: "Saved",
          ctx: { within: { k: "role", role: "region" }, withinHasText: "Billing" },
        },
      }),
      step({ type: "click", locator: { k: "testid", v: "done" } }),
    ];
    const source = gen(steps);
    const parsed = parseSpecDetailed(source);
    assertEqual(parsed.steps.length, steps.length, "a mixed script round-trips every step");
    assertEqual(parsed.skipped, 0, "…with nothing left unclassified");
    assertEqual(gen(parsed.steps), source, "…and regenerates identically");
  }

  // ── 10. Context survives a hand edit elsewhere in the file ───────────────
  //
  // The real-world shape of the original bug: a user edits the Script tab, the
  // app re-parses, and steps it cannot read vanish. Splicing an unrelated line
  // in must not disturb the context-carrying ones around it.
  {
    const steps: Step[] = [
      step({ type: "goto", url: "https://example.com" }),
      step({
        type: "click",
        locator: { k: "role", role: "button", name: "Edit", ctx: { within: { k: "testid", v: "billing" } } },
      }),
      step({ type: "click", locator: { k: "testid", v: "done" } }),
    ];
    const source = gen(steps);
    const lines = source.split("\n");
    const at = lines.findIndex((l) => l.includes("Edit"));
    assert(at >= 0, "the context-carrying line is in the generated source");
    lines.splice(at + 1, 0, "  await page.waitForTimeout(500);");
    const reparsed = parseSpec(lines.join("\n"));
    assertEqual(reparsed.length, 4, "the spliced script parses to 4 steps");
    assertEqual(
      reparsed[1].locator?.ctx?.within,
      { k: "testid", v: "billing" },
      "…and the context is still on the step it belonged to",
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll locator round-trip checks passed");
}

main();
