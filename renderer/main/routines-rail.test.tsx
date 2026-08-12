// The rail, when the Routines screen is open. REDESIGN §7.1.
//
// The rail and the view's picker are two lists of one set of jobs, so what is
// worth asserting here is everything that could make them disagree: the order,
// which row is marked, and what happens before anything has been chosen.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { Routine } from "../lib/recorder-types";
import { RoutinesRail, useCreateRoutine } from "./routines-rail";

let routines: Routine[] = [];
const routineSave = vi.fn(async (r: Routine) => {
  routines = [...routines, r];
  return r;
});

vi.mock("../lib/api", () => ({
  api: {
    routines: {
      list: async () => routines,
      save: (r: Routine) => routineSave(r),
    },
    recorder: {
      getSettings: async () => ({ defaultCaptureArtifacts: true, defaultBatchConcurrency: 4 }),
    },
  },
}));

// The open Routine lives in the recorder store. Stubbed with a module-level
// value the test can read back, rather than the real provider, which owns the
// whole recording session.
let openRoutineId: string | null = null;
const setOpenRoutineId = vi.fn((id: string | null) => {
  openRoutineId = id;
});
vi.mock("./recorder-store", () => ({
  useRecorder: () => ({ openRoutineId, setOpenRoutineId }),
}));

function routine(id: string, name: string, steps = 0): Routine {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    steps: Array.from({ length: steps }, (_, i) => ({
      kind: "test" as const,
      testId: `t-${i}`,
      browsers: ["chromium" as const],
      headless: false,
      onFailure: "continue" as const,
    })),
    defaults: { captureArtifacts: false, concurrency: 1 },
  };
}

function renderRail() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RoutinesRail />
    </QueryClientProvider>,
  );
}

/** A component whose only job is to expose the hook to a click. */
function NewButton() {
  const create = useCreateRoutine();
  return (
    <button type="button" onClick={create}>
      New routine
    </button>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  routines = [];
  openRoutineId = null;
});

describe("the rail's routine list", () => {
  it("lists every saved routine with its size", async () => {
    // A count, not a name list: three truncated test names in a 240px rail is a
    // list you cannot read pretending to be a summary.
    routines = [routine("r-a", "Smoke", 3), routine("r-b", "Nightly", 1)];
    renderRail();

    expect(await screen.findByText("Smoke")).toBeTruthy();
    expect(screen.getByText("3 tests")).toBeTruthy();
    expect(screen.getByText("1 test")).toBeTruthy();
  });

  it("marks the FIRST routine before anything has been chosen", async () => {
    // That is what the view opens. A rail showing no selection beside a screen
    // plainly editing something reads as the two disagreeing about what you
    // are looking at.
    routines = [routine("r-a", "Smoke"), routine("r-b", "Nightly")];
    renderRail();

    const row = await screen.findByRole("button", { name: /Smoke/ });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /Nightly/ }).getAttribute("aria-current")).toBeNull();
  });

  it("marks the chosen routine once one is", async () => {
    routines = [routine("r-a", "Smoke"), routine("r-b", "Nightly")];
    openRoutineId = "r-b";
    renderRail();

    const row = await screen.findByRole("button", { name: /Nightly/ });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /Smoke/ }).getAttribute("aria-current")).toBeNull();
  });

  it("selects a routine on a plain click", async () => {
    // The rail's rows are ordinary buttons, not the SDK's mouseDown-activated
    // list items — see rail.tsx.
    routines = [routine("r-a", "Smoke"), routine("r-b", "Nightly")];
    renderRail();

    fireEvent.click(await screen.findByRole("button", { name: /Nightly/ }));

    expect(setOpenRoutineId).toHaveBeenCalledWith("r-b");
  });

  it("says what to do when there are none", async () => {
    renderRail();
    expect(await screen.findByText(/no routines yet/i)).toBeTruthy();
  });
});

describe("the rail's + button", () => {
  it("creates an EMPTY routine and opens it", async () => {
    // Pre-filling would make the first thing a new job does be something the
    // user has to undo.
    routines = [routine("r-a", "Smoke")];
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NewButton />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New routine" }));

    await waitFor(() => expect(routineSave).toHaveBeenCalled());
    const created = routineSave.mock.calls[0][0];
    expect(created.steps).toEqual([]);
    expect(created.name).toBe("New routine");
    // The globals, so a user who set "4 at once" everywhere does not get
    // one-at-a-time back every time they make a job.
    expect(created.defaults).toEqual({ captureArtifacts: true, concurrency: 4 });
    await waitFor(() => expect(setOpenRoutineId).toHaveBeenCalledWith(created.id));
  });

  it("does not reuse a name already taken", async () => {
    routines = [routine("r-a", "New routine")];
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NewButton />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New routine" }));

    await waitFor(() => expect(routineSave).toHaveBeenCalled());
    expect(routineSave.mock.calls[0][0].name).toBe("New routine 2");
  });
});
