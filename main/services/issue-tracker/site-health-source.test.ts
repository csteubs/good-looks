// The Site Health defect source at the IPC boundary, and the draft's shape
// from a domain's detail.
//
// `normalizeSource` REBUILDS a source: every field becomes part of a stored
// link key and of a deep link written into someone else's tracker, so a host
// that is not a host and a category that is not in the vocabulary are refused
// outright. `siteHealthDefectFrom` is the pure half of the loader — the part a
// test can drive without a metrics database — and what it pins is that a
// page's TITLE never reaches the defect while its path and score do.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { SiteHealthHostDetail } from "../../../shared/site-health.mjs";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-site-health-source-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { issueTrackerService } = await import("./issue-tracker-service.js");
const { siteHealthDefectFrom } = await import("./defect-loader.js");

afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const RAW = {
  kind: "site-health",
  host: "WWW.Shop.Example.com",
  category: "performance",
  testId: "t1",
  runId: "r1",
  sinceMs: 1_700_000_000_000,
};

describe("normalizeSource for site-health", () => {
  it("rebuilds a well-formed source, folding the host", () => {
    expect(issueTrackerService.normalizeSource(RAW)).toEqual({
      kind: "site-health",
      host: "shop.example.com",
      category: "performance",
      testId: "t1",
      runId: "r1",
      sinceMs: 1_700_000_000_000,
    });
  });

  it("reads a missing or negative window as all time", () => {
    expect(issueTrackerService.normalizeSource({ ...RAW, sinceMs: undefined })).toMatchObject({ sinceMs: 0 });
    expect(issueTrackerService.normalizeSource({ ...RAW, sinceMs: -5 })).toMatchObject({ sinceMs: 0 });
    expect(issueTrackerService.normalizeSource({ ...RAW, sinceMs: "soon" })).toMatchObject({ sinceMs: 0 });
  });

  it("refuses a host that is not a host, a category outside the vocabulary, and a bad anchor", () => {
    expect(issueTrackerService.normalizeSource({ ...RAW, host: "not a host" })).toBeNull();
    expect(issueTrackerService.normalizeSource({ ...RAW, host: "../etc" })).toBeNull();
    expect(issueTrackerService.normalizeSource({ ...RAW, category: "speed" })).toBeNull();
    expect(issueTrackerService.normalizeSource({ ...RAW, runId: "../r1" })).toBeNull();
    expect(issueTrackerService.normalizeSource({ ...RAW, testId: "" })).toBeNull();
  });

  it("carries no key the sender invented", () => {
    const out = issueTrackerService.normalizeSource({ ...RAW, extra: "x", title: "Page Title" });
    expect(out && "extra" in out).toBe(false);
    expect(out && "title" in out).toBe(false);
  });
});

describe("siteHealthDefectFrom", () => {
  const detail: SiteHealthHostDetail = {
    host: "shop.example.com",
    since: 100,
    until: 200,
    runs: 4,
    readings: 8,
    pageCount: 2,
    seo: { score: 78, prev: 80 },
    perf: { score: 54, prev: 58 },
    series: [],
    pages: [
      { path: "/", url: "https://shop.example.com/", title: "Secret Home Title", seo: 100, perf: 41, audits: [], coverage: ["fcp", "lcp", "tbt", "cls"], fcp: 1, lcp: 3400, cls: 0.19, tbt: 1, inp: null, ttfb: 1, dcl: 1, load: 1, requests: 1, transferBytes: 1, engine: "chromium", cold: true, navType: "navigate", status: 200, at: 150, runId: "r1", testId: "t1", testName: "Checkout" },
      { path: "/cart", url: "https://shop.example.com/cart", title: "Cart", seo: 56, perf: 67, audits: [], coverage: ["fcp"], fcp: 1, lcp: null, cls: null, tbt: null, inp: null, ttfb: 1, dcl: 1, load: 1, requests: 1, transferBytes: 1, engine: "webkit", cold: false, navType: "navigate", status: 200, at: 150, runId: "r1", testId: "t1", testName: "Checkout" },
    ],
    findings: [{ id: "meta-description", label: "Meta description present", status: "fail", pages: 1, of: 2, examples: [] }],
    info: [],
    vitals: {
      lcp: { p75: 3400, n: 2, status: "over" },
      cls: { p75: 0.19, n: 2, status: "over" },
      inp: { p75: null, n: 0, status: null },
      ttfb: { p75: 180, n: 2, status: "within" },
      fcp: { p75: 900, n: 2, status: "within" },
      tbt: { p75: 60, n: 2, status: "within" },
    },
    engines: [],
    tests: [{ testId: "t1", testName: "Checkout" }],
  };
  const source = { kind: "site-health" as const, host: "shop.example.com", category: "performance" as const, testId: "t1", runId: "r1", sinceMs: 100 };

  it("takes the category's score, pages and vitals — never a page title", () => {
    const defect = siteHealthDefectFrom(source, detail);
    expect(defect).toMatchObject({ kind: "site-health", host: "shop.example.com", category: "performance", score: 54, prev: 58, runs: 4 });
    expect((defect as { pages: unknown }).pages).toEqual([{ path: "/", score: 41 }, { path: "/cart", score: 67 }]);
    expect((defect as { findings: unknown[] }).findings).toEqual([]);
    const vitals = (defect as { vitals: { label: string; over: boolean }[] }).vitals;
    expect(vitals.map((v) => v.label)).toEqual(["LCP", "CLS", "TTFB", "FCP", "TBT"]);
    expect(vitals.find((v) => v.label === "LCP")).toEqual({ label: "LCP", value: "3.4 s", target: "2.5 s", over: true });
    expect(JSON.stringify(defect)).not.toContain("Secret Home Title");
  });

  it("takes the SEO score and findings on the SEO tab, and no vitals", () => {
    const defect = siteHealthDefectFrom({ ...source, category: "seo" }, detail);
    expect(defect).toMatchObject({ category: "seo", score: 78, prev: 80 });
    expect((defect as { pages: unknown }).pages).toEqual([{ path: "/", score: 100 }, { path: "/cart", score: 56 }]);
    expect((defect as { findings: unknown }).findings).toEqual([{ label: "Meta description present", pages: 1, of: 2 }]);
    expect((defect as { vitals: unknown[] }).vitals).toEqual([]);
  });
});
