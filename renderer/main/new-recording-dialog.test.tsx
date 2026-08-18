// The New Recording dialog's window-size preset.
//
// The preset has to survive the whole way from the picker to the training
// window, and its failure mode is silent: a recording made at the wrong size
// looks fine on screen and only diverges later, when the generated test replays
// against a layout it never saw. So what's pinned here is the value handed to
// `start` — not that a control rendered.
//
// The SDK's Select is native-menu-backed, so its options never enter the DOM
// and a selection can't be driven in jsdom (see CLAUDE.md). The persisted
// setting is therefore the way a preset is put in play here, which is also the
// path a returning user actually takes: the dialog reopens on their last
// choice, and pressing Start must use it without touching the picker.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { RecorderSettings } from "../lib/recorder-types";
import { NewRecordingDialog } from "./new-recording-dialog";

// Typed to the real signatures — an untyped vi.fn() infers zero arguments, and
// the assertions below are entirely about which argument carries the size.
const start = vi.fn(
  async (
    _url: string,
    _name: string,
    _testId?: string,
    _viewport?: { width: number; height: number } | null,
    _runBrowser?: string,
  ) => {},
);
const setSettings = vi.fn(async (_update: Partial<RecorderSettings>) => ({}) as RecorderSettings);
let settings: Partial<RecorderSettings> = {};
let settingsReadable = true;

vi.mock("./recorder-store", () => ({
  useRecorder: () => ({ start }),
}));

vi.mock("../lib/api", () => ({
  api: {
    recorder: {
      getSettings: async () => {
        if (!settingsReadable) throw new Error("settings unavailable");
        return settings;
      },
      setSettings: (update: Partial<RecorderSettings>) => setSettings(update),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  settings = {};
  settingsReadable = true;
});

const onOpenChange = vi.fn();

function open() {
  render(<NewRecordingDialog open onOpenChange={onOpenChange} />);
}

async function startRecording(url = "https://example.com") {
  fireEvent.change(screen.getByPlaceholderText("https://example.com"), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
  await waitFor(() => expect(start).toHaveBeenCalled());
}

/** The runBrowser argument `start` was called with (5th). */
function startedBrowser() {
  return start.mock.calls[0]?.[4];
}

/** The viewport argument `start` was called with. */
function startedViewport() {
  return start.mock.calls[0]?.[3];
}

describe("window size preset", () => {
  it("offers a size to record at", async () => {
    // The gap this closes: the dialog asked for a URL, a name and a speed, and
    // gave no way to say how big the browser window should be.
    open();
    await waitFor(() => expect(screen.getByText("Window size")).toBeTruthy());
  });

  it("records at the persisted preset", async () => {
    settings = { defaultWindowSize: { width: 390, height: 844 } };
    open();
    // Wait for the persisted setting to land before confirming — otherwise this
    // passes against the pre-load default and proves nothing.
    await waitFor(() => expect(screen.getByText("Mobile 390×844")).toBeTruthy());
    await startRecording();
    expect(startedViewport()).toEqual({ width: 390, height: 844 });
  });

  it("passes no size when the preset is Default", async () => {
    // Null, not a fabricated 1280×800: with no preset the trainer keeps its own
    // window size and the recording gets no viewport step at all.
    settings = { defaultWindowSize: null };
    open();
    await waitFor(() => expect(screen.getByText("Default")).toBeTruthy());
    await startRecording();
    expect(startedViewport()).toBeNull();
  });

  it("falls back to Default for a stored size matching no preset", async () => {
    // A hand-edited settings file, or a preset dropped in a later version. The
    // picker has to show something it can offer rather than a blank trigger.
    settings = { defaultWindowSize: { width: 1234, height: 567 } };
    open();
    await waitFor(() => expect(screen.getByText("Default")).toBeTruthy());
    await startRecording();
    expect(startedViewport()).toBeNull();
  });

  it("still records, at the default size, when settings can't be read", async () => {
    // A failed settings read must leave the dialog usable — the preset is a
    // convenience, and losing it is not a reason to be unable to record.
    settingsReadable = false;
    open();
    await startRecording();
    expect(startedViewport()).toBeNull();
  });

  it("starts a new recording rather than editing an existing test", async () => {
    // The viewport is the 4th argument and the engine the 5th; passing either
    // must not shift the testId into the wrong slot, which would silently turn
    // Start into Edit. Spelled as an exhaustive argument list for that reason —
    // a positional bug here is invisible in every other assertion.
    settings = { defaultWindowSize: { width: 768, height: 1024 } };
    open();
    await waitFor(() => expect(screen.getByText("Tablet 768×1024")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("My test"), { target: { value: "My run" } });
    await startRecording();
    expect(start).toHaveBeenCalledWith(
      "https://example.com",
      "My run",
      undefined,
      { width: 768, height: 1024 },
      // Untouched picker → nothing stored, so the test inherits the default.
      undefined,
    );
  });
});

// ── The dialog closes once the recording has started ──────────────────────
//
// The bug this pins (docs/issue-audit/fix-137.md): the composed `Dialog`'s
// confirm calls `onConfirm()` and nothing else — it never closes. This dialog
// is mounted by the library rail's `+` menu and the ⌘K palette, both OUTSIDE
// the outlet `RootShell` swaps for `RecordingView`, so the modal and its
// full-viewport Radix overlay stayed over the main window for the rest of the
// session, pointer-blocking everything behind them. The Home-view path unmounts
// its own copy with the swap, which is why the path most people test is the one
// path that looks fixed.
describe("dialog lifecycle", () => {
  it("closes once the recording has started", async () => {
    open();
    await startRecording();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("stays open when start fails", async () => {
    // The other half, and the reason this is a per-caller close rather than a
    // restored auto-close: a recording that could not start must leave the URL
    // on screen to correct, not vanish behind a dialog that closed anyway.
    start.mockRejectedValueOnce(new Error("no such host"));
    open();
    fireEvent.change(screen.getByPlaceholderText("https://example.com"), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    await waitFor(() => expect(start).toHaveBeenCalled());

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

// ── The browser picker ────────────────────────────────────────────────────
//
// The engine was settable only from the test-detail toolbar — only AFTER the
// test existed — so every test was born on the global default and a user who
// wanted WebKit discovered that from the first red run.
//
// What is pinned here is the ASYMMETRY, which is the whole design: an untouched
// picker stores NOTHING, so the test keeps inheriting `defaultRunBrowser` and
// changing that setting later still moves it. Storing the seeded value on every
// new test would quietly retire the Settings default, since nothing would be
// left inheriting it.
describe("browser picker", () => {
  it("offers an engine to run in", async () => {
    open();
    await waitFor(() => expect(screen.getByText("Browser")).toBeTruthy());
  });

  it("starts on the global default", async () => {
    settings = { defaultRunBrowser: "firefox" };
    open();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Firefox" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
  });

  it("stores nothing when the picker is left alone", async () => {
    // The inheritance case, and the one a "just store what the control shows"
    // implementation gets wrong.
    settings = { defaultRunBrowser: "firefox" };
    open();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Firefox" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    await startRecording();
    expect(startedBrowser()).toBeUndefined();
  });

  it("pins the engine when the picker is moved off the default", async () => {
    settings = { defaultRunBrowser: "chromium" };
    open();
    await waitFor(() => expect(screen.getByRole("button", { name: "WebKit" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "WebKit" }));
    await startRecording();
    expect(startedBrowser()).toBe("webkit");
  });

  it("stores nothing again when the picker is moved back to the default", async () => {
    // Off and back is not the same as never touched to a store that latches on
    // the first change — but it IS the same to the user, and the field's
    // meaning is about the value, not the history.
    settings = { defaultRunBrowser: "chromium" };
    open();
    await waitFor(() => expect(screen.getByRole("button", { name: "WebKit" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "WebKit" }));
    fireEvent.click(screen.getByRole("button", { name: "Chromium" }));
    await startRecording();
    expect(startedBrowser()).toBeUndefined();
  });

  it("still records, on the inherited engine, when settings can't be read", async () => {
    settingsReadable = false;
    open();
    await startRecording();
    expect(startedBrowser()).toBeUndefined();
  });
});
