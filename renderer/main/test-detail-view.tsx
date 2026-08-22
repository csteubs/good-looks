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
import { ScriptEditor, ScriptView, lineStartOffset } from "./script-view";
import { StepRow } from "./step-row";
import { VariablesPanel } from "./variables-panel";
import { HealsPanel } from "./heals-panel";
import { A11yPanel } from "./a11y-panel";
import { computeStepDepths } from "../lib/describe-step";
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
  type Step,
  type TestRecord,
  type TestVariable,
  type VariableKind,
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
  const [scriptDraft, setScriptDraft] = React.useState("");
  // The pre-save check's verdict on the draft. `checking` holds Save while the
  // Playwright CLI has the draft; `failed` keeps the editor open with the
  // problems listed and offers "Save anyway" — the file is the user's, and a
  // draft that does not load yet is still theirs to keep.
  const [scriptCheck, setScriptCheck] = React.useState<ScriptCheckState>(IDLE_CHECK);
  const scriptTextareaRef = React.useRef<HTMLTextAreaElement | null>(null);
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
  // Per-test "Run headless" choice — remembers whether this test's runs open a
  // visible browser. Falls back to the global Settings default. Runs only; the
  // trainer/"Edit in Trainer" flow is always headed.
  const [runHeadless, setRunHeadless] = React.useState(false);
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
  // Badged on the Accessibility tab, from the most recent run that actually
  // checked — same reasoning as the Heals count: an unaccepted violation the
  // user has to open a tab to discover is one they won't discover. Shares the
  // ["runs"] key with Stats and the panel itself, so this is usually free.
  const runsQuery = useQuery({ queryKey: ["runs"], queryFn: api.runs.list });
  const settingsQuery = useQuery({
    queryKey: ["recorder-settings"],
    queryFn: () => api.recorder.getSettings(),
  });
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
  const signatureWarning = ((): { text: string; title: string } | null => {
    if (!test) return null;
    const host = normalizeSignatureHost(test.sourceDir ? (test.baseUrl ?? "") : (test.url ?? ""));
    if (!host) return null;
    const entry = (signaturesQuery.data ?? []).find((s) => s.host === host);
    if (!entry) return null;
    if (entry.state === "expired") {
      return {
        text: "Signature expired",
        title: `The Shopify crawler signature for ${host} has expired, so runs of this test go out unsigned. An expired signature fails verification, which is worse than sending none — create a new one in your Shopify admin.`,
      };
    }
    if (entry.state === "unreadable") {
      return {
        text: "Signature unreadable",
        title: `A Shopify crawler signature is registered for ${host} but can't be decrypted on this Mac, so runs of this test go out unsigned.`,
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
  // One badge for both stores. They are two routes to the same hazard — the
  // stored test changed and nobody has looked — and two numbers on one tab
  // would be asking the user to add them up.
  const pendingHeals =
    (healsQuery.data ?? []).filter((h) => h.status === "pending").length +
    scriptChanges.filter((c) => c.status === "pending").length;
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
      const updated = await api.tests.updateScript(id, source, origin);
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

  /** Write the draft over the script. No verification here — the callers
   *  decide what has to be true first. */
  const writeScriptDraft = async () => {
    // No origin: a hand edit the user is looking at as they save it. The
    // backend defaults to exactly that, but saying it here is what keeps the
    // Heals tab's labels honest if the default ever changes.
    await api.tests.updateScript(id, scriptDraft, { by: "manual", reviewed: true });
    qc.invalidateQueries({ queryKey: ["script", id] });
    qc.invalidateQueries({ queryKey: ["test", id] });
    qc.invalidateQueries({ queryKey: ["script-changes", id] });
    setEditingScript(false);
    setScriptCheck(IDLE_CHECK);
  };

  /** Save = check, then write. The check hands the draft to the real
   *  Playwright CLI (`tests:checkScript`, see script-check.ts): a draft it
   *  cannot load stays in the editor with its problems listed against the
   *  lines. A check that could not RUN is reported the same way — it is not a
   *  pass — and "Save anyway" is the way past either. */
  const saveScript = async () => {
    setScriptCheck({ status: "checking", errors: [] });
    let result: ScriptCheckResult;
    try {
      result = await api.tests.checkScript(id, scriptDraft);
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
    await writeScriptDraft();
  };

  /** Put the caret at the start of a reported line and bring it into view.
   *  The textarea is the editor's one scrolling element, so setting its
   *  scrollTop is what moves the highlight layer and the gutter with it. */
  const jumpToScriptLine = (line: number) => {
    const ta = scriptTextareaRef.current;
    if (!ta) return;
    const offset = lineStartOffset(scriptDraft, line);
    ta.focus();
    ta.setSelectionRange(offset, offset);
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.scrollTop = Math.max(0, (line - 3) * lineHeight);
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
      // edit the user made.
      await writeScriptDraft();
    }
    start(test.url, test.name, test.id);
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
                    else start(test.url, test.name, test.id);
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
                      start(test.url, test.name, test.id);
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
            {/* The gang of four, a compact 2×2 block. The column-track rule that
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
                onClick={() => run(id, captureArtifacts, runHeadless, runBrowser)}
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
              <div className="gl-detail-script-bar">
                {editingScript ? (
                  <>
                    {scriptCheck.status === "checking" ? (
                      <span className="gl-script-check-msg" data-checking="" role="status">
                        Checking with Playwright…
                      </span>
                    ) : scriptCheck.status === "failed" ? (
                      <span className="gl-script-check-msg" role="status">
                        {scriptCheck.errors.length === 1
                          ? "Playwright can't load this script — 1 problem"
                          : `Playwright can't load this script — ${scriptCheck.errors.length} problems`}
                      </span>
                    ) : null}
                    <Btn
                      onClick={() => {
                        setEditingScript(false);
                        setScriptCheck(IDLE_CHECK);
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
                    {test.scriptEdited ? <span className="gl-chip">Edited manually</span> : null}
                    <Btn
                      onClick={() => {
                        setScriptDraft(scriptQuery.data ?? "");
                        setScriptCheck(IDLE_CHECK);
                        setEditingScript(true);
                      }}
                    >
                      Edit script
                    </Btn>
                  </>
                )}
              </div>
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
              {editingScript ? (
                <ScriptEditor
                  value={scriptDraft}
                  onChange={setScriptDraft}
                  errors={scriptCheck.errors}
                  textareaRef={scriptTextareaRef}
                />
              ) : (
                <ScriptView code={scriptQuery.data ?? ""} />
              )}
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
