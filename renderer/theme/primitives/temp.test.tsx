import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { Temp, tempColor, formatDuration, formatDev, RAMP } from "./temp";
import { INK, TONE, hexToRgb } from "../tokens";

/** The alpha channel of an `rgba()` string, or 1 for an `rgb()`/hex. */
function alphaOf(c: string): number {
  return Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(c)?.[1] ?? "1");
}

/** RGB channels from either form. `tempColor` returns `rgba()` (it interpolates)
 *  while the TONE constants it interpolates TOWARD are hex, so a comparison
 *  between the two has to normalise or it is comparing notations. */
function channels(c: string): { r: number; g: number; b: number } {
  const hex = hexToRgb(c);
  if (hex) return { r: hex[0], g: hex[1], b: hex[2] };
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (!m) throw new Error(`not a colour: ${c}`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

describe("tempColor — the ramp", () => {
  it("is dead in the middle, which is the whole design", () => {
    // A table where every row is lit says nothing. Anything inside ±10% must
    // come back EXACTLY neutral, not nearly neutral — "nearly" over forty rows
    // is a table that shimmers.
    for (const dev of [0, 0.05, -0.05, 0.099, -0.099]) {
      expect(tempColor(dev)).toBe(INK.neutral);
    }
  });

  it("is continuous at both seams", () => {
    // A step in the ramp means one millisecond of difference flips a colour,
    // and a reader learns to distrust the whole column.
    const eps = 1e-9;
    expect(channels(tempColor(-RAMP.dead))).toEqual(channels(INK.neutral));
    expect(channels(tempColor(RAMP.dead))).toEqual(channels(INK.neutral));
    const justUnderHot = channels(tempColor(RAMP.hot - eps));
    const atHot = channels(tempColor(RAMP.hot));
    expect(justUnderHot).toEqual(atHot);
    expect(atHot).toEqual(channels(TONE.amber));
  });

  it("goes green for faster, saturating 25% past the dead band", () => {
    const [r] = hexToRgb(TONE.phos) as [number, number, number];
    expect(channels(tempColor(-(RAMP.dead + RAMP.fastSpan))).r).toBe(r);
    // ...and stays there. Ten times faster is not ten times greener.
    expect(channels(tempColor(-5)).r).toBe(r);
  });

  it("goes amber then red for slower, saturating at double the median", () => {
    expect(channels(tempColor(RAMP.hot))).toEqual(channels(TONE.amber));
    expect(channels(tempColor(1))).toEqual(channels(TONE.red));
    expect(channels(tempColor(50))).toEqual(channels(TONE.red));
  });

  it("mixes alpha along with the hue", () => {
    // Neutral is 62% alpha and the status hues are opaque. A mixer that only
    // touched RGB would make the first lit step jump to full opacity — a
    // visible cliff exactly where the ramp is supposed to be gentlest.
    expect(alphaOf(INK.neutral)).toBeLessThan(1);
    expect(alphaOf(tempColor(0.15))).toBeGreaterThan(alphaOf(INK.neutral));
    expect(alphaOf(tempColor(-5))).toBe(1);
  });
});

describe("formatDuration", () => {
  it("stops at three significant-ish figures", () => {
    // Extra digits imply a repeatability these timings do not have: a test that
    // ran in 1234ms will run in 1198ms next time and nothing has changed.
    expect(formatDuration(340)).toBe("340ms");
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(22_400)).toBe("22s");
  });

  it("renders a dash rather than NaN for a missing timing", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("formatDev", () => {
  it("uses a real minus sign", () => {
    // At 9px in a mono face a hyphen sits too high and too short to read as a
    // sign, and "7%" and "-7%" are opposite claims.
    expect(formatDev(-0.07)).toBe("−7%");
    expect(formatDev(0.18)).toBe("+18%");
    expect(formatDev(0)).toBe("0%");
  });
});

describe("<Temp />", () => {
  it("falls to off with no median, and does not colour a guess", () => {
    // THE IMPORTANT ONE. A fabricated median would colour every row on a young
    // history, confidently and wrongly. Real medians arrive in Phase C; until
    // then this is the current behaviour rendered honestly.
    for (const median of [undefined, null, 0, Number.NaN]) {
      const { container, unmount } = render(<Temp ms={1200} median={median} mode="tint" />);
      const el = container.querySelector('[data-gl="temp"]') as HTMLElement;
      expect(el.dataset.mode).toBe("off");
      unmount();
    }
  });

  it("renders the duration whatever the mode", () => {
    for (const mode of ["tint", "rule", "bar", "delta", "halo", "off"] as const) {
      const { unmount } = render(<Temp ms={1200} median={1000} mode={mode} />);
      expect(screen.getByText("1.2s")).toBeTruthy();
      unmount();
    }
  });

  it("tints the number itself in tint mode", () => {
    const { container } = render(<Temp ms={1500} median={1000} mode="tint" />);
    const value = container.querySelector(".gl-temp-value") as HTMLElement;
    expect(value.style.color).not.toBe("");
    expect(channels(value.style.color)).toEqual(channels(tempColor(0.5)));
  });

  it("leaves the number neutral in bar mode, because the bar carries the reading", () => {
    const { container } = render(<Temp ms={1500} median={1000} mode="bar" />);
    const value = container.querySelector(".gl-temp-value") as HTMLElement;
    expect(channels(value.style.color)).toEqual(channels(INK.neutral));
    expect(container.querySelector(".gl-temp-bar-fill")).not.toBeNull();
  });

  it("clamps the bar at ±100%", () => {
    // A step that took eight times its median is not eight times more
    // interesting than one that took twice — and an unclamped bar would flatten
    // every other row in the column to nothing.
    const { container } = render(<Temp ms={9000} median={1000} mode="bar" />);
    expect((container.querySelector(".gl-temp-bar-fill") as HTMLElement).style.width).toBe("100%");
  });

  it("shows the signed percentage in delta mode, and nothing at zero", () => {
    const { container, rerender } = render(<Temp ms={1180} median={1000} mode="delta" />);
    expect(screen.getByText("+18%")).toBeTruthy();

    rerender(<Temp ms={1000} median={1000} mode="delta" />);
    expect(container.querySelector(".gl-temp-delta")).toBeNull();
  });

  it("always carries the full reading in a title, however it is presented", () => {
    // `bar` and `halo` say "unusual" without saying how much, and someone
    // writing up a regression needs the number.
    const { container } = render(<Temp ms={1500} median={1000} mode="halo" />);
    expect((container.querySelector('[data-gl="temp"]') as HTMLElement).title).toBe(
      "1.5s · +50% vs median",
    );
  });

  it("says only the duration when there is nothing to compare against", () => {
    const { container } = render(<Temp ms={1500} mode="tint" />);
    expect((container.querySelector('[data-gl="temp"]') as HTMLElement).title).toBe("1.5s");
  });
});
