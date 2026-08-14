// The single-semantic-definition invariant, pinned.
//
// `shared/step-semantics.mjs` is only worth having if BOTH consumers actually
// read it. The failure it prevents is not a crash — it is one side quietly
// growing a private rule again, which is exactly how the app came to have three
// different meanings for "URL contains" and no test that could see it.
//
// Four properties, each guarding a different way that could come back:
//
//  1. Every string-comparing kind in the step vocabulary HAS a declared rule.
//     A new assert kind with no entry silently falls back to "no match" rather
//     than announcing that nobody decided what it means.
//  2. The injected replayer really carries the shared comparator. The source is
//     shipped via `Function.prototype.toString`, so a closure reference added
//     to it would type-check, build, and then throw a ReferenceError inside a
//     page the user is watching — invisible to every other gate.
//  3. The generated spec's pattern is built from the same table. A `.` left
//     unescaped is a false PASS, which no failing test ever reveals.
//  4. Where the wait vocabulary overlaps the assert vocabulary, the two agree.
//     "Wait until the URL contains X" and "assert the URL contains X" differing
//     by a case rule would be this bug one level down.

import { buildReplayScript } from "../step-replayer.js";
import { generateSpec } from "../script-generator.js";
import {
  ASSERT_SEMANTICS,
  matchesValue,
  matchSource,
  textMatchExpr,
  visibilitySource,
  WAIT_SEMANTICS,
  WAIT_TO_ASSERT_KIND,
} from "../../../shared/step-semantics.mjs";
import { ASSERT_KINDS } from "../../recorder/types.js";
import type { AssertKind, Step } from "../../recorder/types.js";

let failures = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log("ok   " + label);
  } else {
    console.log("FAIL " + label);
    failures++;
  }
}
function eq(actual: unknown, expected: unknown, label: string): void {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (!good) console.log("  expected: " + JSON.stringify(expected) + "\n  actual:   " + JSON.stringify(actual));
  ok(good, label);
}

// ---------------------------------------------------------------------------
// 1. Every kind that compares a string has a declared rule.
// ---------------------------------------------------------------------------

/** The assert kinds that compare a free-text value against the page. The rest
 *  (`visible`, `count`, `css`, …) compare something else and correctly have no
 *  entry — `css` carries its match mode per-step in `cssMatch`. */
const VALUE_KINDS: AssertKind[] = [
  "url", "urlEndsWith", "urlIs", "title", "titleContains",
  "text", "exactText", "value", "attribute",
];

for (const kind of VALUE_KINDS) {
  ok(!!ASSERT_SEMANTICS[kind], `${kind} has declared semantics`);
}
for (const kind of VALUE_KINDS) {
  ok(ASSERT_KINDS.includes(kind), `${kind} is in the runtime allowlist`);
}
// The inverse: nothing in the table that is not a real kind, which would mean a
// rule nobody can reach.
for (const kind of Object.keys(ASSERT_SEMANTICS)) {
  ok(ASSERT_KINDS.includes(kind as AssertKind), `${kind} in the table is a real assert kind`);
}

// ---------------------------------------------------------------------------
// 2. The injected replayer carries the shared comparator, and it is standalone.
// ---------------------------------------------------------------------------

const script = buildReplayScript({ id: "s", type: "assert", assert: "url", value: "/x" } as Step);
ok(script.includes("matchesValue"), "the injected script binds matchesValue");
ok(script.includes("isVisibleByRect"), "the injected script binds isVisibleByRect");
ok(script.includes('"caseSensitive"') || script.includes("caseSensitive"), "the semantics table travels as data");

// The one that matters: the serialized functions must not close over anything.
// Evaluated in an isolated scope with NO access to this module — a reference to
// a module-scope constant throws here, which is the whole point.
for (const [label, source, call] of [
  ["matchesValue", matchSource(), '(function(){ return matchesValue("abc", "b", {match:"substring",caseSensitive:true,normalizeWhitespace:false}); })()'],
  ["isVisibleByRect", visibilitySource(), '(function(){ return isVisibleByRect({width:1,height:1},{visibility:"visible",display:"block"}); })()'],
] as const) {
  let threw: string | null = null;
  let result: unknown = null;
  try {
    result = new Function(source + "\nreturn " + call + ";")();
  } catch (e) {
    threw = String(e);
  }
  ok(threw === null, `${label} runs with no access to its own module scope${threw ? " — " + threw : ""}`);
  ok(result === true, `${label} returns the right answer when isolated`);
}

// ---------------------------------------------------------------------------
// 3. The generated spec's pattern comes from the same table.
// ---------------------------------------------------------------------------

function emitted(step: Partial<Step>): string {
  const src = generateSpec({
    name: "t",
    url: "https://example.com",
    steps: [{ id: "s1", type: "assert", ...step } as Step],
  });
  return (src.split("\n").find((l) => l.includes("expect(")) ?? "").trim();
}

// A dot must arrive escaped, or the assertion passes against the wrong host.
ok(
  emitted({ assert: "url", value: "example.com" }).includes("example\\\\.com"),
  "a URL's dot is escaped in the emitted pattern",
);
// A query string's `?` must arrive escaped, or the assertion fails on every run.
ok(
  emitted({ assert: "url", value: "/a?b=1" }).includes("\\\\?"),
  "a URL's question mark is escaped in the emitted pattern",
);
// And the emission is literally the shared builder's output, not a lookalike.
const urlSemantics = ASSERT_SEMANTICS.url;
if (!urlSemantics) throw new Error("url semantics missing");
ok(
  emitted({ assert: "url", value: "/cart?x=1" }).includes(textMatchExpr("/cart?x=1", urlSemantics)),
  "the emitted line contains exactly what textMatchExpr builds",
);
// The old bug, refused by name.
ok(
  !emitted({ assert: "url", value: "/cart" }).includes('toHaveURL("/cart")'),
  "'URL contains' never emits the bare-string (exact) form",
);

// ---------------------------------------------------------------------------
// 4. Wait predicates agree with the assert kinds they mirror.
// ---------------------------------------------------------------------------

for (const [waitKind, assertKind] of Object.entries(WAIT_TO_ASSERT_KIND)) {
  const w = WAIT_SEMANTICS[waitKind];
  const a = assertKind ? ASSERT_SEMANTICS[assertKind] : undefined;
  ok(!!w && !!a, `${waitKind} and ${assertKind} both have semantics`);
  if (w && a) eq(w, a, `wait ${waitKind} matches assert ${assertKind} exactly`);
}

// And a behavioural spot-check of the comparator itself, because a table can be
// self-consistent and still wrong.
ok(matchesValue("Cart | Acme", "Cart", ASSERT_SEMANTICS.titleContains!), "titleContains accepts a substring");
ok(!matchesValue("Cart | Acme", "Cart", ASSERT_SEMANTICS.title!), "title rejects a substring");
ok(matchesValue("HTTPS://X.TEST/a", "x.test/a", ASSERT_SEMANTICS.url!), "url ignores case");
ok(!matchesValue("Checkout", "checkout", ASSERT_SEMANTICS.text!), "text does not ignore case");
ok(matchesValue("  a   b  ", "a b", ASSERT_SEMANTICS.exactText!), "exactText normalizes whitespace");
ok(!matchesValue("  a   b  ", "a b", ASSERT_SEMANTICS.value!), "value does not normalize whitespace");
// The `endsWith` empty-string trap: `"x".slice(-0)` is the whole string.
ok(!matchesValue("https://x.test/a", "", ASSERT_SEMANTICS.urlEndsWith!), "urlEndsWith with an empty value matches nothing");

console.log(failures === 0 ? "\nall step-semantics checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
