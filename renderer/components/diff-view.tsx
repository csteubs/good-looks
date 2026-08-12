// A line-level diff, rendered.
//
// Lifted out of ai-debug-panel.tsx when the Heals surfaces gained script
// changes. Both of them show the same thing — what a write to a test's spec
// changed — and the AI debug panel shows it BEFORE the write while the Heals
// row shows it after. Two renderers for one picture would drift, and the way
// they'd drift is one of them quietly disagreeing with the other about what a
// removed line looks like.
//
// Equal lines are dimmed; removed lines (the previous script) get a red tint;
// added lines (the new one) get a green tint.

import type { DiffLine } from "../lib/line-diff";

export function DiffView({ diff }: { diff: DiffLine[] }) {
  return (
    <div className="text-small-mono overflow-auto rounded-md border border-separator">
      <div className="min-w-max">
        {diff.map((d, i) => {
          const sign = d.type === "add" ? "+" : d.type === "remove" ? "-" : " ";
          const cls =
            d.type === "add"
              ? "bg-[var(--color-positive-subtle,rgba(46,196,87,0.12))] text-primary"
              : d.type === "remove"
                ? "bg-[var(--color-negative-subtle,rgba(229,72,77,0.12))] text-primary"
                : "text-secondary";
          return (
            <div key={i} className={`whitespace-pre px-2 py-px ${cls}`}>
              <span className="select-none opacity-60">{sign} </span>
              {d.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
