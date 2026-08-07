import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  NativeDatePickerRoot,
  NativeDatePickerTrigger,
  NativeDatePickerValue,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  Toolbar,
  ToolbarActions,
  ToolbarContent,
  ToolbarDescription,
  ToolbarTitle,
  toast,
} from "@ui";
import {
  Calendar,
  Camera,
  Check,
  Copy,
  Globe,
  MoreHorizontal,
  MonitorOff,
  Search,
  Stamp,
  X,
  Wand2,
} from "lucide-react";

import { api } from "../lib/api";
import { FlakePanel } from "./flake-panel";
import { Pager } from "./pager";
import type { CaptureOverheadSummary, LogSearchResult, RunRecord } from "../lib/recorder-types";
import { RUN_BROWSERS, RUN_BROWSER_LABELS } from "../lib/recorder-types";
import { pageSlice } from "../lib/paginate";
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
function clipboard(): { writeText: (t: string) => void } {
  return (window as unknown as { glazeAPI: { clipboard: { writeText: (t: string) => void } } })
    .glazeAPI.clipboard;
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
    <div className="flex flex-col gap-1 rounded-lg border border-token-border bg-token-surface-raised px-4 py-3">
      <Text variant="small" color="tertiary">
        {label}
      </Text>
      <Text className="text-[22px] font-semibold leading-none">{value}</Text>
      {hint ? (
        <Text variant="small" color="secondary">
          {hint}
        </Text>
      ) : null}
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
    <div className="rounded-lg border border-token-border bg-token-surface-raised p-4">
      <div className="mb-3 flex items-center justify-between">
        <Text variant="small" className="font-medium">
          Capture overhead
        </Text>
        <Text variant="small" color="tertiary">
          {summary.capturedRuns > 0
            ? `${summary.capturedRuns} captured ${summary.capturedRuns === 1 ? "run" : "runs"} · ${summary.totalShots} screenshots`
            : `${summary.a11yRuns} accessibility ${summary.a11yRuns === 1 ? "run" : "runs"}`}
        </Text>
      </div>
      <div className="grid grid-cols-3 gap-3">
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
    </div>
  );
}

function PassFailChart({ buckets }: { buckets: DayBucket[] }) {
  const maxTotal = Math.max(1, ...buckets.map((b) => b.passed + b.failed));
  return (
    <div className="rounded-lg border border-token-border bg-token-surface-raised p-4">
      <div className="mb-3 flex items-center justify-between">
        <Text variant="small" className="font-medium">
          Pass / fail over time
        </Text>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-support-green" />
            <Text variant="small" color="secondary">
              Passed
            </Text>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-support-red" />
            <Text variant="small" color="secondary">
              Failed
            </Text>
          </span>
        </div>
      </div>
      <div className="flex h-40 gap-1.5 overflow-x-auto">
        {buckets.map((b) => {
          const total = b.passed + b.failed;
          const totalPct = (total / maxTotal) * 100;
          const passPct = total > 0 ? (b.passed / total) * 100 : 0;
          return (
            <div key={b.key} className="flex min-w-[14px] flex-1 flex-col items-center gap-1">
              <div className="flex w-full flex-1 items-end">
                <div
                  className="flex w-full flex-col justify-end overflow-hidden rounded-sm"
                  style={{ height: `${totalPct}%` }}
                  title={`${b.label}: ${b.passed} passed, ${b.failed} failed`}
                >
                  <div className="w-full bg-support-red" style={{ height: `${100 - passPct}%` }} />
                  <div className="w-full bg-support-green" style={{ height: `${passPct}%` }} />
                </div>
              </div>
              <Text variant="small" color="tertiary" className="text-[10px]">
                {b.label}
              </Text>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LogInspector({
  runId,
  title,
  onClose,
}: {
  runId: string;
  title: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const logQuery = useQuery({
    queryKey: ["run-log", runId],
    queryFn: () => api.runs.getLog(runId),
  });
  const text = logQuery.data ?? "";

  const copy = () => {
    clipboard().writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="2xl"
      title={title}
      description="Raw console output for this run."
    >
      <div className="flex flex-col gap-2">
        <div className="flex justify-end">
          <Button variant="glass" size="small" onClick={copy}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Copy log"}
          </Button>
        </div>
        <ScrollArea className="h-[55vh] rounded-md border border-token-border bg-token-surface">
          <pre className="whitespace-pre-wrap break-words p-3 text-mono font-mono text-secondary">
            {logQuery.isLoading ? "Loading…" : text || "(empty log)"}
          </pre>
        </ScrollArea>
      </div>
    </Dialog>
  );
}

/** Prev / range / Next control shared by both Stats lists. Renders nothing for
 *  a single page, so short lists aren't cluttered with dead controls. */

export function StatsView() {
  const qc = useQueryClient();
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

  // Filters apply to the run-history table only — the summary cards and chart
  // keep describing the whole history, so narrowing the table doesn't silently
  // redefine "pass rate".
  const filteredRuns = React.useMemo(
    () => runs.filter((r) => runMatchesFilters(r, filters)),
    [runs, filters],
  );

  // Distinct tests present in the history, for the test filter's options.
  const testOptions = React.useMemo(() => testFilterOptions(runs), [runs]);

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
      <Toolbar className="pt-2">
        <ToolbarContent>
          <ToolbarTitle>Stats</ToolbarTitle>
          <ToolbarDescription>
            {realRuns.length} run{realRuns.length === 1 ? "" : "s"} recorded
            {runs.length !== realRuns.length
              ? ` · ${runs.length - realRuns.length} baseline update${
                  runs.length - realRuns.length === 1 ? "" : "s"
                }`
              : ""}
          </ToolbarDescription>
        </ToolbarContent>
        <ToolbarActions>
          <Button variant="glass" size="small" onClick={openManageMenu}>
            <MoreHorizontal className="size-4" />
            Manage data
          </Button>
        </ToolbarActions>
      </Toolbar>

      {/* min-h-0 flex-1, NOT h-full. In a flex column h-full resolves to 100% of
          the PARENT, but the Toolbar above has already consumed part of that —
          so the scroll region extended past the bottom of the window by the
          toolbar's height and its last child (the pager) was cut off. flex-1
          claims only the remaining space; min-h-0 is required with it, or a
          flex item refuses to shrink below its content and overflows again. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-4xl flex-col gap-5 p-5 pb-10">
          {runs.length === 0 && !runsQuery.isLoading ? (
            <EmptyState
              className="py-16"
              title="No runs yet"
              description="Run a test from its detail page to start collecting pass/fail stats and console logs here."
            />
          ) : (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-4 gap-3">
                <StatCard label="Total runs" value={String(realRuns.length)} />
                <StatCard label="Pass rate" value={`${passRate}%`} />
                <StatCard label="Passed" value={String(passed)} />
                <StatCard label="Failed" value={String(failed)} />
              </div>

              {/* Capture overhead — only once a capture run has been measured */}
              {overheadQuery.data ? <CaptureOverheadPanel summary={overheadQuery.data} /> : null}

              {/* Stability — above the chart, because "is this test trustworthy"
                  is the question the pass rate below can't answer. */}
              {flakeQuery.data ? <FlakePanel report={flakeQuery.data} /> : null}

              {/* Chart */}
              {buckets.length > 0 ? <PassFailChart buckets={buckets} /> : null}

              {/* Search */}
              <div className="flex flex-col gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-tertiary" />
                  <Input
                    variant="filled"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search raw logs (errors, selectors, output)…"
                    className="pl-8"
                  />
                </div>

                {searching ? (
                  <div className="rounded-lg border border-token-border bg-token-surface-raised">
                    {searchQuery.isLoading ? (
                      <Text variant="small" color="tertiary" className="block p-3">
                        Searching…
                      </Text>
                    ) : searchResults.length === 0 ? (
                      <Text variant="small" color="tertiary" className="block p-3">
                        No logs match “{debounced}”.
                      </Text>
                    ) : (
                      pageSlice(searchResults, searchPage).map((r) => (
                        <button
                          key={r.runId}
                          type="button"
                          onClick={() =>
                            setLogRun({ id: r.runId, title: `${r.testName} — ${fmtDateTime(r.startedAt)}` })
                          }
                          className="flex w-full flex-col gap-1 border-b border-token-border px-3 py-2 text-left last:border-b-0 hover:bg-token-hover"
                        >
                          <div className="flex items-center gap-2">
                            <Badge color={r.status === "passed" ? "green" : "red"}>{r.status}</Badge>
                            <Text variant="small" className="font-medium">
                              {r.testName}
                            </Text>
                            <Text variant="small" color="tertiary">
                              {fmtDateTime(r.startedAt)} · {r.matchCount} match
                              {r.matchCount === 1 ? "" : "es"}
                            </Text>
                          </div>
                          <Text variant="small" color="secondary" className="line-clamp-1 font-mono">
                            {r.snippet}
                          </Text>
                        </button>
                      ))
                    )}
                    <Pager
                      page={searchPage}
                      total={searchResults.length}
                      onPage={setSearchPage}
                      label="results"
                    />
                  </div>
                ) : null}
              </div>

              {/* Run history table */}
              {!searching ? (
                <div>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Text variant="small" className="font-medium">
                      Run history
                    </Text>
                    <Text variant="small" color="tertiary">
                      {filtersActive(filters)
                        ? `${filteredRuns.length} of ${runs.length}`
                        : `${runs.length} run${runs.length === 1 ? "" : "s"}`}
                    </Text>

                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      <SegmentedControl
                        size="small"
                        value={filters.status}
                        onValueChange={(v) => {
                          // allowEmpty is off, but Radix still emits "" if the
                          // selected item is re-pressed — ignore that.
                          if (!v) return;
                          setFilters((f) => ({ ...f, status: v as StatusFilter }));
                        }}
                        aria-label="Filter runs by status"
                      >
                        <SegmentedControlItem value="all">All</SegmentedControlItem>
                        <SegmentedControlItem value="passed">Passed</SegmentedControlItem>
                        <SegmentedControlItem value="failed">Failed</SegmentedControlItem>
                        <SegmentedControlItem value="baseline">Baselines</SegmentedControlItem>
                      </SegmentedControl>

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
                            <SelectItem key={b} value={b}>
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
                        <Button
                          variant="glass"
                          size="small"
                          onClick={() => setFilters(NO_FILTERS)}
                        >
                          <X className="size-4" />
                          Clear
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="overflow-x-hidden">
                    <Table className="table-fixed">
                      <TableHeader sticky>
                        <TableRow>
                          <TableHead>Test</TableHead>
                          <TableHead className="w-20">Status</TableHead>
                          <TableHead className="w-28">Started</TableHead>
                          <TableHead className="w-28">Tags</TableHead>
                          <TableHead className="w-24 text-right">Duration</TableHead>
                          <TableHead className="w-20 text-right">Log</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pageSlice(filteredRuns, runsPage).map((r) => {
                          const isBaseline = r.kind === "baseline-update";
                          return (
                            <TableRow
                              key={r.id}
                              className={isBaseline ? "" : "cursor-pointer"}
                              onClick={() => {
                                if (isBaseline) return;
                                setLogRun({
                                  id: r.id,
                                  title: `${r.testName} — ${fmtDateTime(r.startedAt)}`,
                                });
                              }}
                            >
                              <TableCell
                                className="truncate font-medium"
                                title={r.testName}
                              >
                                {r.testName}
                              </TableCell>
                              <TableCell>
                                {isBaseline ? (
                                  <Badge color="secondary">
                                    <Stamp className="size-3" />
                                    Baseline
                                  </Badge>
                                ) : (
                                  <span className="flex items-center gap-1">
                                    <Badge color={r.status === "passed" ? "green" : "red"}>
                                      {r.status}
                                    </Badge>
                                    {/* A run that only passed because Auto-Heal
                                        substituted a locator is not the same
                                        evidence as one that passed outright, so
                                        it must not read identically. */}
                                    {r.healedSteps ? (
                                      <Badge color="orange" title={`${r.healedSteps} step${r.healedSteps === 1 ? "" : "s"} healed during this run`}>
                                        <Wand2 className="size-3" />
                                        healed
                                      </Badge>
                                    ) : null}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell
                                className="truncate text-secondary"
                                title={fmtDateTime(r.startedAt)}
                              >
                                {fmtDateTime(r.startedAt)}
                              </TableCell>
                              <TableCell>
                                {isBaseline ? (
                                  <span className="text-tertiary">—</span>
                                ) : (
                                  <span className="flex items-center gap-1">
                                    {/* One badge carries both facts: which engine
                                        ran, and whether it was visible. */}
                                    <Badge color="secondary">
                                      {r.runHeadless ? (
                                        <MonitorOff className="size-3" />
                                      ) : (
                                        <Globe className="size-3" />
                                      )}
                                      {RUN_BROWSER_LABELS[runBrowserOf(r)]}
                                    </Badge>
                                    {/* Capture is a filterable tag, so it needs to be
                                        visible here — icon-only to fit the column. */}
                                    {r.captureArtifacts ? (
                                      <Camera
                                        className="size-3 shrink-0 text-tertiary"
                                        aria-label="Screenshots captured"
                                      />
                                    ) : null}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="text-right text-secondary">
                                {isBaseline ? (
                                  <span className="text-tertiary" title={r.note}>
                                    {r.note ?? "—"}
                                  </span>
                                ) : (
                                  fmtDuration(r.durationMs)
                                )}
                              </TableCell>
                              <TableCell className="text-right text-tertiary">
                                {isBaseline ? "—" : fmtBytes(r.logBytes)}
                              </TableCell>
                            </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  {filteredRuns.length === 0 ? (
                    <Text variant="small" color="tertiary" className="block px-3 py-6 text-center">
                      No runs match these filters.
                    </Text>
                  ) : null}
                  <Pager
                    page={runsPage}
                    total={filteredRuns.length}
                    onPage={setRunsPage}
                    label="runs"
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
          <Field label="From" orientation="vertical" className="p-0">
            <NativeDatePickerRoot value={rangeFrom} onValueChange={setRangeFrom} type="date">
              <NativeDatePickerTrigger>
                <Calendar className="size-4 text-tertiary" />
                <NativeDatePickerValue placeholder="Start date" />
              </NativeDatePickerTrigger>
            </NativeDatePickerRoot>
          </Field>
          <Field label="To" orientation="vertical" className="p-0">
            <NativeDatePickerRoot value={rangeTo} onValueChange={setRangeTo} type="date">
              <NativeDatePickerTrigger>
                <Calendar className="size-4 text-tertiary" />
                <NativeDatePickerValue placeholder="End date" />
              </NativeDatePickerTrigger>
            </NativeDatePickerRoot>
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
