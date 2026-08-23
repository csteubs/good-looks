// Standing AI instructions: capped text, hosts normalized, table replaced
// whole — the three rules that make the setting the same on disk as in the
// pane.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-ai-instructions-test-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { recorderSettingsStore, AI_INSTRUCTIONS_MAX } = await import("./recorder-settings-store.js");
const { INSPECTION_RULES } = await import("../../shared/inspections.mjs");
const settingsFile = path.join(userData, "recorder", "recorder-settings.json");

function writeRaw(patch: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(patch), "utf-8");
}

beforeEach(() => {
  fs.rmSync(settingsFile, { force: true });
});

describe("aiInstructions", () => {
  it("defaults to empty, and a non-string on disk reads as empty", () => {
    expect(recorderSettingsStore.get().aiInstructions).toBe("");
    expect(recorderSettingsStore.get().aiInstructionsByHost).toEqual({});
    writeRaw({ aiInstructions: 42, aiInstructionsByHost: ["x"] });
    expect(recorderSettingsStore.get().aiInstructions).toBe("");
    expect(recorderSettingsStore.get().aiInstructionsByHost).toEqual({});
  });

  it("caps the text on save and on read", () => {
    recorderSettingsStore.set({ aiInstructions: "x".repeat(AI_INSTRUCTIONS_MAX + 10) });
    expect(recorderSettingsStore.get().aiInstructions).toHaveLength(AI_INSTRUCTIONS_MAX);
    writeRaw({ aiInstructions: "y".repeat(AI_INSTRUCTIONS_MAX + 10) });
    expect(recorderSettingsStore.get().aiInstructions).toHaveLength(AI_INSTRUCTIONS_MAX);
  });

  it("lowercases and trims hosts, drops blank texts, and replaces the table whole", () => {
    recorderSettingsStore.set({ aiInstructionsByHost: { " Shop.Example.com ": "Cart is a dialog.", "blank.example": "   " } });
    expect(recorderSettingsStore.get().aiInstructionsByHost).toEqual({ "shop.example.com": "Cart is a dialog." });
    recorderSettingsStore.set({ aiInstructionsByHost: { "other.example": "x" } });
    expect(recorderSettingsStore.get().aiInstructionsByHost).toEqual({ "other.example": "x" });
    // An update that does not mention the table leaves it alone.
    recorderSettingsStore.set({ aiInstructions: "global" });
    expect(recorderSettingsStore.get().aiInstructionsByHost).toEqual({ "other.example": "x" });
  });
});

describe("inspections", () => {
  it("defaults every rule on, rebuilds over the known rules, and merges a patch", () => {
    const all = recorderSettingsStore.get().inspections;
    expect(Object.keys(all).sort()).toEqual([...INSPECTION_RULES].sort());
    expect(Object.values(all).every((v) => v === true)).toBe(true);
    writeRaw({ inspections: { "no-wait-for-timeout": false, "made-up": false, "missing-await": "no" } });
    const read = recorderSettingsStore.get().inspections;
    expect(read["no-wait-for-timeout"]).toBe(false);
    expect(read["missing-await"]).toBe(true);
    expect("made-up" in read).toBe(false);
    recorderSettingsStore.set({ inspections: { "raw-css-locator": false } as never });
    const after = recorderSettingsStore.get().inspections;
    expect(after["raw-css-locator"]).toBe(false);
    expect(after["no-wait-for-timeout"]).toBe(false);
  });
});

describe("page stylesheet and init script", () => {
  it("default to empty, keep text as written, cap it, and read a non-string as empty", async () => {
    const { USER_PAGE_TEXT_MAX } = await import("./recorder-settings-store.js");
    expect(recorderSettingsStore.get().userStylesheet).toBe("");
    expect(recorderSettingsStore.get().userInitScript).toBe("");
    recorderSettingsStore.set({ userStylesheet: "#a {\n  display: none;\n}", userInitScript: "window.x = 1;" });
    expect(recorderSettingsStore.get().userStylesheet).toBe("#a {\n  display: none;\n}");
    expect(recorderSettingsStore.get().userInitScript).toBe("window.x = 1;");
    recorderSettingsStore.set({ userInitScript: "y".repeat(USER_PAGE_TEXT_MAX + 1) });
    expect(recorderSettingsStore.get().userInitScript).toHaveLength(USER_PAGE_TEXT_MAX);
    writeRaw({ userStylesheet: 7 });
    expect(recorderSettingsStore.get().userStylesheet).toBe("");
  });
});
