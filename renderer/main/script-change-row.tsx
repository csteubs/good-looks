// One whole-script change, rendered — the sibling of `HealRow`.
//
// A heal swaps one step's locator and the row shows `was` / `now`. This one
// replaces the entire spec, so what it has to show is a diff, and what it has
// to say is WHO did it. Two origins, and the distinction is the point of the
// feature: "AI Debug - <model>" for a fix the machine wrote, plain "Edited by
// hand" for the user's own save.
//
// Shared by both surfaces (the per-test Heals tab and the cross-test Heals
// view) so the two can't describe the same event differently. It reuses the
// heal row's frame classes on purpose — see the note in theme/shared.css.

import * as React from "react";
import { FileCode2 } from "lucide-react";

import { Btn, TONE, toneSurface } from "../theme";
import { DiffView } from "../components/diff-view";
import { diffLines } from "../lib/line-diff";
import type { ScriptChangeEntry } from "../lib/recorder-types";

/** What the row says the change was. Exported because a Radix-backed tooltip
 *  can't be opened in jsdom and, more to the point, a test asserting the label
 *  should be asserting the SAME string the row renders — a copy in the test is
 *  a copy that can go stale without anything failing. */
export function originLabel(entry: ScriptChangeEntry): string {
  if (entry.origin !== "ai-debug") return "Edited by hand";
  // A model name may be missing on an entry recorded before the session
  // stamped one. "AI Debug - undefined" is worse than saying less.
  return entry.model ? `AI Debug - ${entry.model}` : "AI Debug";
}

/** The counts as one line, for a caller that wants the whole sentence.
 *
 *  The rows themselves DON'T use this — they render the two numbers as
 *  separately toned spans and follow them with the bare word "lines", so
 *  additions read green and removals red. This is the same fact in one string,
 *  for tests and for anywhere a chip needs the sentence rather than the layout.
 *
 *  The zero case only arises on an entry whose sources were dropped (any real
 *  edit touches at least one line), and "No line changes" is still better than
 *  rendering "+0 −0", which reads as a bug. */
export function changeSummary(entry: ScriptChangeEntry): string {
  if (entry.addedLines === 0 && entry.removedLines === 0) return "No line changes";
  return `+${entry.addedLines} −${entry.removedLines} lines`;
}

/** The counts, toned. Shared by the row and the cross-test view's detail pane so
 *  the same numbers can't be laid out two ways. */
export function ChangeCounts({ entry }: { entry: ScriptChangeEntry }) {
  if (entry.addedLines === 0 && entry.removedLines === 0) {
    return <span>{changeSummary(entry)}</span>;
  }
  return (
    <>
      {entry.addedLines > 0 ? (
        <span className="gl-script-change-added">+{entry.addedLines}</span>
      ) : null}
      {entry.removedLines > 0 ? (
        <span className="gl-script-change-removed">−{entry.removedLines}</span>
      ) : null}
      <span>lines</span>
    </>
  );
}

export function ScriptChangeRow({
  entry,
  onAccept,
  onRevert,
  busy,
  /** Extra chips from the caller — the cross-test view adds the test name. */
  children,
}: {
  entry: ScriptChangeEntry;
  onAccept?: () => void;
  onRevert?: () => void;
  busy?: boolean;
  children?: React.ReactNode;
}) {
  const [showDiff, setShowDiff] = React.useState(false);
  const settled = entry.status !== "pending";
  const ai = entry.origin === "ai-debug";
  // Computed only while open. A spec diff is O(n*m) over lines and a list can
  // hold fifty rows; doing it for all of them to render a number we already
  // stored would cost the whole list to show one.
  const diff = React.useMemo(
    () => (showDiff ? diffLines(entry.before, entry.after) : null),
    [showDiff, entry.before, entry.after],
  );

  return (
    <div className="gl-heal-row">
      <div className="gl-heal-head">
        <span className={`gl-heal-head-icon${ai ? "" : " gl-heal-head-icon-plain"}`}>
          <FileCode2 aria-hidden="true" />
        </span>
        <span className="gl-heal-title">Script</span>
        {/* Violet: the theme's AI-adjacent hue, and explicitly NOT a status —
            which is right, because "a model wrote this" is a fact about where
            the change came from, not a verdict on it. A hand edit takes the
            neutral chip for the same reason. */}
        {ai ? (
          <span className="gl-chip-tone" style={toneSurface(TONE.violet)}>
            {originLabel(entry)}
          </span>
        ) : (
          <span className="gl-chip">{originLabel(entry)}</span>
        )}
        {/* ONE chip, not two. Every script change was written to the test — a
            heal has a suggest-only mode and this doesn't — so "applied" alone
            reports nothing, and the fact worth taking amber for is whether
            anyone READ it before it landed. Saying both would spend the row's
            most legible slot on a word that is true of every row.

            Said out loud on the row rather than left to the "Needs review"
            heading, because the cross-test view has no such heading. */}
        {!entry.reviewed && !settled ? (
          <span className="gl-chip-tone" style={toneSurface(TONE.amber)}>
            Applied without review
          </span>
        ) : (
          <span className="gl-chip">Applied to the test</span>
        )}
        {entry.status === "accepted" ? (
          <span className="gl-chip-tone" style={toneSurface(TONE.phos)}>
            Kept
          </span>
        ) : null}
        {entry.status === "reverted" ? <span className="gl-chip">Reverted</span> : null}
        {children}
        <span className="gl-heal-when">{fmtWhen(entry.at)}</span>
      </div>

      <div className="gl-script-change-summary">
        <ChangeCounts entry={entry} />
      </div>

      <div className="gl-heal-actions">
        {!settled && onAccept ? (
          <Btn tone="go" disabled={busy} onClick={onAccept}>
            Keep
          </Btn>
        ) : null}
        {/* Revert stays offered on a SETTLED row too, unlike a heal's. The
            entry is the only copy of the previous spec, so "I kept this
            yesterday and want it back" has nowhere else to go. */}
        {onRevert ? (
          <Btn
            tone="ghost"
            disabled={busy || entry.truncated === true}
            title={
              entry.truncated
                ? "This change was too large to store, so it can't be undone."
                : undefined
            }
            onClick={onRevert}
          >
            Revert
          </Btn>
        ) : null}
        {!entry.truncated ? (
          <Btn tone="ghost" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? "Hide diff" : "Show diff"}
          </Btn>
        ) : null}
      </div>

      {diff ? (
        <div className="gl-script-change-diff">
          <DiffView diff={diff} />
        </div>
      ) : null}
    </div>
  );
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
