// Persists global trainer preferences (independent of any recording session)
// to a small JSON file under userData, mirroring llm-config-store.ts.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@shell/backend";

import {
  isInsightsCadence,
  isRunBrowser,
  isTestSpeed,
  isUiScale,
  isUiTypeface,
  MAX_BATCH_CONCURRENCY,
  MAX_BATCH_TEST_OPTIONS,
  RUN_BROWSERS,
} from "../recorder/types.js";
import type { BatchRowOptions, RecorderSettings } from "../recorder/types.js";
import { normalizeViewport } from "../recorder/window-size.js";
import {
  clampCostPerCiMinute,
  clampHourlyRate,
  clampMinutesPerManualDebug,
  clampMinutesPerManualRun,
  COST_DEFAULT_HOURLY_RATE,
  COST_DEFAULT_MINUTES_PER_MANUAL_DEBUG,
  COST_DEFAULT_MINUTES_PER_MANUAL_RUN,
  COST_DEFAULT_PER_CI_MINUTE,
  DEFAULT_COST_CURRENCY,
  isCostCurrency,
} from "../../shared/cost-units.mjs";
import { DEFAULT_RETAINED_RUNS } from "./artifact-store.js";
import {
  clampTestTimeoutMs,
  DEFAULT_TEST_TIMEOUT_MS,
  isTestTimeoutMs,
} from "../../shared/run-pacing.mjs";
import {
  isProxySource,
  isProxyTraffic,
  normalizeProxyUrl,
  PROXY_DEFAULTS,
} from "../../shared/proxy-config.mjs";

/** Bounds for `artifactRetainedRuns`. 1 keeps only the newest run (the pinned
 *  baseline is stored separately and is never pruned); 50 is a generous ceiling
 *  — at ~0.6 MB per captured run for a small test that's ~30 MB per test. */
const MIN_RETAINED_RUNS = 1;
const MAX_RETAINED_RUNS = 50;

/** Bounds for `artifactRetentionDays`. 0 disables age-based pruning entirely
 *  (the run-count cap still applies); 365 is a sane ceiling for a local app. */
const MAX_RETENTION_DAYS = 365;

/** Bounds for `runLogRetainedRuns` — how many recent runs keep their raw .log.
 *
 *  0 is meaningful and allowed: keep the records and their counts, keep no
 *  console output at all. The ceiling is the record cap, because a log without
 *  a record is unreachable — nothing can open it. */
const MAX_RUN_LOGS = 50_000;
export const DEFAULT_RUN_LOG_RETAINED_RUNS = 1000;

function clampRunLogs(n: number): number {
  return Math.max(0, Math.min(MAX_RUN_LOGS, Math.round(n)));
}

/** Ceiling on the persisted batch order. Far above any real library; exists so
 *  a corrupt file can't grow without bound across saves. */
const MAX_BATCH_ORDER = 1000;

/** The Playwright per-test timeout's bounds and helpers. Defined in
 *  shared/run-pacing.mjs — the standalone MCP server clamps against the same
 *  numbers, and a second copy of a bound is a bound that eventually disagrees.
 *  Re-exported here because this module is where the rest of the app already
 *  imports them from. */
export {
  MIN_TEST_TIMEOUT_MS,
  MAX_TEST_TIMEOUT_MS,
  DEFAULT_TEST_TIMEOUT_MS,
  clampTestTimeoutMs,
  isTestTimeoutMs,
} from "../../shared/run-pacing.mjs";

function clampDays(n: number): number {
  return Math.min(MAX_RETENTION_DAYS, Math.max(0, Math.round(n)));
}

function clampRetained(n: number): number {
  return Math.min(MAX_RETAINED_RUNS, Math.max(MIN_RETAINED_RUNS, Math.round(n)));
}

/** Clamp the stored batch-concurrency default into 1–MAX_BATCH_CONCURRENCY.
 *
 *  Falls back rather than clamping for a non-number: a hand-edited `"4"` or a
 *  null is a corrupt file, not a request for one-at-a-time, and `Math.round`
 *  would happily turn `null` into 0 and then into the floor. */
function clampBatchDefault(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_BATCH_CONCURRENCY, Math.max(1, Math.round(value)));
}

/**
 * Rebuild the per-row Batch options from whatever was on disk (or arrived over
 * IPC). REBUILDS rather than filters, per the capture-boundary rule: spreading
 * the input would carry every unknown key straight back out to the file, and
 * into whatever reads it next.
 *
 * Three things this must get right, each of which is silent when wrong:
 *  - The output is seeded from a null-prototype object, so a hand-edited
 *    `__proto__` key in the JSON is an ordinary entry rather than a prototype
 *    write.
 *  - `browsers` is filtered THROUGH RUN_BROWSERS, which validates, dedupes and
 *    normalises order in one pass — so `["webkit","webkit","nope"]` becomes
 *    `["webkit"]` and can't run a test twice on one engine.
 *  - An entry whose browsers validated to empty is DROPPED, not kept: a stored
 *    zero-engine row is a ticked test that never runs, and falling back to the
 *    defaults is the recoverable outcome.
 */
function normalizeBatchTestOptions(raw: unknown): Record<string, BatchRowOptions> {
  const out: Record<string, BatchRowOptions> = Object.create(null) as Record<
    string,
    BatchRowOptions
  >;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let kept = 0;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= MAX_BATCH_TEST_OPTIONS) break;
    if (typeof id !== "string" || id === "") continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const wanted = Array.isArray(row.browsers) ? (row.browsers as unknown[]) : [];
    const browsers = RUN_BROWSERS.filter((b) => wanted.includes(b));
    if (browsers.length === 0) continue;
    out[id] = {
      selected: row.selected === true,
      browsers,
      headless: row.headless === true,
    };
    kept++;
  }
  return out;
}

const DEFAULT_SETTINGS: RecorderSettings = {
  showUrlBar: true,
  // Opt-in: the panel moves and resizes real windows, so it stays off until
  // the user asks for it. The in-window trainer is unchanged either way.
  trainerPanelEnabled: false,
  defaultRunSpeed: "slow",
  defaultWindowSize: null,
  autoHealEnabled: true,
  autoHealRetries: 3,
  autoHealAttemptTimeoutMs: 4000,
  // Suggest, not apply. A mis-heal usually SUCCEEDS — clicking the wrong button
  // rarely throws — so silently rewriting the stored test is the failure mode
  // with no signal. The user opts into that; they do not get it by default.
  autoHealApply: "suggest",
  defaultCaptureArtifacts: false,
  defaultA11yChecks: false,
  defaultRecordLogs: false,
  recordAllHeaders: false,
  // An egress path, so `false` here is a security default rather than a taste
  // one. See the field's own note in `recorder-types.ts`.
  siteIconsFromWeb: false,
  keepRunningAiDebugJobs: false,
  debugScreenshots: false,
  defaultRunHeadless: false,
  defaultRunBrowser: "chromium",
  // 1 minute — Playwright's built-in 30s default kills ordinary multi-step runs.
  defaultTestTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
  alertWebhookEnabled: false,
  batchOrder: [],
  // Nothing collapsed. This is the direction that matters: the list stores
  // what is HIDDEN, so an empty one shows the whole library — see
  // `collapsedTestGroups`.
  collapsedTestGroups: [],
  // Empty is the correct default and needs no migration: every test resolves
  // its row from its own record and the defaults above until the user touches
  // a control. See BatchRowOptions.
  batchTestOptions: {},
  // One at a time. Parallel batches are opt-in: they multiply CPU load and, run
  // headed, open a browser window per test — neither is something to hand
  // someone who never asked for it.
  defaultBatchConcurrency: 1,
  artifactRetainedRuns: DEFAULT_RETAINED_RUNS,
  runLogRetainedRuns: DEFAULT_RUN_LOG_RETAINED_RUNS,
  artifactRetentionDays: 0,
  notifyOnRunIssues: false,
  // ON by default, unlike the per-run notification. A batch is a job you walk
  // away from, and the whole point is to be told it ended.
  notifyOnBatchDone: true,
  notifyOnAiDebugDone: false,
  // OFF by default, and this one is load-bearing: enabling it is the consent
  // for the app's only unattended AI send.
  aiInsightsEnabled: false,
  aiInsightsCadence: "weekly",
  // ON by default like notifyOnBatchDone, and gated behind aiInsightsEnabled
  // in practice: a report that generates unattended and announces nothing is
  // one nobody finds.
  notifyOnInsightsReady: true,
  // OFF by default — a send off the machine the user has to switch on, and
  // inert until they also store a webhook URL for it.
  insightsSlackEnabled: false,
  autoAcceptAiDebugFixes: false,
  disabledAestheticEnhancements: [],
  // 100%. The theme is drawn at these exact pixel sizes, so the default has to
  // be the identity — anything else would mean the app never renders at the
  // size it was designed at unless someone goes looking for the setting.
  uiScale: 1,
  uiTypeface: "space",
  // USD, because the runner prices the Settings pane offers are published in
  // it. The two numbers below are the app's own conservative guesses, and the
  // Cost panel says so on screen for as long as they are unchanged.
  costCurrency: DEFAULT_COST_CURRENCY,
  costPerCiMinute: COST_DEFAULT_PER_CI_MINUTE,
  costMinutesPerManualRun: COST_DEFAULT_MINUTES_PER_MANUAL_RUN,
  costMinutesPerManualDebug: COST_DEFAULT_MINUTES_PER_MANUAL_DEBUG,
  // 0 = no hourly rate stated. Not a price, and never rendered as one: the app
  // declines to guess what an hour of the user's time is worth, so every money
  // figure derived from saved time stays hidden until they say.
  costHourlyRate: COST_DEFAULT_HOURLY_RATE,
  // "none": the proxy feature is inert until asked for — nothing about how
  // this app reaches the network changes on the strength of a default. The
  // rest of the configuration is kept even at "none" (that is what "none"
  // means — ignored, not erased). Defaults defined in shared/proxy-config.mjs
  // because the MCP server reads this same file and must land on the same
  // answers for the same bytes.
  proxyTraffic: PROXY_DEFAULTS.proxyTraffic,
  proxySource: PROXY_DEFAULTS.proxySource,
  proxyUrl: PROXY_DEFAULTS.proxyUrl,
  proxyUsername: PROXY_DEFAULTS.proxyUsername,
  proxySslVerify: PROXY_DEFAULTS.proxySslVerify,
};

/** A stored or incoming proxy URL, canonicalised — or "" for anything that
 *  fails validation, INCLUDING a URL carrying credentials. Blank is the
 *  recoverable outcome: the proxy simply never applies, where "repairing" a
 *  hand-edited value would send traffic somewhere the user didn't write. */
function normalizeProxyUrlOrBlank(value: unknown): string {
  const result = normalizeProxyUrl(value);
  return result.ok ? result.url : "";
}


function settingsFile(): string {
  return path.join(app.getPath("userData"), "recorder", "recorder-settings.json");
}

function read(): RecorderSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf-8")) as Partial<RecorderSettings>;
    return {
      showUrlBar: typeof parsed.showUrlBar === "boolean" ? parsed.showUrlBar : DEFAULT_SETTINGS.showUrlBar,
      trainerPanelEnabled:
        typeof parsed.trainerPanelEnabled === "boolean"
          ? parsed.trainerPanelEnabled
          : DEFAULT_SETTINGS.trainerPanelEnabled,
      defaultRunSpeed: isTestSpeed(parsed.defaultRunSpeed) ? parsed.defaultRunSpeed : DEFAULT_SETTINGS.defaultRunSpeed,
      // Normalized, not cast: these numbers size a native window and are
      // written into a generated spec, so a hand-edited or corrupt file must
      // fall back to the default rather than reach either.
      defaultWindowSize: normalizeViewport(parsed.defaultWindowSize),
      autoHealEnabled: typeof parsed.autoHealEnabled === "boolean" ? parsed.autoHealEnabled : DEFAULT_SETTINGS.autoHealEnabled,
      autoHealRetries:
        typeof parsed.autoHealRetries === "number" && parsed.autoHealRetries > 0
          ? Math.min(Math.round(parsed.autoHealRetries), 10)
          : DEFAULT_SETTINGS.autoHealRetries,
      autoHealAttemptTimeoutMs:
        typeof parsed.autoHealAttemptTimeoutMs === "number" && parsed.autoHealAttemptTimeoutMs >= 1000
          ? Math.min(Math.round(parsed.autoHealAttemptTimeoutMs), 30000)
          : DEFAULT_SETTINGS.autoHealAttemptTimeoutMs,
      autoHealApply:
        parsed.autoHealApply === "apply" || parsed.autoHealApply === "suggest"
          ? parsed.autoHealApply
          : DEFAULT_SETTINGS.autoHealApply,
      defaultA11yChecks:
        typeof parsed.defaultA11yChecks === "boolean"
          ? parsed.defaultA11yChecks
          : DEFAULT_SETTINGS.defaultA11yChecks,
      defaultRecordLogs:
        typeof parsed.defaultRecordLogs === "boolean"
          ? parsed.defaultRecordLogs
          : DEFAULT_SETTINGS.defaultRecordLogs,
      recordAllHeaders:
        typeof parsed.recordAllHeaders === "boolean"
          ? parsed.recordAllHeaders
          : DEFAULT_SETTINGS.recordAllHeaders,
      siteIconsFromWeb:
        typeof parsed.siteIconsFromWeb === "boolean"
          ? parsed.siteIconsFromWeb
          : DEFAULT_SETTINGS.siteIconsFromWeb,
      keepRunningAiDebugJobs:
        typeof parsed.keepRunningAiDebugJobs === "boolean"
          ? parsed.keepRunningAiDebugJobs
          : DEFAULT_SETTINGS.keepRunningAiDebugJobs,
      debugScreenshots:
        typeof parsed.debugScreenshots === "boolean"
          ? parsed.debugScreenshots
          : DEFAULT_SETTINGS.debugScreenshots,
      defaultCaptureArtifacts:
        typeof parsed.defaultCaptureArtifacts === "boolean"
          ? parsed.defaultCaptureArtifacts
          : DEFAULT_SETTINGS.defaultCaptureArtifacts,
      defaultRunHeadless:
        typeof parsed.defaultRunHeadless === "boolean"
          ? parsed.defaultRunHeadless
          : DEFAULT_SETTINGS.defaultRunHeadless,
      // Validated rather than cast: an unknown engine name would be passed
      // straight to the Playwright CLI and fail the run.
      defaultRunBrowser: isRunBrowser(parsed.defaultRunBrowser)
        ? parsed.defaultRunBrowser
        : DEFAULT_SETTINGS.defaultRunBrowser,
      defaultTestTimeoutMs: isTestTimeoutMs(parsed.defaultTestTimeoutMs)
        ? clampTestTimeoutMs(parsed.defaultTestTimeoutMs)
        : DEFAULT_SETTINGS.defaultTestTimeoutMs,
      alertWebhookEnabled:
        typeof parsed.alertWebhookEnabled === "boolean"
          ? parsed.alertWebhookEnabled
          : DEFAULT_SETTINGS.alertWebhookEnabled,
      // Ids only, capped — a corrupt or bloated array would otherwise be
      // written straight back out on the next settings save.
      batchOrder: Array.isArray(parsed.batchOrder)
        ? parsed.batchOrder.filter((v: unknown) => typeof v === "string").slice(0, MAX_BATCH_ORDER)
        : DEFAULT_SETTINGS.batchOrder,
      // Names only, capped with the same ceiling the order uses. A name no test
      // carries is inert rather than pruned — groups have no records to clean
      // up, so a folder that comes back keeps the state it had.
      collapsedTestGroups: Array.isArray(parsed.collapsedTestGroups)
        ? parsed.collapsedTestGroups
            .filter((v: unknown) => typeof v === "string")
            .slice(0, MAX_BATCH_ORDER)
        : DEFAULT_SETTINGS.collapsedTestGroups,
      batchTestOptions: normalizeBatchTestOptions(parsed.batchTestOptions),
      defaultBatchConcurrency: clampBatchDefault(
        parsed.defaultBatchConcurrency,
        DEFAULT_SETTINGS.defaultBatchConcurrency,
      ),
      artifactRetainedRuns:
        typeof parsed.artifactRetainedRuns === "number" && parsed.artifactRetainedRuns > 0
          ? clampRetained(parsed.artifactRetainedRuns)
          : DEFAULT_SETTINGS.artifactRetainedRuns,
      // `>= 0` rather than `> 0`: zero is a choice here (keep no logs), not a
      // missing value, so the truthiness idiom the other numbers use would
      // silently rewrite it to the default on every read.
      runLogRetainedRuns:
        typeof parsed.runLogRetainedRuns === "number" && parsed.runLogRetainedRuns >= 0
          ? clampRunLogs(parsed.runLogRetainedRuns)
          : DEFAULT_SETTINGS.runLogRetainedRuns,
      artifactRetentionDays:
        typeof parsed.artifactRetentionDays === "number" && parsed.artifactRetentionDays >= 0
          ? clampDays(parsed.artifactRetentionDays)
          : DEFAULT_SETTINGS.artifactRetentionDays,
      notifyOnRunIssues:
        typeof parsed.notifyOnRunIssues === "boolean"
          ? parsed.notifyOnRunIssues
          : DEFAULT_SETTINGS.notifyOnRunIssues,
      notifyOnBatchDone:
        typeof parsed.notifyOnBatchDone === "boolean"
          ? parsed.notifyOnBatchDone
          : DEFAULT_SETTINGS.notifyOnBatchDone,
      notifyOnAiDebugDone:
        typeof parsed.notifyOnAiDebugDone === "boolean"
          ? parsed.notifyOnAiDebugDone
          : DEFAULT_SETTINGS.notifyOnAiDebugDone,
      aiInsightsEnabled:
        typeof parsed.aiInsightsEnabled === "boolean"
          ? parsed.aiInsightsEnabled
          : DEFAULT_SETTINGS.aiInsightsEnabled,
      aiInsightsCadence: isInsightsCadence(parsed.aiInsightsCadence)
        ? parsed.aiInsightsCadence
        : DEFAULT_SETTINGS.aiInsightsCadence,
      notifyOnInsightsReady:
        typeof parsed.notifyOnInsightsReady === "boolean"
          ? parsed.notifyOnInsightsReady
          : DEFAULT_SETTINGS.notifyOnInsightsReady,
      insightsSlackEnabled:
        typeof parsed.insightsSlackEnabled === "boolean"
          ? parsed.insightsSlackEnabled
          : DEFAULT_SETTINGS.insightsSlackEnabled,
      autoAcceptAiDebugFixes:
        typeof parsed.autoAcceptAiDebugFixes === "boolean"
          ? parsed.autoAcceptAiDebugFixes
          : DEFAULT_SETTINGS.autoAcceptAiDebugFixes,
      disabledAestheticEnhancements:
        Array.isArray(parsed.disabledAestheticEnhancements) &&
        parsed.disabledAestheticEnhancements.every((v) => typeof v === "string")
          ? parsed.disabledAestheticEnhancements
          : DEFAULT_SETTINGS.disabledAestheticEnhancements,
      // Membership, not a clamp, and it matters more here than anywhere else in
      // this function: `uiScale` is handed to `setZoomFactor` for every app
      // window, so a hand-edited file carrying `0` or `1e9` would open the app
      // at a size from which the Settings window cannot be read — and Settings
      // is the only way back. A bad value falls back to 100%.
      uiScale: isUiScale(parsed.uiScale) ? parsed.uiScale : DEFAULT_SETTINGS.uiScale,
      uiTypeface: isUiTypeface(parsed.uiTypeface) ? parsed.uiTypeface : DEFAULT_SETTINGS.uiTypeface,
      // Clamped rather than cast. Both numbers multiply every figure on the
      // Cost panel, so a hand-edited `0` or `1e9` on disk would render as a
      // confident "$0.00 spent" or an absurd one — a wrong answer that looks
      // exactly like a right one. The clamps live in shared/ so this path and
      // the pane that writes it cannot disagree about what is valid.
      costCurrency: isCostCurrency(parsed.costCurrency)
        ? parsed.costCurrency
        : DEFAULT_SETTINGS.costCurrency,
      costPerCiMinute: clampCostPerCiMinute(parsed.costPerCiMinute),
      costMinutesPerManualRun: clampMinutesPerManualRun(parsed.costMinutesPerManualRun),
      costMinutesPerManualDebug: clampMinutesPerManualDebug(parsed.costMinutesPerManualDebug),
      costHourlyRate: clampHourlyRate(parsed.costHourlyRate),
      // Validated with the shared guards, because the MCP server reads this
      // same file through the same module: two readers, one rule. The URL is
      // re-canonicalised on every read so a hand-edited value that smuggles
      // credentials in (`http://user:pw@host`) is blanked rather than carried
      // into a run's environment or a session's proxy rules.
      proxyTraffic: isProxyTraffic(parsed.proxyTraffic)
        ? parsed.proxyTraffic
        : DEFAULT_SETTINGS.proxyTraffic,
      proxySource: isProxySource(parsed.proxySource)
        ? parsed.proxySource
        : DEFAULT_SETTINGS.proxySource,
      proxyUrl: normalizeProxyUrlOrBlank(parsed.proxyUrl),
      proxyUsername:
        typeof parsed.proxyUsername === "string"
          ? parsed.proxyUsername
          : DEFAULT_SETTINGS.proxyUsername,
      proxySslVerify:
        typeof parsed.proxySslVerify === "boolean"
          ? parsed.proxySslVerify
          : DEFAULT_SETTINGS.proxySslVerify,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const recorderSettingsStore = {
  get(): RecorderSettings {
    return read();
  },

  set(update: Partial<RecorderSettings>): RecorderSettings {
    const current = read();
    const next: RecorderSettings = {
      showUrlBar: update.showUrlBar !== undefined ? update.showUrlBar : current.showUrlBar,
      trainerPanelEnabled:
        update.trainerPanelEnabled !== undefined
          ? update.trainerPanelEnabled
          : current.trainerPanelEnabled,
      defaultRunSpeed: update.defaultRunSpeed !== undefined && isTestSpeed(update.defaultRunSpeed)
        ? update.defaultRunSpeed
        : current.defaultRunSpeed,
      // `null` is a real choice here ("Default" in the picker), so the update
      // is applied whenever the key is PRESENT — testing truthiness would make
      // going back to the default size impossible.
      defaultWindowSize:
        update.defaultWindowSize !== undefined
          ? normalizeViewport(update.defaultWindowSize)
          : current.defaultWindowSize,
      autoHealEnabled: update.autoHealEnabled !== undefined ? update.autoHealEnabled : current.autoHealEnabled,
      autoHealRetries:
        update.autoHealRetries !== undefined && typeof update.autoHealRetries === "number" && update.autoHealRetries > 0
          ? Math.min(Math.round(update.autoHealRetries), 10)
          : current.autoHealRetries,
      autoHealAttemptTimeoutMs:
        update.autoHealAttemptTimeoutMs !== undefined &&
        typeof update.autoHealAttemptTimeoutMs === "number" &&
        update.autoHealAttemptTimeoutMs >= 1000
          ? Math.min(Math.round(update.autoHealAttemptTimeoutMs), 30000)
          : current.autoHealAttemptTimeoutMs,
      autoHealApply:
        update.autoHealApply === "apply" || update.autoHealApply === "suggest"
          ? update.autoHealApply
          : current.autoHealApply,
      defaultA11yChecks:
        update.defaultA11yChecks !== undefined
          ? update.defaultA11yChecks
          : current.defaultA11yChecks,
      defaultRecordLogs:
        update.defaultRecordLogs !== undefined
          ? update.defaultRecordLogs
          : current.defaultRecordLogs,
      recordAllHeaders:
        update.recordAllHeaders !== undefined ? update.recordAllHeaders : current.recordAllHeaders,
      siteIconsFromWeb:
        update.siteIconsFromWeb !== undefined
          ? update.siteIconsFromWeb
          : current.siteIconsFromWeb,
      keepRunningAiDebugJobs:
        update.keepRunningAiDebugJobs !== undefined
          ? update.keepRunningAiDebugJobs
          : current.keepRunningAiDebugJobs,
      debugScreenshots:
        update.debugScreenshots !== undefined
          ? update.debugScreenshots
          : current.debugScreenshots,
      defaultCaptureArtifacts:
        update.defaultCaptureArtifacts !== undefined
          ? update.defaultCaptureArtifacts
          : current.defaultCaptureArtifacts,
      defaultRunHeadless:
        update.defaultRunHeadless !== undefined
          ? update.defaultRunHeadless
          : current.defaultRunHeadless,
      defaultRunBrowser: isRunBrowser(update.defaultRunBrowser)
        ? update.defaultRunBrowser
        : current.defaultRunBrowser,
      defaultTestTimeoutMs: isTestTimeoutMs(update.defaultTestTimeoutMs)
        ? clampTestTimeoutMs(update.defaultTestTimeoutMs)
        : current.defaultTestTimeoutMs,
      alertWebhookEnabled:
        update.alertWebhookEnabled !== undefined
          ? update.alertWebhookEnabled
          : current.alertWebhookEnabled,
      batchOrder: Array.isArray(update.batchOrder)
        ? update.batchOrder.filter((v) => typeof v === "string").slice(0, MAX_BATCH_ORDER)
        : current.batchOrder,
      // Whole-list replace, like the order above: the rail always sends the
      // complete set of collapsed names, so expanding one has to be able to
      // shorten the list.
      collapsedTestGroups: Array.isArray(update.collapsedTestGroups)
        ? update.collapsedTestGroups
            .filter((v) => typeof v === "string")
            .slice(0, MAX_BATCH_ORDER)
        : current.collapsedTestGroups,
      // Whole-map replace, not a merge: the Batch view always sends the
      // complete map, and a merge would make deleting a row impossible.
      batchTestOptions:
        update.batchTestOptions !== undefined
          ? normalizeBatchTestOptions(update.batchTestOptions)
          : current.batchTestOptions,
      defaultBatchConcurrency:
        update.defaultBatchConcurrency !== undefined
          ? clampBatchDefault(update.defaultBatchConcurrency, current.defaultBatchConcurrency)
          : current.defaultBatchConcurrency,
      artifactRetainedRuns:
        update.artifactRetainedRuns !== undefined &&
        typeof update.artifactRetainedRuns === "number" &&
        update.artifactRetainedRuns > 0
          ? clampRetained(update.artifactRetainedRuns)
          : current.artifactRetainedRuns,
      runLogRetainedRuns:
        update.runLogRetainedRuns !== undefined &&
        typeof update.runLogRetainedRuns === "number" &&
        update.runLogRetainedRuns >= 0
          ? clampRunLogs(update.runLogRetainedRuns)
          : current.runLogRetainedRuns,
      artifactRetentionDays:
        update.artifactRetentionDays !== undefined &&
        typeof update.artifactRetentionDays === "number" &&
        update.artifactRetentionDays >= 0
          ? clampDays(update.artifactRetentionDays)
          : current.artifactRetentionDays,
      notifyOnRunIssues:
        update.notifyOnRunIssues !== undefined
          ? update.notifyOnRunIssues
          : current.notifyOnRunIssues,
      notifyOnBatchDone:
        update.notifyOnBatchDone !== undefined
          ? update.notifyOnBatchDone
          : current.notifyOnBatchDone,
      notifyOnAiDebugDone:
        update.notifyOnAiDebugDone !== undefined
          ? update.notifyOnAiDebugDone
          : current.notifyOnAiDebugDone,
      aiInsightsEnabled:
        update.aiInsightsEnabled !== undefined ? update.aiInsightsEnabled : current.aiInsightsEnabled,
      // Same allowlist as `read()`, on the standing principle: a value refused
      // on load but accepted on save is written to disk and then silently
      // ignored forever, which reads as "the setting does not work".
      aiInsightsCadence: isInsightsCadence(update.aiInsightsCadence)
        ? update.aiInsightsCadence
        : current.aiInsightsCadence,
      notifyOnInsightsReady:
        update.notifyOnInsightsReady !== undefined
          ? update.notifyOnInsightsReady
          : current.notifyOnInsightsReady,
      insightsSlackEnabled:
        update.insightsSlackEnabled !== undefined
          ? update.insightsSlackEnabled
          : current.insightsSlackEnabled,
      autoAcceptAiDebugFixes:
        update.autoAcceptAiDebugFixes !== undefined
          ? update.autoAcceptAiDebugFixes
          : current.autoAcceptAiDebugFixes,
      disabledAestheticEnhancements:
        update.disabledAestheticEnhancements !== undefined &&
        Array.isArray(update.disabledAestheticEnhancements) &&
        update.disabledAestheticEnhancements.every((v) => typeof v === "string")
          ? update.disabledAestheticEnhancements
          : current.disabledAestheticEnhancements,
      // Same allowlist as `read()`, and it has to be applied on BOTH paths: a
      // value rejected on load but accepted on save would be written to disk
      // and then silently ignored forever after, which reads as "the setting
      // does not work" rather than "the value was refused".
      uiScale: isUiScale(update.uiScale) ? update.uiScale : current.uiScale,
      uiTypeface: isUiTypeface(update.uiTypeface) ? update.uiTypeface : current.uiTypeface,
      // Same clamps as `read()`, on the same principle as `uiScale` above: a
      // value refused on load but accepted on save is written to disk and then
      // ignored forever, which reads as "the setting does not work".
      costCurrency: isCostCurrency(update.costCurrency) ? update.costCurrency : current.costCurrency,
      costPerCiMinute:
        update.costPerCiMinute !== undefined
          ? clampCostPerCiMinute(update.costPerCiMinute)
          : current.costPerCiMinute,
      costMinutesPerManualRun:
        update.costMinutesPerManualRun !== undefined
          ? clampMinutesPerManualRun(update.costMinutesPerManualRun)
          : current.costMinutesPerManualRun,
      costMinutesPerManualDebug:
        update.costMinutesPerManualDebug !== undefined
          ? clampMinutesPerManualDebug(update.costMinutesPerManualDebug)
          : current.costMinutesPerManualDebug,
      costHourlyRate:
        update.costHourlyRate !== undefined
          ? clampHourlyRate(update.costHourlyRate)
          : current.costHourlyRate,
      // Same guards as `read()`, on the standing principle above. The URL is
      // the one that matters: this is an IPC boundary, and whatever arrives is
      // canonicalised or blanked — never written through. Blank is a real
      // choice (clearing the field), which is why an invalid value degrades to
      // it rather than keeping the old one: both paths agree an unusable URL
      // means "no proxy".
      proxyTraffic: isProxyTraffic(update.proxyTraffic) ? update.proxyTraffic : current.proxyTraffic,
      proxySource: isProxySource(update.proxySource) ? update.proxySource : current.proxySource,
      proxyUrl:
        update.proxyUrl !== undefined ? normalizeProxyUrlOrBlank(update.proxyUrl) : current.proxyUrl,
      proxyUsername:
        update.proxyUsername !== undefined && typeof update.proxyUsername === "string"
          ? update.proxyUsername
          : current.proxyUsername,
      proxySslVerify:
        update.proxySslVerify !== undefined ? update.proxySslVerify : current.proxySslVerify,
    };
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), "utf-8");
    logger.info("recorder", "Saved trainer settings", {
      showUrlBar: next.showUrlBar,
      trainerPanelEnabled: next.trainerPanelEnabled,
      defaultRunSpeed: next.defaultRunSpeed,
      defaultWindowSize: next.defaultWindowSize,
      autoHealEnabled: next.autoHealEnabled,
      autoHealRetries: next.autoHealRetries,
      autoHealAttemptTimeoutMs: next.autoHealAttemptTimeoutMs,
      autoHealApply: next.autoHealApply,
      defaultA11yChecks: next.defaultA11yChecks,
      defaultRecordLogs: next.defaultRecordLogs,
      recordAllHeaders: next.recordAllHeaders,
      siteIconsFromWeb: next.siteIconsFromWeb,
      keepRunningAiDebugJobs: next.keepRunningAiDebugJobs,
      debugScreenshots: next.debugScreenshots,
      defaultCaptureArtifacts: next.defaultCaptureArtifacts,
      defaultRunHeadless: next.defaultRunHeadless,
      defaultRunBrowser: next.defaultRunBrowser,
      defaultTestTimeoutMs: next.defaultTestTimeoutMs,
      alertWebhookEnabled: next.alertWebhookEnabled,
      batchOrderCount: next.batchOrder.length,
      // The count, never the map: it names every test id in the library.
      batchTestOptionsCount: Object.keys(next.batchTestOptions).length,
      defaultBatchConcurrency: next.defaultBatchConcurrency,
      artifactRetainedRuns: next.artifactRetainedRuns,
      artifactRetentionDays: next.artifactRetentionDays,
      notifyOnRunIssues: next.notifyOnRunIssues,
      notifyOnBatchDone: next.notifyOnBatchDone,
      notifyOnAiDebugDone: next.notifyOnAiDebugDone,
      aiInsightsEnabled: next.aiInsightsEnabled,
      aiInsightsCadence: next.aiInsightsCadence,
      notifyOnInsightsReady: next.notifyOnInsightsReady,
      insightsSlackEnabled: next.insightsSlackEnabled,
      autoAcceptAiDebugFixes: next.autoAcceptAiDebugFixes,
      disabledAestheticEnhancements: next.disabledAestheticEnhancements,
      uiScale: next.uiScale,
      uiTypeface: next.uiTypeface,
      costCurrency: next.costCurrency,
      costPerCiMinute: next.costPerCiMinute,
      costMinutesPerManualRun: next.costMinutesPerManualRun,
      costMinutesPerManualDebug: next.costMinutesPerManualDebug,
      costHourlyRate: next.costHourlyRate,
      proxyTraffic: next.proxyTraffic,
      proxySource: next.proxySource,
      // The URL and the presence of a username, never the username itself: it
      // is half of a credential, and this log line is exactly the kind of
      // place a copied value outlives the reason it was written.
      proxyUrl: next.proxyUrl,
      proxyHasUsername: next.proxyUsername.length > 0,
      proxySslVerify: next.proxySslVerify,
    });
    return next;
  },
};
