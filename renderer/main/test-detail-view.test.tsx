// Component tests for the test detail view's run controls.
//
// This is where per-test preferences (browser, headless, capture, timeout) turn
// into an actual run. Each is stored per test with a fall-back to a global
// default, and each is persisted on change — so the failure modes are "my
// setting didn't stick" and, worse, "it ran with different settings than the
// ones on screen". The second is silent, which is why the run arguments are
// asserted rather than just the controls' appearance.

import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { RecorderSettings, RunRecord, Step, StepType, TestRecord } from "../lib/recorder-types";
import { TestDetailView, persistRunBrowser } from "./test-detail-view";
import { runSessionKey, useAiDebug, type AiDebugRunContext } from "./ai-debug-store";
import { withAiDebug } from "../__tests__/ai-debug-harness";
import { clearToastCalls, toastTexts } from "../__tests__/sonner-stub";
import { EditorView } from "./script-editor-cm";
import { isScriptDirty, markScriptDirty, resetScriptDirty } from "../lib/script-buffer";
import { SCRIPT_CHANGED_ON_DISK } from "../../shared/script-save.mjs";

let test_: TestRecord | null = null;
let settings: Partial<RecorderSettings> = {};
let runs: RunRecord[] = [];
// The route param, mutable so a test can model the sidebar switching tests.
// The router does NOT remount a route component when only its params change
// (no `remountDeps` on the route), so that switch is a re-render of the SAME
// component instance under a new id — which is where per-test state leaks.
let routeId = "t1";
// Records reachable by id, for those navigation tests. `test_` still answers
// for any id the map doesn't hold, so single-test suites are unaffected.
let library: Record<string, TestRecord> = {};
/** What `api.tests.flowUsage()` answers with — the tests calling this one. */
let flowUsage: { id: string; name: string }[] = [];
const unwrapFlow = vi.fn(async (_id: string, _stepId: string) => ({}) as TestRecord);
/** What `api.shopify.list()` answers with. Empty for every test that isn't
 *  about the signature chip, which is the state a machine with no Shopify
 *  store registered is in. */
let signatures: {
  id: string;
  host: string;
  expiresAt: number | null;
  createdAt: number | null;
  addedAt: number;
  state: "valid" | "expiring" | "expired" | "unknown" | "unreadable";
}[] = [];

const run = vi.fn();
/** The store's `start` — what "Edit in Trainer" and "Record here" call. */
const startRecording = vi.fn(async (_url: string, _name: string, _testId?: string) => {});
const setHeadless = vi.fn(async () => ({}) as TestRecord);
const setBrowser = vi.fn(async () => ({}) as TestRecord);
const setCaptureArtifacts = vi.fn(async () => ({}) as TestRecord);
const setHandlePopups = vi.fn(async () => ({}) as TestRecord);
const setTestTimeout = vi.fn(async () => ({}) as TestRecord);
/** What `useRecorder().runs` answers — empty unless a test models a run in
 *  progress, which is the one state that has to disable the run options. */
let recorderRuns: Record<string, unknown> = {};
// Typed with the real signature: the assertions below read BOTH arguments, and
// the difference between `""` and `null` in the second one is the difference
// between "clear it" and a value the backend refuses.
const setBaseUrl = vi.fn(async (_id: string, _baseUrl: string | null) => ({}) as TestRecord);
// Typed with the real signature, unlike the setters above: these assertions
// read the third argument, and a zero-arg mock makes indexing it a type error.
const updateSteps = vi.fn(
  async (_id: string, _steps: Step[], _opts?: { regenerate?: boolean }) => ({}) as TestRecord,
);
// The real `tests:updateScript` handler re-parses the spec and returns the
// record with a WHOLLY REBUILT step list — new ids and all. Tests that exercise
// the AI-apply path override this to model that; everything else keeps the
// inert default.
const updateScript = vi.fn(
  async (_id: string, _source: string, _origin?: unknown, _base?: string) => ({}) as TestRecord,
);
/** What `tests:checkScript` answers. Passes by default: most of this file is
 *  about what happens AFTER a save, and a save now goes through the check. */
/** What `tests:previewScript` answers. Nothing unmapped by default: the
 *  divergence question is asked only over NEW misses, and most saves have
 *  none. */
const previewScript = vi.fn(async (_id: string, _source: string) => ({
  tracked: true,
  steps: 1,
  skipped: 0,
  stepRanges: [] as { from: number; to: number }[],
  skippedRanges: [] as { from: number; to: number }[],
  newlySkipped: [] as string[],
}));
const getScript = vi.fn(async (_id: string) => "import { test } from '@playwright/test';");
/** The live page (a Playwright browser the editor owns). Closed unless a
 *  test opens it. */
let livePage: { open: boolean; url?: string; title?: string; picking?: boolean; closedReason?: string } = { open: false };
let proposals: import("../lib/recorder-types").PropagationEntry[] = [];
const livePageOpen = vi.fn(async (url: string, _browser?: string) => {
  livePage = { open: true, url, title: "Live" };
  return livePage;
});
const countMany = vi.fn(async (_locators: unknown[]) => [] as { count: number | null; error?: string }[]);
const highlightLocator = vi.fn(async (_locator: unknown) => {});
const pickLocator = vi.fn(async () => null as null | { expr: string; locator: unknown });
const setCursor = vi.fn(async (_index: number) => ({}));
const checkScript = vi.fn(async (_id: string, _source: string) => ({
  ok: true,
  errors: [] as { message: string; line?: number; column?: number; snippet?: string }[],
  tests: [] as { title: string; line: number }[],
  durationMs: 1,
}));
/** Models the real handler: it SAVES the flag and hands back the stored record,
 *  which is what keeps the banner down after the view reconciles. A mock that
 *  returned a bare object would let a purely optimistic implementation pass. */
const dismissDiverged = vi.fn(async (_id: string) => {
  test_ = { ...(test_ as TestRecord), stepsDivergedDismissed: true };
  return test_;
});

vi.mock("./recorder-store", () => ({
  // Mirrors the real store's contract: calling run() bumps runEpoch, which the
  // view watches to retire the new-step glow the moment a run starts.
  useRecorder: () => {
    const [epoch, setEpoch] = React.useState(0);
    return {
      runs: recorderRuns,
      run: (...a: unknown[]) => {
        run(...(a as []));
        setEpoch((e) => e + 1);
      },
      stopRun: vi.fn(),
      start: (...a: Parameters<typeof startRecording>) => startRecording(...a),
      runEpoch: epoch,
    };
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: routeId }),
}));

import { api } from "../lib/api";

vi.mock("./script-ai-panel", () => ({
  ScriptAiPanel: (props: { onApply: (next: string, meta: unknown) => void }) => (
    <button type="button" onClick={() => props.onApply("// by ai\n", { affordance: "inline-rewrite", provider: "ollama", model: "qwen", promptVersion: "inline-1" })}>
      Apply stub
    </button>
  ),
}));
vi.mock("../lib/api", () => ({
  api: {
    tests: {
      get: async (id: string) => library[id] ?? test_,
      getScript: (...a: Parameters<typeof getScript>) => getScript(...a),
      setHeadless: (...a: unknown[]) => setHeadless(...(a as [])),
      setBrowser: (...a: unknown[]) => setBrowser(...(a as [])),
      setCaptureArtifacts: (...a: unknown[]) => setCaptureArtifacts(...(a as [])),
      setHandlePopups: (...a: unknown[]) => setHandlePopups(...(a as [])),
      setTestTimeout: (...a: unknown[]) => setTestTimeout(...(a as [])),
      setBaseUrl: (...a: Parameters<typeof setBaseUrl>) => setBaseUrl(...a),
      remove: async () => {},
      rename: async () => ({}) as TestRecord,
      flowUsage: async () => flowUsage,
      unwrapFlow: (...a: Parameters<typeof unwrapFlow>) => unwrapFlow(...a),
      updateScript: (...a: Parameters<typeof updateScript>) => updateScript(...a),
      checkScript: (...a: Parameters<typeof checkScript>) => checkScript(...a),
      previewScript: (...a: Parameters<typeof previewScript>) => previewScript(...a),
      updateSteps: (...a: Parameters<typeof updateSteps>) => updateSteps(...a),
      dismissDiverged: (...a: Parameters<typeof dismissDiverged>) => dismissDiverged(...a),
    },
    recorder: {
      getSettings: async () => settings as RecorderSettings,
      setCursor: (...a: Parameters<typeof setCursor>) => setCursor(...a),
    },
    livePage: {
      status: async () => livePage,
      open: (...a: Parameters<typeof livePageOpen>) => livePageOpen(...a),
      close: async () => {
        livePage = { open: false };
      },
      countMany: (...a: Parameters<typeof countMany>) => countMany(...a),
      highlight: (...a: Parameters<typeof highlightLocator>) => highlightLocator(...a),
      pick: (...a: Parameters<typeof pickLocator>) => pickLocator(...a),
      cancelPick: async () => {},
    },
    runs: {
      // Returns a REAL summary on purpose: the toolbar must not render the old
      // "(adds ~…)" hint even when overhead data exists to show. With a null
      // here, the absence assertion below would pass vacuously.
      captureOverhead: async () => ({
        capturedRuns: 3,
        meanCaptureMs: 1400,
        meanMsPerShot: 200,
        meanCapturedDurationMs: 9000,
        meanUncapturedDurationMs: 7600,
        captureShareOfRun: 0.18,
      }),
      list: async () => runs,
    },
    heals: { list: async () => [] },
    propagation: { list: async () => proposals },
    shopify: { list: async () => signatures },
    artifacts: { getReplay: async () => null },
    aiDebug: {
      list: async () => [],
      save: async (s: unknown) => s,
      remove: async () => ({ removed: 0 }),
      clear: async () => ({ removed: 0 }),
      notifyDone: async () => ({ ok: true }),
      history: async () => [],
      record: async (r: unknown) => r,
    },
    ts: {
      ensure: async () => ({ available: false, reason: "no service in tests" }),
      status: async () => ({ available: false, reason: "no service in tests" }),
      update: async () => {},
      close: async () => {},
      diagnostics: async () => [],
      completions: async () => [],
      hover: async () => null,
      inspections: async () => [],
      format: async () => [],
    },
    llm: {
      getConfig: async () => ({ provider: "ollama", model: null, baseUrls: {} }),
      status: async () => ({ online: false, models: [] }),
      setConfig: async () => ({}),
      chat: async () => ({ requestId: "req-test" }),
      cancel: async () => {},
      isActive: async () => ({ active: false }),
    },
    on: () => () => {},
  },
}));

function record(over: Partial<TestRecord> = {}): TestRecord {
  return {
    id: "t1",
    name: "Checkout",
    url: "https://example.com",
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    scriptPath: "/tmp/t1.spec.ts",
    ...over,
  } as TestRecord;
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>{withAiDebug(<TestDetailView />)}</QueryClientProvider>
  );
  const result = render(tree());
  return {
    ...result,
    /** What clicking another test in the sidebar does: same component instance,
     *  new route param. Deliberately NOT a fresh render — remounting would hide
     *  exactly the state-leak this models. */
    renavigate(id: string) {
      routeId = id;
      result.rerender(tree());
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  test_ = record();
  routeId = "t1";
  library = {};
  runs = [];
  recorderRuns = {};
  proposals = [];
  signatures = [];
  flowUsage = [];
  settings = {
    defaultRunBrowser: "chromium",
    defaultRunHeadless: false,
    defaultCaptureArtifacts: false,
    defaultTestTimeoutMs: 60_000,
  };
});

describe("the Accessibility tab", () => {
  it("sits after Heals, so the run-related tabs stay together", async () => {
    // Placement is the whole request: it belongs beside Heals, not buried at
    // the front where it would push Steps and Script along. Scoped to the
    // detail strip — the run panel below carries its own tablist (Console /
    // Step details / History), whose tabs would otherwise read as "last".
    renderView();
    await screen.findAllByRole("tab");
    const strip = document.querySelector(".gl-detail-tabs") as HTMLElement;
    const names = within(strip)
      .getAllByRole("tab")
      .map((t) => t.textContent);
    expect(names[names.length - 1]).toMatch(/Accessibility/);
    expect(names[names.length - 2]).toMatch(/Heals/);
  });

  it("badges the unaccepted count from the most recent CHECKED run", async () => {
    // A later run with the toggle off must not clear the badge — the user
    // would read a cleared badge as the issues having been fixed.
    runs = [
      { id: "r2", testId: "t1", startedAt: 2_000 } as RunRecord,
      { id: "r1", testId: "t1", startedAt: 1_000, a11yChecks: 4, a11yNewSteps: 3 } as RunRecord,
    ];
    renderView();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Accessibility \(3\)/ })).toBeTruthy(),
    );
  });

  it("carries no count when nothing is unaccepted", async () => {
    runs = [{ id: "r1", testId: "t1", startedAt: 1_000, a11yChecks: 4 } as RunRecord];
    renderView();
    const tab = await screen.findByRole("tab", { name: /Accessibility/ });
    expect(tab.textContent).toBe("Accessibility");
  });

  it("is not offered for an imported test", async () => {
    // The check runs from the capture fixture, which an imported spec never
    // loads — the tab could only ever be empty.
    test_ = record({ sourceDir: "/imported/project" });
    renderView();
    await screen.findByText("Checkout");
    expect(screen.queryByRole("tab", { name: /Accessibility/ })).toBeNull();
  });
});

describe("run controls", () => {
  it("shows the test name", async () => {
    renderView();
    expect(await screen.findByText("Checkout")).toBeTruthy();
  });

  it("falls back to the global default browser for a test with no preference", async () => {
    settings = { ...settings, defaultRunBrowser: "webkit" };
    renderView();
    await screen.findByText("Checkout");
    expect(await screen.findByText("WebKit")).toBeTruthy();
  });

  it("prefers the test's own saved browser over the global default", async () => {
    test_ = record({ runBrowser: "firefox" });
    settings = { ...settings, defaultRunBrowser: "webkit" };
    renderView();
    await screen.findByText("Checkout");
    expect(await screen.findByText("Firefox")).toBeTruthy();
  });

  it("leaves the trigger's glyph to the Select, so only one icon shows", async () => {
    // SelectValue already draws the selected item's `icon` — the SF Symbol on
    // the SelectItem. Drawing our own lucide glyph beside it put TWO browser
    // icons on a control whose whole job is to name one engine.
    test_ = record({ runBrowser: "firefox" });
    renderView();
    await screen.findByText("Checkout");
    const trigger = screen.getByRole("combobox", { name: /browser engine for this test/i });
    expect(trigger.querySelectorAll("[data-browser]").length).toBe(0);
    expect(trigger.textContent).toContain("Firefox");
  });

  it("re-seeds the controls when the route moves to another test", async () => {
    // The bug this pins: the picker kept the engine of the test viewed BEFORE
    // this one, so the sidebar row said Chromium while the picker said Firefox
    // — for the same test. The route component is never remounted on an id
    // change, so a one-shot "already initialised" latch never fires again.
    library = {
      t1: record({ runBrowser: "firefox", testTimeoutMs: 120_000 }),
      t2: record({ id: "t2", name: "Search", runBrowser: "chromium" }),
    };
    const view = renderView();
    await screen.findByText("Firefox");

    view.renavigate("t2");

    await screen.findByText("Search");
    const trigger = screen.getByRole("combobox", { name: /browser engine for this test/i });
    await waitFor(() => expect(trigger.textContent).toContain("Chromium"));
    expect(trigger.textContent).not.toContain("Firefox");
    // Every per-test control seeds from the same latch, so they all leaked.
    expect((screen.getByLabelText(/per-test timeout/i) as HTMLInputElement).value).toBe("");
  });

  it("persists a headless change", async () => {
    renderView();
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByLabelText(/run this test headless/i));
    await waitFor(() => expect(setHeadless).toHaveBeenCalledWith("t1", true));
  });

  it("persists a capture change", async () => {
    renderView();
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByLabelText(/capture screenshots/i));
    await waitFor(() => expect(setCaptureArtifacts).toHaveBeenCalledWith("t1", true));
  });

  it("persists a per-test timeout override in milliseconds", async () => {
    renderView();
    await screen.findByText("Checkout");
    const input = screen.getByLabelText(/per-test timeout/i) as HTMLInputElement;
    // Empty = use Settings default; placeholder shows that default in seconds.
    expect(input.placeholder).toBe("60");
    fireEvent.change(input, { target: { value: "180" } });
    await waitFor(() => expect(setTestTimeout).toHaveBeenCalledWith("t1", 180_000));
  });

  it("clears the timeout override when the field is emptied", async () => {
    test_ = record({ testTimeoutMs: 120_000 });
    renderView();
    await screen.findByText("Checkout");
    const input = screen.getByLabelText(/per-test timeout/i) as HTMLInputElement;
    expect(input.value).toBe("120");
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(setTestTimeout).toHaveBeenCalledWith("t1", null));
  });

  it("steps the timeout in single seconds", async () => {
    // A 5-second stepper made "47s" unreachable from the arrows; the input
    // now moves one second at a time.
    renderView();
    await screen.findByText("Checkout");
    const input = screen.getByLabelText(/per-test timeout/i) as HTMLInputElement;
    expect(input.step).toBe("1");
  });

  it("persists a timeout that is not a multiple of five", async () => {
    // Pins that loosening the stepper wasn't undone by re-rounding in the
    // change handler: 7 must persist as 7000, not snap to 5 or 10.
    renderView();
    await screen.findByText("Checkout");
    const input = screen.getByLabelText(/per-test timeout/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "7" } });
    await waitFor(() => expect(setTestTimeout).toHaveBeenCalledWith("t1", 7_000));
  });

  it("still clamps a sub-floor timeout up to 5 seconds", async () => {
    // The finer stepper must not have loosened the floor from run-pacing.
    renderView();
    await screen.findByText("Checkout");
    const input = screen.getByLabelText(/per-test timeout/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3" } });
    await waitFor(() => expect(setTestTimeout).toHaveBeenCalledWith("t1", 5_000));
  });

  it("never shows the capture-overhead hint, even when overhead data exists", async () => {
    // The api mock above returns a real overhead summary, so this fails
    // against any code that renders the old "(adds ~1.4 s, 18%)" label.
    renderView();
    await screen.findByText("Checkout");
    await screen.findByLabelText(/capture screenshots/i);
    expect(screen.queryByText(/adds ~/)).toBeNull();
  });

  // The head is ONE row: what the test IS on the left, everything that acts on
  // it on the right.
  //
  // It used to be two — `Toolbar` stacks its content over its actions — and
  // both lines half-filled their own: the name ran out a third of the way
  // across while the controls sat under an empty gutter, and the band spent
  // 94px saying what fits in 54.
  //
  // WHAT THIS TEST OWNS IS THE STRUCTURE, NOT THE GEOMETRY. Whether the row
  // actually wraps at a narrow window, and what gives when it does, is CSS that
  // `check:narrow-layout` reads from the stylesheet — it has to, because jsdom
  // has no layout engine and the dom project runs with `css: false`, so nothing
  // measured here would be measuring anything. What jsdom CAN answer is the
  // half the stylesheet cannot: that the identity and the controls are siblings
  // on one row rather than two stacked boxes, and that every control the
  // toolbar owns is inside the group the rules right-align. A control that
  // escapes back out to the toolbar's own level would still render — just no
  // longer aligned with the others, and no longer wrapping with them.
  it("lays the identity and the controls out as one row", async () => {
    renderView();
    await screen.findByText("Checkout");
    const row = document.querySelector(".gl-detail-head-row");
    expect(row).not.toBeNull();
    const ident = row!.querySelector(".gl-detail-ident");
    const tools = row!.querySelector(".gl-detail-tools");
    // Siblings, in this order — not one nested in the other, and not stacked by
    // `Toolbar`'s own column.
    expect(ident?.parentElement).toBe(row);
    expect(tools?.parentElement).toBe(row);
    expect(ident!.compareDocumentPosition(tools!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The name and the URL are the identity; both are inside it.
    expect(ident!.textContent).toContain("Checkout");
    expect(ident!.textContent).toContain("https://example.com");
  });

  it("keeps every control inside the right-aligned group", async () => {
    renderView();
    await screen.findByText("Checkout");
    const tools = document.querySelector(".gl-detail-tools") as HTMLElement | null;
    expect(tools).not.toBeNull();
    for (const el of [
      screen.getByRole("button", { name: /edit test/i }),
      screen.getByLabelText("Delete test"),
      screen.getByRole("combobox", { name: /browser engine for this test/i }),
      screen.getByLabelText(/per-test timeout/i),
      screen.getByLabelText(/run this test headless/i),
      screen.getByLabelText(/capture screenshots on this run/i),
      screen.getByLabelText(/record console and network/i),
      screen.getByLabelText(/check accessibility/i),
      screen.getByLabelText(/handle pop-ups on this run/i),
      screen.getByRole("button", { name: /^run test$/i }),
    ]) {
      expect(tools!.contains(el)).toBe(true);
    }
  });

  it("stacks the run toggles as one two-column block", async () => {
    renderView();
    await screen.findByText("Checkout");
    const block = screen
      .getByLabelText(/run this test headless/i)
      .closest(".gl-run-options") as HTMLElement | null;
    expect(block).not.toBeNull();
    // The TRACK SIZING moved into `.gl-run-options` (screens.css) in B5a, and
    // `check:narrow-layout` reads it from the stylesheet — it has to, because
    // the dom project runs with `css: false` and there is no computed grid
    // geometry here to measure. What this test still owns is the other half,
    // which the stylesheet cannot answer: that all four toggles are actually
    // INSIDE the block. A checkbox that escapes the grid breaks the
    // gang-of-four layout while every CSS assertion stays green.
    expect(block!.className).not.toContain("grid-cols-2");
    // Every toggle lives in the same block — a checkbox that escapes the grid
    // silently breaks the layout without failing anything. Handle pop-ups is
    // the fifth, and the one most likely to have been bolted on outside.
    for (const label of [
      /capture screenshots on this run/i,
      /record console and network/i,
      /check accessibility/i,
      /handle pop-ups on this run/i,
    ]) {
      expect(block!.contains(screen.getByLabelText(label))).toBe(true);
    }
  });
});

// The "Handle pop-ups" run option.
//
// The fifth toggle, and the first that defaults ON: the standing overlay rules
// were always armed before it existed, so "unset" has to keep meaning armed or
// every taught rule goes silently quiet the day the box ships. Three seeds are
// pinned separately because each is a different fall-through, and the last —
// true with NOTHING stored anywhere — is the one a lazy `?? false` gets wrong
// without any test noticing, since the view renders either way.
//
// It is persisted and NOT passed to `run()`: the runner reads the record, the
// way it reads `recordLogs`, so the unattended runner and the app cannot answer
// the question differently for the same test.
describe("the Handle pop-ups run option", () => {
  /** The box, once the view has seeded its toggles from the record. Waits on
   *  the headless box the way `captureBoxAfterInit` does — the record pins
   *  headless ON so there is a transition to wait for — because the pop-ups
   *  box's own initial state is `true`, and an assertion of "checked" made
   *  before the seed lands would pass against the un-seeded default. */
  async function popupsBoxAfterInit() {
    await screen.findByText("Checkout");
    const headless = screen.getByLabelText(/run this test headless/i);
    await waitFor(() => expect(headless.getAttribute("data-state")).toBe("checked"));
    return screen.getByLabelText(/handle pop-ups on this run/i);
  }

  it("seeds from the record when the test has decided", async () => {
    test_ = record({ runHeadless: true, handlePopups: false });
    settings = { ...settings, defaultHandlePopups: true };
    renderView();
    const box = await popupsBoxAfterInit();
    expect(box.getAttribute("data-state")).toBe("unchecked");
  });

  it("seeds from the global default when the record is silent", async () => {
    test_ = record({ runHeadless: true });
    settings = { ...settings, defaultHandlePopups: false };
    renderView();
    const box = await popupsBoxAfterInit();
    expect(box.getAttribute("data-state")).toBe("unchecked");
  });

  it("is on when neither the record nor the settings say anything", async () => {
    // A settings file from before the key existed. Off here would switch every
    // taught rule off for a user who never touched anything.
    test_ = record({ runHeadless: true });
    settings = { ...settings, defaultHandlePopups: undefined };
    renderView();
    const box = await popupsBoxAfterInit();
    expect(box.getAttribute("data-state")).toBe("checked");
  });

  it("persists a change on the record, and does not pass it to run()", async () => {
    test_ = record({ runHeadless: true });
    renderView();
    const box = await popupsBoxAfterInit();
    fireEvent.click(box);
    await waitFor(() => expect(setHandlePopups).toHaveBeenCalledWith("t1", false));
    expect(box.getAttribute("data-state")).toBe("unchecked");

    fireEvent.click(screen.getByRole("button", { name: /^run test$/i }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    // run(id, captureArtifacts, headless, browser, speed), exhaustively — the
    // record carries the choice, so a sixth argument carrying it too is the
    // regression this exists to catch (the runner would then have two answers).
    expect(run).toHaveBeenCalledWith("t1", false, true, "chromium", undefined);
  });

  it("is disabled while this test is running", async () => {
    recorderRuns = {
      t1: { lines: [], running: true, code: null, stepStatus: {}, startedAt: 0 },
    };
    renderView();
    await screen.findByText("Checkout");
    const box = screen.getByLabelText(/handle pop-ups on this run/i);
    await waitFor(() =>
      expect(box.getAttribute("data-disabled") ?? box.getAttribute("disabled")).not.toBeNull(),
    );
  });
});

// The Base URL field, on the toolbar of an IMPORTED test.
//
// An imported suite navigates relatively (`page.goto("/")`) and resolves that
// against its own project's `use.baseURL`. Import reads that config, but a
// config can compute the value rather than write it down — and then this field
// is the only repair, so what it persists is what decides whether the test can
// run at all. Two silent shapes are pinned here: a value that looks saved and
// wasn't, and a rejected value left on screen as if it had been accepted.
describe("the Base URL field", () => {
  const LABEL = /Base URL that this imported test/i;

  beforeEach(() => {
    clearToastCalls();
  });

  /** The field, after the toolbar has seeded it from the record.
   *
   *  The seed runs in an effect, so the input exists — empty — before it lands.
   *  Reading it without waiting races that effect and reports the pre-seeded
   *  empty string, which is also what a blur would then try to persist. */
  async function seededField(expected: string): Promise<HTMLInputElement> {
    const input = (await screen.findByLabelText(LABEL)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(expected));
    return input;
  }

  it("is not offered for a recorded test", async () => {
    // A recorded test navigates to the absolute URL the recorder watched, so
    // the box would do nothing at all.
    renderView();
    await screen.findByText("Checkout");
    // Anchor on a sibling control of the same toolbar: without it the absence
    // assertion passes against a toolbar that simply hasn't rendered yet.
    await screen.findByLabelText(/per-test timeout/i);
    expect(screen.queryByLabelText(LABEL)).toBeNull();
  });

  it("shows an imported test's stored base URL", async () => {
    test_ = record({ sourceDir: "/imported/project", baseUrl: "https://staging.example.com/" });
    renderView();
    await screen.findByText("Checkout");
    await seededField("https://staging.example.com/");
  });

  it("persists on blur, and not on a keystroke", async () => {
    // Deliberate: a URL is invalid for most of the time it is being typed, and
    // the backend refuses anything that isn't a full http(s) address — so a
    // per-keystroke persist is an error toast per character.
    test_ = record({ sourceDir: "/imported/project" });
    renderView();
    const input = await seededField("");

    fireEvent.change(input, { target: { value: "https://staging.example.com" } });
    // Flush effects and microtasks, so a persist scheduled off the change
    // rather than fired inline is still caught here.
    await act(async () => {});
    expect(setBaseUrl).not.toHaveBeenCalled();

    fireEvent.blur(input);
    await waitFor(() =>
      expect(setBaseUrl).toHaveBeenCalledWith("t1", "https://staging.example.com"),
    );
    expect(setBaseUrl).toHaveBeenCalledTimes(1);
  });

  it("clears the base URL when the field is emptied", async () => {
    // `null`, not `""`. The handler treats the empty string as "not a URL" and
    // throws, so a field emptied by the user would fail to clear and revert.
    test_ = record({ sourceDir: "/imported/project", baseUrl: "https://staging.example.com/" });
    renderView();
    const input = await seededField("https://staging.example.com/");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    await waitFor(() => expect(setBaseUrl).toHaveBeenCalledWith("t1", null));
  });

  it("writes nothing when the field is blurred unedited", async () => {
    // Tabbing through the toolbar must not re-persist — and, more to the point,
    // must not invalidate the record's cache for no reason.
    test_ = record({ sourceDir: "/imported/project", baseUrl: "https://staging.example.com/" });
    renderView();
    const input = await seededField("https://staging.example.com/");

    fireEvent.blur(input);
    await act(async () => {});
    expect(setBaseUrl).not.toHaveBeenCalled();
  });

  it("reverts and says so when the backend refuses the URL", async () => {
    // The silent failure this pins: the refusal is swallowed, the typed text
    // stays on screen, and the user reads the run's next "no base URL" refusal
    // as the app ignoring a setting they can see.
    test_ = record({ sourceDir: "/imported/project", baseUrl: "https://staging.example.com/" });
    setBaseUrl.mockRejectedValueOnce(new Error("not a base URL"));
    renderView();
    const input = await seededField("https://staging.example.com/");

    fireEvent.change(input, { target: { value: "staging.example.com" } });
    fireEvent.blur(input);

    await waitFor(() => expect(setBaseUrl).toHaveBeenCalledWith("t1", "staging.example.com"));
    await waitFor(() => expect(input.value).toBe("https://staging.example.com/"));
    // A toast is recorded as a CALL and never rendered by the stub, so this is
    // the only place the message exists to be asserted on.
    const errors = toastTexts().filter((t) => t.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].title).toMatch(/base URL/i);
  });
});

describe("persisting the browser choice", () => {
  // The Select is native-menu-backed — its options are drawn by AppKit and
  // never enter the DOM — so the change cannot be driven through the trigger
  // in jsdom. The handler behind it is exported and called directly instead.

  it("refreshes every cached copy of the record it just changed", async () => {
    // The ["tests"] list holds its own copy of the record and nothing else in
    // this flow refetches it, so without this the cache keeps the engine the
    // test USED to run on until something unrelated happens to refresh it.
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    await persistRunBrowser(qc, "t1", "firefox");
    expect(setBrowser).toHaveBeenCalledWith("t1", "firefox");
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["tests"]));
    expect(keys).toContain(JSON.stringify(["test", "t1"]));
  });

  it("refreshes nothing when the write failed", async () => {
    // Nothing on disk changed, so there is nothing to re-read — and the run
    // still uses the on-screen choice, which is why this stays best-effort.
    setBrowser.mockRejectedValueOnce(new Error("read-only volume"));
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    await persistRunBrowser(qc, "t1", "firefox");
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("running", () => {
  it("runs with the settings shown on screen", async () => {
    // The silent failure this guards: controls say one thing, the run uses
    // another. run(id, captureArtifacts, headless, browser).
    test_ = record({ runBrowser: "firefox", runHeadless: true });
    renderView();
    await screen.findByText("Checkout");
    await screen.findByText("Firefox");

    fireEvent.click(screen.getByRole("button", { name: /run test/i }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const [id, , headless, browser] = run.mock.calls[0];
    expect(id).toBe("t1");
    expect(headless).toBe(true);
    expect(browser).toBe("firefox");
  });

  it("passes the capture flag through", async () => {
    test_ = record({ captureArtifacts: true });
    renderView();
    await screen.findByText("Checkout");

    fireEvent.click(screen.getByRole("button", { name: /run test/i }));

    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls[0][1]).toBe(true);
  });

  /** The capture checkbox, once the view has finished seeding its toggles from
   *  the record. Without waiting for that, an assertion races the one-shot init
   *  effect and passes against the pre-initialised state — which is exactly how
   *  the first version of these tests passed with the bug still in place. */
  async function captureBoxAfterInit() {
    await screen.findByText("Checkout");
    const headless = screen.getByLabelText(/run this test headless/i);
    await waitFor(() => expect(headless.getAttribute("data-state")).toBe("checked"));
    return screen.getByLabelText(/capture screenshots/i);
  }

  it("leaves capture enabled while headless is on", async () => {
    // These used to be coupled, on the assumption that screenshots of an
    // invisible browser aren't useful. They are: headless Chromium renders to
    // an offscreen surface and page.screenshot() works identically — it's how
    // visual regression testing is normally done, and headless avoids the
    // window chrome and focus rings that make headed baselines noisy.
    test_ = record({ runHeadless: true });
    renderView();
    const capture = await captureBoxAfterInit();
    expect(capture.getAttribute("data-disabled") ?? capture.getAttribute("disabled")).toBeNull();
  });

  it("shows capture as ticked while headless is on, rather than lying about it", async () => {
    // The old UI forced the box to render unticked under headless while still
    // passing the SAVED value to the run — so a test with both flags captured
    // anyway and the checkbox said otherwise. Displayed state has to match what
    // actually runs.
    test_ = record({ runHeadless: true, captureArtifacts: true });
    renderView();
    const capture = await captureBoxAfterInit();
    expect(capture.getAttribute("data-state")).toBe("checked");
  });

  it("can toggle capture on while headless is on", async () => {
    // Guards the third part of the old coupling: a click handler that returned
    // early under headless, so the box could not be ticked at all.
    test_ = record({ runHeadless: true, captureArtifacts: false });
    renderView();
    const capture = await captureBoxAfterInit();
    fireEvent.click(capture);
    await waitFor(() => expect(setCaptureArtifacts).toHaveBeenCalledWith("t1", true));
  });

});

describe("diverged steps warning", () => {
  it("warns when the script has statements the parser couldn't map", async () => {
    test_ = record({ stepsDiverged: true });
    renderView();
    expect(await screen.findByText(/may not reflect the script/i)).toBeTruthy();
  });

  it("stays quiet when steps and script agree", async () => {
    renderView();
    await screen.findByText("Checkout");
    expect(screen.queryByText(/may not reflect the script/i)).toBeNull();
  });

  it("says so plainly when the saved steps were never put into the script", async () => {
    // Different cause, different fix: this one is undone by regenerating, and
    // the parse-failure wording ("couldn't be parsed back into steps") would
    // send the user looking for a problem in their script instead.
    test_ = record({ stepsDiverged: true, stepsDivergedReason: "unapplied" });
    renderView();
    expect(await screen.findByText(/saved without regenerating/i)).toBeTruthy();
    expect(screen.queryByText(/couldn't be parsed back into steps/i)).toBeNull();
  });

  it("can be waved off, and says so to the backend", async () => {
    test_ = record({ stepsDiverged: true });
    renderView();
    await screen.findByText(/may not reflect the script/i);
    fireEvent.click(screen.getByLabelText("Dismiss this warning"));
    // Both halves matter. The banner has to go NOW — the click is an
    // acknowledgement, and one that leaves the warning up reads as broken — and
    // it has to be recorded, or it comes back on the next visit.
    await waitFor(() => expect(screen.queryByText(/may not reflect the script/i)).toBeNull());
    expect(dismissDiverged).toHaveBeenCalledWith("t1");
  });

  it("stays quiet for a divergence already dismissed", async () => {
    // The persisted half: the record is STILL diverged, and that is correct —
    // everything else that reads the flag must keep saying so. Only the banner
    // is silenced.
    test_ = record({ stepsDiverged: true, stepsDivergedDismissed: true });
    renderView();
    await screen.findByText("Checkout");
    expect(screen.queryByText(/may not reflect the script/i)).toBeNull();
  });

  it("doesn't tell an imported test to regenerate, which it can never do", async () => {
    // The fix the warning names has to exist. "Choose Regenerate script" sends
    // the user to a button this path never shows.
    test_ = record({
      stepsDiverged: true,
      stepsDivergedReason: "unapplied",
      sourceDir: "/imported/project",
    });
    renderView();
    expect(await screen.findByText(/never regenerated from steps/i)).toBeTruthy();
    expect(screen.queryByText(/Regenerate script/i)).toBeNull();
  });
});

// "Edit Steps" against a script that is NOT generated from the steps.
//
// The bug this covers was a total silent no-op: the steps saved, the Steps tab
// updated, and the .spec.ts that runs was untouched with nothing on screen
// saying so. The fix is a question at save time, so what's asserted is that the
// question is asked AND that each answer reaches the backend intact — a dialog
// whose buttons both send the same flag looks right and changes nothing.
describe("editing steps when the script isn't generated from them", () => {
  /** Open "Edit Test" → "Edit Steps" and hand back the editor's Save button.
   *
   *  The SDK's DropdownMenu is native-menu-backed, like its Select: the items
   *  render to `null` and are handed to `glazeAPI.Menu.popup`, which answers
   *  with the chosen commandId. So the menu is driven by standing in for the
   *  native popup, not by clicking a DOM node that never exists. */
  async function openStepEditor() {
    (window as unknown as { glazeAPI: { Menu: { popup: unknown } } }).glazeAPI.Menu.popup = vi.fn(
      async (opts: { items: { label?: string; commandId?: number }[] }) => {
        const item = opts.items.find((i) => i.label === "Edit Steps");
        // Not found means the entry was renamed or dropped — answer "nothing
        // chosen" rather than a wrong commandId, so the test fails on the
        // missing editor instead of silently invoking another menu entry.
        return item?.commandId === undefined ? {} : { commandId: item.commandId };
      },
    );
    renderView();
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByRole("button", { name: /edit test/i }));
    return await screen.findByRole("button", { name: "Save" });
  }

  it("saves and regenerates without a question when the script is generated from steps", async () => {
    test_ = record();
    fireEvent.click(await openStepEditor());

    await waitFor(() => expect(updateSteps).toHaveBeenCalledTimes(1));
    expect(updateSteps.mock.calls[0][2]).toEqual({ regenerate: false });
    expect(screen.queryByText(/Apply these steps to the script/i)).toBeNull();
  });

  it("asks instead of quietly saving steps the script will never run", async () => {
    test_ = record({ scriptEdited: true });
    fireEvent.click(await openStepEditor());

    expect(await screen.findByText(/Apply these steps to the script/i)).toBeTruthy();
    // Nothing is written until the question is answered — the old behaviour
    // saved here and returned as if the edit had taken effect.
    expect(updateSteps).not.toHaveBeenCalled();
  });

  it("applies the steps to the script when the user asks for that", async () => {
    test_ = record({ scriptEdited: true });
    fireEvent.click(await openStepEditor());
    fireEvent.click(await screen.findByRole("button", { name: /regenerate script/i }));

    await waitFor(() => expect(updateSteps).toHaveBeenCalledTimes(1));
    expect(updateSteps.mock.calls[0][2]).toEqual({ regenerate: true });
  });

  it("leaves the script alone when the user asks for that", async () => {
    test_ = record({ scriptEdited: true });
    fireEvent.click(await openStepEditor());
    fireEvent.click(await screen.findByRole("button", { name: /save steps only/i }));

    await waitFor(() => expect(updateSteps).toHaveBeenCalledTimes(1));
    expect(updateSteps.mock.calls[0][2]).toEqual({ regenerate: false });
  });

  it("never offers to regenerate an imported test's spec", async () => {
    // Offering it would be a lie twice over: the backend refuses, and doing it
    // would replace a file whose sibling imports a generated spec can't carry.
    test_ = record({ scriptEdited: true, sourceDir: "/imported/project" });
    fireEvent.click(await openStepEditor());

    expect(await screen.findByText(/Save steps without changing the script/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /regenerate script/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^save steps$/i }));
    await waitFor(() => expect(updateSteps).toHaveBeenCalledTimes(1));
    expect(updateSteps.mock.calls[0][2]).toEqual({ regenerate: false });
  });
});

// --------------------------------------------------------------------------
// Applying an AI-debug fix, seen from the Steps tab.
//
// The failure this whole block exists for is silent by construction. Applying
// a fix goes through `tests:updateScript`, which re-parses the spec and swaps
// the step list out underneath the view — and the parser mints a fresh id for
// EVERY step each time it runs. So "which steps did that change?" cannot be
// answered by id, the step rows all remount, and a view that got this wrong
// would look completely normal: right steps, right order, no error, just no
// indication that anything happened. The user walks away from a change they
// asked for without seeing it.
// --------------------------------------------------------------------------

let stepSeq = 0;
/** A step carrying a deliberately throwaway id, the way the spec parser emits
 *  them — never reused across a re-parse. */
function mkStep(partial: Partial<Step> & { type: StepType }): Step {
  stepSeq += 1;
  return { id: `s${stepSeq}`, timestamp: stepSeq, ...partial } as Step;
}

const BTN = { k: "role", role: "button", name: "Submit" } as const;
const ALT = { k: "role", role: "button", name: "Continue" } as const;

/** Re-mint ids, as the backend re-parse does. Anything comparing by id sees a
 *  wholly different list; anything comparing by content sees no change. */
function reparsed(steps: Step[]): Step[] {
  return steps.map((s) => ({ ...s, id: `p${(stepSeq += 1)}` }));
}

/** Reaches the same `onApplyScript` the AI debug panel's Apply button calls.
 *
 *  The panel route would need a streamed model response carrying a fenced code
 *  block to get there, which tests the LLM plumbing rather than this view. The
 *  context object is the actual seam between the two, so the test grabs that
 *  and leaves the panel out of it. */
function renderWithApply() {
  const aiKey = runSessionKey("t1");
  let apply: ((source: string) => Promise<void>) | null = null;

  function Probe() {
    const aiDebug = useAiDebug();
    React.useEffect(() => {
      // A session must exist for the view to attach its context to — that is
      // the real precondition in the app, where Apply is only reachable from
      // an open session.
      aiDebug.openSession({
        key: aiKey,
        kind: "run",
        testId: "t1",
        label: "Checkout",
        testName: "Checkout",
        runKey: null,
        context: { kind: "run", testName: "Checkout", testUrl: "https://example.com" } as AiDebugRunContext,
      });
      // Once only: re-opening on every render would churn the store.
    }, []);
    apply = (source: string) => {
      const ctx = aiDebug.getContext(aiKey) as AiDebugRunContext | null;
      if (!ctx?.onApplyScript) throw new Error("the view never attached an apply handler");
      return ctx.onApplyScript(source);
    };
    return null;
  }

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      {withAiDebug(
        <>
          <TestDetailView />
          <Probe />
        </>,
      )}
    </QueryClientProvider>,
  );
  return {
    ...utils,
    apply: async (source: string) => {
      if (!apply) throw new Error("probe never rendered");
      await act(async () => {
        await apply!(source);
      });
    },
  };
}

/** Switch tabs. Radix's TabsTrigger activates on pointer-down/focus rather
 *  than a bare click, so fireEvent.click alone leaves the tab unchanged — and
 *  the test then asserts against the PREVIOUS tab's content. */
function selectTab(name: RegExp) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.focus(tab);
  fireEvent.click(tab);
  return tab;
}

/** Replace the editor's document the way typing would: through the view.
 *  A CodeMirror content element is contenteditable, so `fireEvent.change`
 *  reaches nothing. */
function setDraft(content: HTMLElement, text: string): void {
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("no EditorView behind the textbox");
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  });
}

/** The editor stays mounted read-only after a save or a cancel; "closed"
 *  means it stopped taking edits and the Edit button is back. */
async function editorClosed(): Promise<void> {
  await screen.findByRole("button", { name: "Edit script" });
  await waitFor(() => expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe("false"));
}

/** What the editor currently shows. */
function draftText(): string {
  const content = document.querySelector(".cm-content") as HTMLElement | null;
  const view = content ? EditorView.findFromDOM(content) : null;
  return view ? view.state.doc.toString() : "";
}

/** The rows currently claiming to be newly added. */
function glowingRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-new-step="true"]'));
}

/** Row text for each glowing row, so assertions name steps rather than indexes. */
function glowingText(): string[] {
  return glowingRows().map((r) => r.textContent ?? "");
}

/** Wire updateScript to hand back `after`, and make subsequent refetches agree. */
function applyYields(after: Step[]) {
  updateScript.mockImplementation(async () => {
    test_ = record({ ...(test_ ?? {}), steps: after });
    return test_;
  });
}

async function stepsTab(): Promise<HTMLElement> {
  return screen.findByRole("tab", { name: /^Steps/ });
}

describe("applying an AI-debug fix, in the Steps tab", () => {
  beforeEach(() => {
    stepSeq = 0;
    updateScript.mockReset();
    updateScript.mockImplementation(async () => ({}) as TestRecord);
  });

  it("glows a step the fix added, and only that step", async () => {
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    const click = mkStep({ type: "click", locator: BTN });
    test_ = record({ steps: [goto, click] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    const added = mkStep({ type: "wait", waitMs: 500 });
    applyYields([...reparsed([goto, click]), added]);
    await view.apply("// corrected spec");

    await waitFor(() => expect(glowingRows()).toHaveLength(1));
    expect(glowingText()[0]).toMatch(/500/);
  });

  it("retires the glow the moment Run test is clicked", async () => {
    // The glow means "look what the AI changed". Once a run starts, the run's
    // verdict is the story — stale green outlines over failing steps would
    // read as the AI's work being fine.
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    test_ = record({ steps: [goto] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    applyYields([...reparsed([goto]), mkStep({ type: "wait", waitMs: 500 })]);
    await view.apply("// corrected spec");
    await waitFor(() => expect(glowingRows()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /run test/i }));
    await waitFor(() => expect(glowingRows()).toHaveLength(0));
    expect(run).toHaveBeenCalled();
  });

  it("glows every step of a multi-step addition", async () => {
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    test_ = record({ steps: [goto] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    applyYields([
      ...reparsed([goto]),
      mkStep({ type: "click", locator: BTN }),
      mkStep({ type: "assert", assert: "visible", locator: BTN }),
    ]);
    await view.apply("// corrected spec");

    await waitFor(() => expect(glowingRows()).toHaveLength(2));
  });

  it("updates the step count when steps are added", async () => {
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    test_ = record({ steps: [goto] });

    const view = renderWithApply();
    expect((await stepsTab()).textContent).toBe("Steps (1)");

    applyYields([...reparsed([goto]), mkStep({ type: "click", locator: BTN })]);
    await view.apply("// corrected spec");

    await waitFor(async () => expect((await stepsTab()).textContent).toBe("Steps (2)"));
  });

  it("glows nothing when the fix only DELETED steps", async () => {
    // Explicitly part of the spec: a removal has no row left to decorate, and
    // decorating its neighbours would point at the wrong step.
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    const click = mkStep({ type: "click", locator: BTN });
    test_ = record({ steps: [goto, click] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    applyYields(reparsed([goto]));
    await view.apply("// corrected spec");

    await waitFor(async () => expect((await stepsTab()).textContent).toBe("Steps (1)"));
    expect(glowingRows()).toHaveLength(0);
  });

  it("glows only the replacement in a substitution, and holds the count", async () => {
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    const click = mkStep({ type: "click", locator: BTN });
    test_ = record({ steps: [goto, click] });

    const view = renderWithApply();
    expect((await stepsTab()).textContent).toBe("Steps (2)");

    applyYields([...reparsed([goto]), mkStep({ type: "click", locator: ALT })]);
    await view.apply("// corrected spec");

    await waitFor(() => expect(glowingRows()).toHaveLength(1));
    expect(glowingText()[0]).toMatch(/Continue/);
    expect((await stepsTab()).textContent).toBe("Steps (2)");
  });

  it("glows nothing when the fix only reordered steps", async () => {
    // The LCS alone reports a move as a remove plus an add. Without the move
    // suppression this lights up a step the AI did not write.
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    const click = mkStep({ type: "click", locator: BTN });
    const wait = mkStep({ type: "wait", waitMs: 250 });
    test_ = record({ steps: [goto, click, wait] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    applyYields(reparsed([goto, wait, click]));
    await view.apply("// corrected spec");

    await waitFor(async () => expect((await stepsTab()).textContent).toBe("Steps (3)"));
    expect(glowingRows()).toHaveLength(0);
  });

  it("glows nothing when the fix changed no steps at all", async () => {
    // A whitespace- or comment-only correction re-parses to the same steps
    // with entirely new ids. Comparing by id would glow the whole list here.
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    const click = mkStep({ type: "click", locator: BTN });
    test_ = record({ steps: [goto, click] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    applyYields(reparsed([goto, click]));
    await view.apply("// corrected spec");

    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
    expect(glowingRows()).toHaveLength(0);
  });

  it("replaces the previous highlight when a second fix is applied", async () => {
    // Highlights must not accumulate: the question is "what did the change I
    // just applied do", not "what has ever been added to this test".
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    test_ = record({ steps: [goto] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    const first = mkStep({ type: "click", locator: BTN });
    applyYields([...reparsed([goto]), first]);
    await view.apply("// fix one");
    await waitFor(() => expect(glowingRows()).toHaveLength(1));

    const second = mkStep({ type: "wait", waitMs: 750 });
    applyYields([...reparsed([goto, first]), second]);
    await view.apply("// fix two");

    await waitFor(() => expect(glowingText()).toEqual([expect.stringMatching(/750/)]));
  });

  it("stops glowing once the user saves their own step edits", async () => {
    // Once the user has had their hands in the list, "the AI added these" is
    // no longer a claim this view can make about it — and the ids it was
    // tracking may not even be in the list any more.
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    test_ = record({ steps: [goto] });

    // Stand in for the native menu, the way the Edit Steps suite below does —
    // the SDK's DropdownMenu items never reach the DOM.
    (window as unknown as { glazeAPI: { Menu: { popup: unknown } } }).glazeAPI.Menu.popup = vi.fn(
      async (opts: { items: { label?: string; commandId?: number }[] }) => {
        const item = opts.items.find((i) => i.label === "Edit Steps");
        return item?.commandId === undefined ? {} : { commandId: item.commandId };
      },
    );

    const view = renderWithApply();
    await screen.findByText("Checkout");

    applyYields([...reparsed([goto]), mkStep({ type: "click", locator: BTN })]);
    await view.apply("// corrected spec");
    await waitFor(() => expect(glowingRows()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /edit test/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateSteps).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(glowingRows()).toHaveLength(0));
  });

  it("moves off the Steps tab when a fix deletes the last step", async () => {
    // The trigger is gated on there being steps. Left uncontrolled, the tab
    // value stayed "steps" after the trigger vanished and the user was looking
    // at an empty pane with nothing selected in the tab bar.
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    test_ = record({ steps: [goto] });

    const view = renderWithApply();
    expect((await stepsTab()).textContent).toBe("Steps (1)");

    // The user has to have PICKED the tab for this to bite. Steps is already
    // the default, and the default arm recomputes from the current step list,
    // so it copes on its own — it is the explicitly-chosen value that gets
    // stranded. Round-tripping through Script is what makes "steps" an actual
    // choice rather than the fallback.
    selectTab(/Script/);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Script/ }).getAttribute("data-state")).toBe("active"),
    );
    selectTab(/^Steps/);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^Steps/ }).getAttribute("data-state")).toBe("active"),
    );

    applyYields([]);
    await view.apply("// corrected spec");

    await waitFor(() => expect(screen.queryByRole("tab", { name: /^Steps/ })).toBeNull());
    // Scoped to the detail strip: the run panel's console tablist keeps its own
    // active tab, which is a different strip answering a different question.
    const strip = document.querySelector(".gl-detail-tabs") as HTMLElement;
    const selected = within(strip)
      .getAllByRole("tab")
      .filter((t) => t.getAttribute("data-state") === "active");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toMatch(/Script/);
  });
});

// ── The Shopify crawler-signature chip ────────────────────────────────
//
// Everything this chip says is about a run that will go out UNSIGNED. The run
// output says so too, but it says it afterwards, in a log people scroll past —
// and this is the screen someone is looking at when they press Run. So the two
// properties that matter are that it appears for the states where the user
// believes they are covered and are not, and that it stays QUIET otherwise: a
// chip that also announced a working signature would be on screen for every run
// of every test against a registered store, and would stop being read.

const NOW_S = Math.floor(Date.UTC(2026, 7, 18) / 1000);
const DAY_S = 24 * 60 * 60;

function sig(over: Partial<(typeof signatures)[number]> = {}): (typeof signatures)[number] {
  return {
    id: "s1",
    host: "shop.example.com",
    expiresAt: NOW_S + 60 * DAY_S,
    createdAt: null,
    addedAt: 0,
    state: "valid",
    ...over,
  };
}

describe("the Shopify signature chip", () => {
  beforeEach(() => {
    test_ = {
      id: "t1",
      name: "Checkout",
      url: "https://shop.example.com/products/hat",
      steps: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as TestRecord;
  });

  it("says nothing when the signature is working", async () => {
    signatures = [sig()];
    renderView();
    await screen.findAllByRole("tab");
    expect(screen.queryByText(/Signature/)).toBeNull();
  });

  it("says nothing when no signature is registered for this store", async () => {
    signatures = [];
    renderView();
    await screen.findAllByRole("tab");
    expect(screen.queryByText(/Signature/)).toBeNull();
  });

  it("warns when the signature for this store has expired", async () => {
    signatures = [sig({ state: "expired", expiresAt: NOW_S - DAY_S })];
    renderView();
    await waitFor(() => expect(screen.getByText("Signature expired")).toBeTruthy());
    expect(screen.getByText("Signature expired").closest("[title]")?.getAttribute("title")).toMatch(
      /worse than sending none/,
    );
  });

  it("warns when the signature cannot be decrypted on this Mac", async () => {
    // A different problem with a different fix — re-paste the one you have,
    // rather than go and create a new one — so it must not read as "expired".
    signatures = [sig({ state: "unreadable" })];
    renderView();
    await waitFor(() => expect(screen.getByText("Signature unreadable")).toBeTruthy());
  });

  it("warns an imported test that its runs cannot carry the signature", async () => {
    // The gap the fixture cannot close: an imported spec never imports it.
    test_ = {
      id: "t1",
      name: "Imported checkout",
      url: "",
      baseUrl: "https://shop.example.com",
      sourceDir: "/tmp/imported",
      steps: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as TestRecord;
    signatures = [sig()];
    renderView();
    await waitFor(() => expect(screen.getByText("Signature not sent")).toBeTruthy());
  });

  it("does not warn a test at a neighbouring host", async () => {
    // `www.` and the apex are different authorities and get different
    // signatures — warning here would be claiming a fact about the wrong one.
    signatures = [sig({ host: "www.shop.example.com", state: "expired", expiresAt: NOW_S - 1 })];
    renderView();
    await screen.findAllByRole("tab");
    expect(screen.queryByText(/Signature/)).toBeNull();
  });
});

describe("flows — the used-by strip and the guarded delete", () => {
  it("shows a flow's callers as click-through links", async () => {
    test_ = record({ isFlow: true, name: "Sign in" });
    flowUsage = [
      { id: "t2", name: "Checkout" },
      { id: "t3", name: "Search" },
    ];
    renderView();
    expect(await screen.findByText(/Used by 2 tests/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Checkout" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
  });

  it("tells a flow with no callers how to get one", async () => {
    test_ = record({ isFlow: true });
    renderView();
    expect(await screen.findByText(/Not called by any test yet/)).toBeTruthy();
  });

  it("shows the strip for an unflagged test something still calls", async () => {
    // Callers are what a change reaches — the flag is only what the picker
    // offers. Turning the flag off must not hide who depends on the steps.
    test_ = record({ isFlow: false });
    flowUsage = [{ id: "t2", name: "Checkout" }];
    renderView();
    expect(await screen.findByText(/Used by 1 test/)).toBeTruthy();
  });

  it("shows no strip on an ordinary test", async () => {
    renderView();
    await screen.findAllByRole("tab");
    expect(screen.queryByText(/Used by/)).toBeNull();
    expect(screen.queryByText(/Not called by any test/)).toBeNull();
  });

  it("warns in the delete dialog while callers exist", async () => {
    test_ = record({ isFlow: true, name: "Sign in" });
    flowUsage = [{ id: "t2", name: "Checkout" }];
    renderView();
    await screen.findByText(/Used by 1 test/);
    fireEvent.click(screen.getByLabelText("Delete test"));
    expect(await screen.findByText(/deleting is blocked/i)).toBeTruthy();
  });

  // The utilities menu is native-menu-backed: its items never enter the DOM,
  // so these drive it the way appearance-pane.test.tsx drives the typeface
  // Select — stub `glazeAPI.Menu.popup` and answer with the wanted label's
  // commandId. See CLAUDE.md's Select note; same component family.
  interface MenuItem {
    label?: string;
    commandId?: number;
    submenu?: MenuItem[];
  }
  function stubNativeMenu(choose: string | null): { labels: () => string[] } {
    let seen: MenuItem[] = [];
    const popup = vi.fn(async ({ items }: { items: MenuItem[] }) => {
      const flat: MenuItem[] = [];
      const walk = (list: MenuItem[]): void => {
        for (const i of list) {
          flat.push(i);
          if (i.submenu) walk(i.submenu);
        }
      };
      walk(items);
      seen = flat;
      if (choose === null) return {};
      const hit = flat.find((i) => i.label === choose && i.commandId !== undefined);
      if (!hit) throw new Error(`no item labelled "${choose}"`);
      return { commandId: hit.commandId };
    });
    (window as unknown as { glazeAPI: { Menu: unknown } }).glazeAPI = { Menu: { popup } };
    return { labels: () => seen.map((i) => i.label ?? "").filter(Boolean) };
  }

  const flowCallRecord = () =>
    record({
      steps: [
        {
          id: "s1",
          type: "runFlow",
          flowId: "f1",
          label: "Sign in",
          timestamp: 1,
        },
      ] as TestRecord["steps"],
    });

  it("offers Go to Flow and Unwrap on a runFlow row, and no parameter editor", async () => {
    test_ = flowCallRecord();
    renderView();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Steps/ }));
    const menu = stubNativeMenu(null);
    fireEvent.click(await screen.findByLabelText("Step utilities"));
    await waitFor(() => expect(menu.labels()).toContain("Go to Flow"));
    expect(menu.labels()).toContain("Unwrap Flow…");
    // No onEdit on the read-only detail rows, so no parameter editor here —
    // editing a call's arguments happens where steps are editable (the
    // trainer, Edit Steps).
    expect(menu.labels()).not.toContain("Flow Parameters…");
  });

  it("unwraps through the confirm dialog", async () => {
    test_ = flowCallRecord();
    renderView();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Steps/ }));
    stubNativeMenu("Unwrap Flow…");
    fireEvent.click(await screen.findByLabelText("Step utilities"));
    expect(await screen.findByText(/call is replaced by a copy/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unwrap" }));
    await waitFor(() => expect(unwrapFlow).toHaveBeenCalledWith("t1", "s1"));
  });
});

describe("saving a script edit", () => {
  // Save hands the draft to the Playwright CLI before it writes anything. A
  // draft the CLI cannot load stays in the editor with its problems listed
  // against the lines; "Save anyway" is the way past that, and the only way.
  beforeEach(() => {
    updateScript.mockReset();
    updateScript.mockImplementation(async () => ({}) as TestRecord);
    checkScript.mockReset();
    checkScript.mockImplementation(async () => ({ ok: true, errors: [], tests: [], durationMs: 1 }));
  });

  async function openEditor(): Promise<HTMLElement> {
    renderView();
    await screen.findByText("Checkout");
    selectTab(/Script/);
    fireEvent.click(await screen.findByRole("button", { name: "Edit script" }));
    // The CodeMirror host is lazy; the textbox appears once it has loaded and
    // is editable once the Edit click has flipped it.
    const content = await screen.findByRole("textbox");
    await waitFor(() => expect(content.getAttribute("contenteditable")).toBe("true"));
    return content;
  }

  it("formats the draft through the type service before checking and saving it", async () => {
    // The module mock's ts surface is a plain object: make the service
    // available and hand back one formatting edit for this test only.
    const ts = api.ts as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const wasEnsure = ts.ensure;
    const wasFormat = ts.format;
    ts.ensure = async () => ({ available: true, typescript: "5.9.3" });
    ts.format = async () => [{ from: 0, to: 2, text: "//" }];
    try {
      const ta = await openEditor();
      setDraft(ta, "/*edited");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
      expect(checkScript).toHaveBeenCalledWith("t1", "//edited");
      expect(updateScript).toHaveBeenCalledWith("t1", "//edited", { by: "manual", reviewed: true }, expect.any(String));
    } finally {
      ts.ensure = wasEnsure;
      ts.format = wasFormat;
    }
  });

  it("files the save as ai-inline after an AI rewrite was applied into the buffer", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    // The panel is stubbed (see the vi.mock at the top); its Apply hands back
    // a rewritten file with the model's details, as the real one does.
    fireEvent.click(await screen.findByRole("button", { name: "Apply stub" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
    expect(updateScript).toHaveBeenCalledWith(
      "t1",
      "// by ai\n",
      { by: "ai-inline", affordance: "inline-rewrite", provider: "ollama", model: "qwen", promptVersion: "inline-1", reviewed: true },
      expect.any(String),
    );
  });

  it("checks the draft with Playwright before writing it", async () => {
    const ta = await openEditor();
    setDraft(ta, "// edited");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
    expect(checkScript).toHaveBeenCalledWith("t1", "// edited");
    expect(updateScript).toHaveBeenCalledWith("t1", "// edited", { by: "manual", reviewed: true }, expect.any(String));
    // Order matters: the write must wait for the verdict.
    expect(checkScript.mock.invocationCallOrder[0]).toBeLessThan(
      updateScript.mock.invocationCallOrder[0],
    );
    await editorClosed();
  });

  it("keeps the editor open and lists the problems when the draft does not load", async () => {
    checkScript.mockResolvedValue({
      ok: false,
      errors: [{ message: 'SyntaxError: Unexpected token, expected "," (3:9)', line: 3, column: 9 }],
      tests: [],
      durationMs: 1,
    });
    const ta = await openEditor();
    setDraft(ta, "a\nb\nc(\nd");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText(/can't load this script — 1 problem/);
    expect(updateScript).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBe(ta);
    // The problem, where it is, and the line marked in the gutter.
    const row = screen.getByRole("button", { name: /Line 3:9/ });
    expect(row.textContent).toContain('SyntaxError: Unexpected token, expected "," (3:9)');
    // …and as a diagnostic on its line in the editor.
    await waitFor(() => expect(document.querySelector(".cm-lintRange-error")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Save anyway" })).toBeTruthy();
  });

  it("moves the caret to a problem's line when its row is clicked", async () => {
    checkScript.mockResolvedValue({
      ok: false,
      errors: [{ message: "SyntaxError: x", line: 3, column: 1 }],
      tests: [],
      durationMs: 1,
    });
    const ta = await openEditor();
    setDraft(ta, "ab\ncd\nef");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const row = await screen.findByRole("button", { name: /Line 3:1/ });
    fireEvent.click(row);
    const v = EditorView.findFromDOM(ta)!;
    expect(v.state.selection.main.head).toBe(6);
    expect(v.state.selection.main.anchor).toBe(6);
  });

  it("Save anyway writes the draft the check refused", async () => {
    checkScript.mockResolvedValue({
      ok: false,
      errors: [{ message: "SyntaxError: x", line: 1, column: 1 }],
      tests: [],
      durationMs: 1,
    });
    const ta = await openEditor();
    setDraft(ta, "broken(");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save anyway" }));

    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
    expect(updateScript).toHaveBeenCalledWith("t1", "broken(", { by: "manual", reviewed: true }, expect.any(String));
    // One check, not two: Save anyway is the way past the verdict, not a retry.
    expect(checkScript).toHaveBeenCalledTimes(1);
    await editorClosed();
  });

  it("treats a check that could not run as a failure, not a pass", async () => {
    checkScript.mockRejectedValue(new Error("Could not find @playwright/test"));
    const ta = await openEditor();
    setDraft(ta, "// edited");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText(/Couldn't check the script: Could not find @playwright\/test/);
    expect(updateScript).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save anyway" })).toBeTruthy();
  });

  it("holds Save while the check is running", async () => {
    let release: (() => void) | null = null;
    checkScript.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, errors: [], tests: [], durationMs: 1 });
        }),
    );
    const ta = await openEditor();
    setDraft(ta, "// edited");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const checking = await screen.findByRole("button", { name: "Checking…" });
    expect((checking as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText("Checking with Playwright…");
    await act(async () => {
      release!();
    });
    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
  });

  it("Cancel discards the verdict with the draft", async () => {
    checkScript.mockResolvedValue({
      ok: false,
      errors: [{ message: "SyntaxError: x", line: 1, column: 1 }],
      tests: [],
      durationMs: 1,
    });
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/can't load this script/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await editorClosed();
    // Re-opening starts clean: no stale problems from the last draft.
    fireEvent.click(await screen.findByRole("button", { name: "Edit script" }));
    await screen.findByRole("textbox");
    expect(screen.queryByText(/can't load this script/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save anyway" })).toBeNull();
  });
});

describe("applying an AI fix lands under the same rules as a hand edit", () => {
  beforeEach(() => {
    updateScript.mockReset();
    updateScript.mockImplementation(async () => ({}) as TestRecord);
    getScript.mockReset();
    getScript.mockImplementation(async () => "import { test } from '@playwright/test';");
    resetScriptDirty();
  });

  it("sends the stored script as the base, so a fix diffed against an older file is refused", async () => {
    const view = renderWithApply();
    await screen.findByText("Checkout");
    // The script query has resolved by the time the apply handler exists.
    await waitFor(() => expect(getScript).toHaveBeenCalled());
    await view.apply("// corrected spec");
    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
    expect(updateScript.mock.calls[0][3]).toBe("import { test } from '@playwright/test';");
  });

  it("refuses while the Script tab has an unsaved draft of this test", async () => {
    const view = renderWithApply();
    await screen.findByText("Checkout");
    markScriptDirty("t1", true);
    await expect(view.apply("// corrected spec")).rejects.toThrow(/unsaved draft/);
    expect(updateScript).not.toHaveBeenCalled();
  });
});

describe("saving a script edit — stale drafts, divergence, and the dirty buffer", () => {
  const LOADED = "import { test } from '@playwright/test';";
  beforeEach(() => {
    updateScript.mockReset();
    updateScript.mockImplementation(async () => ({}) as TestRecord);
    checkScript.mockReset();
    checkScript.mockImplementation(async () => ({ ok: true, errors: [], tests: [], durationMs: 1 }));
    previewScript.mockReset();
    previewScript.mockImplementation(async () => ({
      tracked: true,
      steps: 1,
      skipped: 0,
      stepRanges: [],
      skippedRanges: [],
      newlySkipped: [],
    }));
    getScript.mockReset();
    getScript.mockImplementation(async () => LOADED);
    resetScriptDirty();
  });

  async function openEditor(): Promise<HTMLElement> {
    renderView();
    await screen.findByText("Checkout");
    selectTab(/Script/);
    fireEvent.click(await screen.findByRole("button", { name: "Edit script" }));
    // The CodeMirror host is lazy; the textbox appears once it has loaded and
    // is editable once the Edit click has flipped it.
    const content = await screen.findByRole("textbox");
    await waitFor(() => expect(content.getAttribute("contenteditable")).toBe("true"));
    return content;
  }

  it("sends the script it loaded as the draft's base", async () => {
    const ta = await openEditor();
    setDraft(ta, "// edited");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
    expect(updateScript.mock.calls[0][3]).toBe(LOADED);
  });

  it("marks the buffer dirty while the draft differs from what it loaded, and clean after a save", async () => {
    const ta = await openEditor();
    expect(isScriptDirty("t1")).toBe(false);
    setDraft(ta, "// edited");
    await waitFor(() => expect(isScriptDirty("t1")).toBe(true));
    setDraft(ta, LOADED);
    await waitFor(() => expect(isScriptDirty("t1")).toBe(false));
    setDraft(ta, "// edited again");
    await waitFor(() => expect(isScriptDirty("t1")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await editorClosed();
    expect(isScriptDirty("t1")).toBe(false);
  });

  it("a stale refusal opens the dialog; Overwrite saves again without a base", async () => {
    updateScript.mockImplementationOnce(async () => {
      throw new Error(SCRIPT_CHANGED_ON_DISK);
    });
    const ta = await openEditor();
    setDraft(ta, "// edited");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("The script changed on disk");
    expect(updateScript).toHaveBeenCalledTimes(1);
    // Still editing underneath the (modal, aria-hiding) dialog.
    expect(document.querySelector(".cm-content")).toBe(ta);

    fireEvent.click(screen.getByRole("button", { name: "Overwrite with my draft" }));
    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(2));
    expect(updateScript.mock.calls[1][1]).toBe("// edited");
    expect(updateScript.mock.calls[1][3]).toBeUndefined();
    await editorClosed();
  });

  it("Reload replaces the draft with the script as it is now, and keeps editing", async () => {
    updateScript.mockImplementationOnce(async () => {
      throw new Error(SCRIPT_CHANGED_ON_DISK);
    });
    const ta = await openEditor();
    setDraft(ta, "// edited");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("The script changed on disk");
    getScript.mockImplementation(async () => "// version two");

    fireEvent.click(screen.getByRole("button", { name: "Reload (discard draft)" }));
    await waitFor(() => expect(draftText()).toBe("// version two"));
    expect(updateScript).toHaveBeenCalledTimes(1);
    expect(isScriptDirty("t1")).toBe(false);
    // The reloaded text is the new base: saving it sends it as such.
    setDraft(screen.getByRole("textbox"), "// version three");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(2));
    expect(updateScript.mock.calls[1][3]).toBe("// version two");
  });

  it("asks before saving a draft whose new statements the parser cannot map, and saves on confirm", async () => {
    previewScript.mockResolvedValue({
      tracked: true,
      steps: 1,
      skipped: 1,
      stepRanges: [],
      skippedRanges: [{ from: 0, to: 1 }],
      newlySkipped: ['await page.keyboard.down("Shift")'],
    });
    const ta = await openEditor();
    setDraft(ta, 'await page.keyboard.down("Shift")');
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("One statement won't become a step");
    // Scoped to the dialog: the editor's highlight layer shows the draft too.
    expect(within(screen.getByRole("dialog")).getByText(/keyboard\.down\("Shift"\)/)).toBeTruthy();
    expect(updateScript).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
    // Asked once: the confirmed save does not raise the question again.
    await editorClosed();
    expect(screen.queryByText(/won't become/)).toBeNull();
  });

  it("does not ask when the misses are ones the stored script already had, or the steps are not tracked", async () => {
    previewScript.mockResolvedValue({
      tracked: false,
      steps: 0,
      skipped: 3,
      stepRanges: [],
      skippedRanges: [],
      newlySkipped: ["await page.mouse.move(1, 2)"],
    });
    const ta = await openEditor();
    setDraft(ta, "// imported");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/won't become/)).toBeNull();
  });

  it("skips the Playwright check when Settings → Editor turns it off, and still saves", async () => {
    settings = { ...settings, editorCheckOnSave: false };
    const ta = await openEditor();
    setDraft(ta, "// edited");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
    expect(checkScript).not.toHaveBeenCalled();
    await editorClosed();
  });

  it("a preview that fails does not stand between the user and the save", async () => {
    previewScript.mockRejectedValue(new Error("no parser today"));
    const ta = await openEditor();
    setDraft(ta, "// edited");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
  });
});

describe("the Script tab's live page", () => {
  const SCRIPT = [
    'import { test, expect } from "@playwright/test";',
    'test("Checkout", async ({ page }) => {',
    '  await page.goto("https://example.com");',
    '  await page.getByTestId("go").click();',
    '  await page.getByRole("button").click();',
    "});",
  ].join("\n");
  beforeEach(() => {
    livePage = { open: false };
    livePageOpen.mockClear();
    countMany.mockReset();
    countMany.mockImplementation(async (locators: unknown[]) =>
      locators.map((l) => {
        const loc = l as { k: string; name?: string };
        if (loc.k === "testid") return { count: 1 };
        if (loc.k === "role" && !loc.name) return { count: 3 };
        return { count: 0 };
      }),
    );
    highlightLocator.mockClear();
    pickLocator.mockReset();
    setCursor.mockClear();
    getScript.mockReset();
    getScript.mockImplementation(async () => SCRIPT);
    previewScript.mockReset();
    previewScript.mockImplementation(async (_id: string, source: string) => {
      const lines = source.split("\n");
      const at = (n: number) => lines.slice(0, n - 1).join("\n").length + (n > 1 ? 1 : 0);
      const stepList = [
        { id: "a", type: "goto", url: "https://example.com", timestamp: 0 },
        { id: "b", type: "click", locator: { k: "testid", v: "go" }, timestamp: 0 },
        { id: "c", type: "click", locator: { k: "role", role: "button" }, timestamp: 0 },
      ] as unknown as Step[];
      return {
        tracked: true,
        steps: 3,
        skipped: 0,
        stepRanges: [3, 4, 5].map((n) => ({ from: at(n) + 2, to: at(n) + lines[n - 1].length })),
        skippedRanges: [],
        newlySkipped: [],
        stepList,
      };
    });
    test_ = record({ url: "https://shop.example.com/${path}", variables: [{ name: "path", kind: "plain", value: "cart" }] as never });
  });

  async function openScriptTab() {
    renderView();
    await screen.findByText("Checkout");
    selectTab(/Script/);
    await screen.findByRole("textbox");
  }

  it("opens the live page at the test's address with its variables resolved, and shows the host", async () => {
    await openScriptTab();
    fireEvent.click(screen.getByRole("button", { name: "Live page" }));
    // The TEST ID is the third argument and it is not bookkeeping: it is what
    // lets the live page answer this test's basic-auth wall and present its
    // Shopify crawler signature. Opened without it, the page is
    // credential-blind and a protected storefront serves it the password page
    // while the same test's runs sail through.
    await waitFor(() =>
      expect(livePageOpen).toHaveBeenCalledWith("https://shop.example.com/cart", "chromium", "t1"),
    );
    await screen.findByText("shop.example.com");
    expect(screen.getByRole("button", { name: "Live page ●" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("draws a match count after every locator once the page is open, in the outcome's tone", async () => {
    await openScriptTab();
    fireEvent.click(screen.getByRole("button", { name: "Live page" }));
    await waitFor(() => expect(countMany).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelectorAll(".gl-ide-inlay")).toHaveLength(2));
    const inlays = Array.from(document.querySelectorAll(".gl-ide-inlay")).map((el) => [(el as HTMLElement).textContent, (el as HTMLElement).dataset.tone]);
    expect(inlays).toEqual([["1 match", "ok"], ["3 matches", "warn"]]);
    // The goto has no locator and gets no inlay; the testid's inlay sits on its line.
    const ok = document.querySelector('.gl-ide-inlay[data-tone="ok"]') as HTMLElement;
    expect(ok.closest(".cm-line")?.textContent).toContain('getByTestId("go")');
  });

  it("outlines the caret's step in the live page as the caret moves", async () => {
    await openScriptTab();
    fireEvent.click(screen.getByRole("button", { name: "Live page" }));
    await waitFor(() => expect(countMany).toHaveBeenCalled());
    const v = EditorView.findFromDOM(screen.getByRole("textbox"))!;
    act(() => v.dispatch({ selection: { anchor: v.state.doc.line(4).from + 4 } }));
    await waitFor(() => expect(highlightLocator).toHaveBeenCalledWith({ k: "testid", v: "go" }));
  });

  it("Pick locator inserts the app's spelling of the picked element at the caret", async () => {
    pickLocator.mockResolvedValue({ expr: "getByRole('button', { name: 'Sign in' })", locator: { k: "role", role: "button", name: "Sign in" } });
    await openScriptTab();
    fireEvent.click(screen.getByRole("button", { name: "Live page" }));
    await screen.findByText("shop.example.com");
    // Pick is an editing action: disabled until Edit script.
    expect(screen.queryByRole("button", { name: "Pick locator" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit script" }));
    const content = await screen.findByRole("textbox");
    await waitFor(() => expect(content.getAttribute("contenteditable")).toBe("true"));
    const v = EditorView.findFromDOM(content)!;
    act(() => v.dispatch({ selection: { anchor: v.state.doc.line(5).to } }));
    fireEvent.click(screen.getByRole("button", { name: "Pick locator" }));
    await waitFor(() => expect(draftText()).toContain('page.getByRole("button", { name: "Sign in" })'));
  });

  it("Record here opens the trainer with the insert cursor just past the caret's step", async () => {
    await openScriptTab();
    const v = EditorView.findFromDOM(screen.getByRole("textbox"))!;
    act(() => v.dispatch({ selection: { anchor: v.state.doc.line(4).from + 4 } }));
    await screen.findByText(/step 2 ·/);
    fireEvent.click(screen.getByRole("button", { name: "Record here" }));
    await waitFor(() => expect(startRecording).toHaveBeenCalledWith("https://shop.example.com/${path}", "Checkout", "t1"));
    await waitFor(() => expect(setCursor).toHaveBeenCalledWith(2));
  });
});

describe("the script bar's clusters", () => {
  // The bar shipped as one right-aligned run of controls, and "Types ready"
  // landed in the middle of it — between Outline and Explain failure, a label
  // splitting what otherwise reads as a row of four buttons. What replaces it
  // is five clusters, and the contract that keeps them honest is POSITIONAL
  // rather than cosmetic: a readout never sits inside a cluster of controls,
  // and never has a control after it inside its own. jsdom cannot see the gaps
  // that say a cluster is a cluster — `check:script-bar` owns those two numbers
  // and their ratio — but every placement they depend on is right here.
  const SCRIPT = [
    'import { test, expect } from "@playwright/test";',
    'test("Checkout", async ({ page }) => {',
    '  await page.goto("https://example.com");',
    '  await page.getByTestId("go").click();',
    "});",
  ].join("\n");

  beforeEach(() => {
    livePage = { open: false };
    getScript.mockReset();
    getScript.mockImplementation(async () => SCRIPT);
    checkScript.mockReset();
    checkScript.mockImplementation(async () => ({ ok: true, errors: [], tests: [], durationMs: 1 }));
    previewScript.mockReset();
    previewScript.mockImplementation(async (_id: string, source: string) => {
      const lines = source.split("\n");
      const at = (n: number) => lines.slice(0, n - 1).join("\n").length + (n > 1 ? 1 : 0);
      return {
        tracked: true,
        steps: 2,
        skipped: 0,
        stepRanges: [3, 4].map((n) => ({ from: at(n) + 2, to: at(n) + lines[n - 1].length })),
        skippedRanges: [],
        newlySkipped: [],
        stepList: [
          { id: "a", type: "goto", url: "https://example.com", timestamp: 0 },
          { id: "b", type: "click", locator: { k: "testid", v: "go" }, timestamp: 0 },
        ] as unknown as Step[],
      };
    });
  });

  async function openScriptTab() {
    renderView();
    await screen.findByText("Checkout");
    selectTab(/Script/);
    return await screen.findByRole("textbox");
  }

  const bar = () => document.querySelector(".gl-detail-script-bar") as HTMLElement;
  /** Everything in the bar that READS OUT rather than acts: the live page's
   *  host, the type service's state, the caret's step, the check's verdict,
   *  and the hand-edited chip. */
  const readouts = (root: ParentNode) =>
    Array.from(root.querySelectorAll<HTMLElement>(".gl-script-live-status, .gl-script-check-msg, .gl-chip"));
  const controls = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>(".gl-btn"));
  const labels = (els: HTMLElement[]) => els.map((el) => (el.textContent ?? "").trim());

  /** Every way the bar can break the rule the restyle exists to enforce, as
   *  sentences — an empty list is the assertion, so a failure names the
   *  offending control rather than reporting `false !== true`. */
  function clusterViolations(): string[] {
    const out: string[] = [];
    for (const group of Array.from(bar().querySelectorAll<HTMLElement>(".gl-script-group"))) {
      for (const stray of readouts(group)) {
        out.push(`"${(stray.textContent ?? "").trim()}" is inside a cluster of controls`);
      }
    }
    for (const readout of readouts(bar())) {
      const parent = readout.parentElement as HTMLElement;
      for (const control of controls(parent)) {
        // Node.DOCUMENT_POSITION_FOLLOWING: the control comes AFTER the label,
        // which is the shape of "a label splitting a row of buttons".
        if (readout.compareDocumentPosition(control) & 4) {
          out.push(
            `"${(readout.textContent ?? "").trim()}" sits before "${(control.textContent ?? "").trim()}" in the same cluster`,
          );
        }
      }
    }
    return out;
  }

  it("never puts a readout between two controls, reading or editing", async () => {
    const ta = await openScriptTab();
    // Reading: Live page + its host, Outline, Types, the caret's step, Record
    // here + Edit script.
    fireEvent.click(screen.getByRole("button", { name: "Live page" }));
    await screen.findByText("example.com");
    const v = EditorView.findFromDOM(ta)!;
    act(() => v.dispatch({ selection: { anchor: v.state.doc.line(4).from + 4 } }));
    await screen.findByText(/step 2 ·/);
    expect(readouts(bar()).length).toBeGreaterThan(1);
    expect(clusterViolations()).toEqual([]);

    // Editing: Pick locator joins the live cluster and Ask AI appears, which is
    // the state the old bar read worst in.
    fireEvent.click(screen.getByRole("button", { name: "Edit script" }));
    await screen.findByRole("button", { name: "Save" });
    expect(controls(bar()).length).toBeGreaterThan(4);
    expect(clusterViolations()).toEqual([]);
  });

  it("reads the type service's state out in the status zone, not between Outline and the AI buttons", async () => {
    // The exact placement the restyle was asked for. `ts.ensure` answers
    // "unavailable" in tests, which is the same readout in its other state.
    await openScriptTab();
    const ts = await screen.findByText("Types unavailable");
    expect(ts.closest(".gl-script-bar-status")).not.toBeNull();
    expect(ts.closest(".gl-script-group")).toBeNull();
  });

  it("keeps the bar's two halves whatever the readouts have to say", async () => {
    // `space-between` over exactly two children is what places the clusters
    // now. The bar used to lean on `margin-right: auto` claimed by BOTH the
    // live cluster and the check message, so the left-hand controls slid
    // sideways the moment the caret readout appeared.
    const ta = await openScriptTab();
    const halves = () => Array.from(bar().children).map((el) => el.className);
    expect(halves()).toEqual(["gl-script-bar-left", "gl-script-bar-right"]);

    const v = EditorView.findFromDOM(ta)!;
    act(() => v.dispatch({ selection: { anchor: v.state.doc.line(4).from + 4 } }));
    await screen.findByText(/step 2 ·/);
    expect(halves()).toEqual(["gl-script-bar-left", "gl-script-bar-right"]);

    fireEvent.click(screen.getByRole("button", { name: "Edit script" }));
    await screen.findByRole("button", { name: "Save" });
    expect(halves()).toEqual(["gl-script-bar-left", "gl-script-bar-right"]);
  });

  it("ends the bar with the mode: Record here beside Edit script", async () => {
    // Record here used to sit beside Outline, and only because it was Pick
    // locator's `else`. It is one of the two ways INTO a change, which is what
    // the bar's right end holds.
    await openScriptTab();
    const commit = bar().querySelector('[data-gl="script-commit"]') as HTMLElement;
    expect(labels(controls(commit))).toEqual(["Record here", "Edit script"]);
    expect(readouts(commit)).toEqual([]);
  });

  it("gives the live page both its controls, and its host after them", async () => {
    // Pick locator is disabled until the toggle beside it is on and inserts
    // what that page was asked for, so it belongs to the live page rather than
    // to Outline. The host TRAILS the pair — it is what the toggle reports.
    const ta = await openScriptTab();
    fireEvent.click(screen.getByRole("button", { name: "Edit script" }));
    await screen.findByRole("button", { name: "Save" });
    const live = bar().querySelector('[data-gl="script-live"]') as HTMLElement;
    expect(labels(controls(live))).toEqual(["Live page", "Pick locator"]);
    expect(labels(controls(bar().querySelector('[data-gl="script-commit"]') as HTMLElement))).toEqual([
      "Cancel",
      "Save",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Live page" }));
    const host = await screen.findByText("example.com");
    expect(host.parentElement).toBe(live);
    expect(host.previousElementSibling?.className).toBe("gl-script-group");
    expect(ta).toBe(screen.getByRole("textbox"));
  });

  it("reads the pre-save verdict out beside the buttons that answer it", async () => {
    // The verdict and Save anyway are one decision. It used to reach its place
    // by claiming the bar's auto margin, which is what fought the live cluster.
    checkScript.mockResolvedValue({
      ok: false,
      errors: [{ message: "SyntaxError: x", line: 1, column: 1 }],
      tests: [],
      durationMs: 1,
    });
    const ta = await openScriptTab();
    fireEvent.click(screen.getByRole("button", { name: "Edit script" }));
    await screen.findByRole("button", { name: "Save" });
    setDraft(ta, "broken(");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const verdict = await screen.findByText(/can't load this script — 1 problem/);
    expect(verdict.closest(".gl-script-bar-status")).not.toBeNull();
    const commit = bar().querySelector('[data-gl="script-commit"]') as HTMLElement;
    expect(labels(controls(commit))).toEqual(["Cancel", "Save anyway", "Save"]);
    expect(clusterViolations()).toEqual([]);
  });

  it("puts the hand-edited chip with the readouts, not in the commit cluster", async () => {
    test_ = record({ scriptEdited: true });
    await openScriptTab();
    const chip = await screen.findByText("Edited manually");
    expect(chip.closest(".gl-script-bar-status")).not.toBeNull();
    expect(labels(controls(bar().querySelector('[data-gl="script-commit"]') as HTMLElement))).toEqual([
      "Record here",
      "Edit script",
    ]);
  });
});

describe("the Heals tab badge", () => {
  it("counts a pending propagation proposal with the other reviews", async () => {
    // One badge for heals, script changes and propagated fixes alike: three
    // stores, three routes to the same hazard — a change to this test nobody
    // has read.
    proposals = [
      {
        id: "p1",
        testId: "t1",
        stepId: "s1",
        stepLabel: "click",
        origin: "https://example.test",
        fromLocator: { k: "testid", v: "a" },
        toLocator: { k: "testid", v: "b" },
        donors: [],
        confidence: 0.9,
        reasons: [],
        autoApplyEligible: false,
        applied: false,
        status: "pending",
        at: 1_700_000_000_000,
      },
    ];
    renderView();
    const tab = await screen.findByRole("tab", { name: /Heals \(1\)/ });
    expect(tab).toBeTruthy();
  });
});
