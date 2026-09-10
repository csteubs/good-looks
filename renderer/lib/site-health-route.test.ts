// Which pathnames are Site Health — the one regex three components agree on.

import { describe, expect, it } from "vitest";

import { isSiteHealthPath, parseSiteHealthPath, SITE_HEALTH_PATH, siteHealthPath } from "./site-health-route";

describe("parseSiteHealthPath", () => {
  it("reads the board, a host, and a host's tab", () => {
    expect(parseSiteHealthPath("/site-health")).toEqual({});
    expect(parseSiteHealthPath("/site-health/")).toEqual({});
    expect(parseSiteHealthPath("/site-health/shop.example.com")).toEqual({ host: "shop.example.com" });
    expect(parseSiteHealthPath("/site-health/shop.example.com/performance")).toEqual({
      host: "shop.example.com",
      category: "performance",
    });
    expect(parseSiteHealthPath("/site-health/shop.example.com/seo")).toEqual({
      host: "shop.example.com",
      category: "seo",
    });
  });

  it("decodes the host the way the router encoded it", () => {
    expect(parseSiteHealthPath("/site-health/%5B%3A%3A1%5D/seo")).toEqual({ host: "[::1]", category: "seo" });
  });

  it("drops a category it does not know rather than inventing a tab", () => {
    expect(parseSiteHealthPath("/site-health/shop.example.com/speed")).toEqual({ host: "shop.example.com" });
  });

  it("refuses a path that merely starts with the word, and anything deeper", () => {
    for (const path of ["/site-healthy", "/site-health-x", "/stats/site-health", "/", "/site-health/a/seo/extra"]) {
      expect(parseSiteHealthPath(path), path).toBeNull();
      expect(isSiteHealthPath(path), path).toBe(false);
    }
  });
});

describe("siteHealthPath", () => {
  it("round-trips through the parser", () => {
    expect(siteHealthPath()).toBe(SITE_HEALTH_PATH);
    expect(parseSiteHealthPath(siteHealthPath("shop.example.com"))).toEqual({ host: "shop.example.com" });
    expect(parseSiteHealthPath(siteHealthPath("[::1]", "performance"))).toEqual({ host: "[::1]", category: "performance" });
  });
});
