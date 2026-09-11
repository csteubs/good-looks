import * as React from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Callout,
  Checkbox,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Status,
  Tabs,
  TabsContent,
  TabsRoot,
  TabsTrigger,
  Toolbar,
  ToolbarActions,
  ToolbarContent,
  ToolbarDescription,
  ToolbarRow,
  ToolbarTitle,
  toast,
} from "@ui";
import { ChevronDown, Pencil, TriangleAlert, Trash2 } from "lucide-react";

import { Btn } from "../theme";
import { api } from "../lib/api";
import { normalizeSignatureHost } from "../../shared/shopify-signature.mjs";
import { useRecorder } from "./recorder-store";
import {
  runSessionKey,
  useAiDebug,
  useAiDebugStatus,
  type AiDebugRunContext,
} from "./ai-debug-store";
import { EditStepsView } from "./edit-steps-view";
import { RunOutput } from "./run-output";
import { IssueComposeDialog } from "../components/issue-compose-dialog";
import { ScriptEditor, type LineInlay, type RunLineStatus, type ScriptEditorHandle } from "./script-view";
import { isScriptDirty, markScriptDirty } from "../lib/script-buffer";
import { makeGhostSource } from "../lib/ghost-source";
import { resolveAiInstructions } from "../lib/ai-instructions";
import { applyTextEdits } from "../lib/text-edits";
import type { TsIntelligence } from "./script-view";
import { ScriptAiPanel, type ScriptAiApplyMeta, type ScriptAiMode, type ScriptAiSelection } from "./script-ai-panel";
import { ScriptOutlinePanel } from "./script-outline-panel";
import { SCRIPT_CHANGED_ON_DISK, isScriptChangedOnDisk } from "../../shared/script-save.mjs";
import { StepRow } from "./step-row";
import { VariablesPanel } from "./variables-panel";
import { HealsPanel } from "./heals-panel";
import { A11yPanel } from "./a11y-panel";
import { SiteHealthPanel } from "./site-health-panel";
import { computeStepDepths, describeStep, locatorExpr } from "../lib/describe-step";
import { gradeCounts } from "../lib/locator-grade";
import { newStepIds as computeNewStepIds } from "../lib/diff-steps";
import { latestA11yRun } from "../lib/a11y-format";
import { summariseRun } from "../lib/run-summary";
import { BROWSER_SF_SYMBOLS } from "../lib/browser-icons";
import { consumeAiDebugRequest } from "./insight-intents";
import {
  RUN_BROWSERS,
  RUN_BROWSER_LABELS,
  type RunBrowser,
  type ScriptChangeSource,
  type ScriptCheckError,
  type ScriptCheckResult,
  editorLineHeight,
  type LivePageCount,
  type LivePageStatus,
  type Step,
  type TestRecord,
  type TestVariable,
  type VariableKind,
  type TestSpeed,
  TEST_SPEEDS,
  TEST_SPEED_LABELS,
} from "../lib/recorder-types";

/** What to say when a record admits its steps and its script disagree. Three
 *  cases, not one: a warning that prescribes a fix the test can't perform is
 *  its own bug, and an imported spec is never regenerated from steps. The
 *  reason is absent on records written before it was tracked — back then a
 *  lossy parse was the only way to get here. */
function divergedMessage(test: TestRecord): string {
  if (test.stepsDivergedReason !== "unapplied") {
    return "Steps may not reflect the script — some statements in it couldn't be parsed back into steps.";
  }
  if (test.sourceDir) {
    return "These steps aren't in the script — this test runs the file it was imported with, and that file is never regenerated from steps.";
  }
  return "These steps aren't in the script — they were saved without regenerating it, so runs still use the script as it was. Edit Steps, save, then choose “Regenerate script” to apply them.";
}

/**
 * Persist a per-test engine change, then refresh every cached copy of the
 * record it just changed.
 *
 * Both keys, not just ["test", id]: the ["tests"] list holds its own copy of
 * every record and nothing in this flow refetches it, so leaving it alone
 * leaves a cache that disagrees with disk about which engine this test runs on.
 *
 * Exported because the Select is native-menu-backed: its menu is drawn by
 * AppKit and never enters the DOM, so this is the only handle a test has.
 */
export async function persistRunBrowser(qc: QueryClient, id: string, browser: RunBrowser) {
  try {
    await api.tests.setBrowser(id, browser);
  } catch {
    // Best-effort persist — the choice still applies to this run, and nothing
    // on disk changed, so there is nothing to re-read.
    return;
  }
  qc.invalidateQueries({ queryKey: ["tests"] });
  qc.invalidateQueries({ queryKey: ["test", id] });
}

/** What the pre-save check has said about the current draft. */
interface ScriptCheckState {
  status: "idle" | "checking" | "failed";
  errors: ScriptCheckError[];
}

const IDLE_CHECK: ScriptCheckState = { status: "idle", errors: [] };

/** The host of a URL for the live page's status, or the URL itself when it
 *  does not parse (a page the user typed into the browser). */
function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** The body of the divergence question: the first few statements the parser
 *  will not map, then what that costs. The script runs as written either
 *  way — what changes is that the Steps tab stops tracking those lines. */
function describeDiverge(newlySkipped: string[]): string {
  const shown = newlySkipped.slice(0, 3).map((t) => `“${t}”`);
  const more = newlySkipped.length - shown.length;
  const list = shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
  return `The parser can't map ${list} back to a step. The script still runs exactly as written; the Steps tab just won't show or track ${newlySkipped.length === 1 ? "that line" : "those lines"} until the test is retrained or its script regenerated.`;
}

export function TestDetailView() {
  const { id } = useParams({ from: "/test/$id" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { runs, run, stopRun, start, runEpoch } = useRecorder();
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState("");
  const [editingName, setEditingName] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState("");
  const [editingScript, setEditingScript] = React.useState(false);
  // The inline AI panel (⌘K rewrite / explain the failure), and the origin
  // the NEXT save carries once an AI rewrite has been applied into the
  // buffer — so the Heals tab files the change as the model's, not the
  // user's, even though the user pressed Save.
  const [aiPanel, setAiPanel] = React.useState<{ mode: ScriptAiMode; selection: ScriptAiSelection | null } | null>(null);
  const aiOriginRef = React.useRef<ScriptChangeSource | null>(null);
  // The outline (go to step, and the caret locator's usages across the library).
  const [outlineOpen, setOutlineOpen] = React.useState(false);
  const testsQuery = useQuery({ queryKey: ["tests"], queryFn: api.tests.list, enabled: outlineOpen });
  const [scriptDraft, setScriptDraft] = React.useState("");
  // The pre-save check's verdict on the draft. `checking` holds Save while the
  // Playwright CLI has the draft; `failed` keeps the editor open with the
  // problems listed and offers "Save anyway" — the file is the user's, and a
  // draft that does not load yet is still theirs to keep.
  const [scriptCheck, setScriptCheck] = React.useState<ScriptCheckState>(IDLE_CHECK);
  const scriptEditorRef = React.useRef<ScriptEditorHandle | null>(null);
  // The caret's line while editing, for the step readout in the bar.
  const [caretLine, setCaretLine] = React.useState<number | null>(null);
  // The script the draft STARTED from. Sent with every save so the backend
  // can refuse a draft built on text that something else has since replaced
  // (an AI fix landing unattended, a flow edit regenerating this caller, a
  // heal). `staleOpen` is that refusal, with Reload and Overwrite as the two
  // ways past it. `divergeConfirm` is the other question a save can raise —
  // statements the parser will not map back to steps — asked only for misses
  // the stored script did not already have.
  const [scriptBase, setScriptBase] = React.useState("");
  const [staleOpen, setStaleOpen] = React.useState(false);
  const [divergeConfirm, setDivergeConfirm] = React.useState<{
    newlySkipped: string[];
    overwrite: boolean;
  } | null>(null);
  // The dirty registry is what holds an unattended AI apply off a test whose
  // draft is open (ai-debug-store.tsx). Cleared when editing ends, and on
  // unmount, so a draft abandoned by navigating away does not pin the test.
  const scriptDirty = editingScript && scriptDraft !== scriptBase;
  React.useEffect(() => {
    markScriptDirty(id, scriptDirty);
    return () => markScriptDirty(id, false);
  }, [id, scriptDirty]);
  const [editingSteps, setEditingSteps] = React.useState(false);
  // Edited steps waiting on the "what about the script?" question. Only set for
  // a test whose script isn't generated from its steps; null the rest of the
  // time, which is also what closes the dialog.
  const [pendingSteps, setPendingSteps] = React.useState<Step[] | null>(null);
  // The run whose failure is being filed. Held here rather than in RunOutput
  // because the dialog needs the test id, which this view owns.
  const [failureRunId, setFailureRunId] = React.useState<string | null>(null);
  const [trainerConfirmOpen, setTrainerConfirmOpen] = React.useState(false);
  // Per-test visual-testing gate — remembers the user's "Capture screenshots"
  // choice between sessions. Falls back to the global Settings default when the
  // test has no saved preference yet.
  const [captureArtifacts, setCaptureArtifacts] = React.useState(false);
  // Per-test accessibility gate. Independent of screenshots: axe usually costs
  // more per step than the rest of the step does, so asking for pictures must
  // not silently buy an a11y audit as well.
  const [a11yChecks, setA11yChecks] = React.useState(false);
  // Per-test console+network recording. Independent of screenshots again: this
  // one persists page-controlled text and request URLs, which is a different
  // decision from persisting pictures.
  const [recordLogs, setRecordLogs] = React.useState(false);
  // Per-test "Handle pop-ups" gate. Unlike the three above it is ON by default:
  // the standing overlay rules were always armed before this box existed, and
  // a default of off would have silently switched every taught rule off. The
  // record stores it only when the user has decided; absent means inherit.
  const [handlePopups, setHandlePopups] = React.useState(true);
  // Per-test "Run headless" choice — remembers whether this test's runs open a
  // visible browser. Falls back to the global Settings default. Runs only; the
  // trainer/"Edit in Trainer" flow is always headed.
  const [runHeadless, setRunHeadless] = React.useState(false);
  // THIS RUN'S pace, not the test's (R18). Deliberately NOT persisted and
  // deliberately reset to "inherit" on every test: "run this one slowly while I
  // watch it" is a decision about one run, and a control that quietly rewrote
  // the test would leave the library changed behind it. Empty = whatever the
  // test itself pins, or the Settings default.
  const [runSpeed, setRunSpeed] = React.useState<TestSpeed | "">("");
  // Per-test browser engine — same fall-back chain as the toggles above.
  const [runBrowser, setRunBrowser] = React.useState<RunBrowser>("chromium");
  // Per-test Playwright timeout override, in seconds for the input. null means
  // "use the global Settings default" (no override stored on the record).
  const [testTimeoutSec, setTestTimeoutSec] = React.useState<number | null>(null);
  // The Base URL field's draft text. Held locally and persisted on blur rather
  // than on every keystroke: the backend refuses anything that isn't a full
  // http(s) address, and a URL being typed is invalid for most of its length —
  // persisting per character would mean an error toast per character.
  const [baseUrlDraft, setBaseUrlDraft] = React.useState("");
  // Which test the six controls above currently hold the settings OF.
  //
  // Not a boolean. This view is a route component, and the router does not
  // remount one when only its params change — clicking another test in the
  // sidebar re-renders THIS instance with a new id. A "have I initialised yet"
  // latch therefore fires once for the first test opened and never again, so
  // every test after it showed the previous test's engine, timeout and
  // toggles: the sidebar said Chromium while the picker said Firefox, and the
  // run used whatever the picker said.
  const [seededFor, setSeededFor] = React.useState<string | null>(null);

  // Ids of steps an applied AI-debug fix just ADDED, so the Steps tab can glow
  // them. Held here rather than on the step records because it is a fact about
  // this view's session, not about the test: reopening the test later should
  // show a settled list, not a stale "look what changed".
  //
  // Not on a timer, deliberately. Applying happens from the AI debug panel,
  // which is usually open over the Run tab — a timeout would expire before the
  // user ever switched to Steps to look. It clears when the list changes again
  // for some other reason (see the two callers of setNewStepIds below), or the
  // moment a run starts: from then on the run's verdict is the story, not the
  // glow (the runEpoch effect below).
  const [newStepIds, setNewStepIds] = React.useState<Set<string>>(() => new Set());
  React.useEffect(() => {
    if (runEpoch > 0) setNewStepIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, [runEpoch]);
  // Controlled so the active tab can be forced off "steps" when an apply
  // deletes the last step and the trigger disappears out from under it.
  const [tab, setTab] = React.useState<string | null>(null);

  const testQuery = useQuery({ queryKey: ["test", id], queryFn: () => api.tests.get(id) });
  const scriptQuery = useQuery({ queryKey: ["script", id], queryFn: () => api.tests.getScript(id) });
  // Badged on the Heals tab. Fetched here rather than inside the panel so the
  // count is visible without opening the tab — an unreviewed heal means the
  // test may already have been changed underneath the user.
  const healsQuery = useQuery({ queryKey: ["heals", id], queryFn: () => api.heals.list(id) });
  // Shopify crawler signatures. Read here so this screen can say, BEFORE the
  // Run button is pressed, that the run will go out unsigned — the run output
  // says so too, but a line in a log somebody scrolls past is not a disclosure,
  // and this is the screen they are looking at when they decide to run.
  const signaturesQuery = useQuery({ queryKey: ["shopify-signatures"], queryFn: () => api.shopify.list() });
  // The other half of that badge: whole-script changes. Fetched here for the
  // same reason, and it is what decides whether an IMPORTED test gets the tab
  // at all — see the trigger below.
  const scriptChangesQuery = useQuery({
    queryKey: ["script-changes", id],
    queryFn: () => api.scriptChanges.list(id),
  });
  // The badge's third route: fixes proposed for this test from its siblings.
  // Review lives in the Heals view; this screen only has to make the count
  // visible without opening the tab.
  const propagationsQuery = useQuery({
    queryKey: ["propagations", id],
    queryFn: () => api.propagation.list(id),
  });
  // Badged on the Accessibility tab, from the most recent run that actually
  // checked — same reasoning as the Heals count: an unaccepted violation the
  // user has to open a tab to discover is one they won't discover. Shares the
  // ["runs"] key with Stats and the panel itself, so this is usually free.
  const runsQuery = useQuery({ queryKey: ["runs"], queryFn: api.runs.list });
  const settingsQuery = useQuery({
    queryKey: ["recorder-settings"],
    queryFn: () => api.recorder.getSettings(),
  });
  const siteHealthOn = settingsQuery.data?.siteHealthChecks === true;
  // Ghost text is on while editing and an autocomplete slot is assigned
  // (Settings → AI → Autocomplete). Settings is another window, so this
  // cache cannot be invalidated from there; a short staleTime and the
  // focus refetch are what notice a slot assigned while the editor was open.
  const llmConfigQuery = useQuery({
    queryKey: ["llm", "config"],
    queryFn: () => api.llm.getConfig(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const ghostSource = React.useMemo(() => makeGhostSource((p) => api.llm.fim(p)), []);
  // The TypeScript service (Phase 4). Asked for once per view; "unavailable"
  // is a state the bar reports, never an error, and the editor keeps its
  // syntax and CLI diagnostics without it.
  const tsStatusQuery = useQuery({
    queryKey: ["ts", "status"],
    queryFn: () => api.ts.ensure(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const tsAvailable = Boolean(tsStatusQuery.data?.available);
  const intelligence = React.useMemo<TsIntelligence | null>(
    () =>
      tsAvailable
        ? {
            update: (text) => api.ts.update(id, text),
            diagnostics: () => api.ts.diagnostics(id),
            inspections: () => api.ts.inspections(id),
            completions: (offset) => api.ts.completions(id, offset),
            hover: (offset) => api.ts.hover(id, offset),
          }
        : null,
    [id, tsAvailable],
  );
  React.useEffect(() => {
    if (!tsAvailable) return;
    return () => {
      void api.ts.close(id).catch(() => {});
    };
  }, [id, tsAvailable]);
  const ghostEnabled = editingScript && Boolean(llmConfigQuery.data?.roles?.autocomplete);
  // Settings → Editor → Font size lands on the two tokens every editor
  // column is sized from (renderer/theme/editor.css). Written on the document
  // so the theme extension's `var()` reads pick it up without a remount.
  const editorFontSize = settingsQuery.data?.editorFontSize;
  React.useEffect(() => {
    const root = document.documentElement;
    if (typeof editorFontSize === "number") {
      root.style.setProperty("--gl-code-size", `${editorFontSize}px`);
      root.style.setProperty("--gl-code-line", `${editorLineHeight(editorFontSize)}px`);
    }
  }, [editorFontSize]);

  const test = testQuery.data;
  const scriptChanges = scriptChangesQuery.data ?? [];
  // Which tests call this one as a flow. Fetched for every test rather than
  // only flagged ones — a caller step can point at a test whose flag was later
  // turned off, and the delete guard below refuses on CALLERS, not the flag.
  const flowUsageQuery = useQuery({
    queryKey: ["flowUsage", id],
    queryFn: () => api.tests.flowUsage(id),
  });
  const flowUsedBy = flowUsageQuery.data ?? [];
  // The runFlow step being unwrapped, held while its confirm dialog is open.
  const [unwrappingStep, setUnwrappingStep] = React.useState<Step | null>(null);
  // What this test's runs will do about its store's crawler signature — and it
  // only ever reports the cases where the answer is "nothing". A chip saying a
  // working signature is working would be noise on every run of every test
  // against a registered store; the two that need saying are the ones where the
  // user thinks they are covered and are not.
  //
  // Since 2026-08-24 the LIVE PAGE reads the same store, so the first two cases
  // stop it at the wall exactly as they stop a run — the wording says so, and
  // this chip sits on the toolbar the live page is opened from. The imported
  // case does NOT: the live page is a browser the editor drives, not a spec the
  // app rewrote, so the fixture's reach is not its limit.
  const signatureWarning = ((): { text: string; title: string } | null => {
    if (!test) return null;
    const host = normalizeSignatureHost(test.sourceDir ? (test.baseUrl ?? "") : (test.url ?? ""));
    if (!host) return null;
    const entry = (signaturesQuery.data ?? []).find((s) => s.host === host);
    if (!entry) return null;
    if (entry.state === "expired") {
      return {
        text: "Signature expired",
        title: `The Shopify crawler signature for ${host} has expired, so runs of this test — and its live page — go out unsigned. An expired signature fails verification, which is worse than sending none — create a new one in your Shopify admin.`,
      };
    }
    if (entry.state === "unreadable") {
      return {
        text: "Signature unreadable",
        title: `A Shopify crawler signature is registered for ${host} but can't be decrypted on this Mac, so runs of this test — and its live page — go out unsigned.`,
      };
    }
    if (test.sourceDir) {
      // The gap the fixture cannot close, said on the screen where the run is
      // started rather than discovered in the output afterwards.
      return {
        text: "Signature not sent",
        title: `The Shopify crawler signature for ${host} is not sent for imported tests — it travels on the same fixture as screenshots and Auto-Heal, which needs the spec to import @playwright/test directly.`,
      };
    }
    return null;
  })();
  // One badge for all three stores. They are three routes to the same hazard —
  // the stored test changed (or is about to change) and nobody has looked —
  // and three numbers on one tab would be asking the user to add them up.
  const pendingHeals =
    (healsQuery.data ?? []).filter((h) => h.status === "pending").length +
    scriptChanges.filter((c) => c.status === "pending").length +
    (propagationsQuery.data ?? []).filter((p) => p.status === "pending").length;
  const a11yNewSteps = latestA11yRun(runsQuery.data ?? [], id)?.a11yNewSteps ?? 0;
  const runInfo = runs[id];

  // Real medians, per step and for the test itself (C §6.3). One query for
  // both — they are one screen asking one question, and two channels would let
  // the step list and the run summary answer it from two different reads of a
  // database that is being written to while they look.
  //
  // `available: false` is not an error and is not treated as one: the metrics
  // DB is a derived shadow that degrades to "no metrics" by design, and every
  // consumer of it here falls back to a `Temp` that renders neutral.
  const metricsQuery = useQuery({
    queryKey: ["metrics", "slowness", id],
    queryFn: () => api.metrics.slowness(id),
  });
  const stepTrends = React.useMemo(() => {
    const map = new Map<string, { recentP50Ms: number | null; previousP50Ms: number | null }>();
    for (const row of metricsQuery.data?.rows ?? []) {
      map.set(row.stepId, {
        recentP50Ms: row.recentP50Ms,
        previousP50Ms: row.previousP50Ms,
      });
    }
    return map;
  }, [metricsQuery.data]);

  // The run panel's clock, and ONLY while a run is in flight (§6.1's `running`
  // panel reports elapsed time). It would usually be carried for free by the
  // log streaming in, but a run that is waiting — on a slow navigation, on a
  // locator that will eventually time out — streams nothing, and those are
  // exactly the runs somebody is watching the clock on.
  const [nowTick, setNowTick] = React.useState(() => Date.now());
  const running = runInfo?.running ?? false;
  React.useEffect(() => {
    if (!running) return;
    setNowTick(Date.now());
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Which of the six states this test's run panel is in. Computed here rather
  // than inside the panel because both of its inputs are queries this view
  // already holds for other reasons — the a11y badge needs `runs`, the Heals
  // tab badge needs `heals` — so the summary costs nothing extra.
  const runSummary = React.useMemo(
    () =>
      summariseRun({
        testId: id,
        runs: runsQuery.data ?? [],
        heals: healsQuery.data ?? [],
        stepCount: testQuery.data?.steps.length ?? 0,
        live: runInfo ?? null,
        now: nowTick,
        // The REAL median, when the metrics DB can supply one — see §6.3 and
        // `summariseRun`'s note on why it is preferred over the one derived
        // from run history here.
        medianMs: metricsQuery.data?.testTrend?.recentP50Ms ?? null,
      }),
    [
      id,
      runsQuery.data,
      healsQuery.data,
      testQuery.data?.steps.length,
      runInfo,
      nowTick,
      metricsQuery.data,
    ],
  );

  // Seed the run controls from the record, falling back to the global defaults.
  // Once per TEST rather than once per mount (see `seededFor`), and never again
  // for the same test — a refetch after the user changes one must not undo it.
  React.useEffect(() => {
    // Waiting on the settings query matters for a test that has pinned
    // nothing: seeding before the defaults arrive latches the hard-coded
    // fall-backs, and which query wins that race is a coin flip per mount.
    if (!test || settingsQuery.isPending || seededFor === test.id) return;
    const defaults = settingsQuery.data;
    setCaptureArtifacts(test.captureArtifacts ?? defaults?.defaultCaptureArtifacts ?? false);
    setA11yChecks(test.a11yChecks ?? defaults?.defaultA11yChecks ?? false);
    setRecordLogs(test.recordLogs ?? defaults?.defaultRecordLogs ?? false);
    setHandlePopups(test.handlePopups ?? defaults?.defaultHandlePopups ?? true);
    setRunHeadless(test.runHeadless ?? defaults?.defaultRunHeadless ?? false);
    setRunBrowser(test.runBrowser ?? defaults?.defaultRunBrowser ?? "chromium");
    // Timeout is the exception: only a stored per-test value seeds it. An
    // absent field leaves the input empty so the placeholder can show the
    // global default rather than hard-coding it into an override.
    setTestTimeoutSec(
      typeof test.testTimeoutMs === "number" ? Math.round(test.testTimeoutMs / 1000) : null,
    );
    setBaseUrlDraft(test.baseUrl ?? "");
    setSeededFor(test.id);
  }, [seededFor, test, settingsQuery.data, settingsQuery.isPending]);
  // Earliest step the run reported as failed, if any — lets the AI debug
  // prompt skip steps after it, since Playwright never ran them.
  const failedStepIndex = React.useMemo(() => {
    if (!runInfo) return undefined;
    const failed = Object.entries(runInfo.stepStatus)
      .filter(([, status]) => status === "failed")
      .map(([index]) => Number(index));
    return failed.length > 0 ? Math.min(...failed) : undefined;
  }, [runInfo]);

  // ── AI debug session ─────────────────────────────────────────────
  // The session lives in the global store, so it survives leaving this view.
  // This view's job is to (a) supply the prompt context, and (b) re-supply it
  // when a session restored from disk is reopened here.
  const aiDebug = useAiDebug();
  const aiKey = runSessionKey(id);
  const script = scriptQuery.data ?? "";
  // The text the editor shows: the draft while editing, the file otherwise.
  const shownScript = editingScript ? scriptDraft : script;
  // What the parser makes of the shown text — the coverage gutter and the
  // step readout draw from it. Keyed by the text itself so a draft is
  // re-parsed as it changes (debounced below), and the saved script once.
  const [previewText, setPreviewText] = React.useState(shownScript);
  React.useEffect(() => {
    if (!editingScript) {
      setPreviewText(script);
      return;
    }
    const t = setTimeout(() => setPreviewText(scriptDraft), 500);
    return () => clearTimeout(t);
  }, [editingScript, script, scriptDraft]);
  const previewQuery = useQuery({
    queryKey: ["script-preview", id, previewText],
    queryFn: () => api.tests.previewScript(id, previewText),
    enabled: previewText.length > 0,
    staleTime: Infinity,
  });
  const preview = previewQuery.data ?? null;
  // Run status by LINE for the editor's gutter: the line each step index
  // last ran from when the run reported one, else the line the parser reads
  // that step from in the saved script. Only while the shown text is the
  // saved script — a draft's lines have moved.
  const runLineStatus = React.useMemo<Record<number, RunLineStatus>>(() => {
    const out: Record<number, RunLineStatus> = {};
    if (!runInfo || editingScript) return out;
    const lineOfOffset = (offset: number): number => script.slice(0, offset).split("\n").length;
    for (const [k, status] of Object.entries(runInfo.stepStatus)) {
      const index = Number(k);
      const reported = runInfo.stepLines?.[index];
      const range = preview && preview.tracked !== undefined ? preview.stepRanges[index] : undefined;
      const line = reported ?? (range ? lineOfOffset(range.from) : undefined);
      if (line) out[line] = status;
    }
    return out;
  }, [runInfo, editingScript, preview, script]);
  // The step the caret is on, for the readout: the index whose range holds
  // the caret's line, described the way the Steps tab describes it.
  const caretStep = React.useMemo(() => {
    if (caretLine === null || !preview || !test) return null;
    const lineOfOffset = (offset: number): number => shownScript.slice(0, offset).split("\n").length;
    const index = preview.stepRanges.findIndex((r) => {
      const first = lineOfOffset(r.from);
      const last = lineOfOffset(Math.max(r.from, r.to - 1));
      return caretLine >= first && caretLine <= last;
    });
    if (index < 0) return null;
    const step = test.steps[index];
    return { index, label: step ? describeStep(step) : `step ${index + 1}` };
  }, [caretLine, preview, test, shownScript]);

  // ── The live page ──────────────────────────────────────────────────────
  //
  // A Playwright browser the editor owns (main/services/live-page-service.ts).
  // Status is a query the backend's push keeps current; counts are asked per
  // parsed step's locator whenever the page or the parse changes, and drawn
  // as inlays at the end of each statement; the caret's step is outlined in
  // the page as it moves.
  const livePageQuery = useQuery({ queryKey: ["live-page"], queryFn: () => api.livePage.status() });
  const livePage: LivePageStatus = livePageQuery.data ?? { open: false };
  React.useEffect(
    () =>
      api.on<LivePageStatus>("livePage:changed", (next) => {
        qc.setQueryData(["live-page"], next ?? { open: false });
      }),
    [qc],
  );
  const [liveBusy, setLiveBusy] = React.useState(false);
  const [liveCounts, setLiveCounts] = React.useState<Record<number, LivePageCount>>({});
  const liveUrl = React.useMemo(() => {
    if (!test) return "";
    // `${var}` references in the address resolve to the plain variables'
    // values; anything else stays as written and the browser says so.
    return test.url.replace(/\$\{([A-Za-z_][\w]*)\}/g, (m, name: string) => {
      const v = (test.variables ?? []).find((x) => x.name === name);
      return v && typeof v.value === "string" ? v.value : m;
    });
  }, [test]);
  const toggleLivePage = async () => {
    setLiveBusy(true);
    try {
      // The answer is written into the query here as well as arriving on the
      // push: the window that asked must not wait on a broadcast to see it.
      if (livePage.open) {
        await api.livePage.close();
        qc.setQueryData(["live-page"], { open: false });
      } else if (liveUrl) {
        const next = await api.livePage.open(
          liveUrl,
          test?.runBrowser ?? settingsQuery.data?.defaultRunBrowser,
          // The test's id, so the page can answer its basic-auth wall and sign
          // for its store. Without it the live page opens credential-blind and
          // a protected storefront serves it the password page.
          test?.id,
        );
        qc.setQueryData(["live-page"], next);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLiveBusy(false);
    }
  };
  const stepList = preview?.stepList;
  React.useEffect(() => {
    if (!livePage.open || !stepList) {
      setLiveCounts({});
      return;
    }
    let cancelled = false;
    const indexed = stepList.map((s, i) => ({ i, locator: s.locator })).filter((x) => x.locator);
    if (indexed.length === 0) {
      setLiveCounts({});
      return;
    }
    void api.livePage
      .countMany(indexed.map((x) => x.locator!))
      .then((counts) => {
        if (cancelled) return;
        const next: Record<number, LivePageCount> = {};
        indexed.forEach((x, k) => {
          next[x.i] = counts[k] ?? { count: null };
        });
        setLiveCounts(next);
      })
      .catch(() => {
        if (!cancelled) setLiveCounts({});
      });
    return () => {
      cancelled = true;
    };
  }, [livePage.open, livePage.url, stepList]);
  const liveInlays = React.useMemo<LineInlay[]>(() => {
    if (!livePage.open || !preview) return [];
    const out: LineInlay[] = [];
    for (const [k, c] of Object.entries(liveCounts)) {
      const range = preview.stepRanges[Number(k)];
      if (!range) continue;
      const line = shownScript.slice(0, Math.max(range.from, range.to - 1)).split("\n").length;
      if (c.count === null) out.push({ line, text: "no count", tone: "muted", title: c.error ?? "Could not count this locator on the live page" });
      else if (c.count === 1) out.push({ line, text: "1 match", tone: "ok", title: "Matches one element on the live page" });
      else if (c.count === 0) out.push({ line, text: "no match", tone: "bad", title: "Matches nothing on the live page — this step would fail" });
      else out.push({ line, text: `${c.count} matches`, tone: "warn", title: `Matches ${c.count} elements on the live page — Playwright refuses an ambiguous action` });
    }
    return out;
  }, [livePage.open, preview, liveCounts, shownScript]);
  // Caret → outline in the live page, a beat after the caret settles.
  const caretLocator = caretStep && stepList ? (stepList[caretStep.index]?.locator ?? null) : null;
  React.useEffect(() => {
    if (!livePage.open) return;
    const t = setTimeout(() => void api.livePage.highlight(caretLocator).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [livePage.open, caretLocator]);
  const pickLocator = async () => {
    try {
      const picked = await api.livePage.pick();
      if (!picked) return;
      // The app's spelling when the parser read the pick (it round-trips);
      // Playwright's own otherwise, which the coverage gutter will flag.
      const text = "page." + (picked.locator ? locatorExpr(picked.locator) : picked.expr);
      scriptEditorRef.current?.insertAtCaret(text);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };
  // "Record here": a trainer session for this test with the insert cursor
  // just past the caret's step, so what gets recorded lands where the caret
  // was. The cursor is applied once the session exists.
  const pendingCursorRef = React.useRef<number | null>(null);
  const startTrainer = async () => {
    if (!test) return;
    await start(test.url, test.name, test.id);
    const cursor = pendingCursorRef.current;
    pendingCursorRef.current = null;
    if (cursor !== null) {
      try {
        await api.recorder.setCursor(cursor);
      } catch {
        // The session is live either way; the cursor simply stays at the end.
      }
    }
  };
  const openAi = (mode: ScriptAiMode) => {
    const view = scriptEditorRef.current?.view();
    const sel = view?.state.selection.main;
    const selection: ScriptAiSelection | null =
      mode === "rewrite" && view && sel && !sel.empty
        ? { from: sel.from, to: sel.to, text: view.state.doc.sliceString(sel.from, sel.to) }
        : null;
    setAiPanel({ mode, selection });
  };
  const applyAi = (next: string, meta: ScriptAiApplyMeta) => {
    setScriptDraft(next);
    markScriptDirty(id, true);
    aiOriginRef.current = {
      by: "ai-inline",
      affordance: meta.affordance,
      provider: meta.provider,
      model: meta.model,
      promptVersion: meta.promptVersion,
      reviewed: true,
    };
    setAiPanel(null);
    scriptEditorRef.current?.focusLine(1);
  };
  const recordHere = () => {
    if (!test) return;
    pendingCursorRef.current = caretStep ? caretStep.index + 1 : test.steps.length;
    if (test.scriptEdited) setTrainerConfirmOpen(true);
    else void startTrainer();
  };
  const runOutput = runInfo?.lines.join("") ?? "";
  const recordId = runInfo?.recordId;
  // Identifies the execution being debugged, STABLY for its whole life. Hashing
  // the output instead would change on every streamed line, so a session opened
  // mid-run would look like it belonged to a different run one chunk later.
  const runKey = runInfo ? (recordId ?? `t${runInfo.startedAt}`) : null;
  const keepRunningJobs = settingsQuery.data?.keepRunningAiDebugJobs ?? false;
  // Scoped to THIS run: a session from a previous run of the same test must not
  // colour the icon, or it promises an answer about output that is gone.
  const aiStatus = useAiDebugStatus(aiKey, runKey);

  // A session belongs to ONE run. When the run changes, drop it outright rather
  // than waiting for the panel to be reopened: leaving it in the store meant it
  // was still reachable — and still showing the previous run's answer — from
  // the global chip, which restores a session without going through
  // openSession's reset. Discarding also cancels any request still answering
  // about output that is no longer on screen.
  React.useEffect(() => {
    if (!runKey) return;
    const existing = aiDebug.sessions.find((s) => s.key === aiKey);
    // Only on a DEFINITE mismatch. A session restored from disk before run
    // identities existed has none, and treating unknown as "different" would
    // delete every restored diagnosis the moment its test was opened.
    if (!existing || existing.runKey == null || existing.runKey === runKey) return;
    // Already kept by an explicit opt-in. It must survive FINISHING, too —
    // discarding it the moment its answer arrived would defeat the entire
    // point of preserving it. It now lives until the user discards it.
    if (existing.superseded) return;

    // EXPERIMENTAL opt-in: a job that is still STREAMING survives the re-run
    // rather than being thrown away mid-answer. It stops colouring this run's
    // icon either way (useAiDebugStatus is run-scoped) and is reachable only
    // from the global chip, marked as belonging to the previous run.
    //
    // A FINISHED session is discarded regardless of the setting: the thing
    // worth protecting is work in progress, not a stale answer — and keeping
    // stale answers around is the exact complaint this whole path exists to
    // fix.
    if (existing.status === "streaming" && keepRunningJobs) {
      aiDebug.markSuperseded(aiKey);
      return;
    }
    aiDebug.discard(aiKey);
  }, [aiDebug, aiKey, runKey, keepRunningJobs]);

  // Whether the finished run recorded console/network. Asked once per run
  // rather than assumed from the toggle: the toggle can be flipped after a run,
  // and what matters is what THIS run actually wrote.
  const logsQuery = useQuery({
    queryKey: ["run-logs-available", id, recordId],
    queryFn: () => (recordId ? api.artifacts.hasLogs(id, recordId) : Promise.resolve({ hasLogs: false })),
    enabled: Boolean(recordId),
  });

  // Whether the run left any Auto-Heal failure behind — the source of the page
  // structure the model can ask for. Asked per run for the same reason as the
  // logs above: the Auto-Heal setting can be flipped after a run, and what
  // matters is what THIS run wrote.
  const structureQuery = useQuery({
    queryKey: ["run-structure-available", id, recordId],
    queryFn: () =>
      recordId ? api.artifacts.hasStructure(id, recordId) : Promise.resolve({ hasStructure: false }),
    enabled: Boolean(recordId),
  });

  // Write an edited step list back. `regenerate` is what the save-time question
  // resolves to; it's ignored for a test whose script is generated from steps
  // anyway, and refused backend-side for an imported one.
  // Declare a variable from inside the Edit Steps editor. Two writes because a
  // secret's value never travels on the record: the declaration goes through
  // `setVariables` like any other, and the plaintext takes the one-way trip to
  // the encrypted store. Ordered declaration-first so a failed secret write
  // leaves a declared-but-empty variable — visible on the Variables tab and
  // fixable there — rather than a stored value nothing references.
  const createVariable = React.useCallback(
    async (v: { name: string; kind: VariableKind; value: string }) => {
      // Re-read rather than appending to the rendered record. `setVariables`
      // replaces the whole list, so the base has to be the CURRENT one — and
      // the rendered copy is only as fresh as the last refetch. Two creates in
      // a row (declare the email, then the password) would otherwise write the
      // second on top of a list that predates the first, silently deleting it.
      const current = await api.tests.get(id);
      const next: TestVariable[] = [
        ...(current?.variables ?? []),
        { name: v.name, kind: v.kind, ...(v.kind === "secret" ? {} : { value: v.value }) },
      ];
      await api.tests.setVariables(id, next);
      if (v.kind === "secret" && v.value) await api.tests.setSecret(id, v.name, v.value);
      qc.invalidateQueries({ queryKey: ["test", id] });
      qc.invalidateQueries({ queryKey: ["script", id] });
      qc.invalidateQueries({ queryKey: ["secretStatus", id] });
    },
    [id, qc],
  );

  const commitSteps = React.useCallback(
    async (steps: Step[], regenerate: boolean) => {
      await api.tests.updateSteps(id, steps, { regenerate });
      // The user has now edited the list themselves, so "these are the steps
      // the AI added" is no longer a claim this view can make about it — the
      // indexes and ids it was tracking may not even exist any more.
      setNewStepIds(new Set());
      qc.invalidateQueries({ queryKey: ["test", id] });
      qc.invalidateQueries({ queryKey: ["script", id] });
      qc.invalidateQueries({ queryKey: ["tests"] });
      setPendingSteps(null);
      setEditingSteps(false);
    },
    [id, qc],
  );

  const applyScript = React.useCallback(
    async (source: string, origin?: ScriptChangeSource) => {
      // Snapshot the steps BEFORE the write. Applying a fix goes through
      // `tests:updateScript`, which re-parses the whole spec and replaces the
      // step list wholesale — so this is the only moment the previous list
      // still exists anywhere.
      const before = qc.getQueryData<TestRecord | null>(["test", id])?.steps ?? [];
      // An AI fix lands under the same two rules a hand edit does: never over a
      // draft the user has open, and never over a file that moved on since the
      // fix was diffed — the base is the script the panel diffed against.
      if (isScriptDirty(id)) {
        throw new Error("The Script tab has an unsaved draft of this test — save or discard it before applying a fix.");
      }
      const base = qc.getQueryData<string>(["script", id]);
      const updated = await api.tests.updateScript(id, source, origin, base);
      // Diff off the handler's return value rather than a refetch: the refetch
      // is async and the highlight would race it, and the record it returns is
      // the same one the invalidation is about to put in the cache anyway.
      setNewStepIds(computeNewStepIds(before, updated?.steps ?? []));
      qc.invalidateQueries({ queryKey: ["script", id] });
      qc.invalidateQueries({ queryKey: ["test", id] });
      // The Heals tab now has a new entry, and its badge counts them.
      qc.invalidateQueries({ queryKey: ["script-changes", id] });
    },
    [id, qc],
  );

  const runContext = React.useMemo<AiDebugRunContext | null>(() => {
    if (!test) return null;
    return {
      kind: "run",
      testName: test.name,
      testUrl: test.url,
      script,
      output: runOutput,
      imported: Boolean(test.sourceDir),
      speed: test.speed,
      failedStepIndex,
      recordId,
      logsAvailable: Boolean(logsQuery.data?.hasLogs),
      structureAvailable: Boolean(structureQuery.data?.hasStructure),
      onApplyScript: applyScript,
    };
  }, [
    test,
    script,
    runOutput,
    failedStepIndex,
    applyScript,
    recordId,
    logsQuery.data?.hasLogs,
    structureQuery.data?.hasStructure,
  ]);

  // Keep a live session's context fresh (the script or run output can change
  // under it) and re-ground one restored from disk, which has no context at all
  // until the view that owns it renders again.
  // Deliberately NOT gated on aiStatus: that is now scoped to the current run,
  // and a session from a previous run still needs the live script attached so
  // its diff is computed against what applying would actually overwrite.
  // "Which icon colour" and "does this session need context" are different
  // questions and must not share a condition.
  const hasSession = aiDebug.sessions.some((s) => s.key === aiKey);
  React.useEffect(() => {
    if (!runContext || !hasSession) return;
    aiDebug.attachContext(aiKey, runContext);
  }, [aiDebug, aiKey, runContext, hasSession]);

  const openAiDebug = React.useCallback(() => {
    if (!test || !runContext) return;
    aiDebug.openSession({
      key: aiKey,
      kind: "run",
      testId: id,
      label: test.name,
      testName: test.name,
      runKey,
      context: runContext,
    });
  }, [aiDebug, aiKey, id, test, runContext, runKey]);

  // An Insights recommendation asked for this test's AI debug session. It is
  // consumed only once the run context exists, so the dialog opens through the
  // exact same path as the Output panel's button — context assembly, Sending
  // strip and the manual send included. One-shot: a later manual visit to the
  // same test cannot replay the click.
  React.useEffect(() => {
    if (!test || !runContext) return;
    if (consumeAiDebugRequest(id)) openAiDebug();
  }, [test, runContext, id, openAiDebug]);

  const saveName = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === test?.name) return;
    await api.tests.rename(id, trimmed);
    qc.invalidateQueries({ queryKey: ["tests"] });
    qc.invalidateQueries({ queryKey: ["test", id] });
    qc.invalidateQueries({ queryKey: ["script", id] });
  };

  /** Silence the divergence banner. Optimistic on purpose: this is a "yes, I
   *  know" click, and a banner that lingers until a round trip reads as a
   *  control that didn't work. The invalidate below reconciles. */
  const dismissDiverged = () => {
    qc.setQueryData(["test", id], (prev: TestRecord | null | undefined) =>
      prev ? { ...prev, stepsDivergedDismissed: true } : prev,
    );
    api.tests
      .dismissDiverged(id)
      // Take the saved record rather than invalidating: a refetch would land a
      // moment later and is indistinguishable from the optimistic value, right
      // up until the write failed — in which case the banner would reappear
      // with no explanation. The catch below is the only path that restores it.
      .then((rec) => {
        if (rec) qc.setQueryData(["test", id], rec);
      })
      .catch(() => {
        // Put it back rather than leaving the user believing it was recorded.
        qc.invalidateQueries({ queryKey: ["test", id] });
        toast.error("Couldn't dismiss the warning.");
      });
  };

  /** Write the draft over the script. No load check here — the callers
   *  decide whether that has to be true first — but two questions of its own:
   *  will the parser lose statements it could map before (asked once, over
   *  the new misses only), and is the draft still built on the file as it is
   *  (refused by the backend; answered with Reload or Overwrite). */
  const writeScriptDraft = async (opts: { overwrite?: boolean; confirmedDiverge?: boolean } = {}, text: string = scriptDraft) => {
    if (!opts.confirmedDiverge) {
      try {
        const preview = await api.tests.previewScript(id, text);
        if (preview.tracked && preview.newlySkipped.length > 0) {
          setDivergeConfirm({ newlySkipped: preview.newlySkipped, overwrite: Boolean(opts.overwrite) });
          return;
        }
      } catch {
        // A preview that could not run must not stand between the user and
        // their save; the divergence banner still reports it afterwards.
      }
    }
    try {
      // No origin: a hand edit the user is looking at as they save it. The
      // backend defaults to exactly that, but saying it here is what keeps the
      // Heals tab's labels honest if the default ever changes.
      await api.tests.updateScript(
        id,
        text,
        aiOriginRef.current ?? { by: "manual", reviewed: true },
        opts.overwrite ? undefined : scriptBase,
      );
      aiOriginRef.current = null;
    } catch (err) {
      if (isScriptChangedOnDisk(err)) {
        setStaleOpen(true);
        return;
      }
      toast.error(err instanceof Error ? err.message : String(err));
      return;
    }
    qc.invalidateQueries({ queryKey: ["script", id] });
    qc.invalidateQueries({ queryKey: ["test", id] });
    qc.invalidateQueries({ queryKey: ["script-changes", id] });
    setEditingScript(false);
    setScriptCheck(IDLE_CHECK);
  };

  /** The way back from a stale draft that keeps the file's side: fetch the
   *  script as it is now and start the draft over from it. */
  const reloadScript = async () => {
    setStaleOpen(false);
    let fresh = "";
    try {
      fresh = await api.tests.getScript(id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return;
    }
    qc.setQueryData(["script", id], fresh);
    setScriptDraft(fresh);
    setScriptBase(fresh);
    setScriptCheck(IDLE_CHECK);
  };

  /** Save = check, then write. The check hands the draft to the real
   *  Playwright CLI (`tests:checkScript`, see script-check.ts): a draft it
   *  cannot load stays in the editor with its problems listed against the
   *  lines. A check that could not RUN is reported the same way — it is not a
   *  pass — and "Save anyway" is the way past either. */
  const saveScript = async () => {
    // Settings → Editor → "Format on save": TypeScript's formatter over the
    // draft, through the service, before the check and the write. The
    // formatted text becomes the draft, so what was checked is what is saved
    // and what the editor shows afterwards. Unavailable service: no format.
    let draft = scriptDraft;
    if (settingsQuery.data?.editorFormatOnSave !== false && tsAvailable) {
      try {
        await api.ts.update(id, draft);
        const formatted = applyTextEdits(draft, await api.ts.format(id));
        if (formatted !== draft) {
          draft = formatted;
          setScriptDraft(formatted);
        }
      } catch {
        // A formatter that did not answer is not a reason to refuse a save.
      }
    }
    // Settings → Editor → "Check with Playwright before saving". Off, the
    // save still refuses a stale draft and still asks about statements the
    // parser would lose; it stops asking the CLI whether the file loads.
    if (settingsQuery.data?.editorCheckOnSave === false) {
      await writeScriptDraft({}, draft);
      return;
    }
    setScriptCheck({ status: "checking", errors: [] });
    let result: ScriptCheckResult;
    try {
      result = await api.tests.checkScript(id, draft);
    } catch (err) {
      setScriptCheck({
        status: "failed",
        errors: [
          {
            message:
              "Couldn't check the script: " + (err instanceof Error ? err.message : String(err)),
          },
        ],
      });
      return;
    }
    if (!result.ok) {
      setScriptCheck({ status: "failed", errors: result.errors });
      return;
    }
    await writeScriptDraft({}, draft);
  };

  /** Put the caret at the start of a reported line and bring it into view. */
  const jumpToScriptLine = (line: number) => {
    scriptEditorRef.current?.focusLine(line);
  };

  if (!test) {
    return (
      <div className="flex h-full flex-col">
        <Toolbar>
          <ToolbarContent>
            <ToolbarTitle> </ToolbarTitle>
          </ToolbarContent>
        </Toolbar>
      </div>
    );
  }

  // Save any in-progress script edits, then open the trainer so the manually
  // edited script is preserved on disk before the trainer can regenerate it.
  const saveAndEditInTrainer = async () => {
    if (editingScript) {
      // Unchecked on purpose: this path exists so the edit is not LOST to the
      // regeneration that follows, and a draft the CLI rejects is still the
      // edit the user made. The divergence question is moot here too — the
      // trainer regenerates the steps it is about to edit. A stale draft
      // still stops: the dialog it opens is the answer, and the trainer is
      // not started over a refusal.
      await writeScriptDraft({ confirmedDiverge: true });
      if (scriptDraft !== scriptBase && editingScript) {
        // writeScriptDraft returned without closing the editor — it refused.
        setTrainerConfirmOpen(false);
        return;
      }
    }
    void startTrainer();
    // The composed `Dialog` never closes itself on a resolved confirm — callers
    // close themselves (see `dialog-actions.test.tsx`). Test detail is inside
    // the outlet, so the swap to RecordingView unmounts this dialog and hides
    // the omission; closing explicitly keeps it correct if that ever changes,
    // and keeps this dialog honest with its two siblings.
    setTrainerConfirmOpen(false);
  };

  return (
    <div className="gl-detail flex h-full flex-col">
      {/* `Toolbar` is kept — it owns the drag region and the `no-drag` islands
          inside it, which are window behaviour rather than styling, and
          `check:clickable-chrome` is about exactly that. What changes is what is
          drawn in it. */}
      <Toolbar className="gl-detail-head">
        {/* ONE ROW: the test's identity on the left, every control on the right.
            `ToolbarRow` rather than letting `Toolbar`'s own column stack them,
            because a stacked head spent 94px on two lines that each half-filled
            their own — the name ran out at a third of the width and the controls
            sat under an empty gutter. The row wraps (`.gl-detail-head-row`), so
            a window too narrow to hold both drops the controls to their own line
            and lands back on exactly the layout this replaced. */}
        <ToolbarRow className="gl-detail-head-row">
          <ToolbarContent className="gl-detail-ident">
            {editingName ? (
              <Input
                size="small"
                variant="filled"
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                className="h-6 pl-1.5 -ml-1.5 text-[15px] font-medium"
                onBlur={() => {
                  setEditingName(false);
                  saveName(nameDraft);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setEditingName(false);
                    saveName(nameDraft);
                  } else if (e.key === "Escape") {
                    setEditingName(false);
                  }
                }}
              />
            ) : (
              <ToolbarTitle
                className="cursor-text no-drag inline-flex items-center gap-1.5"
                onClick={() => {
                  setNameDraft(test.name);
                  setEditingName(true);
                }}
              >
                {test.name}
                <Pencil className="size-3.5 text-tertiary" />
              </ToolbarTitle>
            )}
            {/* Same neutral chip vocabulary the step rows use: being a flow is
                a fact about what this test IS, not an outcome, so no hue. */}
            {test.isFlow ? (
              <span
                className="gl-chip"
                title="Reusable flow — other tests inline these steps with a “Run a flow” step"
              >
                flow
              </span>
            ) : null}
            <ToolbarDescription>{test.url}</ToolbarDescription>
          </ToolbarContent>
          <ToolbarActions className="gl-detail-tools">
            {/* WHAT THE TEST IS — the two ways to change it. The delete lives here
                rather than beside `Run test` on purpose: destructive and primary
                actions at opposite ends of the same cluster is how a mis-click
                happens. */}
            <div className="gl-detail-tool-group">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  {/* `Btn` rather than the SDK `Button`, but still inside Radix's
                      `DropdownMenu`: that one is native-menu-backed here, and the
                      trigger is the only part of it that is real DOM. */}
                  <Btn>
                    Edit Test
                    <ChevronDown className="size-3.5" />
                  </Btn>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end">
                  <DropdownMenuItem onSelect={() => {
                    if (test.scriptEdited) setTrainerConfirmOpen(true);
                    else void startTrainer();
                  }}>
                    Edit in Trainer
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setEditingSteps(true)}>
                    Edit Steps
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {test.scriptEdited ? (
                <Dialog
                  open={trainerConfirmOpen}
                  onOpenChange={setTrainerConfirmOpen}
                  title="Edit in Trainer"
                  description="This test has manual script edits. Opening the trainer will regenerate the script from the recorded steps when you stop, overwriting those edits."
                  confirmLabel="Save & continue"
                  confirmVariant="accent"
                  onConfirm={saveAndEditInTrainer}
                  destructiveAction={{
                    label: "Continue without saving",
                    onClick: () => {
                      void startTrainer();
                      setTrainerConfirmOpen(false);
                    },
                  }}
                />
              ) : null}
              <AlertDialog
                trigger={
                  <button type="button" className="gl-icon-btn" aria-label="Delete test">
                    <Trash2 className="size-4" />
                  </button>
                }
                title="Delete this test?"
                description={
                  flowUsedBy.length > 0
                    ? `This test is used as a flow by ${flowUsedBy
                        .map((c) => `“${c.name}”`)
                        .join(", ")}. Remove or unwrap those flow calls first — deleting is blocked while anything still calls it.`
                    : "This removes the recording and its generated script. This can't be undone."
                }
                confirmLabel="Delete"
                confirmVariant="destructive"
                onConfirm={async () => {
                  try {
                    await api.tests.remove(id);
                  } catch (err) {
                    // The backend refuses to delete a flow other tests still
                    // call — surface its sentence rather than navigating away
                    // from a test that is still there.
                    toast.error(err instanceof Error ? err.message : String(err));
                    return;
                  }
                  qc.invalidateQueries({ queryKey: ["tests"] });
                  navigate({ to: "/" });
                }}
              />
            </div>
            <span className="gl-detail-tool-rule" aria-hidden="true" />
            {/* HOW IT RUNS — engine, budget, and (imported tests only) what a
                relative navigation resolves against. */}
            <div className="gl-detail-tool-group">
              <Select
                value={runBrowser}
                onValueChange={(v) => {
                  const next = v as RunBrowser;
                  setRunBrowser(next);
                  void persistRunBrowser(qc, id, next);
                }}
                disabled={runInfo?.running}
              >
                {/* `.gl-input` on a Select trigger: it is a control that reports a
                    value and opens a NATIVE menu, so its box should read as a field
                    rather than as a button. The menu itself is drawn by AppKit and
                    never enters the DOM — nothing here can style it, which is also
                    why the engine choice is asserted at the IPC layer. */}
                <SelectTrigger
                  variant="filled"
                  size="small"
                  className="gl-input gl-detail-engine w-28"
                  aria-label="Browser engine for this test's runs"
                >
                  {/* No icon of ours here: SelectValue already draws the selected
                      item's SF Symbol, so a lucide glyph beside it is the same
                      engine twice. */}
                  <SelectValue placeholder="Chromium" />
                </SelectTrigger>
                <SelectContent>
                  {RUN_BROWSERS.map((b) => (
                    <SelectItem key={b} value={b} icon={BROWSER_SF_SYMBOLS[b]}>
                      {RUN_BROWSER_LABELS[b]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* PACE FOR THIS RUN ONLY. It sits beside the engine because it
                  is the same kind of question — how this execution behaves —
                  and it defaults to "Inherit" rather than to the test's own
                  speed so that the control reads as an override rather than as
                  a second place the test's speed is stored. */}
              <label className="gl-run-option">
                <span className="whitespace-nowrap">Pace</span>
                <select
                  className="gl-input gl-detail-pace w-24"
                  value={runSpeed}
                  disabled={runInfo?.running}
                  aria-label="Speed for this run only; leave on Inherit to use the test's own"
                  onChange={(e) => setRunSpeed((e.target.value as TestSpeed | "") ?? "")}
                >
                  <option value="">Inherit</option>
                  {TEST_SPEEDS.map((sp) => (
                    <option key={sp} value={sp}>
                      {TEST_SPEED_LABELS[sp]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="gl-run-option gl-detail-timeout">
                <span className="whitespace-nowrap">Timeout</span>
                <Input
                  type="number"
                  min={5}
                  max={1800}
                  step={1}
                  className="gl-input gl-detail-secs w-12"
                  value={testTimeoutSec ?? ""}
                  placeholder={String(
                    Math.round((settingsQuery.data?.defaultTestTimeoutMs ?? 60_000) / 1000),
                  )}
                  disabled={runInfo?.running}
                  aria-label="Per-test timeout in seconds; leave empty to use the Settings default"
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    if (raw === "") {
                      setTestTimeoutSec(null);
                      api.tests.setTestTimeout(id, null).catch(() => {
                        /* best-effort persist */
                      });
                      return;
                    }
                    const sec = Math.max(5, Math.min(1800, Math.round(Number(raw) || 60)));
                    setTestTimeoutSec(sec);
                    api.tests.setTestTimeout(id, sec * 1000).catch(() => {
                      /* best-effort persist */
                    });
                  }}
                />
                <span className="gl-detail-unit">s</span>
              </label>
              {/* Imported tests only. A recorded test navigates to the absolute URL
                  the recorder watched, so a base URL would be a box that does
                  nothing; an imported spec is idiomatically relative
                  (`page.goto("/")`) and cannot run without one. It is usually filled
                  in already, from the source project's playwright.config — this is
                  where that lands, and the only repair when the config computed it
                  rather than writing it down. */}
              {test.sourceDir ? (
                <label className="gl-run-option gl-detail-baseurl">
                  <span className="whitespace-nowrap">Base URL</span>
                  <Input
                    type="url"
                    className="gl-input w-52"
                    value={baseUrlDraft}
                    placeholder="https://example.com"
                    disabled={runInfo?.running}
                    aria-label="Base URL that this imported test's relative navigations resolve against"
                    onChange={(e) => setBaseUrlDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    onBlur={() => {
                      const next = baseUrlDraft.trim();
                      if (next === (test.baseUrl ?? "")) return; // nothing changed
                      api.tests
                        .setBaseUrl(id, next === "" ? null : next)
                        .then(() => {
                          // Unlike the toggles beside it, this one invalidates: the
                          // run guard reads `baseUrl` off the RECORD, so a stale
                          // cache would keep refusing a run the user just fixed.
                          qc.invalidateQueries({ queryKey: ["test", id] });
                          qc.invalidateQueries({ queryKey: ["tests"] });
                        })
                        .catch(() => {
                          setBaseUrlDraft(test.baseUrl ?? "");
                          toast.error("That isn't a valid base URL — try https://example.com");
                        });
                    }}
                  />
                </label>
              ) : null}
              {signatureWarning ? (
                <span title={signatureWarning.title}>
                  <Status variant="error">{signatureWarning.text}</Status>
                </span>
              ) : null}
            </div>
            <span className="gl-detail-tool-rule" aria-hidden="true" />
            {/* The run toggles, a compact two-column block. The column-track rule that
                keeps it from overlapping itself at narrow widths moved into
                `.gl-run-options` (screens.css) in B5a — the reasoning is written
                out there, and `check:narrow-layout` reads it from the stylesheet
                rather than from a Tailwind class here. */}
            <div className="gl-run-options">
              <label className="gl-run-option">
                <Checkbox
                  checked={runHeadless}
                  onCheckedChange={(v) => {
                    const next = v === true;
                    setRunHeadless(next);
                    api.tests.setHeadless(id, next).catch(() => {
                      /* best-effort persist; the toggle still applies to this run */
                    });
                  }}
                  disabled={runInfo?.running}
                  aria-label="Run this test headless (no visible browser)"
                />
                Run headless
              </label>
              <label className="gl-run-option">
                {/* Independent of "Run headless". Headless Chromium renders to an
                    offscreen surface, so page.screenshot() works exactly the same —
                    it's how visual regression testing is normally done. Headless is
                    arguably the BETTER mode for it, since a headed run drags in
                    window chrome, focus rings and whatever display it landed on,
                    all of which read as visual changes nobody made. */}
                <Checkbox
                  checked={captureArtifacts}
                  onCheckedChange={(v) => {
                    const next = v === true;
                    setCaptureArtifacts(next);
                    api.tests.setCaptureArtifacts(id, next).catch(() => {
                      /* best-effort persist; the toggle still applies to this run */
                    });
                  }}
                  disabled={runInfo?.running}
                  aria-label="Capture screenshots on this run"
                />
                Capture screenshots
              </label>
              <label className="gl-run-option">
                {/* Separate from screenshots on purpose: this writes page console
                    output and request URLs to disk. Off by default, and the model
                    can only ASK for the result — it is never attached automatically. */}
                <Checkbox
                  checked={recordLogs}
                  onCheckedChange={(v) => {
                    const next = v === true;
                    setRecordLogs(next);
                    api.tests.setRecordLogs(id, next).catch(() => {
                      /* best-effort persist; the toggle still applies to this run */
                    });
                  }}
                  disabled={runInfo?.running}
                  aria-label="Record console and network on this run"
                />
                Record console &amp; network
              </label>
              <label className="gl-run-option">
                <Checkbox
                  checked={a11yChecks}
                  onCheckedChange={(v) => {
                    const next = v === true;
                    setA11yChecks(next);
                    api.tests.setA11yChecks(id, next).catch(() => {
                      /* best-effort persist; the toggle still applies to this run */
                    });
                  }}
                  disabled={runInfo?.running}
                  aria-label="Check accessibility on this run"
                />
                Check accessibility
              </label>
              <label className="gl-run-option">
                {/* The runner reads this off the RECORD, exactly as it reads
                    recordLogs — so it is persisted and never passed to run().
                    Off means nothing is clicked away: the built-in Klaviyo and
                    DataGrail handlers AND the rules taught for this host, because
                    half a switch would leave a test that asserts on the consent
                    banner watching it vanish anyway. */}
                <Checkbox
                  checked={handlePopups}
                  onCheckedChange={(v) => {
                    const next = v === true;
                    setHandlePopups(next);
                    api.tests.setHandlePopups(id, next).catch(() => {
                      /* best-effort persist; the toggle still applies to this run */
                    });
                  }}
                  disabled={runInfo?.running}
                  aria-label="Handle pop-ups on this run"
                />
                Handle pop-ups
              </label>
            </div>
            <span className="gl-detail-tool-rule" aria-hidden="true" />
            {/* `stop` and `go`, and this is the one place on the screen that earns
                a hue: pressing it causes the thing the colour means. Everything
                else in this toolbar is `ghost` for the same reason — a screen
                where every button is lit spends the whole palette on chrome. */}
            {runInfo?.running ? (
              <Btn className="gl-detail-run" tone="stop" onClick={() => stopRun(id)}>
                Stop
              </Btn>
            ) : (
              <Btn
                className="gl-detail-run"
                tone="go"
                onClick={() =>
                  run(id, captureArtifacts, runHeadless, runBrowser, runSpeed || undefined)
                }
              >
                Run test
              </Btn>
            )}
          </ToolbarActions>
        </ToolbarRow>
      </Toolbar>

      {/* Dismissible, and the dismissal is persisted rather than held here: the
          record stays diverged (everything else that reads the flag must keep
          saying so), the user has simply acknowledged it. The backend re-arms
          the banner when divergence is established AFRESH — an applied script
          that won't fully parse back into steps, or a step edit saved without
          regenerating — so a new problem is never hidden by an old dismissal. */}
      {test.stepsDiverged && !test.stepsDivergedDismissed ? (
        <div className="px-4 pt-2">
          <Callout
            color="yellow"
            icon={<TriangleAlert className="size-4" />}
            onDismiss={dismissDiverged}
            dismissLabel="Dismiss this warning"
          >
            <Callout.Text>{divergedMessage(test)}</Callout.Text>
          </Callout>
        </div>
      ) : null}

      {/* WHERE THIS FLOW IS USED — shown for any test with callers, flagged or
          not, because the callers are what a change here reaches. Each name is
          a link: "which tests does editing this break" should cost one click
          to answer, not a search. */}
      {test.isFlow || flowUsedBy.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-2 text-[12px] text-secondary">
          {flowUsedBy.length === 0 ? (
            <span>Not called by any test yet — add a “Run a flow” step in another test.</span>
          ) : (
            <>
              <span>
                Used by {flowUsedBy.length} test{flowUsedBy.length === 1 ? "" : "s"}:
              </span>
              {flowUsedBy.map((caller) => (
                <button
                  key={caller.id}
                  type="button"
                  className="cursor-pointer underline decoration-dotted underline-offset-2"
                  onClick={() => navigate({ to: "/test/$id", params: { id: caller.id } })}
                >
                  {caller.name}
                </button>
              ))}
              <span className="text-tertiary">Editing these steps changes every one of them.</span>
            </>
          )}
        </div>
      ) : null}

      {/* Imported tests (sourceDir set) are script-only; the verbatim file is
          the source of truth. Tests created in the app show Steps AND Script. */}
      {editingSteps ? (
        <EditStepsView
          steps={test.steps}
          scriptEdited={Boolean(test.scriptEdited)}
          imported={Boolean(test.sourceDir)}
          variables={test.variables ?? []}
          // An imported test's spec is never regenerated, so a variable
          // declared against it would be a promise nothing keeps — the same
          // reason the Variables tab itself is hidden for one.
          onCreateVariable={test.sourceDir ? undefined : createVariable}
          onCancel={() => setEditingSteps(false)}
          onSave={async (steps) => {
            // A script that isn't generated from steps can't be updated behind
            // the user's back, and it can't be silently left behind either —
            // ask, with both outcomes spelled out. Everything else saves and
            // regenerates as it always did.
            if (test.scriptEdited) {
              setPendingSteps(steps);
              return;
            }
            await commitSteps(steps, false);
          }}
        />
      ) : (() => {
        const imported = Boolean(test.sourceDir);
        const showSteps = !imported && test.steps.length > 0;
        // An apply can delete the last step, which removes the Steps trigger.
        // With an uncontrolled TabsRoot the value stayed "steps" and the user
        // was left staring at an empty pane with no tab selected in the bar.
        const value = tab === "steps" && !showSteps ? "script" : (tab ?? (showSteps ? "steps" : "script"));
        return (
          <TabsRoot value={value} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <div className="gl-tabs gl-detail-tabs">
              <Tabs variant="filled" size="large">
                {showSteps ? <TabsTrigger value="steps">Steps ({test.steps.length})</TabsTrigger> : null}
                <TabsTrigger value="script">Script</TabsTrigger>
                {/* Imported tests have no generated spec to parameterize — the
                    stored script is their source of truth, so a variable
                    declared here would never reach it. */}
                {imported ? null : (
                  <TabsTrigger value="variables">
                    Variables
                    {(test.variables?.length ?? 0) > 0 ? ` (${test.variables?.length})` : ""}
                  </TabsTrigger>
                )}
                {/* Hidden for an imported test only while it would be EMPTY,
                    which is the same rule the two neighbours state — "a tab
                    that could only ever be empty is worse than no tab". An
                    imported test can't be healed (its steps aren't the source
                    of truth), but its script is exactly the kind that gets
                    hand-edited, and hiding the tab outright would put that
                    history somewhere the user cannot reach. */}
                {imported && scriptChanges.length === 0 ? null : (
                  <TabsTrigger value="heals">
                    Heals
                    {pendingHeals > 0 ? ` (${pendingHeals})` : ""}
                  </TabsTrigger>
                )}
                {/* Same imported-test exclusion as the two above, and for the
                    same reason: the check runs from the capture fixture, which
                    an imported spec never loads. A tab that could only ever be
                    empty is worse than no tab. */}
                {imported ? null : (
                  <TabsTrigger value="a11y">
                    Accessibility
                    {a11yNewSteps > 0 ? ` (${a11yNewSteps})` : ""}
                  </TabsTrigger>
                )}
                {/* Gated on the GLOBAL switch, like the rail row: the check has
                    no per-test layer, so a tab on a test while the check is off
                    could only ever explain the switch. Imported tests are
                    excluded for the reason the three above are. */}
                {imported || !siteHealthOn ? null : (
                  <TabsTrigger value="site-health">Site Health</TabsTrigger>
                )}
              </Tabs>
            </div>
            <TabsContent value="steps" className="min-h-0 flex-1">
              <ScrollArea className="h-full" scrollbars="both">
                {/* The hover-free surface for what the row glyphs can only
                    hint at. Positional only: an index can be a deliberate
                    ordinal, but a generated path is never anyone's intent. */}
                {(() => {
                  const { positional } = gradeCounts(test.steps);
                  if (positional === 0) return null;
                  return (
                    <div className="px-3 pt-2">
                      <Callout color="yellow" icon={<TriangleAlert className="size-4" />}>
                        <Callout.Text>
                          {positional === 1
                            ? "1 step stands on a positional locator — a generated path that breaks when the page changes. Open it in the trainer and refine its selection."
                            : `${positional} steps stand on positional locators — generated paths that break when the page changes. Open them in the trainer and refine their selections.`}
                        </Callout.Text>
                      </Callout>
                    </div>
                  );
                })()}
                <div className="gl-step-list">
                  {computeStepDepths(test.steps).map((depth, i) => (
                    <StepRow
                      key={test.steps[i].id}
                      index={i}
                      step={test.steps[i]}
                      indent={depth}
                      runStatus={runInfo?.stepStatus[i]}
                      trend={stepTrends.get(test.steps[i].id)}
                      isNew={newStepIds.has(test.steps[i].id)}
                      onOpenFlow={(flowId) => navigate({ to: "/test/$id", params: { id: flowId } })}
                      onUnwrapFlow={() => setUnwrappingStep(test.steps[i])}
                    />
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="script" className="flex min-h-0 flex-1 flex-col">
              {/* Five clusters, and no readout ever between two buttons. Left
                  to right: the live page with what it is showing TRAILING its
                  controls, the script's own view control, the AI pair, then —
                  at the far end, beside the actions they inform — everything
                  the editor knows, and the one cluster that commits. The
                  arrangement used to be a single right-aligned run in which
                  "Types ready" landed between Outline and Explain failure,
                  splitting a row of buttons with a label. `check:script-bar`
                  pins the CSS half; "the script bar's clusters" in
                  test-detail-view.test.tsx pins this half. */}
              <div className="gl-detail-script-bar">
                <span className="gl-script-bar-left">
                  <span className="gl-script-live" data-gl="script-live">
                    <span className="gl-script-group">
                      <Btn
                        tone={livePage.open ? "go" : "ghost"}
                        onClick={() => void toggleLivePage()}
                        disabled={liveBusy || !liveUrl}
                        title={
                          livePage.open
                            ? "Close the live page"
                            : "Open this test's site in a Playwright browser the editor can ask: match counts after every locator, the caret's element outlined, Pick locator"
                        }
                        aria-pressed={livePage.open}
                      >
                        {liveBusy ? "Live page…" : livePage.open ? "Live page ●" : "Live page"}
                      </Btn>
                      {/* The live page's OTHER control, not Outline's
                          neighbour: it is disabled until the toggle beside it
                          is on, and what it inserts is what that page was
                          asked for. */}
                      {editingScript ? (
                        <Btn
                          onClick={() => void pickLocator()}
                          disabled={!livePage.open || Boolean(livePage.picking)}
                          title={
                            livePage.open
                              ? "Click an element in the live page; its locator is inserted at the caret"
                              : "Open the live page to pick a locator from it"
                          }
                        >
                          Pick locator
                        </Btn>
                      ) : null}
                    </span>
                    {livePage.open ? (
                      <span className="gl-script-live-status" title={livePage.url}>
                        {livePage.picking ? "Click an element in the live page…" : hostOf(livePage.url)}
                      </span>
                    ) : livePage.closedReason ? (
                      <span className="gl-script-live-status" data-muted="">
                        {livePage.closedReason}
                      </span>
                    ) : null}
                  </span>
                  <span className="gl-script-group">
                    <Btn
                      onClick={() => setOutlineOpen((v) => !v)}
                      aria-pressed={outlineOpen}
                      title="The steps as a list to jump to, and where the caret's locator is used across the library"
                    >
                      Outline
                    </Btn>
                  </span>
                  {/* The holo-treated pair, together and mounted only when at
                      least one of them is offered — an empty cluster would
                      still spend the bar's cluster gap on nothing. */}
                  {editingScript || (typeof failedStepIndex === "number" && runOutput) ? (
                    <span className="gl-script-group" data-gl="script-ai">
                      {typeof failedStepIndex === "number" && runOutput ? (
                        <Btn
                          tone="ai"
                          onClick={() => openAi("explain")}
                          title="Ask the instant model why the last run failed, starting from the caret's statement"
                        >
                          Explain failure
                        </Btn>
                      ) : null}
                      {editingScript ? (
                        <Btn tone="ai" onClick={() => openAi("rewrite")} title="Rewrite the selection or the whole file with AI (⌘K)">
                          Ask AI
                        </Btn>
                      ) : null}
                    </span>
                  ) : null}
                </span>
                <span className="gl-script-bar-right">
                  <span className="gl-script-bar-status" data-gl="script-status">
                    {tsStatusQuery.data ? (
                      <span
                        className="gl-script-live-status"
                        data-gl="ts-status"
                        {...(tsAvailable ? {} : { "data-muted": "" })}
                        title={tsAvailable ? `TypeScript ${tsStatusQuery.data.typescript ?? ""} — completions, hover, type errors and inspections` : tsStatusQuery.data.reason}
                      >
                        {tsAvailable ? "Types ready" : "Types unavailable"}
                      </span>
                    ) : null}
                    {caretStep && (!editingScript || scriptCheck.status === "idle") ? (
                      <span className="gl-script-check-msg" data-checking="" data-gl="caret-step">
                        step {caretStep.index + 1} · {caretStep.label}
                      </span>
                    ) : null}
                    {editingScript && scriptCheck.status === "checking" ? (
                      <span className="gl-script-check-msg" data-checking="" role="status">
                        Checking with Playwright…
                      </span>
                    ) : null}
                    {editingScript && scriptCheck.status === "failed" ? (
                      <span className="gl-script-check-msg" role="status">
                        {scriptCheck.errors.length === 1
                          ? "Playwright can't load this script — 1 problem"
                          : `Playwright can't load this script — ${scriptCheck.errors.length} problems`}
                      </span>
                    ) : null}
                    {!editingScript && test.scriptEdited ? <span className="gl-chip">Edited manually</span> : null}
                  </span>
                  {/* The bar's right end is always the MODE: the two ways into
                      a change while reading, Cancel and Save while making one.
                      Record here belongs to that pair rather than beside
                      Outline, where it only ever sat as Pick locator's `else`. */}
                  <span className="gl-script-group" data-gl="script-commit">
                    {editingScript ? (
                      <>
                        <Btn
                          onClick={() => {
                            setEditingScript(false);
                            setScriptCheck(IDLE_CHECK);
                            setAiPanel(null);
                            aiOriginRef.current = null;
                          }}
                        >
                          Cancel
                        </Btn>
                        {scriptCheck.status === "failed" ? (
                          <Btn tone="stop" onClick={() => void writeScriptDraft()}>
                            Save anyway
                          </Btn>
                        ) : null}
                        <Btn tone="go" onClick={saveScript} disabled={scriptCheck.status === "checking"}>
                          {scriptCheck.status === "checking" ? "Checking…" : "Save"}
                        </Btn>
                      </>
                    ) : (
                      <>
                        <Btn
                          onClick={recordHere}
                          title={
                            caretStep
                              ? `Open the trainer with new steps landing after step ${caretStep.index + 1}`
                              : "Open the trainer with new steps landing at the end"
                          }
                        >
                          Record here
                        </Btn>
                        <Btn
                          onClick={() => {
                            setScriptDraft(scriptQuery.data ?? "");
                            setScriptBase(scriptQuery.data ?? "");
                            setScriptCheck(IDLE_CHECK);
                            setEditingScript(true);
                          }}
                        >
                          Edit script
                        </Btn>
                      </>
                    )}
                  </span>
                </span>
              </div>
              {outlineOpen ? (
                <ScriptOutlinePanel
                  steps={preview?.stepList ?? test.steps}
                  stepRanges={preview?.stepRanges ?? []}
                  script={shownScript}
                  caretIndex={caretStep?.index ?? null}
                  tests={testsQuery.data ?? []}
                  currentTestId={id}
                  onJumpToLine={jumpToScriptLine}
                  onOpenTest={(testId) => navigate({ to: "/test/$id", params: { id: testId } })}
                  onClose={() => setOutlineOpen(false)}
                />
              ) : null}
              {aiPanel ? (
                <ScriptAiPanel
                  mode={aiPanel.mode}
                  testId={id}
                  testName={test.name}
                  testUrl={test.url}
                  script={shownScript}
                  selection={aiPanel.selection}
                  caretLine={caretLine ?? 1}
                  failure={
                    typeof failedStepIndex === "number"
                      ? { index: failedStepIndex, label: test.steps[failedStepIndex] ? describeStep(test.steps[failedStepIndex]) : undefined, output: runOutput }
                      : { output: runOutput }
                  }
                  instructions={resolveAiInstructions(settingsQuery.data, test.url)}
                  onApply={applyAi}
                  onClose={() => setAiPanel(null)}
                />
              ) : null}
              {editingScript && scriptCheck.status === "failed" ? (
                <ul className="gl-script-check-errors" aria-label="Script problems">
                  {scriptCheck.errors.map((e, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className="gl-script-check-row"
                        disabled={!e.line}
                        title={e.snippet}
                        onClick={() => {
                          if (e.line) jumpToScriptLine(e.line);
                        }}
                      >
                        <span className="gl-script-check-loc">
                          {e.line ? `Line ${e.line}${e.column ? ":" + e.column : ""}` : "Script"}
                        </span>
                        <span>{e.message}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ScriptEditor
                value={shownScript}
                onChange={setScriptDraft}
                readOnly={!editingScript}
                errors={scriptCheck.errors}
                skippedRanges={preview?.skippedRanges ?? null}
                runStatus={runLineStatus}
                onCaretLine={setCaretLine}
                ariaLabel={`Script of ${test.name}`}
                handleRef={scriptEditorRef}
                lineWrap={settingsQuery.data?.editorLineWrap ?? false}
                lineNumbers={settingsQuery.data?.editorLineNumbers ?? true}
                tabSize={settingsQuery.data?.editorTabSize ?? 2}
                inlays={liveInlays}
                ghost={ghostEnabled ? ghostSource : null}
                onAiRequest={editingScript ? () => openAi("rewrite") : undefined}
                intelligence={intelligence}
                keymapPreset={settingsQuery.data?.editorKeymap ?? "default"}
                stepRanges={preview?.stepRanges ?? null}
              />
              <Dialog
                open={staleOpen}
                onOpenChange={setStaleOpen}
                title="The script changed on disk"
                description={SCRIPT_CHANGED_ON_DISK}
                confirmLabel="Overwrite with my draft"
                confirmVariant="destructive"
                onConfirm={() => {
                  setStaleOpen(false);
                  void writeScriptDraft({ overwrite: true, confirmedDiverge: true });
                }}
                destructiveAction={{
                  label: "Reload (discard draft)",
                  onClick: () => void reloadScript(),
                }}
              />
              <Dialog
                open={divergeConfirm !== null}
                onOpenChange={(open) => {
                  if (!open) setDivergeConfirm(null);
                }}
                title={
                  divergeConfirm && divergeConfirm.newlySkipped.length === 1
                    ? "One statement won't become a step"
                    : `${divergeConfirm?.newlySkipped.length ?? 0} statements won't become steps`
                }
                description={describeDiverge(divergeConfirm?.newlySkipped ?? [])}
                confirmLabel="Save anyway"
                confirmVariant="accent"
                onConfirm={() => {
                  const pending = divergeConfirm;
                  setDivergeConfirm(null);
                  if (pending) {
                    void writeScriptDraft({ overwrite: pending.overwrite, confirmedDiverge: true });
                  }
                }}
              />
            </TabsContent>
            {imported ? null : (
              <TabsContent value="variables" className="min-h-0 flex-1">
                <VariablesPanel test={test} />
              </TabsContent>
            )}
            {imported ? null : (
              <TabsContent value="heals" className="min-h-0 flex-1">
                <HealsPanel test={test} />
              </TabsContent>
            )}
            {imported ? null : (
              <TabsContent value="a11y" className="min-h-0 flex-1">
                <A11yPanel test={test} />
              </TabsContent>
            )}
            {imported || !siteHealthOn ? null : (
              <TabsContent value="site-health" className="min-h-0 flex-1">
                <SiteHealthPanel test={test} />
              </TabsContent>
            )}
          </TabsRoot>
        );
      })()}

      {/* The dialog itself is rendered by AiDebugHost above the router, so a
          minimized session outlives this view. */}
      {/* Always rendered now, not only once something has run in this session.
          Opening a test cold used to say nothing at all about it — not that it
          had never run, not that it failed yesterday (§6.1). */}
      <RunOutput
        info={runInfo}
        summary={runSummary}
        testId={id}
        steps={test.steps}
        runs={runsQuery.data ?? []}
        onOpenVisual={() => navigate({ to: "/visual" })}
        onDebug={openAiDebug}
        onReview={test.sourceDir ? undefined : () => setTab("heals")}
        onSendToTracker={setFailureRunId}
        hasTrace={
          runSummary.state === "failed" &&
          ((runsQuery.data ?? []).find((r) => r.id === runSummary.recordId)?.hasTrace ?? false)
        }
        onOpenTrace={(runId) => {
          void api.runs.openTrace(id, runId).then((res) => {
            if (!res.ok) toast.error(res.reason ?? "No trace for this run.");
          });
        }}
        aiStatus={aiStatus}
      />

      {/* Unwrapping is a content change with no inverse — the call is replaced
          by a bound COPY of the flow's steps, so later flow edits stop reaching
          this test. Worth a confirm that says exactly that. */}
      <Dialog
        open={unwrappingStep !== null}
        onOpenChange={(o) => {
          if (!o) setUnwrappingStep(null);
        }}
        title="Unwrap this flow call?"
        description={`The “${unwrappingStep?.label ?? "flow"}” call is replaced by a copy of the flow's steps, with this call's parameter values filled in. The copied steps become this test's own — edits to the flow no longer reach them.`}
        confirmLabel="Unwrap"
        confirmVariant="accent"
        onConfirm={async () => {
          if (!unwrappingStep) return;
          try {
            await api.tests.unwrapFlow(id, unwrappingStep.id);
            qc.invalidateQueries({ queryKey: ["test", id] });
            qc.invalidateQueries({ queryKey: ["tests"] });
            qc.invalidateQueries({ queryKey: ["script", id] });
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
          }
          setUnwrappingStep(null);
        }}
      />

      {/* A failure names no step of its own — the loader resolves which step
          failed from the replay, which is where that fact lives. Passing null
          rather than guessing here keeps one answer to "which step failed?" */}
      <IssueComposeDialog
        source={
          failureRunId
            ? { kind: "failure", testId: test.id, runId: failureRunId, stepId: null }
            : null
        }
        open={failureRunId !== null}
        onOpenChange={(open) => {
          if (!open) setFailureRunId(null);
        }}
        onFiled={(issue) => toast.success(`Filed as ${issue.identifier}.`)}
        onCommented={(link) => toast.success(`Added to ${link.identifier}.`)}
      />

      {/* Asked at SAVE, not when Edit Steps is opened: this is a question about
          what to do with the edits, and it can only be answered once they
          exist. Cancelling returns to the editor with the draft intact. */}
      {pendingSteps ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingSteps(null);
          }}
          title={
            test.sourceDir ? "Save steps without changing the script?" : "Apply these steps to the script?"
          }
          description={
            test.sourceDir
              ? "This test runs the file it was imported with, and that file is never regenerated — a generated spec would lose the imports and anything else the step list can't express. The edited steps are saved as this test's step list, and the test is flagged as out of sync with its script."
              : "This test's script was edited directly, so it isn't generated from these steps. Regenerating rebuilds it from the step list and discards anything the steps can't express. Saving without regenerating leaves the script — and every run — exactly as it is, and flags the test as out of sync."
          }
          confirmLabel={test.sourceDir ? "Save steps" : "Regenerate script"}
          confirmVariant="accent"
          onConfirm={() => commitSteps(pendingSteps, !test.sourceDir)}
          secondaryAction={
            test.sourceDir
              ? undefined
              : { label: "Save steps only", onClick: () => commitSteps(pendingSteps, false) }
          }
        />
      ) : null}

      <Dialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename test"
        confirmLabel="Save"
        confirmDisabled={renameValue.trim().length === 0}
        onConfirm={() => saveName(renameValue)}
      >
        <Field label="Name" orientation="vertical">
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
        </Field>
      </Dialog>
    </div>
  );
}
