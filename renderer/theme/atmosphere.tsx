// The global atmosphere: three fixed overlay layers, the `data-atmo` /
// `data-glitch` roots, and the reduced-motion floor.  docs/REDESIGN.md §3.6.
//
// NOTHING MOUNTS THIS YET, and that is the plan (REDESIGN §4, A2): "lands with
// the app still looking exactly as it does — the overlays default off until
// A4". The vocabulary, the resolver and the guards ship first so that the
// shell PR is about layout rather than about inventing this at the same time.
//
// The one idea here worth reading before changing anything:
//
//   MOTION THAT REPORTS SOMETHING IS NOT DECORATION.
//
// A running step pulses because it is running. That is data, drawn in time
// instead of in ink, and it survives `calm` for the same reason a status colour
// survives it. Only `still` stops it, and only because someone asked.
//
// The corresponding accessibility rule is the one the mockup does not state and
// this file adds: `prefers-reduced-motion: reduce` FORCES `calm` AS A FLOOR.
// Someone who has told their OS they want less motion should not then have to
// find a setting in this app. The clamp is one-directional — it can make the
// app quieter, never louder — so `still` is left alone.

// The stylesheet is NOT imported here. It comes in through `renderer/styles.css`
// alongside tokens.css and fonts.css, for two reasons: the motion floor has to
// be in force before React mounts (see the `@media` backstop in atmosphere.css),
// and one entry point is what makes `check:theme-tokens` able to prove the whole
// theme layer actually reaches the emitted bundle.
import * as React from "react";
import { createPortal } from "react-dom";

/** How much of the app is allowed to move. */
export type AtmoLevel = "alive" | "calm" | "still";

/** The glitch treatment. Fixed at `echo` (ghosting) per REDESIGN §0 — it is a
 *  default, not a setting, so this type exists to make "off" expressible for
 *  tests and for the boot sequence rather than to be exposed in Settings. */
export type GlitchMode = "echo" | "off";

/** The shipped defaults, in full, from REDESIGN §0. Exported because the
 *  Appearance pane (A4) has to state them and a test has to pin them; a
 *  default that is written down in two places drifts in one of them. */
export const ATMO_DEFAULT: AtmoLevel = "calm";
export const GLITCH_DEFAULT: GlitchMode = "echo";

/**
 * The effective motion level, given what the user asked this app for and what
 * they have already asked the OS for.
 *
 * The clamp is deliberately asymmetric. `alive` is the only level reduced
 * motion overrides, because it is the only one that is louder than the floor:
 *
 *   alive + reduce  →  calm    the floor, applied
 *   calm  + reduce  →  calm    already there
 *   still + reduce  →  still   quieter than the floor, and theirs to keep
 *
 * Callers should render from THIS value and never from the requested one, so
 * that `data-atmo` on the root always names what is actually happening. A
 * settings pane reading the requested value would tell someone their app is
 * `alive` while it is visibly not.
 */
export function resolveAtmo(requested: AtmoLevel, prefersReducedMotion: boolean): AtmoLevel {
  if (prefersReducedMotion && requested === "alive") return "calm";
  return requested;
}

/** The OS-level reduced-motion preference, live.
 *
 *  `useSyncExternalStore` rather than `useState` + `useEffect` so the FIRST
 *  render already has the right answer. With an effect, the first paint runs at
 *  the requested level and only then drops to the floor — which means the one
 *  frame someone with motion sensitivity sees is the animated one.
 *
 *  Guarded for a missing `matchMedia`: the trainer window and the jsdom suite
 *  do not always have one, and a bare throw here would take down whatever it is
 *  wrapped in rather than degrading to "no preference stated". */
export function usePrefersReducedMotion(): boolean {
  const subscribe = React.useCallback((onChange: () => void) => {
    const mql = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mql?.addEventListener) return () => {};
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const getSnapshot = React.useCallback(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    [],
  );

  return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export interface AtmosphereProps {
  /** What the user asked for. Clamped by the reduced-motion floor before use. */
  level?: AtmoLevel;
  /** The CRT scanline overlay. A real setting, off by default (REDESIGN §0) —
   *  it is the one layer here that costs legibility, so it is opt-in. */
  crt?: boolean;
  /** Fixed at the design's default; a prop so the boot sequence and tests can
   *  turn it off without reaching into the DOM. */
  glitch?: GlitchMode;
}

/**
 * Mount once, near the root.
 *
 * PORTALLED TO `document.body`, not rendered in place. Every layer below is
 * `position: fixed`, and a fixed element inside an ancestor carrying
 * `transform`, `filter` or `backdrop-filter` positions against THAT ancestor
 * instead of the viewport — which is not a hypothetical here, since the glitch
 * and texture treatments this design is built on are exactly those properties.
 * The failure would be a vignette that covers one panel instead of the window,
 * and it would only appear on the screens that got reskinned last.
 */
export function Atmosphere({
  level = ATMO_DEFAULT,
  crt = false,
  glitch = GLITCH_DEFAULT,
}: AtmosphereProps): React.ReactNode {
  const reduced = usePrefersReducedMotion();
  const effective = resolveAtmo(level, reduced);

  // The roots. These are read by atmosphere.css and by nothing else — the
  // component does not branch on them, so the attribute and the rendering can
  // never disagree about what level is in force.
  React.useEffect(() => {
    const root = document.documentElement;
    root.dataset.atmo = effective;
    root.dataset.glitch = glitch;
    return () => {
      delete root.dataset.atmo;
      delete root.dataset.glitch;
    };
  }, [effective, glitch]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      {/* Order is back-to-front: grain sits on the app, vignette on the grain,
          scanlines on everything. Scanlines last because they are the only
          layer that is a deliberate artefact rather than a texture. */}
      <div className="gl-atmo-layer gl-atmo-grain" aria-hidden data-gl-atmo="grain" />
      <div className="gl-atmo-layer gl-atmo-vignette" aria-hidden data-gl-atmo="vignette" />
      {crt ? (
        <div className="gl-atmo-layer gl-atmo-scanlines" aria-hidden data-gl-atmo="scanlines" />
      ) : null}
    </>,
    document.body,
  );
}
