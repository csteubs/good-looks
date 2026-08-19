// "Position among matches" — the ordinal the user can finally SAY.
//
// `Locator.nth` has existed since the ambiguity fallback began writing it,
// the generator has always emitted it last (it indexes the narrowed set), and
// DECISIONS 4208 admits it as the last resort. What never existed was a way
// for the USER to choose it: the picker offered container, text, attribute
// and class clauses, never position — so "the fourth row of very similar
// rows" meant hand-editing the Script tab. This field closes that, shared by
// the Refine dialog and the composer's target picker, sitting UNDER the
// context section because it applies after context narrows (same order the
// emitted chain evaluates).
//
// "Last" is `nth: -1` — Playwright's one legal negative — and it is the
// stable way to index a set whose size changes between runs; the tail is
// where appended rows land, so "last" keeps meaning the newest one.

import * as React from "react";
import { Input, SegmentedControl, SegmentedControlItem, Text } from "@ui";

type Mode = "auto" | "first" | "last" | "index";

function modeFor(value: number | null): Mode {
  if (value === null) return "auto";
  if (value === 0) return "first";
  if (value === -1) return "last";
  return "index";
}

export function PositionField({
  value,
  onChange,
}: {
  /** The locator's `nth`, or null for none. 0-based like the model; the
   *  numeric input renders 1-based because people count matches from one. */
  value: number | null;
  onChange: (nth: number | null) => void;
}) {
  // "Nth…" is a mode the user ENTERS before it has a number, so it is local
  // state rather than derived: a fully value-controlled segment could not show
  // its input until the parent echoed a value back, which would force emitting
  // an arbitrary index the moment the segment was clicked.
  const [indexMode, setIndexMode] = React.useState(false);
  const mode: Mode = indexMode ? "index" : modeFor(value);
  // The 1-based draft for "index" mode, kept as text so a half-typed number
  // doesn't snap the field around underneath the user.
  const [draft, setDraft] = React.useState(value !== null && value > 0 ? String(value + 1) : "");

  return (
    <div className="flex flex-col gap-1.5">
      <Text variant="small" color="secondary">
        Position among matches
      </Text>
      <div className="flex items-center gap-2">
        <SegmentedControl
          size="small"
          value={mode}
          onValueChange={(m) => {
            if (!m || m === mode) return;
            if (m === "index") {
              // Enter the mode; emit only once a real position is typed. The
              // previous value stays live until then, so nothing snaps.
              setIndexMode(true);
              const n = parseInt(draft, 10);
              if (Number.isFinite(n) && n >= 1) onChange(n - 1);
              return;
            }
            setIndexMode(false);
            if (m === "auto") onChange(null);
            else if (m === "first") onChange(0);
            else onChange(-1);
          }}
        >
          <SegmentedControlItem value="auto">Auto</SegmentedControlItem>
          <SegmentedControlItem value="first">First</SegmentedControlItem>
          <SegmentedControlItem value="last">Last</SegmentedControlItem>
          <SegmentedControlItem value="index">Nth…</SegmentedControlItem>
        </SegmentedControl>
        {mode === "index" ? (
          <Input
            size="small"
            inputMode="numeric"
            value={draft || (value !== null && value > 0 ? String(value + 1) : "")}
            onChange={(e) => {
              const text = e.target.value;
              setDraft(text);
              const n = parseInt(text, 10);
              if (Number.isFinite(n) && n >= 1) onChange(n - 1);
            }}
            aria-label="Match position (1-based)"
            placeholder="2"
            className="w-16"
          />
        ) : null}
      </div>
      <Text variant="small" color="tertiary">
        {mode === "auto"
          ? "Auto: the locator must match exactly one element, or the step fails strict mode."
          : "Applied after the context clauses narrow the matches — the position indexes what remains, in page order."}
      </Text>
    </div>
  );
}
