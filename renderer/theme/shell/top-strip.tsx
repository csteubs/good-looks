// The top strip: where you are, and the way out to everything global.
// docs/REDESIGN.md §4 (A4).
//
// One band across the top of the window: the wordmark, a breadcrumb, then the
// trailing cluster — two slots and whatever actions the window has (in the main
// window, the settings gear).
//
// THE TWO SLOTS ARE EMPTY ON PURPOSE, AND THEY ARE THE POINT OF THIS COMPONENT
// BEING SHAPED THIS WAY. The redesign puts a ⌘K command palette (§6.7) and a
// live job ticker (§6.8) here, and neither exists — both are Phase C. What A4
// owes them is a home, and the honest way to owe it is a slot that renders
// nothing rather than a control that does nothing:
//
//   A ⌘K hint that opens no palette is worse than no hint. It is a promise the
//   app cannot keep, it teaches the shortcut to someone who then presses it and
//   gets silence, and — unlike an empty slot — nothing about it says "not
//   built". A disabled control is no better: the app would be shipping a
//   permanently greyed key hint for a feature nobody has asked for yet.
//
// So `command` and `ticker` are props with nowhere to be filled from yet. When
// §6.7 and §6.8 land they pass a node in and change nothing else here.
//
// The breadcrumb is DATA, not chrome. A segment with an `onClick` is a button;
// the last one never is, because a link to where you already are is a control
// that does nothing — the same rule as the paragraph above, one size down.

import * as React from "react";

import { Hint } from "../primitives/hint";

export interface Crumb {
  label: string;
  /** Omit to make this segment inert. The trailing segment always is. */
  onClick?: () => void;
}

export interface TopStripProps {
  /** The path to here, outermost first. Rendered as `A / B / C`. */
  crumbs?: Crumb[];
  /** The rail handle, in practice — anything that belongs left of the wordmark. */
  leading?: React.ReactNode;
  /** ⌘K command palette (REDESIGN §6.7). Nothing fills this yet. */
  command?: React.ReactNode;
  /** Live job ticker (REDESIGN §6.8). Nothing fills this yet. */
  ticker?: React.ReactNode;
  /** Window-level actions, pinned to the trailing edge. */
  actions?: React.ReactNode;
  className?: string;
}

/** The wordmark, uppercase and letterspaced. Exported so a test can assert the
 *  string without hardcoding it, and so B1's 40px treatment of the same mark
 *  cannot drift from this one. */
export const WORDMARK = "GOOD LOOKS!";

export function TopStrip({
  crumbs = [],
  leading,
  command,
  ticker,
  actions,
  className,
}: TopStripProps): React.ReactElement {
  const lastIndex = crumbs.length - 1;

  return (
    <header
      className={["gl-strip", className].filter(Boolean).join(" ")}
      data-gl="strip"
    >
      {leading !== undefined ? <div className="gl-strip-lead">{leading}</div> : null}
      <span className="gl-strip-mark">{WORDMARK}</span>
      {crumbs.length > 0 ? (
        <nav className="gl-strip-crumbs" aria-label="Breadcrumb">
          {crumbs.map((crumb, i) => (
            // Index in the key: two segments can legitimately read the same
            // (a test named "Stats" under Stats), and a label key would then
            // drop one of them.
            <React.Fragment key={`${i}-${crumb.label}`}>
              {i > 0 ? (
                <span className="gl-strip-sep" aria-hidden="true">
                  /
                </span>
              ) : null}
              {crumb.onClick && i !== lastIndex ? (
                <button type="button" className="gl-strip-crumb" onClick={crumb.onClick}>
                  {crumb.label}
                </button>
              ) : (
                <span
                  className="gl-strip-crumb-current"
                  // Only the trailing segment is the current page. A middle
                  // segment without an `onClick` is inert, not "here".
                  aria-current={i === lastIndex ? "page" : undefined}
                  title={crumb.label}
                >
                  {crumb.label}
                </span>
              )}
            </React.Fragment>
          ))}
        </nav>
      ) : null}
      <div className="gl-strip-tail">
        {command}
        {ticker}
        {actions}
      </div>
    </header>
  );
}

export interface ChromeButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  /** Required. Every control in the strip and the rail header is icon-only. */
  label: string;
  className?: string;
}

/** An icon control sized for the strip and the rail header.
 *
 *  `aria-label` names it for assistive tech; a `Hint` says the same words on
 *  hover and on focus. It carried the label as a native `title` as well until
 *  2026-09-11, on the theory that a `title` was both testable and keyboard-
 *  reachable — it is neither on macOS under the pinned Electron, which shows
 *  one once and then rarely (electron/electron#49843, primitives/hint.tsx). */
export function ChromeButton({
  label,
  className,
  children,
  ...props
}: ChromeButtonProps): React.ReactElement {
  return (
    <Hint text={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        className={["gl-chrome-btn", className].filter(Boolean).join(" ")}
        {...props}
      >
        {children}
      </button>
    </Hint>
  );
}
