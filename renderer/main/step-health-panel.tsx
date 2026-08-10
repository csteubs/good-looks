// Step Health — one row per step, across all retained history.
//
// The join the metrics DB exists for. Each of these columns already existed and
// each lived in a different panel keyed off a different file, so the rows that
// matter were invisible: a step that never fails but has healed four times, or
// one whose visual keeps drifting while it passes. Neither is visible in any
// view that holds only one column.
//
// Two things the display has to get right, both of which look like polish and
// are not:
//
//   • A COUNT AND ITS DENOMINATOR travel together. "4 heals" means something
//     different across 5 runs and across 400. Every count here is rendered
//     against its run count for that reason.
//   • A NULL IS NOT A ZERO. `p50` is null for steps whose runs predate the
//     fixture measuring step duration, and a dash is the honest rendering. A 0
//     in a column people sort by is a lie that sorts to the top.
//
// Sorting is client-side over rows the query already capped and ordered by
// severity, so the default view is "worst first" without a sort being chosen.

import { ArrowDown, ArrowUp } from "lucide-react";
import * as React from "react";

import { Panel, TONE } from "../theme";
import type { StepHealthRow } from "../../shared/metrics-query.mjs";

type SortKey = "label" | "runs" | "failRate" | "heals" | "visualChanges" | "pageErrors";

const COLUMNS: { key: SortKey; label: string; hint: string; numeric: boolean; width?: string }[] = [
  { key: "label", label: "Step", hint: "The step, across every run that has it", numeric: false },
  { key: "runs", label: "Runs", hint: "How many runs included this step", numeric: true, width: "56px" },
  {
    key: "failRate",
    label: "Fail",
    hint: "Share of those runs where it failed",
    numeric: true,
    width: "56px",
  },
  {
    key: "heals",
    label: "Heals",
    hint: "Times Auto-Heal substituted a locator — a step that never fails but heals often is decaying",
    numeric: true,
    width: "72px",
  },
  {
    key: "visualChanges",
    label: "Visual",
    hint: "Runs where the screenshot differed from its baseline",
    numeric: true,
    width: "72px",
  },
  {
    key: "pageErrors",
    label: "Page errors",
    hint: "Times the page's own JavaScript threw during this step",
    numeric: true,
    width: "86px",
  },
];

/** A count against the runs it was drawn from. Zero renders as a muted dash:
 *  a column of "0"s is noise, and the eye should go to the non-zero rows. */
function Count({ n, of }: { n: number; of: number }) {
  if (!n) return <span style={{ color: "var(--gl-tx-3)" }}>—</span>;
  return (
    <span>
      {n}
      <span style={{ color: "var(--gl-tx-3)" }}> / {of}</span>
    </span>
  );
}

export function formatMs(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function StepHealthPanel({
  rows,
  available,
}: {
  rows: StepHealthRow[];
  available: boolean;
}) {
  const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean } | null>(null);

  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const dir = sort.desc ? -1 : 1;
    return [...rows].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
  }, [rows, sort]);

  // "Metrics are unavailable on this runtime" and "you have not run anything"
  // are different facts and only one of them is the user's to fix.
  if (!available) {
    return (
      <Panel title="Step health">
        <p className="gl-panel-note">
          Step metrics aren’t available on this runtime, so there’s nothing to show here. Everything
          else on this page still works.
        </p>
      </Panel>
    );
  }

  if (rows.length === 0) {
    return (
      <Panel title="Step health">
        <p className="gl-panel-note">
          No steps recorded yet. Run a test and its steps will start accumulating history here.
        </p>
      </Panel>
    );
  }

  const toggle = (key: SortKey) =>
    setSort((s) => (s?.key === key ? { key, desc: !s.desc } : { key, desc: true }));

  return (
    <Panel title="Step health" id={`${rows.length} step${rows.length === 1 ? "" : "s"}`}>
      <div className="gl-table-wrap" style={{ border: 0 }}>
        <table className="gl-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  style={{
                    ...(c.width ? { width: c.width } : null),
                    ...(c.numeric ? { textAlign: "end" as const } : null),
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggle(c.key)}
                    title={c.hint}
                    aria-label={`Sort by ${c.label}`}
                    className={`gl-sort${c.numeric ? " gl-sort-num" : ""}`}
                  >
                    {c.label}
                    {sort?.key === c.key ? (
                      sort.desc ? (
                        <ArrowDown aria-hidden="true" />
                      ) : (
                        <ArrowUp aria-hidden="true" />
                      )
                    ) : null}
                  </button>
                </th>
              ))}
              <th style={{ width: "104px", textAlign: "end" }}>
                <span title="Fastest and slowest measured run of this step">Range</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={`${r.testId}:${r.stepId}`}>
                {/* Two lines in one cell, so the step and the test it belongs to
                    stay together while the numeric columns keep one baseline. */}
                <td style={{ paddingTop: 4, paddingBottom: 4, whiteSpace: "normal" }}>
                  <div className="gl-rowline">
                    <div className="gl-rowline-main" title={r.label ?? r.stepId}>
                      {r.label ?? r.stepId}
                    </div>
                    <div className="gl-rowline-sub">{r.testName ?? r.testId}</div>
                  </div>
                </td>
                <td className="gl-num">{r.runs}</td>
                <td className="gl-num">
                  {r.failed ? (
                    <span style={{ color: TONE.red }}>{Math.round(r.failRate * 100)}%</span>
                  ) : (
                    <span style={{ color: "var(--gl-tx-3)" }}>—</span>
                  )}
                </td>
                <td className="gl-num">
                  <Count n={r.heals} of={r.runs} />
                </td>
                <td className="gl-num">
                  <Count n={r.visualChanges} of={r.runs} />
                </td>
                <td className="gl-num">
                  <Count n={r.pageErrors} of={r.runs} />
                </td>
                <td className="gl-num">
                  {/* Null when the step's runs predate the fixture measuring
                      duration. A dash, never a zero. */}
                  {r.timedRuns === 0 ? "—" : `${formatMs(r.minMs)}–${formatMs(r.maxMs)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
