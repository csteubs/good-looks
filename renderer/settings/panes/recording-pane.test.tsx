// Tests for the Recording pane.
//
// All three rows describe the TRAINER's browser window, as distinct from the
// one a test run opens. The window-size row is the interesting one: it is
// stored as `{width,height} | null`, not as a preset id, and `null` is a real
// choice ("Default" — fit to the screen, record no size). A truthiness test
// anywhere on that path makes returning to the default impossible.

import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { RecordingPane } from "./recording-pane";

describe("URL bar", () => {
  it("is on by default", () => {
    renderPane(<RecordingPane />);
    const sw = screen.getByRole("switch", { name: /show url bar/i });
    expect(sw.getAttribute("aria-checked") ?? sw.getAttribute("data-state")).toMatch(
      /true|checked/i,
    );
  });

  it("saves being turned off", () => {
    const { controller } = renderPane(<RecordingPane />);
    fireEvent.click(screen.getByRole("switch", { name: /show url bar/i }));
    expect(savedPatch(controller)).toEqual({ showUrlBar: false });
  });

  it("defaults to on when nothing is stored", () => {
    // One of only two settings in the window that default ON.
    const controller = makeController({ settings: {} });
    renderPane(<RecordingPane />, { controller });
    const sw = screen.getByRole("switch", { name: /show url bar/i });
    expect(sw.getAttribute("aria-checked") ?? sw.getAttribute("data-state")).toMatch(
      /true|checked/i,
    );
  });
});

describe("trainer panel", () => {
  it("is off by default", () => {
    renderPane(<RecordingPane />);
    const sw = screen.getByRole("switch", { name: /dock the trainer/i });
    expect(sw.getAttribute("aria-checked") ?? sw.getAttribute("data-state")).toMatch(
      /false|unchecked/i,
    );
  });

  it("saves being turned on", () => {
    const { controller } = renderPane(<RecordingPane />);
    fireEvent.click(screen.getByRole("switch", { name: /dock the trainer/i }));
    expect(savedPatch(controller)).toEqual({ trainerPanelEnabled: true });
  });

  it("warns that docking narrows the browser, behind the disclosure", () => {
    const { container } = renderPane(<RecordingPane />);
    const row = container.querySelector('[data-setting-row="trainer-panel"]');
    fireEvent.click(row?.querySelector("button[aria-expanded]") as HTMLButtonElement);
    expect(screen.getByText(/narrows the training browser/i)).toBeTruthy();
  });
});

describe("default window size", () => {
  // NOT TESTED: picking a size. The SDK's Select is native-menu-backed, so its
  // options never enter the DOM. The displayed value is asserted instead, and
  // the stored shape is covered in renderer/lib/viewport-presets.

  it("shows Default when no size is stored", () => {
    const controller = makeController({ settings: { defaultWindowSize: null } });
    renderPane(<RecordingPane />, { controller });
    expect(screen.getByRole("combobox", { name: /default window size/i }).textContent).toContain(
      "Default",
    );
  });

  it("shows the matching preset for a stored size", () => {
    const controller = makeController({
      settings: { defaultWindowSize: { width: 1280, height: 800 } },
    });
    renderPane(<RecordingPane />, { controller });
    expect(screen.getByRole("combobox", { name: /default window size/i }).textContent).toContain(
      "Desktop",
    );
  });

  it("falls back to Default for a size matching no preset", () => {
    // A hand-edited settings file, or a preset dropped in a later version. The
    // trigger must never render blank.
    const controller = makeController({
      settings: { defaultWindowSize: { width: 999, height: 111 } },
    });
    renderPane(<RecordingPane />, { controller });
    const trigger = screen.getByRole("combobox", { name: /default window size/i });
    expect(trigger.textContent?.trim().length).toBeGreaterThan(0);
    expect(trigger.textContent).toContain("Default");
  });

  it("says the size is recorded with the test", () => {
    const { container } = renderPane(<RecordingPane />);
    const row = container.querySelector('[data-setting-row="default-window-size"]');
    fireEvent.click(row?.querySelector("button[aria-expanded]") as HTMLButtonElement);
    expect(screen.getByText(/replays at the size it was recorded at/i)).toBeTruthy();
  });
});

describe("search filtering", () => {
  it("shows only the matched row", () => {
    renderPane(<RecordingPane />, { matchedIds: ["trainer-panel"] });
    expect(screen.getByRole("switch", { name: /dock the trainer/i })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /show url bar/i })).toBeNull();
  });
});

describe("page stylesheet and init script", () => {
  it("saves each on blur when it changed, and the init script row carries its risk", () => {
    const { controller } = renderPane(<RecordingPane />);
    const css = screen.getByLabelText("Page stylesheet") as HTMLTextAreaElement;
    fireEvent.blur(css);
    expect(controller.save).not.toHaveBeenCalled();
    fireEvent.change(css, { target: { value: "#chat { display: none }" } });
    fireEvent.blur(css);
    expect(controller.save).toHaveBeenCalledWith({ userStylesheet: "#chat { display: none }" });
    const js = screen.getByLabelText(/^Page init script/) as HTMLTextAreaElement;
    fireEvent.change(js, { target: { value: "window.__x = 1;" } });
    fireEvent.blur(js);
    expect(controller.save).toHaveBeenLastCalledWith({ userInitScript: "window.__x = 1;" });
    expect(screen.getByText(/runs on every site the trainer visits/)).toBeTruthy();
  });
});
