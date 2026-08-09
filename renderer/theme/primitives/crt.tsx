// CRT — the bezel a captured frame is shown in.
//
// THE CONTENT INSIDE IS NEVER TREATED. No scanlines, no grain, no vignette, no
// tint, no filter. This is the one rule in the whole design system that is
// about correctness rather than taste, and it is worth stating plainly:
//
//   A SCREENSHOT THE USER IS BEING ASKED TO JUDGE MUST READ EXACTLY AS THE
//   BROWSER RENDERED IT.
//
// Everything this app shows in a CRT is evidence — a visual diff, a baseline, a
// failure frame. The entire question being asked is "does this look right?",
// and an amber cast from our own chrome is indistinguishable from an amber cast
// in the page under test. A user would file the bug against their own site.
//
// That is why the bezel sits at z-index 610, ABOVE the global atmosphere layers
// at 600 (see tokens.css). The overlays are fixed and full-viewport, so
// anything below them is tinted by definition; lifting the CRT out is the only
// way its content escapes. `check:crt-untreated` pins that nothing here gains a
// filter, blend mode, or overlay later.
//
// The bezel itself is ours to style, and does: hairline frame, black backing,
// a caption below. Only what is INSIDE the screen is sacred.

import * as React from "react";

export interface CRTProps {
  /** The captured frame. */
  src?: string;
  /** Required when `src` is given — this is evidence, and evidence that cannot
   *  be described is unusable to anyone reading with a screen reader. */
  alt?: string;
  /** What this frame IS: which run, which viewport, which engine. */
  caption?: React.ReactNode;
  /** An arbitrary frame — a canvas, a diff layer, a stack of masks. Same rule
   *  applies: whatever goes in here is shown untouched. */
  children?: React.ReactNode;
  className?: string;
}

export function CRT({ src, alt, caption, children, className }: CRTProps): React.ReactElement {
  return (
    <figure className={["gl-crt", className].filter(Boolean).join(" ")} data-gl="crt">
      <div className="gl-crt-screen" data-gl-crt-screen>
        {src !== undefined ? (
          <img className="gl-crt-img" src={src} alt={alt ?? ""} draggable={false} />
        ) : null}
        {children}
      </div>
      {caption !== undefined ? (
        <figcaption className="gl-crt-caption">{caption}</figcaption>
      ) : null}
    </figure>
  );
}
