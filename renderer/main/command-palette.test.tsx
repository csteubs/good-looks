// The palette as a control. REDESIGN §6.7.
//
// The ranking is tested in `renderer/lib/command-palette.test.ts`. What is here
// is the wiring, and every one of these fails quietly if it breaks: a shortcut
// that does not open, a row that navigates somewhere else, Enter running the
// wrong command because the selection was left pointing past the end of a list
// that shrank under it, or a run started on a screen the user is not looking at.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { RunRecord, TestRecord } from "../lib/recorder-types";
import { CommandPalette, isPaletteChord, useCommandPalette } from "./command-palette";

let tests: TestRecord[] = [];
let runs: RunRecord[] = [];

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const runTest = vi.fn();
vi.mock("./recorder-store", () => ({ useRecorder: () => ({ run: runTest }) }));

const batchRun = vi.fn(async () => ({ batchId: "b1", alreadyRunning: false }));
vi.mock("../lib/api", () => ({
  api: {
    tests: { list: async () => tests },
    runs: { list: async () => runs },
    batch: { run: (...args: unknown[]) => batchRun(...(args as [])) },
  },
}));

// The two dialogs reach the backend and native menus on mount. Stubbed to a
// marker so "the Record row opens the recording dialog" is assertable without
// dragging the trainer's whole world into this file.
vi.mock("./new-recording-dialog", () => ({
  NewRecordingDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="record-dialog" /> : null,
}));
vi.mock("./generate-test-dialog", () => ({
  GenerateTestDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="generate-dialog" /> : null,
}));

function test_(over: Partial<TestRecord> & { id: string; name: string }): TestRecord {
  return {
    url: "https://shop.example.com",
    createdAt: 0,
    updatedAt: 0,
    steps: [],
    ...over,
  } as TestRecord;
}

function run_(over: Partial<RunRecord> & { id: string; startedAt: number }): RunRecord {
  return {
    testId: "t1",
    testName: "Checkout",
    url: "https://shop.example.com",
    status: "passed",
    exitCode: 0,
    finishedAt: over.startedAt + 1,
    durationMs: 1,
    logFile: "/x.log",
    logBytes: 1,
    ...over,
  };
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CommandPalette />
    </QueryClientProvider>,
  );
}

const chord = () =>
  fireEvent.keyDown(window, { key: "k", metaKey: true });

const palette = () => document.querySelector('[data-gl="command-palette"]');
const input = () => screen.getByRole("combobox") as HTMLInputElement;
const rows = () => screen.queryAllByRole("option");
const selectedRow = () => rows().find((r) => r.getAttribute("aria-selected") === "true");

beforeEach(() => {
  tests = [
    test_({ id: "t-checkout", name: "Checkout — happy path", tags: ["smoke", "cart"] }),
    test_({
      id: "t-login",
      name: "Login — wrong password",
      url: "https://app.example.com/login",
      tags: ["smoke"],
    }),
  ];
  runs = [];
  navigate.mockClear();
  runTest.mockClear();
  batchRun.mockClear();
});

describe("the chord", () => {
  it("is ⌘K and Ctrl+K, in either case", () => {
    // Both everywhere rather than sniffing the platform: this also runs in a
    // browser tab under `dev:web`, and no other shortcut in the app uses K.
    expect(isPaletteChord({ key: "k", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isPaletteChord({ key: "K", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isPaletteChord({ key: "k", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isPaletteChord({ key: "j", metaKey: true, ctrlKey: false })).toBe(false);
  });

  it("opens and closes the palette", () => {
    mount();
    expect(palette()).toBeNull();
    chord();
    expect(palette()).toBeTruthy();
    chord();
    expect(palette()).toBeNull();
  });

  it("focuses the input on open, so the next keystroke is the query", () => {
    mount();
    chord();
    expect(document.activeElement).toBe(input());
  });

  it("closes on Escape", () => {
    mount();
    chord();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(palette()).toBeNull();
  });

  it("reopens blank, never on the last query", () => {
    mount();
    chord();
    fireEvent.change(input(), { target: { value: "login" } });
    chord();
    chord();
    expect(input().value).toBe("");
  });
});

describe("the list", () => {
  it("offers the actions first with nothing typed", async () => {
    mount();
    chord();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(rows()[0].textContent).toContain("Record a test");
    expect(rows()[1].textContent).toContain("Generate from prompt");
  });

  it("groups a browsed list and flattens a searched one", async () => {
    mount();
    chord();
    await waitFor(() => expect(screen.queryByText("Views")).toBeTruthy());
    // The group headings are a reading aid for a list being browsed. Once a
    // query has ranked the list, its order IS the answer and re-grouping would
    // destroy exactly the information the search produced.
    fireEvent.change(input(), { target: { value: "stat" } });
    expect(screen.queryByText("Views")).toBeNull();
  });

  it("lists every test twice — open it, and run it", async () => {
    mount();
    chord();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    fireEvent.change(input(), { target: { value: "checkout" } });
    const titles = rows().map((r) => r.textContent);
    expect(titles.some((t) => t?.startsWith("Checkout — happy path"))).toBe(true);
    expect(titles.some((t) => t?.startsWith("Run Checkout — happy path"))).toBe(true);
  });

  it("offers one row per tag, counting what it would run", async () => {
    mount();
    chord();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    fireEvent.change(input(), { target: { value: "smoke" } });
    // "Run smoke" is a very different proposition at 2 tests and at 40, and the
    // palette is the one surface with no list to check first.
    const row = rows().find((r) => r.textContent?.includes("Run tag: smoke"));
    expect(row?.textContent).toContain("2 tests");
  });

  it("says so rather than showing an empty box when nothing matches", async () => {
    mount();
    chord();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    fireEvent.change(input(), { target: { value: "zzzzz" } });
    expect(rows()).toEqual([]);
    expect(screen.getByText(/nothing matches/i)).toBeTruthy();
  });

  it("offers the last failure only when there is one", async () => {
    mount();
    chord();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(screen.queryByText(/last failure/i)).toBeNull();
  });

  it("names the most recent failure, ignoring a deleted test's tombstone", async () => {
    runs = [
      run_({ id: "r1", startedAt: 10, status: "failed", exitCode: 1, testName: "Old" }),
      // Newer, but its test is gone — every surface that NAMES a test hides
      // these, and a palette row leading nowhere is a dead end wearing a name.
      run_({
        id: "r2",
        startedAt: 20,
        status: "failed",
        exitCode: 1,
        testName: "Deleted",
        testDeleted: true,
      }),
    ];
    mount();
    chord();
    await waitFor(() => expect(screen.queryByText(/last failure/i)).toBeTruthy());
    expect(screen.getByText(/last failure/i).textContent).toContain("Old");
  });
});

describe("the keyboard", () => {
  it("moves the selection and wraps at both ends", async () => {
    mount();
    chord();
    await waitFor(() => expect(rows().length).toBeGreaterThan(2));
    expect(selectedRow()?.textContent).toContain("Record a test");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(selectedRow()?.textContent).toContain("Generate from prompt");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(selectedRow()).toBe(rows()[rows().length - 1]);
  });

  it("points aria-activedescendant at the selected row", async () => {
    // The whole reason this is a combobox rather than a list of buttons: the
    // rows never take focus, so this attribute is the only thing telling a
    // screen reader which one Enter would run.
    mount();
    chord();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(input().getAttribute("aria-activedescendant")).toBe(selectedRow()?.id);
  });

  it("runs the one remaining row after a query narrows the list", async () => {
    // The clamp itself is tested in the lib — it guards a background refetch,
    // and no keystroke can reach it because typing resets the selection.
    mount();
    chord();
    await waitFor(() => expect(rows().length).toBeGreaterThan(4));
    for (let i = 0; i < 4; i++) fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.change(input(), { target: { value: "Run tag: smoke" } });
    expect(rows().length).toBe(1);
    expect(selectedRow()).toBe(rows()[0]);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(batchRun).toHaveBeenCalledTimes(1);
  });

  it("resets the selection to the top on every keystroke", async () => {
    mount();
    chord();
    await waitFor(() => expect(rows().length).toBeGreaterThan(2));
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.change(input(), { target: { value: "l" } });
    expect(selectedRow()).toBe(rows()[0]);
  });
});

describe("running a command", () => {
  async function pick(query: string, label: RegExp) {
    mount();
    chord();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    fireEvent.change(input(), { target: { value: query } });
    const row = rows().find((r) => label.test(r.textContent ?? ""));
    expect(row).toBeTruthy();
    // `mouseDown`, not `click`: the input holds focus and a click blurs it
    // first, which on a palette that dismisses on blur would take the row out
    // from under the pointer.
    fireEvent.mouseDown(row!);
  }

  it("opens a test, and closes", async () => {
    await pick("checkout", /^Checkout/);
    expect(navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t-checkout" } });
    expect(palette()).toBeNull();
  });

  it("navigates BEFORE it starts a run", async () => {
    // A run streams its output into the detail view's panel. Starting one the
    // user cannot see is the app doing something invisible on their behalf.
    await pick("run checkout", /^Run Checkout/);
    expect(navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t-checkout" } });
    expect(runTest).toHaveBeenCalledWith("t-checkout", undefined, undefined, undefined);
    expect(navigate.mock.invocationCallOrder[0]).toBeLessThan(
      runTest.mock.invocationCallOrder[0],
    );
  });

  it("runs a tag as a batch, on the Batch screen", async () => {
    await pick("smoke", /Run tag: smoke/);
    expect(navigate).toHaveBeenCalledWith({ to: "/batch" });
    expect(batchRun).toHaveBeenCalledWith(["t-checkout", "t-login"]);
  });

  it("opens a view", async () => {
    await pick("stat", /^Stats/);
    expect(navigate).toHaveBeenCalledWith({ to: "/stats" });
  });

  it("opens the recording dialog, which outlives the palette", async () => {
    await pick("record", /Record a test/);
    expect(palette()).toBeNull();
    expect(screen.getByTestId("record-dialog")).toBeTruthy();
  });

  it("opens the generate dialog", async () => {
    await pick("generate", /Generate from prompt/);
    expect(screen.getByTestId("generate-dialog")).toBeTruthy();
  });
});

describe("the ⌘K opener offered to the strip", () => {
  function Cap() {
    const setOpen = useCommandPalette();
    if (!setOpen) return <span data-testid="no-palette" />;
    return (
      <button type="button" onClick={() => setOpen(true)}>
        cap
      </button>
    );
  }

  it("opens the palette from outside it", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CommandPalette>
          <Cap />
        </CommandPalette>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("cap"));
    expect(palette()).toBeTruthy();
  });

  it("is null with no palette above, so a caller can render nothing", () => {
    // The settings window and the trainer panel have their own roots and no
    // command list. A key cap there would be exactly the promise the app cannot
    // keep that this slot was left empty to avoid.
    render(<Cap />);
    expect(screen.getByTestId("no-palette")).toBeTruthy();
  });
});
