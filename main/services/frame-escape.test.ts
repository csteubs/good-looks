// The two CSS-attribute escapers in `shared/` agree, and no file there carries
// a literal control byte.
//
// ── Why there are two escapers at all ─────────────────────────────────────
// `testIdSelector` (shared/testid-attr.mjs) is `toString()`d into the heal
// fixture as source text, so it MUST NOT close over anything — it cannot call a
// helper, and the escaping rule has to be written inside it. `frameSelector`
// (shared/frame-ref.mjs) is never embedded and could import one, but it needs
// `src*=` as well as `=`, so reusing `testIdSelector` whole would cover two of
// its three attribute arms and not the third. The duplication is forced; what
// is not forced is leaving it unwitnessed. `frame-ref.mjs` says the rule is
// "the same rule `testIdSelector` uses, kept identical" — this is what makes
// that sentence true rather than aspirational.
//
// ── Why the literal-control-byte assertion ───────────────────────────────
// `frame-ref.mjs` spelled its class with three literal control BYTES where
// `testid-attr.mjs` spelled the identical class with `\u…` escapes. Same
// behaviour, and that is the point: nothing was wrong, and nothing could be
// seen either. Those bytes render as nothing in a diff, nothing in a review and
// nothing in most editors, so a paste that drops one changes the escaping rule
// with no visible change to the file. `shared/` was also not linted until this
// landed, so `no-control-regex` — the rule that exists to say exactly this —
// had never run over any of it.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { frameSelector, parseFrameSelector } from "../../shared/frame-ref.mjs";
import { testIdSelector } from "../../shared/testid-attr.mjs";

/** Every control code point, plus the characters a CSS string cares about and
 *  a couple of ordinary ones, so a rule that only handles the interesting half
 *  cannot pass. */
const CORPUS: string[] = [
  "plain",
  "",
  'a"b',
  "a\\b",
  'a"\\b',
  "a b",
  "über",
  ...Array.from({ length: 0x20 }, (_, i) => `a${String.fromCharCode(i)}b`),
  `a${String.fromCharCode(0x7f)}b`,
];

describe("the two CSS-attribute escapers agree", () => {
  it("escapes every value identically", () => {
    for (const value of CORPUS) {
      // `frameSelector`'s testid arm and `testIdSelector` build the same
      // `[data-testid="…"]` clause, so the escaped values must match character
      // for character — one is keyed into the heal map and the other is written
      // into the spec, and a locator that resolves is one where they agree.
      const framed = frameSelector({ k: "testid", v: value });
      const direct = testIdSelector("data-testid", value);
      expect(framed, `value ${JSON.stringify(value)}`).toBe(`iframe${direct}`);
    }
  });

  it("escapes a frame's name and url arms by the same rule", () => {
    for (const value of CORPUS) {
      const escaped = testIdSelector("x", value).slice('[x="'.length, -'"]'.length);
      expect(frameSelector({ k: "name", v: value })).toBe(`iframe[name="${escaped}"]`);
      expect(frameSelector({ k: "url", v: value })).toBe(`iframe[src*="${escaped}"]`);
    }
  });

  it("still round-trips a value carrying control characters", () => {
    // The fixed point `check:locator-roundtrip` holds for framed steps. A
    // control character is where an escaping change would break it first, and
    // silently: the parser would return a `css` ref and the step would stop
    // being recognised as a frame.
    for (const value of CORPUS) {
      const parsed = parseFrameSelector(frameSelector({ k: "testid", v: value }));
      expect(parsed, `value ${JSON.stringify(value)}`).toEqual({ k: "testid", v: value });
    }
  });
});

describe("shared/ carries no literal control byte", () => {
  it("spells control characters as escapes in every module", () => {
    const dir = join(process.cwd(), "shared");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!/\.(mjs|mts)$/.test(name)) continue;
      const source = readFileSync(join(dir, name), "utf8");
      source.split("\n").forEach((line, i) => {
        for (const ch of line) {
          const n = ch.charCodeAt(0);
          // Tab is legitimate whitespace; every other C0 code point and DEL is
          // a byte nobody can see. (Line feed cannot appear — we split on it.)
          if ((n < 0x20 && n !== 0x09) || n === 0x7f) {
            offenders.push(`shared/${name}:${i + 1} U+${n.toString(16).padStart(4, "0")}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
