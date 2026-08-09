// Component tests for the Branches view.
//
// Three things are worth pinning, in descending order of how quietly they'd
// break:
//
//   1. The unavailable path. This is the ONLY view in the app that is sometimes
//      not usable at all, and the way it fails is by rendering nothing useful.
//      "The feature can't work here, and here's why" and "the feature is
//      broken" look identical from a blank pane, so the reason has to be on
//      screen — and no switch control may be, or the explanation is beside a
//      button that contradicts it.
//   2. Which branch a click switches to. A row shows a PR title; the thing that
//      gets built is its HEAD REF. Wiring the button to anything else — the
//      title, the number, the previous row — produces a switch that works and
//      runs the wrong code, which is undetectable from the UI afterwards.
//   3. Fork PRs. Their head branch isn't on `origin`, so there is nothing to
//      check out. Offering the button anyway means a build that dies in git.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { BranchStatus, BranchSummary, PullRequestSummary } from "../lib/branch-types";
import { BranchesView } from "./branches-view";

let status: BranchStatus;
let pulls: PullRequestSummary[];
/** Set to make the pull-request query reject, for the error-rendering path. */
let pullsError: Error | null;
let branches: BranchSummary[];
const switchTo = vi.fn(async (_branch: string) => ({ appPath: "/tmp/x" }));
const home = vi.fn(async () => ({ appPath: "/repo" }));

vi.mock("../lib/api", () => ({
  api: {
    branches: {
      status: async () => status,
      listPulls: async () => {
        if (pullsError) throw pullsError;
        return pulls;
      },
      listBranches: async () => branches,
      switch: (branch: string) => switchTo(branch),
      home: () => home(),
      setToken: async () => ({ hasToken: true }),
      clearToken: async () => ({ hasToken: false }),
    },
    on: () => () => {},
  },
}));

function pull(partial: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 41,
    title: "Fix the trainer panel dock",
    branch: "fix/trainer-dock",
    author: "csteubs",
    draft: false,
    updatedAt: "2026-08-08T10:00:00Z",
    url: "https://github.com/csteubs/good-looks/pull/41",
    fork: false,
    ...partial,
  };
}

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BranchesView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  status = {
    available: true,
    switched: false,
    hasToken: false,
    checkout: "/repo",
    appPath: "/repo",
    repo: { owner: "csteubs", name: "good-looks" },
    current: "main",
  };
  pulls = [pull()];
  pullsError = null;
  branches = [{ name: "main", updatedAt: 1_700_000_000_000, subject: "Latest on main" }];
});

describe("when the feature can't work here", () => {
  it("shows the reason instead of an empty list", async () => {
    status = {
      available: false,
      switched: false,
      hasToken: false,
      reason: "The browser preview has no backend — no git, no build, no way to relaunch anything.",
    };
    view();

    // Waiting for the CONTENT, not the container: the toolbar renders before
    // the status query resolves, so asserting on the heading would pass against
    // a view that never got its answer.
    expect(await screen.findByText(/no git, no build/)).toBeTruthy();
    expect(screen.queryByText("Run this")).toBeNull();
  });
});

describe("switching", () => {
  it("switches to a pull request's head ref, not its title or number", async () => {
    // No branch rows: every row carries a button labelled "Run this", and an
    // ambiguous findByRole retries until it times out — which reports as "never
    // rendered" rather than "your query matched two things".
    branches = [];
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Run this" }));

    await waitFor(() => expect(switchTo).toHaveBeenCalledTimes(1));
    expect(switchTo).toHaveBeenCalledWith("fix/trainer-dock");
  });

  it("offers no switch for a fork, and says why", async () => {
    pulls = [pull({ fork: true })];
    // Only `main` is left as a switchable row, so a stray "Run this" would be
    // the fork's.
    branches = [];
    view();

    expect(await screen.findByText(/From a fork/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run this" })).toBeNull();
  });

  it("offers the way home only while a branch build is running", async () => {
    const { unmount } = view();
    expect(await screen.findByText(/Fix the trainer panel/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Back to my checkout/ })).toBeNull();
    unmount();

    status = { ...status, switched: true, current: "fix/trainer-dock" };
    view();
    fireEvent.click(await screen.findByRole("button", { name: /Back to my checkout/ }));
    await waitFor(() => expect(home).toHaveBeenCalledTimes(1));
  });

  it("does not offer to switch to the branch already running", async () => {
    pulls = [];
    branches = [{ name: "main", updatedAt: 1_700_000_000_000, subject: "Latest on main" }];
    view();

    // A row, but a dead button: rebuilding and relaunching onto what is already
    // running is a minutes-long no-op that looks like the app crashing.
    const button = await screen.findByRole("button", { name: "Run this" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("explaining a failure", () => {
  it("shows the reason without Electron's IPC plumbing in front of it", async () => {
    // The message IS the page here — it is what tells you a private repository
    // needs a token. Electron prefixes anything a handler throws with the
    // channel name, which buries the actionable half at the end of a line of
    // plumbing. Verified against the real prefix, exactly as Electron writes it.
    pullsError = new Error(
      "Error invoking remote method 'branches:listPulls': Error: GitHub answered 404. Save a token below.",
    );
    view();

    expect(await screen.findByText(/GitHub answered 404\. Save a token below\./)).toBeTruthy();
    expect(screen.queryByText(/remote method/)).toBeNull();
  });
});

describe("the shared data directory", () => {
  it("warns that a branch build writes to the same stores", async () => {
    // The one consequence of this feature that cannot be undone by switching
    // back. It has to be readable at the moment of the click, so it is asserted
    // as being on the same screen as the switch controls.
    view();
    expect(await screen.findByText(/shares this app/i)).toBeTruthy();
  });
});
