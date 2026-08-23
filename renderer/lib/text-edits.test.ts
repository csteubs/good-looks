import { describe, it, expect } from "vitest";

import { applyTextEdits } from "./text-edits";

describe("applyTextEdits", () => {
  it("applies edits from the end so offsets stay valid, in any given order", () => {
    const text = "abcdef";
    expect(applyTextEdits(text, [{ from: 1, to: 2, text: "BB" }, { from: 4, to: 5, text: "" }])).toBe("aBBcdf");
    expect(applyTextEdits(text, [{ from: 4, to: 5, text: "" }, { from: 1, to: 2, text: "BB" }])).toBe("aBBcdf");
    expect(applyTextEdits(text, [])).toBe(text);
  });
});
