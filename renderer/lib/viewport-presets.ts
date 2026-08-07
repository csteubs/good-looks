// The window/viewport sizes offered anywhere the user picks one: the New
// Recording dialog (the size the trainer window opens at, and the size the
// recording replays at), the Generate-from-prompt dialog (the size the model is
// told to write into the spec), and both "+ Add step → Set viewport" pickers
// (the trainer's and the test detail view's).
//
// One list, because they all answer the same question — a size offered by one
// and missing from another reads as a bug in whichever is shorter. The two
// Add-step dialogs each carried their own copy of it until 2026-08-06, which is
// exactly how that drift starts.

export interface ViewportPreset {
  id: string;
  label: string;
  /** 0 for "Default" — no size is chosen, the caller keeps its own default. */
  w: number;
  h: number;
}

export const VIEWPORT_PRESETS: readonly ViewportPreset[] = [
  { id: "default", label: "Default", w: 0, h: 0 },
  { id: "desktop", label: "Desktop 1280×800", w: 1280, h: 800 },
  { id: "laptop", label: "Laptop 1440×900", w: 1440, h: 900 },
  { id: "tablet", label: "Tablet 768×1024", w: 768, h: 1024 },
  { id: "mobile", label: "Mobile 390×844", w: 390, h: 844 },
];

export const DEFAULT_VIEWPORT_PRESET_ID = "default";

/**
 * The presets a `viewport` STEP can use — everything except "Default".
 *
 * "Default" means "don't choose a size", which is a coherent answer for a
 * dialog asking what size to open a window at and a meaningless one for a step
 * whose entire job is to resize to something. Offering it there would produce a
 * step that resizes to 0×0.
 */
export const RESIZE_PRESETS: readonly ViewportPreset[] = VIEWPORT_PRESETS.filter((p) => p.w > 0);

/** Bounds on a hand-typed custom size. MIRRORS `MIN_VIEWPORT`/`MAX_VIEWPORT` in
 *  main/recorder/window-size.ts, which is the authority — the backend clamps
 *  again on the way in. This copy exists so the dialog can't hand over a size
 *  that will be silently rewritten, which reads as the app ignoring the input. */
export const MIN_STEP_VIEWPORT = 200;
export const MAX_STEP_VIEWPORT = 4000;

/**
 * A typed width/height into a usable number.
 *
 * Takes the raw string because that's what an `<input type="number">` holds:
 * it can be empty, `"-"` mid-typing, or `"1e9"`. Anything unusable falls back
 * to `fallback` rather than to 0 — a resize to 0 is not a size, and the step
 * would generate a spec Playwright rejects at run time.
 */
export function clampViewportAxis(raw: string, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_STEP_VIEWPORT, Math.max(MIN_STEP_VIEWPORT, Math.round(n)));
}

/** The size a preset id means, or null for "Default"/an unknown id. */
export function viewportForPresetId(id: string): { width: number; height: number } | null {
  const preset = VIEWPORT_PRESETS.find((p) => p.id === id);
  if (!preset || preset.w === 0) return null;
  return { width: preset.w, height: preset.h };
}

/**
 * The preset id for a stored size, for restoring a picker's selection.
 *
 * A size that matches no preset (a settings file written by hand, or a preset
 * dropped from the list in a later version) falls back to "Default" — the
 * picker then shows a value it can actually offer, rather than a blank trigger.
 */
export function presetIdForViewport(size: { width: number; height: number } | null): string {
  if (!size) return DEFAULT_VIEWPORT_PRESET_ID;
  const match = VIEWPORT_PRESETS.find((p) => p.w === size.width && p.h === size.height);
  return match ? match.id : DEFAULT_VIEWPORT_PRESET_ID;
}
