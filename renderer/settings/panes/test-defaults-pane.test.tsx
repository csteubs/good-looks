// Tests for the Test defaults pane.
//
// This pane holds eight of the window's settings and one genuine security
// control, so most of the persistence surface is here. The failure mode
// throughout is silent — a toggle that looks right and saves nothing, or saves
// the wrong key — which is why every assertion is on the PATCH, not on the
// control's own state.
//
// The nesting of `record-all-headers` under `default-record-logs` gets the most
// attention. It used to be a greyed-out sibling row, and "greyed out" is not a
// state a user can act on: there was nothing on screen saying which other
// setting controlled it.

import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { TestDefaultsPane } from "./test-defaults-pane";

describe("run speed", () => {
  it("shows the stored speed", () => {
    const controller = makeController({ settings: { defaultRunSpeed: "fast" } });
    renderPane(<TestDefaultsPane />, { controller });
    // The SegmentedControl renders its options as real DOM, unlike Select.
    const fast = screen.getByRole("radio", { name: /fast/i });
    expect(fast.getAttribute("data-state") ?? fast.getAttribute("aria-checked")).toMatch(
      /checked|true|on/i,
    );
  });

  it("saves a different speed", () => {
    const { controller } = renderPane(<TestDefaultsPane />);
    fireEvent.click(screen.getByRole("radio", { name: /^medium$/i }));
    expect(savedPatch(controller)).toEqual({ defaultRunSpeed: "medium" });
  });

  it("offers every speed the runner knows about", () => {
    // A speed missing here is one no new test can be given.
    renderPane(<TestDefaultsPane />);
    for (const label of ["Crawl", "Slow", "Medium", "Fast"]) {
      expect(screen.getByRole("radio", { name: new RegExp(`^${label}$`, "i") }), label).toBeTruthy();
    }
  });
});

describe("browser", () => {
  // NOT TESTED: choosing a different browser. The SDK's Select is backed by a
  // NATIVE menu, so its options never enter the DOM — clicking the trigger in
  // jsdom opens nothing to click. Faking a selection would test the fake. The
  // displayed value is asserted here; the persistence path (recorder:setSettings
  // validating the engine) is covered in main/handlers/handlers.test.ts.

  it("shows the stored engine rather than a hardcoded default", () => {
    const controller = makeController({ settings: { defaultRunBrowser: "webkit" } });
    renderPane(<TestDefaultsPane />, { controller });
    expect(screen.getByRole("combobox", { name: /browser/i }).textContent).toContain("WebKit");
  });

  it("draws no glyph of its own beside the Select's", () => {
    // The trigger's icon is the selected item's SF Symbol, rendered by
    // SelectValue. A lucide one alongside it showed the engine twice.
    const controller = makeController({ settings: { defaultRunBrowser: "webkit" } });
    renderPane(<TestDefaultsPane />, { controller });
    const trigger = screen.getByRole("combobox", { name: /browser/i });
    expect(trigger.querySelectorAll("[data-browser]").length).toBe(0);
  });

  it("falls back to Chromium when nothing is stored", () => {
    const controller = makeController({ settings: {} });
    renderPane(<TestDefaultsPane />, { controller });
    expect(screen.getByRole("combobox", { name: /browser/i }).textContent).toContain("Chromium");
  });
});

describe("headless", () => {
  // Two switches say "headless" now — one for a run, one for a routine — so these
  // queries are exact. A regex that matched both is what turned this file red
  // the moment the second row landed, which is the query telling the truth: it
  // was never asserting WHICH switch it clicked.
  const runSwitch = () => screen.getByRole("switch", { name: "Run tests in headless mode" });
  const batchSwitch = () => screen.getByRole("switch", { name: "Run routines in headless mode" });

  it("saves being turned on", () => {
    const { controller } = renderPane(<TestDefaultsPane />);
    fireEvent.click(runSwitch());
    expect(savedPatch(controller)).toEqual({ defaultRunHeadless: true });
  });

  it("saves being turned off again", () => {
    // The `checked` prop has to be driven by the stored value, not by internal
    // switch state, or the second toggle writes `true` a second time.
    const controller = makeController({ settings: { defaultRunHeadless: true } });
    renderPane(<TestDefaultsPane />, { controller });
    fireEvent.click(runSwitch());
    expect(savedPatch(controller)).toEqual({ defaultRunHeadless: false });
  });

  it("keeps the routine's default separate from the single run's", () => {
    // R18. The two are deliberately different settings: a routine ships headless
    // and a single run ships headed. One switch driving both is how sixty
    // windows got opened by a tick box, and how someone who wants to WATCH one
    // run would have had to turn batches headed to get it.
    const controller = makeController({
      settings: { defaultRunHeadless: false, defaultBatchHeadless: true },
    });
    renderPane(<TestDefaultsPane />, { controller });
    expect(runSwitch().getAttribute("data-state")).toBe("unchecked");
    expect(batchSwitch().getAttribute("data-state")).toBe("checked");

    fireEvent.click(batchSwitch());
    expect(savedPatch(controller)).toEqual({ defaultBatchHeadless: false });
  });

  it("ships batches headless when nothing is stored", () => {
    renderPane(<TestDefaultsPane />, { controller: makeController({ settings: {} }) });
    expect(batchSwitch().getAttribute("data-state")).toBe("checked");
  });
});

describe("batch concurrency", () => {
  // NOT TESTED: picking a different value, for the same reason as the browser
  // Select above — its options are a native menu and never enter the DOM. The
  // displayed value is asserted here, the clamp on save in
  // main/handlers/handlers.test.ts, and the resolve/warn logic directly in
  // renderer/lib/batch-parallel.test.ts.

  it("reads as off when nothing is stored", () => {
    const controller = makeController({ settings: {} });
    renderPane(<TestDefaultsPane />, { controller });
    expect(screen.getByRole("combobox", { name: /at once/i }).textContent).toContain("Off");
  });

  it("shows a stored default", () => {
    const controller = makeController({ settings: { defaultBatchConcurrency: 4 } });
    renderPane(<TestDefaultsPane />, { controller });
    expect(screen.getByRole("combobox", { name: /at once/i }).textContent).toContain("4 at once");
  });

  it("shows the ceiling as 'All at once' rather than a bare number", () => {
    const controller = makeController({ settings: { defaultBatchConcurrency: 16 } });
    renderPane(<TestDefaultsPane />, { controller });
    expect(screen.getByRole("combobox", { name: /at once/i }).textContent).toContain(
      "All at once",
    );
  });

  it("never renders blank for a hand-edited value it doesn't offer", () => {
    // A Select whose value isn't one of its items renders EMPTY, which reads as
    // "no default set" while a default is very much set.
    const controller = makeController({ settings: { defaultBatchConcurrency: 7 } });
    renderPane(<TestDefaultsPane />, { controller });
    const trigger = screen.getByRole("combobox", { name: /at once/i });
    expect(trigger.textContent?.trim()).toBeTruthy();
    expect(trigger.textContent).toContain("4 at once");
  });
});

describe("timeout", () => {
  it("shows seconds but stores milliseconds", () => {
    const controller = makeController({ settings: { defaultTestTimeoutMs: 180_000 } });
    renderPane(<TestDefaultsPane />, { controller });
    const input = screen.getByRole("spinbutton", {
      name: /default test timeout/i,
    }) as HTMLInputElement;
    expect(input.value).toBe("180");
  });

  it("saves a change in milliseconds", () => {
    const { controller } = renderPane(<TestDefaultsPane />);
    fireEvent.change(screen.getByRole("spinbutton", { name: /default test timeout/i }), {
      target: { value: "120" },
    });
    expect(savedPatch(controller)).toEqual({ defaultTestTimeoutMs: 120_000 });
  });

  it("clamps rather than persisting an absurd value", () => {
    const { controller } = renderPane(<TestDefaultsPane />);
    fireEvent.change(screen.getByRole("spinbutton", { name: /default test timeout/i }), {
      target: { value: "99999" },
    });
    expect(savedPatch(controller).defaultTestTimeoutMs).toBe(1800 * 1000);
  });

  it("defaults to 60 seconds when nothing is stored", () => {
    const controller = makeController({ settings: {} });
    renderPane(<TestDefaultsPane />, { controller });
    expect(
      (screen.getByRole("spinbutton", { name: /default test timeout/i }) as HTMLInputElement).value,
    ).toBe("60");
  });

  it("steps in single seconds", () => {
    renderPane(<TestDefaultsPane />);
    const input = screen.getByRole("spinbutton", {
      name: /default test timeout/i,
    }) as HTMLInputElement;
    expect(input.step).toBe("1");
  });

  it("saves a default that is not a multiple of five", () => {
    // Pins that the finer stepper isn't undone by re-rounding in clamp/save.
    const { controller } = renderPane(<TestDefaultsPane />);
    fireEvent.change(screen.getByRole("spinbutton", { name: /default test timeout/i }), {
      target: { value: "47" },
    });
    expect(savedPatch(controller)).toEqual({ defaultTestTimeoutMs: 47_000 });
  });
});

describe("capture and accessibility", () => {
  it("saves the screenshot default", () => {
    const { controller } = renderPane(<TestDefaultsPane />);
    fireEvent.click(screen.getByRole("switch", { name: /capture screenshots/i }));
    expect(savedPatch(controller)).toEqual({ defaultCaptureArtifacts: true });
  });

  it("saves the accessibility default", () => {
    const { controller } = renderPane(<TestDefaultsPane />);
    fireEvent.click(screen.getByRole("switch", { name: /check accessibility/i }));
    expect(savedPatch(controller)).toEqual({ defaultA11yChecks: true });
  });

  it("says the accessibility check never fails a run without needing a click", () => {
    // The reassurance that stops someone leaving it off — it belongs in the
    // always-visible summary, not behind the disclosure.
    renderPane(<TestDefaultsPane />);
    expect(screen.getByText(/never fails a run/i)).toBeTruthy();
  });
});

describe("the request-headers setting is nested under its parent", () => {
  it("is absent while console & network recording is off", () => {
    // It used to render greyed-out, with nothing saying what controlled it.
    const controller = makeController({ settings: { defaultRecordLogs: false } });
    renderPane(<TestDefaultsPane />, { controller });
    expect(screen.queryByRole("switch", { name: /include all request headers/i })).toBeNull();
  });

  it("appears once recording is on", () => {
    const controller = makeController({ settings: { defaultRecordLogs: true } });
    renderPane(<TestDefaultsPane />, { controller });
    expect(screen.getByRole("switch", { name: /include all request headers/i })).toBeTruthy();
  });

  it("saves its own key, not the parent's", () => {
    const controller = makeController({ settings: { defaultRecordLogs: true } });
    renderPane(<TestDefaultsPane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /include all request headers/i }));
    expect(savedPatch(controller)).toEqual({ recordAllHeaders: true });
  });

  it("warns that it stores credentials", () => {
    const controller = makeController({ settings: { defaultRecordLogs: true } });
    renderPane(<TestDefaultsPane />, { controller });
    expect(screen.getByText(/stores credentials/i)).toBeTruthy();
  });

  it("names the headers it will store, with no disclosure to open", () => {
    // The whole point of the danger treatment: a user must be able to read
    // what this does without clicking anything.
    const controller = makeController({ settings: { defaultRecordLogs: true } });
    const { container } = renderPane(<TestDefaultsPane />, { controller });
    const row = container.querySelector('[data-setting-row="record-all-headers"]');
    expect(row?.textContent).toMatch(/authorization/i);
    expect(row?.textContent).toMatch(/cookie/i);
    expect(row?.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("still describes the safe default it replaces", () => {
    // "Turns off the allowlist" is only meaningful if the allowlist is
    // described somewhere the user is already looking.
    const controller = makeController({ settings: { defaultRecordLogs: true } });
    const { container } = renderPane(<TestDefaultsPane />, { controller });
    const row = container.querySelector('[data-setting-row="record-all-headers"]');
    expect(row?.textContent).toMatch(/allowlist/i);
  });

  it("keeps the parent's own toggle working", () => {
    const controller = makeController({ settings: { defaultRecordLogs: true } });
    renderPane(<TestDefaultsPane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /record console/i }));
    expect(savedPatch(controller)).toEqual({ defaultRecordLogs: false });
  });
});

describe("search filtering", () => {
  it("shows only the matched row", () => {
    renderPane(<TestDefaultsPane />, { matchedIds: ["default-run-headless"] });
    expect(screen.getByRole("switch", { name: "Run tests in headless mode" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /capture screenshots/i })).toBeNull();
  });

  it("drops a section whose rows all filtered away", () => {
    // "Running" and "What a run records" are separate sections; a search
    // hitting only one must not leave the other's heading over an empty box.
    renderPane(<TestDefaultsPane />, { matchedIds: ["default-run-headless"] });
    expect(screen.queryByText("What a run records")).toBeNull();
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("hides the nested header row when only its child matched", () => {
    // Searching "headers" matches record-all-headers but not its parent. The
    // child is still rendered — a dependency rule with no parent above it is
    // odd, but hiding the match itself would be worse.
    const controller = makeController({ settings: { defaultRecordLogs: true } });
    renderPane(<TestDefaultsPane />, { controller, matchedIds: ["record-all-headers"] });
    expect(screen.getByRole("switch", { name: /include all request headers/i })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /record console/i })).toBeNull();
  });

  it("does not render a nested row that its parent has switched off, even on a match", () => {
    // Search must not resurrect a control whose parent is off — toggling it
    // would write a setting nothing reads.
    const controller = makeController({ settings: { defaultRecordLogs: false } });
    renderPane(<TestDefaultsPane />, { controller, matchedIds: ["record-all-headers"] });
    expect(screen.queryByRole("switch", { name: /include all request headers/i })).toBeNull();
  });
});
