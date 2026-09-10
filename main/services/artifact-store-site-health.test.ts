// artifact-store.readSiteHealth: the Site Health artifact comes back REBUILT
// through the shared normaliser, never cast.
//
// Every field in site-health.json was written by a fixture reading an
// untrusted page, and this reader is the one place the app takes it in — the
// same boundary rule the step ingest applies (CLAUDE.md, "the capture
// boundary is a security boundary"). A cast would carry every unknown key
// through to the rollup and the view.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { SITE_HEALTH_FILE } from "../../shared/site-health.mjs";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-site-health-artifact-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { artifactStore } = await import("./artifact-store.js");

function page(over: Record<string, unknown> = {}) {
  return {
    id: "doc-a",
    url: "https://www.shop.example.com/products/x",
    host: "shop.example.com",
    path: "/products/x",
    title: "Blue Shoe",
    tab: 0,
    cold: true,
    navType: "navigate",
    engine: "chromium",
    action: 2,
    at: 1_800_000_000_000,
    status: 200,
    xRobotsTag: null,
    facts: {
      titleLength: 9, descriptionLength: 80, lang: "en", viewport: true, canonical: [], robots: [],
      h1Count: 1, imagesTotal: 0, imagesMissingAlt: 0, links: { total: 0, generic: 0, uncrawlable: 0 },
      hreflang: [], jsonLd: { blocks: 0, invalid: 0, types: [] },
      og: { title: true, description: true, image: true }, twitterCard: true, protocol: "https:", insecureResources: 0,
    },
    metrics: { ttfb: 200, fcp: 900, lcp: 1800, cls: 0.02, tbt: 40, inp: null, dcl: 1200, load: 2000, requests: 12, transferBytes: 400000 },
    source: "lab",
    ...over,
  };
}

function write(testId: string, runId: string, body: unknown): void {
  const dir = artifactStore.ensureRunDir(testId, runId);
  fs.writeFileSync(path.join(dir, SITE_HEALTH_FILE), typeof body === "string" ? body : JSON.stringify(body));
}

beforeEach(() => {
  fs.rmSync(path.join(userData, "recorder", "artifacts"), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("readSiteHealth", () => {
  it("reads the artifact the fixture wrote, by the shared filename", () => {
    write("t1", "r1", { testId: "t1", runId: "r1", attempt: 0, ms: 300, pages: [page()] });
    const artifact = artifactStore.readSiteHealth("t1", "r1");
    expect(artifact).not.toBeNull();
    expect(artifact?.pages).toHaveLength(1);
    expect(artifact?.pages[0]?.host).toBe("shop.example.com");
    expect(artifact?.pages[0]?.metrics.lcp).toBe(1800);
    expect(artifact?.ms).toBe(300);
  });

  it("returns null for a run that did not measure, and for a file that is not JSON", () => {
    expect(artifactStore.readSiteHealth("t1", "never")).toBeNull();
    write("t1", "r-bad", "{not json");
    expect(artifactStore.readSiteHealth("t1", "r-bad")).toBeNull();
  });

  it("rebuilds every page: unknown keys are dropped and caps hold", () => {
    write("t1", "r2", {
      testId: "t1",
      runId: "r2",
      attempt: 0,
      ms: 1,
      pages: [
        page({ title: "x".repeat(5000), __proto__polluted: true, extra: "carried?", engine: "netscape" }),
        page({ id: "doc-b", url: "javascript:alert(1)", host: "not a host!", path: "/y" }),
      ],
    });
    const artifact = artifactStore.readSiteHealth("t1", "r2");
    expect(artifact?.pages).toHaveLength(1);
    const only = artifact!.pages[0]!;
    expect(only.title.length).toBeLessThanOrEqual(200);
    expect("extra" in only).toBe(false);
    expect(only.engine).toBe("unknown");
  });

  it("caps the page list", () => {
    const pages = Array.from({ length: 260 }, (_, i) => page({ id: `doc-${i}`, path: `/p/${i}` }));
    write("t1", "r3", { testId: "t1", runId: "r3", attempt: 0, ms: 1, pages });
    expect(artifactStore.readSiteHealth("t1", "r3")?.pages.length).toBe(200);
  });
});
