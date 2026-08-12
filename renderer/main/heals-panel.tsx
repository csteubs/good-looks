// Heals tab on a test's detail view — the review queue for Auto-Heal.
//
// Auto-Heal changes what a step points at. Before the journal, it did that
// silently whenever the retry succeeded, which is worse than it sounds: a
// mis-heal usually SUCCEEDS. Clicking the wrong button rarely throws, so the
// step was marked passed and the test quietly stopped testing what it was
// written to test.
//
// So this panel's job is not to make healing look clever. It is to make every
// heal visible, say plainly whether the stored test was changed, and put both
// directions one click away.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollArea, toast } from "@ui";
import { Check, RotateCcw, Wand2 } from "lucide-react";

import { Btn, TONE, insetRail, toneSurface } from "../theme";
import { api } from "../lib/api";
import { formatLocator } from "./refine-selector-dialog";
import type { HealEntry, Locator, TestRecord } from "../lib/recorder-types";

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

export function HealsPanel({ test }: { test: TestRecord }) {
  const qc = useQueryClient();
  const heals = useQuery({
    queryKey: ["heals", test.id],
    queryFn: () => api.heals.list(test.id),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["heals", test.id] });
    void qc.invalidateQueries({ queryKey: ["test", test.id] });
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

  const clearSettled = useMutation({
    mutationFn: () => api.heals.clearSettled(test.id),
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });

  const entries = heals.data ?? [];
  const pending = entries.filter((e) => e.status === "pending");
  const settled = entries.filter((e) => e.status !== "pending");
  const busy = accept.isPending || revert.isPending;
  // An applied-but-unreviewed heal is the case worth calling out: the test on
  // disk has already changed and nobody has looked at it.
  const appliedPending = pending.filter((e) => e.applied).length;

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-4">
        {appliedPending > 0 ? (
          // The amber inset rail, not a filled banner: it is the same motif
          // every other status in this design uses, so a warning does not need
          // a shape of its own to be read as one.
          <p className="gl-notice" style={{ boxShadow: insetRail(TONE.amber) }}>
            {appliedPending} step{appliedPending === 1 ? " has" : "s have"} already been changed by
            Auto-Heal. Review below — a heal that succeeded is not the same as a heal that was
            right.
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <span className="gl-section-title">Needs review</span>
          {pending.length > 0 ? <span className="gl-chip">{pending.length}</span> : null}
        </div>

        {heals.isLoading ? (
          <p className="gl-note">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="gl-note">
            Nothing to review. Auto-Heal records every locator it changes here, with a way to put it
            back.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {pending.map((e) => (
              <HealRow
                key={e.id}
                entry={e}
                busy={busy}
                onAccept={(locator) => accept.mutate({ id: e.id, locator })}
                onRevert={() => revert.mutate(e.id)}
              />
            ))}
          </div>
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
            <div className="flex flex-col gap-2">
              {settled.map((e) => (
                <HealRow key={e.id} entry={e} busy={busy} onAccept={() => {}} onRevert={() => {}} />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </ScrollArea>
  );
}
