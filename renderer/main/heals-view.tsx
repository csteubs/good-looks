// The Heals view (route /heals) — every locator Auto-Heal has changed, across
// every test.
//
// The per-test Heals tab answers "what happened to THIS test". This answers the
// question that one can't: which locators keep breaking. A heal that recurs on
// the same step across several tests is a locator worth rewriting by hand, and
// that pattern is invisible when the records are split per test.
//
// Master/detail rather than expanding rows, because a heal's detail is wide —
// two locators, a candidate list, the run it came from — and cramming that into
// a list row is how the Stability panel ended up overflowing.
//
// Deleting records: one at a time from the detail pane, or "Clear history" for
// every SETTLED heal at once. There is deliberately no "delete everything" —
// a pending, applied heal is the only stored copy of the locator its step used
// to have, so a bulk sweep that took those with it would quietly destroy the
// undo for changes already made to tests, which is the whole point of the
// journal. Per-record delete can still remove one, and says so before asking.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Badge,
  Button,
  ScrollArea,
  Text,
  Toolbar,
  ToolbarActions,
  ToolbarContent,
  ToolbarDescription,
  ToolbarTitle,
  toast,
} from "@glaze/core/components";
import { Check, RotateCcw, Trash2, Wand2 } from "lucide-react";

import { api } from "../lib/api";
import { clampPage, pageSlice, PAGE_SIZE } from "../lib/paginate";
import { formatLocator } from "./refine-selector-dialog";
import { Pager } from "./pager";
import type { HealListEntry, Locator } from "../lib/recorder-types";

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** One row in the list. Deliberately terse — the detail pane carries the rest,
 *  and a row that wraps is a row you can't scan. */
function HealRow({
  entry,
  selected,
  onSelect,
}: {
  entry: HealListEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`flex w-full items-center gap-2 border-b border-separator px-3 py-2 text-left ${
        selected ? "bg-accent-10 ring-1 ring-inset ring-accent" : "hover:bg-control-subtle"
      }`}
    >
      <Wand2 className="size-3.5 shrink-0 text-tertiary" />
      <div className="flex min-w-0 flex-1 flex-col">
        <Text variant="small" className="truncate font-medium">
          {entry.stepLabel || `Step ${entry.stepIndex + 1}`}
        </Text>
        <Text variant="small" color="tertiary" className="truncate">
          {/* A heal outlives the test it came from, so say so rather than
              rendering a bare uuid. */}
          {entry.testName ?? "(deleted test)"}
        </Text>
      </div>
      {entry.status === "pending" ? (
        <Badge color={entry.applied ? "orange" : "blue"}>
          {entry.applied ? "Applied" : "Suggested"}
        </Badge>
      ) : (
        <Badge color={entry.status === "accepted" ? "green" : "secondary"}>{entry.status}</Badge>
      )}
      <Text variant="small" color="tertiary" className="shrink-0 tabular-nums">
        {fmtWhen(entry.at)}
      </Text>
    </button>
  );
}

/** What deleting this record actually costs, said plainly.
 *
 *  The three cases are genuinely different, and the dangerous one is easy to
 *  miss: a PENDING + APPLIED heal means the stored test has already been
 *  changed and this entry holds the original locator. Delete it and the change
 *  stays while the way back is gone. A generic "this can't be undone" would
 *  read as boilerplate on the two harmless cases and under-sell that one. */
function deleteWarning(entry: HealListEntry): string {
  if (entry.status !== "pending") {
    return "This removes the record only. The test keeps the locator you settled on.";
  }
  if (entry.applied) {
    return "Auto-Heal has already changed this step, and this record holds the locator it replaced — the only way back. Deleting it leaves the change in place with no way to undo it. Revert first if you want the original locator back.";
  }
  return "This heal was never applied, so the test is unchanged either way. Deleting it just drops the suggestion.";
}

function HealDetail({
  entry,
  onAccept,
  onRevert,
  onDelete,
  busy,
}: {
  entry: HealListEntry;
  onAccept: (locator?: Locator) => void;
  onRevert: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const settled = entry.status !== "pending";
  const alternatives = entry.candidates.filter(
    (c) =>
      !(
        c.locator.k === entry.appliedLocator.k &&
        c.locator.v === entry.appliedLocator.v &&
        c.locator.role === entry.appliedLocator.role &&
        c.locator.name === entry.appliedLocator.name
      ),
  );

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 p-4 pb-8">
        <div className="flex flex-col gap-1">
          <Text weight="medium">{entry.stepLabel || `Step ${entry.stepIndex + 1}`}</Text>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              {entry.source === "run" ? "During a run" : "In the trainer"}
            </Badge>
            {entry.applied ? (
              <Badge color="orange">Applied to the test</Badge>
            ) : (
              <Badge color="blue">Suggestion only</Badge>
            )}
            {entry.status === "accepted" ? <Badge color="green">Accepted</Badge> : null}
            {entry.status === "reverted" ? <Badge variant="secondary">Reverted</Badge> : null}
            <Text variant="small" color="tertiary">
              {fmtWhen(entry.at)}
            </Text>
          </div>
          <Text variant="small" color="secondary">
            {entry.testName ?? "The test this came from has been deleted."}
          </Text>
        </div>

        <div className="flex flex-col gap-1">
          <Text variant="small" className="font-medium">
            Locator
          </Text>
          {entry.originalLocator ? (
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-small text-tertiary">was</span>
              <code className="min-w-0 truncate font-mono text-xs text-tertiary line-through">
                {formatLocator(entry.originalLocator)}
              </code>
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-small text-tertiary">now</span>
            <code className="min-w-0 truncate font-mono text-xs text-primary">
              {formatLocator(entry.appliedLocator)}
            </code>
          </div>
        </div>

        {/* One action row whether or not the heal is settled: accept/revert are
            the review decision, Delete is about the record itself, so it sits
            apart rather than reading as a third way to answer the question. */}
        <div className="flex flex-wrap items-center gap-2">
          {!settled ? (
            <>
              <Button size="small" disabled={busy} onClick={() => onAccept()}>
                <Check className="size-4" />
                {entry.applied ? "Keep" : "Apply"}
              </Button>
              <Button size="small" variant="secondary" disabled={busy} onClick={onRevert}>
                <RotateCcw className="size-4" />
                {entry.applied ? "Revert" : "Dismiss"}
              </Button>
            </>
          ) : null}
          <div className="flex-1" />
          <AlertDialog
            trigger={
              <Button size="small" variant="ghost" disabled={busy}>
                <Trash2 className="size-4" />
                Delete
              </Button>
            }
            title="Delete this heal record?"
            description={deleteWarning(entry)}
            confirmLabel="Delete"
            confirmVariant="destructive"
            onConfirm={onDelete}
          />
        </div>

        {alternatives.length > 0 ? (
          <div className="flex flex-col gap-1">
            <Text variant="small" className="font-medium">
              Other candidates
            </Text>
            <Text variant="small" color="tertiary">
              What the engine also found, best-first. Worth a look when the applied one is
              fragile.
            </Text>
            {alternatives.map((c, i) => (
              <div key={i} className="flex items-center gap-2 pt-1">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-secondary">
                  {formatLocator(c.locator)}
                </code>
                {c.matchedPastRun ? <Badge variant="secondary">seen before</Badge> : null}
                {!settled ? (
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => onAccept(c.locator)}
                  >
                    Use this
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}

export function HealsView() {
  const qc = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const heals = useQuery({
    queryKey: ["heals", "all"],
    queryFn: () => api.heals.listAll(),
  });
  const entries = React.useMemo(() => heals.data ?? [], [heals.data]);

  // Clamp rather than trust: accepting the last heal on the last page shrinks
  // the list under the page you're on, and an unclamped number renders an empty
  // list next to rows that plainly exist.
  const safePage = clampPage(page, entries.length);
  const visible = pageSlice(entries, safePage);
  const selected = entries.find((e) => e.id === selectedId) ?? null;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["heals"] });
    void qc.invalidateQueries({ queryKey: ["tests"] });
  };

  const accept = useMutation({
    mutationFn: (p: { id: string; locator?: Locator }) => api.heals.accept(p.id, p.locator),
    onSuccess: () => {
      invalidate();
      toast.success("Applied to the test");
    },
    onError: (err: unknown) => toast.error(String(err)),
  });
  const revert = useMutation({
    mutationFn: (id: string) => api.heals.revert(id),
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.heals.remove(id),
    onSuccess: () => {
      // Drop the selection with the record. `selected` is looked up by id so it
      // would fall to null on its own once the query settles, but only after a
      // frame of the detail pane describing a heal that no longer exists.
      setSelectedId(null);
      invalidate();
      toast.success("Heal deleted");
    },
    onError: (err: unknown) => toast.error(String(err)),
  });
  const clearSettled = useMutation({
    mutationFn: () => api.heals.clearAllSettled(),
    onSuccess: (res) => {
      setSelectedId(null);
      invalidate();
      toast.success(`Cleared ${res.removed} heal${res.removed === 1 ? "" : "s"}`);
    },
    onError: (err: unknown) => toast.error(String(err)),
  });

  const pending = entries.filter((e) => e.status === "pending").length;
  const settledCount = entries.length - pending;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <ToolbarContent>
          <ToolbarTitle>Heals</ToolbarTitle>
          <ToolbarDescription>
            {entries.length} {entries.length === 1 ? "heal" : "heals"} recorded
            {pending > 0 ? ` · ${pending} needing review` : ""}
          </ToolbarDescription>
        </ToolbarContent>
        {/* Only settled heals can be swept in bulk. Offering "clear everything"
            would let one click delete the undo for changes already made to
            tests, which is the one thing this journal exists to prevent. */}
        {settledCount > 0 ? (
          <ToolbarActions>
            <AlertDialog
              trigger={
                <Button variant="glass" size="small" disabled={clearSettled.isPending}>
                  <Trash2 className="size-4" />
                  Clear history
                </Button>
              }
              title={`Delete ${settledCount} settled heal${settledCount === 1 ? "" : "s"}?`}
              description="This removes every heal you've already accepted or reverted, across all tests. Heals still needing review are kept, and no test is changed."
              confirmLabel="Delete"
              confirmVariant="destructive"
              onConfirm={() => clearSettled.mutate()}
            />
          </ToolbarActions>
        ) : null}
      </Toolbar>

      {entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <Text variant="small" color="tertiary">
            {heals.isLoading
              ? "Loading…"
              : "No heals yet. Auto-Heal records every locator it changes here, with a way to put it back."}
          </Text>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* List — fixed width so the detail pane gets the room, matching how
              the Visual view splits its run list from its viewer. */}
          <div className="flex w-80 shrink-0 flex-col border-r border-separator">
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col">
                {visible.map((entry) => (
                  <HealRow
                    key={entry.id}
                    entry={entry}
                    selected={entry.id === selectedId}
                    onSelect={() => setSelectedId(entry.id)}
                  />
                ))}
              </div>
            </ScrollArea>
            <Pager page={safePage} total={entries.length} onPage={setPage} label="heals" />
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selected ? (
              <HealDetail
                entry={selected}
                busy={accept.isPending || revert.isPending || remove.isPending}
                onAccept={(locator) => accept.mutate({ id: selected.id, locator })}
                onRevert={() => revert.mutate(selected.id)}
                onDelete={() => remove.mutate(selected.id)}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center p-8">
                <Text variant="small" color="tertiary">
                  Select a heal to see what changed.
                </Text>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Re-exported so the page size the view uses is the one tests assert against
 *  rather than a second copy of the number. */
export { PAGE_SIZE };
