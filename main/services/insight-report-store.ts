// The insight reports and the scheduler's state, on disk.
//
// PRIMARY data, not a cache: an LLM answer cannot be re-derived from history,
// which is why this is a JSON store and not rows in metrics.db — the metrics
// DB drops and replays itself on every schema bump, and a report would go
// with it. One file holds both the reports and the scheduler state
// (`lastGeneratedAt` and friends) because they change together: a report
// write always advances the state, and two files would be two tmp+rename
// cycles that can disagree after a crash.
//
// Reports quote test names and error signatures, so the file lives in
// `userData/recorder` beside the other content-bearing stores and clears with
// them. It is NOT cascade-deleted with a test: a report is period history,
// like a tombstoned run record, and a deleted test's action renders disabled
// rather than rewriting what the report said.
//
// Everything read from disk is rebuilt field-by-field (`normalizeInsight*` in
// main/recorder/types.ts) — a hand-edited file or an older shape degrades to
// fewer reports, never to a throw.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@shell/backend";

import {
  normalizeInsightReport,
  normalizeInsightsState,
  type InsightReport,
  type InsightReportSummary,
  type InsightsState,
} from "../recorder/types.js";

export const INSIGHT_REPORTS_VERSION = 1;

/** Two years of monthlies, half a year of weeklies. Records are KB-scale
 *  prose, so the whole-file rewrite stays cheap at this cap. */
const MAX_REPORTS = 24;

interface InsightReportsFile {
  version: number;
  state: InsightsState;
  reports: InsightReport[];
}

const EMPTY_STATE: InsightsState = {
  lastGeneratedAt: null,
  lastAttemptAt: null,
  lastError: null,
  lastSeenAppVersion: null,
};

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function indexFile(): string {
  return path.join(dataDir(), "insight-reports.json");
}

/** A corrupt or unrecognized file reads as EMPTY rather than throwing — a
 *  lost report regenerates next period; a store that throws on read takes
 *  down the view and the scheduler with it. */
function readFile(): InsightReportsFile {
  try {
    const raw = fs.readFileSync(indexFile(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { version: INSIGHT_REPORTS_VERSION, state: { ...EMPTY_STATE }, reports: [] };
    }
    const file = parsed as Partial<InsightReportsFile>;
    if (file.version !== INSIGHT_REPORTS_VERSION) {
      return { version: INSIGHT_REPORTS_VERSION, state: { ...EMPTY_STATE }, reports: [] };
    }
    const reports = (Array.isArray(file.reports) ? file.reports : [])
      .map(normalizeInsightReport)
      .filter((r): r is InsightReport => r !== null);
    return {
      version: INSIGHT_REPORTS_VERSION,
      state: normalizeInsightsState(file.state),
      reports,
    };
  } catch {
    return { version: INSIGHT_REPORTS_VERSION, state: { ...EMPTY_STATE }, reports: [] };
  }
}

function writeFile(file: InsightReportsFile): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = `${indexFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), "utf-8");
    fs.renameSync(tmp, indexFile());
  } catch (err) {
    // A failed write must never take down the generation it records — the
    // report is still in memory and the push still announces it.
    logger.warn("insights", "Failed to write insight reports", { err: String(err) });
  }
}

function sortNewestFirst(reports: InsightReport[]): InsightReport[] {
  return [...reports].sort((a, b) => b.generatedAt - a.generatedAt);
}

function summaryOf(r: InsightReport): InsightReportSummary {
  return {
    id: r.id,
    cadence: r.cadence,
    generatedAt: r.generatedAt,
    headline: r.headline,
    read: r.read,
    ...(r.degraded ? { degraded: true as const } : {}),
  };
}

export const insightReportStore = {
  list(): InsightReportSummary[] {
    return sortNewestFirst(readFile().reports).map(summaryOf);
  },

  get(id: string): InsightReport | null {
    return readFile().reports.find((r) => r.id === id) ?? null;
  },

  /** Normalized on the way IN as well as out — the report was assembled from
   *  model output, and the store is the last gate before disk. */
  save(report: InsightReport): InsightReport | null {
    const normalized = normalizeInsightReport(report);
    if (!normalized) return null;
    const file = readFile();
    const rest = file.reports.filter((r) => r.id !== normalized.id);
    file.reports = sortNewestFirst([...rest, normalized]).slice(0, MAX_REPORTS);
    writeFile(file);
    return normalized;
  },

  markRead(id: string): boolean {
    const file = readFile();
    const report = file.reports.find((r) => r.id === id);
    if (!report || report.read) return false;
    report.read = true;
    writeFile(file);
    return true;
  },

  unreadCount(): number {
    return readFile().reports.filter((r) => !r.read).length;
  },

  delete(id: string): boolean {
    const file = readFile();
    const before = file.reports.length;
    file.reports = file.reports.filter((r) => r.id !== id);
    if (file.reports.length === before) return false;
    writeFile(file);
    return true;
  },

  /** Reports AND state: someone deleting everything does not expect the app
   *  to remember when it last generated one of the things they deleted. */
  clearAll(): number {
    const file = readFile();
    const removed = file.reports.length;
    writeFile({ version: INSIGHT_REPORTS_VERSION, state: { ...EMPTY_STATE }, reports: [] });
    return removed;
  },

  state(): InsightsState {
    return readFile().state;
  },

  saveState(patch: Partial<InsightsState>): InsightsState {
    const file = readFile();
    file.state = normalizeInsightsState({ ...file.state, ...patch });
    writeFile(file);
    return file.state;
  },
};
