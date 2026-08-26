// Tests for the Alerts pane.
//
// The webhook that used to live here moved to Integrations, and its tests moved
// with it — see `integrations-pane.test.tsx`, which still carries every
// assertion about the credential boundary that was written here.
//
// The pane's claim SPLIT when AI insights landed, and the tests pin both
// halves. The three notification rows are still local and each still says so.
// The insights rows are the app's only unattended AI send, and what is pinned
// there is the disclosure: the enable row's always-visible risk copy names
// what goes and where it goes, provider-aware — an inaccurate privacy
// disclosure is worse than none, because it is trusted. The
// no-credential/no-webhook guard survives from the old claim: this pane must
// never grow a field that stores a secret.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

import { SETTINGS_DEFAULTS } from "../../lib/settings-schema";
import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { AlertsPane } from "./alerts-pane";

// The pane reads the scheduler's readout and offers "Generate now" through the
// api module. Mocked per the house rule — the api module, never the IPC
// bridge — so these tests state intent rather than channel plumbing.
const { insightsApi } = vi.hoisted(() => ({
  insightsApi: {
    status: vi.fn(async () => ({
      generating: false,
      lastGeneratedAt: null as number | null,
      lastAttemptAt: null as number | null,
      lastError: null,
      lastSeenAppVersion: null as string | null,
    })),
    generateNow: vi.fn(async () => ({ started: true as const })),
  },
}));
vi.mock("../../lib/api", () => ({ api: { insights: insightsApi } }));

beforeEach(() => {
  vi.clearAllMocks();
});

/** The "More" disclosure for one row. Every row has one, so a bare
 *  `getByRole("button", {name: /more/i})` matches them all and reports as
 *  "found multiple elements" rather than as the wrong row. */
function moreFor(rowId: string): HTMLElement {
  const el = document.querySelector(`[aria-controls="${rowId}-details"]`);
  if (!el) throw new Error(`No details disclosure for row "${rowId}"`);
  return el as HTMLElement;
}

/** A controller with the insights feature already on. */
function insightsOn(over: Record<string, unknown> = {}) {
  return makeController({
    settings: { ...SETTINGS_DEFAULTS, batchOrder: [], aiInsightsEnabled: true, ...over },
  });
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

  it("offers a separate routine notification, on by default", () => {
    // A routine is a job you walk away from, so unlike the per-run notice this
    // one reports success too — and it's the reason a failing routine no longer
    // fires one notification per failed test.
    renderPane(<AlertsPane />);
    const toggle = screen.getByRole("switch", { name: /notify when a routine finishes/i });
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

  it("still says so on every notification row", () => {
    // Each row carries the locality claim itself rather than relying on the
    // pane subtitle, which scrolls away. Exactly the three notification rows —
    // the insights rows make a different claim and make it elsewhere.
    renderPane(<AlertsPane />);
    for (const id of ["notify-run-issues", "notify-batch-done", "notify-ai-debug-done"]) {
      fireEvent.click(moreFor(id));
    }
    expect(screen.getAllByText(/local to this Mac/i).length).toBe(3);
  });
});

describe("AI insights", () => {
  it("is off by default, and off hides the dependent rows entirely", () => {
    renderPane(<AlertsPane />);
    const toggle = screen.getByRole("switch", { name: /ai insights report/i });
    expect(toggle.getAttribute("data-state")).toBe("unchecked");
    // Unmounted, not greyed — the auto-heal pane's rule: controls that write
    // settings nothing will read should not sit there editable.
    expect(screen.queryByRole("switch", { name: /notify when a report is ready/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /generate now/i })).toBeNull();
  });

  it("saves the enable toggle", () => {
    const { controller } = renderPane(<AlertsPane />);
    fireEvent.click(screen.getByRole("switch", { name: /ai insights report/i }));
    expect(savedPatch(controller)).toEqual({ aiInsightsEnabled: true });
  });

  it("discloses what a report sends, always visible, naming the local server", () => {
    // `risk`, not `details`: a disclosure behind a More click is one most
    // people never see. The default controller's provider is a local runtime,
    // and the copy must say the summary stays on this machine.
    renderPane(<AlertsPane />);
    const risk = screen.getByText(/sends a summary of recent activity/i);
    expect(risk.textContent).toMatch(/never run logs/i);
    expect(risk.textContent).toMatch(/your own server on this machine/i);
    expect(risk.textContent).not.toMatch(/api\.anthropic\.com/i);
  });

  it("names Anthropic when Claude is the configured provider", () => {
    renderPane(<AlertsPane />, { controller: makeController({ provider: "anthropic" }) });
    expect(screen.getByText(/goes to api\.anthropic\.com/i)).toBeTruthy();
  });

  it("saves the cadence from a plain click — Segmented, not a native menu", () => {
    const { controller } = renderPane(<AlertsPane />, { controller: insightsOn() });
    fireEvent.click(screen.getByRole("button", { name: /monthly/i }));
    expect(savedPatch(controller)).toEqual({ aiInsightsCadence: "monthly" });
  });

  it("saves the ready notification toggle, on by default", () => {
    const { controller } = renderPane(<AlertsPane />, { controller: insightsOn() });
    const toggle = screen.getByRole("switch", { name: /notify when a report is ready/i });
    expect(toggle.getAttribute("data-state")).toBe("checked");
    fireEvent.click(toggle);
    expect(savedPatch(controller)).toEqual({ notifyOnInsightsReady: false });
  });

  it("Generate now asks the backend for a report", async () => {
    renderPane(<AlertsPane />, { controller: insightsOn() });
    fireEvent.click(await screen.findByRole("button", { name: /generate now/i }));
    await waitFor(() => expect(insightsApi.generateNow).toHaveBeenCalledTimes(1));
  });

  it("reads the last report's time back from the scheduler", async () => {
    const at = new Date(2026, 7, 17, 9, 0).getTime();
    insightsApi.status.mockResolvedValueOnce({
      generating: false,
      lastGeneratedAt: at,
      lastAttemptAt: null,
      lastError: null,
      lastSeenAppVersion: "1.0.0",
    });
    renderPane(<AlertsPane />, { controller: insightsOn() });
    expect(await screen.findByText(/last report:/i)).toBeTruthy();
  });
});

describe("no credential ever lands here", () => {
  it("holds no credential field and no outbound-webhook control", () => {
    // What survives of the pane's old "nothing leaves" claim, and the half
    // that must never regress: the insights rows SEND, but only through the
    // provider configured in the AI pane — this pane itself stores no secret
    // and hosts no webhook. A password field reappearing here is the specific
    // regression this catches.
    const { container } = renderPane(<AlertsPane />, { controller: insightsOn() });
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByLabelText(/webhook url/i)).toBeNull();
    expect(screen.queryByRole("switch", { name: /send alerts to a webhook/i })).toBeNull();
  });
});

describe("search filtering", () => {
  it("hides the rows that did not match", () => {
    renderPane(<AlertsPane />, { matchedIds: ["notify-run-issues"] });
    expect(screen.getByRole("switch", { name: /notify when a run has problems/i })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /notify when a routine finishes/i })).toBeNull();
  });

  it("hides the insights rows the same way", () => {
    renderPane(<AlertsPane />, {
      controller: insightsOn(),
      matchedIds: ["ai-insights-cadence"],
    });
    expect(screen.getByRole("button", { name: /weekly/i })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /ai insights report/i })).toBeNull();
  });
});
