// One row of the Settings window.
//
// Three things the old flat list got wrong, fixed in one place so every pane
// inherits them:
//
//   • DESCRIPTIONS ATE THE WINDOW. Every row carried a permanent 3–5 line
//     paragraph, so roughly two thirds of the vertical space was prose the user
//     reads once and then scrolls past forever. `summary` stays; `details` goes
//     behind a disclosure. Nothing is hidden that the user hasn't already been
//     told exists — the trigger says how much more there is.
//   • A RISK READ LIKE A PREFERENCE. "Record all request headers (may include
//     credentials)" signalled danger by putting the warning in the label, where
//     it competed with 29 other labels. `danger` gives it a badge and an accent
//     rule, and such a row NEVER takes `details` — see below.
//   • A DEPENDENT SETTING LOOKED LIKE A SIBLING. `recordAllHeaders` was a
//     greyed-out row at the same indent as its parent, with nothing saying why
//     it was grey. `nested` indents it and the pane unmounts it when the parent
//     is off.
//
// Descriptions use the SDK's `FieldDescription` rather than a hand-rolled
// `<p className="text-sm text-muted-foreground">`. That class was dead — no
// `muted-foreground` token exists in the design system — so every description
// in the old window rendered at full-strength primary text, which is a large
// part of why it read as an undifferentiated wall.

import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { Badge, Field, FieldContent, FieldDescription, FieldLabel } from "@glaze/core/components";

/** Ids of the rows a search matched, or `null` when no search is active.
 *  Filtering at the ROW rather than in each pane means a pane's JSX is the
 *  same whether or not a search is running — there is no second, filtered
 *  rendering path that can drift from the real one. */
const RowFilterCtx = createContext<readonly string[] | null>(null);

export function RowFilterProvider({
  matchedIds,
  children,
}: {
  matchedIds: readonly string[] | null;
  children: ReactNode;
}) {
  return <RowFilterCtx.Provider value={matchedIds}>{children}</RowFilterCtx.Provider>;
}

/** The active search's matched ids, or `null` when no search is running.
 *  `PaneSection` needs the raw list: it has to answer for all of its rows at
 *  once, and a hook cannot be called once per child. */
export function useMatchedIds(): readonly string[] | null {
  return useContext(RowFilterCtx);
}

/** True when this row survives the active search. Exported for the panes that
 *  need to know whether a whole sub-group has been filtered away. */
export function useRowVisible(id: string): boolean {
  const matched = useMatchedIds();
  if (matched === null) return true;
  return matched.indexOf(id) !== -1;
}

export interface SettingRowProps {
  /** The row's id in `SETTING_INDEX`, and the `htmlFor`/`id` of its control.
   *  One string for both, so a row that search can find is a row the label is
   *  actually wired to. */
  id: string;
  label: ReactNode;
  /**
   * The one-sentence version, always visible.
   *
   * Write it so the row is usable with the disclosure closed. If a caveat
   * changes whether someone would turn the setting ON, it belongs here, not in
   * `details`.
   */
  summary?: ReactNode;
  /**
   * The rest of the explanation, behind a disclosure.
   *
   * Never put a security or privacy consequence here. A warning the user has
   * to click to see is a warning most users never see, and this window has two
   * rows where that would matter (`record-all-headers`, `alert-webhook-url`) —
   * both of which carry their full text in `summary` instead.
   */
  details?: ReactNode;
  /** Short badge text, e.g. "stores credentials". Draws the badge and the
   *  accent rule down the row's leading edge. */
  danger?: string;
  /** Indent under the row above and draw the dependency rule. */
  nested?: boolean;
  /**
   * Put the control on its own full-width line BELOW the label and summary,
   * instead of in a right-hand column.
   *
   * For rows whose control is a cluster rather than a single switch — the
   * webhook row is a password field plus three buttons. In the horizontal
   * layout the two columns compete for the same width, and the wide one wins:
   * the label column collapses until "Webhook URL" breaks across two lines and
   * its summary renders as a one-word-per-line ribbon. Stacking gives each the
   * full width in turn.
   */
  stacked?: boolean;
  /** The control. Wire its `id` to this row's `id`. */
  children?: ReactNode;
}

export function SettingRow({
  id,
  label,
  summary,
  details,
  danger,
  nested,
  stacked,
  children,
}: SettingRowProps) {
  const [open, setOpen] = useState(false);
  const visible = useRowVisible(id);
  if (!visible) return null;

  // A danger row's full text is always on screen. Building one with `details`
  // would put a credential warning behind a click, which is the one thing this
  // component must not make easy.
  const showDetails = details && !danger;

  return (
    <Field
      orientation={stacked ? "vertical" : "horizontal"}
      data-setting-row={id}
      // `rounded-none` because a single-sided border with rounded corners
      // renders as a detached arc.
      className={
        nested
          ? `ml-4 rounded-none border-l-2 pl-4 ${danger ? "border-l-red-9" : "border-l-separator"}`
          : danger
            ? "rounded-none border-l-2 border-l-red-9 pl-4"
            : undefined
      }
    >
      <FieldContent>
        <FieldLabel htmlFor={id} className="flex flex-wrap items-center gap-2">
          {label}
          {danger ? (
            <Badge color="red" size="small">
              {danger}
            </Badge>
          ) : null}
        </FieldLabel>
        {summary ? (
          <FieldDescription>
            {summary}
            {showDetails ? (
              <>
                {" "}
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={`${id}-details`}
                  onClick={() => setOpen((v) => !v)}
                  className="cursor-pointer underline underline-offset-2 hover:text-primary"
                >
                  {open ? "Less" : "More"}
                </button>
              </>
            ) : null}
          </FieldDescription>
        ) : null}
        {showDetails && open ? (
          <FieldDescription id={`${id}-details`}>{details}</FieldDescription>
        ) : null}
      </FieldContent>
      {stacked ? <div className="flex w-full justify-end">{children}</div> : children}
    </Field>
  );
}
