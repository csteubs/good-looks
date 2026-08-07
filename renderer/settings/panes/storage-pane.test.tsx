// Tests for the Storage pane.
//
// The usage readout is the only live number in the whole Settings window. It
// used to be appended mid-sentence to a description string — "…never deleted.
// Currently using 1.4 MB across 12 runs." — where nobody asking "how much
// space is this costing me" would find it. Promoting it to a real element is
// the change; these tests pin that it survives an absent reading, which is the
// state it is in for the first frame and whenever the IPC call fails.

import { describe, it, expect } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { StoragePane } from "./storage-pane";

describe("the usage readout", () => {
  it("shows a formatted size and a run count", () => {
    const controller = makeController({
      artifactUsage: { bytes: 6_144_000, runs: 12, tests: 3 },
    });
    renderPane(<StoragePane />, { controller });
    expect(screen.getByTestId("artifact-usage-bytes").textContent).toBe("5.9 MB");
    expect(screen.getByText(/across 12 runs of 3 tests/i)).toBeTruthy();
  });

  it("says run and test in the singular when there is one of each", () => {
    const controller = makeController({ artifactUsage: { bytes: 1024, runs: 1, tests: 1 } });
    renderPane(<StoragePane />, { controller });
    expect(screen.getByText(/across 1 run of 1 test$/i)).toBeTruthy();
  });

  it("renders a placeholder rather than NaN before the reading arrives", () => {
    // `artifactUsage` is null for the first frame and stays null if the IPC
    // call fails. Formatting null would print "NaN B" in the largest type on
    // the pane.
    renderPane(<StoragePane />);
    expect(screen.getByTestId("artifact-usage-bytes").textContent).toBe("—");
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it("reports zero as a real reading, not as missing", () => {
    // 0 bytes is a legitimate answer — nothing has been captured yet.
    const controller = makeController({ artifactUsage: { bytes: 0, runs: 0, tests: 0 } });
    renderPane(<StoragePane />, { controller });
    expect(screen.getByTestId("artifact-usage-bytes").textContent).toBe("0 B");
  });
});

describe("clean up now", () => {
  it("runs the prune", async () => {
    const { controller } = renderPane(<StoragePane />);
    fireEvent.click(screen.getByRole("button", { name: /clean up now/i }));
    await waitFor(() => expect(controller.pruneNow).toHaveBeenCalledTimes(1));
  });

  it("disables itself and says so while running", () => {
    // A second prune racing the first would report freed bytes twice.
    const controller = makeController({ pruning: true });
    renderPane(<StoragePane />, { controller });
    const button = screen.getByRole("button", { name: /cleaning up/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("retention limits", () => {
  it("saves how many runs are kept", () => {
    const { controller } = renderPane(<StoragePane />);
    fireEvent.change(screen.getByLabelText(/screenshot history per test/i), {
      target: { value: "25" },
    });
    expect(savedPatch(controller)).toEqual({ artifactRetainedRuns: 25 });
  });

  it("clamps an absurd value rather than persisting it", () => {
    const { controller } = renderPane(<StoragePane />);
    fireEvent.change(screen.getByLabelText(/screenshot history per test/i), {
      target: { value: "9999" },
    });
    expect(savedPatch(controller).artifactRetainedRuns).toBeLessThanOrEqual(50);
  });

  it("saves an age limit", () => {
    const { controller } = renderPane(<StoragePane />);
    fireEvent.change(screen.getByLabelText(/delete screenshots older than/i), {
      target: { value: "30" },
    });
    expect(savedPatch(controller)).toEqual({ artifactRetentionDays: 30 });
  });

  it("accepts zero as switching the age rule off", () => {
    // 0 is meaningful here and nowhere else in this window — it must reach the
    // store rather than being treated as an empty field.
    const controller = makeController({ settings: { artifactRetentionDays: 30 } });
    renderPane(<StoragePane />, { controller });
    fireEvent.change(screen.getByLabelText(/delete screenshots older than/i), {
      target: { value: "0" },
    });
    expect(savedPatch(controller)).toEqual({ artifactRetentionDays: 0 });
  });

  it("clamps an age beyond a year", () => {
    const { controller } = renderPane(<StoragePane />);
    fireEvent.change(screen.getByLabelText(/delete screenshots older than/i), {
      target: { value: "5000" },
    });
    expect(savedPatch(controller)).toEqual({ artifactRetentionDays: 365 });
  });

  it("keeps the days unit inside the control, at the same width as the row above", () => {
    // The unit used to be a sibling `<span>`. Because the row right-aligns its
    // control, that span displaced the field leftward by its own width and the
    // two inputs in this section stopped lining up. jsdom cannot measure that,
    // so pin the two things that cause it: the unit lives inside the control,
    // and both controls declare the same width.
    const { container } = renderPane(<StoragePane />);
    const days = container.querySelector('[data-setting-row="artifact-retention-days"]');
    const runs = container.querySelector('[data-setting-row="artifact-retained-runs"]');

    const unit = days?.querySelector('[data-slot="number-input-unit"]');
    expect(unit?.textContent).toBe("days");
    // Inside the control, not beside it.
    expect(unit?.closest('[data-slot="number-input"]')).not.toBeNull();

    const width = (el: Element | null | undefined) =>
      Array.from(el?.querySelector('[data-slot="number-input"]')?.classList ?? []).filter((c) =>
        c.startsWith("w-"),
      );
    expect(width(days)).toEqual(width(runs));
    expect(width(days).length).toBeGreaterThan(0);
  });

  it("says the two rules are an AND, and that baselines are exempt", () => {
    // Both facts used to be repeated across two row descriptions; the section
    // description now carries them once.
    renderPane(<StoragePane />);
    expect(screen.getByText(/only while they satisfy both rules/i)).toBeTruthy();
    expect(screen.getByText(/Pinned visual baselines are never deleted/i)).toBeTruthy();
  });
});

describe("search filtering", () => {
  it("keeps the usage readout visible regardless of the query", () => {
    // The readout is context for whatever the user is about to change, not a
    // setting that can be filtered out.
    renderPane(<StoragePane />, { matchedIds: ["artifact-retention-days"] });
    expect(screen.getByTestId("artifact-usage-bytes")).toBeTruthy();
  });

  it("hides an unmatched limit row", () => {
    renderPane(<StoragePane />, { matchedIds: ["artifact-retention-days"] });
    expect(screen.queryByLabelText(/screenshot history per test/i)).toBeNull();
    expect(screen.getByLabelText(/delete screenshots older than/i)).toBeTruthy();
  });
});
