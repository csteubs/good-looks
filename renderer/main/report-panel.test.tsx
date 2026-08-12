// Stats → Report. REDESIGN §6.5.
//
// The security-critical half — that every emit redacts, and that no IPC channel
// hands the emitted bytes to the renderer — is pinned by `check:emit-redaction`,
// at source level, because it is a fact about which arguments a call site passes
// and no rendered test can see that.
//
// What is here is the panel's own contract: that the list comes from the shared
// module rather than a copy, that a risk note appears on the emitters that carry
// one, that a cancelled save is treated as an answer rather than an error, and
// that "last written" is per-emitter. Every one of those is a way this panel can
// be wrong while looking completely fine.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { clearToastCalls, toastTexts } from "../__tests__/sonner-stub";
import { EMITTERS } from "../../shared/emitters.mjs";
import type { EmitResult } from "../lib/recorder-types";
import { ReportPanel } from "./report-panel";

let result: EmitResult = { path: "/tmp/report.xml", bytes: 2048, count: 12, cancelled: false };
/** Typed to the real call shape rather than `unknown[]`, so asserting on an
 *  argument does not need a cast that would also hide a signature change. */
const emit = vi.fn(async (_emitter: string, _stamp: string, _testId?: string) => result);

vi.mock("../lib/api", () => ({
  api: { report: { emit: (...a: Parameters<typeof emit>) => emit(...a) } },
}));

beforeEach(() => {
  emit.mockClear();
  clearToastCalls();
  result = { path: "/tmp/report.xml", bytes: 2048, count: 12, cancelled: false };
});

describe("the list", () => {
  it("renders one row per emitter in the SHARED module", () => {
    // Rendered from `EMITTERS` rather than written out here, so an emitter
    // added to the module cannot be forgotten in the UI — the failure mode of
    // every "list of formats" that exists in two places.
    render(<ReportPanel />);
    expect(document.querySelectorAll(".gl-report-row")).toHaveLength(EMITTERS.length);
    for (const e of EMITTERS) expect(screen.getByText(e.label)).toBeTruthy();
  });

  it("shows a risk note on exactly the emitters that declare one", () => {
    render(<ReportPanel />);
    const expected = EMITTERS.filter((e) => e.risk !== null).length;
    expect(document.querySelectorAll(".gl-report-risk")).toHaveLength(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it("states once that nothing is sent", () => {
    // The mockup's channel toggles implied outbound delivery this app does not
    // do. This is the sentence that replaces them.
    render(<ReportPanel />);
    expect(document.querySelector(".gl-report-head")?.textContent).toContain("nothing is sent");
  });
});

describe("emitting", () => {
  it("asks the backend for the emitter that was clicked", async () => {
    render(<ReportPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Emit JUnit XML/i }));
    await waitFor(() => expect(emit).toHaveBeenCalled());
    expect(emit.mock.calls[0][0]).toBe("junit");
  });

  it("reports where the file went, per emitter", async () => {
    // Keyed by emitter because "last written" is a fact about ONE format. A
    // single slot would make exporting a second file look like it replaced the
    // first, which is the opposite of what the list is for.
    render(<ReportPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Emit JUnit XML/i }));
    await waitFor(() => {
      expect(document.querySelectorAll(".gl-report-written")).toHaveLength(1);
    });
    expect(document.querySelector(".gl-report-written")?.textContent).toContain("/tmp/report.xml");

    result = { path: "/tmp/other.md", bytes: 100, count: 3, cancelled: false };
    fireEvent.click(screen.getByRole("button", { name: /Emit Ticket/i }));
    await waitFor(() => {
      expect(document.querySelectorAll(".gl-report-written")).toHaveLength(2);
    });
  });

  it("says what the file COVERS, not just its size", async () => {
    // "2 KB" tells the reader nothing about whether the export is the run they
    // care about.
    render(<ReportPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Emit JUnit XML/i }));
    await waitFor(() => {
      expect(document.querySelector(".gl-report-written")?.textContent).toContain("12 rows");
    });
  });

  it("treats a cancelled save as an ANSWER, not an error", async () => {
    // The user closed a save dialog. Telling them what they just did reads as
    // the app not having noticed — and a toast for it would fire on the most
    // ordinary way out of the flow.
    result = { path: null, bytes: 0, count: 0, cancelled: true };
    render(<ReportPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Emit JUnit XML/i }));
    await waitFor(() => expect(emit).toHaveBeenCalled());
    expect(toastTexts()).toHaveLength(0);
    expect(document.querySelector(".gl-report-written")).toBeNull();
  });

  it("surfaces a write that failed", async () => {
    // A full disk or a read-only folder is the user's environment rather than a
    // bug, and silence would look identical to a file that was written.
    emit.mockRejectedValueOnce(new Error("Could not write that file: EACCES"));
    render(<ReportPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Emit JUnit XML/i }));
    await waitFor(() => {
      expect(toastTexts().map((t) => t.title).join(" ")).toContain("EACCES");
    });
  });
});
