// The cost settings' trip through the store, both ways.
//
// These three keys are the first persisted settings whose value MULTIPLIES a
// whole screen of figures rather than switching a behaviour on or off, and that
// changes what a bad value looks like. A corrupt `defaultRunBrowser` fails a run
// loudly; a corrupt `costPerCiMinute` renders as a confident "$0.00 spent" or a
// spend figure three orders of magnitude out, and nothing anywhere says so.
//
// The other half is the `set` path. A value refused on load but accepted on
// save is written to disk and then ignored forever, which reads as "the setting
// does not work" rather than "the value was refused" — the same trap `uiScale`
// carries a comment about in the store.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-cost-settings-test-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { recorderSettingsStore } = await import("./recorder-settings-store.js");
const {
  COST_DEFAULT_MINUTES_PER_MANUAL_RUN,
  COST_DEFAULT_PER_CI_MINUTE,
  CI_RUNNER_PRESETS,
} = await import("../../shared/cost-units.mjs");

const settingsFile = path.join(userData, "recorder", "recorder-settings.json");

/** Write a raw settings file, the way a hand edit or a bad migration would. */
function writeRaw(patch: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(patch), "utf-8");
}

beforeEach(() => {
  fs.rmSync(settingsFile, { force: true });
});

describe("defaults", () => {
  it("ships the app's own guesses in US dollars", () => {
    const s = recorderSettingsStore.get();
    expect(s.costCurrency).toBe("usd");
    expect(s.costPerCiMinute).toBe(COST_DEFAULT_PER_CI_MINUTE);
    expect(s.costMinutesPerManualRun).toBe(COST_DEFAULT_MINUTES_PER_MANUAL_RUN);
  });

  it("ships a price that matches no published runner", () => {
    // Which is what makes the Cost pane open on "Custom" and the panel keep
    // saying the numbers are its own. A default that silently equalled a real
    // runner would be the app claiming to know your hardware.
    const rates = CI_RUNNER_PRESETS.map((p) => p.rate);
    expect(rates).not.toContain(COST_DEFAULT_PER_CI_MINUTE);
  });
});

describe("reading a hand-edited file", () => {
  it("clamps a price that would dwarf every figure on the panel", () => {
    writeRaw({ costPerCiMinute: 1e9 });
    expect(recorderSettingsStore.get().costPerCiMinute).toBe(100);
  });

  it("refuses a negative price rather than reporting a suite that earns money", () => {
    writeRaw({ costPerCiMinute: -5 });
    expect(recorderSettingsStore.get().costPerCiMinute).toBe(0);
  });

  it("falls back rather than letting a NaN reach the panel", () => {
    // JSON cannot hold NaN, but it holds `null` and strings, and `Number(null)`
    // is 0 — a confident "free suite" rather than a visible mistake.
    writeRaw({ costPerCiMinute: null, costMinutesPerManualRun: "twelve" });
    const s = recorderSettingsStore.get();
    expect(s.costPerCiMinute).toBe(COST_DEFAULT_PER_CI_MINUTE);
    expect(s.costMinutesPerManualRun).toBe(COST_DEFAULT_MINUTES_PER_MANUAL_RUN);
  });

  it("keeps a real fractional price exactly", () => {
    // The rounding every other numeric setting gets would make this free.
    writeRaw({ costPerCiMinute: 0.062 });
    expect(recorderSettingsStore.get().costPerCiMinute).toBe(0.062);
  });

  it("keeps a price of zero, because a self-hosted runner is free", () => {
    writeRaw({ costPerCiMinute: 0 });
    expect(recorderSettingsStore.get().costPerCiMinute).toBe(0);
  });

  it("refuses zero minutes, which would claim the suite bought nothing", () => {
    writeRaw({ costMinutesPerManualRun: 0 });
    expect(recorderSettingsStore.get().costMinutesPerManualRun).toBe(0.5);
  });

  it("refuses a currency the picker does not offer", () => {
    writeRaw({ costCurrency: "dogecoin" });
    expect(recorderSettingsStore.get().costCurrency).toBe("usd");
  });
});

describe("saving", () => {
  it("round-trips a legitimate change", () => {
    const saved = recorderSettingsStore.set({
      costCurrency: "gbp",
      costPerCiMinute: 0.006,
      costMinutesPerManualRun: 25,
    });
    expect(saved.costCurrency).toBe("gbp");
    expect(saved.costPerCiMinute).toBe(0.006);
    expect(recorderSettingsStore.get().costPerCiMinute).toBe(0.006);
  });

  it("applies the same clamps on the way in as on the way out", () => {
    // A value accepted here but refused by `read` is one that is written to
    // disk and then silently ignored on every subsequent launch.
    expect(recorderSettingsStore.set({ costPerCiMinute: 1e9 }).costPerCiMinute).toBe(100);
    expect(recorderSettingsStore.set({ costMinutesPerManualRun: 0 }).costMinutesPerManualRun).toBe(
      0.5,
    );
    expect(
      recorderSettingsStore.set({ costCurrency: "dogecoin" as never }).costCurrency,
    ).not.toBe("dogecoin");
  });

  it("leaves the other two alone when only one is patched", () => {
    recorderSettingsStore.set({ costCurrency: "eur", costPerCiMinute: 0.01 });
    const next = recorderSettingsStore.set({ costMinutesPerManualRun: 30 });
    expect(next.costCurrency).toBe("eur");
    expect(next.costPerCiMinute).toBe(0.01);
  });
});
