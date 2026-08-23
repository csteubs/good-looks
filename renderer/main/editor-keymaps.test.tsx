import { describe, it, expect } from "vitest";

import { EDITOR_KEYMAPS, keymapFor, prettyKey, rowsFor } from "./editor-keymaps";

describe("editor keymaps", () => {
  it("every preset binds the core editing commands, each key once, and never ⌘K or ⌘I", () => {
    for (const preset of EDITOR_KEYMAPS) {
      const rows = rowsFor(preset);
      const labels = rows.map((r) => r.label);
      for (const must of ["Toggle line comment", "Move line up", "Move line down", "Delete line", "Go to line", "Find", "Fold step", "Unfold step"]) {
        expect(labels, `${preset} binds ${must}`).toContain(must);
      }
      const keys = rows.map((r) => r.key);
      expect(new Set(keys).size, `${preset} has no duplicate keys`).toBe(keys.length);
      expect(keys.map((k) => k.toLowerCase())).not.toContain("mod-k");
      expect(keys.map((k) => k.toLowerCase())).not.toContain("mod-i");
      for (const b of keymapFor(preset)) expect(typeof b.run).toBe("function");
    }
  });

  it("the presets differ where the editors differ", () => {
    const key = (p: "default" | "jetbrains" | "vscode", label: string) => rowsFor(p).find((r) => r.label === label)?.key;
    expect(key("jetbrains", "Duplicate line")).toBe("Mod-d");
    expect(key("vscode", "Duplicate line")).toBe("Shift-Alt-ArrowDown");
    expect(key("jetbrains", "Go to line")).toBe("Mod-l");
    expect(key("vscode", "Go to line")).toBe("Ctrl-g");
  });

  it("Tab rows are listed but left to the host", () => {
    expect(rowsFor("jetbrains").some((r) => r.key === "Tab")).toBe(true);
    expect(keymapFor("jetbrains").some((b) => b.key === "Tab")).toBe(false);
  });

  it("prettyKey spells a chord for the platform", () => {
    expect(prettyKey("Shift-Mod-k", true)).toBe("⇧⌘K");
    expect(prettyKey("Shift-Mod-k", false)).toBe("Shift+Ctrl+K");
    expect(prettyKey("Mod-k Mod-0", true)).toBe("⌘K ⌘0");
    expect(prettyKey("Alt-ArrowDown", true)).toBe("⌥↓");
  });
});
