// The category board — the Stats landing's answer to "is anything wrong?".
//
// docs/plans/stats-categories.md §3. A row of compact tiles, each a category,
// each clickable through to that category's dashboard, under a verdict that
// reports whether any of them needs attention.
//
// THE VERDICT LIVES IN THE PANEL'S HEADER, not in a band of its own above the
// tiles. It is one line about the BOARD — the same kind of thing as the
// "7 of 7 reporting" subtitle beside it — and a full-width row for one
// sentence cost 30-odd pixels above the fold on the app's landing screen while
// separating the title from the tiles it titles. It shrinks and ellipsizes
// there rather than pushing the header past its fixed 32px (see
// `.gl-categories` in screens.css), and carries the full sentence as a `title`
// for the width where it cannot all be shown.
//
// THE BAND COUNTS CATEGORIES. IT NEVER MERGES THEIR NUMBERS. That is the
// condition this treatment ships under and it is not a style preference:
// fourteen unaccepted accessibility steps, three flaky tests and nine healed
// locators are different units, and a total across them is a number that means
// nothing while looking authoritative. The sentence comes from `bandReading`,
// which is given only the STATES; `check:stats-categories` proves nothing under
// this directory does arithmetic across categories.
//
// EVERY TILE IS A REAL BUTTON. Not a div with onClick — these are navigation,
// they need to be reachable and announceable, and the redesign's own controls
// are plain buttons precisely so a click behaves like a click (the SDK's
// pointer-down controls are why so many tests in this repo reach for
// fireEvent.mouseDown).
//
// A TILE THAT HAS NEVER BEEN MEASURED SHOWS NO NUMBER AT ALL. See the header of
// `renderer/lib/stats-categories.ts` — `display` is null in both non-measured
// states, so there is nothing here to accidentally print.

import * as React from "react";

import { Panel, TONE, Verdict } from "../../theme";
import {
  CATEGORIES,
  bandReading,
  isMeasured,
  type CategoryId,
  type CategorySummary,
} from "../../lib/stats-categories";

export interface CategoryBoardProps {
  summaries: CategorySummary[];
  /** Called with the category the user picked. */
  onOpen: (id: CategoryId) => void;
  /** Categories with a dashboard built. Everything else is rendered as a tile
   *  that states why it does not open yet, rather than as a dead link — a tile
   *  that navigates to an empty screen is worse than one that says "not yet". */
  openable?: readonly CategoryId[];
}

/** The whole set, so the board can be shown complete before the dashboards
 *  exist. Narrowed as each one lands. */
const ALL: readonly CategoryId[] = CATEGORIES.map((c) => c.id);

export function CategoryBoard({
  summaries,
  onOpen,
  openable = ALL,
}: CategoryBoardProps): React.ReactElement | null {
  // Nothing has answered yet. Rendering an empty board would read as "you have
  // no categories", which is not a state this feature has.
  if (summaries.length === 0) return null;

  const band = bandReading(summaries);
  const byId = new Map(summaries.map((s) => [s.id, s]));

  return (
    <Panel
      className="gl-categories"
      title="Categories"
      id={`${summaries.length} of ${CATEGORIES.length} reporting`}
      /* The band's own tone reports whether anything needs attention — a fact
         about the BOARD, not a score across it. */
      right={
        <div className="gl-band" title={band.sentence}>
          <Verdict tone={band.tone ?? "cyan"}>{band.sentence}</Verdict>
        </div>
      }
    >
      <div className="gl-tiles">
        {CATEGORIES.map((meta) => {
          const s = byId.get(meta.id);
          // Its query has not resolved. A skeleton, not an "unmeasured" tile:
          // those say "you have never switched this on", which would be a lie
          // told to someone who switched it on last week.
          if (!s) {
            return (
              <div key={meta.id} className="gl-tile gl-tile-loading" aria-hidden="true">
                <span className="gl-tile-label">{meta.short}</span>
                <span className="gl-tile-wait">…</span>
              </div>
            );
          }

          const canOpen = openable.includes(meta.id);
          const measured = isMeasured(s.state);

          return (
            <button
              key={meta.id}
              type="button"
              className="gl-tile"
              data-state={s.state}
              disabled={!canOpen}
              onClick={() => onOpen(meta.id)}
              // The accessible name carries the reading, because the tile's
              // parts are three separate elements and a screen reader would
              // otherwise announce them as unrelated fragments.
              aria-label={`${meta.label}: ${measured ? `${s.display} — ` : ""}${s.say}`}
              title={canOpen ? undefined : "No dashboard for this category yet"}
            >
              <span className="gl-tile-label">{meta.short}</span>
              {measured ? (
                <span className="gl-tile-value" style={s.tone ? { color: TONE[s.tone] } : undefined}>
                  {s.display}
                </span>
              ) : (
                // NO NUMBER. Not a zero, not a dash-with-a-number's-weight —
                // the state is the content here.
                <span className="gl-tile-none">
                  {s.state === "unavailable" ? "No data" : "Not checked"}
                </span>
              )}
              <span className="gl-tile-say">{measured ? meta.unit : s.say}</span>
              {s.window ? <span className="gl-tile-window">{s.window}</span> : null}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
