// Component tests for the sidebar's Duplicate flow.
//
// The branch is the whole point and it is invisible from either side: a test
// with nothing active duplicates on the click, while a test carrying variables,
// cookies, secrets or a hand-edited script stops at a dialog first. Get that
// backwards in the quiet direction and a stored credential is copied with no
// mention of it; get it backwards in the loud direction and every duplication
// grows a dialog, which is how people learn to click through the one that
// mattered.
//
// The other silent failure is the one after confirming: a copy that is created
// but never navigated to, or created without the sidebar refetching, both read
// as "nothing happened" and invite a second click — and a second copy.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toastTexts, clearToastCalls } from "../__tests__/sonner-stub";

import type { RunRecord, SecretStatus, Step, TestRecord } from "../lib/recorder-types";
import { LibrarySidebar } from "./library-sidebar";
import { withAiDebug } from "../__tests__/ai-debug-harness";

let tests: TestRecord[] = [];
let secretStatus: SecretStatus[] = [];
let runRecords: RunRecord[] = [];

const navigate = vi.fn();
/** The open test, as the router reports it. Mutable so a test can put one in
 *  the address bar — selection is derived from it. */
let routeParams: { id?: string } = {};
const duplicate = vi.fn(
  async (id: string): Promise<TestRecord> => ({ ...record({ id: "copy" }), name: "Login [2]", id: `${id}-copy` }),
);

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => routeParams,
  useRouterState: () => "/",
}));

// The sidebar's other dialogs each open their own queries and native bridges;
// none of them is what this file is about.
vi.mock("./new-recording-dialog", () => ({ NewRecordingDialog: () => null }));
vi.mock("./generate-test-dialog", () => ({ GenerateTestDialog: () => null }));
vi.mock("./import-git-dialog", () => ({ ImportGitDialog: () => null }));
vi.mock("./tags-dialog", () => ({ TagsDialog: () => null }));

vi.mock("../lib/api", () => ({
  api: {
    tests: {
      list: async () => tests,
      duplicate: (id: string) => duplicate(id),
      secretStatus: async () => secretStatus,
      setHidden: async () => null,
      setSpeed: async () => ({}) as TestRecord,
      importFiles: async () => ({ imported: 0, names: [], ids: [] }),
    },
    llm: {
      getConfig: async () => ({ provider: "ollama" }),
      status: async () => ({ reachable: true, models: [] }),
    },
    runs: { list: async () => runRecords },
    // The sidebar asks whether the branch switcher is available before it
    // offers the row. Unavailable is the right default here: these tests are
    // about the library, and a Branches row in them would only be noise.
    branches: { status: async () => ({ available: false, switched: false, hasToken: false }) },
    // The AI debug provider (now above the sidebar for the row sparkles)
    // hydrates persisted sessions on mount and subscribes to pushes.
    aiDebug: {
      list: async () => [],
      save: async (session: unknown) => session,
      remove: async () => ({ removed: 0 }),
      clear: async () => ({ removed: 0 }),
      notifyDone: async () => ({ ok: true }),
    },
    on: () => () => {},
  },
}));

function step(type: Step["type"], id: string = type): Step {
  return { id, type, timestamp: 1 } as Step;
}

function record(over: Partial<TestRecord> = {}): TestRecord {
  return {
    id: "t1",
    name: "Login",
    url: "https://example.test/login",
    createdAt: 1,
    updatedAt: 1,
    steps: [step("click")],
    scriptPath: "/tmp/t1.spec.ts",
    ...over,
  };
}

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>{withAiDebug(<LibrarySidebar />)}</QueryClientProvider>,
  );
}

/** Right-click the first test row and pick "Duplicate Test". */
async function chooseDuplicate() {
  const row = await screen.findByText("Login");
  fireEvent.contextMenu(row);
  const item = await screen.findByText("Duplicate Test");
  fireEvent.click(item);
}

beforeEach(() => {
  tests = [record()];
  routeParams = {};
  secretStatus = [];
  runRecords = [];
  navigate.mockClear();
  duplicate.mockClear();
  clearToastCalls();
});

/** The bits of a RunRecord the verdict dot reads. */
function run(over: Partial<RunRecord>): RunRecord {
  return {
    id: "r1",
    testId: "t1",
    testName: "Login",
    url: "https://example.test/login",
    status: "passed",
    exitCode: 0,
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    logFile: "/tmp/r1.log",
    logBytes: 1,
    ...over,
  } as RunRecord;
}

describe("LibrarySidebar — the row icon sends nothing", () => {
  it("draws a monogram rather than fetching a third-party favicon", async () => {
    // THE REGRESSION THIS PINS ALREADY SHIPPED. Every row used to render
    // `<img src="https://www.google.com/s2/favicons?domain=<host>">`, so simply
    // opening the app sent Google the hostname of every site under test — and a
    // QA library routinely names unreleased staging hosts and internal domains.
    // No setting, no disclosure, and invisible from anywhere but that one
    // function.
    //
    // Asserted on the RENDERED OUTPUT rather than on the source, because
    // `check:renderer-egress` already reads the source and these two failing
    // together is the point: one catches the string, this one catches the
    // behaviour.
    tests = [record({ url: "https://staging.unreleased.test/checkout" })];
    renderSidebar();
    await screen.findByText("Login");

    for (const img of document.querySelectorAll("img")) {
      expect(img.getAttribute("src") ?? "").not.toMatch(/^https?:\/\//);
    }
    const icon = document.querySelector('[data-gl="site-icon"]') as HTMLElement;
    expect(icon.dataset.kind).toBe("monogram");
  });

  it("still shows an icon for a host nothing could resolve", async () => {
    // "Never falls through to nothing" — the old code degraded to a generic
    // flask on failure, and a hole in the row would read as a broken render.
    tests = [record({ url: "not a url at all" })];
    renderSidebar();
    await screen.findByText("Login");
    expect(document.querySelector('[data-gl="site-icon"]')).not.toBeNull();
  });
});

describe("LibrarySidebar — the rail", () => {
  it("keeps the views nav out of the scrolling list", async () => {
    // A4's structural fix. The views used to be an `mt-auto` block at the END
    // of the library list, so they were at the bottom only while the library
    // was short — with more tests than fit, Stats/Visual/Batch/Heals scrolled
    // away with them and the app's own views became something to hunt for.
    //
    // Structural, because jsdom has no layout engine: an overflowing list and a
    // short one produce identical (zero) boxes here, so a rendered "is it
    // visible at the bottom?" test would pass in the broken case too.
    tests = [record({ id: "a", name: "A" }), record({ id: "b", name: "B" })];
    renderSidebar();
    await screen.findByText("A");

    const body = document.querySelector(".gl-rail-body") as HTMLElement;
    const nav = document.querySelector(".gl-rail-nav") as HTMLElement;
    expect(body.textContent).toContain("A");
    expect(nav.textContent).toContain("Stats");
    expect(body.contains(nav)).toBe(false);
  });

  it("navigates from a test row on a plain click", async () => {
    // The SDK's `SidebarListItem` fired on mouseDown, so `fireEvent.click` did
    // nothing to it — a documented trap in this repo, and the reason
    // REDESIGN §8.2 called this swap out as a real change rather than a test
    // edit. `RailRow` is an ordinary button.
    renderSidebar();
    fireEvent.click(await screen.findByText("Login"));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t1" } }),
    );
  });

  it("navigates from a views row on a plain click", async () => {
    renderSidebar();
    fireEvent.click(await screen.findByText("Stats"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/stats" }));
  });

  it("marks the open test as selected, and nothing else", async () => {
    // Neutral selection is invisible to jsdom (no cascade, `css: false`), so
    // the attribute the stylesheet selects on IS the assertion — and it is the
    // one `check:selection-neutral` reads too.
    tests = [record({ id: "t1", name: "Login" }), record({ id: "t2", name: "Signup" })];
    routeParams = { id: "t1" };
    renderSidebar();
    await screen.findByText("Login");

    const rows = [...document.querySelectorAll(".gl-rail-row")] as HTMLElement[];
    const selected = rows.filter((r) => r.hasAttribute("data-selected"));
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("Login");
  });
});

describe("LibrarySidebar — run verdict dots", () => {
  it("dots a test with its LATEST run's verdict, not an older one's", async () => {
    // Two runs, newer one failed. A dot driven by list order instead of
    // startedAt would happily show green over a broken test.
    runRecords = [
      run({ id: "r-new", status: "failed", startedAt: 200 }),
      run({ id: "r-old", status: "passed", startedAt: 100 }),
    ];
    renderSidebar();
    await screen.findByText("Login");
    expect(await screen.findByLabelText("Last run failed")).toBeTruthy();
    expect(screen.queryByLabelText("Last run passed")).toBeNull();
  });

  it("blends the dot across a three-browser batch instead of flattening it", async () => {
    // Two of three browsers passing is a different fact from all three
    // failing, and the dot is the only place the difference is visible from
    // the library. Both the CLASS and the label are pinned: jsdom has no
    // cascade to ask, so the class is the colour, and the label is the part a
    // screen reader gets.
    runRecords = [
      run({ id: "r-c", batchId: "b1", runBrowser: "chromium", status: "passed", startedAt: 10 }),
      run({ id: "r-f", batchId: "b1", runBrowser: "firefox", status: "passed", startedAt: 11 }),
      run({ id: "r-w", batchId: "b1", runBrowser: "webkit", status: "failed", startedAt: 12 }),
    ];
    renderSidebar();
    await screen.findByText("Login");
    const dot = await screen.findByLabelText("2 of 3 runs passed");
    expect(dot.className).toContain("bg-support-yellow-orange");
    expect(dot.className).not.toContain("bg-support-red");
  });

  it("marks a passing batch that leaned on Auto-Heal", async () => {
    runRecords = [
      run({ id: "r-c", batchId: "b1", status: "passed", startedAt: 10, healedSteps: 2 }),
      run({ id: "r-f", batchId: "b1", status: "passed", startedAt: 11, healedSteps: 2 }),
      run({ id: "r-w", batchId: "b1", status: "passed", startedAt: 12, healedSteps: 0 }),
    ];
    renderSidebar();
    await screen.findByText("Login");
    const dot = await screen.findByLabelText("All 3 runs passed — 4 steps auto-healed");
    expect(dot.className).toContain("bg-support-green-yellow");
  });

  it("shows no dot for a test that has never run", async () => {
    runRecords = [run({ id: "r-x", testId: "someone-else", startedAt: 50 })];
    renderSidebar();
    await screen.findByText("Login");
    // Flush the runs query before asserting absence — "no dot" only means
    // something once the data that could have drawn one has arrived.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByLabelText(/Last run/)).toBeNull();
  });
});

describe("LibrarySidebar — Duplicate Test", () => {
  it("offers Duplicate Test in a test's context menu", async () => {
    renderSidebar();
    const row = await screen.findByText("Login");
    fireEvent.contextMenu(row);
    expect(await screen.findByText("Duplicate Test")).toBeTruthy();
  });

  it("duplicates immediately when the test has nothing active", async () => {
    renderSidebar();
    await chooseDuplicate();

    await waitFor(() => expect(duplicate).toHaveBeenCalledWith("t1"));
    // No dialog: a prompt that always appears is one nobody reads.
    expect(screen.queryByText(/behave differently in a copy/i)).toBeNull();
  });

  it("navigates to the copy and reports its real name", async () => {
    // A duplication whose only visible result is a sidebar row the user has to
    // find themselves reads as nothing having happened.
    renderSidebar();
    await chooseDuplicate();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t1-copy" } }),
    );
    expect(toastTexts().some((t) => t.type === "success" && t.title.includes("Login [2]"))).toBe(
      true,
    );
  });

  it("reports a failure instead of leaving the click looking successful", async () => {
    duplicate.mockRejectedValueOnce(new Error("Disk is full"));
    renderSidebar();
    await chooseDuplicate();

    await waitFor(() =>
      expect(toastTexts().some((t) => t.type === "error" && t.title === "Disk is full")).toBe(true),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("asks first when the test declares variables", async () => {
    tests = [record({ variables: [{ name: "user", kind: "plain", value: "ada" }] })];
    renderSidebar();
    await chooseDuplicate();

    expect(await screen.findByText(/Duplicate “Login”\?/)).toBeTruthy();
    expect(duplicate).not.toHaveBeenCalled();
  });

  it("asks first when the test records cookies", async () => {
    tests = [record({ steps: [step("click"), step("cookie", "c1")] })];
    renderSidebar();
    await chooseDuplicate();

    expect(await screen.findByText(/1 cookie step/)).toBeTruthy();
    expect(duplicate).not.toHaveBeenCalled();
  });

  it("asks first when a secret has a value stored, even with nothing else active", async () => {
    // The credential case. `secretStatus` is the ONLY source for it — the
    // record never carries a secret's value, so a copy could otherwise take one
    // across with nothing on screen having mentioned it.
    tests = [record({ variables: [{ name: "password", kind: "secret" }] })];
    secretStatus = [{ name: "password", hasValue: true }];
    renderSidebar();
    await chooseDuplicate();

    expect(await screen.findByText(/1 stored secret value/)).toBeTruthy();
  });

  it("duplicates once the dialog is confirmed", async () => {
    tests = [record({ variables: [{ name: "user", kind: "plain", value: "ada" }] })];
    renderSidebar();
    await chooseDuplicate();

    fireEvent.click(await screen.findByRole("button", { name: /^duplicate$/i }));

    await waitFor(() => expect(duplicate).toHaveBeenCalledWith("t1"));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t1-copy" } }),
    );
  });

  it("does nothing when the dialog is dismissed", async () => {
    tests = [record({ variables: [{ name: "user", kind: "plain", value: "ada" }] })];
    renderSidebar();
    await chooseDuplicate();

    // Dismissed by the close "X": the composed dialog's footer no longer
    // carries a Cancel button (renderer/ui/dialog-actions.test.tsx). What must
    // not change is that dismissing copies nothing.
    fireEvent.click(await screen.findByLabelText("Close"));

    await waitFor(() => expect(screen.queryByText(/Duplicate “Login”\?/)).toBeNull());
    expect(duplicate).not.toHaveBeenCalled();
  });

  it("still duplicates when the secret status can't be read", async () => {
    // Losing that one number must not block the action, and must not invent a
    // secrets line the app couldn't verify.
    tests = [record()];
    const api = await import("../lib/api");
    const spy = vi
      .spyOn(api.api.tests, "secretStatus")
      .mockRejectedValueOnce(new Error("no keychain"));
    renderSidebar();
    await chooseDuplicate();

    await waitFor(() => expect(duplicate).toHaveBeenCalledWith("t1"));
    spy.mockRestore();
  });
});
