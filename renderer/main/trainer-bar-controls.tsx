// The reserved context band and its occupants — shared by both trainers.
//
// THE BAND'S HEIGHT IS THE CONTRACT. Every transient the old tool rows
// injected inline — the armed-assert prompt, Hard/Soft, the cancel button,
// the replay result, the refine notice — reflowed the row and moved the
// buttons someone was reaching for (the exact failure DECISIONS 2026-08-17
// banned on the Visual screen, unguarded here until now). The context band
// reserves its height in CSS (`.gl-trainer-context` / `.gl-panelwin-context`,
// both `min-height`), so a transient arriving or leaving changes what the
// band SAYS and never where anything IS.
//
// One implementation for both surfaces so they cannot drift into describing
// one session differently; the frame class stays per-surface (DECISIONS
// 2026-08-12 — shared names would have to satisfy both widths, and the one
// that lost would be the panel).

import * as React from "react";
import { Crosshair, Workflow, X } from "lucide-react";

import { Btn, Segmented } from "../theme";
import type { AssertKind } from "../lib/recorder-types";
import { ASSERT_LABEL } from "./trainer-actions";

/** Tile copy, exported for the same reason DOCK_TOOLTIP is: folded tiles
 *  carry `what` only as a hover title, and a string only reachable by hover
 *  is one no jsdom test can assert on. */
export const TILE_COPY = {
  assert: { name: "Assert", what: "Pin what must be true on the page" },
  // `shortName` is the 360px panel's label: four tiles share ~332px there,
  // and "ADD STEP" in tracked mono is the one name that ellipsizes. The
  // accessible name stays "Add step" on both surfaces via aria-label.
  add: { name: "Add step", shortName: "Add", what: "Insert a manual step at the cursor" },
  replay: { name: "Replay", what: "Re-run from the selected step" },
  ai: { name: "AI", what: "Describe steps in words — tried before inserted" },
} as const;

/** The idle line — the band never collapses, so it says something true. */
export const CONTEXT_IDLE_HINT = "Act on the page, or pick a tool.";

/** Hard/Soft, mounted ONLY inside the armed-assert context. It used to hold
 *  permanent width in the main row for a choice that only matters while
 *  arming — and the panel did not offer it at all, which made soft
 *  assertions unreachable from the surface most sessions are driven from. */
export function StrictnessControl({
  soft,
  onChange,
}: {
  soft: boolean;
  onChange: (soft: boolean) => void;
}): React.ReactElement {
  return (
    <Segmented
      label="Assertion strictness"
      value={soft ? "soft" : "hard"}
      onChange={(v) => onChange(v === "soft")}
      options={[
        {
          value: "hard",
          label: "Hard",
          title:
            "Hard — a failed assertion stops the test run immediately. Use for conditions the test depends on.",
        },
        {
          value: "soft",
          label: "Soft",
          title:
            "Soft — a failed assertion is reported but the run continues. Use for non-critical checks.",
        },
      ]}
    />
  );
}

export interface BarContextZoneProps {
  /** Per-surface frame class: "gl-trainer-context" | "gl-panelwin-context". */
  className: string;
  /** The armed assert kind, or null. Its label renders HERE, which is what
   *  lets the Assert tile's own label stay fixed-width whatever is armed. */
  assertMode: AssertKind | null;
  soft: boolean;
  onSoftChange: (soft: boolean) => void;
  onCancelAssert: () => void;
  refineMode: boolean;
  onCancelRefine: () => void;
  /** Transient one-liner — the replay result, cleared by the view's timer. */
  note: string | null;
  /** The create-flow gate (trainer-actions.createFlowGate) + its action.
   *  Always mounted, disabled-gated — see the gate's comment. */
  createFlow: {
    count: number;
    disabled: boolean;
    title: string;
    onClick: () => void;
    /** The panel's width wants "Flow", the main window affords "Create flow". */
    shortLabel?: boolean;
  };
}

export function BarContextZone({
  className,
  assertMode,
  soft,
  onSoftChange,
  onCancelAssert,
  refineMode,
  onCancelRefine,
  note,
  createFlow,
}: BarContextZoneProps): React.ReactElement {
  const flowLabel =
    (createFlow.shortLabel ? "Flow" : "Create flow") +
    (createFlow.count > 0 ? ` (${createFlow.count})` : "");
  return (
    <div className={className}>
      {assertMode ? (
        <>
          {/* CYAN, the palette's "waiting on the user" — the same licence the
              old inline prompt had. The kind's label lives here, off the
              trigger, so arming changes this band's words and nothing's
              geometry. */}
          <span className="gl-trainer-prompt min-w-0 truncate">
            {ASSERT_LABEL[assertMode]} — click an element in the browser…
          </span>
          <StrictnessControl soft={soft} onChange={onSoftChange} />
          <button
            type="button"
            className="gl-icon-btn"
            onClick={onCancelAssert}
            aria-label="Cancel assertion"
          >
            <X className="size-3.5" />
          </button>
        </>
      ) : refineMode ? (
        <>
          <Crosshair className="gl-trainer-context-mark size-3.5" aria-hidden />
          <span className="gl-trainer-prompt min-w-0 truncate">
            Refine selector active — click a component in the browser. The page won’t respond to
            clicks.
          </span>
          <button
            type="button"
            className="gl-icon-btn"
            onClick={onCancelRefine}
            aria-label="Cancel selector refine"
          >
            <X className="size-3.5" />
          </button>
        </>
      ) : note ? (
        <span className="gl-note min-w-0 truncate">{note}</span>
      ) : (
        <span className="gl-trainer-context-hint min-w-0 truncate">{CONTEXT_IDLE_HINT}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <Btn onClick={createFlow.onClick} disabled={createFlow.disabled} title={createFlow.title}>
          <Workflow className="size-3.5" /> {flowLabel}
        </Btn>
      </span>
    </div>
  );
}
