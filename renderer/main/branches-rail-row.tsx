// The sidebar's Branches row, and the menu that hovers out of it.
//
// ── What a click costs, and why there is a dialog in front of it ──────
// Choosing a branch here is not navigation. It fetches, creates a git worktree
// under the app's data directory, installs, builds, and RELAUNCHES the app onto
// the result — minutes, during which the window the click happened in goes
// away. That is far too much to hang off a menu the pointer can open by
// resting, so the confirm names the branch and states the cost, and says the
// one thing that makes it safe to say yes to: the user's own checkout is not
// touched.
//
// ── The menu is a shortcut INTO the Branches view ─────────────────────
// It does not run the switch itself. The Branches view already renders the
// progress of one — the step list, the build output, the `branches:progress`
// push — so this records the request (`pending-branch-switch.ts`), navigates,
// and lets that view start it. The alternative is a multi-minute build with
// nowhere to watch it, or that whole panel duplicated into the rail.
//
// ── Nothing is fetched until the menu is opened ───────────────────────
// The branch list shells out to git and the pull requests hit the network.
// Neither should happen because the app started; both should have happened by
// the time the menu is on screen. `armed` flips on the first open and stays on,
// so a second hover is instant. The query keys are the Branches view's own, so
// opening the full view after hovering costs nothing at all — and hovering
// after visiting the view shows the list immediately.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { AlertDialog } from "@ui";

import { RailFlyout, RailRow } from "../theme";
import { api } from "../lib/api";
import { buildBranchMenu } from "../lib/branch-menu";
import { BranchMenu } from "./branch-menu";
import { requestBranchSwitch } from "./pending-branch-switch";

interface Pending {
  /** `null` is the pinned row — back to the user's checkout. */
  branch: string | null;
  label: string;
}

export function BranchesRailRow({
  selected,
  onOpenBranches,
}: {
  selected: boolean;
  /** Navigate to the Branches view. Passed in rather than taken from the
   *  router, so this component renders in a test without one. */
  onOpenBranches: () => void;
}): React.ReactElement {
  const [armed, setArmed] = React.useState(false);
  const [pending, setPending] = React.useState<Pending | null>(null);

  // Shares `["branches", "status"]` with the sidebar's own availability check
  // and with the view, so this is already in cache by the time the row renders.
  const status = useQuery({
    queryKey: ["branches", "status"],
    queryFn: api.branches.status,
    staleTime: Infinity,
  });
  const branches = useQuery({
    queryKey: ["branches", "list"],
    queryFn: () => api.branches.listBranches(false),
    enabled: armed,
    retry: false,
  });
  const pulls = useQuery({
    queryKey: ["branches", "pulls"],
    queryFn: api.branches.listPulls,
    // No GitHub remote means there are no pull requests to ask for — asking
    // would throw, and an error toast about a repo that simply isn't on GitHub
    // is noise on a menu that works fine without icons.
    enabled: armed && (status.data?.repo ?? null) !== null,
    retry: false,
  });

  const model = buildBranchMenu({
    status: status.data,
    branches: branches.data,
    // `undefined` for a failed or rate-limited fetch as well as a pending one:
    // all of them mean "no icons", and `buildBranchMenu` says so in one place.
    pulls: pulls.data,
  });

  const confirmBody = pending?.branch
    ? `This checks ${pending.branch} out into its own worktree, installs, builds it, and relaunches the app onto that build. It takes a few minutes. Your own checkout is not touched, and you can come back to it from this menu.`
    : "This relaunches the app from your own checkout, leaving the branch build behind. Nothing is deleted.";

  return (
    <>
      <RailFlyout label="Branches" onOpenChange={(open) => open && setArmed(true)}
        panel={
          <BranchMenu
            model={model}
            loading={branches.isLoading}
            onChoose={(branch) => {
              const entry = model.entries.find((e) => e.branch === branch);
              // Choosing the row you are already on would rebuild and relaunch
              // to arrive exactly where you are.
              if (entry?.current) return;
              setPending({ branch, label: entry?.label ?? branch ?? "your checkout" });
            }}
            onSeeAll={onOpenBranches}
          />
        }
      >
        {(trigger) => (
          <RailRow
            {...trigger}
            icon={<GitBranch aria-hidden="true" />}
            title="Branches"
            subtitle="Run a PR of this app"
            selected={selected}
            onClick={onOpenBranches}
          />
        )}
      </RailFlyout>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.branch ? `Run ${pending.label}?` : "Return to your checkout?"}
        description={confirmBody}
        confirmLabel={pending?.branch ? "Build and run it" : "Return"}
        onConfirm={() => {
          if (!pending) return;
          requestBranchSwitch(pending.branch);
          setPending(null);
          // The view starts it — see `pending-branch-switch.ts`. Navigating
          // first means the progress panel is already on screen when the first
          // `branches:progress` push arrives.
          onOpenBranches();
        }}
      />
    </>
  );
}
