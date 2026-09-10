// The Site Health view: the board's sort and copy rules, the window, the tab,
// and the detail's vitals, findings and change line.
//
// The failure modes here are silent — a row scored off the wrong tab, a sort
// that flips one panel and not the other, a delta box that says "0" when
// there is no prior — so every assertion is on TEXT the user reads, and the
// api is mocked at the module (intent, not channel plumbing).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
  SiteHealthHostDetail,
  SiteHealthHostOverview,
  SiteHealthHostResult,
  SiteHealthOverviewResult,
} from "../../shared/site-health.mjs";
import type { DefectSource, IssueLink } from "../lib/issue-types";
import {
  changeDetected,
  deltaText,
  filedSiteHealthLink,
  RANGES,
  shortDate,
  sinceFor,
  siteHealthAnchor,
  SiteHealthView,
  sortHosts,
} from "./site-health-view";

const h = vi.hoisted(() => ({ navigate: vi.fn(), pathname: "/site-health" }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: h.pathname } }),
}));

let overviewResult: SiteHealthOverviewResult;
let hostResult: (host: string) => SiteHealthHostResult;
const overviewCalls: number[] = [];
const hostCalls: [string, number][] = [];

let links: IssueLink[] = [];
vi.mock("../lib/api", () => ({
  api: {
    siteHealth: {
      overview: async (sinceMs: number) => {
        overviewCalls.push(sinceMs);
        return overviewResult;
      },
      host: async (host: string, sinceMs: number) => {
        hostCalls.push([host, sinceMs]);
        return hostResult(host);
      },
    },
    issues: { siteHealthLinks: async () => links },
  },
}));

// The dialog is its own tested component; here it is a window onto the
// SOURCE the view hands it, which is the whole contract of the Send button.
const composed: { source: DefectSource | null; open: boolean }[] = [];
vi.mock("../components/issue-compose-dialog", () => ({
  IssueComposeDialog: (props: { source: DefectSource | null; open: boolean }) => {
    composed.push({ source: props.source, open: props.open });
    return props.open ? <div data-testid="compose">{JSON.stringify(props.source)}</div> : null;
  },
}));

const AUG_28 = Date.UTC(2026, 7, 28, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function hostOverview(over: Partial<SiteHealthHostOverview> = {}): SiteHealthHostOverview {
  return {
    host: "shop.example.com",
    pages: 3,
    runs: 12,
    seo: 78,
    perf: 54,
    seoPrev: 78,
    perfPrev: 58,
    series: [],
    lastAt: AUG_28,
    ...over,
  };
}

function detailFor(host: string, over: Partial<SiteHealthHostDetail> = {}): SiteHealthHostDetail {
  const series = [0, 1, 2, 3].map((i) => ({
    runId: `r-${i}`,
    at: AUG_28 - (3 - i) * 5 * DAY,
    seo: 78,
    perf: i >= 2 ? 54 : 76,
    pages: 3,
    testId: "t-checkout",
    testName: "Checkout",
    browser: "chromium",
    ingested: i === 1,
  }));
  return {
    host,
    since: 0,
    until: AUG_28 + DAY,
    runs: 4,
    readings: 12,
    pageCount: 3,
    seo: { score: 78, prev: 78 },
    perf: { score: 54, prev: 58 },
    series,
    pages: [
      {
        path: "/", url: `https://${host}/`, title: "Home", seo: 100, perf: 41,
        audits: [{ id: "document-title", status: "pass" }], coverage: ["fcp", "lcp", "tbt", "cls"],
        fcp: 900, lcp: 3400, cls: 0.19, tbt: 60, inp: 120, ttfb: 180, dcl: 1100, load: 1900, requests: 42, transferBytes: 1_460_000,
        engine: "chromium", cold: true, navType: "navigate", status: 200, at: AUG_28, runId: "r-3", testId: "t-checkout", testName: "Checkout",
      },
      {
        path: "/cart", url: `https://${host}/cart`, title: "Cart", seo: 62, perf: 88,
        audits: [{ id: "meta-description", status: "fail" }, { id: "single-h1", status: "fail" }], coverage: ["fcp", "lcp", "tbt"],
        fcp: 700, lcp: 1200, cls: null, tbt: 30, inp: null, ttfb: 150, dcl: 900, load: 1400, requests: 20, transferBytes: 410_000,
        engine: "webkit", cold: false, navType: "navigate", status: 200, at: AUG_28, runId: "r-3", testId: "t-checkout", testName: "Checkout",
      },
    ],
    findings: [
      { id: "meta-description", label: "Meta description present", status: "fail", pages: 2, of: 3, examples: [{ path: "/cart", runId: "r-3", testId: "t-checkout", testName: "Checkout" }, { path: "/about", runId: "r-3", testId: "t-checkout", testName: "Checkout" }] },
    ],
    info: [{ id: "structured-data", label: "Structured data present", status: "warn", pages: 1, of: 3 }],
    vitals: {
      lcp: { p75: 3400, n: 6, status: "over" },
      cls: { p75: 0.19, n: 6, status: "over" },
      inp: { p75: 120, n: 3, status: "within" },
      ttfb: { p75: 180, n: 6, status: "within" },
      fcp: { p75: 900, n: 6, status: "within" },
      tbt: { p75: 60, n: 6, status: "within" },
    },
    engines: [{ engine: "chromium", readings: 10, partial: 0 }, { engine: "webkit", readings: 2, partial: 2 }],
    tests: [{ testId: "t-checkout", testName: "Checkout" }],
    ...over,
  };
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SiteHealthView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.pathname = "/site-health";
  overviewCalls.length = 0;
  hostCalls.length = 0;
  composed.length = 0;
  links = [];
  overviewResult = {
    available: true,
    enabled: true,
    overview: {
      since: 0,
      until: AUG_28,
      hosts: [
        hostOverview(),
        hostOverview({ host: "app.example.com", seo: 91, perf: 88, seoPrev: 88, perfPrev: 88, runs: 4, pages: 2 }),
        hostOverview({ host: "blog.example.com", seo: 64, perf: null, seoPrev: null, perfPrev: null, runs: 1, pages: 1 }),
      ],
    },
  };
  hostResult = (host) => ({ available: true, enabled: true, detail: detailFor(host) });
});

describe("pure rules", () => {
  it("sorts lowest first by the tab's score, unscored last, and reverses cleanly", () => {
    const hosts = overviewResult.overview.hosts;
    expect(sortHosts(hosts, "seo", true).map((x) => x.host)).toEqual(["blog.example.com", "shop.example.com", "app.example.com"]);
    expect(sortHosts(hosts, "seo", false).map((x) => x.host)).toEqual(["app.example.com", "shop.example.com", "blog.example.com"]);
    // On the Performance tab the blog has no score, so it is last either way.
    expect(sortHosts(hosts, "performance", true).map((x) => x.host)).toEqual(["shop.example.com", "app.example.com", "blog.example.com"]);
    expect(sortHosts(hosts, "performance", false).map((x) => x.host)).toEqual(["app.example.com", "shop.example.com", "blog.example.com"]);
  });

  it("finds the most recent run-to-run move of ten points or more", () => {
    const series = detailFor("x").series;
    const change = changeDetected(series, "performance");
    expect(change).toEqual({ at: series[2].at, delta: -22, runId: "r-2" });
    expect(changeDetected(series, "seo")).toBeNull();
    // A null in the middle is skipped, not treated as zero.
    const gappy = [...series];
    gappy[2] = { ...gappy[2], perf: null };
    expect(changeDetected(gappy, "performance")).toEqual({ at: series[3].at, delta: -22, runId: "r-3" });
  });

  it("says 'no prior' rather than zero when there is nothing to compare with", () => {
    expect(deltaText(54, 58, "30d")).toBe("−4 vs prior");
    expect(deltaText(54, 54, "30d")).toBe("no change vs prior");
    expect(deltaText(54, null, "30d")).toBe("no prior");
    expect(deltaText(54, null, "all")).toBe("all time");
  });

  it("formats the date day-then-month whatever the locale", () => {
    expect(shortDate(AUG_28)).toBe("28 Aug");
  });

  it("derives the window from the range, and all time is zero", () => {
    const now = AUG_28;
    expect(sinceFor("7d", now)).toBe(now - 7 * DAY);
    expect(sinceFor("all", now)).toBe(0);
    expect(RANGES.map((r) => r.label)).toEqual(["7d", "30d", "90d", "All"]);
  });
});

describe("the board", () => {
  it("lists domains lowest first with the score and the change, and reverses on the label", async () => {
    renderView();
    const rows = await screen.findAllByRole("button", { name: /example\.com, SEO/ });
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "blog.example.com, SEO 64/100",
      "shop.example.com, SEO 78/100",
      "app.example.com, SEO 91/100",
    ]);
    // The change box reads as a delta, never as a status word.
    expect(within(rows[2]).getByText("+3 vs prior")).toBeTruthy();
    expect(within(rows[1]).getByText("no change vs prior")).toBeTruthy();
    expect(within(rows[0]).getByText("no prior")).toBeTruthy();
    expect(screen.queryByText(/needs work|good|poor/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Domains, lowest SEO score first/ }));
    const reversed = await screen.findAllByRole("button", { name: /example\.com, SEO/ });
    expect(reversed.map((r) => r.getAttribute("aria-label"))[0]).toBe("app.example.com, SEO 91/100");
    expect(screen.getByRole("button", { name: /Domains, highest SEO score first/ })).toBeTruthy();
  });

  it("scores rows off the Performance tab when the path says so, keeping the sort direction", async () => {
    h.pathname = "/site-health/shop.example.com/performance";
    renderView();
    const rows = await screen.findAllByRole("button", { name: /example\.com, Performance/ });
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "shop.example.com, Performance 54/100",
      "app.example.com, Performance 88/100",
      "blog.example.com, Performance —",
    ]);
    expect(within(rows[0]).getByText("−4 vs prior")).toBeTruthy();
  });

  it("switching the tab navigates to the selected host's tab route", async () => {
    renderView();
    await screen.findAllByRole("button", { name: /example\.com, SEO/ });
    fireEvent.click(screen.getByRole("button", { name: "Performance" }));
    // The selected host is the first row by the sort — the blog.
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/site-health/$host/$category",
      params: { host: "blog.example.com", category: "performance" },
    });
  });

  it("selecting a domain navigates to it on the current tab", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "shop.example.com, SEO 78/100" }));
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/site-health/$host/$category",
      params: { host: "shop.example.com", category: "seo" },
    });
  });

  it("asks for the window the range names, and all time as zero", async () => {
    renderView();
    await screen.findAllByRole("button", { name: /example\.com, SEO/ });
    const first = overviewCalls[0];
    expect(first).toBeGreaterThan(Date.now() - 31 * DAY);
    expect(first).toBeLessThan(Date.now() - 29 * DAY);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(overviewCalls).toContain(0));
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(overviewCalls.some((s) => s > Date.now() - 8 * DAY && s < Date.now() - 6 * DAY)).toBe(true));
  });

  it("explains the switch when the check is off, and opens Settings", async () => {
    overviewResult = { ...overviewResult, enabled: false };
    renderView();
    expect(await screen.findByText(/Site Health is off/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/settings/$pane", params: { pane: "test-defaults" } });
  });

  it("says when nothing was read in the window", async () => {
    overviewResult = { ...overviewResult, overview: { since: 0, until: AUG_28, hosts: [] } };
    renderView();
    expect(await screen.findByText(/No readings in this window/)).toBeTruthy();
  });
});

describe("the detail", () => {
  it("shows the headline score with its delta, the series line, and the change detected", async () => {
    h.pathname = "/site-health/shop.example.com/performance";
    renderView();
    expect(await screen.findByText(/change detected 23 Aug \(−22\)/)).toBeTruthy();
    expect(screen.getByText(/54\/100 on the latest run · 4 runs in this window/)).toBeTruthy();
    expect(screen.getByText(/3 pages · 4 runs · last read 28 Aug/)).toBeTruthy();
    expect(hostCalls[0]?.[0]).toBe("shop.example.com");
  });

  it("explains every vital on hover and names the target it is measured against", async () => {
    h.pathname = "/site-health/shop.example.com/performance";
    renderView();
    await screen.findByText("Web vitals · 75th percentile");
    const vitals = within(document.querySelector(".gl-sh-vitals") as HTMLElement);
    const lcp = vitals.getByText("3.4 s").closest(".gl-sh-vital") as HTMLElement;
    expect(lcp.getAttribute("title")).toContain("Largest Contentful Paint");
    expect(lcp.getAttribute("title")).toContain("Target 2.5 s");
    expect(lcp.getAttribute("title")).toContain("75th percentile of the 6 readings");
    expect(within(lcp).getByText("over the 2.5 s target")).toBeTruthy();
    const ttfb = vitals.getByText("180 ms").closest(".gl-sh-vital") as HTMLElement;
    expect(within(ttfb).getByText("within the 800 ms target")).toBeTruthy();
  });

  it("heads the payload column 'Transferred' and formats the bytes", async () => {
    h.pathname = "/site-health/shop.example.com/performance";
    renderView();
    expect(await screen.findByRole("columnheader", { name: "Transferred" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Weight" })).toBeNull();
    expect(screen.getByText("1.4 MB")).toBeTruthy();
    expect(screen.getByText("400 KB")).toBeTruthy();
    // A partial reading says so beside its engine.
    expect(screen.getByText("webkit (partial)")).toBeTruthy();
  });

  it("lists the SEO findings with how many pages they cover, and the failing audits per page", async () => {
    h.pathname = "/site-health/shop.example.com/seo";
    renderView();
    expect(await screen.findByText("Meta description present")).toBeTruthy();
    expect(screen.getByText("2 of 3 pages")).toBeTruthy();
    expect(screen.getByText("/cart · /about")).toBeTruthy();
    expect(screen.getByText("Meta description present, One H1")).toBeTruthy();
    expect(screen.getByText(/missing on 1 of 3 pages/)).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Transferred" })).toBeNull();
  });

  it("opens a test that reaches the domain", async () => {
    h.pathname = "/site-health/shop.example.com/seo";
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Open Checkout" }));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t-checkout" } });
  });

  it("keeps a deep-linked host that has no readings in the window, and says so", async () => {
    h.pathname = "/site-health/old.example.com";
    hostResult = (host) => ({
      available: true,
      enabled: true,
      detail: detailFor(host, { runs: 0, pages: [], series: [], findings: [], info: [], tests: [], engines: [] }),
    });
    renderView();
    expect(await screen.findByText(/No readings for old.example.com in this window/)).toBeTruthy();
  });
});

describe("sending a score to the tracker", () => {
  it("anchors the draft on the newest run in the window, keyed on host and category", () => {
    const detail = detailFor("shop.example.com");
    expect(siteHealthAnchor(detail, "performance", 123)).toEqual({
      kind: "site-health",
      host: "shop.example.com",
      category: "performance",
      testId: "t-checkout",
      runId: "r-3",
      sinceMs: 123,
    });
    expect(siteHealthAnchor({ ...detail, series: [] }, "seo", 0)).toBeNull();
    const link = { kind: "site-health", stepId: "shop.example.com", ruleId: "performance", identifier: "ENG-7" } as IssueLink;
    expect(filedSiteHealthLink([link], "shop.example.com", "performance")?.identifier).toBe("ENG-7");
    expect(filedSiteHealthLink([link], "shop.example.com", "seo")).toBeNull();
    expect(filedSiteHealthLink([link], "app.example.com", "performance")).toBeNull();
  });

  it("opens the compose dialog with the domain, the tab and the window on screen", async () => {
    h.pathname = "/site-health/shop.example.com/performance";
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /Send the Performance score for shop.example.com/ }));
    const source = JSON.parse((await screen.findByTestId("compose")).textContent ?? "null") as DefectSource;
    expect(source).toMatchObject({ kind: "site-health", host: "shop.example.com", category: "performance", testId: "t-checkout", runId: "r-3" });
    expect((source as { sinceMs: number }).sinceMs).toBeGreaterThan(Date.now() - 31 * DAY);
  });

  it("badges a score already filed, and still offers Send for a recurrence", async () => {
    h.pathname = "/site-health/shop.example.com/seo";
    links = [{ kind: "site-health", stepId: "shop.example.com", ruleId: "seo", identifier: "ENG-7", url: "https://linear.app/x/ENG-7" } as IssueLink];
    renderView();
    expect(await screen.findByText("Filed as ENG-7")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Send the SEO score/ })).toBeTruthy();
  });
});
