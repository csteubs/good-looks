// Tests for the Diagnostics pane (named "Advanced" until B4).
//
// Small, but it carries one fact that is easy to lose in an edit: the keyboard
// shortcut works WHETHER OR NOT the toggle is on. The toggle only adds the
// ability for a connected client to ask for a fresh shot. Someone trimming this
// copy would naturally cut the distinction, and the result reads as "turn this
// on to take screenshots" — which would have people enabling a background
// watcher they don't need.

import { describe, it, expect } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { DiagnosticsPane } from "./diagnostics-pane";

describe("debug screenshots", () => {
  it("is off by default", () => {
    renderPane(<DiagnosticsPane />);
    const sw = screen.getByRole("switch", { name: /debug screenshots/i });
    expect(sw.getAttribute("aria-checked") ?? sw.getAttribute("data-state")).toMatch(
      /false|unchecked/i,
    );
  });

  it("saves being turned on", () => {
    const { controller } = renderPane(<DiagnosticsPane />);
    fireEvent.click(screen.getByRole("switch", { name: /debug screenshots/i }));
    expect(savedPatch(controller)).toEqual({ debugScreenshots: true });
  });

  it("shows the real shortcut when the backend reports one", () => {
    const controller = makeController({ debugShortcut: "⌃⌥P" });
    renderPane(<DiagnosticsPane />, { controller });
    expect(screen.getByText("⌃⌥P")).toBeTruthy();
  });

  it("falls back to a printed shortcut rather than an empty keycap", () => {
    // `debug:shortcut` starts as "" and stays "" if the call fails. An empty
    // <code> renders as a stray grey box mid-sentence.
    const controller = makeController({ debugShortcut: "" });
    renderPane(<DiagnosticsPane />, { controller });
    expect(screen.getByText("⌘⌥⇧S")).toBeTruthy();
  });

  it("says the shortcut works whether or not the toggle is on", () => {
    renderPane(<DiagnosticsPane />);
    expect(screen.getByText(/whether or not this is on/i)).toBeTruthy();
  });

  it("explains what the toggle actually adds, behind the disclosure", () => {
    const { container } = renderPane(<DiagnosticsPane />);
    const row = container.querySelector('[data-setting-row="debug-screenshots"]');
    fireEvent.click(row?.querySelector("button[aria-expanded]") as HTMLButtonElement);
    expect(screen.getByText(/ASK for a fresh screenshot/i)).toBeTruthy();
    // And why it is off by default.
    expect(screen.getByText(/keeps a small watcher running/i)).toBeTruthy();
  });
});

describe("capture now", () => {
  it("captures", async () => {
    const { controller } = renderPane(<DiagnosticsPane />);
    fireEvent.click(screen.getByRole("button", { name: /^capture$/i }));
    await waitFor(() => expect(controller.captureNow).toHaveBeenCalledTimes(1));
  });

  it("disables itself and says so while capturing", () => {
    const controller = makeController({ capturing: true });
    renderPane(<DiagnosticsPane />, { controller });
    expect((screen.getByRole("button", { name: /capturing/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("works without the toggle being on", () => {
    // The button is not gated on `debugScreenshots` — same distinction as the
    // shortcut.
    const controller = makeController({ settings: { debugScreenshots: false } });
    renderPane(<DiagnosticsPane />, { controller });
    expect((screen.getByRole("button", { name: /^capture$/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("search filtering", () => {
  it("shows only the matched row", () => {
    renderPane(<DiagnosticsPane />, { matchedIds: ["debug-capture-now"] });
    expect(screen.getByRole("button", { name: /^capture$/i })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /debug screenshots/i })).toBeNull();
  });
});
