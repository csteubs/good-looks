import * as React from "react";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CustomContextMenu,
  CustomContextMenuContent,
  CustomContextMenuItem,
  CustomContextMenuSeparator,
  CustomContextMenuSub,
  CustomContextMenuSubContent,
  CustomContextMenuSubTrigger,
  CustomContextMenuTrigger,
  Slider,
  Status,
  Text,
  toast,
} from "@ui";
import { Plus, FolderOpen, Gauge, EyeOff, BarChart3, Images, ListChecks, Sparkles, Tag, Wand2, Copy } from "lucide-react";

import { ChromeButton, Rail, RailEmpty, RailGroup, RailRow, SiteIcon } from "../theme";
import { RoutinesRail, useCreateRoutine } from "./routines-rail";
import { api } from "../lib/api";
import { aggregateStatus, type SessionLike } from "../lib/ai-debug-sessions";
import { toneFor } from "../lib/ai-debug-status";
import { verdictsByTest, type RunVerdictTone } from "../lib/run-verdict";
import type { LlmProvider } from "../lib/llm-types";
import type { TestRecord } from "../lib/recorder-types";
import { TEST_SPEEDS, TEST_SPEED_LABELS } from "../lib/recorder-types";
import { describeDuplicationWarnings, type DuplicationWarning } from "../lib/duplicate-warnings";
import { importWarnings } from "../lib/import-warnings";
import { nativeShell } from "../lib/native-shell";
import { BranchesRailRow } from "./branches-rail-row";
import { useAiDebug } from "./ai-debug-store";
import { NewRecordingDialog } from "./new-recording-dialog";
import { GenerateTestDialog } from "./generate-test-dialog";
import { ImportGitDialog } from "./import-git-dialog";
import { TagsDialog } from "./tags-dialog";
import { DuplicateTestDialog } from "./duplicate-test-dialog";


/** Slider embedded in the "Adjust Test Speed" submenu — snaps to the named
 * speeds rather than an arbitrary ms value, since that's what a Playwright
 * slowMo delay usefully supports. Pointer/keyboard events are stopped from
 * bubbling so Radix's menu roving-focus doesn't hijack the drag. */
function TestSpeedSlider({ test }: { test: TestRecord }) {
  const qc = useQueryClient();
  const fastIndex = TEST_SPEEDS.indexOf("fast");
  // Fall back to the DEFAULT speed, not to index 0. Index 0 is the slowest stop
  // — a record with an unrecognised speed would open the menu reading "Crawl"
  // and commit that on the first nudge, silently making a fast test the
  // slowest one there is.
  const stored = TEST_SPEEDS.indexOf(test.speed ?? "fast");
  const initial = stored >= 0 ? stored : fastIndex;
  const [index, setIndex] = React.useState(initial);
  const lastCommitted = React.useRef(initial);

  // Commit on every discrete step change rather than waiting for
  // onValueCommit (drag-end) — with a handful of stops, a plain click never
  // produces a drag gesture, so onValueCommit would never fire.
  const handleChange = ([v]: number[]) => {
    setIndex(v);
    if (lastCommitted.current === v) return;
    lastCommitted.current = v;
    void (async () => {
      try {
        await api.tests.setSpeed(test.id, TEST_SPEEDS[v]);
        qc.invalidateQueries({ queryKey: ["tests"] });
        qc.invalidateQueries({ queryKey: ["test", test.id] });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update test speed.");
      }
    })();
  };

  return (
    <div
      className="w-52 px-2 py-2"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <Text variant="small" color="secondary">
          Speed
        </Text>
        <Text variant="small">{TEST_SPEED_LABELS[TEST_SPEEDS[index]]}</Text>
      </div>
      {/* Bounds derived from the list, not written out: a hardcoded max is how
          a new speed becomes an unreachable stop nobody notices is missing. */}
      <Slider
        variant="filled"
        size="small"
        min={0}
        max={TEST_SPEEDS.length - 1}
        step={1}
        ticks={TEST_SPEEDS.length}
        value={[index]}
        startContent={TEST_SPEED_LABELS[TEST_SPEEDS[0]]}
        endContent={TEST_SPEED_LABELS[TEST_SPEEDS[TEST_SPEEDS.length - 1]]}
        onValueChange={handleChange}
      />
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A test row's icon: a monogram generated from the recorded site's host.
 *
 * THIS USED TO FETCH A THIRD-PARTY FAVICON, and that was an egress path nobody
 * had agreed to. It called
 * `https://www.google.com/s2/favicons?domain=<host>` for EVERY test in the
 * library, on every render of the sidebar — so simply opening the app sent
 * Google the hostname of every site under test. A QA tool's library routinely
 * names unreleased staging hosts and internal domains, and this app's stated
 * egress posture is ONE opt-in summary-only webhook (DECISIONS 2026-08-04). It
 * had no setting, no disclosure, and it was not visible from anywhere except
 * this function.
 *
 * `SiteIcon` (REDESIGN §3.5) is the answer and was built for exactly this: the
 * monogram is deterministic per host, needs no network, and is a complete
 * design rather than a degraded one — it was already what reserved names like
 * `localhost` fell back to.
 *
 * THE OPT-IN LANDED IN B4 and is what `fromWeb` carries: Appearance → "Fetch
 * site icons from the web", off by default, with a `risk` block naming the
 * third party and what it learns. `fromWeb` is a required prop rather than one
 * defaulting to `false`, so re-enabling the fetch is a decision somebody has to
 * write at this call site instead of something a missing prop does quietly.
 * Reserved hosts (`localhost`, `*.local`, bare IPs) stay on the monogram even
 * when it is on — `SiteIcon` decides that, not this.
 *
 * Guarded by `check:renderer-egress`, so the next one of these is a build
 * failure rather than a discovery. */
function Favicon({ url, fromWeb }: { url: string; fromWeb: boolean }) {
  return <SiteIcon host={hostOf(url)} size={16} favicon={fromWeb} />;
}

// Native popup menu bridge. The sidebar header action renders as a native
// control, so a React dropdown can't anchor to it — use the native menu popup.
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
  }) => Promise<{ commandId?: number }>;
}
function nativeMenu(): NativeMenu {
  return (window as unknown as { glazeAPI: { Menu: NativeMenu } }).glazeAPI.Menu;
}

function openSettingsWindow(): void {
  (window as unknown as { glazeAPI: { glaze: { ipc: { invoke: (c: string) => Promise<void> } } } })
    .glazeAPI.glaze.ipc.invoke("window:openSettings")
    .catch(() => {});
}

const PROVIDER_LABEL: Record<LlmProvider, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  anthropic: "Claude",
};

type ConnState = "checking" | "connected" | "disconnected";

/** Sidebar footer indicator for the configured AI provider. Always visible
 * (for local and cloud providers), showing a green dot when connected, a red
 * dot when not, or a loading dot while probing. Clicking opens Settings on the
 * AI provider section. Re-checks on window focus so a connection just made in
 * Settings is reflected here. */
function AiConnectionFooter() {
  const [state, setState] = React.useState<ConnState>("checking");
  const [label, setLabel] = React.useState<string>("");

  const check = React.useCallback(async () => {
    try {
      const cfg = await api.llm.getConfig();
      const providerName = PROVIDER_LABEL[cfg.provider] ?? cfg.provider;
      setLabel(providerName);
      setState("checking");
      const status = await api.llm.status(cfg.provider);
      if (status.reachable) {
        setState("connected");
      } else {
        setState("disconnected");
        // Use the backend's friendly error as the label tooltip when available.
        if (status.error) setLabel(`${providerName} — ${status.error}`);
      }
    } catch {
      setState("disconnected");
      setLabel("No AI provider");
    }
  }, []);

  React.useEffect(() => {
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [check]);

  const variant = state === "connected" ? "success" : state === "disconnected" ? "error" : "loading";
  const ariaLabel =
    state === "connected"
      ? `${label} connected`
      : state === "disconnected"
        ? `${label} not connected`
        : `Checking ${label} connection`;

  return (
    // A RailRow, not bespoke markup: the footer is one more row in the rail's
    // vocabulary — icon, label, click — and the neutral hover/selection rules
    // apply to it for the same reason they apply to the list.
    <RailRow
      icon={<Status variant={variant} aria-label={ariaLabel} />}
      title={state === "connected" ? label : label.split(" — ")[0]}
      onClick={openSettingsWindow}
      // `hint` (the native title): the error detail has to be reachable
      // without hover-openable chrome (jsdom cannot open a Radix tooltip).
      hint={state === "disconnected" ? label : undefined}
    />
  );
}

/** Trailing indicators on a test's sidebar row.
 *
 *  The AI-debug sparkle follows the same tone contract as every other surface
 *  (blue ready / orange thinking / green ready-for-review / red failed) so a
 *  minimized job stays findable from the LIST of tests, not just from inside
 *  the one test the user happens to have open. The dot is the latest run's
 *  verdict — the sidebar answers "which of my tests are broken?" at a glance
 *  instead of one detail-view visit per test — on the five-way green→red scale
 *  in lib/run-verdict.ts, so a three-browser batch that lost one browser reads
 *  differently from one that lost all three. */
function RowIndicators({
  sessions,
  verdict,
}: {
  sessions: SessionLike[];
  verdict: RunVerdictTone | undefined;
}) {
  const agg = aggregateStatus(sessions);
  const tone = agg === null ? null : toneFor(agg);
  if (!tone && !verdict) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {tone ? (
        <Sparkles
          role="img"
          aria-label={`AI debug — ${tone.label}`}
          className={`size-3.5 ${tone.className} ${tone.busy ? "animate-pulse" : ""}`}
        />
      ) : null}
      {verdict ? (
        <span
          role="img"
          aria-label={verdict.label}
          title={verdict.label}
          className={`size-2 rounded-full ${verdict.className}`}
        />
      ) : null}
    </span>
  );
}

export function LibrarySidebar() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const selectedId = params.id;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onRoutines = pathname === "/batch";
  // Declared unconditionally — it is a hook, and the rail renders on every
  // screen. Its queries are ones the app already holds.
  const newRoutine = useCreateRoutine();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [generateOpen, setGenerateOpen] = React.useState(false);
  const [gitDialogOpen, setGitDialogOpen] = React.useState(false);
  const [tagsFor, setTagsFor] = React.useState<TestRecord | null>(null);
  // A duplication waiting on the warning dialog. Holds the warnings themselves
  // rather than recomputing them for the dialog: they were already needed to
  // decide whether to open it, and deriving the same list twice is how the
  // dialog ends up describing something other than what the click evaluated.
  const [pendingCopy, setPendingCopy] = React.useState<{
    test: TestRecord;
    warnings: DuplicationWarning[];
  } | null>(null);
  const [copying, setCopying] = React.useState(false);

  const { data: tests = [] } = useQuery({ queryKey: ["tests"], queryFn: api.tests.list });
  // Whether to offer the branch switcher at all. Shares the ["branches",
  // "status"] cache with the view itself, so opening it costs nothing extra.
  const branchesAvailable = useQuery({
    queryKey: ["branches", "status"],
    queryFn: api.branches.status,
    // The answer is a property of how this app was launched, so it cannot
    // change while it is running. Refetching it would be pure noise.
    staleTime: Infinity,
  }).data?.available === true;
  // Shares the ["runs"] cache with Stats and the detail view, so the per-row
  // verdict dots are usually free. The cache is invalidated by RecorderProvider
  // when a run finishes — without that the dot here keeps showing the verdict
  // the list had when the sidebar mounted, which is the exact failure of a
  // re-run that fixed the test and left the dot red.
  const runsQuery = useQuery({ queryKey: ["runs"], queryFn: api.runs.list });
  // Only for the site-icon opt-in. Shares the ["recorder-settings"] key with the
  // batch and detail views, so on any screen that already reads settings this
  // costs nothing — and while it is loading `data` is undefined, which resolves
  // to the monogram. Undefined meaning "don't fetch" is the right way round for
  // an egress switch: the failure mode is a plainer icon, not a silent request.
  const settingsQuery = useQuery({
    queryKey: ["recorder-settings"],
    queryFn: () => api.recorder.getSettings(),
  });
  const siteIconsFromWeb = settingsQuery.data?.siteIconsFromWeb === true;
  const verdictByTest = React.useMemo(
    () => verdictsByTest(runsQuery.data ?? []),
    [runsQuery.data],
  );
  // AI-debug sessions grouped per test, for the row sparkle.
  const { sessions } = useAiDebug();
  const sessionsByTest = React.useMemo(() => {
    const m = new Map<string, SessionLike[]>();
    for (const s of sessions) {
      if (!s.testId) continue;
      const list = m.get(s.testId) ?? [];
      list.push(s);
      m.set(s.testId, list);
    }
    return m;
  }, [sessions]);

  const duplicate = async (test: TestRecord) => {
    setCopying(true);
    try {
      const created = await api.tests.duplicate(test.id);
      qc.invalidateQueries({ queryKey: ["tests"] });
      setPendingCopy(null);
      navigate({ to: "/test/$id", params: { id: created.id } });
      toast.success(`Duplicated as “${created.name}”.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to duplicate test.");
    } finally {
      setCopying(false);
    }
  };

  // Warn only when there is something to warn about. A dialog that always
  // appears is one nobody reads, which would cost exactly the cases it exists
  // for — a copied credential, or a run history the user expected to come with.
  const startDuplicate = async (test: TestRecord) => {
    let storedSecrets = 0;
    try {
      const status = await api.tests.secretStatus(test.id);
      storedSecrets = status.filter((s) => s.hasValue).length;
    } catch {
      // Leave the count at zero: the other warnings still stand, and inventing
      // a secrets line we couldn't verify is worse than omitting one.
    }
    const warnings = describeDuplicationWarnings(test, storedSecrets);
    if (warnings.length === 0) {
      await duplicate(test);
      return;
    }
    setPendingCopy({ test, warnings });
  };

  const importFromFiles = async () => {
    try {
      const res = await api.tests.importFiles();
      if (res.imported === 0) return; // user cancelled the picker
      qc.invalidateQueries({ queryKey: ["tests"] });
      toast.success(
        res.imported === 1 ? "Imported 1 test." : `Imported ${res.imported} tests.`,
      );
      for (const w of importWarnings(res)) toast.warning(w);
      if (res.ids[0]) navigate({ to: "/test/$id", params: { id: res.ids[0] } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import tests.");
    }
  };

  const openAddMenu = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const res = await nativeMenu().popup({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
      coordinateSpace: "view",
      items: [
        { label: "Train manually", commandId: 1 },
        { label: "Generate from prompt", commandId: 4 },
        { type: "separator" },
        { label: "Select from files", commandId: 2 },
        { label: "From URL", commandId: 3 },
      ],
    });
    if (res.commandId === 1) setDialogOpen(true);
    else if (res.commandId === 4) setGenerateOpen(true);
    else if (res.commandId === 2) void importFromFiles();
    else if (res.commandId === 3) setGitDialogOpen(true);
  };

  return (
    <Rail
      // ONE RAIL, THREE JOBS. REDESIGN §7.1 gives it a third: on the Routines
      // screen it lists saved jobs instead of the library, the way Settings'
      // rail lists panes. It swaps rather than stacking — two lists in one rail
      // makes the rail a screen of its own, and what is navigated here is jobs.
      // Nothing is lost: the checklist's own rows still open a test.
      title={onRoutines ? "Routines" : "Library"}
      footer={<AiConnectionFooter />}
      actions={
        onRoutines ? (
          <ChromeButton label="New routine" onClick={newRoutine}>
            <Plus aria-hidden="true" />
          </ChromeButton>
        ) : (
          <ChromeButton label="Add test" onClick={openAddMenu}>
            <Plus aria-hidden="true" />
          </ChromeButton>
        )
      }
      nav={
        // OUTSIDE the scrolling body, structurally. The views used to be an
        // `mt-auto` block at the end of the library list, which pins them to
        // the bottom only while the library is SHORT — with more tests than
        // fit, Stats/Visual/Batch/Heals scrolled away with the list and the
        // app's own views became something you hunt for. See rail.tsx.
        <RailGroup label="Views">
          <RailRow
            icon={<BarChart3 aria-hidden="true" />}
            title="Stats"
            subtitle="Run history & logs"
            selected={pathname === "/stats"}
            onClick={() => navigate({ to: "/stats" })}
          />
          <RailRow
            icon={<Images aria-hidden="true" />}
            title="Visual"
            subtitle="Screenshot replay"
            selected={pathname === "/visual"}
            onClick={() => navigate({ to: "/visual" })}
          />
          <RailRow
            icon={<ListChecks aria-hidden="true" />}
            title="Routines"
            subtitle="Saved jobs"
            selected={pathname === "/batch"}
            onClick={() => navigate({ to: "/batch" })}
          />
          <RailRow
            icon={<Wand2 aria-hidden="true" />}
            title="Heals"
            subtitle="Locators Auto-Heal changed"
            selected={pathname === "/heals"}
            onClick={() => navigate({ to: "/heals" })}
          />
          {/* Only when the app is running from a git checkout of its own
              repository — never in a packaged build, never in the browser
              preview. Hidden rather than disabled: this is a tool for whoever
              is building the app, and a permanently greyed row would be a
              standing question for everyone else. */}
          {branchesAvailable ? (
            <BranchesRailRow
              selected={pathname === "/branches"}
              onOpenBranches={() => navigate({ to: "/branches" })}
            />
          ) : null}
        </RailGroup>
      }
    >
      {onRoutines ? (
        <RoutinesRail />
      ) : tests.length === 0 ? (
        <RailEmpty>
          No tests yet. Click + to train, generate, import, or clone your first one.
        </RailEmpty>
      ) : (
        <>
          {tests.map((t) => (
            <CustomContextMenu key={t.id}>
              <CustomContextMenuTrigger asChild>
                <RailRow
                  icon={<Favicon url={t.url} fromWeb={siteIconsFromWeb} />}
                  title={t.name}
                  subtitle={hostOf(t.url)}
                  selected={t.id === selectedId}
                  accessory={
                    <RowIndicators
                      sessions={sessionsByTest.get(t.id) ?? []}
                      verdict={verdictByTest.get(t.id)}
                    />
                  }
                  onClick={() => navigate({ to: "/test/$id", params: { id: t.id } })}
                />
              </CustomContextMenuTrigger>
              <CustomContextMenuContent>
                <CustomContextMenuItem onSelect={() => nativeShell().showItemInFolder(t.scriptPath)}>
                  <FolderOpen className="size-4" />
                  Reveal in Finder
                </CustomContextMenuItem>
                <CustomContextMenuItem onSelect={() => void startDuplicate(t)}>
                  <Copy className="size-4" />
                  Duplicate Test
                </CustomContextMenuItem>
                <CustomContextMenuSeparator />
                <CustomContextMenuItem
                  onSelect={async () => {
                    try {
                      await api.tests.setHidden(t.id, true);
                      qc.invalidateQueries({ queryKey: ["tests"] });
                      if (t.id === selectedId) navigate({ to: "/" });
                      toast.success("Removed from sidebar.");
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "Failed to remove test.");
                    }
                  }}
                >
                  <EyeOff className="size-4" />
                  Remove from Sidebar
                </CustomContextMenuItem>
                <CustomContextMenuItem onSelect={() => setTagsFor(t)}>
                  <Tag className="size-4" />
                  Edit Tags…
                </CustomContextMenuItem>
                <CustomContextMenuSeparator />
                <CustomContextMenuSub>
                  <CustomContextMenuSubTrigger value={TEST_SPEED_LABELS[t.speed ?? "fast"]}>
                    <Gauge className="size-4" />
                    Adjust Test Speed
                  </CustomContextMenuSubTrigger>
                  <CustomContextMenuSubContent>
                    <TestSpeedSlider test={t} />
                  </CustomContextMenuSubContent>
                </CustomContextMenuSub>
              </CustomContextMenuContent>
            </CustomContextMenu>
          ))}
        </>
      )}
      <NewRecordingDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <GenerateTestDialog open={generateOpen} onOpenChange={setGenerateOpen} />
      <ImportGitDialog open={gitDialogOpen} onOpenChange={setGitDialogOpen} />
      <DuplicateTestDialog
        testName={pendingCopy?.test.name ?? ""}
        warnings={pendingCopy?.warnings ?? []}
        open={pendingCopy !== null}
        busy={copying}
        onOpenChange={(o) => {
          if (!o && !copying) setPendingCopy(null);
        }}
        onConfirm={() => {
          if (pendingCopy) void duplicate(pendingCopy.test);
        }}
      />
      <TagsDialog
        test={tagsFor}
        open={tagsFor !== null}
        onOpenChange={(o) => {
          if (!o) setTagsFor(null);
        }}
      />
    </Rail>
  );
}
