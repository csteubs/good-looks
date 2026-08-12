import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  NativeDatePickerRoot,
  NativeDatePickerTrigger,
  NativeDatePickerValue,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@ui";
import {
  Calendar,
  Camera,
  Globe,
  MoreHorizontal,
  MonitorOff,
  Search,
  Stamp,
  Timer,
  X,
  Wand2,
} from "lucide-react";

import { useNavigate } from "@tanstack/react-router";

import { Btn, Panel, Segmented, StatusChip, TONE, toneSurface } from "../theme";
import { api } from "../lib/api";
import { summariseAll } from "../lib/stats-categories";
import { CategoryBoard } from "./stats/category-board";
import { BUILT } from "./stats/stats-category-view";
import { BROWSER_SF_SYMBOLS, BrowserIcon } from "../lib/browser-icons";
import { FlakePanel } from "./flake-panel";
import { StepHealthPanel } from "./step-health-panel";
import { SuiteCostPanel } from "./suite-cost-panel";
import { CostPanel } from "./cost-panel";
import { DivergencePanel } from "./divergence-panel";
import { LogInspector } from "./log-inspector";
import { Pager } from "./pager";
import type { CaptureOverheadSummary, LogSearchResult, RunRecord } from "../lib/recorder-types";
import { RUN_BROWSERS, RUN_BROWSER_LABELS, TEST_SPEED_LABELS } from "../lib/recorder-types";
import { DENSE_PAGE_SIZE, pageSlice } from "../lib/paginate";
import {
  NO_FILTERS,
  filtersActive,
  runBrowserOf,
  runMatchesFilters,
  testFilterOptions,
  type RunFilters,
  type StatusFilter,
  type TagFilter,
} from "../lib/run-filters";

// ── Native bridges (match library-sidebar patterns) ───────────────────
interface MenuPopupItem {
  label?: string;
  type?: "normal" | "separator";
  commandId?: number;
}
interface NativeMenu {
  popup: (options: {
    items: MenuPopupItem[];
    x?: number;
    y?: number;
    coordinateSpace?: "screen" | "view";
  }) => Promise<{
    commandId?: number;
  }>;
}
function nativeMenu(): NativeMenu {
  return (window as unknown as { glazeAPI: { Menu: NativeMenu } }).glazeAPI.Menu;
}
function nativeShell(): { showItemInFolder: (p: string) => void } {
  return (window as unknown as { glazeAPI: { shell: { showItemInFolder: (p: string) => void } } })
    .glazeAPI.shell;
}
// ── Formatting helpers ─────────────────────────────────────────────────
function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}
function fmtBytes(n: number): string {
  if (n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function dayStartMs(v: string): number {
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}
function dayEndMs(v: string): number {
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

// ── Daily pass/fail buckets for the chart ──────────────────────────────
interface DayBucket {
  key: string;
  label: string;
  passed: number;
  failed: number;
}
function buildDailyBuckets(runs: RunRecord[]): DayBucket[] {
  const map = new Map<string, DayBucket>();
  for (const r of runs) {
    if (r.kind === "baseline-update") continue; // exclude from pass/fail chart
    const d = new Date(r.startedAt);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    let b = map.get(key);
    if (!b) {
      b = { key, label: `${d.getMonth() + 1}/${d.getDate()}`, passed: 0, failed: 0 };
      map.set(key, b);
    }
    if (r.status === "passed") b.passed++;
    else b.failed++;
  }
  // Always show the last 7 calendar days (inclusive of today), even days with
  // no runs, so gaps are visible instead of the chart skipping straight to
  // the next day that has data.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets: DayBucket[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    buckets.push(map.get(key) ?? { key, label: `${d.getMonth() + 1}/${d.getDate()}`, passed: 0, failed: 0 });
  }
  return buckets;
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="gl-kpi">
      <span className="gl-kpi-label">{label}</span>
      <span className="gl-kpi-value">{value}</span>
      {hint ? <span className="gl-kpi-hint">{hint}</span> : null}
    </div>
  );
}

/** ms → a compact human duration ("380 ms", "1.4 s"). */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** What the "Capture screenshots" toggle actually costs, measured rather than
 *  assumed (the roadmap's cross-cutting performance risk). Hidden entirely
 *  until at least one instrumented capture run exists. */
function CaptureOverheadPanel({ summary }: { summary: CaptureOverheadSummary }) {
  // Hidden until there is something measured to show — same rule as before, but
  // now either instrumented capture runs OR accessibility runs qualify, since
  // a11y can be on with screenshots off.
  if (summary.capturedRuns === 0 && summary.a11yRuns === 0) return null;
  const sharePct = Math.round(summary.captureShareOfRun * 100);
  const delta =
    summary.meanUncapturedDurationMs !== null
      ? summary.meanCapturedDurationMs - summary.meanUncapturedDurationMs
      : null;
  return (
    <Panel
      title="Capture overhead"
      id={
        summary.capturedRuns > 0
          ? `${summary.capturedRuns} captured ${summary.capturedRuns === 1 ? "run" : "runs"} · ${summary.totalShots} screenshots`
          : `${summary.a11yRuns} accessibility ${summary.a11yRuns === 1 ? "run" : "runs"}`
      }
      pad={10}
    >
      <div className="gl-kpis">
        {summary.capturedRuns > 0 ? (
          <StatCard
            label="Screenshot time per run"
            value={fmtMs(summary.meanCaptureMs)}
            hint={`${sharePct}% of a captured run`}
          />
        ) : null}
        {/* Reported on its own axis. Folding axe's cost into the screenshot
            number would make "capture is expensive" the wrong conclusion — the
            a11y check is usually the larger of the two by some way. */}
        {summary.a11yRuns > 0 ? (
          <StatCard
            label="Accessibility time per run"
            value={fmtMs(summary.meanA11yMs)}
            hint={`${Math.round(summary.a11yShareOfRun * 100)}% of such a run · ${fmtMs(
              summary.meanMsPerA11yCheck,
            )} per check`}
          />
        ) : null}
        {summary.capturedRuns > 0 ? (
          <StatCard label="Per screenshot" value={fmtMs(summary.meanMsPerShot)} />
        ) : null}
        {summary.capturedRuns > 0 ? (
        <StatCard
          label="Captured vs normal run"
          value={
            delta === null
              ? fmtMs(summary.meanCapturedDurationMs)
              : `${delta >= 0 ? "+" : "−"}${fmtMs(Math.abs(delta))}`
          }
          hint={
            summary.meanUncapturedDurationMs === null
              ? "no uncaptured runs to compare"
              : `${fmtMs(summary.meanCapturedDurationMs)} vs ${fmtMs(summary.meanUncapturedDurationMs)}`
          }
        />
        ) : null}
      </div>
    </Panel>
  );
}

function PassFailChart({ buckets }: { buckets: DayBucket[] }) {
  const maxTotal = Math.max(1, ...buckets.map((b) => b.passed + b.failed));
  return (
    <Panel
      title="Pass / fail over time"
      pad={10}
      right={
        <div className="gl-legend">
          <span className="gl-legend-item">
            <span className="gl-legend-dot" style={{ background: TONE.phos }} />
            Passed
          </span>
          <span className="gl-legend-item">
            <span className="gl-legend-dot" style={{ background: TONE.red }} />
            Failed
          </span>
        </div>
      }
    >
      <div className="gl-chart">
        {buckets.map((b) => {
          const total = b.passed + b.failed;
          const totalPct = (total / maxTotal) * 100;
          const passPct = total > 0 ? (b.passed / total) * 100 : 0;
          return (
            <div key={b.key} className="gl-chart-col">
              <div className="gl-chart-plot">
                {total > 0 ? (
                  <div
                    className="gl-chart-stack"
                    style={{ height: `${totalPct}%` }}
                    title={`${b.label}: ${b.passed} passed, ${b.failed} failed`}
                  >
                    <div style={{ height: `${100 - passPct}%`, background: TONE.red }} />
                    <div style={{ height: `${passPct}%`, background: TONE.phos }} />
                  </div>
                ) : (
                  // A day with no runs draws its floor rather than nothing, so
                  // the gap reads as "nothing happened" and not as a chart that
                  // failed to render.
                  <div className="gl-chart-floor" title={`${b.label}: no runs`} />
                )}
              </div>
              <span className="gl-chart-tick">{b.label}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/** Prev / range / Next control shared by both Stats lists. Renders nothing for
 *  a single page, so short lists aren't cluttered with dead controls. */

export function StatsView() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const runsQuery = useQuery({ queryKey: ["runs"], queryFn: api.runs.list });
  const runs = React.useMemo(() => runsQuery.data ?? [], [runsQuery.data]);

  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [logRun, setLogRun] = React.useState<{ id: string; title: string } | null>(null);
  const [confirm, setConfirm] = React.useState<null | "reset" | "all" | "aiDebug">(null);
  const [rangeOpen, setRangeOpen] = React.useState(false);
  const [rangeFrom, setRangeFrom] = React.useState("");
  const [rangeTo, setRangeTo] = React.useState("");
  const [filters, setFilters] = React.useState<RunFilters>(NO_FILTERS);
  // Page per list. Both reset to 1 when their inputs change, so narrowing a
  // filter doesn't strand you on a page that no longer exists; clampPage in
  // render is the backstop for the list shrinking any other way.
  const [runsPage, setRunsPage] = React.useState(1);
  const [searchPage, setSearchPage] = React.useState(1);

  // Live-refresh when a run completes.
  React.useEffect(() => {
    return api.on("runs:changed", () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
    qc.invalidateQueries({ queryKey: ["captureOverhead"] });
    qc.invalidateQueries({ queryKey: ["metrics"] });
    });
  }, [qc]);

  // Debounce the log search.
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const searchQuery = useQuery({
    queryKey: ["run-log-search", debounced],
    queryFn: () => api.runs.searchLogs(debounced),
    enabled: debounced.length > 0,
  });

  // Capture overhead is computed backend-side from the same run history, so
  // the summarizer has one implementation (and one regression check).
  const flakeQuery = useQuery({
    queryKey: ["flake"],
    queryFn: () => api.runs.flake(),
  });
  const overheadQuery = useQuery({
    queryKey: ["captureOverhead"],
    queryFn: () => api.runs.captureOverhead(),
  });

  // The metrics views. Three queries rather than one, because each is a
  // separate scan and each is useful on its own — Step Health says something
  // from the first run, while the slowness trend needs two windows of history
  // before it can say anything at all.
  const stepHealthQuery = useQuery({
    queryKey: ["metrics", "stepHealth"],
    queryFn: () => api.metrics.stepHealth(),
  });
  const slownessQuery = useQuery({
    queryKey: ["metrics", "slowness"],
    queryFn: () => api.metrics.slowness(),
  });
  const divergenceQuery = useQuery({
    queryKey: ["metrics", "divergence"],
    queryFn: () => api.metrics.divergence(),
  });

  // The two series the board needs that the panels below do not. Both reuse the
  // key their own screen already caches — ["heals","all"] is the Heals view's
  // and ["replays"] is the Visual view's — so the board costs a round trip only
  // on the first visit, and drilling into a category costs none at all.
  const healsQuery = useQuery({ queryKey: ["heals", "all"], queryFn: () => api.heals.listAll() });
  const replaysQuery = useQuery({ queryKey: ["replays"], queryFn: api.artifacts.list });

  // Every category that has an answer yet. One that has not resolved is OMITTED
  // rather than given a state — see the note in stats-categories.ts on why
  // "loading" must not render as "you have never switched this on".
  const summaries = React.useMemo(
    () =>
      summariseAll({
        runs: runsQuery.data,
        flake: flakeQuery.data,
        heals: healsQuery.data,
        replays: replaysQuery.data,
        stepHealth: stepHealthQuery.data,
        slowness: slownessQuery.data,
      }),
    [
      runsQuery.data,
      flakeQuery.data,
      healsQuery.data,
      replaysQuery.data,
      stepHealthQuery.data,
      slownessQuery.data,
    ],
  );

  // Runs whose test still exists. Everything that NAMES a test works from this
  // — the table, the test filter, log search — while the summary cards, the
  // chart and the capture-overhead panel keep working from `runs`. A deleted
  // test's runs really happened, and rewriting the totals to pretend otherwise
  // is what makes the numbers stop being worth reading.
  const liveRuns = React.useMemo(() => runs.filter((r) => !r.testDeleted), [runs]);
  const hiddenRuns = runs.length - liveRuns.length;

  // Filters apply to the run-history table only — the summary cards and chart
  // keep describing the whole history, so narrowing the table doesn't silently
  // redefine "pass rate".
  const filteredRuns = React.useMemo(
    () => liveRuns.filter((r) => runMatchesFilters(r, filters)),
    [liveRuns, filters],
  );

  // Distinct tests present in the history, for the test filter's options.
  const testOptions = React.useMemo(() => testFilterOptions(liveRuns), [liveRuns]);

  React.useEffect(() => {
    setRunsPage(1);
  }, [filters]);

  // A new query is a new result set — start at its first page.
  React.useEffect(() => {
    setSearchPage(1);
  }, [debounced]);

  // A filter pinned to a test that no longer has runs (deleted test, pruned
  // history) would silently show an empty table — drop back to "all" instead.
  React.useEffect(() => {
    if (filters.test !== "all" && !testOptions.some((t) => t.id === filters.test)) {
      setFilters((f) => ({ ...f, test: "all" }));
    }
  }, [testOptions, filters.test]);

  const buckets = React.useMemo(() => buildDailyBuckets(runs), [runs]);
  // Only real test runs count toward pass/fail stats; baseline-update events
  // are shown in the history table but excluded from charts and summary cards.
  const realRuns = runs.filter((r) => r.kind !== "baseline-update");
  const passed = realRuns.filter((r) => r.status === "passed").length;
  const failed = realRuns.length - passed;
  const passRate = realRuns.length > 0 ? Math.round((passed / realRuns.length) * 100) : 0;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["runs"] });
    qc.invalidateQueries({ queryKey: ["captureOverhead"] });
    qc.invalidateQueries({ queryKey: ["metrics"] });
    qc.invalidateQueries({ queryKey: ["run-log-search"] });
    qc.invalidateQueries({ queryKey: ["run-log"] });
  };

  const openManageMenu = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const res = await nativeMenu().popup({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
      coordinateSpace: "view",
      items: [
        { label: "Reset stats (keep logs)", commandId: 1 },
        { label: "Delete stats & logs…", commandId: 2 },
        { label: "Delete logs by date…", commandId: 3 },
        { type: "separator" },
        // AI debug sessions quote script and run-output excerpts, so they get
        // the same explicit cleanup affordance the raw logs have.
        { label: "Delete AI debug history…", commandId: 5 },
        { type: "separator" },
        { label: "Reveal logs folder in Finder", commandId: 4 },
      ],
    });
    if (res.commandId === 1) setConfirm("reset");
    else if (res.commandId === 2) setConfirm("all");
    else if (res.commandId === 3) {
      setRangeFrom("");
      setRangeTo("");
      setRangeOpen(true);
    } else if (res.commandId === 5) setConfirm("aiDebug");
    else if (res.commandId === 4) {
      try {
        nativeShell().showItemInFolder(await api.runs.logsDir());
      } catch {
        toast.error("Could not open the logs folder.");
      }
    }
  };

  const runConfirmedDelete = async () => {
    try {
      if (confirm === "reset") {
        const { removed } = await api.runs.resetStats();
        toast.success(`Cleared ${removed} run${removed === 1 ? "" : "s"} from stats (logs kept).`);
      } else if (confirm === "all") {
        const { removed } = await api.runs.deleteAll();
        toast.success(`Deleted ${removed} run${removed === 1 ? "" : "s"} and their logs.`);
      } else if (confirm === "aiDebug") {
        const { removed } = await api.aiDebug.clear();
        toast.success(
          `Deleted ${removed} saved AI debug session${removed === 1 ? "" : "s"}.`,
        );
      }
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setConfirm(null);
    }
  };

  const runRangeDelete = async () => {
    try {
      const { removed } = await api.runs.deleteRange(dayStartMs(rangeFrom), dayEndMs(rangeTo));
      toast.success(`Deleted ${removed} run${removed === 1 ? "" : "s"} in range.`);
      setRangeOpen(false);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
      throw err;
    }
  };

  const searching = debounced.length > 0;
  const searchResults: LogSearchResult[] = searchQuery.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="gl-stats-head">
        <span className="gl-stats-title">Stats</span>
        <span className="gl-stats-meta">
          {realRuns.length} run{realRuns.length === 1 ? "" : "s"} recorded
          {runs.length !== realRuns.length
            ? ` · ${runs.length - realRuns.length} baseline update${
                runs.length - realRuns.length === 1 ? "" : "s"
              }`
            : ""}
        </span>
        <div className="gl-stats-actions">
          <Btn tone="ghost" onClick={openManageMenu}>
            <MoreHorizontal aria-hidden="true" />
            Manage data
          </Btn>
        </div>
      </header>

      {/* min-h-0 flex-1, NOT h-full. In a flex column h-full resolves to 100% of
          the PARENT, but the header above has already consumed part of that —
          so the scroll region extended past the bottom of the window by the
          header's height and its last child (the pager) was cut off. flex-1
          claims only the remaining space; min-h-0 is required with it, or a
          flex item refuses to shrink below its content and overflows again.
          Both are read at source level by check:scroll-layout. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-4xl flex-col gap-5 p-5 pb-10">
          {runs.length === 0 && !runsQuery.isLoading ? (
            <div className="gl-empty">
              <span className="gl-empty-title">No runs yet</span>
              <p className="gl-empty-note">
                Run a test from its detail page to start collecting pass/fail stats and console logs
                here.
              </p>
            </div>
          ) : (
            <>
              {/* The category board FIRST, and the chart's own argument is why:
                  the shape of the last week is what you can read without
                  reading. The board is that same idea one level up — it answers
                  "is anything wrong?" across every category, where the chart
                  answers it for outcomes alone. */}
              <CategoryBoard
                summaries={summaries}
                openable={BUILT}
                onOpen={(id) => navigate({ to: "/stats/$category", params: { category: id } })}
              />

              {/* Chart FIRST. The shape of the last week is the thing you can
                  read without reading — a rising red band answers "is something
                  wrong?" before any number does, and it was previously below
                  three panels of text. The numbers it summarises follow it. */}
              {buckets.length > 0 ? <PassFailChart buckets={buckets} /> : null}

              {/* Summary cards */}
              <div className="gl-kpis">
                <StatCard label="Total runs" value={String(realRuns.length)} />
                <StatCard label="Pass rate" value={`${passRate}%`} />
                <StatCard label="Passed" value={String(passed)} />
                <StatCard label="Failed" value={String(failed)} />
              </div>

              {/* Capture overhead — only once a capture run has been measured */}
              {overheadQuery.data ? <CaptureOverheadPanel summary={overheadQuery.data} /> : null}

              {/* Stability — "is this test trustworthy", which neither the chart
                  nor the pass rate above can answer: both count outcomes, and
                  what makes a test flaky is how often it CHANGES its mind. */}
              {flakeQuery.data ? <FlakePanel report={flakeQuery.data} /> : null}

              {/* The three views the metrics join makes possible (Phase 4).
                  Ordered by how often they have something to say: divergence
                  and slowdowns are findings and render only when there is one,
                  Step Health is a table and is always worth having. */}
              {divergenceQuery.data ? (
                <DivergencePanel
                  steps={divergenceQuery.data.steps}
                  available={divergenceQuery.data.available}
                />
              ) : null}

              {/* What it COSTS, above where its time goes (§6.4). Two questions
                  that read as one and are not: this one is about money and
                  what it bought, `SuiteCostPanel` is about which switches are
                  spending the minutes. */}
              <CostPanel runs={realRuns} />

              {slownessQuery.data ? (
                <SuiteCostPanel
                  cost={slownessQuery.data.cost}
                  rows={slownessQuery.data.rows}
                  slowed={slownessQuery.data.slowed}
                  available={slownessQuery.data.available}
                />
              ) : null}

              {stepHealthQuery.data ? (
                <StepHealthPanel
                  rows={stepHealthQuery.data.rows}
                  available={stepHealthQuery.data.available}
                />
              ) : null}

              {/* Search */}
              <div className="flex flex-col gap-2">
                <div className="gl-search">
                  <span className="gl-search-icon">
                    <Search aria-hidden="true" />
                  </span>
                  <input
                    className="gl-search-input"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search raw logs (errors, selectors, output)…"
                  />
                </div>

                {searching ? (
                  <Panel>
                    {searchQuery.isLoading ? (
                      <p className="gl-panel-note">Searching…</p>
                    ) : searchResults.length === 0 ? (
                      <p className="gl-panel-note">No logs match “{debounced}”.</p>
                    ) : (
                      pageSlice(searchResults, searchPage).map((r) => (
                        <button
                          key={r.runId}
                          type="button"
                          className="gl-result"
                          onClick={() =>
                            setLogRun({ id: r.runId, title: `${r.testName} — ${fmtDateTime(r.startedAt)}` })
                          }
                        >
                          <span className="gl-result-head">
                            <StatusChip tone={r.status === "passed" ? "phos" : "red"}>
                              {r.status}
                            </StatusChip>
                            <span className="gl-result-name">{r.testName}</span>
                            <span className="gl-result-when">
                              {fmtDateTime(r.startedAt)} · {r.matchCount} match
                              {r.matchCount === 1 ? "" : "es"}
                            </span>
                          </span>
                          <span className="gl-result-snippet">{r.snippet}</span>
                        </button>
                      ))
                    )}
                    <Pager
                      page={searchPage}
                      total={searchResults.length}
                      onPage={setSearchPage}
                      label="results"
                    />
                  </Panel>
                ) : null}
              </div>

              {/* Run history table */}
              {!searching ? (
                <div>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="gl-stats-label">Run history</span>
                    <span className="gl-stats-meta">
                      {filtersActive(filters)
                        ? `${filteredRuns.length} of ${liveRuns.length}`
                        : `${liveRuns.length} run${liveRuns.length === 1 ? "" : "s"}`}
                    </span>
                    {/* Says out loud why "Total runs" above is bigger than the
                        list below. Without it the two numbers just disagree,
                        and a disagreement with no explanation reads as a bug in
                        whichever one the reader trusts less. */}
                    {hiddenRuns > 0 ? (
                      <span className="gl-stats-meta">
                        · {hiddenRuns} from deleted test{hiddenRuns === 1 ? "" : "s"} counted above,
                        not listed
                      </span>
                    ) : null}

                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      {/* Plain buttons with aria-pressed, not a Radix
                          ToggleGroup. The SDK's SegmentedControl activated on
                          pointer-down, which is why so many tests in this repo
                          have to drive it with fireEvent.mouseDown; these
                          respond to a real click, so the tests can say what
                          they mean. The role changes from radio to button, and
                          that is the query change this reskin costs. */}
                      <Segmented
                        label="Filter runs by status"
                        value={filters.status}
                        onChange={(v) => setFilters((f) => ({ ...f, status: v as StatusFilter }))}
                        options={[
                          { value: "all", label: "All" },
                          { value: "passed", label: "Passed" },
                          { value: "failed", label: "Failed" },
                          { value: "baseline", label: "Baselines" },
                        ]}
                      />

                      {/* Native-menu-backed and staying that way (REDESIGN §1):
                          the redesign draws the trigger box, the menu itself is
                          the OS's. Its options never enter the DOM, so a
                          selection cannot be driven in jsdom — persistence is
                          covered at the IPC layer instead. */}
                      <Select
                        value={filters.tag}
                        onValueChange={(v) => setFilters((f) => ({ ...f, tag: v as TagFilter }))}
                      >
                        <SelectTrigger variant="filled" size="small" className="w-36">
                          <SelectValue placeholder="Any tag" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Any tag</SelectItem>
                          <SelectItem value="headed">Headed</SelectItem>
                          <SelectItem value="headless">Headless</SelectItem>
                          <SelectItem value="captured">Screenshots</SelectItem>
                          {RUN_BROWSERS.map((b) => (
                            <SelectItem key={b} value={b} icon={BROWSER_SF_SYMBOLS[b]}>
                              {RUN_BROWSER_LABELS[b]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Select
                        value={filters.test}
                        onValueChange={(v) => setFilters((f) => ({ ...f, test: v }))}
                      >
                        <SelectTrigger variant="filled" size="small" className="w-44">
                          <SelectValue placeholder="All tests" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All tests</SelectItem>
                          {testOptions.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {filtersActive(filters) ? (
                        <Btn tone="ghost" onClick={() => setFilters(NO_FILTERS)}>
                          <X aria-hidden="true" />
                          Clear
                        </Btn>
                      ) : null}
                    </div>
                  </div>
                  <div className="gl-table-wrap">
                    {/* NAMED, since C §6.4 put a second table on this screen. Two unnamed
                        tables are ambiguous to a screen reader and to every
                        `getByRole("table")` in this file's tests — which is how
                        the ambiguity was found. */}
                    <table className="gl-table gl-table-runs" aria-label="Run history">
                      <thead>
                        <tr>
                          <th>Test</th>
                          {/* Wide enough for the fixed-width status chip AND a
                              "healed" chip beside it. The old SDK badge sized
                              itself to its own text, so 80px was plenty; a chip
                              that is contractually `--gl-status-w` is not
                              something a column can be narrower than, and the
                              cell clips rather than wraps. */}
                          <th style={{ width: 160 }}>Status</th>
                          <th style={{ width: 52 }}>Browser</th>
                          <th style={{ width: 96 }}>Started</th>
                          <th style={{ width: 104 }}>Tags</th>
                          <th style={{ width: 76 }} className="gl-num">
                            Duration
                          </th>
                          <th style={{ width: 64 }} className="gl-num">
                            Log
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageSlice(filteredRuns, runsPage, DENSE_PAGE_SIZE).map((r) => {
                          const isBaseline = r.kind === "baseline-update";
                          return (
                            <tr
                              key={r.id}
                              // A baseline update is not a run and has no log to
                              // open, so it is not clickable. The two row kinds
                              // the data already distinguishes must not read
                              // identically (REDESIGN §B7).
                              data-clickable={isBaseline ? undefined : ""}
                              onClick={() => {
                                if (isBaseline) return;
                                setLogRun({
                                  id: r.id,
                                  title: `${r.testName} — ${fmtDateTime(r.startedAt)}`,
                                });
                              }}
                            >
                              <td data-strong="" title={r.testName}>
                                {r.testName}
                              </td>
                              <td>
                                {isBaseline ? (
                                  <StatusChip>
                                    <span className="flex items-center gap-1">
                                      <Stamp aria-hidden="true" className="gl-mini-icon" />
                                      Baseline
                                    </span>
                                  </StatusChip>
                                ) : (
                                  <span className="flex items-center gap-1">
                                    <StatusChip tone={r.status === "passed" ? "phos" : "red"}>
                                      {r.status}
                                    </StatusChip>
                                    {/* A run that only passed because Auto-Heal
                                        substituted a locator is not the same
                                        evidence as one that passed outright, so
                                        it must not read identically. */}
                                    {r.healedSteps ? (
                                      <span
                                        className="gl-chip-tone"
                                        style={toneSurface(TONE.amber)}
                                        title={`${r.healedSteps} step${r.healedSteps === 1 ? "" : "s"} healed during this run`}
                                      >
                                        <Wand2 aria-hidden="true" className="gl-mini-icon me-[3px]" />
                                        healed
                                      </span>
                                    ) : null}
                                  </span>
                                )}
                              </td>
                              {/* Icon-only: the engine is a glance-level fact,
                                  and the name would cost a third of the row's
                                  width to repeat on every line. */}
                              <td>
                                {isBaseline ? (
                                  <span style={{ color: "var(--gl-tx-3)" }}>—</span>
                                ) : (
                                  <span style={{ color: "var(--gl-tx-2)" }}>
                                    <BrowserIcon
                                      browser={runBrowserOf(r)}
                                      className="size-4 shrink-0"
                                    />
                                  </span>
                                )}
                              </td>
                              <td title={fmtDateTime(r.startedAt)}>{fmtDateTime(r.startedAt)}</td>
                              <td>
                                {isBaseline ? (
                                  <span style={{ color: "var(--gl-tx-3)" }}>—</span>
                                ) : (
                                  <span className="flex items-center gap-1">
                                    {/* Mode icon + engine icon, no words. The
                                        engine has its own column now, so the
                                        name here would be pure duplication —
                                        but the chip keeps the glyph so the
                                        tag filter's browser options still have
                                        something to point at. */}
                                    <span className="gl-chip">
                                      {r.runHeadless ? (
                                        <MonitorOff
                                          className="gl-mini-icon"
                                          role="img"
                                          aria-label="Headless"
                                        />
                                      ) : (
                                        <Globe
                                          className="gl-mini-icon"
                                          role="img"
                                          aria-label="Headed"
                                        />
                                      )}
                                      <BrowserIcon
                                        browser={runBrowserOf(r)}
                                        className="gl-mini-icon ms-[3px]"
                                        labelled={false}
                                      />
                                    </span>
                                    {/* Speed this run executed at. Shown only when
                                        the run RECORDED one: runs predating the field
                                        could have been at any speed, and a badge
                                        guessing "Fast" for them would corrupt the one
                                        comparison this is here to support — whether a
                                        slower speed actually passes more often.

                                        This one KEEPS its word, unlike the chip
                                        above. The engine dropped its name because it
                                        has its own column and the word was duplication;
                                        speed has no other column, and four speeds
                                        cannot be told apart by one timer glyph. */}
                                    {r.speed ? (
                                      <span
                                        className="gl-chip"
                                        title={
                                          r.speed === "crawl"
                                            ? "Crawl: waited for the page to load and settle after every step"
                                            : `Playback speed: ${TEST_SPEED_LABELS[r.speed]}`
                                        }
                                      >
                                        <Timer aria-hidden="true" className="gl-mini-icon me-[3px]" />
                                        {TEST_SPEED_LABELS[r.speed]}
                                      </span>
                                    ) : null}
                                    {/* Capture is a filterable tag, so it needs to be
                                        visible here — icon-only to fit the column. */}
                                    {r.captureArtifacts ? (
                                      <Camera
                                        className="gl-mini-icon"
                                        style={{ color: "var(--gl-tx-3)" }}
                                        aria-label="Screenshots captured"
                                      />
                                    ) : null}
                                  </span>
                                )}
                              </td>
                              <td className="gl-num">
                                {isBaseline ? (
                                  <span style={{ color: "var(--gl-tx-3)" }} title={r.note}>
                                    {r.note ?? "—"}
                                  </span>
                                ) : (
                                  fmtDuration(r.durationMs)
                                )}
                              </td>
                              <td className="gl-num" style={{ color: "var(--gl-tx-3)" }}>
                                {isBaseline ? "—" : fmtBytes(r.logBytes)}
                              </td>
                            </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {filteredRuns.length === 0 ? (
                    <p className="gl-panel-note" style={{ textAlign: "center", padding: "18px 10px" }}>
                      No runs match these filters.
                    </p>
                  ) : null}
                  <Pager
                    page={runsPage}
                    total={filteredRuns.length}
                    onPage={setRunsPage}
                    label="runs"
                    size={DENSE_PAGE_SIZE}
                  />
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </ScrollArea>

      {/* Log inspector */}
      {logRun ? (
        <LogInspector runId={logRun.id} title={logRun.title} onClose={() => setLogRun(null)} />
      ) : null}

      {/* Reset / delete-all confirm */}
      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title={
          confirm === "all"
            ? "Delete stats and logs?"
            : confirm === "aiDebug"
              ? "Delete saved AI debug sessions?"
              : "Reset stats?"
        }
        description={
          confirm === "all"
            ? "Permanently deletes all run history and every raw log file. This can't be undone."
            : confirm === "aiDebug"
              ? "Permanently deletes every saved AI diagnosis, including any still minimized. Running jobs are unaffected until they finish. This can't be undone."
              : "Clears the run history and charts. The raw log files stay on disk (reveal them from the Manage menu)."
        }
        confirmLabel={
          confirm === "all"
            ? "Delete everything"
            : confirm === "aiDebug"
              ? "Delete sessions"
              : "Reset stats"
        }
        confirmVariant="destructive"
        onConfirm={runConfirmedDelete}
      />

      {/* Delete logs by date range */}
      <Dialog
        open={rangeOpen}
        onOpenChange={setRangeOpen}
        title="Delete logs by date"
        description="Removes runs (and their raw logs) that started within the selected date range, inclusive."
        confirmLabel="Delete range"
        confirmVariant="destructive"
        confirmDisabled={!rangeFrom || !rangeTo}
        onConfirm={runRangeDelete}
      >
        <div className="flex items-end gap-3">
          {/* The picker itself is native-backed and stays; what left with the
              SDK is `Field`, whose label is one <label> and a gap. */}
          <label className="flex flex-col gap-1">
            <span className="gl-kpi-label">From</span>
            <NativeDatePickerRoot value={rangeFrom} onValueChange={setRangeFrom} type="date">
              <NativeDatePickerTrigger>
                <Calendar className="size-4" style={{ color: "var(--gl-tx-3)" }} />
                <NativeDatePickerValue placeholder="Start date" />
              </NativeDatePickerTrigger>
            </NativeDatePickerRoot>
          </label>
          <label className="flex flex-col gap-1">
            <span className="gl-kpi-label">To</span>
            <NativeDatePickerRoot value={rangeTo} onValueChange={setRangeTo} type="date">
              <NativeDatePickerTrigger>
                <Calendar className="size-4" style={{ color: "var(--gl-tx-3)" }} />
                <NativeDatePickerValue placeholder="End date" />
              </NativeDatePickerTrigger>
            </NativeDatePickerRoot>
          </label>
        </div>
      </Dialog>
    </div>
  );
}
