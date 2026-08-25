// Which pace a run goes at, and how many tests a fresh install runs at once.
//
// Both are R18: shipped defaults that were chosen once and then never revisited,
// each costing everyone who never found the picker. The decisions are pure
// functions precisely so they can be argued with here rather than inferred from
// a run that took four minutes.
//
// Lives under `main/` rather than beside `shared/run-pacing.mjs` for the reason
// `branch-paths.test.ts` gives: vitest's node project takes `main/**`, `mcp/**`
// and `renderer/lib/**`, so a test file under `shared/` matches neither project
// and would pass by never running.

import { describe, it, expect } from "vitest";

import { resolveRunSpeed } from "../../shared/run-pacing.mjs";
import { batchConcurrencyForCores } from "./recorder-settings-store.js";
import { MAX_BATCH_CONCURRENCY } from "../recorder/types.js";

describe("resolveRunSpeed", () => {
  it("prefers this run's override over everything", () => {
    // The point of the layer: watch one test crawl without editing the test and
    // remembering to put it back.
    expect(resolveRunSpeed("crawl", "fast", "medium")).toBe("crawl");
  });

  it("falls back to the test's own pin when there is no override", () => {
    expect(resolveRunSpeed(undefined, "slow", "medium")).toBe("slow");
  });

  it("falls back to the global default when the test pins nothing", () => {
    // THE behaviour recordings now rely on. They stopped stamping their speed,
    // so an unpinned test has to follow the setting — otherwise the New
    // recording dialog's Run speed picker would be a control that does nothing.
    expect(resolveRunSpeed(undefined, undefined, "slow")).toBe("slow");
  });

  it("lands on fast only when nothing at all is known", () => {
    // The MCP and anything predating the setting. Not a policy, a floor.
    expect(resolveRunSpeed(undefined, undefined, undefined)).toBe("fast");
  });

  it("skips an unrecognised value at any layer instead of passing it on", () => {
    // The failure this exists to prevent: an unknown key reaching `SLOW_MO_MS`
    // resolves to `undefined`, which runs the test at FULL SPEED — the exact
    // opposite of what someone asking for "crawl" wanted, and silent.
    expect(resolveRunSpeed("turbo", "slow", "medium")).toBe("slow");
    expect(resolveRunSpeed(undefined, "", "medium")).toBe("medium");
    expect(resolveRunSpeed("", "", "nonsense")).toBe("fast");
  });
});

describe("batchConcurrencyForCores", () => {
  it("gives half the cores to browsers", () => {
    // A lane is a BROWSER, not a thread: it wants a core to itself plus room
    // for the app, the runner and the OS. Half is the conservative reading of
    // "stop running sixty tests one at a time on an eight-core laptop".
    expect(batchConcurrencyForCores(8)).toBe(4);
    expect(batchConcurrencyForCores(16)).toBe(8);
  });

  it("never returns less than one, whatever the machine says", () => {
    // A zero here would ship a batch that runs no tests at all.
    expect(batchConcurrencyForCores(1)).toBe(1);
    expect(batchConcurrencyForCores(2)).toBe(1);
    expect(batchConcurrencyForCores(0)).toBe(1);
    expect(batchConcurrencyForCores(-4)).toBe(1);
    expect(batchConcurrencyForCores(Number.NaN)).toBe(1);
  });

  it("never exceeds the picker's own maximum", () => {
    // The stored value is clamped to this on write, so seeding above it would
    // put the shipped default outside the range the UI can express.
    expect(batchConcurrencyForCores(128)).toBe(MAX_BATCH_CONCURRENCY);
  });
});
