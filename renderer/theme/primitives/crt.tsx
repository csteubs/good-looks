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
   *  applies: whatever goes in here is shown untouched.
   *
   *  IT IS POSITIONED AGAINST THE IMAGE, NOT AGAINST THE SCREEN. Everything
   *  callers put here is an annotation of the frame — a mask, an element
   *  outline, a measured region — and every one of them is stored in
   *  normalized (0–1) coordinates, so "50% down" has to mean half way down the
   *  PICTURE. The screen is a scroll viewport (a full-page screenshot is
   *  routinely three times its height), so positioning against it silently
   *  drifts by however much the frame overflows, which is most of it. */
  children?: React.ReactNode;
  className?: string;
}

export function CRT({ src, alt, caption, children, className }: CRTProps): React.ReactElement {
  return (
    <figure className={["gl-crt", className].filter(Boolean).join(" ")} data-gl="crt">
      <div className="gl-crt-screen" data-gl-crt-screen>
        {/* The one box that is exactly the image. See `children` above: it is
            what makes a normalized overlay land where it says it does, and it
            scrolls with the frame rather than floating over the viewport. */}
        <div className="gl-crt-plate">
          {src !== undefined ? (
            <img className="gl-crt-img" src={src} alt={alt ?? ""} draggable={false} />
          ) : null}
          {children}
        </div>
      </div>
      {caption !== undefined ? (
        <figcaption className="gl-crt-caption">{caption}</figcaption>
      ) : null}
    </figure>
  );
}
