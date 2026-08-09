// The redesign's theme layer.  docs/REDESIGN.md §3.
//
// One import site for everything Phase A builds, so a screen's reskin reads as
// `from "@renderer/theme"` rather than as five deep paths that each have to be
// right. The primitives (A3) re-export through here too.
//
// The CSS is NOT re-exported: tokens.css, fonts.css and atmosphere.css all come
// in through `renderer/styles.css`, which is the one stylesheet all three
// windows load. See the header there.

export {
  Atmosphere,
  resolveAtmo,
  usePrefersReducedMotion,
  ATMO_DEFAULT,
  GLITCH_DEFAULT,
} from "./atmosphere";
export type { AtmoLevel, GlitchMode, AtmosphereProps } from "./atmosphere";
