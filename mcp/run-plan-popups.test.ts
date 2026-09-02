// What `describeRun` says about pop-up handling on an unattended run.
//
// Two notes, and they mean OPPOSITE things to someone reading a failure under
// a banner. "Handle pop-ups is off for this test" says the test armed nothing
// by its own choice — the fix is a run option, not a bug. "Installed no
// dismissal watcher" says the test WANTED its rules and the run did not deliver
// them — an imported spec, or a caller that predates the fixture work. Saying
// the second when the first is true sends a user to debug a watcher that was
// switched off on purpose; saying nothing at all is how a banner-covered
// failure gets read as a broken locator.
//
// And neither note is worth printing for a host with no taught rules: a
// caveat on every run of every test is the kind people learn to skip past,
// and then miss the one time it matters. The presets have no host, so they
// are never the reason a note appears — only a rule taught for THIS host is.
//
// The switch is resolved the way the run itself resolves it, through
// `resolveHandlePopups` (the test's field, else the setting, else the shipped
// default) — the fourth row is what would go red if the note read the field
// alone.

import { describe, expect, it } from "vitest";

import type { RecorderSettings } from "../main/recorder/types.js";
import type { OverlayRuleLike } from "../shared/overlay-rules.mjs";
import { describeRun } from "./run-plan.mjs";
import type { PlannedTest } from "./run-plan.mjs";

const RITUAL = "https://www.ritual.com/";

/** A rule taught on ritual.com's cookie banner. */
function rule(over: Partial<OverlayRuleLike> = {}): OverlayRuleLike {
  return {
    id: "r1",
    host: "ritual.com",
    label: "Cookie banner — Close",
    target: { k: "css", v: ".dg-header-close" },
    ...over,
  };
}

/** `describeRun` takes `overlayRules` and `ran` (R8/R51), which its hand-written
 *  declaration in run-plan.d.mts does not yet list — so the options are built
 *  here and narrowed at the call rather than as a literal the excess-property
 *  check would refuse. */
type DescribeRunOpts = NonNullable<Parameters<typeof describeRun>[2]> & {
  overlayRules?: readonly OverlayRuleLike[];
  ran?: { overlayRules?: readonly string[] };
};

/** The report's skipped lines, `[]` when the report carries none. */
function skippedFor(
  test: PlannedTest,
  settings: Partial<RecorderSettings>,
  opts: Omit<DescribeRunOpts, "speed">,
): string[] {
  const full: DescribeRunOpts = { speed: "fast", ...opts };
  return describeRun(test, settings, full as Parameters<typeof describeRun>[2]).skipped ?? [];
}

const OFF_NOTE = /^Handle pop-ups is off for this test/;
const NOT_ARMED_NOTE = /installed no dismissal watcher/;

describe("describeRun — Handle pop-ups", () => {
  it("names the taught rule a test switched off, in the test's own words", () => {
    const skipped = skippedFor(
      { url: RITUAL, handlePopups: false, steps: [] },
      {},
      { overlayRules: [rule()] },
    );
    const off = skipped.filter((line) => OFF_NOTE.test(line));
    expect(off).toHaveLength(1);
    expect(off[0]).toContain("overlay rule (Cookie banner — Close)");
    // Not the other note: a switched-off test did not lose its watcher.
    expect(skipped.some((line) => NOT_ARMED_NOTE.test(line))).toBe(false);
  });

  it("pluralises when more than one rule was taught for the host", () => {
    const skipped = skippedFor(
      { url: RITUAL, handlePopups: false, steps: [] },
      {},
      { overlayRules: [rule(), rule({ id: "r2", label: "Newsletter — Close" })] },
    );
    const off = skipped.filter((line) => OFF_NOTE.test(line));
    expect(off).toHaveLength(1);
    expect(off[0]).toContain("overlay rules (Cookie banner — Close, Newsletter — Close)");
  });

  it("keeps the older caveat for a run that wanted its rules and armed none", () => {
    const skipped = skippedFor(
      { url: RITUAL, handlePopups: true, steps: [] },
      {},
      { overlayRules: [rule()], ran: { overlayRules: [] } },
    );
    const caveat = skipped.filter((line) => NOT_ARMED_NOTE.test(line));
    expect(caveat).toHaveLength(1);
    expect(caveat[0]).toContain("Cookie banner — Close");
    expect(skipped.some((line) => OFF_NOTE.test(line))).toBe(false);
  });

  it("says nothing when handling is on and the run armed the rules", () => {
    const skipped = skippedFor(
      { url: RITUAL, handlePopups: true, steps: [] },
      {},
      { overlayRules: [rule()], ran: { overlayRules: ["Cookie banner — Close"] } },
    );
    expect(skipped.some((line) => OFF_NOTE.test(line))).toBe(false);
    expect(skipped.some((line) => NOT_ARMED_NOTE.test(line))).toBe(false);
  });

  it("resolves a test with no field through the global default, like the run does", () => {
    const skipped = skippedFor(
      { url: RITUAL, steps: [] },
      { defaultHandlePopups: false },
      { overlayRules: [rule()], ran: { overlayRules: [] } },
    );
    expect(skipped.filter((line) => OFF_NOTE.test(line))).toHaveLength(1);
    expect(skipped.some((line) => NOT_ARMED_NOTE.test(line))).toBe(false);

    // And the default ON with no field is the armed-nothing caveat, not the
    // off note — the test never chose.
    const on = skippedFor(
      { url: RITUAL, steps: [] },
      { defaultHandlePopups: true },
      { overlayRules: [rule()], ran: { overlayRules: [] } },
    );
    expect(on.some((line) => OFF_NOTE.test(line))).toBe(false);
    expect(on.filter((line) => NOT_ARMED_NOTE.test(line))).toHaveLength(1);
  });

  it("prints neither note for a host with no taught rules, whatever the switch says", () => {
    // Rules for another host do not count, and the presets never do — they
    // have no host, and a note about them on every run would be noise.
    const elsewhere = [rule({ host: "other.example" })];
    for (const test of [
      { url: RITUAL, handlePopups: false, steps: [] },
      { url: RITUAL, handlePopups: true, steps: [] },
      { url: RITUAL, steps: [] },
    ] as PlannedTest[]) {
      for (const overlayRules of [[], elsewhere]) {
        for (const settings of [{}, { defaultHandlePopups: false }]) {
          const skipped = skippedFor(test, settings, { overlayRules, ran: { overlayRules: [] } });
          expect(skipped.some((line) => OFF_NOTE.test(line)), JSON.stringify(test)).toBe(false);
          expect(skipped.some((line) => NOT_ARMED_NOTE.test(line)), JSON.stringify(test)).toBe(
            false,
          );
        }
      }
    }
  });
});
