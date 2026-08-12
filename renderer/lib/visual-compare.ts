// Wipe and Blink — the two comparison techniques. REDESIGN §6.6.
//
// The five compare modes are Current, Baseline, Diff, Wipe and Blink. The first
// three answer "what does it look like now / what did it look like / where are
// the different pixels". The two added here answer the question those three
// cannot: **is this difference the one I care about?** A diff map is exact and
// nearly useless for that — it lights up every changed pixel with equal weight,
// so a font-smoothing shift and a button that moved 40px look the same. Wipe and
// Blink put the two frames in the same place instead, and let the eye do the
// comparison it is very good at.
//
// PURE HERE, RENDERED IN visual-view.tsx, because the two things worth pinning
// are decisions rather than pixels: how far the wipe divider is allowed to go,
// and what Blink does for someone who has asked their OS for less motion.

/** How long each frame is held in Blink, in ms.
 *
 *  600 is the plan's figure and it is a good one: fast enough that the two
 *  frames read as one image changing rather than two images in sequence, slow
 *  enough to see what changed. Well under 3Hz, which is the flashing threshold
 *  that matters for photosensitivity — but see `blinkIntervalMs`, because "not
 *  a seizure risk" is a much lower bar than "acceptable to show unasked". */
export const BLINK_MS = 600;

/**
 * How often Blink swaps, or `null` for "do not swap on your own".
 *
 * REDUCED MOTION TURNS IT INTO A MANUAL TOGGLE RATHER THAN TURNING IT OFF, and
 * that distinction is the whole decision. The house rule (see `resolveAtmo`) is
 * that motion which REPORTS something survives `calm` — and here the alternation
 * is not decoration on top of the information, it IS the information: blinking
 * two frames is a comparison technique, and a Blink mode that did not blink
 * would be a mode that does nothing.
 *
 * But it is also involuntary, repeating, full-frame motion, which is exactly
 * what someone turning reduced motion on is asking not to be shown. Both things
 * are true. So the capability is kept and the involuntariness is removed: the
 * user swaps the frames themselves, at their own pace, and gets the same
 * comparison. Nothing is lost except the part they asked not to have.
 */
export function blinkIntervalMs(prefersReducedMotion: boolean): number | null {
  return prefersReducedMotion ? null : BLINK_MS;
}

/**
 * The wipe divider's position, as a percentage from the left.
 *
 * CLAMPED TO A MARGIN AT BOTH ENDS, not to 0–100. A divider dragged flush to an
 * edge leaves one frame showing and no visible handle in the frame to drag it
 * back with — the control disappears into the bezel and the mode looks broken.
 * Keeping a sliver of the other side means the divider is always on screen and
 * always grabbable, and it costs nothing: at 2% there is no comparison anybody
 * was making at 0%.
 */
export const WIPE_MARGIN_PCT = 2;

export function clampWipe(pct: number): number {
  if (!Number.isFinite(pct)) return 50;
  return Math.min(100 - WIPE_MARGIN_PCT, Math.max(WIPE_MARGIN_PCT, pct));
}

/** Where a pointer at `clientX` puts the divider, given the frame's box.
 *
 *  Guarded against a zero-width box, which is not hypothetical: the frame is an
 *  image that has not loaded yet for one paint, and dividing by its width then
 *  yields Infinity — which `clampWipe` would pin to the right-hand margin,
 *  making the first drag of every session jump. */
export function wipeFromPointer(clientX: number, box: { left: number; width: number }): number {
  if (box.width <= 0) return 50;
  return clampWipe(((clientX - box.left) / box.width) * 100);
}

/** Keyboard nudge, so the divider is not mouse-only. 5% a press, 25% with
 *  shift — the same coarse/fine pairing every slider in the app uses. */
export function wipeAfterKey(current: number, key: string, shift: boolean): number | null {
  const step = shift ? 25 : 5;
  if (key === "ArrowLeft") return clampWipe(current - step);
  if (key === "ArrowRight") return clampWipe(current + step);
  if (key === "Home") return clampWipe(0);
  if (key === "End") return clampWipe(100);
  return null;
}
