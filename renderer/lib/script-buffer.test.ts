import { afterEach, describe, expect, it, vi } from "vitest";

import { isScriptDirty, markScriptDirty, onScriptDirtyChange, resetScriptDirty } from "./script-buffer";

afterEach(() => resetScriptDirty());

describe("script-buffer dirty registry", () => {
  it("tracks dirtiness per test and notifies on a change only", () => {
    const seen = vi.fn();
    const off = onScriptDirtyChange(seen);
    expect(isScriptDirty("a")).toBe(false);
    markScriptDirty("a", true);
    expect(isScriptDirty("a")).toBe(true);
    expect(isScriptDirty("b")).toBe(false);
    markScriptDirty("a", true);
    expect(seen).toHaveBeenCalledTimes(1);
    markScriptDirty("a", false);
    expect(isScriptDirty("a")).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    markScriptDirty("a", true);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
