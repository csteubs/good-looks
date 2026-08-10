// The rail: the library, the views nav, and the connection footer.
// docs/REDESIGN.md §4 (A4).
//
// A restyle of the surface `SplitView` already owns, not a replacement for it —
// collapse persistence, the resize handle and the ⌃⌘S shortcut stay where they
// are. What changes is everything drawn inside: `--gl-rail` instead of a
// translucent panel, hairlines instead of rounded rows, mono uppercase labels,
// and the neutral selection treatment.
//
// TWO STRUCTURAL DECISIONS, both of which fix something rather than restyling it.
//
// 1. THE VIEWS NAV IS OUTSIDE THE SCROLLER. It used to be an `mt-auto` block at
//    the end of the library list, which puts it at the bottom only while the
//    library is SHORT — the moment there are more tests than fit, Stats /
//    Visual / Batch / Heals scroll away with them and the app's own views
//    become something you scroll to find. `Rail` takes them as their own slot
//    below the scrolling body, so "pinned to the bottom" is structural.
//
// 2. ROWS ACTIVATE ON CLICK. The SDK's `SidebarListItem` fires on `mouseDown` —
//    the AppKit idiom, and a documented trap in this repo: `fireEvent.click`
//    does nothing to it, and the assertion then reports "0 calls", which reads
//    as a dead handler rather than as the wrong event (CLAUDE.md, and
//    REDESIGN §8.2 which predicts exactly this swap). Our own row is an
//    ordinary button, so click is click. The tests that drove the old rows with
//    `fireEvent.mouseDown` move back to `fireEvent.click`, and that is a real
//    behaviour change rather than a test edit: a press that lands on a row and
//    is dragged off it no longer navigates.

import * as React from "react";

export interface RailProps {
  /** The rail header, aligned with the top strip. */
  title?: string;
  /** Controls in the header, trailing edge. */
  actions?: React.ReactNode;
  /**
   * A filter field, pinned between the header and the scrolling body.
   *
   * PINNED FOR THE SAME REASON THE NAV IS. A search box at the top of a
   * scrolling list is only reachable while the list is short: type a query that
   * narrows to one pane, scroll, and the field that put you there is gone. It
   * is its own slot rather than the first child of `children` so that "does not
   * scroll" is structural instead of something the caller has to keep true.
   *
   * The Settings window is what needs it (B4) and the main window passes
   * nothing, so the rail is byte-identical there.
   */
  search?: React.ReactNode;
  /** The views nav. Pinned below the scrolling body — see the header. */
  nav?: React.ReactNode;
  /** The footer strip (the AI connection indicator, today). */
  footer?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export function Rail({
  title,
  actions,
  search,
  nav,
  footer,
  className,
  children,
}: RailProps): React.ReactElement {
  return (
    <div className={["gl-rail", className].filter(Boolean).join(" ")} data-gl="rail">
      {title !== undefined || actions !== undefined ? (
        // `drag-region` is kept from the surface this replaces. The main window
        // has a native title bar so it drags nothing today, but it is in-flow
        // chrome rather than a positioned overlay, which is the shape
        // `check:clickable-chrome` bans — and it is what this row would need if
        // the window ever loses its title bar.
        <div className="gl-rail-head drag-region">
          {title !== undefined ? <span className="gl-rail-head-title">{title}</span> : null}
          {actions !== undefined ? (
            <div className="gl-rail-head-actions">{actions}</div>
          ) : null}
        </div>
      ) : null}
      {search !== undefined ? <div className="gl-rail-search">{search}</div> : null}
      <div className="gl-rail-body">{children}</div>
      {nav !== undefined ? <div className="gl-rail-nav">{nav}</div> : null}
      {footer !== undefined ? <div className="gl-rail-foot">{footer}</div> : null}
    </div>
  );
}

/** A labelled group of rows. The label is a real heading so the rail has an
 *  outline in a screen reader, rather than one long undifferentiated list. */
export function RailGroup({
  label,
  children,
  className,
}: {
  label?: string;
  children?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={className} role="group" aria-label={label}>
      {label !== undefined ? <h2 className="gl-rail-group-label">{label}</h2> : null}
      {children}
    </div>
  );
}

export interface RailRowProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title" | "className"> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Trailing indicators — a verdict dot, an AI sparkle. */
  accessory?: React.ReactNode;
  selected?: boolean;
  /** The native `title` attribute, renamed because `title` is the row's label
   *  here. A `title` rather than a Tooltip on purpose: Radix tooltips cannot be
   *  opened under jsdom, so a hint carried by one is untestable. */
  hint?: string;
  className?: string;
}

export function RailRow({
  icon,
  title,
  subtitle,
  accessory,
  selected,
  hint,
  className,
  ...props
}: RailRowProps): React.ReactElement {
  return (
    <button
      type="button"
      title={hint}
      // `data-selected` rather than a class, because that is the attribute
      // `check:selection-neutral` looks for when it proves no selection in this
      // app is drawn in a status colour. Absent, not `false`: `[data-selected]`
      // matches an empty attribute, so a literal `data-selected="false"` would
      // style every unselected row as selected.
      data-selected={selected ? "" : undefined}
      aria-current={selected ? "true" : undefined}
      className={["gl-rail-row", className].filter(Boolean).join(" ")}
      {...props}
    >
      {icon !== undefined ? <span className="gl-rail-row-icon">{icon}</span> : null}
      <span className="gl-rail-row-text">
        <span className="gl-rail-row-title">{title}</span>
        {subtitle !== undefined ? <span className="gl-rail-row-sub">{subtitle}</span> : null}
      </span>
      {accessory !== undefined ? (
        <span className="gl-rail-row-accessory">{accessory}</span>
      ) : null}
    </button>
  );
}

/** Copy shown where a list would be. Sans, not mono: this is a sentence to be
 *  read, and the design's mono is for things scanned at a glance. */
export function RailEmpty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="gl-rail-empty">{children}</p>;
}
