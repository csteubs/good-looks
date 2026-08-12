// The redesign's theme layer.  docs/REDESIGN.md §3.
//
// One import site for everything Phase A builds, so a screen's reskin reads as
// `from "@renderer/theme"` rather than as fifteen deep paths that each have to
// be right.
//
// The CSS is NOT re-exported: tokens.css, fonts.css, atmosphere.css and
// primitives.css all come in through `renderer/styles.css`, which is the one
// stylesheet all three windows load. See the header there.

// ── Atmosphere (A2) ───────────────────────────────────────────────────
export {
  Atmosphere,
  resolveAtmo,
  usePrefersReducedMotion,
  ATMO_DEFAULT,
  GLITCH_DEFAULT,
} from "./atmosphere";
export type { AtmoLevel, GlitchMode, AtmosphereProps } from "./atmosphere";

// ── Tokens that have to exist in JavaScript (A3) ──────────────────────
export {
  TONE,
  INK,
  SEL_BG,
  SEL_RING,
  SEL_ROW,
  STATUS_W,
  LINE,
  HOLO,
  HOLO_SIZE,
  HOLO_REST,
  TONE_LINE_ALPHA,
  TONE_FILL_ALPHA,
  hexToRgb,
  mix,
  withAlpha,
  toneSurface,
  insetRail,
} from "./tokens";
export type { ToneName } from "./tokens";

// ── Shell (A4) ────────────────────────────────────────────────────────
export { TopStrip, ChromeButton, WORDMARK } from "./shell/top-strip";
export type { TopStripProps, ChromeButtonProps, Crumb } from "./shell/top-strip";
export { Rail, RailGroup, RailRow, RailEmpty } from "./shell/rail";
export type { RailProps, RailRowProps } from "./shell/rail";
export {
  BootPlate,
  bootDurationMs,
  bootFadeMs,
  resetBootPlateForTests,
  BOOT_MS,
  BOOT_MS_STILL,
  BOOT_FADE_MS,
} from "./shell/boot-plate";
export type { BootPlateProps } from "./shell/boot-plate";

// ── Primitives (A3) ───────────────────────────────────────────────────
export { Panel } from "./primitives/panel";
export type { PanelProps } from "./primitives/panel";
export { Btn } from "./primitives/btn";
export type { BtnProps, BtnTone } from "./primitives/btn";
export { StatusChip } from "./primitives/status-chip";
export type { StatusChipProps } from "./primitives/status-chip";
export { Segmented } from "./primitives/segmented";
export type { SegmentedProps, SegmentedOption } from "./primitives/segmented";
export { Temp, tempColor, formatDuration, formatDev, RAMP } from "./primitives/temp";
export type { TempProps, TempMode } from "./primitives/temp";
export { TypeChip } from "./primitives/type-chip";
export type { TypeChipProps, SyntaxTheme } from "./primitives/type-chip";
export { StepRow } from "./primitives/step-row";
export type { StepRowProps } from "./primitives/step-row";
export { Verdict } from "./primitives/verdict";
export type { VerdictProps } from "./primitives/verdict";
export { CRT } from "./primitives/crt";
export type { CRTProps } from "./primitives/crt";
export { KeyValue } from "./primitives/key-value";
export type { KeyValueProps, KeyValueRow } from "./primitives/key-value";
export { MenuItem } from "./primitives/menu-item";
export { Menu } from "./primitives/menu";
export type { MenuProps } from "./primitives/menu";
export type { MenuItemProps } from "./primitives/menu-item";
export { SiteIcon, monogramLetters, monogramHue } from "./primitives/site-icon";
export type { SiteIconProps } from "./primitives/site-icon";
export { TagStack } from "./primitives/tag-stack";
export type { TagStackProps } from "./primitives/tag-stack";
export { InsertGap } from "./primitives/insert-gap";
export type { InsertGapProps } from "./primitives/insert-gap";
