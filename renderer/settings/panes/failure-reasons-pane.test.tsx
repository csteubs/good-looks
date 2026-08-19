// Tests for the Failure reasons pane.
//
// The properties pinned here are the store's rules as the pane exposes them:
// rename goes through `update` on the SAME id (a rename that created a new
// reason would orphan every labelled run), disable is offered instead of
// delete, built-ins render with no edit affordance, and the automatic-pass
// switch writes the one settings key it owns.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

import { renderPane, savedPatch } from "../__tests__/harness";
import { FailureReasonsPane } from "./failure-reasons-pane";
import type { CustomFailureReason } from "../../lib/recorder-types";

const { reasonsApi } = vi.hoisted(() => ({
  reasonsApi: {
    list: vi.fn(async () => ({
      builtin: [
        { id: "regression", name: "Site regression", description: "The site broke." },
        { id: "timing", name: "Timing issue", description: "Ran out of budget." },
      ],
      custom: [] as Partial<CustomFailureReason>[],
    })),
    create: vi.fn(async (name: string, description?: string) => ({
      id: "fr-new",
      name,
      description: description ?? "",
      createdAt: 1,
      updatedAt: 1,
    })),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
      id,
      name: "x",
      description: "",
      createdAt: 1,
      updatedAt: 2,
      ...patch,
    })),
  },
}));
vi.mock("../../lib/api", () => ({ api: { failureReasons: reasonsApi } }));

function withCustom(custom: Partial<CustomFailureReason>[]) {
  reasonsApi.list.mockResolvedValue({
    builtin: [
      { id: "regression", name: "Site regression", description: "The site broke." },
      { id: "timing", name: "Timing issue", description: "Ran out of budget." },
    ],
    custom,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  withCustom([]);
});

describe("the automatic switch", () => {
  it("is on at the defaults and writes its own key when toggled", async () => {
    const { controller } = renderPane(<FailureReasonsPane />);
    const toggle = screen.getByRole("switch", { name: /categorize failures automatically/i });
    expect(toggle.getAttribute("data-state")).toBe("checked");
    fireEvent.click(toggle);
    expect(savedPatch(controller)).toEqual({ autoFailureReasons: false });
  });
});

describe("built-in reasons", () => {
  it("lists them read-only — no rename or disable affordance", async () => {
    renderPane(<FailureReasonsPane />);
    expect(await screen.findByText("Site regression")).toBeTruthy();
    expect(screen.getByText("Timing issue")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /rename site regression/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /disable site regression/i })).toBeNull();
  });
});

describe("custom reasons", () => {
  it("creates one from the form and clears it on success", async () => {
    renderPane(<FailureReasonsPane />);
    await screen.findByText("Site regression");
    const name = screen.getByRole("textbox", { name: /new reason name/i });
    const description = screen.getByRole("textbox", { name: /new reason description/i });
    fireEvent.change(name, { target: { value: "Vendor outage" } });
    fireEvent.change(description, { target: { value: "Third party down." } });
    fireEvent.click(screen.getByRole("button", { name: /add custom reason/i }));
    await waitFor(() =>
      expect(reasonsApi.create).toHaveBeenCalledWith("Vendor outage", "Third party down."),
    );
    await waitFor(() => expect((name as HTMLInputElement).value).toBe(""));
  });

  it("refuses an empty name at the button, before the store has to", async () => {
    renderPane(<FailureReasonsPane />);
    await screen.findByText("Site regression");
    const add = screen.getByRole("button", { name: /add custom reason/i });
    expect((add as HTMLButtonElement).disabled).toBe(true);
  });

  it("renames through update on the SAME id", async () => {
    withCustom([{ id: "c1", name: "Vendor outage", description: "", createdAt: 1, updatedAt: 1 }]);
    renderPane(<FailureReasonsPane />);
    fireEvent.click(await screen.findByRole("button", { name: /rename vendor outage/i }));
    const name = screen.getByRole("textbox", { name: /new name for vendor outage/i });
    fireEvent.change(name, { target: { value: "Upstream outage" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(reasonsApi.update).toHaveBeenCalledWith("c1", {
        name: "Upstream outage",
        description: "",
      }),
    );
  });

  it("offers disable — never delete — and enable back", async () => {
    withCustom([
      { id: "c1", name: "Vendor outage", description: "", createdAt: 1, updatedAt: 1 },
      {
        id: "c2",
        name: "Old reason",
        description: "",
        disabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    renderPane(<FailureReasonsPane />);
    expect(screen.queryByRole("button", { name: /delete|remove/i })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /disable vendor outage/i }));
    await waitFor(() =>
      expect(reasonsApi.update).toHaveBeenCalledWith("c1", { disabled: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: /enable old reason/i }));
    await waitFor(() =>
      expect(reasonsApi.update).toHaveBeenCalledWith("c2", { disabled: false }),
    );
  });
});
