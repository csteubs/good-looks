// KeyValue — the two-column label/value grid.
//
// Used wherever the app states facts about a thing: baseline provenance, run
// settings, a step's locator, a batch's configuration.
//
// A `<dl>`, not a table and not divs. These are name/value pairs, which is
// precisely what a description list is for, and it is the difference between a
// screen reader announcing "Browser, Chromium" and announcing two unrelated
// strings that happen to be adjacent.
//
// BASELINE-ALIGNED, not centred. The label is 9.5px uppercase mono and the
// value is often 11px or a chip; centring two things of different heights
// leaves the label floating, and a column of floating labels reads as sloppy in
// a way nobody can quite name. Aligning the first text baselines makes them sit
// on one line.

import * as React from "react";

export interface KeyValueRow {
  label: string;
  value: React.ReactNode;
  /** Full text for a value that truncates. */
  title?: string;
}

export interface KeyValueProps {
  rows: ReadonlyArray<KeyValueRow>;
  /** Width of the label column. Fixed per instance so every row in ONE grid
   *  lines up; not global, because "Viewport" and "Accepted by" need different
   *  room and forcing one width on both wastes half the panel. */
  labelWidth?: number;
  className?: string;
}

export function KeyValue({ rows, labelWidth = 92, className }: KeyValueProps): React.ReactElement {
  return (
    <dl
      className={["gl-kv", className].filter(Boolean).join(" ")}
      style={{ gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)` }}
      data-gl="key-value"
    >
      {rows.map((row) => (
        <React.Fragment key={row.label}>
          <dt className="gl-kv-label">{row.label}</dt>
          <dd className="gl-kv-value" title={row.title}>
            {row.value}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
