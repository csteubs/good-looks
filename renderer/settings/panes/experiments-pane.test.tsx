// Tests for the Experiments pane.
//
// Both rows moved here out of the AI pane's "Experimental" section in B4. The
// assertions came with them, plus one the section could never make: the caveat
// now has to be on the ROWS, because a pane has no titled section to carry it
// and a user can land on any single row through search.

import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";

import { renderPane, savedPatch } from "../__tests__/harness";
import { ExperimentsPane } from "./experiments-pane";

describe("the experiments pane", () => {
  it("saves the keep-running toggle", () => {
    const { controller } = renderPane(<ExperimentsPane />);
    fireEvent.click(screen.getByRole("switch", { name: /keep a running AI debug job/i }));
    expect(savedPatch(controller)).toEqual({ keepRunningAiDebugJobs: true });
  });

  it("saves the auto-accept toggle, which defaults off", () => {
    // Off is the safe default: this switch lets a background job rewrite a
    // script. Flipping the default silently would be the worst kind of bug.
    const { controller } = renderPane(<ExperimentsPane />);
    const sw = screen.getByRole("switch", { name: /apply AI debug fixes automatically/i });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(savedPatch(controller)).toEqual({ autoAcceptAiDebugFixes: true });
  });

  it("states what each one costs without needing the details opened", () => {
    // The `risk` block, not `details`. A disclosure the user never opens is the
    // same as no warning at all, and the thing being warned about here is a
    // script changing under them.
    renderPane(<ExperimentsPane />);
    expect(screen.getByText(/script can change without you reading the change/i)).toBeTruthy();
    expect(screen.getByText(/describes the previous run/i)).toBeTruthy();
  });
});

describe("search filtering", () => {
  it("shows only the matched row", () => {
    renderPane(<ExperimentsPane />, { matchedIds: ["auto-accept-ai-debug-fixes"] });
    expect(screen.getByRole("switch", { name: /apply AI debug fixes automatically/i })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /keep a running AI debug job/i })).toBeNull();
  });
});
