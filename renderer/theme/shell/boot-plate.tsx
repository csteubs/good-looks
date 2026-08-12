// The boot sequence. REDESIGN §6.9 — the first thing anyone sees.
//
// A full-window plate on the palette's only true black, holding the wordmark
// under the same `echo` glitch the Home screen's mark wears, over a phosphor
// rule that fills for the duration. Then it goes.
//
// THREE THINGS ABOUT IT ARE DECISIONS RATHER THAN DECORATION.
//
// 1. IT IS SKIPPABLE, on any key or any click. The plan asks for 2.6 seconds,
//    and 2.6 seconds is the right length for the thing the first time and the
//    wrong length for the two-hundredth. A splash you cannot get out of is the
//    reason splashes have a bad name; one you can is a title card. The skip is
//    not advertised — an on-screen "skip" control would make the plate look
//    like something being endured rather than shown — but it is the first thing
//    anyone tries, so it costs nothing to honour.
//
// 2. REDUCED MOTION GETS A DIFFERENT DURATION, not just a stiller plate. The
//    house rule is that `prefers-reduced-motion` clamps motion and never
//    content (see `resolveAtmo`), and stopping the animation here would leave a
//    motionless black rectangle for 2.6 seconds — which does not read as a
//    splash, it reads as a hang. So the still version is short: long enough to
//    register as a title card, too short to worry about. The plate is a
//    performance, and with the performance removed there is less to watch.
//
// 3. IT PLAYS ONCE PER WINDOW, and the flag is set when it FINISHES rather than
//    when it mounts. StrictMode mounts, unmounts and remounts in development,
//    so a flag set on mount would make the plate never appear there — the one
//    environment where it is being worked on.
//
// Not `aria-live`, and `aria-hidden` throughout: the plate says nothing the app
// does not, it holds no focusable element, and a screen reader should reach the
// application rather than a decoration in front of it.

import * as React from "react";

import { usePrefersReducedMotion } from "../atmosphere";

/** The plan's figure, and the still version's.
 *
 *  The still one is not a fraction of the other, and picking it as one would be
 *  wrong: 2.6s is how long the glitch cycle takes to be worth watching, and a
 *  plate with no glitch has no cycle. 900ms is how long a title card needs to
 *  be read. Two different questions, two numbers. */
export const BOOT_MS = 2600;
export const BOOT_MS_STILL = 900;

/** How long the plate holds. Exported and pure so the numbers are assertable
 *  without a fake clock and a mounted tree. */
export function bootDurationMs(prefersReducedMotion: boolean): number {
  return prefersReducedMotion ? BOOT_MS_STILL : BOOT_MS;
}

/** The fade. Zero under reduced motion — a cross-fade IS motion, and the whole
 *  point of the still path is that nothing moves. */
export const BOOT_FADE_MS = 320;

export function bootFadeMs(prefersReducedMotion: boolean): number {
  return prefersReducedMotion ? 0 : BOOT_FADE_MS;
}

/** Set when the plate finishes, so a hot reload does not replay it. Module
 *  scope rather than a ref: it is a fact about this WINDOW, and the component
 *  that would hold the ref is the one being remounted. */
let played = false;

/** Test seam. The plate plays once per window by design, which would make the
 *  second test in a file assert against a component that renders nothing. */
export function resetBootPlateForTests(): void {
  played = false;
}

export interface BootPlateProps {
  /** The wordmark. A prop rather than a constant so the specimen page and the
   *  tests can hold it still. */
  label?: string;
  /** Called when the plate has gone. The app is already mounted underneath —
   *  nothing waits on this — so it exists for tests and for a future caller
   *  that wants to time something against the reveal. */
  onDone?: () => void;
}

export function BootPlate({
  label = "GOOD LOOKS!",
  onDone,
}: BootPlateProps): React.ReactElement | null {
  const reduced = usePrefersReducedMotion();
  // `useState` initialiser, not an effect: a plate that mounts visible and then
  // hides on the first effect would flash on every hot reload after the first
  // play, which is exactly the case `played` exists to prevent.
  const [phase, setPhase] = React.useState<"in" | "out" | "gone">(() =>
    played ? "gone" : "in",
  );

  const hold = bootDurationMs(reduced);
  const fade = bootFadeMs(reduced);

  // TWO EFFECTS, NOT ONE, and the split is load-bearing rather than tidy. A
  // single effect that both waits out the hold and then times the fade has
  // `phase` in its dependencies — so the moment it sets `phase` to "out" it
  // re-runs, its own cleanup clears the fade timer it just set, and the plate
  // sits at zero opacity over the app forever. Everything looks correct on
  // screen for the first 2.6 seconds, which is what makes it worth writing
  // down.
  React.useEffect(() => {
    if (phase !== "in") return;

    // One path out, whether the hold expired or somebody skipped. Two exits
    // would be two chances to leave `played` unset and replay the plate.
    const leave = () => {
      played = true;
      setPhase("out");
    };

    const holdTimer = setTimeout(leave, hold);
    // `pointerdown` and `keydown`, in capture, on the window: the app beneath
    // is live and interactive already, and this must win the first input
    // without the plate having to be the thing that receives it.
    const skip = () => {
      clearTimeout(holdTimer);
      leave();
    };
    window.addEventListener("keydown", skip, { capture: true, once: true });
    window.addEventListener("pointerdown", skip, { capture: true, once: true });

    return () => {
      clearTimeout(holdTimer);
      window.removeEventListener("keydown", skip, { capture: true });
      window.removeEventListener("pointerdown", skip, { capture: true });
    };
  }, [phase, hold]);

  React.useEffect(() => {
    if (phase !== "out") return;
    const t = setTimeout(() => {
      setPhase("gone");
      onDone?.();
    }, fade);
    return () => clearTimeout(t);
  }, [phase, fade, onDone]);

  if (phase === "gone") return null;

  return (
    <div
      className="gl-boot"
      data-gl="boot"
      data-phase={phase}
      // Inert to the pointer. The app underneath is already mounted and usable,
      // and a plate that swallowed the first click would make the skip feel
      // like the app dropping input rather than like getting on with it.
      aria-hidden
      style={{ transitionDuration: `${fade}ms` }}
    >
      <div className="gl-boot-plate">
        {/* `data-text` is what the echo pseudo-elements draw. The same
            attribute contract the Home mark uses, so one glitch treatment
            serves both rather than the boot plate inventing a second. */}
        <span className="gl-boot-mark gl-echo" data-text={label}>
          {label}
        </span>
        <span className="gl-boot-sub">Playwright test recorder</span>
        {/* A rule that fills, not a spinner. A spinner claims the app is
            waiting on something; this is not waiting on anything, and saying so
            would be a lie the very first time the app speaks. Under reduced
            motion it is drawn full and still, because a bar that does not move
            is a rule. */}
        <div className="gl-boot-rule">
          <div
            className="gl-boot-rule-fill"
            style={reduced ? { width: "100%" } : { animationDuration: `${hold}ms` }}
          />
        </div>
      </div>
    </div>
  );
}
