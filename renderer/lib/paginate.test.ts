// Proof that the "node" project runs pure renderer logic.
import { describe, it, expect } from "vitest";

import { clampPage, pageCount, pageSlice } from "./paginate";

describe("paginate", () => {
  it("never reports page 1 of 0", () => {
    expect(pageCount(0)).toBe(1);
  });

  it("clamps a page that outlived its list", () => {
    expect(clampPage(5, 20)).toBe(1);
    expect(pageSlice(Array.from({ length: 20 }, (_, i) => i), 5)).toHaveLength(20);
  });
});
