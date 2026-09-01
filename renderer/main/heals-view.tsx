// The Heals view (route /heals) — everything that has changed a test without
// the user writing it, across every test.
//
// Two kinds, from two stores. Locator heals: every locator Auto-Heal has
// changed. And whole-script changes: an AI-debug fix applied to a spec, or a
// hand edit in the Script tab. See heals-panel.tsx and script-change-store.ts
// for why the second exists and why it is journalled separately.
//
// The per-test Heals tab answers "what happened to THIS test". This answers the
// question that one can't: which locators keep breaking. A heal that recurs on
// the same step across several tests is a locator worth rewriting by hand, and
// that pattern is invisible when the records are split per test. The same is
// true of a model that keeps rewriting specs.
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
import { Check, FileCode2, RotateCcw, Share2, Trash2, Wand2 } from "lucide-react";

import { Btn, Panel, ShotHighlight, StatusChip, TONE, insetRail, toneSurface } from "../theme";
import { api } from "../lib/api";
import { clampPage, pageSlice, PAGE_SIZE } from "../lib/paginate";
import { DiffView } from "../components/diff-view";
import { diffLines } from "../lib/line-diff";
import { formatLocator } from "./refine-selector-dialog";
import { ChangeCounts, originLabel } from "./script-change-row";
import { Pager } from "./pager";
import type {
  HealListEntry,
  Locator,
  PropagationListEntry,
  ScriptChangeListEntry,
} from "../lib/recorder-types";

/** One record in the journal, of any kind.
 *
 *  Discriminated on `kind` rather than on a field only one of them has: every
 *  branch in this file is then a compile error the day a new kind lands,
 *  instead of a row that silently renders as the wrong thing — which is
 *  exactly how the third kind (cross-test propagation proposals) arrived. */
export type JournalEntry =
  | { kind: "heal"; entry: HealListEntry }
  | { kind: "script"; entry: ScriptChangeListEntry }
  | { kind: "proposal"; entry: PropagationListEntry };

/** Fixed copy per engine reason code — the insights-view rule: the engine
 *  contributes codes, the renderer owns every sentence, so nothing the engine
 *  emits can relabel a control. A code this map does not know is skipped. */
const REASON_COPY: Record<string, string> = {
  "donor-accepted": "You accepted this exact fix on another test.",
  "donor-manual": "You made this exact fix by hand on another test.",
  "donor-run-passed": "Auto-Heal made this fix during a run that passed.",
  "donor-trainer": "Auto-Heal made this fix in the trainer, while you watched.",
  "donors-agree": "More than one confirmed fix agrees on it.",
  "fingerprint-key-match":
    "This step's own recording lists the new locator among the element's candidates.",
  "fingerprint-similar": "The recorded elements look alike.",
  "target-failing": "This test is already going red.",
};

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

/** The same four states for a script change, mapped the same way.
 *
 *  It reuses `Applied` rather than inventing a word, because it means exactly
 *  what it means on a heal: the stored test has changed and nobody has looked.
 *  There is no `Suggested` counterpart — a script change is only ever recorded
 *  once it has been written, so that state cannot occur. */
function scriptStatusChip(entry: ScriptChangeListEntry): React.ReactElement {
  if (entry.status === "accepted") return <StatusChip tone="phos">Kept</StatusChip>;
  if (entry.status === "reverted") return <StatusChip>Reverted</StatusChip>;
  return (
    <StatusChip tone="amber" title="This was written to the test without being reviewed">
      Applied
    </StatusChip>
  );
}

/** A proposal's states, mapped the same way. `Proposed` takes the heals'
 *  `Suggested` cyan — the open item waiting on you — and `Applied` reuses the
 *  amber word exactly, because it means exactly what it means on a heal: the
 *  stored test has changed and nobody has looked. The engine's housekeeping
 *  states (`Superseded`, `Stale`) get no tone: there is nothing to decide. */
function proposalStatusChip(entry: PropagationListEntry): React.ReactElement {
  if (entry.status === "accepted") return <StatusChip tone="phos">Accepted</StatusChip>;
  if (entry.status === "pending" && entry.applied) {
    return (
      <StatusChip tone="amber" title="Propagation already changed the stored test">
        Applied
      </StatusChip>
    );
  }
  if (entry.status === "pending") {
    return (
      <StatusChip tone="cyan" title="Recorded only — the stored test is unchanged">
        Proposed
      </StatusChip>
    );
  }
  const word =
    entry.status === "dismissed"
      ? "Dismissed"
      : entry.status === "reverted"
        ? "Reverted"
        : entry.status === "superseded"
          ? "Superseded"
          : "Stale";
  return <StatusChip>{word}</StatusChip>;
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

/** The script-change row. Same anatomy as `HealRow` above — one glyph, two
 *  lines of text, a chip and a time — so a mixed list still scans as a column
 *  rather than as two designs taking turns. */
function ScriptChangeListRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ScriptChangeListEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "" : undefined}
      className="gl-heals-row"
    >
      {/* Not violet, unlike the heal glyph beside it: half of these rows are
          the user's own edit, and violet is the AI mark. Which one this is gets
          said in words on the line below, where it can't be misread. */}
      <span className="gl-heals-row-icon gl-heals-row-icon-plain">
        <FileCode2 aria-hidden="true" />
      </span>
      <span className="gl-heals-row-text">
        <span className="gl-heals-row-step">Script · {originLabel(entry)}</span>
        <span className="gl-heals-row-test">{entry.testName ?? "(deleted test)"}</span>
      </span>
      <span className="gl-heals-row-meta">
        {scriptStatusChip(entry)}
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
            {/* Where it RAN, which is not the same question as what it did.
                A heal carried back by `good-looks ingest` happened in a
                container that no longer exists, so the run's log and
                screenshots may not have travelled with it — and it was never
                applied to anything here. Saying so is what stops "During a
                run" from reading as "during a run you did". */}
            {entry.ingested ? <span className="gl-chip">On another machine</span> : null}
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

/** What deleting a script-change record costs. Blunter than the heal version,
 *  because it is worse: this record holds the ONLY copy of the previous spec,
 *  whatever its status. Settling a heal at least leaves the test pointing at a
 *  locator you chose; settling a script change leaves the file rewritten. */
function scriptDeleteWarning(entry: ScriptChangeListEntry): string {
  if (entry.truncated) {
    return "This change was too large to store, so the record has no copy of the previous script. Deleting it drops the record only.";
  }
  if (entry.status === "reverted") {
    return "You already put the previous script back, so deleting this removes the record only.";
  }
  return "This record holds the only copy of the script this test had before the change — the only way back. Deleting it leaves the new script in place with no way to undo it. Revert first if you want the old one.";
}

function ScriptChangeDetail({
  entry,
  onAccept,
  onRevert,
  onDelete,
  busy,
}: {
  entry: ScriptChangeListEntry;
  onAccept: () => void;
  onRevert: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const settled = entry.status !== "pending";
  // The detail pane shows one record at a time, so the diff is computed for
  // the selected entry only — unlike the per-test list, where a row has to ask
  // for it. Recomputed only when the selection changes.
  const diff = React.useMemo(
    () => (entry.truncated ? null : diffLines(entry.before, entry.after)),
    [entry.truncated, entry.before, entry.after],
  );

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="gl-heals-detail-body">
        {/* Same warning as a heal's, for the same reason and only where it is
            true: this test's script was rewritten and nobody read the change.
            On one the user applied themselves it would be noise, which is how
            a warning becomes something people click past. */}
        {!settled ? (
          <p className="gl-notice" style={{ boxShadow: insetRail(TONE.amber) }}>
            This test&rsquo;s script was rewritten without review. Read the diff before you keep it
            — a change that made the test pass is not the same as a change that was right.
          </p>
        ) : null}

        <div className="gl-heals-section">
          <span className="gl-section-title">Script</span>
          <div className="gl-heal-head">
            {entry.origin === "ai-debug" ? (
              <span className="gl-chip-tone" style={toneSurface(TONE.violet)}>
                {originLabel(entry)}
              </span>
            ) : (
              <span className="gl-chip">{originLabel(entry)}</span>
            )}
            {scriptStatusChip(entry)}
            <span className="gl-heal-when">{fmtWhen(entry.at)}</span>
          </div>
          <span className="gl-note">
            {entry.testName ?? "The test this came from has been deleted."}
          </span>
        </div>

        <div className="gl-heals-section">
          <span className="gl-section-title">What changed</span>
          <div className="gl-script-change-summary">
            <ChangeCounts entry={entry} />
          </div>
          {diff ? (
            <div className="gl-script-change-diff">
              <DiffView diff={diff} />
            </div>
          ) : (
            <p className="gl-note">
              This change was too large to store, so there is no diff to show and nothing to revert
              to.
            </p>
          )}
        </div>

        <div className="gl-heal-actions">
          {!settled ? (
            <Btn tone="go" disabled={busy} onClick={onAccept}>
              <Check aria-hidden="true" />
              Keep
            </Btn>
          ) : null}
          {/* Offered whatever the status: this record is the only copy of the
              previous spec, so "put it back" has nowhere else to go. */}
          <Btn tone="ghost" disabled={busy || entry.truncated === true} onClick={onRevert}>
            <RotateCcw aria-hidden="true" />
            Revert
          </Btn>
          <div className="flex-1" />
          <AlertDialog
            trigger={
              <Btn tone="ghost" disabled={busy}>
                <Trash2 aria-hidden="true" />
                Delete
              </Btn>
            }
            title="Delete this record?"
            description={scriptDeleteWarning(entry)}
            confirmLabel="Delete"
            confirmVariant="destructive"
            onConfirm={onDelete}
          />
        </div>
      </div>
    </ScrollArea>
  );
}

/** The proposal row. Same anatomy as the two above — one glyph, two lines, a
 *  chip and a time. Plain glyph, not violet: the engine is deterministic
 *  machinery, and violet is the AI mark. */
function ProposalRow({
  entry,
  selected,
  onSelect,
}: {
  entry: PropagationListEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "" : undefined}
      className="gl-heals-row"
    >
      <span className="gl-heals-row-icon gl-heals-row-icon-plain">
        <Share2 aria-hidden="true" />
      </span>
      <span className="gl-heals-row-text">
        <span className="gl-heals-row-step">
          {entry.stepLabel || "Propagated fix"}
        </span>
        <span className="gl-heals-row-test">{entry.testName ?? "(deleted test)"}</span>
      </span>
      <span className="gl-heals-row-meta">
        {proposalStatusChip(entry)}
        <span className="gl-heals-row-when">{fmtWhen(entry.at)}</span>
      </span>
    </button>
  );
}

function ProposalDetail({
  entry,
  sameOriginPending,
  onAccept,
  onDismiss,
  onRevert,
  onAcceptAll,
  busy,
}: {
  entry: PropagationListEntry;
  /** Every OTHER pending proposal on this origin — the bulk apply's scope. */
  sameOriginPending: PropagationListEntry[];
  onAccept: () => void;
  onDismiss: () => void;
  onRevert: () => void;
  onAcceptAll: () => void;
  busy: boolean;
}) {
  const settled = entry.status !== "pending";
  // Donor names come from the tests cache the rail already fills; a donor
  // whose test is gone renders the way every deleted test does here.
  const tests = useQuery({ queryKey: ["tests"], queryFn: api.tests.list }).data;
  const nameOf = (testId: string) =>
    tests?.find((t) => t.id === testId)?.name ?? "(deleted test)";
  // The evidence figure — joined backend-side; every absent side is a rung of
  // the honest ladder, so an empty result simply renders no figures.
  const evidence = useQuery({
    queryKey: ["propagations", "evidence", entry.id],
    queryFn: () => api.propagation.evidence(entry.id),
  }).data;
  const reasons = entry.reasons.map((code) => REASON_COPY[code]).filter(Boolean);
  const bulkNames = [...new Set(sameOriginPending.map((p) => p.testName ?? "(deleted test)"))];

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="gl-heals-detail-body">
        {!settled && entry.applied ? (
          <p className="gl-notice" style={{ boxShadow: insetRail(TONE.amber) }}>
            Propagation has already changed this step. A fix confirmed on another test is not
            the same as a fix confirmed on this one — read both locators before you keep it.
          </p>
        ) : null}

        <div className="gl-heals-section">
          <span className="gl-section-title">{entry.stepLabel || "Propagated fix"}</span>
          <div className="gl-heal-head">
            <span className="gl-chip">From another test</span>
            {proposalStatusChip(entry)}
            <span className="gl-heal-when">{fmtWhen(entry.at)}</span>
          </div>
          <span className="gl-note">
            {entry.testName ?? "The test this targets has been deleted."}
          </span>
        </div>

        <div className="gl-heals-section">
          <span className="gl-section-title">Locator</span>
          <div className="gl-heal-locs">
            <div className="gl-heal-loc">
              <span className="gl-heal-loc-key">was</span>
              <code className="gl-mono-value gl-heal-was">{formatLocator(entry.fromLocator)}</code>
            </div>
            <div className="gl-heal-loc">
              <span className="gl-heal-loc-key">now</span>
              <code className="gl-mono-value gl-heal-now">{formatLocator(entry.toLocator)}</code>
            </div>
          </div>
        </div>

        <div className="gl-heals-section">
          <span className="gl-section-title">Why</span>
          <p className="gl-note">
            {entry.origin}
            {entry.donorPageUrl ? ` · seen on ${entry.donorPageUrl}` : ""}
          </p>
          {reasons.map((sentence) => (
            <p key={sentence} className="gl-note">
              {sentence}
            </p>
          ))}
          {entry.donors.length > 0 ? (
            <p className="gl-note">
              {entry.donors.length === 1 ? "Confirmed in " : "Confirmed in: "}
              {[...new Set(entry.donors.map((d) => nameOf(d.testId)))].join(", ")}
            </p>
          ) : null}
        </div>

        {evidence?.donor?.shot || evidence?.target?.shot ? (
          <div className="gl-heals-section">
            <span className="gl-section-title">On screen</span>
            <div className="gl-prop-evidence">
              {evidence?.donor?.shot ? (
                <ShotHighlight
                  shot={evidence.donor.shot}
                  rect={evidence.donor.rect}
                  approximate={evidence.donor.approximate}
                  label={formatLocator(entry.toLocator)}
                  caption="Where it healed — the donor's run, after the fix"
                />
              ) : null}
              {evidence?.target?.shot ? (
                <ShotHighlight
                  shot={evidence.target.shot}
                  rect={evidence.target.rect}
                  approximate={evidence.target.approximate}
                  caption={
                    evidence.target.approximate
                      ? "This test's step — box from the recording, not measured"
                      : "This test's step, on its most recent captured run"
                  }
                />
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="gl-heal-actions">
          {!settled ? (
            <>
              <Btn tone="go" disabled={busy} onClick={onAccept}>
                <Check aria-hidden="true" />
                {entry.applied ? "Keep" : "Apply"}
              </Btn>
              <Btn tone="ghost" disabled={busy} onClick={entry.applied ? onRevert : onDismiss}>
                <RotateCcw aria-hidden="true" />
                {entry.applied ? "Revert" : "Dismiss"}
              </Btn>
              {sameOriginPending.length > 0 ? (
                <AlertDialog
                  trigger={
                    <Btn tone="ghost" disabled={busy}>
                      Apply all {sameOriginPending.length + 1} on this site
                    </Btn>
                  }
                  title={`Apply ${sameOriginPending.length + 1} proposals on ${entry.origin}?`}
                  description={`This writes the proposed locator into each test and regenerates its script: ${[
                    entry.testName ?? "(deleted test)",
                    ...bulkNames,
                  ]
                    .slice(0, 6)
                    .join(", ")}${
                    bulkNames.length + 1 > 6 ? ` and ${bulkNames.length + 1 - 6} more` : ""
                  }. Every change lands in this journal with a one-click revert.`}
                  confirmLabel="Apply all"
                  onConfirm={onAcceptAll}
                />
              ) : null}
            </>
          ) : entry.status === "accepted" ? (
            <Btn tone="ghost" disabled={busy} onClick={onRevert}>
              <RotateCcw aria-hidden="true" />
              Revert
            </Btn>
          ) : null}
        </div>
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
  const scriptChanges = useQuery({
    queryKey: ["script-changes", "all"],
    queryFn: () => api.scriptChanges.listAll(),
  });
  const propagations = useQuery({
    queryKey: ["propagations", "all"],
    queryFn: () => api.propagation.listAll(),
  });
  // One list, every kind, newest first — the question this screen answers is
  // "what has been changing my tests", and splitting it by mechanism would
  // make the user read three lists to answer it once.
  const entries = React.useMemo<JournalEntry[]>(
    () =>
      [
        ...(heals.data ?? []).map((entry): JournalEntry => ({ kind: "heal", entry })),
        ...(scriptChanges.data ?? []).map((entry): JournalEntry => ({ kind: "script", entry })),
        ...(propagations.data ?? []).map((entry): JournalEntry => ({ kind: "proposal", entry })),
      ].sort((a, b) => b.entry.at - a.entry.at),
    [heals.data, scriptChanges.data, propagations.data],
  );

  // Clamp rather than trust: accepting the last record on the last page shrinks
  // the list under the page you're on, and an unclamped number renders an empty
  // list next to rows that plainly exist.
  const safePage = clampPage(page, entries.length);
  const visible = pageSlice(entries, safePage);
  const selected = entries.find((e) => e.entry.id === selectedId) ?? null;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["heals"] });
    void qc.invalidateQueries({ queryKey: ["script-changes"] });
    void qc.invalidateQueries({ queryKey: ["propagations"] });
    void qc.invalidateQueries({ queryKey: ["tests"] });
    // A reverted script change rewrites a spec and re-parses its steps.
    void qc.invalidateQueries({ queryKey: ["script"] });
    void qc.invalidateQueries({ queryKey: ["test"] });
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
  const removeChange = useMutation({
    mutationFn: (id: string) => api.scriptChanges.remove(id),
    onSuccess: () => {
      setSelectedId(null);
      invalidate();
      toast.success("Record deleted");
    },
    onError: (err: unknown) => toast.error(String(err)),
  });
  const acceptProposal = useMutation({
    mutationFn: (p: { id: string; locator?: Locator }) => api.propagation.accept(p.id, p.locator),
    onSuccess: () => {
      invalidate();
      toast.success("Applied to the test");
    },
    onError: (err: unknown) => toast.error(String(err)),
  });
  const dismissProposal = useMutation({
    mutationFn: (id: string) => api.propagation.dismiss(id),
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });
  const revertProposal = useMutation({
    mutationFn: (id: string) => api.propagation.revert(id),
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(String(err)),
  });
  const acceptAllProposals = useMutation({
    // Sequential, not Promise.all: each accept regenerates a spec, and every
    // refusal (a step gone stale mid-batch) must count without failing the
    // rest. The summary says both numbers, because "applied some of them" is
    // the honest outcome of a bulk action over live tests.
    mutationFn: async (ids: string[]) => {
      let applied = 0;
      for (const id of ids) {
        try {
          await api.propagation.accept(id);
          applied += 1;
        } catch {
          // Left pending or marked stale by the service — visible in the list.
        }
      }
      return { applied, of: ids.length };
    },
    onSuccess: (res) => {
      invalidate();
      if (res.applied === res.of) toast.success(`Applied ${res.applied} proposals`);
      else toast.warning(`Applied ${res.applied} of ${res.of} — the rest need a look`);
    },
    onError: (err: unknown) => toast.error(String(err)),
  });
  const clearSettled = useMutation({
    // Both journals, one button — "Clear history" that emptied half the list
    // would read as a control that didn't work.
    mutationFn: async () => {
      const [h, s] = await Promise.all([
        api.heals.clearAllSettled(),
        api.scriptChanges.clearAllSettled(),
      ]);
      return { removed: h.removed + s.removed };
    },
    onSuccess: (res) => {
      setSelectedId(null);
      invalidate();
      toast.success(`Cleared ${res.removed} record${res.removed === 1 ? "" : "s"}`);
    },
    onError: (err: unknown) => toast.error(String(err)),
  });

  const pending = entries.filter((e) => e.entry.status === "pending").length;
  const settledCount = entries.length - pending;
  const busy =
    accept.isPending ||
    revert.isPending ||
    remove.isPending ||
    keepChange.isPending ||
    revertChange.isPending ||
    removeChange.isPending ||
    acceptProposal.isPending ||
    dismissProposal.isPending ||
    revertProposal.isPending ||
    acceptAllProposals.isPending;

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
        title={`Delete ${settledCount} settled record${settledCount === 1 ? "" : "s"}?`}
        description="This removes every heal and script change you've already settled, across all tests. Records still needing review are kept, and no test is changed. A settled script change is also the last copy of the script it replaced, so this throws those away too."
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
        id={`${entries.length} ${entries.length === 1 ? "record" : "records"}${
          pending > 0 ? ` · ${pending} needing review` : ""
        }`}
        right={clearHistory}
        className="gl-heals-journal"
      >
        {entries.length === 0 ? (
          <p className="gl-heals-empty gl-note">
            {heals.isLoading || scriptChanges.isLoading || propagations.isLoading
              ? "Loading…"
              : "Nothing yet. Every locator Auto-Heal changes, every rewrite of a test's script, and every fix proposed from a sibling test is recorded here, with a way to put it back."}
          </p>
        ) : (
          <>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col">
                {visible.map((row) =>
                  row.kind === "heal" ? (
                    <HealRow
                      key={row.entry.id}
                      entry={row.entry}
                      selected={row.entry.id === selectedId}
                      onSelect={() => setSelectedId(row.entry.id)}
                    />
                  ) : row.kind === "script" ? (
                    <ScriptChangeListRow
                      key={row.entry.id}
                      entry={row.entry}
                      selected={row.entry.id === selectedId}
                      onSelect={() => setSelectedId(row.entry.id)}
                    />
                  ) : (
                    <ProposalRow
                      key={row.entry.id}
                      entry={row.entry}
                      selected={row.entry.id === selectedId}
                      onSelect={() => setSelectedId(row.entry.id)}
                    />
                  ),
                )}
              </div>
            </ScrollArea>
            <Pager page={safePage} total={entries.length} onPage={setPage} label="records" />
          </>
        )}
      </Panel>

      <Panel
        title="What changed"
        // The panel is ABOUT a record, and the `id` slot is where this design
        // puts what a panel is about — dim, truncating, findable when looked for.
        id={selected ? (selected.entry.testName ?? "(deleted test)") : undefined}
        className="gl-heals-detail"
      >
        {selected === null ? (
          <p className="gl-heals-empty gl-note">Select a record to see what changed.</p>
        ) : selected.kind === "heal" ? (
          <HealDetail
            entry={selected.entry}
            busy={busy}
            onAccept={(locator) => accept.mutate({ id: selected.entry.id, locator })}
            onRevert={() => revert.mutate(selected.entry.id)}
            onDelete={() => remove.mutate(selected.entry.id)}
          />
        ) : selected.kind === "script" ? (
          <ScriptChangeDetail
            entry={selected.entry}
            busy={busy}
            onAccept={() => keepChange.mutate(selected.entry.id)}
            onRevert={() => revertChange.mutate(selected.entry.id)}
            onDelete={() => removeChange.mutate(selected.entry.id)}
          />
        ) : (
          <ProposalDetail
            entry={selected.entry}
            busy={busy}
            sameOriginPending={(propagations.data ?? []).filter(
              (p) =>
                p.id !== selected.entry.id &&
                p.status === "pending" &&
                p.origin === selected.entry.origin,
            )}
            onAccept={() => acceptProposal.mutate({ id: selected.entry.id })}
            onDismiss={() => dismissProposal.mutate(selected.entry.id)}
            onRevert={() => revertProposal.mutate(selected.entry.id)}
            onAcceptAll={() =>
              acceptAllProposals.mutate([
                selected.entry.id,
                ...(propagations.data ?? [])
                  .filter(
                    (p) =>
                      p.id !== selected.entry.id &&
                      p.status === "pending" &&
                      p.origin === selected.entry.origin,
                  )
                  .map((p) => p.id),
              ])
            }
          />
        )}
      </Panel>
    </div>
  );
}

/** Re-exported so the page size the view uses is the one tests assert against
 *  rather than a second copy of the number. */
export { PAGE_SIZE };
