// Component tests for the Accessibility tab.
//
// This panel exists because the results used to be somewhere the user had no
// reason to look, so its tests are about WHAT IT SAYS in each of the four
// situations it has to tell apart — never checked, checked and clean, checked
// and broken, checked and dirty. Three of those four render "no issues" if the
// copy is written carelessly, and the fourth is the one that matters most:
// a check that completed nothing must never read as a clean page. That is the
// exact confusion that hid a broken axe fixture for months.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { clearToastCalls, toastCalls } from "../__tests__/sonner-stub";

import type {
  A11yResult,
  ReplayStep,
  RunNoticeKind,
  RunRecord,
  RunReplay,
  TestRecord,
} from "../lib/recorder-types";
import { A11yPanel } from "./a11y-panel";

let runs: RunRecord[] = [];
let replay: RunReplay | null = null;

// The dismiss pair patches the replay the way the real handlers do, so the
// panel re-renders from the object the backend would hand back.
const dismissNotice = vi.fn(async (_testId: string, _runId: string, kind: RunNoticeKind) => {
  if (replay) {
    replay.dismissedNotices = [...new Set<RunNoticeKind>([...(replay.dismissedNotices ?? []), kind])];
  }
  return replay;
});
const restoreNotice = vi.fn(async (_testId: string, _runId: string, kind: RunNoticeKind) => {
  if (replay) replay.dismissedNotices = (replay.dismissedNotices ?? []).filter((k) => k !== kind);
  return replay;
});
const acceptRun = vi.fn(async () => replay);

vi.mock("../lib/api", () => ({
  api: {
    runs: { list: async () => runs },
    artifacts: {
      getReplay: async () => replay,
      dismissNotice: (...a: Parameters<typeof dismissNotice>) => dismissNotice(...a),
      restoreNotice: (...a: Parameters<typeof restoreNotice>) => restoreNotice(...a),
    },
    a11y: {
      acceptStep: async () => replay,
      acceptRun: (...a: unknown[]) => acceptRun(...(a as [])),
      resetBaseline: async () => ({ cleared: 0 }),
    },
  },
}));

function runRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r1",
    testId: "t1",
    testName: "Checkout",
    status: "passed",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    ...over,
  } as RunRecord;
}

function step(over: Partial<ReplayStep> & { stepId: string }): ReplayStep {
  return {
    index: 0,
    label: 'getByRole("link", { name: "Women" }).click()',
    type: "click",
    status: "passed",
    screenshot: null,
    ...over,
  } as ReplayStep;
}

function result(over: Partial<A11yResult> = {}): A11yResult {
  return {
    violations: [
      {
        id: "color-contrast",
        impact: "serious",
        help: "Elements must have sufficient colour contrast",
        nodes: [".cta-button"],
      },
    ],
    newKeys: ["color-contrast|.cta-button"],
    acceptedCount: 0,
    ...over,
  };
}

function replayOf(steps: ReplayStep[]): RunReplay {
  return {
    testId: "t1",
    runId: "r1",
    testName: "Checkout",
    status: "passed",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    failedIndex: null,
    steps,
  } as RunReplay;
}

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

function renderPanel(test: TestRecord = record()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <A11yPanel test={test} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearToastCalls();
  runs = [];
  replay = null;
});

describe("when nothing has been checked", () => {
  it("says how to get results rather than showing an empty list", async () => {
    runs = [runRecord()];
    renderPanel();
    expect(await screen.findByText(/No accessibility results yet/i)).toBeTruthy();
    expect(document.body.textContent).toMatch(/Check accessibility/);
  });

  it("says something different when the check is already switched on", async () => {
    // "Switch it on" is wrong and confusing advice for a user who already did.
    runs = [runRecord()];
    renderPanel(record({ a11yChecks: true }));
    expect(await screen.findByText(/hasn’t been run since/i)).toBeTruthy();
  });

  it("ignores a run of a different test", async () => {
    runs = [runRecord({ testId: "other", a11yChecks: 4 })];
    renderPanel();
    expect(await screen.findByText(/No accessibility results yet/i)).toBeTruthy();
  });
});

describe("when the check ran", () => {
  it("reports a run that completed no checks as a fault, not a clean page", async () => {
    // THE test. axe ran (a11yMs is non-zero) and every check failed, so there
    // are no results. Reporting that as "no issues found" is how this feature
    // spent months looking like it worked.
    runs = [runRecord({ a11yMs: 1700, a11yChecks: 0 })];
    replay = replayOf([step({ stepId: "s1" })]);
    renderPanel();
    expect(await screen.findByText(/completed none/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/No accessibility issues found/i);
  });

  it("says the page was clean only when checks actually completed", async () => {
    runs = [runRecord({ a11yMs: 900, a11yChecks: 5 })];
    replay = replayOf([step({ stepId: "s1" })]);
    renderPanel();
    expect(await screen.findByText(/No accessibility issues found/i)).toBeTruthy();
  });

  it("lists each violation with the step, the rule, its impact and the node", async () => {
    runs = [runRecord({ a11yMs: 900, a11yChecks: 5, a11yNewSteps: 1 })];
    replay = replayOf([step({ stepId: "s1", a11y: result() })]);
    renderPanel();
    // The node target is the only thing that tells the user WHERE the problem
    // is; a list of rule names alone isn't actionable.
    expect(await screen.findByText(".cta-button")).toBeTruthy();
    expect(screen.getByText("color-contrast")).toBeTruthy();
    expect(screen.getByText("serious")).toBeTruthy();
    expect(document.body.textContent).toMatch(/getByRole/);
  });

  it("offers to accept, both per step and for the whole run", async () => {
    runs = [runRecord({ a11yMs: 900, a11yChecks: 5, a11yNewSteps: 1 })];
    replay = replayOf([step({ stepId: "s1", a11y: result() })]);
    renderPanel();
    expect(await screen.findByText("Accept these issues")).toBeTruthy();
    expect(screen.getByText("Accept all in this run")).toBeTruthy();
  });

  it("distinguishes clean-against-the-baseline from clean-against-the-page", async () => {
    // Everything accepted: the issues are still there and still shown, but
    // there is nothing new. Saying "no issues" here would make a baseline feel
    // like a fix, and offering "Accept all" again would be meaningless.
    runs = [runRecord({ a11yMs: 900, a11yChecks: 5, a11yNewSteps: 0 })];
    replay = replayOf([
      step({ stepId: "s1", a11y: result({ newKeys: [], acceptedCount: 1 }) }),
    ]);
    renderPanel();
    expect(await screen.findByText(/Nothing new/i)).toBeTruthy();
    expect(screen.getByText("color-contrast")).toBeTruthy();
    expect(screen.queryByText("Accept all in this run")).toBeNull();
  });

  it("always offers the way back from an over-eager accept", async () => {
    // `a11y:resetBaseline` had a handler and an API method and no UI at all —
    // accepting was one click and un-accepting was impossible.
    runs = [runRecord({ a11yMs: 900, a11yChecks: 5 })];
    replay = replayOf([step({ stepId: "s1" })]);
    renderPanel();
    expect(await screen.findByText("Reset accepted")).toBeTruthy();
  });

  it("describes the newest checked run, not the newest run", async () => {
    // A later run with the toggle off must not blank the results — the user
    // would read that as the issues having been fixed.
    runs = [
      runRecord({ id: "r2", startedAt: 2_000_000_000_000 }),
      runRecord({ id: "r1", startedAt: 1_700_000_000_000, a11yMs: 900, a11yChecks: 5 }),
    ];
    replay = replayOf([step({ stepId: "s1", a11y: result() })]);
    renderPanel();
    await waitFor(() => expect(screen.getByText("color-contrast")).toBeTruthy());
  });
});

// Dismissing the "not accepted yet" banner.
//
// Same distinction the Visual view draws, and it matters more here because this
// tab is where the issues are actually READ: accepting pins them onto the test
// record and changes what every later run reports, dismissing says "seen" about
// this run and leaves the list below untouched. Before this, the only way to
// stop the banner nagging was to accept issues you might not have read.
describe("waving the banner off, as opposed to accepting it", () => {
  beforeEach(() => {
    runs = [runRecord({ a11yMs: 900, a11yChecks: 5 })];
    replay = replayOf([step({ stepId: "s1", a11y: result() })]);
  });

  it("dismisses the banner without accepting a single issue", async () => {
    renderPanel();
    await screen.findByText(/accessibility issues that aren’t/i);
    fireEvent.click(screen.getByLabelText("Dismiss accessibility issues for this run"));

    await waitFor(() =>
      expect(screen.queryByText(/accessibility issues that aren’t/i)).toBeNull(),
    );
    expect(dismissNotice).toHaveBeenCalledWith("t1", "r1", "a11y");
    // The two assertions that separate this from "Accept all in this run".
    expect(acceptRun).not.toHaveBeenCalled();
    expect(replay?.steps[0].a11y?.newKeys).toEqual(["color-contrast|.cta-button"]);
  });

  it("keeps listing the issues it just stopped nagging about", async () => {
    // A dismiss that also hid the violations would be an accept wearing a
    // different label — the whole point is that the findings stay readable.
    renderPanel();
    await screen.findByText(/accessibility issues that aren’t/i);
    fireEvent.click(screen.getByLabelText("Dismiss accessibility issues for this run"));

    await waitFor(() =>
      expect(screen.queryByText(/accessibility issues that aren’t/i)).toBeNull(),
    );
    expect(screen.getByText("color-contrast")).toBeTruthy();
    expect(screen.getByText("Accept all in this run")).toBeTruthy();
  });

  it("stays dismissed on a replay that already carries the flag", async () => {
    // Read off the replay, not component state — otherwise the banner returns
    // the moment the user leaves the tab and comes back.
    replay = { ...replayOf([step({ stepId: "s1", a11y: result() })]), dismissedNotices: ["a11y"] };
    renderPanel();
    await screen.findByText("color-contrast");
    expect(screen.queryByText(/accessibility issues that aren’t/i)).toBeNull();
  });

  it("offers a way back", async () => {
    renderPanel();
    await screen.findByText(/accessibility issues that aren’t/i);
    fireEvent.click(screen.getByLabelText("Dismiss accessibility issues for this run"));
    await waitFor(() => expect(dismissNotice).toHaveBeenCalled());

    const undo = toastCalls
      .map((c) => c.options as { action?: { label: string; onClick: () => void } } | undefined)
      .find((o) => o?.action?.label === "Undo");
    expect(undo).toBeTruthy();
    act(() => undo!.action!.onClick());

    await waitFor(() => expect(restoreNotice).toHaveBeenCalledWith("t1", "r1", "a11y"));
    expect(await screen.findByText(/accessibility issues that aren’t/i)).toBeTruthy();
  });

  it("does not offer to dismiss a check that completed nothing", async () => {
    // That banner reports a BROKEN CHECK, not a finding about the page. There
    // is nothing to have seen and accepted, and letting it be waved off is how
    // a silently broken axe fixture hides for another few months.
    runs = [runRecord({ a11yMs: 900, a11yChecks: 0 })];
    replay = replayOf([step({ stepId: "s1" })]);
    renderPanel();
    await screen.findByText(/completed none/i);
    expect(screen.queryByLabelText("Dismiss accessibility issues for this run")).toBeNull();
  });
});

describe("the banner slot", () => {
  // One slot, four mutually exclusive states. Centring only the orange one
  // would make the banner look like it jumps alignment as a run's verdict
  // changes, which reads as a rendering bug rather than as a layout choice.
  const cases = [
    { name: "a check that completed nothing", checks: 0, a11y: undefined, match: /completed none/i },
    { name: "a clean page", checks: 5, a11y: undefined, match: /No accessibility issues found/i },
    {
      name: "clean against the baseline",
      checks: 5,
      a11y: result({ newKeys: [], acceptedCount: 1 }),
      match: /Nothing new/i,
    },
    { name: "unaccepted issues", checks: 5, a11y: result(), match: /aren’t\s+accepted yet/i },
  ];

  for (const c of cases) {
    it(`centres its copy for ${c.name}`, async () => {
      runs = [runRecord({ a11yMs: 900, a11yChecks: c.checks })];
      replay = replayOf([step({ stepId: "s1", ...(c.a11y ? { a11y: c.a11y } : {}) })]);
      renderPanel();
      const copy = await screen.findByText(c.match);
      expect(copy.className).toContain("text-center");
    });
  }
});
