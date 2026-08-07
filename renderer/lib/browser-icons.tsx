// Browser-engine iconography — the one place that decides what Chromium,
// Firefox and WebKit look like.
//
// Two representations, because the app draws browsers on two different
// surfaces and they cannot share a renderer:
//
//  - `BrowserIcon` (lucide) for anything in the DOM — Select triggers, the
//    Stats run table, the sidebar accessory.
//  - `BROWSER_SF_SYMBOLS` for the SDK's native `Select`, whose options are
//    drawn by AppKit and never enter the DOM. A React node passed there would
//    be silently dropped, so those items take an SF Symbol name instead.
//
// Keeping both maps here means a fourth engine is one edit, and the two
// surfaces can't drift into disagreeing about which glyph means Firefox.

import { Chrome, Compass, Flame, type LucideIcon } from "lucide-react";

import { RUN_BROWSER_LABELS, type RunBrowser } from "./recorder-types";

/** DOM glyphs. Deliberately lucide rather than brand logos: these sit inline
 *  with the app's other stroke icons at 12–16px, where a filled multicolour
 *  logo reads as a smudge. WebKit gets the compass (Safari's engine, but not
 *  Safari), Firefox the flame, Chromium the Chrome mark. */
export const BROWSER_ICONS: Record<RunBrowser, LucideIcon> = {
  chromium: Chrome,
  firefox: Flame,
  webkit: Compass,
};

/** Native-menu glyphs for `SelectItem icon`. SF Symbol names, matched to the
 *  lucide shapes above as closely as the system set allows. */
export const BROWSER_SF_SYMBOLS: Record<RunBrowser, string> = {
  chromium: "globe",
  firefox: "flame",
  webkit: "safari",
};

export interface BrowserIconProps {
  browser: RunBrowser;
  className?: string;
  /** Set false where the engine name is already adjacent in text, so a screen
   *  reader doesn't read "Firefox Firefox". Icon-only usages must leave it on. */
  labelled?: boolean;
}

/**
 * The engine's glyph. Carries its own accessible name by default — the Stats
 * column and the sidebar accessory show this with no adjacent text, so without
 * a label they'd be empty to a screen reader (and unassertable in jsdom, where
 * an SVG path is the only other thing to match on). `title` gives the same
 * name to a mouse hover.
 */
export function BrowserIcon({ browser, className, labelled = true }: BrowserIconProps) {
  const Icon = BROWSER_ICONS[browser];
  const label = RUN_BROWSER_LABELS[browser];
  if (!labelled) {
    // No accessible name by design, so `data-browser` is the only handle a
    // test has on which glyph rendered — and the Select triggers are exactly
    // where a wrong glyph would go unnoticed.
    return <Icon className={className ?? "size-3.5 shrink-0"} data-browser={browser} aria-hidden />;
  }
  return (
    <Icon
      className={className ?? "size-3.5 shrink-0"}
      data-browser={browser}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
    </Icon>
  );
}
