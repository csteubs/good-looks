// ToolTile — the trainer action bar's tile (Direction A of the 2026-09-01
// reorganisation; REDESIGN §B6's "mark, name, and what it does", adapted).
//
// One control, two postures, and the FOLD IS THE CONTAINER'S CHOICE. Folded it
// is a compact strip item — mark, name, caret — the steady state for the
// hundredth session, and the only posture the 360px docked panel ever shows.
// Unfolded it grows a one-line "what it does", the posture that teaches.
// `folded` is a prop the strip passes to every tile at once rather than
// per-tile state, because a strip where one tile is tall re-introduces exactly
// the mid-reach reflow the tile architecture exists to end.
//
// The strip the tiles sit in NEVER changes membership: four tiles, mounted in
// every session state and disabled-gated, never render-gated. Transients live
// in the reserved context band beneath (`.gl-trainer-context` /
// `.gl-panelwin-context` in screens.css), so nothing here moves while the
// user is reaching for it.
//
// `tone="ai"` wears the Btn's holo border for the same reason Btn's does: AI
// is not an outcome, so it takes a treatment, never a colour (tokens.css).
// The caret is drawn inline rather than imported — primitives stay
// dependency-free, and this chevron is the only glyph the tile itself owns;
// the mark is the CALLER's glyph, because which icon means "assert" is the
// view's vocabulary (and its glyph-uniqueness test's subject), not the
// primitive's.

import * as React from "react";

export interface ToolTileProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** The tile's glyph. Sized by the stylesheet the way Btn sizes its icons. */
  mark: React.ReactNode;
  name: string;
  /** One line of "what it does" — visible unfolded, the hover title folded. */
  what?: string;
  folded?: boolean;
  /** True for a tile that opens a menu. */
  caret?: boolean;
  tone?: "ai";
}

export function ToolTile({
  mark,
  name,
  what,
  folded,
  caret,
  tone,
  className,
  type,
  title,
  ...rest
}: ToolTileProps): React.ReactElement {
  return (
    <button
      // Explicitly `button`, for Btn's reason: the HTML default is `submit`.
      type={type ?? "button"}
      className={[
        "gl-tooltile",
        folded ? "gl-tooltile-folded" : null,
        tone === "ai" ? "gl-tooltile-ai" : null,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-gl="tooltile"
      data-tone={tone}
      // Folded hides the "what" line, so it moves to the title — the same
      // sentence, one hover away rather than gone.
      title={title ?? (folded ? what : undefined)}
      {...rest}
    >
      <span className="gl-tooltile-mark" aria-hidden>
        {mark}
      </span>
      <span className="gl-tooltile-name">{name}</span>
      {!folded && what ? <span className="gl-tooltile-what">{what}</span> : null}
      {caret ? (
        <svg
          className="gl-tooltile-caret"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      ) : null}
    </button>
  );
}
