// The Handle pop-ups settings' trip through the store, both ways — the same
// shape as recorder-settings-proxy.test.ts, and for the same reason: a value
// refused on load but accepted on save is written to disk and then ignored
// forever ("the setting does not work"), and a value accepted that shouldn't
// be is a switch nobody chose.
//
// Two keys, two failure modes. `defaultHandlePopups` is what every test with
// no pin of its own follows; a settings file that predates it MUST read as ON,
// because taught overlay rules were always on before the switch existed and a
// default of off would turn every one of them silently off (the shipped
// default is spelled once, in shared/popup-presets.mjs, and asserted there —
// here it is asserted as the literal, so a flipped default fails THIS file
// too). `disabledPopupPresets` is a list of preset ids, and a ghost id in it —
// a preset renamed, removed, or never real — is a switch for nothing: the
// store rebuilds the list from known ids on both paths rather than storing
// what it was handed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { POPUP_PRESETS } from "../../shared/popup-presets.mjs";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-popup-settings-test-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { recorderSettingsStore } = await import("./recorder-settings-store.js");

const settingsFile = path.join(userData, "recorder", "recorder-settings.json");

/** Write a raw settings file, the way a hand edit or an older version would. */
function writeRaw(patch: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(patch), "utf-8");
}

/** What is actually on disk — the half `get()` cannot vouch for. */
function onDisk(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
  fs.rmSync(settingsFile, { force: true });
});

afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("defaults", () => {
  it("ships with pop-up handling ON and no preset disabled", () => {
    const s = recorderSettingsStore.get();
    expect(s.defaultHandlePopups).toBe(true);
    expect(s.disabledPopupPresets).toEqual([]);
  });

  it("reads a settings file written before the keys existed as the defaults", () => {
    // An upgrade must not turn the taught rules off. `showUrlBar` proves the
    // file was read rather than ignored.
    writeRaw({ showUrlBar: false, autoHealEnabled: true });
    const s = recorderSettingsStore.get();
    expect(s.showUrlBar).toBe(false);
    expect(s.defaultHandlePopups).toBe(true);
    expect(s.disabledPopupPresets).toEqual([]);
  });
});

describe("reading a hand-edited file", () => {
  it("keeps a valid choice exactly", () => {
    writeRaw({ defaultHandlePopups: false, disabledPopupPresets: ["datagrail-consent-close"] });
    const s = recorderSettingsStore.get();
    expect(s.defaultHandlePopups).toBe(false);
    expect(s.disabledPopupPresets).toEqual(["datagrail-consent-close"]);
  });

  it("falls back on a non-boolean switch and drops unknown preset ids", () => {
    writeRaw({
      defaultHandlePopups: "yes",
      disabledPopupPresets: ["nope", "klaviyo-form-close", 7, null, "klaviyo-form-close"],
    });
    const s = recorderSettingsStore.get();
    expect(s.defaultHandlePopups).toBe(true);
    expect(s.disabledPopupPresets).toEqual(["klaviyo-form-close"]);
  });

  it("reads a disabled list that is not a list as nothing disabled", () => {
    writeRaw({ disabledPopupPresets: "klaviyo-form-close" });
    expect(recorderSettingsStore.get().disabledPopupPresets).toEqual([]);
  });
});

describe("saving over IPC", () => {
  it("persists a disabled list rebuilt from known ids only", () => {
    const saved = recorderSettingsStore.set({
      disabledPopupPresets: ["nope", "klaviyo-form-close"],
    });
    expect(saved.disabledPopupPresets).toEqual(["klaviyo-form-close"]);
    expect(recorderSettingsStore.get().disabledPopupPresets).toEqual(["klaviyo-form-close"]);
    // The ghost never reaches the file either — "refused on save" has to mean
    // refused, not stored-and-ignored.
    expect(onDisk().disabledPopupPresets).toEqual(["klaviyo-form-close"]);
  });

  it("can disable every shipped preset, and re-enable them with an empty list", () => {
    const all = POPUP_PRESETS.map((p) => p.id);
    expect(recorderSettingsStore.set({ disabledPopupPresets: all }).disabledPopupPresets).toEqual(all);
    expect(recorderSettingsStore.set({ disabledPopupPresets: [] }).disabledPopupPresets).toEqual([]);
    expect(onDisk().disabledPopupPresets).toEqual([]);
  });

  it("keeps the current switch when handed something that is not a boolean", () => {
    // Twice, from both states: "keeps the current value" is not "resets to
    // the default", and only the second case tells them apart.
    const first = recorderSettingsStore.set({
      defaultHandlePopups: "yes" as unknown as boolean,
    });
    expect(first.defaultHandlePopups).toBe(true);

    recorderSettingsStore.set({ defaultHandlePopups: false });
    const second = recorderSettingsStore.set({
      defaultHandlePopups: "yes" as unknown as boolean,
    });
    expect(second.defaultHandlePopups).toBe(false);
    expect(recorderSettingsStore.get().defaultHandlePopups).toBe(false);
  });

  it("persists the switch off, and back on", () => {
    const off = recorderSettingsStore.set({ defaultHandlePopups: false });
    expect(off.defaultHandlePopups).toBe(false);
    expect(recorderSettingsStore.get().defaultHandlePopups).toBe(false);
    expect(onDisk().defaultHandlePopups).toBe(false);

    const on = recorderSettingsStore.set({ defaultHandlePopups: true });
    expect(on.defaultHandlePopups).toBe(true);
    expect(onDisk().defaultHandlePopups).toBe(true);
  });

  it("leaves both keys alone when an unrelated setting is saved", () => {
    recorderSettingsStore.set({
      defaultHandlePopups: false,
      disabledPopupPresets: ["datagrail-consent-close"],
    });
    const s = recorderSettingsStore.set({ showUrlBar: false });
    expect(s.defaultHandlePopups).toBe(false);
    expect(s.disabledPopupPresets).toEqual(["datagrail-consent-close"]);
  });
});
