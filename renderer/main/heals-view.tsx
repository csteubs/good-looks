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
import { AlertDialog, ScrollArea, toast } from "@ui";
import { Check, RotateCcw, Trash2, Wand2 } from "lucide-react";

import { Btn, Panel, StatusChip, TONE, insetRail } from "../theme";
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

/** How a heal's four states map onto the palette, in one place.
 *
 *  ONLY TWO OF THE FOUR ARE OUTCOMES, and the mapping says so. `Accepted` is a
 *  result (you approved the change), `Applied` is the one that should catch
 *  your eye (the stored test has ALREADY changed and nobody has looked at it —
 *  amber is caution, which is exactly what that is). `Suggested` takes cyan:
 *  the palette calls it "running / live / focus", and a suggestion is the open
 *  item waiting on you rather than a verdict. `Reverted` gets no tone at all —
 *  it is settled and there is nothing to report.
 *
 *  Two states sharing "no hue" is fine and deliberate: `StatusChip`'s width is
 *  fixed so these read as a column, and THE WORD is what reports the state. */
function statusChip(entry: HealListEntry): React.ReactElement {
  if (entry.status === "accepted") return <StatusChip tone="phos">Accepted</StatusChip>;
  if (entry.status === "reverted") return <StatusChip>Reverted</StatusChip>;
  if (entry.applied) {
    return (
      <StatusChip tone="amber" title="Auto-Heal already changed the stored test">
        Applied
      </StatusChip>
    );
  }
  return (
    <StatusChip tone="cyan" title="Recorded only — the stored test is unchanged">
      Suggested
    </StatusChip>
  );
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
      // `data-selected` is what the stylesheet selects on, and it is the
      // attribute `check:selection-neutral` reads to prove no selection in this
      // app is drawn in a status hue — which matters more here than anywhere:
      // this list is a column of chips reporting four different outcomes.
      data-selected={selected ? "" : undefined}
      className="gl-heals-row"
    >
      {/* Violet: Auto-Heal is AI-adjacent machinery, and what it did is
          reported by the chip rather than by this glyph. */}
      <span className="gl-heals-row-icon">
        <Wand2 aria-hidden="true" />
      </span>
      <span className="gl-heals-row-text">
        <span className="gl-heals-row-step">
          {entry.stepLabel || `Step ${entry.stepIndex + 1}`}
        </span>
        {/* A heal outlives the test it came from, so say so rather than
            rendering a bare uuid. */}
        <span className="gl-heals-row-test">{entry.testName ?? "(deleted test)"}</span>
      </span>
      <span className="gl-heals-row-meta">
        {statusChip(entry)}
        <span className="gl-heals-row-when">{fmtWhen(entry.at)}</span>
      </span>
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
      <div className="gl-heals-detail-body">
        {/* THE WARNING THE DESIGN ADDS, and it is only shown where it is true.
            "Succeeded" is doing the work in that sentence: it is about a heal
            that has ALREADY been applied to the stored test and passed, which
            is the case with no other signal — a mis-heal usually succeeds,
            because clicking the wrong button rarely throws. On a suggestion
            nothing has been applied and the sentence would be noise, which is
            how a warning becomes something people click past. */}
        {!settled && entry.applied ? (
          <p className="gl-notice" style={{ boxShadow: insetRail(TONE.amber) }}>
            Auto-Heal has already changed this step. A heal that succeeded is not the same as a
            heal that was right — read both locators before you keep it.
          </p>
        ) : null}

        <div className="gl-heals-section">
          <span className="gl-section-title">
            {entry.stepLabel || `Step ${entry.stepIndex + 1}`}
          </span>
          <div className="gl-heal-head">
            <span className="gl-chip">
              {entry.source === "run" ? "During a run" : "In the trainer"}
            </span>
            {statusChip(entry)}
            <span className="gl-heal-when">{fmtWhen(entry.at)}</span>
          </div>
          <span className="gl-note">
            {entry.testName ?? "The test this came from has been deleted."}
          </span>
        </div>

        <div className="gl-heals-section">
          <span className="gl-section-title">Locator</span>
          <div className="gl-heal-locs">
            {entry.originalLocator ? (
              <div className="gl-heal-loc">
                <span className="gl-heal-loc-key">was</span>
                <code className="gl-mono-value gl-heal-was">
                  {formatLocator(entry.originalLocator)}
                </code>
              </div>
            ) : null}
            <div className="gl-heal-loc">
              <span className="gl-heal-loc-key">now</span>
              <code className="gl-mono-value gl-heal-now">
                {formatLocator(entry.appliedLocator)}
              </code>
            </div>
          </div>
        </div>

        {/* One action row whether or not the heal is settled: accept/revert are
            the review decision, Delete is about the record itself, so it sits
            apart rather than reading as a third way to answer the question. */}
        <div className="gl-heal-actions">
          {!settled ? (
            <>
              {/* `go` on the affirmative one only — two lit buttons on a row is
                  the design smell `Btn` documents. */}
              <Btn tone="go" disabled={busy} onClick={() => onAccept()}>
                <Check aria-hidden="true" />
                {entry.applied ? "Keep" : "Apply"}
              </Btn>
              <Btn tone="ghost" disabled={busy} onClick={onRevert}>
                <RotateCcw aria-hidden="true" />
                {entry.applied ? "Revert" : "Dismiss"}
              </Btn>
            </>
          ) : null}
          <div className="flex-1" />
          <AlertDialog
            trigger={
              <Btn tone="ghost" disabled={busy}>
                <Trash2 aria-hidden="true" />
                Delete
              </Btn>
            }
            title="Delete this heal record?"
            description={deleteWarning(entry)}
            confirmLabel="Delete"
            confirmVariant="destructive"
            onConfirm={onDelete}
          />
        </div>

        {alternatives.length > 0 ? (
          <div className="gl-heals-section">
            <span className="gl-section-title">Other candidates</span>
            <p className="gl-note">
              What the engine also found, best-first. Worth a look when the applied one is
              fragile.
            </p>
            {alternatives.map((c, i) => (
              <div key={i} className="gl-heal-alt">
                <code className="gl-mono-value flex-1">{formatLocator(c.locator)}</code>
                {c.matchedPastRun ? <span className="gl-chip">seen before</span> : null}
                {!settled ? (
                  <Btn tone="ghost" disabled={busy} onClick={() => onAccept(c.locator)}>
                    Use this
                  </Btn>
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

  const clearHistory =
    settledCount > 0 ? (
      // Only settled heals can be swept in bulk. Offering "clear everything"
      // would let one click delete the undo for changes already made to tests,
      // which is the one thing this journal exists to prevent.
      <AlertDialog
        trigger={
          <Btn tone="ghost" disabled={clearSettled.isPending}>
            <Trash2 aria-hidden="true" />
            Clear history
          </Btn>
        }
        title={`Delete ${settledCount} settled heal${settledCount === 1 ? "" : "s"}?`}
        description="This removes every heal you've already accepted or reverted, across all tests. Heals still needing review are kept, and no test is changed."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => clearSettled.mutate()}
      />
    ) : undefined;

  // THE TOOLBAR IS GONE, and its two jobs moved rather than being dropped. The
  // top strip's breadcrumb already says HEALS, so a title bar under it was the
  // screen's name twice; the count belongs to the journal it counts, and
  // "Clear history" belongs to the list it clears. What is left is two panels
  // and no chrome above them.
  return (
    <div className="gl-heals">
      <Panel
        title="Journal"
        id={`${entries.length} ${entries.length === 1 ? "heal" : "heals"} recorded${
          pending > 0 ? ` · ${pending} needing review` : ""
        }`}
        right={clearHistory}
        className="gl-heals-journal"
      >
        {entries.length === 0 ? (
          <p className="gl-heals-empty gl-note">
            {heals.isLoading
              ? "Loading…"
              : "No heals yet. Auto-Heal records every locator it changes here, with a way to put it back."}
          </p>
        ) : (
          <>
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
          </>
        )}
      </Panel>

      <Panel
        title="What changed"
        // The panel is ABOUT a heal, and the `id` slot is where this design puts
        // what a panel is about — dim, truncating, findable when looked for.
        id={selected ? (selected.testName ?? "(deleted test)") : undefined}
        className="gl-heals-detail"
      >
        {selected ? (
          <HealDetail
            entry={selected}
            busy={accept.isPending || revert.isPending || remove.isPending}
            onAccept={(locator) => accept.mutate({ id: selected.id, locator })}
            onRevert={() => revert.mutate(selected.id)}
            onDelete={() => remove.mutate(selected.id)}
          />
        ) : (
          <p className="gl-heals-empty gl-note">Select a heal to see what changed.</p>
        )}
      </Panel>
    </div>
  );
}

/** Re-exported so the page size the view uses is the one tests assert against
 *  rather than a second copy of the number. */
export { PAGE_SIZE };
