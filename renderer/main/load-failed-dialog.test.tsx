// The load-failure dialog, and the two structural facts that make it work.
//
// This is a regression suite before it is a component suite. The dialog it
// replaces existed for months and could never open: it was gated on
// `RecorderState.loadFailed`, which the service nulls out of existence before
// the broadcast, and it lived inside `RecordingView`, which is unmounted by the
// same teardown. Every test below either drives the push or pins one of those
// two facts, because the component rendering correctly is not the part that
// was ever broken.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LOAD_FAILED_COPY, LoadFailedDialog } from "./load-failed-dialog";

/** Backend push listeners, keyed by channel. Same harness as the sibling views. */
const listeners: Record<string, ((payload: unknown) => void)[]> = {};

function emit(channel: string, payload: unknown = {}) {
  for (const cb of listeners[channel] ?? []) cb(payload);
}

vi.mock("../lib/api", () => ({
  api: {
    on: (channel: string, cb: (payload: unknown) => void) => {
      (listeners[channel] ??= []).push(cb);
      return () => {
        listeners[channel] = (listeners[channel] ?? []).filter((f) => f !== cb);
      };
    },
  },
}));

const onCheckStats = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(listeners)) delete listeners[key];
});

function renderDialog() {
  return render(<LoadFailedDialog onCheckStats={onCheckStats} />);
}

describe("a failed load reaches the user", () => {
  it("shows nothing until the backend reports a failure", () => {
    renderDialog();
    expect(screen.queryByText(LOAD_FAILED_COPY.title)).toBeNull();
  });

  it("opens on the push, which is the only carrier there is", async () => {
    // The service sets `session.loadFailed = true`, then sets `session = null`,
    // and only then broadcasts. `currentState()` reads `session?.loadFailed ??
    // false`, so the state push says the load did not fail — this event is the
    // entire signal.
    renderDialog();
    emit("recorder:loadFailed", {
      testId: "t1",
      message: "The training window couldn't open for https://example.com.",
    });
    await waitFor(() => expect(screen.getByText(LOAD_FAILED_COPY.title)).toBeTruthy());
  });

  it("repeats the backend's sentence, because only it names the URL", async () => {
    renderDialog();
    emit("recorder:loadFailed", {
      testId: "t1",
      message: "The training window couldn't open for https://example.com.",
    });
    await waitFor(() => expect(screen.getByText(/https:\/\/example\.com/)).toBeTruthy());
  });

  it("still explains itself when the push carries no message", async () => {
    // The event is the fact and the fields are decoration, so a payload-less
    // push must not produce a titled dialog with an empty body — that reads as
    // the app having lost the error rather than reporting it.
    renderDialog();
    emit("recorder:loadFailed", {});
    await waitFor(() => expect(screen.getByText(new RegExp(LOAD_FAILED_COPY.fallback))).toBeTruthy());
  });

  it("sends the user to Stats through the router, not a URL fragment", async () => {
    // The old dialog assigned `window.location.hash = "#/stats"`. This router
    // runs on memory history, so that selected nothing — a dead button on a
    // dialog that never opened.
    renderDialog();
    emit("recorder:loadFailed", { testId: "t1", message: "boom" });
    await waitFor(() => expect(screen.getByText(LOAD_FAILED_COPY.title)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: LOAD_FAILED_COPY.checkStats }));
    expect(onCheckStats).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText(LOAD_FAILED_COPY.title)).toBeNull());
  });

  it("can be dismissed", async () => {
    renderDialog();
    emit("recorder:loadFailed", { testId: "t1", message: "boom" });
    await waitFor(() => expect(screen.getByText(LOAD_FAILED_COPY.title)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: LOAD_FAILED_COPY.dismiss }));
    await waitFor(() => expect(screen.queryByText(LOAD_FAILED_COPY.title)).toBeNull());
  });
});

describe("it is mounted where the teardown cannot reach it", () => {
  // Source-level, because the failure is about WHERE the component is rendered
  // and jsdom cannot observe a mount that the real app's routing would decide.
  // Same idiom as the source pins in window-size.test.ts.
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("is rendered by root-view, outside the shell that swaps on `recording`", () => {
    const src = read("renderer/main/root-view.tsx");
    expect(src).toContain("<LoadFailedDialog");
    // RootShell is what renders `state.recording ? <RecordingView/> : <Outlet/>`.
    // The dialog must be a sibling of it, not inside it.
    const shellClose = src.indexOf("<RootShell />");
    const dialogAt = src.indexOf("<LoadFailedDialog");
    expect(shellClose).toBeGreaterThan(-1);
    expect(dialogAt).toBeGreaterThan(shellClose);
  });

  it("is NOT rendered from the trainer, which unmounts on the failure", () => {
    // `RecordingView` is mounted only while `state.recording`, and a failed load
    // clears the session before it announces itself. Putting the dialog back in
    // there is the original bug, so it is asserted absent rather than trusted.
    expect(read("renderer/main/recording-view.tsx")).not.toContain("LoadFailedDialog");
  });

  it("reads no session state at all", () => {
    // The original was gated on a RecorderState field, and by the time a failed
    // load is announced there is no session left for that state to describe.
    // Touching the store again — for the message, the testId, anything — is how
    // the dialog would silently stop opening, so the dependency is asserted
    // absent rather than merely avoided.
    //
    // Asserted on `useRecorder` rather than on the field name: this file's own
    // header explains the old `state.loadFailed` bug in prose, and a substring
    // check cannot tell an explanation from a use. That is the same
    // comments-are-just-text trap `check:clickable-chrome` documents, met here
    // from the other side — it cost this test one red run to notice.
    expect(read("renderer/main/load-failed-dialog.tsx")).not.toContain("useRecorder");
  });
});
