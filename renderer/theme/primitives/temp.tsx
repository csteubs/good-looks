// Temp — change temp. The one genuinely new information design in the
// redesign (docs/REDESIGN.md §3.4), and the only primitive here that is making
// a claim rather than drawing a shape.
//
// A DURATION ON ITS OWN IS NOT INFORMATION. 22s is fine for one test and a
// regression in another, and a table of raw milliseconds asks every reader to
// remember what normal looked like. `Temp` reads a timing against THAT TEST'S
// OWN MEDIAN and colours the deviation, so the number answers "is this
// unusual?" instead of "how long did it take?".
//
// THE RAMP IS DELIBERATELY DEAD IN THE MIDDLE. Nothing colours until ±10%,
// because a table where every row is lit says nothing at all — the eye has no
// way to pick the one row that matters out of forty that are all faintly amber.
// The dead band is the feature, not a tolerance for imprecision.
//
// AND IT REFUSES TO GUESS. With no median there is no deviation, so the mode
// falls to `off` and the number renders neutral — the current behaviour,
// rendered honestly. That is not a degraded state to be fixed at the call site
// with a default of zero: a fabricated median would colour every row on a young
// history and the colours would be confident and wrong. Real medians come from
// `metrics-store` in Phase C (§6.3).

import * as React from "react";

import { INK, TONE, mix } from "../tokens";

export type TempMode = "tint" | "rule" | "bar" | "delta" | "halo" | "off";

/** Where the ramp turns. Named, because these five numbers ARE the design and a
 *  reader should not have to reverse them out of the arithmetic. */
export const RAMP = {
  /** Nothing colours inside ±10%. */
  dead: 0.1,
  /** ...and 25% faster than that is as green as it gets. */
  fastSpan: 0.25,
  /** 10% → 40% slower ramps neutral to amber. */
  warmSpan: 0.3,
  /** 40% → 100% slower ramps amber to red, saturating at double. */
  hotSpan: 0.6,
  hot: 0.4,
} as const;

/**
 * The colour for a deviation, where `dev` is `(ms - median) / median`.
 *
 * Continuous at both seams by construction: at exactly ±0.10 and at exactly
 * +0.40 the two adjacent branches agree, so there is no step in the ramp where
 * one pixel of difference flips a colour.
 */
export function tempColor(dev: number): string {
  if (dev <= -RAMP.dead) {
    return mix(INK.neutral, TONE.phos, (-RAMP.dead - dev) / RAMP.fastSpan);
  }
  if (dev >= RAMP.hot) {
    return mix(TONE.amber, TONE.red, (dev - RAMP.hot) / RAMP.hotSpan);
  }
  if (dev >= RAMP.dead) {
    return mix(INK.neutral, TONE.amber, (dev - RAMP.dead) / RAMP.warmSpan);
  }
  return INK.neutral;
}

/**
 * A duration, at the precision a reader can actually use.
 *
 * Three significant-ish figures and no more: `1.2s`, not `1234ms`. The extra
 * digits are noise in a column being scanned, and — the part that matters —
 * they imply a repeatability these timings do not have. A test that ran in
 * 1234ms will run in 1198ms next time and nothing has changed.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/** `+18%` / `−7%`. A real minus sign, not a hyphen: at 9px in a mono face a
 *  hyphen sits too high and too short to read as a sign. */
export function formatDev(dev: number): string {
  const pct = Math.round(dev * 100);
  if (pct === 0) return "0%";
  return pct > 0 ? `+${pct}%` : `−${Math.abs(pct)}%`;
}

export interface TempProps {
  /** This run's duration. */
  ms: number;
  /** THIS TEST'S OWN median. Absent, zero or non-finite means there is nothing
   *  to compare against, and the whole thing falls to `off`. */
  median?: number | null;
  /** How to present the deviation. A shipped setting, not a knob, because it
   *  changes what the number tells you. */
  mode?: TempMode;
  title?: string;
}

export function Temp({ ms, median, mode = "tint", title }: TempProps): React.ReactElement {
  const comparable = typeof median === "number" && Number.isFinite(median) && median > 0;
  // The mode falls to `off` rather than the caller having to check. Every call
  // site would otherwise repeat this, and the one that forgot would render a
  // confident colour derived from a median of zero.
  const effective: TempMode = comparable ? mode : "off";
  const dev = comparable ? (ms - median) / median : 0;
  const color = effective === "off" ? INK.neutral : tempColor(dev);
  const value = formatDuration(ms);

  return (
    <span
      className="gl-temp"
      data-gl="temp"
      data-mode={effective}
      // The full sentence, always available, whatever the presentation. `bar`
      // and `halo` say "unusual" without saying how much, and someone reading a
      // regression report needs the number.
      title={title ?? (comparable ? `${value} · ${formatDev(dev)} vs median` : value)}
    >
      <span
        className="gl-temp-value"
        style={{
          color: effective === "bar" ? INK.neutral : color,
          ...(effective === "halo" ? { textShadow: `0 0 7px ${color}` } : null),
        }}
      >
        {value}
      </span>

      {effective === "delta" && dev !== 0 ? (
        <span className="gl-temp-delta" style={{ color }}>
          {formatDev(dev)}
        </span>
      ) : null}

      {effective === "rule" ? (
        <span className="gl-temp-rule" style={{ background: color }} aria-hidden />
      ) : null}

      {effective === "bar" ? (
        <span className="gl-temp-bar" aria-hidden>
          <span
            className="gl-temp-bar-fill"
            style={{
              background: color,
              // Clamped at ±100%: a step that took eight times its median is
              // not eight times more interesting than one that took twice, and
              // an unclamped bar would flatten every other row to nothing.
              width: `${Math.min(1, Math.abs(dev)) * 100}%`,
            }}
          />
        </span>
      ) : null}
    </span>
  );
}
