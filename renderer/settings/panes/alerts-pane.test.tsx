// Tests for the Alerts pane.
//
// The webhook that used to live here moved to Integrations, and its tests moved
// with it — see `integrations-pane.test.tsx`, which still carries every
// assertion about the credential boundary that was written here.
//
// What is left is three LOCAL notifications, and the claim worth pinning is
// exactly that: each row says it stays on this Mac, and the pane as a whole no
// longer contains anything that leaves. The last test is the one that would
// notice the webhook being moved back in by accident.

import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";

import { renderPane, savedPatch } from "../__tests__/harness";
import { AlertsPane } from "./alerts-pane";

/** The "More" disclosure for one row. Every row has one, so a bare
 *  `getByRole("button", {name: /more/i})` matches them all and reports as
 *  "found multiple elements" rather than as the wrong row. */
function moreFor(rowId: string): HTMLElement {
  const el = document.querySelector(`[aria-controls="${rowId}-details"]`);
  if (!el) throw new Error(`No details disclosure for row "${rowId}"`);
  return el as HTMLElement;
}

describe("local notifications", () => {
  it("saves the toggle", () => {
    const { controller } = renderPane(<AlertsPane />);
    fireEvent.click(screen.getByRole("switch", { name: /notify when a run has problems/i }));
    expect(savedPatch(controller)).toEqual({ notifyOnRunIssues: true });
  });

  it("says the notification never leaves the Mac", () => {
    renderPane(<AlertsPane />);
    fireEvent.click(moreFor("notify-run-issues"));
    expect(screen.getByText(/local to this Mac/i)).toBeTruthy();
  });

  it("offers a separate batch notification, on by default", () => {
    // A batch is a job you walk away from, so unlike the per-run notice this
    // one reports success too — and it's the reason a failing batch no longer
    // fires one notification per failed test.
    renderPane(<AlertsPane />);
    const toggle = screen.getByRole("switch", { name: /notify when a batch finishes/i });
    expect(toggle.getAttribute("data-state")).toBe("checked");
    fireEvent.click(moreFor("notify-batch-done"));
    expect(screen.getByText(/one for the suite/i)).toBeTruthy();
  });

  it("offers an AI-debug notification, off by default, that saves", () => {
    // A minimized AI job is walked away from exactly like a batch, but the
    // default is off: not everyone uses the AI feature at all.
    renderPane(<AlertsPane />);
    const toggle = screen.getByRole("switch", { name: /notify when an AI debug job finishes/i });
    expect(toggle.getAttribute("data-state")).toBe("unchecked");
  });

  it("saves the AI-debug toggle", () => {
    const { controller } = renderPane(<AlertsPane />);
    fireEvent.click(screen.getByRole("switch", { name: /notify when an AI debug job finishes/i }));
    expect(savedPatch(controller)).toEqual({ notifyOnAiDebugDone: true });
  });
});

describe("nothing here leaves this Mac", () => {
  it("holds no credential field and no outbound control", () => {
    // The pane's whole claim after the webhook moved out. A credential field
    // reappearing here is the specific regression this catches: it would put a
    // bearer token back in a pane whose copy promises everything is local.
    const { container } = renderPane(<AlertsPane />);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByText(/leaves this Mac/i)).toBeNull();
    expect(screen.queryByLabelText(/webhook url/i)).toBeNull();
    expect(screen.queryByRole("switch", { name: /send alerts to a webhook/i })).toBeNull();
  });

  it("says so on every row", () => {
    // Each row carries the claim itself rather than relying on the pane
    // subtitle, which scrolls away.
    renderPane(<AlertsPane />);
    for (const id of ["notify-run-issues", "notify-batch-done", "notify-ai-debug-done"]) {
      fireEvent.click(moreFor(id));
    }
    expect(screen.getAllByText(/local to this Mac/i).length).toBe(3);
  });
});

describe("search filtering", () => {
  it("hides the rows that did not match", () => {
    renderPane(<AlertsPane />, { matchedIds: ["notify-run-issues"] });
    expect(screen.getByRole("switch", { name: /notify when a run has problems/i })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /notify when a batch finishes/i })).toBeNull();
  });
});
