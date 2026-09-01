// Heals tab on a test's detail view — the review queue for everything that
// changes a test without the user writing it.
//
// Auto-Heal changes what a step points at. Before the journal, it did that
// silently whenever the retry succeeded, which is worse than it sounds: a
// mis-heal usually SUCCEEDS. Clicking the wrong button rarely throws, so the
// step was marked passed and the test quietly stopped testing what it was
// written to test.
//
// TWO KINDS OF EVENT LIVE HERE, from two stores. Locator heals, above, and
// whole-script changes — an AI-debug fix, or a hand edit in the Script tab —
// which had exactly the same problem and no journal at all: the "Apply AI debug
// fixes automatically" setting says in its own copy that "your script can
// change without you reading the change first", and until this panel showed
// them, nothing recorded that it had. They are merged into one time-ordered
// list rather than sectioned by kind, because the question the user arrives
// with is "what has happened to this test", not "what happened to its
// locators".
//
// So this panel's job is not to make healing look clever. It is to make every
// change visible, say plainly whether the stored test was changed, and put both
// directions one click away.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollArea, toast } from "@ui";
import { Check, RotateCcw, Wand2 } from "lucide-react";

import { Btn, TONE, insetRail, toneSurface } from "../theme";
import { api } from "../lib/api";
import { formatLocator } from "./refine-selector-dialog";
import { ScriptChangeRow } from "./script-change-row";
import type {
  HealEntry,
  Locator,
  ScriptChangeEntry,
  TestRecord,
} from "../lib/recorder-types";

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function HealRow({
  entry,
  onAccept,
  onRevert,
  busy,
}: {
  entry: HealEntry;
  onAccept: (locator?: Locator) => void;
  onRevert: () => void;
  busy: boolean;
}) {
  const [showAll, setShowAll] = React.useState(false);
  const settled = entry.status !== "pending";
  // Alternatives the user can pick instead of the engine's choice. The one
  // already applied is dropped — offering it again reads as a second option
  // when it isn't one.
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
    <div className="gl-heal-row">
      <div className="gl-heal-head">
        {/* Violet, because AI-adjacent chrome is the one thing that is not a
            status — Auto-Heal is a mechanism, and what it DID is reported by
            the toned chips beside it. */}
        <span className="gl-heal-head-icon">
          <Wand2 aria-hidden="true" />
        </span>
        <span className="gl-heal-title">
          {entry.stepLabel || `Step ${entry.stepIndex + 1}`}
        </span>
        {/* Neutral: where the heal happened is a fact, not a result. */}
        <span className="gl-chip">{entry.source === "run" ? "During a run" : "In the trainer"}</span>
        {/* The distinction that matters most: was the saved test changed? These
            ARE outcomes, so they take a tone — derived through `toneSurface()`,
            the one place that derivation happens, rather than a hex written
            into the stylesheet. Not `StatusChip`: that is fixed at the status
            width so a COLUMN of them has one edge, and these are inline labels
            of deliberately different lengths in a wrapping row. */}
        {entry.applied ? (
          <span className="gl-chip-tone" style={toneSurface(TONE.amber)}>
            Applied to the test
          </span>
        ) : (
          <span className="gl-chip-tone" style={toneSurface(TONE.cyan)}>
            Suggestion only
          </span>
        )}
        {entry.status === "accepted" ? (
          <span className="gl-chip-tone" style={toneSurface(TONE.phos)}>
            Accepted
          </span>
        ) : null}
        {entry.status === "reverted" ? <span className="gl-chip">Reverted</span> : null}
        <span className="gl-heal-when">{fmtWhen(entry.at)}</span>
      </div>

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
          <code className="gl-mono-value gl-heal-now">{formatLocator(entry.appliedLocator)}</code>
        </div>
      </div>

      {!settled ? (
        <div className="gl-heal-actions">
          {/* `go` on the affirmative one only. Two lit buttons on a row is the
              design smell `Btn` documents: the tone is for the action that
              causes the thing the hue means. */}
          <Btn tone="go" disabled={busy} onClick={() => onAccept()}>
            <Check aria-hidden="true" />
            {entry.applied ? "Keep" : "Apply"}
          </Btn>
          <Btn tone="ghost" disabled={busy} onClick={onRevert}>
            <RotateCcw aria-hidden="true" />
            {entry.applied ? "Revert" : "Dismiss"}
          </Btn>
          {alternatives.length > 0 ? (
            <Btn tone="ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Hide" : `${alternatives.length} other candidate${alternatives.length === 1 ? "" : "s"}`}
            </Btn>
          ) : null}
        </div>
      ) : null}

      {showAll ? (
        <div className="flex flex-col gap-1.5">
          {alternatives.map((c, i) => (
            <div key={i} className="gl-heal-alt">
              <code className="gl-mono-value flex-1">{formatLocator(c.locator)}</code>
              {c.matchedPastRun ? <span className="gl-chip">seen before</span> : null}
              <Btn tone="ghost" disabled={busy} onClick={() => onAccept(c.locator)}>
                Use this
              </Btn>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The merged list this panel renders: a heal or a script change, with the one
 *  field both have — when it happened — used to interleave them. Discriminated
 *  on `kind` rather than on a field only one of them carries, so adding a third
 *  kind later is a compile error at every branch rather than a silent fallthrough. */
type Change =
  | { kind: "heal"; at: number; id: string; entry: HealEntry }
  | { kind: "script"; at: number; id: string; entry: ScriptChangeEntry };

export function HealsPanel({ test }: { test: TestRecord }) {
  const qc = useQueryClient();
  const heals = useQuery({
    queryKey: ["heals", test.id],
    queryFn: () => api.heals.list(test.id),
  });
  const scriptChanges = useQuery({
    queryKey: ["script-changes", test.id],
    queryFn: () => api.scriptChanges.list(test.id),
  });
  // Fixes proposed for this test from its siblings. Counted and pointed at
  // here; the review actions live in the cross-test Heals view, where the
  // donors and the evidence screenshots are — a second accept surface would
  // be a second set of guards to keep in step.
  const proposals = useQuery({
    queryKey: ["propagations", test.id],
    queryFn: () => api.propagation.list(test.id),
  });
  const pendingProposals = (proposals.data ?? []).filter((p) => p.status === "pending").length;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["heals", test.id] });
    void qc.invalidateQueries({ queryKey: ["script-changes", test.id] });
    void qc.invalidateQueries({ queryKey: ["test", test.id] });
    // A reverted script change rewrites the spec and re-parses the steps, so
    // the Script and Steps tabs are stale the moment it lands.
    void qc.invalidateQueries({ queryKey: ["script", test.id] });
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

  const keepChange = useMutation({
    mutationFn: (id: string) => api.scriptChanges.accept(id),
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });

  const revertChange = useMutation({
    mutationFn: (id: string) => api.scriptChanges.revert(id),
    onSuccess: () => {
      invalidate();
      toast.success("Put the previous script back.");
    },
    onError: (err: unknown) => toast.error(String(err)),
  });

  const clearSettled = useMutation({
    // Both stores, one button. "Clear history" that emptied half the list would
    // read as a control that didn't work.
    mutationFn: async () => {
      await Promise.all([
        api.heals.clearSettled(test.id),
        api.scriptChanges.clearSettled(test.id),
      ]);
    },
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });

  // Newest first, both kinds interleaved — see the note at the top of the file.
  const entries: Change[] = React.useMemo(
    () =>
      [
        ...(heals.data ?? []).map(
          (entry): Change => ({ kind: "heal", at: entry.at, id: entry.id, entry }),
        ),
        ...(scriptChanges.data ?? []).map(
          (entry): Change => ({ kind: "script", at: entry.at, id: entry.id, entry }),
        ),
      ].sort((a, b) => b.at - a.at),
    [heals.data, scriptChanges.data],
  );
  const pending = entries.filter((e) => e.entry.status === "pending");
  const settled = entries.filter((e) => e.entry.status !== "pending");
  const busy =
    accept.isPending || revert.isPending || keepChange.isPending || revertChange.isPending;
  // The case worth calling out: the test on disk has ALREADY changed and nobody
  // has looked at it. True of an applied heal, and of a script change that was
  // auto-applied while the AI debug job was minimized — which is the same
  // hazard arriving by a different route, so it gets the same banner rather
  // than a second one competing with it.
  const appliedPending = pending.filter((e) =>
    e.kind === "heal" ? e.entry.applied : !e.entry.reviewed,
  ).length;

  const renderRow = (change: Change, actionable: boolean) =>
    change.kind === "heal" ? (
      <HealRow
        key={change.id}
        entry={change.entry}
        busy={busy}
        onAccept={
          actionable ? (locator) => accept.mutate({ id: change.id, locator }) : () => {}
        }
        onRevert={actionable ? () => revert.mutate(change.id) : () => {}}
      />
    ) : (
      <ScriptChangeRow
        key={change.id}
        entry={change.entry}
        busy={busy}
        onAccept={actionable ? () => keepChange.mutate(change.id) : undefined}
        // Deliberately offered on a settled row too: the entry holds the only
        // copy of the previous spec, so "put it back" has nowhere else to go.
        onRevert={() => revertChange.mutate(change.id)}
      />
    );

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-4">
        {appliedPending > 0 ? (
          // The amber inset rail, not a filled banner: it is the same motif
          // every other status in this design uses, so a warning does not need
          // a shape of its own to be read as one.
          <p className="gl-notice" style={{ boxShadow: insetRail(TONE.amber) }}>
            {appliedPending} change{appliedPending === 1 ? " has" : "s have"} already been made to
            this test without review. Look below — a change that made the test pass is not the same
            as a change that was right.
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <span className="gl-section-title">Needs review</span>
          {pending.length + pendingProposals > 0 ? (
            <span className="gl-chip">{pending.length + pendingProposals}</span>
          ) : null}
        </div>

        {pendingProposals > 0 ? (
          <p className="gl-note">
            {pendingProposals} propagated fix{pendingProposals === 1 ? "" : "es"} from sibling
            tests on this site {pendingProposals === 1 ? "waits" : "wait"} in the Heals view,
            beside the evidence.
          </p>
        ) : null}

        {heals.isLoading || scriptChanges.isLoading ? (
          <p className="gl-note">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="gl-note">
            Nothing to review. Every locator Auto-Heal changes and every rewrite of this test&rsquo;s
            script is recorded here, with a way to put it back.
          </p>
        ) : (
          <div className="flex flex-col gap-2">{pending.map((e) => renderRow(e, true))}</div>
        )}

        {settled.length > 0 ? (
          <>
            <div className="flex items-center gap-2 pt-2">
              <span className="gl-section-title">History</span>
              <div className="flex-1" />
              <Btn
                tone="ghost"
                disabled={clearSettled.isPending}
                onClick={() => clearSettled.mutate()}
              >
                Clear history
              </Btn>
            </div>
            <div className="flex flex-col gap-2">{settled.map((e) => renderRow(e, false))}</div>
          </>
        ) : null}
      </div>
    </ScrollArea>
  );
}
