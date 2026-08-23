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
