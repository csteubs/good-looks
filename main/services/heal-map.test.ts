// The heal map an UNATTENDED run builds is one the fixture can actually use.
//
// This is R49's property, and the reason it needs its own test: every part of
// run-time Auto-Heal can be present and correct while the feature does nothing,
// because the fixture's first line on a failed action is
//
//     if (!entry || !entry.probe || !isResolveFailure(err)) throw err;
//
// A missing map, a key spelled differently from the one the fixture derives
// from Playwright's factory arguments, or an entry without a probe are all the
// same outcome: healing is off, silently, while the environment says it is on.
// That shipped, on every MCP and CLI run, from R8 until R51 made the probe
// buildable outside the app.
//
// The app's side is covered by `heal-fixture.test.ts` (key agreement) and
// `check:heal-journal`. What is NOT covered anywhere else is the map built
// WITHOUT `describeStep` — the unattended path — and whether the fixture
// tolerates the one field it therefore lacks.

import { describe, expect, it } from "vitest";

import { healFixtureSource } from "../../shared/heal-fixture-source.mjs";
import { healKeyFor } from "../../shared/heal-key.mjs";
import { buildHealMap } from "../../shared/heal-map.mjs";
import type { Step } from "../recorder/types.js";

const steps = [
  { id: "s1", type: "click", locator: { k: "role", role: "button", name: "Save" } },
  { id: "s2", type: "fill", value: "x", locator: { k: "testid", v: "email" } },
  { id: "s3", type: "click", locator: { k: "testid", v: "email", attr: "data-test-id" } },
  {
    id: "s4",
    type: "click",
    locator: { k: "text", v: "Sign in", exact: true, ctx: { within: { k: "testid", v: "card" } } },
  },
  { id: "s5", type: "click", disabled: true, locator: { k: "css", v: ".disabled" } },
  { id: "s6", type: "click", locator: { k: "css", v: ".framed", frame: [{ k: "name", v: "f" }] } },
  { id: "s7", type: "wait", waitFor: "visible" },
] as unknown as Step[];

describe("the map an unattended run builds", () => {
  it("gives every entry a probe — the field the fixture short-circuits on", () => {
    const map = buildHealMap(steps);
    const entries = Object.values(map) as { probe?: string }[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      // Not just present: a probe is an injected script, and an empty string
      // evaluates to undefined rather than to a candidate list.
      expect(typeof entry.probe).toBe("string");
      expect(entry.probe!.length).toBeGreaterThan(100);
    }
  });

  it("keys entries the way the fixture keys a factory call", () => {
    const map = buildHealMap(steps);
    // The fixture's FACTORIES table builds these from the arguments Playwright
    // was called with. The map is keyed from the Locator MODEL. Both sides go
    // through shared/heal-key.mjs, and this is the assertion that the two
    // spellings meet — a miss here is healing that silently never happens.
    expect(Object.keys(map).sort()).toEqual(
      [
        "role|button|Save",
        "testid|email",
        'css|[data-test-id="email"]',
        "in(testid|card)>text!|Sign in",
      ].sort(),
    );
  });

  it("skips what cannot be healed rather than keying it without a probe", () => {
    const map = buildHealMap(steps);
    // A disabled step, a step with no locator, and a FRAMED step — the probe is
    // a top-document query and cannot reach inside an iframe, so a key it could
    // never rescue is worse than no key: it makes the fixture take the heal path
    // and fail there.
    expect(map[healKeyFor({ k: "css", v: ".disabled" })]).toBeUndefined();
    expect(map[healKeyFor({ k: "css", v: ".framed" })]).toBeUndefined();
  });

  it("first step wins a key collision", () => {
    const dupes = [
      { id: "a", type: "click", locator: { k: "css", v: ".x" } },
      { id: "b", type: "click", locator: { k: "css", v: ".x" } },
    ] as unknown as Step[];
    const map = buildHealMap(dupes) as Record<string, { stepId: string }>;
    expect(map["css|.x"].stepId).toBe("a");
  });
});

describe("the label an unattended run cannot build", () => {
  it("leaves stepLabel empty without describeStep", () => {
    const map = buildHealMap(steps) as Record<string, { stepLabel: string }>;
    for (const entry of Object.values(map)) expect(entry.stepLabel).toBe("");
  });

  it("uses the injected describeStep when one is given", () => {
    const map = buildHealMap(steps, {
      describeStep: (step) => `step ${(step as { id: string }).id}`,
    }) as Record<string, { stepLabel: string }>;
    expect(Object.values(map).map((e) => e.stepLabel).sort()).toEqual(
      ["step s1", "step s2", "step s3", "step s4"].sort(),
    );
  });

  it("is a field the fixture has a fallback for", () => {
    // The empty label is only acceptable because the fixture never prints it
    // bare. If this stops being true, an unattended run's heal artifacts start
    // naming nothing at all, and the map has to carry a label after all.
    expect(healFixtureSource).toContain("entry.stepLabel || entry.stepId");
  });
});

describe("the map and the fixture agree on the entry's shape", () => {
  it("provides every field the fixture reads", () => {
    const map = buildHealMap(steps, { describeStep: () => "x" });
    const [entry] = Object.values(map) as Record<string, unknown>[];
    // Read off the fixture SOURCE rather than listed by hand: a field the
    // fixture starts reading is a field this map has to start providing, and a
    // transcription here would not notice. `entry.probe` is checked above.
    const read = [...healFixtureSource.matchAll(/\bentry\.([A-Za-z]+)\b/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThan(0);
    for (const field of new Set(read)) {
      expect(Object.keys(entry), `fixture reads entry.${field}`).toContain(field);
    }
  });
});
