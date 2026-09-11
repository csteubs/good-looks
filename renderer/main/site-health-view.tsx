// The Site Health view (routes /site-health, /site-health/$host,
// /site-health/$host/$category) — every domain the suite's runs load, scored
// for SEO and performance, with the change over time made the first thing on
// the screen.
//
// Master/detail, the Accessibility split: the Domains panel lists every host
// with a reading in the window, the detail panel is one host on one tab. The
// two tabs are the two questions a domain gets asked — is it indexable and
// well-described (SEO), and is it fast (Performance) — and they share the
// window, the sort and the selected host, because "which domain is worst"
// is one question whichever score you ask it of.
//
// THREE RULES THE COPY FOLLOWS, all from the mockup review:
//   • No status words. A 54 is a 54; whether that is fine is the user's
//     call. What the view adds is the CHANGE — "−4 vs prior" — and when a
//     change was detected, which are facts about the series.
//   • Score text is right-aligned and bounded, so a bar never runs into it.
//   • Every explanation on the screen is a DOM-rendered Tooltip (`@ui`'s,
//     the flake panel's and the Visual view's), NEVER a native `title`. It
//     shipped as a `title` first, and the cards' help cursor promised an
//     explanation that did not come: on the pinned Electron, macOS shows a
//     `title` tooltip on the first hover and rarely again — an open
//     regression since 38.8.2 (electron/electron#49843). A `title` remains
//     only where it reveals TRUNCATED text (a host, a path, a URL), which the
//     row also carries in full. Every trigger that stands on its own is in
//     the tab order, so focus opens the same words — the keyboard path, and
//     the one jsdom can drive (pointer events cannot open a Radix tooltip
//     there; `fireEvent.focus` on a focusable trigger can).
//
// Data: `["site-health", …]` queries (in RUN_DERIVED_KEYS, so a finished run
// refreshes them). The window is chosen here and the shaping is shared with
// the MCP tool and the insights facts builder — see shared/site-health.mjs.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ScrollArea, toast, Tooltip, TooltipContent, TooltipTrigger } from "@ui";
import { ExternalLink, Heart, Send } from "lucide-react";

import { Btn, Panel, Segmented } from "../theme";
import { api } from "../lib/api";
import { parseSiteHealthPath } from "../lib/site-health-route";
import { IssueComposeDialog } from "../components/issue-compose-dialog";
import type { DefectSource, IssueLink } from "../lib/issue-types";
import {
  describeVital,
  formatBytes,
  formatVital,
  formatVitalTarget,
  scoreDelta,
  seoAuditLabel,
  VITAL_IDS,
  VITAL_META,
  vitalStatus,
  type SiteHealthCategory,
  type SiteHealthHostDetail,
  type SiteHealthHostOverview,
  type SiteHealthSeriesPoint,
  type VitalId,
} from "../../shared/site-health.mjs";

// ── Windows ─────────────────────────────────────────────────────────────

export type RangeId = "7d" | "30d" | "90d" | "all";

const DAY = 24 * 60 * 60 * 1000;

/** The four windows. `ms` 0 is all time — no prior period, so no delta. */
export const RANGES: readonly { id: RangeId; label: string; ms: number; title: string }[] = [
  { id: "7d", label: "7d", ms: 7 * DAY, title: "The last 7 days, compared with the 7 before" },
  { id: "30d", label: "30d", ms: 30 * DAY, title: "The last 30 days, compared with the 30 before" },
  { id: "90d", label: "90d", ms: 90 * DAY, title: "The last 90 days, compared with the 90 before" },
  { id: "all", label: "All", ms: 0, title: "Every reading this library has for the domain" },
];

export const DEFAULT_RANGE: RangeId = "30d";

/** A window's `sinceMs`, from a moment: 0 for all time. */
export function sinceFor(range: RangeId, nowMs: number): number {
  const r = RANGES.find((x) => x.id === range);
  return r && r.ms > 0 ? nowMs - r.ms : 0;
}

// ── Pure helpers, exported for the tests ────────────────────────────────

const CATEGORY_LABEL: Record<SiteHealthCategory, string> = {
  seo: "SEO",
  performance: "Performance",
};

function scoreOf(host: SiteHealthHostOverview, category: SiteHealthCategory): number | null {
  return category === "seo" ? host.seo : host.perf;
}

function prevOf(host: SiteHealthHostOverview, category: SiteHealthCategory): number | null {
  return category === "seo" ? host.seoPrev : host.perfPrev;
}

/** Domains by the current tab's score. Lowest first by default — the domain
 *  that most wants looking at — and a host with no score sorts last either
 *  way, because "unscored" is not a score. Ties break on the name. */
export function sortHosts(
  hosts: readonly SiteHealthHostOverview[],
  category: SiteHealthCategory,
  lowestFirst: boolean,
): SiteHealthHostOverview[] {
  return [...hosts].sort((a, b) => {
    const sa = scoreOf(a, category);
    const sb = scoreOf(b, category);
    if (sa === null && sb === null) return a.host.localeCompare(b.host);
    if (sa === null) return 1;
    if (sb === null) return -1;
    if (sa !== sb) return lowestFirst ? sa - sb : sb - sa;
    return a.host.localeCompare(b.host);
  });
}

/** How far a score has to move between two consecutive runs to count as a
 *  change. Ten points is the width of a Lighthouse band and well clear of the
 *  run-to-run noise a lab reading carries. */
export const CHANGE_THRESHOLD = 10;

/** The most recent run-to-run move of at least CHANGE_THRESHOLD, or null. A
 *  fact about the series, not a verdict: the line says when the score moved
 *  and by how much, and leaves whether that matters to the reader. */
export function changeDetected(
  series: readonly SiteHealthSeriesPoint[],
  category: SiteHealthCategory,
): { at: number; delta: number; runId: string } | null {
  const scored = series.filter((p) => (category === "seo" ? p.seo : p.perf) !== null);
  for (let i = scored.length - 1; i >= 1; i--) {
    const now = category === "seo" ? scored[i].seo : scored[i].perf;
    const before = category === "seo" ? scored[i - 1].seo : scored[i - 1].perf;
    if (now === null || before === null) continue;
    const delta = now - before;
    if (Math.abs(delta) >= CHANGE_THRESHOLD) return { at: scored[i].at, delta, runId: scored[i].runId };
  }
  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "28 Aug" — day then month, the same whatever the locale, so the copy the
 *  review asked for ("change detected 28 Aug") is the copy that ships. */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function scoreText(score: number | null): string {
  return score === null ? "—" : `${score}/100`;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The delta box's text. Null from `scoreDelta` means there is no prior
 *  reading to compare with — said as that, never as a zero. */
export function deltaText(current: number | null, prev: number | null, range: RangeId): string {
  return scoreDelta(current, prev) ?? (range === "all" ? "all time" : "no prior");
}

/** What a delta box is comparing — the tooltip on it, spelled once for the
 *  row's box and the detail's. Names the window in days rather than "the
 *  prior period", because the prior period IS the same number of days
 *  again and a reader should not have to know that. */
export function deltaExplanation(category: SiteHealthCategory, range: RangeId): string {
  const r = RANGES.find((x) => x.id === range);
  if (!r || r.ms === 0) {
    return `${CATEGORY_LABEL[category]} score over every reading this library has — there is no prior period to compare with`;
  }
  const days = r.ms / DAY;
  return `${CATEGORY_LABEL[category]} score over the last ${days} days, against the ${days} days before`;
}

/** A vital card's explanation: what the statistic is, its target, and that
 *  the figure is the 75th percentile across the pages read — the same
 *  percentile Google's field data reports. */
export function vitalExplanation(id: VitalId, readings: number): string {
  const meta = VITAL_META[id];
  return `${meta.name}: ${meta.definition}. Target ${formatVitalTarget(id)}. Shown as the 75th percentile of the ${plural(readings, "reading")} in this window.`;
}

/** One bar of the series, named: the day, the test that read it, the score,
 *  and whether the run was carried in from CI. */
export function seriesPointLabel(
  p: SiteHealthHostDetail["series"][number],
  category: SiteHealthCategory,
): string {
  const score = category === "seo" ? p.seo : p.perf;
  return `${shortDate(p.at)} · ${p.testName} · ${scoreText(score)}${p.ingested ? " · from CI" : ""}`;
}

/** The pages table's explained column heads. */
export const COLUMN_EXPLANATION = {
  lcp: VITAL_META.lcp.name,
  cls: VITAL_META.cls.name,
  tbt: VITAL_META.tbt.name,
  inp: VITAL_META.inp.name,
  transferred: "Bytes transferred to load the page, as the browser reported them",
} as const;

// ── Pieces ──────────────────────────────────────────────────────────────

/** An explanation on hover and, when the child is focusable, on focus. The
 *  child is the trigger itself (`asChild`), so the explained thing keeps its
 *  own element, class and role. The side is typed off the content rather
 *  than imported: check:sdk-retired keeps the Tooltip FAMILY on its list by
 *  name, and a type alias is not one of the four members. */
function Explain({
  text,
  side,
  children,
}: {
  text: string;
  side?: React.ComponentProps<typeof TooltipContent>["side"];
  children: React.ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-[260px] leading-snug">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function HostRow({
  host,
  category,
  range,
  selected,
  onSelect,
}: {
  host: SiteHealthHostOverview;
  category: SiteHealthCategory;
  range: RangeId;
  selected: boolean;
  onSelect: () => void;
}) {
  const score = scoreOf(host, category);
  const prev = prevOf(host, category);
  return (
    <button
      type="button"
      className="gl-sh-host"
      data-selected={selected ? "" : undefined}
      onClick={onSelect}
      aria-label={`${host.host}, ${CATEGORY_LABEL[category]} ${scoreText(score)}`}
    >
      <span className="gl-sh-host-name" title={host.host}>
        {host.host}
      </span>
      <span className="gl-sh-host-meta">
        {plural(host.pages, "page")} · {plural(host.runs, "run")}
      </span>
      <span className="gl-sh-gauge">
        <span className="gl-sh-track" aria-hidden="true">
          <span className="gl-sh-fill" style={{ width: `${score ?? 0}%` }} />
        </span>
        <span className="gl-sh-score">{scoreText(score)}</span>
        {/* Hover only: the row is a button, and a focusable child inside one
            is a nested control. The detail's box carries the same words on
            focus. */}
        <Explain text={deltaExplanation(category, range)} side="left">
          <span className="gl-sh-delta">{deltaText(score, prev, range)}</span>
        </Explain>
      </span>
    </button>
  );
}

function SeriesStrip({
  series,
  category,
}: {
  series: SiteHealthHostDetail["series"];
  category: SiteHealthCategory;
}) {
  // One point is not a series, and drawing it would imply it is — the same
  // rule the Visual view's drift strip and the a11y trend follow.
  if (series.length < 2) return null;
  const change = changeDetected(series, category);
  const latest = series[series.length - 1];
  const latestScore = category === "seo" ? latest.seo : latest.perf;
  return (
    <div className="gl-sh-series">
      <div className="gl-sh-series-strip" aria-hidden>
        {series.map((p) => {
          const score = category === "seo" ? p.seo : p.perf;
          return (
            <Explain key={p.runId} text={seriesPointLabel(p, category)} side="top">
              <span className="gl-sh-series-slot">
                {score === null ? (
                  <span className="gl-sh-series-gap" />
                ) : (
                  <span
                    className="gl-sh-series-bar"
                    data-latest={p.runId === latest.runId ? "" : undefined}
                    data-ingested={p.ingested ? "" : undefined}
                    data-change={change && change.runId === p.runId ? "" : undefined}
                    style={{ height: `${Math.max(4, score)}%` }}
                  />
                )}
              </span>
            </Explain>
          );
        })}
      </div>
      <span className="gl-sh-series-line">
        {`${scoreText(latestScore)} on the latest run · ${plural(series.length, "run")} in this window`}
        {change ? (
          <>
            {" · "}
            <span className="gl-sh-change">
              {`change detected ${shortDate(change.at)} (${signed(change.delta)})`}
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}

function VitalCard({ id, vital }: { id: VitalId; vital: SiteHealthHostDetail["vitals"][VitalId] }) {
  const meta = VITAL_META[id];
  const status = vitalStatus(id, vital.p75);
  return (
    // The explanation the review asked for, on hover — and on focus, which
    // is why the card is in the tab order.
    <Explain text={vitalExplanation(id, vital.n)} side="bottom">
      <div className="gl-sh-vital" tabIndex={0}>
        <span className="gl-sh-vital-label">{meta.label}</span>
        <span className="gl-sh-vital-value">{formatVital(id, vital.p75)}</span>
        <span className="gl-sh-vital-note" data-over={status === "over" ? "" : undefined}>
          {vital.p75 === null ? "not measured on this engine" : describeVital(id, vital.p75)}
        </span>
      </div>
    </Explain>
  );
}

/**
 * The anchor for filing a domain's score: the newest run in the window that
 * read it. The link is keyed on host + category (never the run), so any later
 * run finds the same issue; the run is what the screenshot comes from. Null
 * when no run is in the window — nothing on disk to anchor a draft to.
 */
export function siteHealthAnchor(
  detail: SiteHealthHostDetail,
  category: SiteHealthCategory,
  sinceMs: number,
): DefectSource | null {
  const latest = detail.series.length ? detail.series[detail.series.length - 1] : null;
  if (!latest) return null;
  return {
    kind: "site-health",
    host: detail.host,
    category,
    testId: latest.testId,
    runId: latest.runId,
    sinceMs,
  };
}

/** The link already filed for this host and category, if any. Mirrors the
 *  store's key: host in the step slot, category in the rule slot. */
export function filedSiteHealthLink(
  links: readonly IssueLink[],
  host: string,
  category: SiteHealthCategory,
): IssueLink | null {
  return links.find((l) => l.kind === "site-health" && l.stepId === host && l.ruleId === category) ?? null;
}

function Detail({
  detail,
  category,
  range,
  filed,
  onSend,
  onOpenTest,
}: {
  detail: SiteHealthHostDetail;
  category: SiteHealthCategory;
  range: RangeId;
  /** The issue already filed for this host and category, if any. */
  filed: IssueLink | null;
  /** Absent when no run in the window can anchor a draft. */
  onSend: (() => void) | null;
  onOpenTest: (id: string) => void;
}) {
  const score = category === "seo" ? detail.seo.score : detail.perf.score;
  const prev = category === "seo" ? detail.seo.prev : detail.perf.prev;
  const lastAt = detail.series.length ? detail.series[detail.series.length - 1].at : null;

  if (detail.runs === 0 && detail.pages.length === 0) {
    return (
      <div className="gl-empty">
        <span className="gl-empty-title">No readings for {detail.host} in this window</span>
        <span className="gl-empty-note">Pick a longer range, or run a test that reaches it.</span>
      </div>
    );
  }

  return (
    <div className="gl-sh-detail-body">
      <div className="gl-sh-head">
        <span className="gl-sh-headline">
          {score === null ? "—" : score}
          <span className="gl-sh-headline-of">/100</span>
        </span>
        <Explain text={deltaExplanation(category, range)} side="bottom">
          <span className="gl-sh-delta gl-sh-delta-big" tabIndex={0}>
            {deltaText(score, prev, range)}
          </span>
        </Explain>
        <span className="gl-sh-head-meta">
          {plural(detail.pageCount, "page")} · {plural(detail.runs, "run")}
          {lastAt !== null ? ` · last read ${shortDate(lastAt)}` : ""}
        </span>
        <div className="flex-1" />
        {filed ? (
          <span className="gl-chip" title={filed.url}>
            Filed as {filed.identifier}
          </span>
        ) : null}
        {onSend ? (
          <Btn
            tone="ghost"
            onClick={onSend}
            aria-label={`Send the ${CATEGORY_LABEL[category]} score for ${detail.host} to the issue tracker`}
          >
            <Send aria-hidden="true" />
            Send
          </Btn>
        ) : null}
      </div>

      <SeriesStrip series={detail.series} category={category} />

      {category === "performance" ? (
        <>
          <span className="gl-sh-section">Web vitals · 75th percentile</span>
          <div className="gl-sh-vitals">
            {VITAL_IDS.map((id) => (
              <VitalCard key={id} id={id} vital={detail.vitals[id]} />
            ))}
          </div>
          <span className="gl-sh-section">Pages · latest reading of each</span>
          <div className="gl-sh-table-wrap">
            <table className="gl-sh-table">
              <thead>
                <tr>
                  <th>Path</th>
                  <th className="gl-sh-num">Score</th>
                  <Explain text={COLUMN_EXPLANATION.lcp} side="top">
                    <th className="gl-sh-num gl-sh-explained">LCP</th>
                  </Explain>
                  <Explain text={COLUMN_EXPLANATION.cls} side="top">
                    <th className="gl-sh-num gl-sh-explained">CLS</th>
                  </Explain>
                  <Explain text={COLUMN_EXPLANATION.tbt} side="top">
                    <th className="gl-sh-num gl-sh-explained">TBT</th>
                  </Explain>
                  <Explain text={COLUMN_EXPLANATION.inp} side="top">
                    <th className="gl-sh-num gl-sh-explained">INP</th>
                  </Explain>
                  <th className="gl-sh-num">Requests</th>
                  <Explain text={COLUMN_EXPLANATION.transferred} side="top">
                    <th className="gl-sh-num gl-sh-explained">Transferred</th>
                  </Explain>
                  <th>Engine</th>
                </tr>
              </thead>
              <tbody>
                {detail.pages.map((p) => (
                  <tr key={p.path}>
                    <td>
                      <span className="gl-sh-path" title={p.url}>
                        {p.path}
                      </span>
                    </td>
                    <td className="gl-sh-num">{p.perf === null ? "—" : p.perf}</td>
                    <td className="gl-sh-num">{formatVital("lcp", p.lcp)}</td>
                    <td className="gl-sh-num">{formatVital("cls", p.cls)}</td>
                    <td className="gl-sh-num">{formatVital("tbt", p.tbt)}</td>
                    <td className="gl-sh-num">{formatVital("inp", p.inp)}</td>
                    <td className="gl-sh-num">{p.requests ?? "—"}</td>
                    <td className="gl-sh-num">{formatBytes(p.transferBytes)}</td>
                    <td>
                      {p.engine}
                      {p.coverage.length < 4 ? " (partial)" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <span className="gl-sh-section">Findings · latest reading of each page</span>
          {detail.findings.length === 0 ? (
            <p className="gl-panel-note">Every weighted audit passes on every page read in this window.</p>
          ) : (
            <div className="gl-sh-findings">
              {detail.findings.map((f) => (
                <div key={f.id} className="gl-sh-finding">
                  <span className="gl-sh-finding-label">{f.label}</span>
                  <span className="gl-sh-finding-count">
                    {f.status === "warn" ? "warning · " : ""}
                    {f.pages} of {plural(f.of, "page")}
                  </span>
                  <span className="gl-sh-finding-examples">
                    {f.examples.map((e) => e.path).join(" · ")}
                  </span>
                </div>
              ))}
            </div>
          )}
          {detail.info.length > 0 ? (
            <>
              <span className="gl-sh-section">Not scored</span>
              <div className="gl-sh-findings">
                {detail.info.map((f) => (
                  <div key={f.id} className="gl-sh-finding">
                    <span className="gl-sh-finding-label">{f.label}</span>
                    <span className="gl-sh-finding-count">
                      {f.status === "pass" ? "present on " : "missing on "}
                      {f.pages} of {plural(f.of, "page")}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
          <span className="gl-sh-section">Pages · latest reading of each</span>
          <div className="gl-sh-table-wrap">
            <table className="gl-sh-table">
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Title</th>
                  <th className="gl-sh-num">Score</th>
                  <th>Failing</th>
                  <th className="gl-sh-num">Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.pages.map((p) => {
                  const failing = p.audits.filter((a) => a.status === "fail").map((a) => seoAuditLabel(a.id));
                  return (
                    <tr key={p.path}>
                      <td>
                        <span className="gl-sh-path" title={p.url}>
                          {p.path}
                        </span>
                      </td>
                      <td>
                        <span className="gl-sh-path" title={p.title}>
                          {p.title || "(no title)"}
                        </span>
                      </td>
                      <td className="gl-sh-num">{p.seo === null ? "—" : p.seo}</td>
                      <td>
                        <span className="gl-sh-path" title={failing.join(", ")}>
                          {failing.length === 0 ? "none" : failing.join(", ")}
                        </span>
                      </td>
                      <td className="gl-sh-num">{p.status ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="gl-sh-foot">
        <span className="gl-sh-head-meta">
          {detail.engines.map((e) => `${e.engine} ×${e.readings}${e.partial > 0 ? ` (${e.partial} partial)` : ""}`).join(" · ")}
        </span>
        <div className="gl-sh-tests">
          {detail.tests.map((t) => (
            <button
              key={t.testId}
              type="button"
              className="gl-cost-edit"
              onClick={() => onOpenTest(t.testId)}
              aria-label={`Open ${t.testName}`}
            >
              <ExternalLink className="gl-mini-icon" aria-hidden="true" />
              {t.testName}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── The view ────────────────────────────────────────────────────────────

export function SiteHealthView() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const location = parseSiteHealthPath(pathname) ?? {};
  const category: SiteHealthCategory = location.category ?? "seo";

  const [range, setRange] = React.useState<RangeId>(DEFAULT_RANGE);
  // Fixed per range choice rather than per render: a `Date.now()` in the
  // query key would mint a new key on every render and refetch forever.
  const sinceMs = React.useMemo(() => sinceFor(range, Date.now()), [range]);
  const [lowestFirst, setLowestFirst] = React.useState(true);

  const overview = useQuery({
    queryKey: ["site-health", "overview", sinceMs],
    queryFn: () => api.siteHealth.overview(sinceMs),
  });
  // ONE links read for the whole screen, keyed on its own name: links are not
  // run-derived, they change when the user files.
  const links = useQuery({ queryKey: ["site-health-links"], queryFn: api.issues.siteHealthLinks });
  const [sending, setSending] = React.useState<DefectSource | null>(null);
  const hosts = React.useMemo(
    () => sortHosts(overview.data?.overview.hosts ?? [], category, lowestFirst),
    [overview.data, category, lowestFirst],
  );
  // The path's host wins, even one outside the window — a deep link names a
  // domain, and the detail says "no readings" rather than swapping the
  // subject. With none named, the first row (the one that most wants looking
  // at, by the sort).
  const selectedHost = location.host ?? hosts[0]?.host ?? null;

  const detail = useQuery({
    queryKey: ["site-health", "host", selectedHost, sinceMs],
    queryFn: () => api.siteHealth.host(selectedHost as string, sinceMs),
    enabled: selectedHost !== null,
  });

  const go = (host: string, cat: SiteHealthCategory) =>
    void navigate({ to: "/site-health/$host/$category", params: { host, category: cat } });
  const onOpenTest = (id: string) => void navigate({ to: "/test/$id", params: { id } });
  const openSettings = () =>
    void navigate({ to: "/settings/$pane", params: { pane: "test-defaults" } });

  const enabled = overview.data?.enabled ?? true;
  const available = overview.data?.available ?? true;
  const runsInWindow = (overview.data?.overview.hosts ?? []).reduce((n, h) => n + h.runs, 0);

  return (
    <div className="gl-sh">
      <div className="gl-sh-bar">
        <Heart className="gl-sh-bar-icon" aria-hidden="true" />
        <Segmented
          label="Site Health score"
          value={category}
          onChange={(v) => {
            if (selectedHost) go(selectedHost, v);
          }}
          options={[
            { value: "seo", label: "SEO", title: "Indexability and description — the audits Lighthouse's SEO category runs" },
            { value: "performance", label: "Performance", title: "Lab readings of the Core Web Vitals, weighted the way Lighthouse weights them" },
          ]}
        />
        <div className="flex-1" />
        <span className="gl-sh-bar-note">
          {overview.data ? `${plural(hosts.length, "domain")} · ${plural(runsInWindow, "run")}` : ""}
        </span>
        <Segmented
          label="Time range"
          value={range}
          onChange={(v) => setRange(v)}
          options={RANGES.map((r) => ({ value: r.id, label: r.label, title: r.title }))}
        />
      </div>
      <div className="gl-sh-panes">
        <Panel className="gl-sh-hosts">
          <div className="gl-sh-hosts-head">
            {/* The label IS the sort control, as the review asked: click it to
                go from lowest-first to highest-first and back. Shared by both
                tabs by construction — it is one piece of state. */}
            <button
              type="button"
              className="gl-sh-sort"
              onClick={() => setLowestFirst((v) => !v)}
              aria-label={`Domains, ${lowestFirst ? "lowest" : "highest"} ${CATEGORY_LABEL[category]} score first. Click to reverse.`}
            >
              Domains · {lowestFirst ? "lowest first" : "highest first"}
            </button>
          </div>
          {overview.isLoading ? (
            <div className="gl-visual-loading" />
          ) : !enabled ? (
            <div className="gl-empty">
              <span className="gl-empty-title">Site Health is off</span>
              <span className="gl-empty-note">
                Switch on “Check Site Health” in Settings → Test defaults. Every run after that scores each page it loads, grouped here by domain.
              </span>
              <Btn tone="ghost" onClick={openSettings}>
                Open Settings
              </Btn>
            </div>
          ) : !available ? (
            <div className="gl-empty">
              <span className="gl-empty-title">Metrics are unavailable</span>
              <span className="gl-empty-note">
                This runtime could not open the metrics database, which is where the per-domain series lives. Runs still record their summary.
              </span>
            </div>
          ) : hosts.length === 0 ? (
            <div className="gl-empty">
              <span className="gl-empty-title">No readings in this window</span>
              <span className="gl-empty-note">
                {range === "all"
                  ? "Run a test with Check Site Health on. Every page the run loads is scored and grouped here by domain."
                  : "Pick a longer range, or run a test with Check Site Health on."}
              </span>
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col">
                {hosts.map((h) => (
                  <HostRow
                    key={h.host}
                    host={h}
                    category={category}
                    range={range}
                    selected={h.host === selectedHost}
                    onSelect={() => go(h.host, category)}
                  />
                ))}
              </div>
            </ScrollArea>
          )}
        </Panel>
        <Panel
          title={selectedHost ?? "Domain"}
          id={selectedHost ? CATEGORY_LABEL[category] : undefined}
          className="gl-sh-detail"
        >
          {selectedHost === null ? (
            <p className="gl-panel-note">Select a domain to see its pages, findings and vitals.</p>
          ) : detail.isLoading || !detail.data ? (
            <div className="gl-visual-loading" />
          ) : (
            <Detail
              detail={detail.data.detail}
              category={category}
              range={range}
              filed={filedSiteHealthLink(links.data ?? [], detail.data.detail.host, category)}
              onSend={
                siteHealthAnchor(detail.data.detail, category, sinceMs)
                  ? () => setSending(siteHealthAnchor(detail.data.detail, category, sinceMs))
                  : null
              }
              onOpenTest={onOpenTest}
            />
          )}
        </Panel>
      </div>
      <IssueComposeDialog
        source={sending}
        open={sending !== null}
        onOpenChange={(open) => {
          if (!open) setSending(null);
        }}
        onFiled={(issue) => {
          toast.success(`Filed as ${issue.identifier}.`);
          void qc.invalidateQueries({ queryKey: ["site-health-links"] });
        }}
        onCommented={(link) => toast.success(`Added to ${link.identifier}.`)}
      />
    </div>
  );
}
