// The boot plate. REDESIGN §6.9.
//
// Four things here would be silent if wrong, and each has a test. It never
// goes away (the app is behind it). It replays (the first thing anyone sees,
// every time they navigate). It swallows input (the app looks broken on the one
// screen where the user has no evidence it works). And under reduced motion it
// holds a motionless black rectangle for 2.6 seconds, which does not read as a
// splash — it reads as a hang.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

import {
  BOOT_FADE_MS,
  BOOT_MS,
  BOOT_MS_STILL,
  BootPlate,
  bootDurationMs,
  bootFadeMs,
  resetBootPlateForTests,
} from "./boot-plate";

const plate = () => document.querySelector('[data-gl="boot"]') as HTMLElement | null;

/** jsdom's `matchMedia` is stubbed in the dom setup; this points the
 *  reduced-motion query at a chosen answer. */
function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  resetBootPlateForTests();
  setReducedMotion(false);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the durations", () => {
  it("holds for the plan's 2.6 seconds", () => {
    expect(bootDurationMs(false)).toBe(BOOT_MS);
    expect(BOOT_MS).toBe(2600);
  });

  it("is much SHORTER under reduced motion, not merely stiller", () => {
    // The house rule clamps motion, never content — but a motionless black
    // rectangle held for 2.6s does not read as a splash, it reads as a hang.
    // With the performance removed there is less to watch, so it is shorter.
    expect(bootDurationMs(true)).toBe(BOOT_MS_STILL);
    expect(BOOT_MS_STILL).toBeLessThan(BOOT_MS / 2);
  });

  it("does not cross-fade under reduced motion, because a fade IS motion", () => {
    expect(bootFadeMs(false)).toBe(BOOT_FADE_MS);
    expect(bootFadeMs(true)).toBe(0);
  });
});

describe("the plate", () => {
  it("shows the wordmark and goes away on its own", () => {
    render(<BootPlate />);
    expect(screen.getByText("GOOD LOOKS!")).toBeTruthy();

    act(() => void vi.advanceTimersByTime(BOOT_MS));
    // Fading, not gone: the app is revealed under it rather than cut to.
    expect(plate()?.dataset.phase).toBe("out");

    act(() => void vi.advanceTimersByTime(BOOT_FADE_MS));
    expect(plate()).toBeNull();
  });

  it("goes away on any key", () => {
    render(<BootPlate />);
    // Two `act`s, not one: the skip only starts the fade, and the timer that
    // ends it is registered by the effect React runs on the NEXT commit.
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })));
    expect(plate()?.dataset.phase).toBe("out");
    act(() => void vi.advanceTimersByTime(BOOT_FADE_MS));
    expect(plate()).toBeNull();
  });

  it("goes away on any click", () => {
    render(<BootPlate />);
    // Two `act`s, not one: the skip only starts the fade, and the timer that
    // ends it is registered by the effect React runs on the NEXT commit.
    act(() => void window.dispatchEvent(new Event("pointerdown")));
    expect(plate()?.dataset.phase).toBe("out");
    act(() => void vi.advanceTimersByTime(BOOT_FADE_MS));
    expect(plate()).toBeNull();
  });

  it("does not swallow the pointer", () => {
    // The app underneath is mounted and interactive. A plate that ate the first
    // click would make the skip read as the app dropping input — on the one
    // screen where the user has no other evidence it works.
    render(<BootPlate />);
    expect(plate()?.className).toContain("gl-boot");
    // `pointer-events: none` is in the stylesheet, which the dom project does
    // not load, so this asserts the contract the stylesheet implements: the
    // plate holds nothing focusable and nothing clickable.
    expect(plate()?.querySelectorAll("button, a, input, [tabindex]").length).toBe(0);
  });

  it("is hidden from assistive technology", () => {
    // It says nothing the app does not, so a screen reader should reach the
    // application rather than a decoration in front of it.
    render(<BootPlate />);
    expect(plate()?.getAttribute("aria-hidden")).toBe("true");
  });

  it("plays ONCE per window, so navigation never brings it back", () => {
    const { unmount } = render(<BootPlate />);
    act(() => void vi.advanceTimersByTime(BOOT_MS + BOOT_FADE_MS));
    unmount();

    render(<BootPlate />);
    expect(plate()).toBeNull();
  });

  it("still plays after a mount/unmount/remount, which is what StrictMode does", () => {
    // The flag is set when the plate FINISHES, not when it mounts. Set on
    // mount, StrictMode's double-mount would make it never appear in
    // development — the one environment where it is being worked on.
    const { unmount } = render(<BootPlate />);
    unmount();
    render(<BootPlate />);
    expect(plate()).toBeTruthy();
  });

  it("calls onDone once the plate has actually gone, not when it starts leaving", () => {
    const onDone = vi.fn();
    render(<BootPlate onDone={onDone} />);
    act(() => void vi.advanceTimersByTime(BOOT_MS));
    expect(onDone).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(BOOT_FADE_MS));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("under reduced motion", () => {
  beforeEach(() => setReducedMotion(true));

  it("holds for the short beat", () => {
    render(<BootPlate />);
    act(() => void vi.advanceTimersByTime(BOOT_MS_STILL - 1));
    expect(plate()?.dataset.phase).toBe("in");
    act(() => void vi.advanceTimersByTime(1));
    expect(plate()?.dataset.phase).toBe("out");
  });

  it("draws the rule FULL and still, rather than leaving an empty groove", () => {
    // The fill is an animation, and the reduced-motion floor stops ambient
    // animations. Left to the stylesheet, a `calm` user would get a bar stuck
    // at zero width for the whole hold, which reads as stalled.
    render(<BootPlate />);
    const fill = document.querySelector(".gl-boot-rule-fill") as HTMLElement;
    expect(fill.style.width).toBe("100%");
    expect(fill.style.animationDuration).toBe("");
  });

  it("takes the fade out of the transition rather than only out of the fill", () => {
    render(<BootPlate />);
    expect(plate()?.style.transitionDuration).toBe("0ms");
  });
});

describe("with motion", () => {
  it("times the fill to the hold, so the rule lands exactly as the plate leaves", () => {
    render(<BootPlate />);
    const fill = document.querySelector(".gl-boot-rule-fill") as HTMLElement;
    expect(fill.style.animationDuration).toBe(`${BOOT_MS}ms`);
    expect(fill.style.width).toBe("");
  });
});
