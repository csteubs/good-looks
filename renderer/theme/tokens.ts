// The tokens the primitives need in JavaScript, not just in CSS.
//
// MOST OF THE THEME BELONGS IN tokens.css AND SHOULD STAY THERE. This file is
// the narrow set that a `var()` genuinely cannot express, and it is deliberately
// small — every value here is a second copy of something, and a second copy is a
// thing that drifts.
//
// Three reasons a value ends up here:
//
//  1. IT GETS CONCATENATED. `StatusChip` draws `tone + "55"` over `tone + "12"`
//     — one hue, two alphas, derived rather than declared, which is what keeps
//     a new status from needing three new tokens. CSS cannot append to the
//     result of `var()`, so the chip needs the hex itself. (`color-mix()` could
//     do it in a modern engine, but it computes to `rgba()` that jsdom cannot
//     read back, which would put the chip's whole contract out of reach of a
//     test.)
//  2. IT GETS INTERPOLATED. `Temp` mixes along a ramp per row (§3.4). That is
//     arithmetic on a colour, and arithmetic belongs in a function that can be
//     given a number and asserted on.
//  3. IT IS A LAYOUT CONTRACT A CHECK HAS TO NAME. `STATUS_W` is why a column
//     of status chips has one edge; `check:status-width` needs a symbol to
//     point at.
//
// EVERY VALUE BELOW IS PINNED AGAINST tokens.css BY `check:theme-tokens`, in
// both directions. That is the whole reason it is safe to write a colour twice:
// the copies cannot disagree silently, and the check names which one moved. Same
// idiom as `check:text-color`, which pins a union against the SDK's declaration.

/** The four status hues, plus the one AI accent that is not a status.
 *
 *  SIX-DIGIT HEX, always. `StatusChip` appends two-digit alpha to these, and
 *  `#abc` + `"55"` is not a colour — it parses as nothing and the chip loses its
 *  border with no error anywhere. Pinned by the check. */
export const TONE = {
  /** pass / go */
  phos: "#6bff9e",
  /** running / live / focus */
  cyan: "#35e0ff",
  /** flaky / healed / caution */
  amber: "#ffb43d",
  /** fail / stop / danger */
  red: "#ff4d61",
  /** AI-adjacent. NOT a status — see the note on `HOLO` below. */
  violet: "#b98cff",
} as const;

export type ToneName = keyof typeof TONE;

/** The text ramp, in a form the mixer can read. */
export const INK = {
  /** Primary text. */
  tx1: "#e9edee",
  /** `Temp`'s resting colour: the deliberate middle of the ramp, where a
   *  duration is reporting "nothing to see here" and must not be lit. */
  neutral: "rgba(233, 237, 238, 0.62)",
} as const;

/**
 * Selection, and it is NEVER a status hue.
 *
 * The rule this encodes is the load-bearing one of the whole palette: COLOUR
 * MEANS OUTCOME. A selected row drawn in green would be claiming a result, and
 * a row that is both selected AND failing would have two treatments arguing
 * about what the colour reports. So selection is neutral white at low alpha —
 * a lift plus a ring, no hue at all.
 *
 * `check:selection-neutral` exists because the next person to add a selectable
 * surface will reasonably reach for the accent colour, and nothing else in the
 * toolchain would object.
 */
export const SEL_BG = "rgba(255, 255, 255, 0.055)";
export const SEL_RING = "rgba(255, 255, 255, 0.16)";

/** The whole selection treatment, as one style object, so a call site cannot
 *  take the background and forget the ring (which reads as a hover state). */
export const SEL_ROW = {
  background: SEL_BG,
  boxShadow: `inset 0 0 0 1px ${SEL_RING}`,
} as const;

/**
 * The fixed status-chip width. A LAYOUT CONTRACT, not a style.
 *
 * Every status chip in the app is exactly this wide so that a column of them
 * has one edge instead of a ragged one. It degrades a single row at a time,
 * which is precisely the kind of thing that survives review — hence
 * `check:status-width`.
 */
export const STATUS_W = 78;

/** Hairlines, for the places a border is drawn in JS rather than CSS. */
export const LINE = "rgba(255, 255, 255, 0.08)";

/**
 * The AI treatment.
 *
 * AI IS NOT A STATUS, SO IT GETS A TREATMENT RATHER THAN A COLOUR. Borders and
 * small marks only — never a text fill, because `background-clip: text` costs
 * enough contrast to stop a 9.5px uppercase label being readable, and that is
 * the size this app puts AI marks at.
 */
export const HOLO =
  "linear-gradient(100deg,#6bff9e,#35e0ff,#8f9bff,#ff7ad1,#ffd36b,#6bff9e)";
export const HOLO_SIZE = "300% 100%";
export const HOLO_REST = "38%";

// ── Colour arithmetic ─────────────────────────────────────────────────

/** `#rrggbb` → `[r, g, b]`. Returns null for anything else, so a caller that
 *  was handed an `rgba()` string degrades rather than producing NaN channels —
 *  `rgb(NaN,NaN,NaN)` is dropped by the parser and the element silently
 *  inherits, which is the exact failure mode this whole layer exists to avoid. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Parse either `#rrggbb` or `rgba(r, g, b, a)` into channels plus alpha. */
function parseColor(c: string): [number, number, number, number] | null {
  const hex = hexToRgb(c);
  if (hex) return [hex[0], hex[1], hex[2], 1];
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/i.exec(
    c.trim(),
  );
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

/**
 * Linear mix of two colours, `t` clamped to 0…1.
 *
 * Alpha is mixed too, which matters more than it looks: the ramp starts at
 * `INK.neutral` (62% alpha) and ends at a fully opaque status hue, so a mixer
 * that only touched RGB would make the first lit step of the ramp jump to full
 * opacity — a visible cliff exactly where §3.4 wants the ramp to be gentlest.
 *
 * Returns `rgba(...)` with alpha rounded to three places: enough precision that
 * adjacent ramp steps differ, few enough digits that a test can assert an exact
 * string instead of a tolerance.
 */
export function mix(from: string, to: string, t: number): string {
  const a = parseColor(from);
  const b = parseColor(to);
  if (!a || !b) return from;
  const k = Math.max(0, Math.min(1, t));
  const ch = (i: number): number => Math.round(a[i] + (b[i] - a[i]) * k);
  const alpha = Math.round((a[3] + (b[3] - a[3]) * k) * 1000) / 1000;
  return `rgba(${ch(0)}, ${ch(1)}, ${ch(2)}, ${alpha})`;
}

/** `#rrggbb` plus a two-digit alpha suffix — the `tone + "55"` idiom, with the
 *  six-digit precondition actually enforced instead of assumed. */
export function withAlpha(hex: string, suffix: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    throw new Error(`withAlpha needs a six-digit hex, got ${hex}`);
  }
  return `${hex}${suffix}`;
}

/** The two alphas the design derives every tinted surface from. `55` (33%) for
 *  the line, `12` (7%) for the fill — one hue, two weights, so a new status
 *  costs one token rather than three. */
export const TONE_LINE_ALPHA = "55";
export const TONE_FILL_ALPHA = "12";

/**
 * A tinted surface in one tone: border, fill and text.
 *
 * THE ONLY PLACE THIS DERIVATION HAPPENS. `StatusChip` and `Btn` both want it,
 * and doing it twice — once by writing the hex into a stylesheet, once by
 * concatenating in JS — is two mechanisms for one appearance, which drift apart
 * the first time a hue is retuned and leave one of them stale with nothing to
 * report it. `check:theme-tokens` pins that no status hex is ever written into a
 * stylesheet, which is what keeps this the only route.
 */
export function toneSurface(tone: string): {
  borderColor: string;
  background: string;
  color: string;
} {
  return {
    borderColor: withAlpha(tone, TONE_LINE_ALPHA),
    background: withAlpha(tone, TONE_FILL_ALPHA),
    color: tone,
  };
}

/**
 * Status as an INSET RAIL, which is the single most repeated motif in this
 * design — step rows, diff lines, verdict blocks, menu hover, risk rows.
 *
 * A rail rather than a background or a border, and both alternatives were
 * rejected for reasons worth keeping: a background tint at a readable strength
 * fights the text sitting on it, and a real `border` participates in layout, so
 * a list where some rows have one and some do not jumps by 2px per status
 * change. `box-shadow` is drawn outside the box model and composes with the
 * selection ring, so a row can be selected AND failing without either claim
 * hiding the other.
 */
export function insetRail(tone: string, width = 2): string {
  return `inset ${width}px 0 0 ${tone}`;
}
