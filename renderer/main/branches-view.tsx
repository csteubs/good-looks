// The Branches view (route /branches) — open pull requests against this app's
// own repository, and a way to run any of them.
//
// This is a tool for whoever is building Good Looks, not a feature of the
// product, and it is the only view that is sometimes absent: the sidebar entry
// renders only when `branches:status` says the feature is available, which it
// is not in a packaged build and not in the browser preview. See
// main/services/branch-switcher.ts for why those are hard stops rather than
// degraded modes.
//
// ── Why the warning is where it is ────────────────────────────────────────
// A branch build shares this app's DATA DIRECTORY — same test library, same run
// history, same saved keys. That is what makes it worth doing (you see the
// branch behave against real data) and it is also the whole risk: a branch that
// changes a store's format changes YOUR store, and switching back does not
// undo it. That sentence sits next to the switch button rather than in a doc,
// because the only moment it can be acted on is the moment before the click.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Input,
  ScrollArea,
  Text,
  Toolbar,
  ToolbarActions,
  ToolbarContent,
  ToolbarDescription,
  ToolbarTitle,
  toast,
} from "@ui";
import { GitBranch, GitPullRequest, Home, RefreshCw } from "lucide-react";

import { api } from "../lib/api";
import type { BranchSummary, PullRequestSummary, SwitchProgress } from "../lib/branch-types";

function fmtWhen(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * A backend error as a sentence, without the IPC plumbing in front of it.
 *
 * Electron wraps anything a handler throws as `Error invoking remote method
 * 'branches:listPulls': Error: …`. Everywhere else in the app these go to a
 * toast, where the prefix is ugly but brief. Here the message is the PAGE — it
 * is what explains that a private repository needs a token — and forty
 * characters of channel name before the explanation buries the part that tells
 * you what to do.
 */
function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "");
}

/**
 * The live build log.
 *
 * Rendered as a plain scrolling block rather than a progress bar because a
 * branch build has no meaningful percentage: `npm ci` on a diverged lockfile is
 * minutes, a symlinked one is instant, and a build that has stalled looks
 * exactly like a bar that is still moving. Lines arriving is the only honest
 * signal that it is still working.
 */
function SwitchLog({ steps, lines }: { steps: string[]; lines: string[] }) {
  const bottom = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lines.length, steps.length]);

  return (
    <div className="border-separator flex min-h-0 flex-1 flex-col gap-2 border-t p-4">
      <div className="flex flex-col gap-1">
        {steps.map((step, i) => (
          <Text key={i} variant="small" color={i === steps.length - 1 ? "primary" : "secondary"}>
            {i === steps.length - 1 ? "▸ " : "✓ "}
            {step}
          </Text>
        ))}
      </div>
      {lines.length > 0 ? (
        <ScrollArea className="bg-control-subtle min-h-0 flex-1 rounded">
          <pre className="text-tertiary p-2 font-mono text-xs whitespace-pre-wrap">
            {lines.join("\n")}
          </pre>
          <div ref={bottom} />
        </ScrollArea>
      ) : null}
    </div>
  );
}

function PullRow({
  pull,
  disabled,
  onSwitch,
}: {
  pull: PullRequestSummary;
  disabled: boolean;
  onSwitch: () => void;
}) {
  return (
    <div className="border-separator flex items-center gap-3 border-b px-3 py-2">
      <GitPullRequest className="text-tertiary size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <Text variant="small" className="truncate font-medium">
            {pull.title}
          </Text>
          {pull.draft ? <Badge variant="secondary">Draft</Badge> : null}
        </div>
        <Text variant="small" color="tertiary" className="truncate">
          #{pull.number} · {pull.author} · {pull.branch}
        </Text>
      </div>
      {pull.fork ? (
        // A fork's head branch is not on `origin`, so there is nothing here to
        // fetch. Saying which is far more useful than a button that fails with
        // git's own "couldn't find remote ref".
        <Text variant="small" color="tertiary" className="shrink-0">
          From a fork — not on origin
        </Text>
      ) : (
        <Button size="small" variant="secondary" disabled={disabled} onClick={onSwitch}>
          Run this
        </Button>
      )}
    </div>
  );
}

function BranchRow({
  branch,
  current,
  disabled,
  onSwitch,
}: {
  branch: BranchSummary;
  current: boolean;
  disabled: boolean;
  onSwitch: () => void;
}) {
  return (
    <div className="border-separator flex items-center gap-3 border-b px-3 py-2">
      <GitBranch className="text-tertiary size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <Text variant="small" className="truncate font-medium">
            {branch.name}
          </Text>
          {current ? <Badge color="green">Running</Badge> : null}
        </div>
        <Text variant="small" color="tertiary" className="truncate">
          {branch.subject}
        </Text>
      </div>
      <Text variant="small" color="tertiary" className="shrink-0 tabular-nums">
        {fmtWhen(branch.updatedAt)}
      </Text>
      <Button size="small" variant="secondary" disabled={disabled || current} onClick={onSwitch}>
        Run this
      </Button>
    </div>
  );
}

/** The GitHub token row. Only ever offered — never required: a public
 *  repository lists its PRs without one. */
function TokenRow({ hasToken, onSaved }: { hasToken: boolean; onSaved: () => void }) {
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.branches.setToken(value);
      setValue("");
      onSaved();
      toast.success("GitHub token saved");
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await api.branches.clearToken();
      onSaved();
      toast.success("GitHub token removed");
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <Text variant="small" color="secondary">
        A token is optional for a public repository. A private one needs it — GitHub answers 404,
        not 403, for repositories a request can&rsquo;t see, so without a token the failure reads as
        &ldquo;no such repository&rdquo;. It is stored encrypted on this device and never sent
        anywhere but api.github.com.
      </Text>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          aria-label="GitHub token"
          placeholder={hasToken ? "A token is saved — type a new one to replace it" : "ghp_…"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1"
        />
        <Button size="small" disabled={busy || !value.trim()} onClick={() => void save()}>
          Save
        </Button>
        {hasToken ? (
          <Button size="small" variant="ghost" disabled={busy} onClick={() => void clear()}>
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function BranchesView() {
  const qc = useQueryClient();
  const [steps, setSteps] = React.useState<string[]>([]);
  const [lines, setLines] = React.useState<string[]>([]);

  const status = useQuery({ queryKey: ["branches", "status"], queryFn: api.branches.status });
  const available = status.data?.available === true;
  const repo = status.data?.repo ?? null;

  const pulls = useQuery({
    queryKey: ["branches", "pulls"],
    queryFn: api.branches.listPulls,
    enabled: available && repo !== null,
    retry: false,
  });
  const branches = useQuery({
    queryKey: ["branches", "list"],
    queryFn: () => api.branches.listBranches(false),
    enabled: available,
    retry: false,
  });

  // Progress arrives on a push channel rather than as the mutation's result:
  // the mutation does not settle until the build has finished, which is the
  // whole span the user needs to see something during.
  React.useEffect(() => {
    return api.on<SwitchProgress>("branches:progress", (event) => {
      if (event.kind === "log" && event.line) {
        // Bounded in the view too. The backend caps what it KEEPS; this caps
        // what React re-renders, which is a different budget.
        setLines((prev) => [...prev.slice(-400), event.line as string]);
      } else if (event.message) {
        setSteps((prev) => [...prev, event.message as string]);
      }
    });
  }, []);

  const switching = useMutation({
    mutationFn: (branch: string | null) => {
      setSteps([]);
      setLines([]);
      return branch === null ? api.branches.home() : api.branches.switch(branch);
    },
    // No success toast: the app is relaunching, and a toast on a window that
    // is about to disappear is a flash nobody reads.
    onError: (err: unknown) => {
      toast.error(errorText(err));
      setSteps((prev) => [...prev, "Failed — nothing was changed, and your checkout is untouched."]);
    },
  });
  const busy = switching.isPending;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["branches"] });
  };

  if (status.isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Text variant="small" color="tertiary">
          Loading…
        </Text>
      </div>
    );
  }

  if (!available) {
    return (
      <div className="flex h-full flex-col">
        <Toolbar>
          <ToolbarContent>
            <ToolbarTitle>Branches</ToolbarTitle>
          </ToolbarContent>
        </Toolbar>
        <div className="flex flex-1 items-center justify-center p-8">
          <Text variant="small" color="tertiary" className="max-w-md text-center">
            {status.data?.reason ?? "Branch switching isn't available here."}
          </Text>
        </div>
      </div>
    );
  }

  const current = status.data?.current ?? "";
  const switched = status.data?.switched === true;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <ToolbarContent>
          <ToolbarTitle>Branches</ToolbarTitle>
          <ToolbarDescription>
            Running {current}
            {switched ? " (a branch build)" : " (your checkout)"}
            {repo ? ` · ${repo.owner}/${repo.name}` : " · origin isn’t a GitHub remote"}
          </ToolbarDescription>
        </ToolbarContent>
        <ToolbarActions>
          <Button variant="glass" size="small" disabled={busy} onClick={refresh}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
          {switched ? (
            <Button variant="glass" size="small" disabled={busy} onClick={() => switching.mutate(null)}>
              <Home className="size-4" />
              Back to my checkout
            </Button>
          ) : null}
        </ToolbarActions>
      </Toolbar>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col">
          <div className="px-3 pt-3">
            <Text variant="small" color="secondary">
              Switching builds the branch into its own worktree under this app&rsquo;s data
              directory and relaunches onto it. Your checkout is never touched, so
              &ldquo;back to my checkout&rdquo; always works.{" "}
              <strong>The branch shares this app&rsquo;s data directory</strong> — the same test
              library, run history and saved keys — so a branch that changes how something is
              stored changes yours, and switching back does not undo that.
            </Text>
          </div>

          <div className="px-3 pt-4 pb-1">
            <Text variant="small" color="secondary" className="font-medium">
              Open pull requests
            </Text>
          </div>
          {!repo ? (
            <Text variant="small" color="tertiary" className="px-3 pb-2">
              `origin` isn&rsquo;t a GitHub remote, so there are no pull requests to list. The
              branches below still work.
            </Text>
          ) : pulls.isError ? (
            <Text variant="small" color="tertiary" className="px-3 pb-2">
              {errorText(pulls.error)}
            </Text>
          ) : pulls.isLoading ? (
            <Text variant="small" color="tertiary" className="px-3 pb-2">
              Loading pull requests…
            </Text>
          ) : (pulls.data ?? []).length === 0 ? (
            <Text variant="small" color="tertiary" className="px-3 pb-2">
              No open pull requests.
            </Text>
          ) : (
            (pulls.data ?? []).map((pull) => (
              <PullRow
                key={pull.number}
                pull={pull}
                disabled={busy}
                onSwitch={() => switching.mutate(pull.branch)}
              />
            ))
          )}

          <div className="px-3 pt-4 pb-1">
            <Text variant="small" color="secondary" className="font-medium">
              Branches on origin
            </Text>
          </div>
          {branches.isError ? (
            <Text variant="small" color="tertiary" className="px-3 pb-2">
              {errorText(branches.error)}
            </Text>
          ) : branches.isLoading ? (
            <Text variant="small" color="tertiary" className="px-3 pb-2">
              Loading branches…
            </Text>
          ) : (
            (branches.data ?? []).map((branch) => (
              <BranchRow
                key={branch.name}
                branch={branch}
                current={branch.name === current}
                disabled={busy}
                onSwitch={() => switching.mutate(branch.name)}
              />
            ))
          )}

          <div className="px-3 pt-4 pb-1">
            <Text variant="small" color="secondary" className="font-medium">
              GitHub token
            </Text>
          </div>
          <TokenRow hasToken={status.data?.hasToken === true} onSaved={refresh} />
        </div>
      </ScrollArea>

      {steps.length > 0 || lines.length > 0 ? <SwitchLog steps={steps} lines={lines} /> : null}
    </div>
  );
}
