// ShotHighlight — a step screenshot with the element highlighted, the
// trainer's refine-box idiom (capture-script.ts: border, soft halo, a label
// pill riding the top edge) re-drawn over a SCREENSHOT in the theme's own
// vocabulary. Built for propagation's evidence pane (preemptive-updates
// §2.9), where the healed element is the whole point of the picture.
//
// The rect is NORMALIZED 0-1 OF THE IMAGE — the one convention
// `ElementFingerprint.rect`, the capture manifest and the heal journal share
// — so the overlay scales with the rendered figure and never with the
// viewport. Two visual claims, deliberately distinct: a MEASURED box (solid,
// spotlit) is where the element was seen; an APPROXIMATE one (dashed, no
// spotlight) is where the recorder remembered it, and the two must never
// read as the same statement. No rect renders the bare shot; no shot is the
// CALLER's case to omit — this component never draws an empty frame.
//
// Motion is decoration only: a one-shot settle pulse on reveal draws the eye
// to the changed element, `prefers-reduced-motion` renders the box static
// and full (the boot-plate house rule — clamp motion, never delete
// information), and position/size never animate, because a box easing toward
// its rect briefly draws a geometry claim that is not true.

import * as React from "react";

export interface ShotHighlightRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ShotHighlightProps {
  /** The screenshot, as the data URL `artifacts:readShot` serves. */
  shot: string;
  /** Viewport-normalized (0-1) box to highlight; absent renders the bare shot. */
  rect?: ShotHighlightRect;
  /** True when the rect is a record-time memory rather than a measurement —
   *  drawn dashed, without the spotlight, a visibly weaker claim. */
  approximate?: boolean;
  /** Short text for the pill riding the box — usually the locator's spelling. */
  label?: string;
  /** One line under the figure saying which shot this is. */
  caption?: string;
  alt?: string;
}

/** The overlay's geometry, as percentages of the image box. Exported so the
 *  math is testable without a layout engine: jsdom cannot measure the figure,
 *  but it can prove a normalized rect becomes these four strings. */
export function shotHighlightBox(rect: ShotHighlightRect): React.CSSProperties {
  const pct = (n: number): string => `${Math.min(100, Math.max(0, n * 100))}%`;
  return {
    left: pct(rect.x),
    top: pct(rect.y),
    width: pct(rect.w),
    height: pct(rect.h),
  };
}

export function ShotHighlight({
  shot,
  rect,
  approximate,
  label,
  caption,
  alt,
}: ShotHighlightProps): React.ReactElement {
  return (
    <figure className="gl-shothl" data-gl="shothl">
      <div className="gl-shothl-stage">
        <img className="gl-shothl-img" src={shot} alt={alt ?? ""} />
        {rect ? (
          <div
            className={["gl-shothl-box", approximate ? "gl-shothl-box-approx" : null]
              .filter(Boolean)
              .join(" ")}
            style={shotHighlightBox(rect)}
            data-approximate={approximate ? "" : undefined}
            aria-hidden
          >
            {label ? <span className="gl-shothl-tag">{label}</span> : null}
          </div>
        ) : null}
      </div>
      {caption ? <figcaption className="gl-shothl-caption">{caption}</figcaption> : null}
    </figure>
  );
}
