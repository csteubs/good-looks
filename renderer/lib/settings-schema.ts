// The shape of the Settings window, as data.
//
// Settings grew one FieldSet at a time until it was ~30 rows in six UNLABELLED
// groups, and the only way to find a control was to scroll past every other
// one. The redesign splits it into panes with a searchable sidebar — which only
// works if "which pane owns this setting" and "what words find it" are facts
// the code can read, not something spelled twice in JSX and prose.
//
// Everything here is pure and DOM-free so it runs in the node project. The
// clamps especially: they used to be inline arithmetic inside async handlers,
// where the only way to test "9999 runs is refused" was to render a window and
// fire a change event.

import type { RecorderSettings } from "./recorder-types";
import {
  COST_DEFAULT_MINUTES_PER_MANUAL_RUN,
  COST_DEFAULT_PER_CI_MINUTE,
  DEFAULT_COST_CURRENCY,
} from "../../shared/cost-units.mjs";

// ── Panes ────────────────────────────────────────────────────────────────────

export type PaneId =
  | "appearance"
  | "recording"
  | "test-defaults"
  | "auto-heal"
  | "storage"
  | "cost"
  | "ai"
  | "alerts"
  | "integrations"
  | "diagnostics"
  | "experiments";

/** Sidebar grouping. `null` = ungrouped, rendered above the titled groups
 *  (Appearance) or below them (Diagnostics, Experiments), which is where macOS
 *  puts the general-purpose and the developer-ish panes respectively. */
export type PaneGroup = "Testing" | "Connections" | null;

export interface PaneDef {
  id: PaneId;
  /** Sidebar row label and the pane's own heading — one string, so they cannot
   *  drift into saying different things about the same pane. */
  title: string;
  /** Sits under the pane heading. Carries the fact that used to be repeated in
   *  half the row descriptions ("each test can still override this"). */
  subtitle: string;
  group: PaneGroup;
}

export const PANES: readonly PaneDef[] = [
  {
    id: "appearance",
    title: "Appearance",
    subtitle: "How the app looks, and the flourishes you can turn off.",
    group: null,
  },
  {
    id: "recording",
    title: "Recording",
    subtitle: "The training window you record in.",
    group: "Testing",
  },
  {
    id: "test-defaults",
    title: "Test defaults",
    subtitle: "Starting values for new tests. Every one can be overridden per test.",
    group: "Testing",
  },
  {
    id: "auto-heal",
    title: "Auto-Heal",
    subtitle: "What happens when a step's locator stops matching.",
    group: "Testing",
  },
  {
    id: "storage",
    title: "Storage",
    subtitle: "How long captured screenshots stay on disk.",
    group: "Testing",
  },
  {
    // Its own pane rather than a section of Test defaults: nothing here is a
    // starting value for a new test, and nothing here changes what a run DOES.
    // These are the two numbers the Stats → Cost panel multiplies by, and the
    // pane exists so the panel can stop guessing.
    id: "cost",
    title: "Cost",
    subtitle: "What a CI minute costs, and what one manual test run costs in time.",
    group: "Testing",
  },
  {
    id: "ai",
    title: "AI",
    subtitle: "The model behind Debug with AI and Generate from prompt.",
    group: "Connections",
  },
  {
    id: "alerts",
    title: "Alerts",
    // Says "on this Mac" since the webhook moved to Integrations: what is left
    // here is three local notifications, and the pane's whole claim is now that
    // none of it goes anywhere.
    subtitle: "Being told when a run goes wrong, on this Mac.",
    group: "Connections",
  },
  {
    // The one place to answer "what does this app talk to?".
    //
    // Holds the webhook (moved from Alerts), the Linear connection, and the
    // GitHub token — which had no settings UI at all before this and could only
    // be set from inside the branch switcher, where nobody auditing the app
    // would think to look.
    //
    // The local notification rows did NOT move with the webhook. They send
    // nothing anywhere, and a pane whose subject is outbound connections is
    // weaker for listing three things that aren't.
    id: "integrations",
    title: "Integrations",
    subtitle: "Services this app connects to, and what leaves this Mac.",
    group: "Connections",
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    subtitle: "Tools for handing this app's state to someone helping you.",
    group: null,
  },
  {
    // Its own pane since B4. A flag that changes how a RUN behaves does not
    // belong buried inside AI settings, where nobody looking for "what might be
    // affecting my results?" would ever think to check.
    id: "experiments",
    title: "Experiments",
    subtitle: "Behaviour that is still being decided. Any of it can change.",
    group: null,
  },
];

export const DEFAULT_PANE_ID: PaneId = "appearance";

export function paneById(id: string): PaneDef | undefined {
  return PANES.filter((p) => p.id === id)[0];
}

export interface PaneSegment {
  group: PaneGroup;
  panes: readonly PaneDef[];
}

/**
 * The sidebar's sections, in order — RUNS of consecutive panes sharing a
 * group, not one bucket per distinct group.
 *
 * The difference matters because two separate stretches are ungrouped:
 * Appearance at the top, and Diagnostics + Experiments at the bottom, which is
 * where macOS puts the general-purpose and the developer panes. Bucketing by
 * group value would collapse those into one section and render the developer
 * panes directly under Appearance, at the top of the list.
 */
export function paneSegments(): readonly PaneSegment[] {
  const segments: PaneSegment[] = [];
  for (const pane of PANES) {
    const last = segments[segments.length - 1];
    if (last && last.group === pane.group) {
      (last.panes as PaneDef[]).push(pane);
    } else {
      segments.push({ group: pane.group, panes: [pane] });
    }
  }
  return segments;
}

// ── The searchable index ─────────────────────────────────────────────────────

export interface SettingIndexEntry {
  /** Matches the row's DOM id, so a search hit can hide every row that isn't
   *  one — see `SettingRow`. Ids are also what the tests address. */
  id: string;
  pane: PaneId;
  /** The row's visible label. */
  label: string;
  /** Words a user might search that aren't in the label. The label is searched
   *  too, so don't repeat it here. */
  keywords: string;
  /** The `RecorderSettings` key this row writes, when it writes one. Rows
   *  backed by a credential store (API key, webhook URL) or by an action
   *  button have none, which is also what keeps them out of "reset section". */
  key?: keyof RecorderSettings;
}

export const SETTING_INDEX: readonly SettingIndexEntry[] = [
  // Appearance
  // Still indexed, and the keywords still name what someone would search for.
  // "light" and "auto" especially: the row exists to answer where that control
  // went, so the search has to be able to reach it by the name of the thing
  // that is gone.
  { id: "theme", pane: "appearance", label: "Theme", keywords: "dark light auto system appearance colour color" },
  // Keywords cover the words someone reaches for when the app is too small to
  // read — "zoom", "scale", "bigger", "accessibility" — and not just the label.
  // Whoever needs this setting most is the person least able to browse for it.
  {
    id: "ui-scale",
    pane: "appearance",
    label: "Font size",
    keywords: "font text type size zoom scale bigger larger smaller legibility accessibility",
    key: "uiScale",
  },
  {
    id: "ui-typeface",
    pane: "appearance",
    label: "Typeface",
    keywords:
      "font family typeface mono monospace space grotesk sf pro menlo helvetica system classic",
    key: "uiTypeface",
  },
  // Both flourishes write the same key — it's one array of disabled ids, not a
  // field each. `paneKeys` dedupes, so the pane counts them as one setting and
  // "reset section" restores the whole array in a single write.
  {
    id: "ai-thinking-gif",
    pane: "appearance",
    label: "AI thinking gif",
    keywords: "glitch animation flourish aesthetic enhancement debug",
    key: "disabledAestheticEnhancements",
  },
  {
    id: "home-black-hole",
    pane: "appearance",
    label: "Home screen animation",
    keywords: "black hole ink drawing flourish aesthetic enhancement",
    key: "disabledAestheticEnhancements",
  },
  // Keywords name the thing that is SENT, not just the thing that is drawn:
  // someone auditing this app searches "network", "privacy" or "duckduckgo",
  // not "site icons".
  {
    id: "site-icons-from-web",
    pane: "appearance",
    label: "Fetch site icons from the web",
    keywords: "favicon icon monogram network privacy egress duckduckgo hostname third party",
    key: "siteIconsFromWeb",
  },

  // Recording
  {
    id: "show-url-bar",
    pane: "recording",
    label: "Show URL bar in training window",
    keywords: "address title bar trainer",
    key: "showUrlBar",
  },
  {
    id: "trainer-panel",
    pane: "recording",
    label: "Dock the trainer to the browser",
    keywords: "panel step list side attached window",
    key: "trainerPanelEnabled",
  },
  {
    id: "default-window-size",
    pane: "recording",
    label: "Default window size",
    keywords: "viewport resolution desktop laptop tablet mobile",
    key: "defaultWindowSize",
  },

  // Test defaults
  {
    id: "default-run-speed",
    pane: "test-defaults",
    label: "Run speed",
    keywords: "slow medium fast crawl playback delay pacing",
    key: "defaultRunSpeed",
  },
  {
    id: "default-run-browser",
    pane: "test-defaults",
    label: "Browser",
    keywords: "chromium firefox webkit engine safari chrome",
    key: "defaultRunBrowser",
  },
  {
    id: "default-run-headless",
    pane: "test-defaults",
    label: "Run tests in headless mode",
    keywords: "invisible hidden window background",
    key: "defaultRunHeadless",
  },
  {
    id: "default-batch-concurrency",
    pane: "test-defaults",
    label: "Batch tests at once",
    keywords: "parallel concurrent simultaneous suite batch workers speed",
    key: "defaultBatchConcurrency",
  },
  {
    id: "default-test-timeout",
    pane: "test-defaults",
    label: "Test timeout",
    keywords: "seconds limit slow long flow playwright",
    key: "defaultTestTimeoutMs",
  },
  {
    id: "default-capture-artifacts",
    pane: "test-defaults",
    label: "Capture screenshots",
    keywords: "visual artifacts baseline diff images",
    key: "defaultCaptureArtifacts",
  },
  {
    id: "default-record-logs",
    pane: "test-defaults",
    label: "Record console & network",
    keywords: "logs requests debug ai devtools",
    key: "defaultRecordLogs",
  },
  {
    id: "record-all-headers",
    pane: "test-defaults",
    label: "Include all request headers",
    keywords: "authorization cookie credentials secrets allowlist",
    key: "recordAllHeaders",
  },
  {
    id: "default-a11y",
    pane: "test-defaults",
    label: "Check accessibility",
    keywords: "a11y axe wcag violations contrast",
    key: "defaultA11yChecks",
  },

  // Auto-Heal
  {
    id: "auto-heal-enabled",
    pane: "auto-heal",
    label: "Auto-Heal",
    keywords: "locator selector broken repair resilient replay",
    key: "autoHealEnabled",
  },
  {
    id: "auto-heal-apply",
    pane: "auto-heal",
    label: "Apply heals automatically",
    keywords: "suggest review write locator",
    key: "autoHealApply",
  },
  {
    id: "auto-heal-retries",
    pane: "auto-heal",
    label: "Heal attempts",
    keywords: "retries tries candidates give up",
    key: "autoHealRetries",
  },
  {
    id: "auto-heal-timeout",
    pane: "auto-heal",
    label: "Per-attempt timeout",
    keywords: "milliseconds ms wait heal",
    key: "autoHealAttemptTimeoutMs",
  },

  // Storage
  {
    id: "artifact-retained-runs",
    pane: "storage",
    label: "Screenshot history per test",
    keywords: "retention keep runs delete disk space prune",
    key: "artifactRetainedRuns",
  },
  {
    id: "artifact-retention-days",
    pane: "storage",
    label: "Delete screenshots older than",
    keywords: "retention age days expiry prune disk space",
    key: "artifactRetentionDays",
  },
  {
    id: "prune-now",
    pane: "storage",
    label: "Clean up now",
    keywords: "prune delete retention disk space free",
  },

  // Cost
  // Keywords name the INVOICE, not the panel: someone who has just seen a CI
  // bill searches "spend", "price", "dollar" or "github actions", and none of
  // those words are in any of these labels.
  {
    id: "cost-currency",
    pane: "cost",
    label: "Currency",
    keywords: "money symbol dollar euro pound yen usd eur gbp jpy cad aud spend cost none",
    key: "costCurrency",
  },
  {
    id: "cost-ci-runner",
    pane: "cost",
    label: "CI runner",
    keywords: "github actions hosted runner linux windows macos arm64 x64 price rate preset",
  },
  {
    id: "cost-per-ci-minute",
    pane: "cost",
    label: "Price per CI minute",
    keywords: "spend cost money price rate minute ci github actions invoice bill",
    key: "costPerCiMinute",
  },
  {
    id: "cost-minutes-per-manual-run",
    pane: "cost",
    label: "Minutes to run one test by hand",
    keywords: "manual testing time saved avoided hours by hand human",
    key: "costMinutesPerManualRun",
  },

  // AI
  {
    id: "llm-provider",
    pane: "ai",
    label: "AI provider",
    keywords: "ollama lm studio claude anthropic local model llm",
  },
  { id: "llm-server-url", pane: "ai", label: "Server URL", keywords: "ollama lm studio host port localhost" },
  { id: "anthropic-key", pane: "ai", label: "API key", keywords: "claude anthropic secret token credential" },
  {
    id: "lmstudio-token",
    pane: "ai",
    label: "API token",
    keywords: "lm studio bearer authentication unauthorized 401 credential secret",
  },
  { id: "llm-model", pane: "ai", label: "Model", keywords: "llm ollama claude sonnet opus haiku" },

  // Alerts
  {
    id: "notify-run-issues",
    pane: "alerts",
    label: "Notify when a run has problems",
    keywords: "notification macos banner failure local",
    key: "notifyOnRunIssues",
  },
  {
    id: "notify-batch-done",
    pane: "alerts",
    label: "Notify when a batch finishes",
    keywords: "notification macos banner batch suite finished local",
    key: "notifyOnBatchDone",
  },
  {
    id: "notify-ai-debug-done",
    pane: "alerts",
    label: "Notify when an AI debug job finishes",
    keywords: "notification macos banner ai debug llm answer ready local",
    key: "notifyOnAiDebugDone",
  },

  // Integrations
  //
  // The webhook rows keep their ids across the move to this pane. The id is
  // what `SettingRow` hides on, what search matches, and what every existing
  // test addresses — renaming them to match the new pane would break all three
  // to make the strings tidier.
  {
    id: "linear-connection",
    pane: "integrations",
    label: "Linear",
    keywords: "issue tracker ticket bug api key connect linear team project workspace",
  },
  {
    id: "linear-default-team",
    pane: "integrations",
    label: "Default team",
    keywords: "linear team default destination triage",
  },
  {
    id: "linear-default-project",
    pane: "integrations",
    label: "Default project",
    keywords: "linear project default destination milestone",
  },
  {
    id: "alert-webhook-enabled",
    pane: "integrations",
    label: "Send alerts to a webhook",
    keywords: "slack discord post http remote alerts",
    key: "alertWebhookEnabled",
  },
  {
    id: "alert-webhook-url",
    pane: "integrations",
    label: "Webhook URL",
    keywords: "slack discord secret credential https endpoint alerts",
  },
  {
    id: "github-token",
    pane: "integrations",
    label: "GitHub token",
    keywords: "branch switcher pull request private repository rate limit credential",
  },

  // Diagnostics
  {
    id: "debug-screenshots",
    pane: "diagnostics",
    label: "Debug screenshots",
    keywords: "mcp claude code capture window shortcut helper",
    key: "debugScreenshots",
  },
  {
    id: "debug-capture-now",
    pane: "diagnostics",
    label: "Capture now",
    keywords: "screenshot mcp immediate window",
  },

  // Experiments. The keywords still carry "ai" and "debug" because that is what
  // someone looking for these will type — "experiments" is the pane they ended
  // up in, not a word anyone would search for.
  {
    id: "keep-running-ai-debug-jobs",
    pane: "experiments",
    label: "Keep a running AI debug job when a test is re-run",
    keywords: "experimental ai debug cancel session survive rerun",
    key: "keepRunningAiDebugJobs",
  },
  {
    id: "auto-accept-ai-debug-fixes",
    pane: "experiments",
    label: "Apply AI debug fixes automatically",
    keywords: "experimental ai debug auto accept apply suggestion corrected script",
    key: "autoAcceptAiDebugFixes",
  },
];

/**
 * Ids of the settings matching `query`.
 *
 * Case-insensitive substring over label + keywords + the owning pane's title,
 * every whitespace-separated term required. Substring rather than fuzzy on
 * purpose: a settings search that returns near-misses is worse than one that
 * returns nothing, because the user cannot tell "no such setting" from "the
 * matcher is being clever".
 *
 * The pane title is part of the haystack so "storage" lists that pane's rows
 * rather than only the two whose labels happen to contain the word.
 */
export function searchSettings(query: string): readonly string[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return SETTING_INDEX.map((e) => e.id);
  return SETTING_INDEX.filter((entry) => {
    const pane = paneById(entry.pane);
    const haystack = `${entry.label} ${entry.keywords} ${pane ? pane.title : ""}`.toLowerCase();
    return terms.every((term) => haystack.indexOf(term) !== -1);
  }).map((e) => e.id);
}

/** How many of `matchedIds` each pane holds, for the sidebar's result counts.
 *  Panes with no match are absent rather than present with 0 — the caller
 *  filters on presence. */
export function matchCountByPane(matchedIds: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of matchedIds) {
    const entry = SETTING_INDEX.filter((e) => e.id === id)[0];
    if (!entry) continue;
    counts[entry.pane] = (counts[entry.pane] ?? 0) + 1;
  }
  return counts;
}

// ── Defaults, and what differs from them ─────────────────────────────────────

/**
 * The value each setting has when nothing has been chosen.
 *
 * MIRRORS `recorder-settings-store.ts`, which is the authority — the backend
 * clamps and defaults again on the way in. This copy exists so the window can
 * say "3 settings differ from the default" without asking the backend what a
 * default is, and so "reset section" has something to write.
 *
 * A key missing here is a key "reset section" will not touch, which is the
 * safe direction to be wrong in.
 */
export const SETTINGS_DEFAULTS: Partial<RecorderSettings> = {
  showUrlBar: true,
  trainerPanelEnabled: false,
  defaultRunSpeed: "slow",
  defaultWindowSize: null,
  defaultCaptureArtifacts: false,
  defaultRecordLogs: false,
  recordAllHeaders: false,
  siteIconsFromWeb: false,
  keepRunningAiDebugJobs: false,
  defaultRunHeadless: false,
  defaultRunBrowser: "chromium",
  defaultBatchConcurrency: 1,
  defaultTestTimeoutMs: 60_000,
  artifactRetainedRuns: 10,
  artifactRetentionDays: 0,
  notifyOnRunIssues: false,
  notifyOnBatchDone: true,
  notifyOnAiDebugDone: false,
  autoAcceptAiDebugFixes: false,
  alertWebhookEnabled: false,
  autoHealEnabled: true,
  autoHealRetries: 3,
  autoHealAttemptTimeoutMs: 4000,
  autoHealApply: "suggest",
  defaultA11yChecks: false,
  debugScreenshots: false,
  disabledAestheticEnhancements: [],
  uiScale: 1,
  uiTypeface: "space",
  costCurrency: DEFAULT_COST_CURRENCY,
  costPerCiMinute: COST_DEFAULT_PER_CI_MINUTE,
  costMinutesPerManualRun: COST_DEFAULT_MINUTES_PER_MANUAL_RUN,
};

/** Structural equality for the three shapes a setting value actually takes:
 *  primitive, `{width,height} | null`, and `string[]`. `===` alone would report
 *  an untouched `disabledAestheticEnhancements` as modified on every load,
 *  because the array arrives fresh from JSON each time. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sortedA = a.slice().sort();
    const sortedB = b.slice().sort();
    return sortedA.every((v, i) => v === sortedB[i]);
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const va = a as { width?: number; height?: number };
    const vb = b as { width?: number; height?: number };
    return va.width === vb.width && va.height === vb.height;
  }
  return false;
}

/** The `RecorderSettings` keys a pane owns, in index order. */
export function paneKeys(pane: PaneId): readonly (keyof RecorderSettings)[] {
  const keys: (keyof RecorderSettings)[] = [];
  for (const entry of SETTING_INDEX) {
    if (entry.pane === pane && entry.key && keys.indexOf(entry.key) === -1) keys.push(entry.key);
  }
  return keys;
}

/**
 * Which of `pane`'s settings differ from their default.
 *
 * A key absent from `settings` counts as unmodified: a partial object is what
 * arrives before the load resolves, and reporting "everything is modified" for
 * one frame would flash a count on every pane each time the window opens.
 */
export function modifiedKeys(
  settings: Partial<RecorderSettings> | null,
  pane: PaneId,
): readonly (keyof RecorderSettings)[] {
  if (!settings) return [];
  return paneKeys(pane).filter((key) => {
    if (!(key in settings)) return false;
    if (!(key in SETTINGS_DEFAULTS)) return false;
    return !sameValue(settings[key], SETTINGS_DEFAULTS[key]);
  });
}

/** The patch that returns a pane to its defaults. Only keys the pane owns AND
 *  that have a known default — so a credential-backed row can never be caught
 *  up in a reset. */
export function resetPatch(pane: PaneId): Partial<RecorderSettings> {
  const patch: Partial<RecorderSettings> = {};
  for (const key of paneKeys(pane)) {
    if (!(key in SETTINGS_DEFAULTS)) continue;
    // Copy the array rather than share the module-level one: it is handed to
    // setState and would otherwise alias the defaults object for every caller.
    const value = SETTINGS_DEFAULTS[key];
    (patch as Record<string, unknown>)[key] = Array.isArray(value) ? value.slice() : value;
  }
  return patch;
}

// ── Clamps ───────────────────────────────────────────────────────────────────
//
// Each takes the RAW string from an `<input type="number">`, because that is
// what the control holds: it can be empty, "-" mid-typing, "1e9", or "abc".
// The bounds MIRROR `recorder-settings-store.ts`. Clamping here as well is not
// redundant — a value the backend silently rewrites reads as the app ignoring
// what you typed.
//
// The `Number(raw) || fallback` idiom treats 0 as absent, which is deliberate
// everywhere it matters: "0 heal attempts" is not a request for zero, it is a
// half-typed number. `clampRetentionDays` is the one place 0 is meaningful, and
// there the fallback IS 0, so the idiom lands on the same answer either way.

export function clampTestTimeoutSec(raw: string | number): number {
  return Math.max(5, Math.min(30 * 60, Math.round(Number(raw) || 60)));
}

export function clampRetainedRuns(raw: string | number): number {
  return Math.max(1, Math.min(50, Math.round(Number(raw) || 10)));
}

export function clampRetentionDays(raw: string | number): number {
  return Math.max(0, Math.min(365, Math.round(Number(raw) || 0)));
}

export function clampHealRetries(raw: string | number): number {
  return Math.max(1, Math.min(10, Math.round(Number(raw) || 3)));
}

export function clampHealTimeoutMs(raw: string | number): number {
  return Math.max(1000, Math.min(30000, Math.round(Number(raw) || 4000)));
}

// THE COST PANE'S TWO NUMBERS ARE NOT CLAMPED HERE, deliberately. Every clamp
// above rounds to an integer (`settings-schema.test.ts` pins that as a
// property of the whole family, because these values reach the Playwright CLI
// and the retention sweep), and a price of 0.008 does not survive rounding.
// They also both use `Number(raw) || fallback`, which treats 0 as absent —
// right for "0 heal attempts", wrong for a CI price, where 0 is the real
// answer for a self-hosted runner. `clampCostPerCiMinute` and
// `clampMinutesPerManualRun` in `shared/cost-units.mjs` are what the pane calls
// instead, and they are the same two functions the settings store validates
// with, so the pane and the store cannot disagree about what is valid.

// ── Formatting ───────────────────────────────────────────────────────────────

/** Human-readable size for the screenshot-storage readout (KB/MB/GB, 1 decimal
 *  once past KB so "0.6 MB" reads better than "614 KB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
