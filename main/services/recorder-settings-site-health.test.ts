// The Check Site Health switch's trip through the store, both ways — the
// recorder-settings-popups.test.ts shape, for the same reason: a value refused
// on load but accepted on save is written to disk and then ignored forever
// ("the setting does not work"), and a value accepted that shouldn't be is a
// switch nobody chose.
//
// One key, and its default is the security-shaped one: OFF. A settings file
// that predates it must read as off — the switch turns on a read per action
// and an artifact per run, which is not something an upgrade should start
// doing on its own.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-site-health-settings-test-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { recorderSettingsStore } = await import("./recorder-settings-store.js");

const settingsFile = path.join(userData, "recorder", "recorder-settings.json");

function writeRaw(patch: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(patch), "utf-8");
}

function onDisk(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
  fs.rmSync(settingsFile, { force: true });
});

afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("siteHealthChecks", () => {
  it("ships OFF", () => {
    expect(recorderSettingsStore.get().siteHealthChecks).toBe(false);
  });

  it("reads a settings file written before the key existed as off", () => {
    writeRaw({ showUrlBar: false });
    const s = recorderSettingsStore.get();
    expect(s.showUrlBar).toBe(false);
    expect(s.siteHealthChecks).toBe(false);
  });

  it("round-trips on, and it is on disk", () => {
    recorderSettingsStore.set({ siteHealthChecks: true });
    expect(recorderSettingsStore.get().siteHealthChecks).toBe(true);
    expect(onDisk().siteHealthChecks).toBe(true);
  });

  it("round-trips off again", () => {
    recorderSettingsStore.set({ siteHealthChecks: true });
    recorderSettingsStore.set({ siteHealthChecks: false });
    expect(recorderSettingsStore.get().siteHealthChecks).toBe(false);
    expect(onDisk().siteHealthChecks).toBe(false);
  });

  it("leaves it alone when a save does not mention it", () => {
    recorderSettingsStore.set({ siteHealthChecks: true });
    recorderSettingsStore.set({ showUrlBar: false });
    expect(recorderSettingsStore.get().siteHealthChecks).toBe(true);
  });

  it("refuses a non-boolean on load and on save", () => {
    writeRaw({ siteHealthChecks: "yes" });
    expect(recorderSettingsStore.get().siteHealthChecks).toBe(false);
    recorderSettingsStore.set({ siteHealthChecks: 1 as unknown as boolean });
    expect(recorderSettingsStore.get().siteHealthChecks).toBe(false);
    expect(onDisk().siteHealthChecks).toBe(false);
  });
});
