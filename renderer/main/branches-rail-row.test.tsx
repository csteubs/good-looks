// The Branches rail row: hover, confirm, hand off.
//
// The assertions that matter here are the NEGATIVE ones. Choosing a branch in
// this menu eventually spends minutes on a build and takes the user's window
// away, so what has to be true is that nothing is requested until the dialog is
// confirmed — and a negative assertion is exactly the kind that passes
// vacuously if the surface it names stops rendering. Each one below is paired
// with a positive test that the same path DOES work, so a menu that silently
// stopped opening cannot leave this file green.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BranchesRailRow } from "./branches-rail-row";
import { clearBranchSwitch, takeBranchSwitch } from "./pending-branch-switch";
import type { BranchStatus, BranchSummary, PullRequestSummary } from "../lib/branch-types";

const PAST_OPEN_DELAY = 200;

const status = vi.fn<() => Promise<BranchStatus>>();
const listBranches = vi.fn<() => Promise<BranchSummary[]>>();
const listPulls = vi.fn<() => Promise<PullRequestSummary[]>>();

vi.mock("../lib/api", () => ({
  api: {
    branches: {
      status: () => status(),
      listBranches: () => listBranches(),
      listPulls: () => listPulls(),
    },
  },
}));

const DAY = 86_400_000;

function defaultStatus(over: Partial<BranchStatus> = {}): BranchStatus {
  return {
    available: true,
    switched: false,
    hasToken: true,
    current: "main",
    checkoutBranch: "main",
    repo: { owner: "csteubs", name: "good-looks" },
    ...over,
  };
}

beforeEach(() => {
  clearBranchSwitch();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  status.mockReset().mockResolvedValue(defaultStatus());
  listBranches.mockReset().mockResolvedValue([
    { name: "feat/a", updatedAt: 10 * DAY, subject: "add the thing" },
    { name: "feat/b", updatedAt: 9 * DAY, subject: "fix the thing" },
  ]);
  listPulls.mockReset().mockResolvedValue([
    {
      number: 42,
      title: "Add the thing",
      branch: "feat/a",
      author: "csteubs",
      draft: false,
      updatedAt: "2026-08-11T00:00:00Z",
      url: "https://github.com/csteubs/good-looks/pull/42",
      fork: false,
    },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

function renderRow(over: Partial<BranchStatus> = {}) {
  if (Object.keys(over).length > 0) status.mockResolvedValue(defaultStatus(over));
  const onOpenBranches = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <BranchesRailRow selected={false} onOpenBranches={onOpenBranches} />
    </QueryClientProvider>,
  );
  return { onOpenBranches };
}

async function openMenu(): Promise<void> {
  fireEvent.pointerEnter(screen.getByRole("button", { name: /Branches/ }));
  await act(async () => {
    vi.advanceTimersByTime(PAST_OPEN_DELAY);
  });
  await screen.findByRole("menu", { name: "Branches" });
}

describe("BranchesRailRow — nothing is fetched until the menu opens", () => {
  it("does not read branches or pull requests just because the app started", async () => {
    // Shelling out to git and hitting the network on every app launch, for a
    // menu nobody opened. Paired with the test below, so a menu that stopped
    // opening cannot make this pass by accident.
    renderRow();
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(listBranches).not.toHaveBeenCalled();
    expect(listPulls).not.toHaveBeenCalled();
  });

  it("reads them when the menu opens", async () => {
    renderRow();
    await openMenu();
    await waitFor(() => expect(listBranches).toHaveBeenCalled());
    await waitFor(() => expect(listPulls).toHaveBeenCalled());
  });

  it("does not ask for pull requests when origin is not GitHub", async () => {
    // The call throws in that case, and an error about a repo that simply
    // isn't on GitHub is noise on a menu that works fine without icons.
    renderRow({ repo: null });
    await openMenu();
    await waitFor(() => expect(listBranches).toHaveBeenCalled());
    expect(listPulls).not.toHaveBeenCalled();
  });
});

describe("BranchesRailRow — the confirm gate", () => {
  it("asks before switching, naming the branch and the cost", async () => {
    renderRow();
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /feat\/a/ }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("feat/a");
    expect(dialog.textContent).toContain("relaunches");
    // The sentence that makes it safe to say yes.
    expect(dialog.textContent).toContain("checkout is not touched");
  });

  it("requests NOTHING until the dialog is confirmed", async () => {
    // The assertion the feature exists to be safe about. Its positive twin is
    // the next test, so this cannot pass merely because the menu broke.
    renderRow();
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /feat\/a/ }));
    await screen.findByRole("alertdialog");

    expect(takeBranchSwitch()).toBeUndefined();
  });

  it("records the branch and opens the view once confirmed", async () => {
    const { onOpenBranches } = renderRow();
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /feat\/a/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Build and run it/ }));

    expect(takeBranchSwitch()).toBe("feat/a");
    expect(onOpenBranches).toHaveBeenCalled();
  });

  it("requests nothing when the dialog is cancelled", async () => {
    renderRow();
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /feat\/a/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(takeBranchSwitch()).toBeUndefined();
  });

  it("asks a different question for the way home", async () => {
    // Returning to the checkout is not a build, and describing it as one would
    // make people decline the cheap, safe half of this menu.
    renderRow({ switched: true, current: "feat/a" });
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /main/ }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Return to your checkout");
    expect(dialog.textContent).toContain("Nothing is deleted");
    expect(dialog.textContent).not.toContain("takes a few minutes");
  });

  it("records null for the way home", async () => {
    renderRow({ switched: true, current: "feat/a" });
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /main/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Return" }));

    expect(takeBranchSwitch()).toBeNull();
  });
});

describe("BranchesRailRow — the row you are already on", () => {
  it("does not offer to rebuild what is already running", async () => {
    // A build and a relaunch to arrive exactly where you are.
    renderRow();
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /main/ }));

    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(takeBranchSwitch()).toBeUndefined();
  });

  it("still offers the OTHER rows while on that branch", async () => {
    // Paired with the test above: it must not be skipping every row.
    renderRow();
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /feat\/a/ }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
  });
});

describe("BranchesRailRow — the row itself", () => {
  it("opens the full view on click, as it did before there was a menu", async () => {
    const { onOpenBranches } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: /Branches/ }));
    expect(onOpenBranches).toHaveBeenCalled();
  });

  it("opens the full view from the menu's footer", async () => {
    const { onOpenBranches } = renderRow();
    await openMenu();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /All branches and pull requests/ }),
    );
    expect(onOpenBranches).toHaveBeenCalled();
  });

  it("still shows a usable menu when the branch list fails", async () => {
    // git missing, or a repository this app cannot read. The way home is the
    // row most worth having when everything else failed.
    listBranches.mockRejectedValue(new Error("git is not installed"));
    renderRow();
    await openMenu();
    expect(await screen.findByRole("menuitem", { name: /main/ })).toBeTruthy();
  });

  it("still lists branches when the pull-request fetch fails", async () => {
    // The unauthenticated rate limit is 60 requests an hour, shared across the
    // machine — so this is the common case, not the edge case.
    listPulls.mockRejectedValue(new Error("GitHub answered 403"));
    renderRow();
    await openMenu();
    expect(await screen.findByRole("menuitem", { name: /feat\/a/ })).toBeTruthy();
    await waitFor(() => expect(listPulls).toHaveBeenCalled());
    expect(screen.queryByRole("menuitem", { name: /Open pull request/ })).toBeNull();
  });
});
