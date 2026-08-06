// The window/viewport sizes offered anywhere the user picks one: the New
// Recording dialog (the size the trainer window opens at, and the size the
// recording replays at) and the Generate-from-prompt dialog (the size the
// model is told to write into the spec).
//
// One list, because the two dialogs answer the same question — a size offered
// by one and missing from the other reads as a bug in whichever is shorter.

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
