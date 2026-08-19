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
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toastTexts, clearToastCalls } from "../__tests__/sonner-stub";

import type {
  RecorderSettings,
  RunRecord,
  SecretStatus,
  Step,
  TestRecord,
} from "../lib/recorder-types";
import { LibrarySidebar } from "./library-sidebar";
import { withAiDebug } from "../__tests__/ai-debug-harness";

let tests: TestRecord[] = [];
/** Only the two keys the rail reads. Cast at the call site rather than built
 *  out in full: a complete `RecorderSettings` literal here would need updating
 *  for every unrelated setting the app grows. */
let settings: Partial<RecorderSettings> = {};
let secretStatus: SecretStatus[] = [];
let runRecords: RunRecord[] = [];

const navigate = vi.fn();
/** The open test, as the router reports it. Mutable so a test can put one in
 *  the address bar — selection is derived from it. */
let routeParams: { id?: string } = {};
const setGroup = vi.fn(
  async (_id: string, _group: string): Promise<TestRecord> => record(),
);
const renameGroup = vi.fn(async (from: string, to: string) => ({
  from,
  to,
  changed: 1,
}));
const setSettings = vi.fn(
  async (_patch: Partial<RecorderSettings>) => settings as RecorderSettings,
);
const duplicate = vi.fn(
  async (id: string): Promise<TestRecord> => ({
    ...record({ id: "copy" }),
    name: "Login [2]",
    id: `${id}-copy`,
  }),
);

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => routeParams,
  useRouterState: () => "/",
}));

// The rail lists saved Routines while the Routines screen is open (REDESIGN
// §7.1), and the selection lives in the recorder store. Stubbed for the same
// reason the dialogs below are: the real provider owns the whole recording
// session, and `useRouterState` above answers "/" here, so this file only ever
// renders the library half.
vi.mock("./recorder-store", () => ({
  useRecorder: () => ({ openRoutineId: null, setOpenRoutineId: () => {} }),
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
      setGroup: (id: string, group: string) => setGroup(id, group),
      renameGroup: (from: string, to: string) => renameGroup(from, to),
    },
    // The rail reads settings for two things: the site-icon egress switch and
    // which folders are collapsed. Both come back from this one query.
    recorder: {
      getSettings: async () => settings,
      setSettings: (patch: Partial<RecorderSettings>) => setSettings(patch),
    },
    llm: {
      getConfig: async () => ({ provider: "ollama" }),
      status: async () => ({ reachable: true, models: [] }),
    },
    runs: { list: async () => runRecords },
    // The sidebar asks whether the branch switcher is available before it
    // offers the row. Unavailable is the right default here: these tests are
    // about the library, and a Branches row in them would only be noise.
    branches: {
      status: async () => ({
        available: false,
        switched: false,
        hasToken: false,
      }),
    },
    // The AI debug provider (now above the sidebar for the row sparkles)
    // hydrates persisted sessions on mount and subscribes to pushes.
    aiDebug: {
      list: async () => [],
      save: async (session: unknown) => session,
      remove: async () => ({ removed: 0 }),
      clear: async () => ({ removed: 0 }),
      notifyDone: async () => ({ ok: true }),
      history: async () => [],
      record: async (r: unknown) => r,
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      {withAiDebug(<LibrarySidebar />)}
    </QueryClientProvider>,
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
  settings = {};
  routeParams = {};
  secretStatus = [];
  runRecords = [];
  navigate.mockClear();
  duplicate.mockClear();
  setGroup.mockClear();
  renameGroup.mockClear();
  setSettings.mockClear();
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
      expect(navigate).toHaveBeenCalledWith({
        to: "/test/$id",
        params: { id: "t1" },
      }),
    );
  });

  it("navigates from a views row on a plain click", async () => {
    renderSidebar();
    fireEvent.click(await screen.findByText("Stats"));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/stats" }),
    );
  });

  it("offers every view, by the name a person reads", async () => {
    // PINNED HERE BECAUSE THE E2E SUITE PINS IT TOO, and the local gate does
    // not run the e2e suite (CLAUDE.md). `app-launch.spec.ts` asserts these
    // four names inside the "Views" group; renaming Batch → Routines for §7.1
    // turned that red on CI with nothing locally to catch it first. This is the
    // same claim in the same words, in a file the gate does run — a rename now
    // fails in a minute rather than after a push.
    renderSidebar();
    const nav = document.querySelector(".gl-rail-nav") as HTMLElement;
    for (const name of ["Stats", "Visual", "Routines", "Heals"]) {
      expect(nav.textContent).toContain(name);
    }
  });

  it("marks the open test as selected, and nothing else", async () => {
    // Neutral selection is invisible to jsdom (no cascade, `css: false`), so
    // the attribute the stylesheet selects on IS the assertion — and it is the
    // one `check:selection-neutral` reads too.
    tests = [
      record({ id: "t1", name: "Login" }),
      record({ id: "t2", name: "Signup" }),
    ];
    routeParams = { id: "t1" };
    renderSidebar();
    await screen.findByText("Login");

    const rows = [
      ...document.querySelectorAll(".gl-rail-row"),
    ] as HTMLElement[];
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
      run({
        id: "r-c",
        batchId: "b1",
        runBrowser: "chromium",
        status: "passed",
        startedAt: 10,
      }),
      run({
        id: "r-f",
        batchId: "b1",
        runBrowser: "firefox",
        status: "passed",
        startedAt: 11,
      }),
      run({
        id: "r-w",
        batchId: "b1",
        runBrowser: "webkit",
        status: "failed",
        startedAt: 12,
      }),
    ];
    renderSidebar();
    await screen.findByText("Login");
    const dot = await screen.findByLabelText("2 of 3 runs passed");
    expect(dot.className).toContain("bg-support-yellow-orange");
    expect(dot.className).not.toContain("bg-support-red");
  });

  it("marks a passing batch that leaned on Auto-Heal", async () => {
    runRecords = [
      run({
        id: "r-c",
        batchId: "b1",
        status: "passed",
        startedAt: 10,
        healedSteps: 2,
      }),
      run({
        id: "r-f",
        batchId: "b1",
        status: "passed",
        startedAt: 11,
        healedSteps: 2,
      }),
      run({
        id: "r-w",
        batchId: "b1",
        status: "passed",
        startedAt: 12,
        healedSteps: 0,
      }),
    ];
    renderSidebar();
    await screen.findByText("Login");
    const dot = await screen.findByLabelText(
      "All 3 runs passed — 4 steps auto-healed",
    );
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
      expect(navigate).toHaveBeenCalledWith({
        to: "/test/$id",
        params: { id: "t1-copy" },
      }),
    );
    expect(
      toastTexts().some(
        (t) => t.type === "success" && t.title.includes("Login [2]"),
      ),
    ).toBe(true);
  });

  it("reports a failure instead of leaving the click looking successful", async () => {
    duplicate.mockRejectedValueOnce(new Error("Disk is full"));
    renderSidebar();
    await chooseDuplicate();

    await waitFor(() =>
      expect(
        toastTexts().some(
          (t) => t.type === "error" && t.title === "Disk is full",
        ),
      ).toBe(true),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("asks first when the test declares variables", async () => {
    tests = [
      record({ variables: [{ name: "user", kind: "plain", value: "ada" }] }),
    ];
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
    tests = [
      record({ variables: [{ name: "user", kind: "plain", value: "ada" }] }),
    ];
    renderSidebar();
    await chooseDuplicate();

    fireEvent.click(
      await screen.findByRole("button", { name: /^duplicate$/i }),
    );

    await waitFor(() => expect(duplicate).toHaveBeenCalledWith("t1"));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/test/$id",
        params: { id: "t1-copy" },
      }),
    );
  });

  it("does nothing when the dialog is dismissed", async () => {
    tests = [
      record({ variables: [{ name: "user", kind: "plain", value: "ada" }] }),
    ];
    renderSidebar();
    await chooseDuplicate();

    // Dismissed by the close "X": the composed dialog's footer no longer
    // carries a Cancel button (renderer/ui/dialog-actions.test.tsx). What must
    // not change is that dismissing copies nothing.
    fireEvent.click(await screen.findByLabelText("Close"));

    await waitFor(() =>
      expect(screen.queryByText(/Duplicate “Login”\?/)).toBeNull(),
    );
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

describe("LibrarySidebar folders (REDESIGN §7.2)", () => {
  /** Two tests in one folder plus one loose, which is the shape every question
   *  below needs: a header, members under it, and a row that is not in it. */
  function library() {
    tests = [
      record({ id: "t1", name: "Login", group: "Storefront" }),
      record({ id: "t2", name: "Checkout", group: "Storefront" }),
      record({ id: "t3", name: "Search" }),
    ];
  }

  it("draws a folder above its members, with a count, and does not draw a folder for the loose test", async () => {
    library();
    renderSidebar();

    const folder = await screen.findByRole("button", { name: /Storefront/ });
    expect(folder).toBeTruthy();
    expect(within(folder).getByText("2 tests")).toBeTruthy();
    // The count is of THIS folder, not of the library: `Search` is loose and
    // must not be in it.
    expect(tests).toHaveLength(3);
    // Every test is still reachable — a folder hides nothing while open.
    expect(await screen.findByText("Login")).toBeTruthy();
    expect(screen.getByText("Checkout")).toBeTruthy();
    expect(screen.getByText("Search")).toBeTruthy();
    // …and only ONE header, so the loose test did not grow one.
    expect(document.querySelectorAll(".gl-rail-group-row")).toHaveLength(1);
  });

  it("counts what is actually in the folder, in the singular when there is one", async () => {
    // A hardcoded plural passes against a two-member fixture forever, and the
    // count is the one number a collapsed folder still gives you.
    tests = [
      record({ id: "t1", name: "Login", group: "Storefront" }),
      record({ id: "t2", name: "Checkout", group: "Admin" }),
      record({ id: "t3", name: "Search", group: "Admin" }),
      record({ id: "t4", name: "Signup", group: "Admin" }),
    ];
    renderSidebar();

    const admin = await screen.findByRole("button", { name: /Admin/ });
    expect(within(admin).getByText("3 tests")).toBeTruthy();
    const store = screen.getByRole("button", { name: /Storefront/ });
    expect(within(store).getByText("1 test")).toBeTruthy();
  });

  it("indents the members and not the loose test, which is what says they are inside", async () => {
    library();
    renderSidebar();
    await screen.findByText("Login");
    expect(document.querySelectorAll(".gl-rail-row-nested")).toHaveLength(2);
  });

  it("is NOT selectable, even when one of its tests is open", async () => {
    // A folder is not a destination — there is no group screen — and a second
    // `data-selected` row would make the rail's selection mean two things.
    library();
    routeParams = { id: "t1" };
    renderSidebar();
    const folder = await screen.findByRole("button", { name: /Storefront/ });
    expect(folder.hasAttribute("data-selected")).toBe(false);
    expect(
      document.querySelectorAll(".gl-rail-row[data-selected]"),
    ).toHaveLength(1);
  });

  it("aggregates its members' verdicts into one dot, counting TESTS", async () => {
    library();
    runRecords = [
      run({ id: "a", testId: "t1", status: "passed" }),
      run({ id: "b", testId: "t2", status: "failed" }),
    ];
    renderSidebar();
    // The label, not the colour: colour alone is not an accessible signal and
    // jsdom would report a class either way.
    expect(await screen.findByLabelText("1 of 2 tests passed")).toBeTruthy();
  });

  it("collapses, and its members LEAVE THE LIST rather than being hidden", async () => {
    // Rows still in the DOM are still in the tab order and still in a screen
    // reader's list, so the number of rows would stop matching the count on
    // the header — the one number a folder exists to give.
    library();
    settings = { collapsedTestGroups: ["Storefront"] };
    renderSidebar();

    await screen.findByRole("button", { name: /Storefront/ });
    await waitFor(() => expect(screen.queryByText("Login")).toBeNull());
    expect(screen.queryByText("Checkout")).toBeNull();
    // The loose test is untouched, and the header still counts what is inside.
    expect(screen.getByText("Search")).toBeTruthy();
    expect(screen.getByText("2 tests")).toBeTruthy();
  });

  it("persists the collapse, so a folder does not spring open on the next launch", async () => {
    library();
    renderSidebar();
    const folder = await screen.findByRole("button", { name: /Storefront/ });
    expect(folder.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(folder);

    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith({
        collapsedTestGroups: ["Storefront"],
      }),
    );
    // And the row reports its new state without waiting for the write — a
    // disclosure that waits for a round trip reads as a dead control on the
    // click that matters most.
    expect(
      screen
        .getByRole("button", { name: /Storefront/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("expands again — the half that matters", async () => {
    library();
    settings = { collapsedTestGroups: ["Storefront"] };
    renderSidebar();
    const folder = await screen.findByRole("button", { name: /Storefront/ });

    fireEvent.click(folder);

    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith({ collapsedTestGroups: [] }),
    );
  });

  it("moves a test into an existing folder from its own menu", async () => {
    library();
    renderSidebar();
    const row = await screen.findByText("Search");
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("Move to Group"));
    // `getByRole("menuitem")`, not `getByText`: the folder's own header row
    // carries the same word, and an ambiguous query retries until timeout and
    // then reports "never rendered" rather than "your query matched two".
    fireEvent.click(await screen.findByRole("menuitem", { name: "Storefront" }));

    await waitFor(() =>
      expect(setGroup).toHaveBeenCalledWith("t3", "Storefront"),
    );
  });

  it("moves a test OUT of its folder with None", async () => {
    library();
    renderSidebar();
    const row = await screen.findByText("Login");
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("Move to Group"));
    fireEvent.click(await screen.findByText("None"));

    await waitFor(() => expect(setGroup).toHaveBeenCalledWith("t1", ""));
  });

  it("deletes a folder by moving its members to the top level", async () => {
    // There is no group record to remove, so this is the only deletion there
    // is — and nothing is destroyed, which is why it needs no confirmation.
    library();
    renderSidebar();
    const folder = await screen.findByRole("button", { name: /Storefront/ });
    fireEvent.contextMenu(folder);
    fireEvent.click(await screen.findByText("Ungroup Tests"));

    await waitFor(() =>
      expect(renameGroup).toHaveBeenCalledWith("Storefront", ""),
    );
  });

  it("renames a folder, and the rename does not spring it open", async () => {
    // The collapsed list is keyed by NAME, so a rename has to carry the state
    // across or every folder the user had shut opens under them.
    library();
    settings = { collapsedTestGroups: ["Storefront"] };
    renderSidebar();
    const folder = await screen.findByRole("button", { name: /Storefront/ });
    fireEvent.contextMenu(folder);
    fireEvent.click(await screen.findByText("Rename Group…"));

    const field = await screen.findByLabelText("Group name");
    expect((field as HTMLInputElement).value).toBe("Storefront");
    fireEvent.change(field, { target: { value: "Shop" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() =>
      expect(renameGroup).toHaveBeenCalledWith("Storefront", "Shop"),
    );
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith({
        collapsedTestGroups: ["Shop"],
      }),
    );
  });

  it("creating a folder and joining one are the SAME gesture", async () => {
    // A group is its members, so an "add group" command would make a row that
    // disappeared on the next read.
    library();
    renderSidebar();
    const row = await screen.findByText("Search");
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("Move to Group"));
    fireEvent.click(await screen.findByText("New Group…"));

    const field = await screen.findByLabelText("Group name");
    fireEvent.change(field, { target: { value: "Admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(setGroup).toHaveBeenCalledWith("t3", "Admin"));
  });

  it("refuses an empty name rather than treating it as ungroup", async () => {
    // Deleting a folder has its own command with its own words. Getting there
    // by clearing a text field would be destructive with no way to tell it
    // apart from a slip.
    library();
    renderSidebar();
    const row = await screen.findByText("Search");
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("Move to Group"));
    fireEvent.click(await screen.findByText("New Group…"));

    const field = await screen.findByLabelText("Group name");
    fireEvent.change(field, { target: { value: "   " } });
    expect(
      screen.getByRole("button", { name: "Move" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(setGroup).not.toHaveBeenCalled();
  });
});

describe("LibrarySidebar — the Flows section", () => {
  it("lists a flow under its own section instead of among the tests", async () => {
    tests = [
      record({ id: "t1", name: "Checkout" }),
      record({ id: "f1", name: "Sign in", isFlow: true, group: "Storefront" }),
    ];
    renderSidebar();
    // The section exists and carries the flow's row.
    expect(await screen.findByText("Flows")).toBeTruthy();
    expect(await screen.findByText("Sign in")).toBeTruthy();
    // The flow left its folder — its place is the section, so its old group
    // has no remaining member and must not be drawn as an empty folder.
    expect(screen.queryByText("Storefront")).toBeNull();
  });

  it("marks a flow's row with the Workflow glyph", async () => {
    tests = [record({ id: "f1", name: "Sign in", isFlow: true })];
    renderSidebar();
    await screen.findByText("Sign in");
    expect(screen.getByLabelText("Reusable flow")).toBeTruthy();
  });

  it("draws no Flows section when the library has no flows", async () => {
    tests = [record({ id: "t1", name: "Checkout" })];
    renderSidebar();
    await screen.findByText("Checkout");
    expect(screen.queryByText("Flows")).toBeNull();
  });
});
