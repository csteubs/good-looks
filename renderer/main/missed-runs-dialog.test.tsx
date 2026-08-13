// "This did not run while you were away." docs/ROUTINES.md capability 2.
//
// This dialog is the half that makes `SCHEDULE_CAVEAT` true — it promises a
// missed run is OFFERED on the next launch. So what is worth asserting is the
// promise: that it offers rather than runs, that both answers settle the
// occurrence, and that dismissing it counts as an answer.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { Routine } from "../lib/recorder-types";
import { MissedRunsDialog } from "./missed-runs-dialog";

let missed: Routine[] = [];
const runMissed = vi.fn(async (_id: string) => ({ routineId: _id, outcome: "started" }));
const dismissMissed = vi.fn(async (_id: string) => ({ dismissed: true }));

vi.mock("../lib/api", () => ({
  api: {
    routines: {
      missed: async () => missed,
      runMissed: (id: string) => runMissed(id),
      dismissMissed: (id: string) => dismissMissed(id),
    },
  },
}));

function routine(id: string, name: string): Routine {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    schedule: { kind: "dailyAt", minute: 3 * 60 },
    lastScheduledRunAt: 2,
    steps: [],
    defaults: { captureArtifacts: false, concurrency: 1 },
  };
}

function renderDialog() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MissedRunsDialog />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  missed = [];
});

describe("nothing missed", () => {
  it("renders nothing at all", async () => {
    renderDialog();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});

describe("a missed run", () => {
  it("names the routine and its schedule, and OFFERS rather than running", async () => {
    missed = [routine("r-a", "Nightly regression")];
    renderDialog();

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Nightly regression");
    // The schedule in words, so the prompt says WHY it is asking.
    expect(dialog.textContent).toContain("every day at 03:00");
    // A suite that seizes the machine the moment you launch the app is how
    // people turn scheduling off.
    expect(runMissed).not.toHaveBeenCalled();
  });

  it("runs it when accepted", async () => {
    missed = [routine("r-a", "Nightly")];
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: /run it now/i }));
    await waitFor(() => expect(runMissed).toHaveBeenCalledWith("r-a"));
  });

  it("settles it when declined, so the prompt does not return forever", async () => {
    missed = [routine("r-a", "Nightly")];
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(dismissMissed).toHaveBeenCalledWith("r-a"));
  });

  it("advances to the next one rather than asking about four at once", async () => {
    // The batch runner runs one batch at a time, so offering four together
    // would be offering three that get refused.
    missed = [routine("r-a", "Nightly"), routine("r-b", "Smoke")];
    renderDialog();

    expect((await screen.findByRole("alertdialog")).textContent).toContain("Nightly");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.getByRole("alertdialog").textContent).toContain("Smoke"),
    );
  });

  it("closes for good once every one has been answered", async () => {
    missed = [routine("r-a", "Nightly")];
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: /run it now/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
