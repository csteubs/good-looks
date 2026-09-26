// The failure-reason row: what it shows, what it offers, and what it writes.
//
// The Select is native-menu-backed, so its options never enter the DOM. The
// assertions here follow the repo's two rules for that control: read the
// DISPLAYED value off the trigger, and drive a change through a stubbed
// `glazeAPI.Menu.popup` (the appearance-pane pattern) when the handler on the
// near side of the store — the setFailureReason call — is the thing under
// test.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RunFailureReason } from "./run-failure-reason";
import type { CustomFailureReason, RunRecord } from "../lib/recorder-types";

const h = vi.hoisted(() => ({
  runs: [] as Partial<RunRecord>[],
  custom: [] as Partial<CustomFailureReason>[],
  setFailureReason: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    runs: {
      list: async () => h.runs,
      setFailureReason: h.setFailureReason,
    },
    failureReasons: {
      list: async () => ({
        builtin: [
          { id: "regression", name: "Site regression", description: "" },
          { id: "timing", name: "Timing issue", description: "" },
        ],
        custom: h.custom,
      }),
    },
  },
}));

function run(over: Partial<RunRecord> = {}): Partial<RunRecord> {
  return {
    id: "r1",
    testId: "t1",
    testName: "Alpha",
    status: "failed",
    startedAt: 1,
    ...over,
  };
}

function renderRow(runId?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RunFailureReason runId={runId ?? "r1"} />
    </QueryClientProvider>,
  );
}

/** Answer the native menu with the item whose label matches, exactly as a
 *  click on that row would. Returns a getter for every label the popup was
 *  handed, so a test can also assert what the menu OFFERED. */
function chooseFromNativeMenu(label: string): () => string[] {
  interface Item {
    label?: string;
    commandId?: number;
    submenu?: Item[];
  }
  const seen: string[] = [];
  const popup = vi.fn(async ({ items }: { items: Item[] }) => {
    const flat: Item[] = [];
    const walk = (list: Item[]): void => {
      for (const i of list) {
        flat.push(i);
        if (i.submenu) walk(i.submenu);
      }
    };
    walk(items);
    for (const i of flat) if (i.label !== undefined) seen.push(i.label);
    const hit = flat.find((i) => i.label === label && i.commandId !== undefined);
    if (!hit)
      throw new Error(
        `no menu item labelled "${label}" (saw: ${flat.map((i) => i.label).join(", ")})`,
      );
    return { commandId: hit.commandId };
  });
  (window as unknown as { glazeAPI: { Menu: unknown } }).glazeAPI = { Menu: { popup } };
  fireEvent.click(document.getElementById("failure-reason-select") as HTMLElement);
  return () => seen;
}

beforeEach(() => {
  h.runs = [];
  h.custom = [];
  h.setFailureReason.mockReset();
  h.setFailureReason.mockImplementation(async (id: string, reasonId: string | null) => ({
    ...run(),
    id,
    ...(reasonId ? { failureReasonId: reasonId, failureReasonBy: "user" } : {}),
  }));
});

describe("what the row shows", () => {
  it("shows the assigned reason's name, and the auto tag for an automatic label", async () => {
    h.runs = [run({ failureReasonId: "regression", failureReasonBy: "auto" })];
    renderRow();
    expect(await screen.findByText("Site regression")).toBeTruthy();
    expect(screen.getByText("auto")).toBeTruthy();
  });

  it("shows Uncategorized for an unlabelled failure, with no auto tag", async () => {
    h.runs = [run()];
    renderRow();
    expect(await screen.findByText("Uncategorized")).toBeTruthy();
    expect(screen.queryByText("auto")).toBeNull();
  });

  it("drops the auto tag once the label is the user's", async () => {
    h.runs = [run({ failureReasonId: "timing", failureReasonBy: "user" })];
    renderRow();
    expect(await screen.findByText("Timing issue")).toBeTruthy();
    expect(screen.queryByText("auto")).toBeNull();
  });

  it("resolves a custom reason's CURRENT name — a rename reaches history", async () => {
    h.custom = [{ id: "c1", name: "Vendor outage", description: "" }];
    h.runs = [run({ failureReasonId: "c1", failureReasonBy: "user" })];
    renderRow();
    expect(await screen.findByText("Vendor outage")).toBeTruthy();
  });

  it("shows the raw id for a reason the catalog no longer knows, not a blank", async () => {
    h.runs = [run({ failureReasonId: "gone-id", failureReasonBy: "user" })];
    renderRow();
    expect(await screen.findByText("gone-id")).toBeTruthy();
  });

  it("renders nothing for a passed run or an unknown run id", async () => {
    h.runs = [run({ id: "r-pass", status: "passed" })];
    const { container } = renderRow("r-pass");
    // Wait for the queries to settle, then assert the ABSENCE — asserting
    // before they resolve would pass against a component that renders late.
    await waitFor(() => expect(container.querySelector(".gl-failure-reason")).toBeNull());
    const missing = renderRow("r-missing");
    await waitFor(() =>
      expect(missing.container.querySelector(".gl-failure-reason")).toBeNull(),
    );
  });
});

describe("what the picker offers and writes", () => {
  it("assigns the chosen reason over IPC and shows it without a refetch", async () => {
    h.runs = [run()];
    renderRow();
    await screen.findByText("Uncategorized");
    chooseFromNativeMenu("Timing issue");
    await waitFor(() => expect(h.setFailureReason).toHaveBeenCalledWith("r1", "timing"));
    expect(await screen.findByText("Timing issue")).toBeTruthy();
  });

  it("clears the label when Uncategorized is picked", async () => {
    h.runs = [run({ failureReasonId: "timing", failureReasonBy: "user" })];
    renderRow();
    await screen.findByText("Timing issue");
    chooseFromNativeMenu("Uncategorized");
    await waitFor(() => expect(h.setFailureReason).toHaveBeenCalledWith("r1", null));
  });

  it("offers enabled custom reasons and withholds disabled ones", async () => {
    h.custom = [
      { id: "c1", name: "Vendor outage", description: "" },
      { id: "c2", name: "Old reason", description: "", disabled: true },
    ];
    h.runs = [run()];
    renderRow();
    await screen.findByText("Uncategorized");
    // The enabled custom reason is pickable…
    const offered = chooseFromNativeMenu("Vendor outage");
    await waitFor(() => expect(h.setFailureReason).toHaveBeenCalledWith("r1", "c1"));
    // …and the disabled one was never in the menu that opened. Asserted off
    // the labels the popup was HANDED — the throw path inside the Select
    // swallows errors, so "picking it fails" would pass vacuously.
    await waitFor(() => expect(offered()).toContain("Vendor outage"));
    expect(offered()).not.toContain("Old reason");
  });

  it("withholds a deleted reason — even one missing the disabled flag it is written with", async () => {
    h.custom = [
      { id: "c1", name: "Vendor outage", description: "" },
      { id: "c3", name: "Cloudflare", description: "", deleted: true },
    ];
    h.runs = [run()];
    renderRow();
    await screen.findByText("Uncategorized");
    const offered = chooseFromNativeMenu("Vendor outage");
    await waitFor(() => expect(offered()).toContain("Vendor outage"));
    expect(offered()).not.toContain("Cloudflare");
  });

  it("keeps a deleted reason's NAME on the runs it already labels", async () => {
    h.custom = [{ id: "c3", name: "Cloudflare", description: "", disabled: true, deleted: true }];
    h.runs = [run({ failureReasonId: "c3", failureReasonBy: "user" })];
    renderRow();
    expect(await screen.findByText("Cloudflare")).toBeTruthy();
    expect(screen.queryByText("c3")).toBeNull();
  });

  it("keeps showing a disabled reason that is the CURRENT value", async () => {
    h.custom = [{ id: "c2", name: "Old reason", description: "", disabled: true }];
    h.runs = [run({ failureReasonId: "c2", failureReasonBy: "user" })];
    renderRow();
    expect(await screen.findByText("Old reason")).toBeTruthy();
  });
});
