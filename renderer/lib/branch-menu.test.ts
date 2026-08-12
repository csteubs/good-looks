// The branch hover menu's rules, stated one per test.
//
// Runs in the NODE project (`renderer/lib/**/*.test.ts`) — no React, no jsdom.
// That is the point of putting the rules in a pure module: a hover flyout is
// the worst surface on which to debug an ordering bug, and every one of these
// would otherwise be reachable only by pointing at a menu.

import { describe, expect, it } from "vitest";

import { BRANCH_MENU_LIMIT, buildBranchMenu } from "./branch-menu";
import type { BranchStatus, BranchSummary, PullRequestSummary } from "./branch-types";

const DAY = 86_400_000;

function status(over: Partial<BranchStatus> = {}): BranchStatus {
  return {
    available: true,
    switched: false,
    hasToken: false,
    current: "main",
    checkoutBranch: "main",
    ...over,
  };
}

function branch(name: string, daysAgo: number, subject = `work on ${name}`): BranchSummary {
  return { name, updatedAt: 10 * DAY - daysAgo * DAY, subject };
}

function pull(over: Partial<PullRequestSummary> & { branch: string }): PullRequestSummary {
  return {
    number: 1,
    title: `PR for ${over.branch}`,
    author: "csteubs",
    draft: false,
    updatedAt: "2026-08-11T00:00:00Z",
    url: `https://github.com/csteubs/good-looks/pull/${over.number ?? 1}`,
    fork: false,
    ...over,
  };
}

/** The branch rows, in order — everything but the pinned one. */
function branchNames(model: ReturnType<typeof buildBranchMenu>): (string | null)[] {
  return model.entries.filter((e) => !e.home).map((e) => e.branch);
}

describe("buildBranchMenu — when there is a menu at all", () => {
  it("is empty when the branch switcher is unavailable", () => {
    // The rail row is hidden in this case, so a populated menu would be a
    // flyout on a control the user cannot see.
    const model = buildBranchMenu({
      status: status({ available: false }),
      branches: [branch("feat/a", 1)],
      pulls: [pull({ branch: "feat/a" })],
    });
    expect(model.entries).toEqual([]);
    expect(model.hidden).toBe(0);
  });

  it("is empty before the status query resolves", () => {
    expect(buildBranchMenu({ status: undefined, branches: undefined, pulls: undefined }).entries)
      .toEqual([]);
  });

  it("still shows the pinned row when the branch list has not loaded", () => {
    // "Return to my checkout" needs no branch list, and it is the row most
    // worth having during a slow fetch.
    const model = buildBranchMenu({ status: status(), branches: undefined, pulls: undefined });
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0].home).toBe(true);
  });
});

describe("buildBranchMenu — the pinned row", () => {
  it("comes first, labelled with the checkout's own branch", () => {
    const model = buildBranchMenu({
      status: status({ checkoutBranch: "main" }),
      branches: [branch("feat/a", 1)],
      pulls: [],
    });
    expect(model.entries[0]).toMatchObject({ home: true, branch: null, label: "main" });
  });

  it("labels itself from the CHECKOUT, not from what is running", () => {
    // The whole reason `checkoutBranch` was added. While a branch build runs,
    // `current` is that branch; a pinned row reading "feat/x" that returns you
    // to main is a row that lies about where it goes.
    const model = buildBranchMenu({
      status: status({ switched: true, current: "feat/x", checkoutBranch: "main" }),
      branches: [branch("feat/x", 1)],
      pulls: [],
    });
    expect(model.entries[0].label).toBe("main");
    expect(model.entries[0].detail).toBe("Return to your checkout");
  });

  it("says a name it does not know rather than guessing one", () => {
    // Printing "main" here would be right almost always, and silently wrong on
    // exactly the checkout where being wrong matters.
    const model = buildBranchMenu({
      status: status({ checkoutBranch: undefined }),
      branches: [],
      pulls: [],
    });
    expect(model.entries[0].label).toBe("Your checkout");
    expect(model.entries[0].label).not.toBe("main");
  });

  it("is the current row when no branch build is running", () => {
    const model = buildBranchMenu({ status: status({ switched: false }), branches: [], pulls: [] });
    expect(model.entries[0].current).toBe(true);
    expect(model.entries[0].detail).toBe("You are here");
  });

  it("is not the current row while a branch build is running", () => {
    const model = buildBranchMenu({
      status: status({ switched: true, current: "feat/x" }),
      branches: [branch("feat/x", 1)],
      pulls: [],
    });
    expect(model.entries[0].current).toBe(false);
  });

  it("never appears a second time in the branch rows", () => {
    // `origin/main` is in the branch list like any other ref. Two rows for one
    // destination that do different things is the bug.
    const model = buildBranchMenu({
      status: status({ checkoutBranch: "main" }),
      branches: [branch("main", 0), branch("feat/a", 1)],
      pulls: [],
    });
    expect(branchNames(model)).toEqual(["feat/a"]);
  });
});

describe("buildBranchMenu — which five", () => {
  it("shows the five most recently updated, newest first", () => {
    const model = buildBranchMenu({
      status: status(),
      branches: [
        branch("feat/e", 5),
        branch("feat/a", 1),
        branch("feat/c", 3),
        branch("feat/b", 2),
        branch("feat/f", 6),
        branch("feat/d", 4),
      ],
      pulls: [],
    });
    expect(branchNames(model)).toEqual(["feat/a", "feat/b", "feat/c", "feat/d", "feat/e"]);
    expect(branchNames(model)).toHaveLength(BRANCH_MENU_LIMIT);
  });

  it("sorts what it is given rather than trusting the caller's order", () => {
    // The backend sorts, but this is also handed fixtures and a cached list.
    // A menu whose order depends on who called it cannot be reasoned about.
    const model = buildBranchMenu({
      status: status(),
      branches: [branch("old", 9), branch("new", 0)],
      pulls: [],
    });
    expect(branchNames(model)).toEqual(["new", "old"]);
  });

  it("breaks ties on name, so the order is total", () => {
    // Branches pushed in one operation share a timestamp. An unstable order
    // makes the menu reshuffle between renders for no visible reason.
    const same = 5 * DAY;
    const model = buildBranchMenu({
      status: status(),
      branches: [
        { name: "feat/b", updatedAt: same, subject: "" },
        { name: "feat/a", updatedAt: same, subject: "" },
      ],
      pulls: [],
    });
    expect(branchNames(model)).toEqual(["feat/a", "feat/b"]);
  });

  it("reports how many branches it did not show", () => {
    const model = buildBranchMenu({
      status: status(),
      branches: Array.from({ length: 9 }, (_, i) => branch(`feat/${i}`, i)),
      pulls: [],
    });
    expect(branchNames(model)).toHaveLength(BRANCH_MENU_LIMIT);
    expect(model.hidden).toBe(4);
  });

  it("reports nothing hidden when the menu is the whole list", () => {
    const model = buildBranchMenu({
      status: status(),
      branches: [branch("feat/a", 1), branch("feat/b", 2)],
      pulls: [],
    });
    expect(model.hidden).toBe(0);
  });

  it("carries the tip's subject as the second line", () => {
    const model = buildBranchMenu({
      status: status(),
      branches: [branch("feat/a", 1, "fix the thing")],
      pulls: [],
    });
    expect(model.entries[1].detail).toBe("fix the thing");
  });

  it("says so rather than rendering a blank second line", () => {
    const model = buildBranchMenu({
      status: status(),
      branches: [{ name: "feat/a", updatedAt: DAY, subject: "" }],
      pulls: [],
    });
    expect(model.entries[1].detail).toBe("No commit subject");
  });
});

describe("buildBranchMenu — the running branch always has a row", () => {
  it("displaces the oldest of the five when it would fall outside them", () => {
    // "What am I running?" is the first question this menu answers. It stays at
    // five rows, so the drop is the least recent one.
    const model = buildBranchMenu({
      status: status({ switched: true, current: "feat/old" }),
      branches: [
        branch("feat/1", 1),
        branch("feat/2", 2),
        branch("feat/3", 3),
        branch("feat/4", 4),
        branch("feat/5", 5),
        branch("feat/6", 6),
        branch("feat/old", 40),
      ],
      pulls: [],
    });
    expect(branchNames(model)).toEqual(["feat/1", "feat/2", "feat/3", "feat/4", "feat/old"]);
    expect(branchNames(model)).toHaveLength(BRANCH_MENU_LIMIT);
  });

  it("does not duplicate it when it is already among the five", () => {
    const model = buildBranchMenu({
      status: status({ switched: true, current: "feat/2" }),
      branches: [branch("feat/1", 1), branch("feat/2", 2)],
      pulls: [],
    });
    expect(branchNames(model)).toEqual(["feat/1", "feat/2"]);
  });

  it("gives it a row even when it is no longer on origin", () => {
    // A branch deleted after its PR merged, or a checkout that has not fetched
    // since the build. It is still what is running.
    const model = buildBranchMenu({
      status: status({ switched: true, current: "feat/gone" }),
      branches: [branch("feat/1", 1)],
      pulls: [],
    });
    expect(branchNames(model)).toContain("feat/gone");
  });

  it("counts hidden branches by name, so a row that was never a candidate does not miscount", () => {
    // The bug: `candidates.length - shown.length` reports one too few hidden
    // when one shown row came from `current` rather than from the list.
    const model = buildBranchMenu({
      status: status({ switched: true, current: "feat/gone" }),
      branches: Array.from({ length: 8 }, (_, i) => branch(`feat/${i}`, i)),
      pulls: [],
    });
    expect(model.hidden).toBe(4);
    expect(branchNames(model)).toHaveLength(BRANCH_MENU_LIMIT);
  });

  it("marks exactly one row as current", () => {
    const model = buildBranchMenu({
      status: status({ switched: true, current: "feat/2" }),
      branches: [branch("feat/1", 1), branch("feat/2", 2)],
      pulls: [],
    });
    expect(model.entries.filter((e) => e.current).map((e) => e.branch)).toEqual(["feat/2"]);
  });
});

describe("buildBranchMenu — the pull-request icon", () => {
  it("attaches a PR to the branch that is its head ref", () => {
    const model = buildBranchMenu({
      status: status(),
      branches: [branch("feat/a", 1), branch("feat/b", 2)],
      pulls: [pull({ branch: "feat/b", number: 42 })],
    });
    expect(model.entries[1].pull).toBeUndefined();
    expect(model.entries[2].pull).toMatchObject({
      number: 42,
      url: "https://github.com/csteubs/good-looks/pull/42",
    });
  });

  it("leaves rows without an open PR with no icon to click", () => {
    const model = buildBranchMenu({
      status: status(),
      branches: [branch("feat/a", 1)],
      pulls: [pull({ branch: "some/other/branch" })],
    });
    expect(model.entries[1].pull).toBeUndefined();
  });

  it("matches head refs exactly, case included", () => {
    // Git refs are case-sensitive. A case-insensitive match would point the
    // icon at a different pull request than the row names.
    const model = buildBranchMenu({
      status: status(),
      branches: [branch("Feat/A", 1)],
      pulls: [pull({ branch: "feat/a", number: 7 })],
    });
    expect(model.entries[1].pull).toBeUndefined();
  });

  it("shows no icons at all when the PR fetch did not answer", () => {
    // Undefined covers loading, a failed request, a rate limit, and a remote
    // that isn't GitHub. All four mean the same thing here.
    const model = buildBranchMenu({
      status: status(),
      branches: [branch("feat/a", 1)],
      pulls: undefined,
    });
    expect(model.entries.every((e) => e.pull === undefined)).toBe(true);
  });

  it("takes the first of two open PRs from one head ref", () => {
    // Possible with different bases. The API returns newest-updated first,
    // which is the one worth linking.
    const model = buildBranchMenu({
      status: status(),
      branches: [branch("feat/a", 1)],
      pulls: [pull({ branch: "feat/a", number: 9 }), pull({ branch: "feat/a", number: 3 })],
    });
    expect(model.entries[1].pull?.number).toBe(9);
  });

  it("carries the draft flag through, so the row can say so", () => {
    const model = buildBranchMenu({
      status: status(),
      branches: [branch("feat/a", 1)],
      pulls: [pull({ branch: "feat/a", draft: true })],
    });
    expect(model.entries[1].pull?.draft).toBe(true);
  });

  it("never puts a pull request on the pinned row", () => {
    // A PR whose head ref happens to be the checkout's branch. The pinned row
    // returns you home; it is not that pull request.
    const model = buildBranchMenu({
      status: status({ checkoutBranch: "main" }),
      branches: [branch("main", 0)],
      pulls: [pull({ branch: "main", number: 5 })],
    });
    expect(model.entries[0].pull).toBeUndefined();
  });
});
