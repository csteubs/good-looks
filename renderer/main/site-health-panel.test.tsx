// The per-test Site Health tab: what the last MEASURING run read, said in
// the Output line's own words, with the way through to the domain's series.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { SiteHealthTestResult } from "../../shared/site-health.mjs";
import type { TestRecord } from "../lib/recorder-types";
import { SiteHealthPanel } from "./site-health-panel";

const h = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
  useRouterState: () => "/test/t1",
}));

let result: SiteHealthTestResult | null = null;
vi.mock("../lib/api", () => ({
  api: { siteHealth: { forTest: async () => result } },
}));

const AUG_28 = Date.UTC(2026, 7, 28, 12, 0, 0);

function reading(over: Record<string, unknown> = {}) {
  return {
    id: "doc",
    url: "https://shop.example.com/",
    host: "shop.example.com",
    path: "/",
    title: "Home",
    tab: 0,
    cold: true,
    navType: "navigate",
    engine: "chromium",
    action: 0,
    at: AUG_28,
    status: 200,
    xRobotsTag: null,
    facts: {
      titleLength: 4, descriptionLength: 90, lang: "en", viewport: true, canonical: [], robots: [],
      h1Count: 1, imagesTotal: 0, imagesMissingAlt: 0, links: { total: 0, generic: 0, uncrawlable: 0 },
      hreflang: [], jsonLd: { blocks: 0, invalid: 0, types: [] },
      og: { title: true, description: true, image: true }, twitterCard: true, protocol: "https:", insecureResources: 0,
    },
    metrics: { ttfb: 100, fcp: 800, lcp: 3400, cls: 0.19, tbt: 30, inp: null, dcl: 900, load: 1500, requests: 12, transferBytes: 1_460_000, coverage: ["fcp", "lcp", "tbt", "cls"] },
    source: "lab" as const,
    ...over,
  };
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SiteHealthPanel test={{ id: "t1", name: "Checkout", url: "https://shop.example.com" } as TestRecord} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  result = null;
});

describe("SiteHealthPanel", () => {
  it("explains the switch when no run has measured", async () => {
    renderPanel();
    expect(await screen.findByText(/No Site Health reading yet/)).toBeTruthy();
    expect(screen.getByText(/Check Site Health/)).toBeTruthy();
  });

  it("describes the run in the Output line's words, lists each host, and opens its series", async () => {
    result = {
      run: { id: "r1", startedAt: AUG_28, status: "passed", ingested: true },
      summary: { pages: 2, ms: 300, hosts: [{ host: "shop.example.com", pages: 2, seo: 78, perf: 54 }] },
      pages: [
        { reading: reading() as never, seo: 100, audits: [], perf: 41, coverage: ["fcp", "lcp", "tbt", "cls"], partial: false },
        { reading: reading({ id: "doc-2", path: "/cart", url: "https://shop.example.com/cart", title: "Cart", engine: "webkit", metrics: { ...reading().metrics, transferBytes: 410_000 } }) as never, seo: 56, audits: [], perf: 67, coverage: ["fcp", "lcp", "tbt"], partial: true },
      ],
    };
    renderPanel();
    expect(await screen.findByText(/2 pages scored on shop\.example\.com/)).toBeTruthy();
    expect(screen.getByText(/Run of 28 Aug, ingested from another machine/)).toBeTruthy();
    expect(screen.getByText(/SEO 78 · performance 54 · 2 pages/)).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Transferred" })).toBeTruthy();
    expect(screen.getByText("1.4 MB")).toBeTruthy();
    expect(screen.getByText("webkit (partial)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Site Health for shop.example.com" }));
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/site-health/$host/$category",
      params: { host: "shop.example.com", category: "seo" },
    });
  });

  it("reports a run that measured nothing as the probe's fault, never as a clean site", async () => {
    result = {
      run: { id: "r1", startedAt: AUG_28, status: "passed", ingested: false },
      summary: { pages: 0, ms: 12, hosts: [] },
      pages: [],
    };
    renderPanel();
    const line = await screen.findByText(/Site Health:/);
    expect(line.textContent).toMatch(/no page was scored/);
    expect(line.textContent).not.toMatch(/\d+ pages? scored/);
  });

  it("says when the per-page readings are gone but the summary remains", async () => {
    result = {
      run: { id: "r1", startedAt: AUG_28, status: "passed", ingested: false },
      summary: { pages: 3, ms: 300, hosts: [{ host: "shop.example.com", pages: 3, seo: 80, perf: 60 }] },
      pages: [],
    };
    renderPanel();
    expect(await screen.findByText(/have been cleaned up/)).toBeTruthy();
  });
});
