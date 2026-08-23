import { describe, it, expect, vi } from "vitest";

import { makeGhostSource, boundedWindow, BACKOFF_MS, PREFIX_CHARS, SUFFIX_CHARS, MAX_TOKENS } from "./ghost-source";

describe("boundedWindow", () => {
  it("passes a small script through untouched", () => {
    expect(boundedWindow("a\nb", "c\nd")).toEqual({ prefix: "a\nb", suffix: "c\nd" });
  });

  it("cuts a long prefix at a line start and a long suffix at a line end", () => {
    const line = "x".repeat(99) + "\n";
    const prefix = line.repeat(100); // 10000 chars
    const suffix = line.repeat(40); // 4000 chars
    const w = boundedWindow(prefix, suffix);
    expect(w.prefix.length).toBeLessThanOrEqual(PREFIX_CHARS);
    expect(w.prefix.startsWith("x".repeat(99) + "\n")).toBe(true);
    expect(w.suffix.length).toBeLessThanOrEqual(SUFFIX_CHARS);
    expect(w.suffix.endsWith("x")).toBe(true);
    expect(w.suffix.split("\n").every((l) => l.length === 99)).toBe(true);
  });
});

describe("makeGhostSource", () => {
  it("sends the bounded window with the token cap and returns the text", async () => {
    const fim = vi.fn(async () => ({ text: "done" }));
    const source = makeGhostSource(fim);
    const ctrl = new AbortController();
    expect(await source("before", "after", ctrl.signal)).toBe("done");
    expect(fim).toHaveBeenCalledWith({ prefix: "before", suffix: "after", maxTokens: MAX_TOKENS });
  });

  it("returns nothing for a request aborted while in flight", async () => {
    const ctrl = new AbortController();
    const fim = vi.fn(async () => {
      ctrl.abort();
      return { text: "late" };
    });
    expect(await makeGhostSource(fim)("p", "s", ctrl.signal)).toBe("");
  });

  it("backs off after a failure, then asks again once the window has passed", async () => {
    let t = 1000;
    const fim = vi.fn<(p: unknown) => Promise<{ text: string }>>().mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValue({ text: "ok" });
    const source = makeGhostSource(fim, () => t);
    const sig = new AbortController().signal;
    expect(await source("p", "s", sig)).toBe("");
    t += 1000;
    expect(await source("p", "s", sig)).toBe("");
    expect(fim).toHaveBeenCalledTimes(1);
    t += BACKOFF_MS;
    expect(await source("p", "s", sig)).toBe("ok");
    expect(fim).toHaveBeenCalledTimes(2);
  });
});
