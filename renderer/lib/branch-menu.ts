// What the sidebar's branch hover menu shows.
//
// Pure, and in `renderer/lib` so `vitest`'s NODE project runs its tests without
// React, jsdom or the design system — the same reason `run-filters.ts` and
// `batch-run-plan.ts` live here. The flyout that renders this is a hover
// surface, and a hover surface is the worst possible place to debug a sorting
// rule; every decision the menu makes is therefore made here, where a test can
// state it as a sentence.
//
// ── "The five most recently created branches" ─────────────────────────
// GIT DOES NOT RECORD WHEN A BRANCH WAS CREATED. A ref is a file containing a
// sha; there is no creation timestamp, and nothing that could reconstruct one
// after a rebase, a force-push or a fresh clone (which writes every
// remote-tracking ref at the same instant). The available signal is the tip
// commit's committer date, which `listOriginBranches` already sorts by. For the
// PR branches this menu exists to serve, "created recently" and "committed to
// recently" are the same branches; where they differ — a long-lived branch that
// just got one commit — this ranks it as recent, which is also the answer
// somebody scanning the menu wants.
//
// ── Why the running branch is guaranteed a row ────────────────────────
// The first question a branch menu has to answer is "what am I running?", and
// on a build of a branch that has since fallen out of the five most recent, a
// menu obeying the count alone would not say. So the current branch displaces
// the OLDEST of the five rather than being appended: the list stays at five
// plus the pinned row, which is the shape the design asks for, and the row that
// gets dropped is the one least likely to be wanted.

import type { BranchStatus, BranchSummary, PullRequestSummary } from "./branch-types";

/** Branch rows below the pinned one. The pinned row is extra, so the menu is
 *  six rows: five branches and the way home. */
export const BRANCH_MENU_LIMIT = 5;

export interface BranchMenuPull {
  number: number;
  title: string;
  url: string;
  draft: boolean;
}

export interface BranchMenuEntry {
  /** The ref a switch would build. `null` on the pinned row, which returns to
   *  the user's checkout rather than building anything. */
  branch: string | null;
  /** What the row reads. */
  label: string;
  /** The second line — the tip's subject, or what the row does. */
  detail: string;
  /** The open pull request whose head is this branch, when there is one. Only
   *  ever set on a row the icon can act on: no PR, no icon. */
  pull?: BranchMenuPull;
  /** This is what the app is running right now. */
  current: boolean;
  /** The pinned row. */
  home: boolean;
}

export interface BranchMenuModel {
  entries: BranchMenuEntry[];
  /** Branches the menu did not show. Zero means the menu is the whole list, and
   *  the footer can say so instead of implying there is more. */
  hidden: number;
}

export interface BranchMenuInput {
  status: BranchStatus | undefined;
  branches: BranchSummary[] | undefined;
  /** Undefined while loading, or when the fetch failed, or when `origin` isn't
   *  GitHub. All three mean the same thing to this function: no icons. */
  pulls: PullRequestSummary[] | undefined;
}

/** The pinned row's label when the backend didn't say. Not "main" — guessing a
 *  branch name and printing it as fact is how a row comes to lie about where it
 *  goes. */
const UNKNOWN_CHECKOUT_LABEL = "Your checkout";

export function buildBranchMenu({ status, branches, pulls }: BranchMenuInput): BranchMenuModel {
  if (!status?.available) return { entries: [], hidden: 0 };

  const checkoutBranch = status.checkoutBranch ?? null;
  const switched = status.switched === true;
  const running = status.current ?? null;

  // ── The pinned row ────────────────────────────────────────────────
  const home: BranchMenuEntry = {
    branch: null,
    label: checkoutBranch ?? UNKNOWN_CHECKOUT_LABEL,
    detail: switched ? "Return to your checkout" : "You are here",
    current: !switched,
    home: true,
  };

  // ── The candidates ────────────────────────────────────────────────
  //
  // Sorted here rather than trusted: the backend does sort, but this function
  // is also handed fixtures and a cached list, and a menu whose order depends
  // on who called it is a menu nobody can reason about. Ties break on name so
  // the order is total — branches pushed in one operation share a second, and
  // an unstable order makes the menu shuffle between renders.
  const pullByBranch = new Map<string, PullRequestSummary>();
  for (const pull of pulls ?? []) {
    // Refs are case-sensitive, so this is an exact match. First writer wins:
    // two open PRs from one head ref is possible (different bases) and the API
    // returns them newest-updated first, which is the one to link.
    if (!pullByBranch.has(pull.branch)) pullByBranch.set(pull.branch, pull);
  }

  const candidates = (branches ?? [])
    // The pinned row already IS this branch, and offering it twice would give
    // the same destination two rows that do different things.
    .filter((b) => b.name !== checkoutBranch)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));

  let shown = candidates.slice(0, BRANCH_MENU_LIMIT);

  // The running branch always has a row — see the header. Only when it is a
  // branch build: unswitched, the pinned row is already the answer.
  if (switched && running && running !== checkoutBranch) {
    if (!shown.some((b) => b.name === running)) {
      const found = candidates.find((b) => b.name === running);
      // It may not be in the list at all — a branch deleted on origin since the
      // build, or a checkout that has not fetched since. Still worth a row,
      // because it is what is running.
      const entry: BranchSummary = found ?? { name: running, updatedAt: 0, subject: "" };
      shown = [...shown.slice(0, BRANCH_MENU_LIMIT - 1), entry];
    }
  }

  const entries: BranchMenuEntry[] = [
    home,
    ...shown.map((b) => {
      const pull = pullByBranch.get(b.name);
      return {
        branch: b.name,
        label: b.name,
        detail: b.subject || "No commit subject",
        ...(pull
          ? {
              pull: {
                number: pull.number,
                title: pull.title,
                url: pull.url,
                draft: pull.draft,
              },
            }
          : {}),
        current: switched && b.name === running,
        home: false,
      };
    }),
  ];

  // Counted by NAME, not `candidates.length - shown.length`: the running branch
  // may be a row that was never a candidate (deleted on origin, or not fetched
  // since), and subtracting lengths would then report one branch too few as
  // hidden — a footer quietly understating what the full view holds.
  const shownNames = new Set(shown.map((b) => b.name));
  const hidden = candidates.filter((b) => !shownNames.has(b.name)).length;

  return { entries, hidden };
}
