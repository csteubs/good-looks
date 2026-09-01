// The command box's MECHANICAL first pass: phrases with one honest local
// meaning are handled by the trainer's own controls, and only what this
// module cannot claim goes to the agent. The split is deliberate — "assert
// the heading is visible" arming the picker costs nothing and teaches the
// bar, while "add something to the cart and check out" is a goal only the
// agent can drive. A parse that guessed at the second kind would insert
// steps nobody stood behind, which is the exact failure the verify gate
// exists to stop.
//
// Pure, node-tested. The view maps each result onto the control it already
// has: `arm-assert` → setAssert (the user clicks the element — the trainer's
// own model for naming one); `compose-assert` → the Add-step assertion form
// prefilled from the live page, exactly as the assert menu's page group
// opens it; `compose-wait` → the wait form with the duration filled in.
// Null means "not mine": the caller sends the text to the agent verbatim.

import type { AssertKind } from "./recorder-types";

export type ParsedCommand =
  | { kind: "arm-assert"; assert: AssertKind }
  | { kind: "compose-assert"; assert: AssertKind }
  | { kind: "compose-wait"; waitMs: number };

/** The verbs that mark a sentence as an assertion ask. Anchored at the start:
 *  "verify" mid-sentence ("…and verify the receipt") is a goal with several
 *  steps in front of it, and that is the agent's. */
const ASSERT_VERB = /^(?:assert|check|verify|expect|make sure|confirm)\b/i;

/** Element-state phrases, NEGATIONS FIRST: "not visible" contains "visible",
 *  and a table scanned in the wrong order arms the opposite of what was
 *  said. Each entry is (pattern, kind); first hit wins. */
const ELEMENT_STATES: [RegExp, AssertKind][] = [
  [/\bnot\s+visible\b|\binvisible\b|\bhidden\b|\bdisappear(?:s|ed)?\b|\bgone\b/i, "hidden"],
  [/\bvisible\b|\bappears?\b|\bshows?\s+up\b|\bshown\b|\bon\s+screen\b/i, "visible"],
  [/\bnot\s+enabled\b|\bdisabled\b|\bgreyed\s+out\b|\bgrayed\s+out\b/i, "disabled"],
  [/\benabled\b|\bclickable\b/i, "enabled"],
  [/\bnot\s+checked\b|\bunchecked\b|\bunticked\b/i, "unchecked"],
  [/\bchecked\b|\bticked\b/i, "checked"],
  [/\bexact\s+text\b/i, "exactText"],
  [/\btext\b|\bsays\b/i, "text"],
];

/** "wait 2 seconds", "pause for 500ms", "sleep 1.5s". The WHOLE input must be
 *  the wait — "wait for the banner to disappear" names a condition, not a
 *  duration, and belongs to the agent (or the wait form's own predicates). */
const WAIT_RE =
  /^(?:wait|pause|sleep)(?:\s+for)?\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|msecs?|s|secs?|seconds?|m|mins?|minutes?)?\s*[.!]?$/i;

export function parseCommand(input: string): ParsedCommand | null {
  const text = input.trim();
  if (!text) return null;

  const wait = WAIT_RE.exec(text);
  if (wait) {
    const n = Number(wait[1]);
    const unit = (wait[2] ?? "s").toLowerCase();
    const ms = unit.startsWith("ms") || unit.startsWith("msec")
      ? n
      : unit.startsWith("m")
        ? n * 60_000
        : n * 1000;
    return { kind: "compose-wait", waitMs: Math.round(ms) };
  }

  if (!ASSERT_VERB.test(text)) return null;

  // Page-level asks open the form prefilled from where the page is — the
  // same move the assert menu's page group makes, for the same reason: these
  // kinds take a typed value, and the app knows a better draft of it than
  // the user does.
  if (/\burl\b/i.test(text)) {
    if (/\bpath\b/i.test(text)) return { kind: "compose-assert", assert: "urlPathIs" };
    if (/\bends?\s+with\b/i.test(text)) return { kind: "compose-assert", assert: "urlEndsWith" };
    if (/\bcontains?\b/i.test(text)) return { kind: "compose-assert", assert: "url" };
    if (/\bis\b/i.test(text)) return { kind: "compose-assert", assert: "urlIs" };
    // "check the url" alone: the robust default, per ASSERT_PAGE's ordering.
    return { kind: "compose-assert", assert: "urlPathIs" };
  }
  // Element states before the title branch: "the exact text of the title"
  // is an ask about an ELEMENT that happens to contain the word title, and
  // the state vocabulary is the more specific signal. The URL branch stays
  // first — nothing in the state table collides with it.
  for (const [re, assert] of ELEMENT_STATES) {
    if (re.test(text)) return { kind: "arm-assert", assert };
  }

  if (/\b(?:page\s+)?title\b/i.test(text)) {
    return /\bcontains?\b/i.test(text)
      ? { kind: "compose-assert", assert: "titleContains" }
      : { kind: "compose-assert", assert: "title" };
  }

  // An assertion sentence this table cannot name honestly — "assert the
  // total is $40" — is the agent's, which can read the page and propose the
  // step for the verify gate to try.
  return null;
}
