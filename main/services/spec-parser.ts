// Best-effort parser that reads a Playwright spec file's source and extracts
// the actions inside its `test(...)` bodies as the app's Step[] model — the
// reverse of script-generator.ts. Used by the import flow so imported tests
// show their steps in the Steps view, and by the LLM-debug-apply path to
// resync steps after a script edit.
//
// This is a pragmatic line-by-line parser, not a full TS parser. It strips
// comments, then walks the body of each `test(...)`/`test.describe(...)` block
// looking for the full vocabulary script-generator.ts emits: page.goto,
// page.waitForTimeout, page.setViewportSize, page.keyboard.press,
// getByRole/getByLabel/.../locator(...).click/.fill/.selectOption/.check/
// .uncheck/.press/.waitFor/.scrollIntoViewIfNeeded, glazeScrollTo(page, x, y),
// and expect(...)/expect.soft(...) assertions
// (toBeVisible/toBeHidden/toContainText/toHaveText/toBeEnabled/toBeDisabled/
// toBeChecked/.not.toBeChecked/toHaveValue/toHaveAttribute/toHaveCount, plus
// page-level toHaveURL/toHaveTitle). A statement that still can't be
// classified is skipped and counted (see parseSpecDetailed) rather than
// silently dropped — the verbatim script is still the runnable artifact
// either way.

import { randomUUID } from "crypto";

import { parseTestIdSelector } from "../../shared/testid-attr.mjs";
import { DEFAULT_WAIT_TIMEOUT_MS } from "./script-generator.js";
import { fromPlaywrightSameSite } from "../recorder/types.js";
import type {
  AssertKind,
  ConditionKind,
  CookieSpec,
  Locator,
  LocatorContext,
  LocatorKind,
  Step,
  StepType,
  WaitUntilKind,
} from "../recorder/types.js";

/**
 * Read `{ … }` object literals out of an argument string into CookieSpecs.
 * Deliberately narrow: it understands the shape script-generator emits
 * (string/number/boolean literal values, no nesting, no expressions) and
 * ignores anything else, so a hand-written call with computed values is
 * reported as skipped rather than silently half-parsed.
 *
 * Playwright's `expires`/`sameSite` are translated back to the Chromium
 * spelling the app stores (`expirationDate`, lowercase sameSite).
 */
function parseCookieObjects(argsStr: string): CookieSpec[] {
  const out: CookieSpec[] = [];
  const objectRe = /\{[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = objectRe.exec(argsStr)) !== null) {
    const body = m[0].slice(1, -1);
    const readStr = (key: string): string | undefined => {
      // Matches a quoted value (either quote style), honoring backslash
      // escapes, then unescapes them — cookie values legitimately contain
      // quotes and backslashes.
      const hit = body.match(new RegExp(key + "\\s*:\\s*([\"'])((?:\\\\.|(?!\\1).)*)\\1"));
      return hit ? hit[2].replace(/\\(.)/g, "$1") : undefined;
    };
    const readNum = (key: string): number | undefined => {
      const hit = body.match(new RegExp(key + "\\s*:\\s*(-?\\d+(?:\\.\\d+)?)"));
      return hit ? parseFloat(hit[1]) : undefined;
    };
    const readBool = (key: string): boolean | undefined => {
      const hit = body.match(new RegExp(key + "\\s*:\\s*(true|false)"));
      return hit ? hit[1] === "true" : undefined;
    };

    const name = readStr("name");
    if (!name) continue;
    const spec: CookieSpec = { name };
    const value = readStr("value");
    if (value !== undefined) spec.value = value;
    const domain = readStr("domain");
    if (domain !== undefined) spec.domain = domain;
    const path = readStr("path");
    if (path !== undefined) spec.path = path;
    const url = readStr("url");
    if (url !== undefined) spec.url = url;
    const expires = readNum("expires");
    if (expires !== undefined) spec.expirationDate = expires;
    const httpOnly = readBool("httpOnly");
    if (httpOnly !== undefined) spec.httpOnly = httpOnly;
    const secure = readBool("secure");
    if (secure !== undefined) spec.secure = secure;
    const sameSite = fromPlaywrightSameSite(readStr("sameSite"));
    if (sameSite !== undefined) spec.sameSite = sameSite;
    out.push(spec);
  }
  return out;
}

/**
 * Strip line and block comments from a source snippet. String-aware so a
 * `//` inside a string literal (e.g. a URL like "https://…") is NOT treated
 * as a line comment — critical since page.goto args contain URLs.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // Skip over string literals verbatim (handles `//` inside "https://…").
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      out += ch;
      i++;
      while (i < src.length) {
        const c = src[i];
        out += c;
        i++;
        if (c === "\\") {
          if (i < src.length) {
            out += src[i];
            i++;
          }
          continue;
        }
        if (c === q) break;
      }
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "//") {
      // Preserve "disabled — skipped:" comment lines so the scan loop can
      // round-trip them into disabled steps (see parseBody). We keep the
      // whole line verbatim by skipping the `//` but NOT the rest.
      const after = src.slice(i + 2);
      if (after.match(/^\s*disabled\s*—\s*skipped\s*:/) || after.match(/^\s*disabled\s*-?\s*skipped\s*:/)) {
        // Emit a bare `//` so the line stays a comment the scan loop handles,
        // but keep the rest of the line (the statement) intact.
        out += "//";
        i += 2;
        continue;
      }
      // Preserve the `// wait until` marker script-generator.ts appends to a
      // conditional wait. Without this the marker is stripped here and every
      // conditional wait parses back as an ASSERTION — the same call, since
      // Playwright's only retrying primitive for these predicates is `expect`.
      // Kept verbatim; the scan loop reads it off the statement's line.
      if (after.match(/^\s*wait until\s*(?:\r?\n|$)/)) {
        out += "//";
        i += 2;
        continue;
      }
      const nl = src.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Pull the first string-literal argument out of `fn("x"…)` / `fn('x'…)` / `fn(`x`…)`.
 *
 *  ESCAPE-AWARE, and it has to be. The naive character class stops at the first
 *  quote of ANY kind, so a value containing one — which the generator writes as
 *  `"a\"b"` — came back as `a\`, and regenerating produced a different literal
 *  than the one that was read. A round trip that CHANGES a locator's value is
 *  worse than one that drops it: the step still runs, still looks right in the
 *  step list, and points at nothing. Every caller already passes the result
 *  through `unescapeLit`, so the backslashes this now preserves are undone
 *  exactly where they always were. */
function firstStringLiteral(s: string): string | null {
  const m = s.match(/(['"`])((?:\\.|(?!\1)[^\n])*)\1/);
  return m ? m[2] : null;
}

/**
 * Read a step's VALUE argument back out of a generated call, undoing what
 * `valueExpr` in script-generator emitted.
 *
 * Three shapes, because the generator emits three:
 *   V.name                     → "${name}"
 *   `text ${V.name} more`      → "text ${name} more"
 *   "literal"                  → "literal"
 *
 * Without this a round-trip would turn `V.email` into the literal text
 * "V.email" — the step would still look plausible in the editor and the next
 * regeneration would emit a quoted string, silently un-parameterizing the test.
 */
function parseValueArg(argsStr: string): string | null {
  const trimmed = argsStr.trim();
  const bare = trimmed.match(/^V\.([A-Za-z_][A-Za-z0-9_]*)\s*$/);
  if (bare) return "${" + bare[1] + "}";
  if (trimmed.startsWith("`")) {
    // Scan for the first UNescaped backtick — `indexOf` would stop at a \`
    // inside the literal and truncate the value there.
    let end = -1;
    for (let k = 1; k < trimmed.length; k++) {
      if (trimmed[k] === "\\") {
        k++;
        continue;
      }
      if (trimmed[k] === "`") {
        end = k;
        break;
      }
    }
    if (end > 0) {
      return unescapeLit(trimmed.slice(1, end)).replace(
        /\$\{\s*V\.([A-Za-z_][A-Za-z0-9_]*)\s*\}/g,
        (_whole, name: string) => "${" + name + "}",
      );
    }
  }
  const lit = firstStringLiteral(argsStr);
  return lit === null ? null : unescapeLit(lit);
}

/**
 * Assert kind → the wait predicate that compiles to the same `expect` call.
 *
 * Only the kinds script-generator.ts actually emits with a `// wait until`
 * marker appear here. `exactText` and `attribute` are absent on purpose: they
 * have no conditional-wait counterpart, so a marker on one of them is a
 * hand-edit rather than something this parser produced, and it stays an
 * assertion.
 */
const ASSERT_TO_WAIT_UNTIL: Partial<Record<AssertKind, WaitUntilKind>> = {
  visible: "visible",
  hidden: "hidden",
  enabled: "enabled",
  disabled: "disabled",
  checked: "checked",
  unchecked: "unchecked",
  text: "text",
  value: "value",
  count: "count",
  url: "urlContains",
  // `titleContains`, not `title`. A marked `toHaveTitle` used to come back as
  // the exact `title` assert and then be mapped to a CONTAINS wait, quietly
  // widening the predicate on the way through the parser. Now that the two
  // title kinds are distinct on both sides, each maps to itself and neither
  // changes meaning by being round-tripped.
  titleContains: "titleContains",
};

/** Undo script-generator.ts's `reEscape` — drop the backslash in front of a
 *  regex metacharacter so a pattern becomes the literal substring it came
 *  from. Only used where the generator is known to have escaped a user string
 *  into a RegExp (the page-level conditional waits). */
function reUnescape(s: string): string {
  return s.replace(/\\([.*+?^${}()|[\]\\])/g, "$1");
}

/** Read `{ timeout: N }` back off a conditional wait's call. Returns null when
 *  absent, so the step falls back to the generator's default rather than
 *  recording a timeout the spec never stated. */
function parseTimeoutOption(s: string): number | null {
  const m = s.match(/\btimeout\s*:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Unescape a JS string-literal payload (\\n, \\t, \\", \\', \\`, \\\\). */
function unescapeLit(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\`/g, "`")
    .replace(/\\\\/g, "\\");
}

/** Parse a `getByRole("role", { name: "x" })`-style options object for role/name. */
function parseRoleOptions(s: string): { role?: string; name?: string } {
  const out: { role?: string; name?: string } = {};
  const roleM = s.match(/getByRole\s*\(\s*['"`]([^'"`\n]+)['"`]/);
  if (roleM) out.role = roleM[1];
  const nameM = s.match(/\bname\s*:\s*['"`]([^'"`\n]+)['"`]/);
  if (nameM) out.name = nameM[1];
  return out;
}

const BUILDER_RE = "getByTestId|getByRole|getByLabel|getByPlaceholder|getByText|locator";

/**
 * Parse exactly ONE locator-builder call beginning at `idx`, and return the
 * modeled Locator plus everything after its closing paren.
 *
 * Split out of `parseLocator` because a context-carrying locator contains up to
 * three builder calls — the container, the target, and each `and` predicate —
 * and they must be parsed INDEPENDENTLY. `parseRoleOptions` anchors its regex
 * on the first `getByRole(` in whatever string it is handed, so passing it the
 * whole expression (as the single-builder version could safely do) would read
 * the CONTAINER's role and name onto the target the moment a chain had two role
 * locators in it. It is given this call's text alone.
 */
function parseBuilderAt(s: string, idx: number): { locator: Locator; rest: string } | null {
  const m = s.slice(idx).match(new RegExp(`^(?:page\\.)?(${BUILDER_RE})\\s*\\(`));
  if (!m) return null;
  const kind = m[1];
  const openIdx = idx + m[0].length - 1;
  // Find the matching close paren of the builder call.
  let depth = 0;
  let end = -1;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const call = s.slice(idx, end + 1);
  const argsStr = s.slice(openIdx + 1, end);
  let locator: Locator;
  if (kind === "getByRole") {
    const { role, name } = parseRoleOptions(call);
    locator = { k: "role", role: role ?? "", name };
  } else {
    const map: Record<string, LocatorKind> = {
      getByTestId: "testid",
      getByLabel: "label",
      getByPlaceholder: "placeholder",
      getByText: "text",
      locator: "css",
    };
    const k = map[kind];
    const v = firstStringLiteral(argsStr);
    locator = { k, v: v ? unescapeLit(v) : "" };
  }
  // `locator("xpath=…")` is how the generator writes an xpath — read it back as
  // one, or a round trip turns every xpath step into a css step whose selector
  // begins with "xpath=" and matches nothing.
  if (locator.k === "css" && locator.v?.startsWith("xpath=")) {
    locator = { k: "xpath", v: locator.v.slice("xpath=".length) };
  }
  // `locator('[data-test-id="…"]')` is how the generator writes a testid that
  // lives on an attribute `getByTestId` cannot resolve. Read it back as the
  // SAME testid locator — left as css, every hand edit of the Script tab would
  // silently relabel the step and drop which attribute it meant. A hand-written
  // `[data-testid="…"]` is deliberately NOT converted: it resolves identically
  // as css everywhere, so the relabel would change nothing but the label.
  if (locator.k === "css") {
    const tid = parseTestIdSelector(locator.v ?? "");
    if (tid) locator = { k: "testid", attr: tid.attr, v: tid.value };
  }
  return { locator, rest: s.slice(end + 1) };
}

/**
 * Parse a Playwright locator expression starting at `expr` and return the
 * modeled Locator plus the remainder of the string (the action tail).
 * Recognizes getByTestId / getByRole / getByLabel / getByPlaceholder /
 * getByText / locator(...) chains. Returns null if no locator is found.
 */
function parseLocator(expr: string): { locator: Locator; rest: string } | null {
  // Match the first locator-builder call.
  const m = expr.match(new RegExp(`(?:page\\.)?(${BUILDER_RE})\\s*\\(`));
  if (!m || m.index === undefined) return null;
  const first = parseBuilderAt(expr, m.index);
  if (!first) return null;
  let locator = first.locator;
  let rest = first.rest;

  // ── The user's pinned context, read back off the chain ───────────────────
  //
  // THIS IS NOT OPTIONAL POLISH. The comment on `.nth()` below records what
  // happens when the generator emits something this function cannot read: the
  // action shape does not match, and the WHOLE STEP is dropped — silently, on
  // every hand edit of the Script tab and every applied AI fix. `.filter()`,
  // `.first()` and `.or()` were listed there as refinements the model had no
  // field for, and were left unclassified for exactly that reason. `within`,
  // `withinHasText` and `and` now HAVE fields, so they are read, and the pair
  // is held by check:locator-roundtrip.

  // `.filter({ hasText })` belongs to the CONTAINER, so it is held until a
  // chained builder proves there is one.
  let hasText: string | undefined;
  const fm = rest.match(/^\s*\.filter\(\s*\{\s*hasText\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\}\s*\)/);
  if (fm) {
    hasText = unescapeLit(fm[2]);
    rest = rest.slice(fm[0].length);
  }

  // A second builder chained onto the first makes the first a CONTAINER and the
  // second the target — `page.getByTestId("card").getByRole("button")`.
  const chained = rest.match(new RegExp(`^\\s*\\.(${BUILDER_RE})\\s*\\(`));
  if (chained && chained.index !== undefined) {
    const dot = rest.indexOf(".", chained.index);
    const inner = parseBuilderAt(rest, dot + 1);
    if (!inner) return null;
    const ctx: LocatorContext = { within: locator };
    if (hasText !== undefined) ctx.withinHasText = hasText;
    locator = { ...inner.locator, ctx };
    rest = inner.rest;
  } else if (hasText !== undefined) {
    // A `.filter()` with nothing chained after it is a refinement of the TARGET,
    // which the model still has no field for. Refused rather than dropped: the
    // step becomes unclassified (a skip the caller reports), instead of
    // regenerating as a locator that silently matches more than it did.
    return null;
  }

  // `.and(page.<builder>)`, repeatable — extra predicates on the target.
  for (;;) {
    const am = rest.match(/^\s*\.and\(/);
    if (!am) break;
    const inner = parseBuilderAt(rest, am[0].length);
    if (!inner) return null;
    const close = inner.rest.match(/^\s*\)/);
    if (!close) return null;
    const ctx: LocatorContext = { ...(locator.ctx ?? {}) };
    ctx.and = [...(ctx.and ?? []), inner.locator];
    locator = { ...locator, ctx };
    rest = inner.rest.slice(close[0].length);
  }
  // `.nth(k)` is part of the LOCATOR, not a refinement to be refused.
  //
  // The generator emits it (`locatorExpr`), and this parser could not read it
  // back — so `page.getByText("Save").nth(1).click()` matched no action shape
  // and the WHOLE STEP was dropped on re-parse. Not the index: the step. Every
  // hand edit of the Script tab and every applied AI fix silently deleted the
  // recorder's own output for exactly the steps that needed an index, which are
  // the ones where no unique locator existed.
  //
  // Deliberately narrow, and deliberately not the same decision as `.first()`
  // / `.filter()` / `.or()`. Those are refinements the app has no field for, so
  // storing the base locator would regenerate a selector matching the wrong
  // element and they stay counted-as-unclassified (see the note on the refined
  // chain below). `nth` has a field, `Locator.nth`, with the same meaning.
  // `-1` alongside the naturals: Playwright's "last match", the one negative
  // the model admits. Deeper negatives stay unmatched on purpose — the step
  // goes unclassified rather than round-tripping an index the generator would
  // refuse to re-emit.
  const nthM = rest.match(/^\s*\.nth\(\s*(-1|\d+)\s*\)/);
  if (nthM) {
    locator = { ...locator, nth: parseInt(nthM[1], 10) };
    rest = rest.slice(nthM[0].length);
  }
  return { locator, rest };
}

function makeStep(type: StepType, partial: Partial<Step>): Step {
  return {
    id: randomUUID(),
    type,
    timestamp: 0,
    ...partial,
  } as Step;
}

/** The action methods a locator can be chained to that this parser models.
 *  Shared by the inline `page.getBy…().click()` branch and the
 *  locator-in-a-variable branch, so a method added to one is not missing from
 *  the other. */
const LOCATOR_ACTIONS = [
  "click",
  "fill",
  "selectOption",
  "check",
  "uncheck",
  "press",
  "waitFor",
  "hover",
  "focus",
  "scrollIntoViewIfNeeded",
] as const;

const LOCATOR_ACTION_RE = LOCATOR_ACTIONS.join("|");

/**
 * Build the step a `<locator>.<action>(args)` call means. Returns null when the
 * call has no counterpart in the step model — only `waitFor({ state: "detached" })`
 * today — which the caller reports as a skip rather than emitting a step that
 * would regenerate as something else.
 */
function locatorActionStep(locator: Locator, action: string, argsStr: string): Step | null {
  // Until pseudo-states existed, `.hover()` fell through to the unclassified
  // branch and counted as a SKIP — which set `stepsDiverged` permanently on any
  // imported test that hovered.
  if (action === "hover" || action === "focus") {
    return makeStep("state", { locator, elementState: action });
  }
  if (action === "scrollIntoViewIfNeeded") {
    return makeStep("scroll", { locator });
  }
  if (action === "waitFor") {
    // `.waitFor({ state: … })` is a conditional wait with a native API, so it
    // needs no marker. The state is the whole meaning of the call: parsing it
    // as a plain wait (which is what happened before conditional waits existed)
    // turned every wait-for-hidden back into a wait-for-VISIBLE on the next
    // regeneration.
    const stateM = argsStr.match(/\bstate\s*:\s*['"`](visible|hidden|attached|detached)['"`]/);
    const timeoutMs = parseTimeoutOption(argsStr);
    // `detached` has no counterpart in the step model. Modeling it as a plain
    // wait would regenerate as a wait-for-VISIBLE — the very inversion this
    // branch exists to stop — so it is reported as unclassified instead.
    if (stateM?.[1] === "detached") return null;
    const waitUntil: WaitUntilKind | undefined =
      stateM?.[1] === "hidden"
        ? "hidden"
        : stateM?.[1] === "attached"
          ? "exists"
          : stateM?.[1] === "visible"
            ? "visible"
            : undefined;
    return makeStep("wait", {
      locator,
      ...(waitUntil ? { waitUntil } : {}),
      ...(waitUntil && timeoutMs !== null ? { timeoutMs } : {}),
    });
  }
  const typeMap: Record<string, StepType> = {
    click: "click",
    fill: "fill",
    selectOption: "select",
    check: "check",
    uncheck: "uncheck",
    press: "press",
  };
  const value = parseValueArg(argsStr);
  return makeStep(typeMap[action], {
    locator,
    ...(value !== null ? { value: unescapeLit(value) } : {}),
  });
}

/**
 * Find the index of the matching close paren for the open paren at `openIdx`,
 * skipping nested parens. Returns -1 if unbalanced.
 */
function matchParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Like matchParen, but for `{ … }`. */
function matchBrace(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Reverse of script-generator.ts's conditionExpr: read an `if (...)` condition
 * expression back into a `{ cond, locator?, value? }` partial. Returns null for
 * a condition shape the app doesn't author (e.g. a hand-written foreign `if`).
 */
function parseCondition(raw: string): Partial<Step> | null {
  const c = raw.trim();
  // Page-level conditions.
  //
  // The optional `.toLowerCase()` on both sides is the URL condition's case
  // rule made visible in the source. It has to be OPTIONAL rather than
  // required: specs generated before the rule was fixed carry the bare
  // `page.url().includes(...)` form, and they are re-parsed by every hand edit
  // and applied AI fix. Refusing to read the old shape would turn each of those
  // into an unclassified statement and silently drop the whole `if` body.
  let m = c.match(
    /^page\.url\(\)(?:\.toLowerCase\(\))?\.includes\(\s*(?:String\(\s*)?(['"`])([\s\S]*?)\1\s*\)?\s*(?:\.toLowerCase\(\)\s*)?\)$/,
  );
  if (m) return { cond: "urlContains", value: unescapeLit(m[2]) };
  if (/page\.title\(\)/.test(c)) {
    m = c.match(/\.includes\(\s*(['"`])([\s\S]*?)\1\s*\)\s*$/);
    if (m) return { cond: "titleContains", value: unescapeLit(m[2]) };
  }
  // Element conditions — extract the locator, then map the predicate method.
  const parsed = parseLocator(c);
  if (!parsed) return null;
  const negated = /^!\s*\(/.test(c);
  let cond: ConditionKind | null = null;
  if (/\.count\(\)\s*\)?\s*>\s*0/.test(c)) cond = "exists";
  else if (/\.isVisible\s*\(/.test(c)) cond = "visible";
  else if (/\.isHidden\s*\(/.test(c)) cond = "hidden";
  else if (/\.isEnabled\s*\(/.test(c)) cond = "enabled";
  else if (/\.isDisabled\s*\(/.test(c)) cond = "disabled";
  else if (/\.isChecked\s*\(/.test(c)) cond = negated ? "unchecked" : "checked";
  if (!cond) return null;
  return { cond, locator: parsed.locator };
}

/** Parse the body of a single test callback into steps, plus a count of
 *  statements that looked like actions but couldn't be classified.
 *
 *  `vars` carries the locators bound to `const` names earlier in the same body
 *  (see the declaration branch below). Nested calls — the try/catch and
 *  disabled-comment branches — are handed the caller's map so a statement
 *  wrapped in one can still resolve a variable declared outside it. */
function parseBody(
  body: string,
  vars: Map<string, Locator> = new Map(),
  // Armed download promises awaiting their `{ const dN = await downloadN; … }`
  // — threaded like `vars` because the awaiting line can sit inside a
  // continue-on-failure try-block, which parses by RECURSION: a map local to
  // one call would make every wrapped download read as skipped.
  pendingDownloads: Map<string, { timeoutMs: number }> = new Map(),
): { steps: Step[]; skipped: number } {
  const steps: Step[] = [];
  let skipped = 0;
  // Recognized open blocks awaiting their closing `}`, innermost last. A
  // STACK of kinds rather than the old single counter, because a `}` must
  // close back into the step that opened it: `endif` for an `if`, `endLoop`
  // for a `for` — one counter cannot tell `if { for {` from `for { if {`.
  const blockStack: ("if" | "loop")[] = [];
  const src = stripComments(body);

  // A single forward scan. At each position we test the known call shapes;
  // when one matches we consume the whole balanced call (and, for expect/locator,
  // the chained `.action(...)` call that follows) before advancing.
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);

    // Closing brace of a recognized block → the closer for whatever opened it.
    const braceM = rest.match(/^[\s;]*\}/);
    if (braceM && blockStack.length > 0) {
      const kind = blockStack.pop();
      steps.push(makeStep(kind === "loop" ? "endLoop" : "endif", {}));
      i += braceM[0].length;
      continue;
    }

    // for (let i = 0; i < N; i++) { … } — the generator's repeat block. The
    // variable name is pinned to the generator's own vocabulary (`i`, `i2`, …)
    // and must be the SAME name in all three positions; a foreign for-loop —
    // over anything else, or counting differently — is skipped whole below,
    // like a foreign `if`, rather than half-read into a loop step that would
    // regenerate as something the original was not.
    const forM = rest.match(
      /^[\s;]*for\s*\(\s*let\s+([A-Za-z_$][\w$]*)\s*=\s*0\s*;\s*([A-Za-z_$][\w$]*)\s*<\s*(\d+)\s*;\s*([A-Za-z_$][\w$]*)\s*\+\+\s*\)\s*\{/,
    );
    if (forM) {
      const ours =
        forM[1] === forM[2] && forM[1] === forM[4] && /^i\d*$/.test(forM[1]);
      if (ours) {
        steps.push(makeStep("loop", { loopCount: parseInt(forM[3], 10) }));
        blockStack.push("loop");
        i += forM[0].length;
        continue;
      }
      // The counting SHAPE with names that are not the generator's — a
      // near-miss. Half-reading it into a `loop` step would regenerate as a
      // repeat the original never was, so the whole block is skipped, inner
      // calls included, and counted so `stepsDiverged` can say so.
      const braceIdx = i + forM[0].length - 1;
      const blockClose = matchBrace(src, braceIdx);
      skipped++;
      i = blockClose >= 0 ? blockClose + 1 : braceIdx + 1;
      continue;
    }

    // const downloadN = page.waitForEvent("download", { timeout: T }); — a
    // download step's ARMING half. No step yet: the step materializes at the
    // awaiting block below, which carries the assertion. An arming nothing
    // awaits is counted as skipped at end-of-parse via the map it leaves
    // behind? No — it simply never becomes a step, which regenerates as
    // nothing: the harmless direction, since an un-awaited promise asserted
    // nothing in the original either.
    const armM = rest.match(
      /^[\s;]*const (download\d+) = page\.waitForEvent\("download", \{ timeout: (\d+) \}\);/,
    );
    if (armM) {
      pendingDownloads.set(armM[1], { timeoutMs: parseInt(armM[2], 10) });
      i += armM[0].length;
      continue;
    }

    // { const dN = await downloadN; [expect(dN.suggestedFilename()).toBe|
    // toContain(<value>);] [V.name = dN.suggestedFilename();] } — the
    // awaiting half. Consumed as one balanced block so a filename containing
    // `}` cannot end it early. Pairing is by the download variable's name;
    // an await with no recorded arming is a foreign block and counts skipped.
    // Two spellings of the same half. Standalone, the generator wraps it in
    // its own block; under continue-on-failure the wrapper's braces BECOME the
    // try's braces, and the try-recursion hands this scanner the braceless
    // body. Both must parse, or every wrapped download reads as skipped.
    const dlM = rest.match(/^[\s;]*(\{\s*)?const (d\d+) = await (download\d+);/);
    if (dlM) {
      const braced = !!dlM[1];
      const dName = dlM[2];
      const armed = pendingDownloads.get(dlM[3]);
      // The tail the optional parts are scanned from — AFTER the matched
      // const-await head in both spellings; bounded by the closing brace in
      // the braced one so a following statement can't be swallowed.
      let closeIdx = -1;
      if (braced) {
        const openIdx = i + rest.match(/^[\s;]*/)![0].length;
        closeIdx = matchBrace(src, openIdx);
        if (closeIdx < 0) {
          skipped++;
          i = i + dlM[0].length;
          continue;
        }
      }
      const inner = src.slice(i + dlM[0].length, braced ? closeIdx : src.length);
      const after = braced ? closeIdx + 1 : -1; // braceless advances piecewise
      if (!armed) {
        skipped++;
        i = braced ? after : i + dlM[0].length;
        continue;
      }
      pendingDownloads.delete(dlM[3]);
      const st: Partial<Step> = {};
      // Only a non-default timeout round-trips onto the step, so a step
      // authored without one stays without one (regeneration fixed point).
      if (armed.timeoutMs !== DEFAULT_WAIT_TIMEOUT_MS) st.timeoutMs = armed.timeoutMs;
      let consumed = 0;
      const expectM = inner.match(
        new RegExp(`^\\s*expect\\(${dName}\\.suggestedFilename\\(\\)\\)\\.(toBe|toContain)\\(`),
      );
      if (expectM) {
        const argOpen = inner.indexOf("(", expectM[0].length - 1);
        const argClose = matchParen(inner, argOpen);
        const value = argClose > argOpen ? parseValueArg(inner.slice(argOpen + 1, argClose)) : null;
        if (value === null) {
          skipped++;
          i = braced ? after : i + dlM[0].length;
          continue;
        }
        st.value = value;
        if (expectM[1] === "toBe") st.downloadMatch = "exact";
        const semi = inner.indexOf(";", argClose);
        consumed = semi >= 0 ? semi + 1 : argClose + 1;
      }
      const capM = inner
        .slice(consumed)
        .match(new RegExp(`^\\s*V\\.([A-Za-z_][A-Za-z0-9_]*) = ${dName}\\.suggestedFilename\\(\\);`));
      if (capM) {
        st.captureVar = capM[1];
        consumed += capM[0].length;
      }
      steps.push(makeStep("download", st));
      i = braced ? after : i + dlM[0].length + consumed;
      continue;
    }

    // if (<condition>) { … } — the logic layer's conditional block.
    const ifM = rest.match(/^[\s;]*if\s*\(/);
    if (ifM) {
      const openIdx = i + ifM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const afterCond = src.slice(close + 1);
      const braceIdx = afterCond.indexOf("{");
      const parsed = parseCondition(src.slice(openIdx + 1, close));
      if (parsed && braceIdx >= 0 && afterCond.slice(0, braceIdx).trim() === "") {
        steps.push(makeStep("if", parsed));
        blockStack.push("if");
        i = close + 1 + braceIdx + 1; // resume just past the opening brace
        continue;
      }
      // Foreign / unrecognized condition — skip the whole block so we never
      // emit a half-parsed `if` without its matching `endif`.
      skipped++;
      if (braceIdx >= 0) {
        const blockClose = matchBrace(src, close + 1 + braceIdx);
        i = blockClose >= 0 ? blockClose + 1 : close + 1 + braceIdx + 1;
      } else {
        i = close + 1;
      }
      continue;
    }

    // // disabled — skipped: <statement> — a disabled step emitted by
    // script-generator.ts. Parse the statement after the marker, tag it with
    // disabled: true, then advance past the line.
    const disM = rest.match(/^[\s;]*\/\/\s*disabled\s*—\s*skipped\s*:\s*/);
    if (disM) {
      const stmtStart = i + disM[0].length;
      // Find the end of the statement (next newline or `}` at the same depth).
      // The statement is a single line, so scan to the next newline.
      let nl = src.indexOf("\n", stmtStart);
      if (nl < 0) nl = src.length;
      const stmt = src.slice(stmtStart, nl).trim();
      if (stmt) {
        const innerResult = parseBody(stmt, vars);
        if (innerResult.steps.length > 0) {
          const s = innerResult.steps[0];
          s.disabled = true;
          steps.push(...innerResult.steps);
          skipped += innerResult.skipped;
        } else if (innerResult.skipped > 0) {
          // Zero steps AND zero skips means the statement was recognized but
          // isn't a step — a disabled `viewport` is commented out as TWO lines
          // (the resize and its log statement), and the second has no step of
          // its own. Only a genuinely unclassifiable statement counts here, or
          // every test with a disabled resize would report divergence.
          skipped++;
        }
      } else {
        skipped++;
      }
      i = nl;
      continue;
    }

    // try { <statement> } catch { … } — a "Continue on Failure" wrapper
    // emitted by script-generator.ts. Parse the inner statement, tag it with
    // continueOnFailure, then skip past the catch block.
    const tryM = rest.match(/^[\s;]*try\s*\{/);
    if (tryM) {
      const braceOpen = i + tryM[0].length - 1;
      const braceClose = matchBrace(src, braceOpen);
      if (braceClose < 0) {
        skipped++;
        i = braceOpen + 1;
        continue;
      }
      const inner = src.slice(braceOpen + 1, braceClose);
      const innerResult = parseBody(inner, vars, pendingDownloads);
      if (innerResult.steps.length > 0) {
        // The wrapper always encloses a single statement; tag it and push.
        const s = innerResult.steps[0];
        s.continueOnFailure = true;
        steps.push(...innerResult.steps);
        skipped += innerResult.skipped;
        // Find and skip the matching catch { … } block that follows.
        const after = src.slice(braceClose + 1);
        const catchM = after.match(/^[\s;]*catch\s*\{/);
        if (catchM) {
          const catchOpen = braceClose + 1 + after.indexOf("{", catchM[0].length - 1);
          const catchClose = matchBrace(src, catchOpen);
          i = catchClose >= 0 ? catchClose + 1 : braceClose + 1;
        } else {
          i = braceClose + 1;
        }
      } else {
        // Empty or unrecognized try body — count as skipped and move on.
        skipped++;
        const after = src.slice(braceClose + 1);
        const catchM = after.match(/^[\s;]*catch\s*\{/);
        if (catchM) {
          const catchOpen = braceClose + 1 + after.indexOf("{", catchM[0].length - 1);
          const catchClose = matchBrace(src, catchOpen);
          i = catchClose >= 0 ? catchClose + 1 : braceClose + 1;
        } else {
          i = braceClose + 1;
        }
      }
      continue;
    }

    // console.log(…) / .info / .warn / .error / .debug — diagnostics, not
    // steps. Consumed WITHOUT counting as skipped, for the same reason as the
    // variable header below: a skip sets TestRecord.stepsDiverged, and the
    // generator emits a log line after every `viewport` step, so counting it
    // would leave a permanent "your steps undercount the script" warning on
    // every test that resizes. Any console call qualifies, not just ours — a
    // log statement a user added by hand isn't a step either.
    const logM = rest.match(/^[\s;]*console\.(?:log|info|warn|error|debug)\s*\(/);
    if (logM) {
      const openIdx = i + logM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const after = src.slice(close + 1).match(/^\s*;/);
      i = close + 1 + (after ? after[0].length : 0);
      continue;
    }

    // const V = { … }; — the variable header script-generator emits. It's
    // declaration, not a step, so it's consumed WITHOUT counting as skipped:
    // a skip sets TestRecord.stepsDiverged, which warns the user their step
    // count may be wrong. Every parameterized test would carry that warning
    // forever if this were treated as an unclassifiable statement.
    const varsM = rest.match(/^[\s;]*const\s+V\s*=\s*\{/);
    if (varsM) {
      const openIdx = i + varsM[0].length - 1;
      const close = matchBrace(src, openIdx);
      if (close < 0) break;
      // Also swallow the trailing semicolon so the next iteration starts clean.
      const after = src.slice(close + 1).match(/^\s*;/);
      i = close + 1 + (after ? after[0].length : 0);
      continue;
    }

    // const <name> = page.getByRole(…); — a locator bound to a variable and
    // used further down (`await submit.click()`). This app never generates that
    // shape, but a model asked for a readable spec writes it constantly, and
    // before this branch existed BOTH halves vanished without a trace: the
    // declaration hit the locator branch below, which found no chained action
    // and counted a skip, and the later use started with neither `page.` nor a
    // builder call, so no branch claimed it and the scan walked it character by
    // character — no step AND no skip. A prompt-generated spec came back with
    // its `goto` and nothing else, and nothing on screen said why.
    //
    // Only a BARE builder call is recorded. A refined chain (`.first()`,
    // `.filter(…)`) is deliberately left unregistered and counted as a skip:
    // storing the base locator would drop the refinement and regenerate a
    // selector that matches the wrong element, which is worse than reporting
    // the divergence the user can see.
    const locVarM = rest.match(
      new RegExp(
        `^[\\s;]*const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:page\\.)?(?:getByTestId|getByRole|getByLabel|getByPlaceholder|getByText|locator)\\s*\\(`,
      ),
    );
    if (locVarM) {
      const openIdx = i + locVarM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const parsed = parseLocator(src.slice(i));
      // End of the declaration statement: its `;`, or the line's end when the
      // model omitted one. Everything between the end of the locator EXPRESSION
      // and there is a refinement chain we don't model — measured from what
      // `parseLocator` consumed rather than from the first builder's close
      // paren, so a container chain reads as part of the locator (which it is)
      // instead of as an unmodelled refinement.
      const semi = src.indexOf(";", close + 1);
      const nl = src.indexOf("\n", close + 1);
      const stmtEnd =
        semi >= 0 && (nl < 0 || semi < nl) ? semi + 1 : nl < 0 ? src.length : nl;
      const locEnd = parsed ? src.length - parsed.rest.length : close + 1;
      const tail = src.slice(locEnd, stmtEnd).replace(/[\s;]/g, "");
      if (parsed && tail === "") {
        vars.set(locVarM[1], parsed.locator);
      } else {
        skipped++;
      }
      i = stmtEnd;
      continue;
    }

    // glazeCapture(V, "name", <subject>, "from"[, "attr"]) — a capture step.
    const capM = rest.match(/^[\s;]*(?:await\s+|return\s+)?glazeCapture\s*\(/);
    if (capM) {
      const openIdx = i + capM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const argsStr = src.slice(openIdx + 1, close);
      // Args are positional and generator-emitted, so a narrow match is right:
      // anything else is a hand-written call we shouldn't half-parse.
      const argM = argsStr.match(
        /^\s*V\s*,\s*['"]([^'"]+)['"]\s*,\s*([\s\S]*?),\s*['"](text|value|attribute|url|title)['"]\s*(?:,\s*['"]([^'"]*)['"]\s*)?$/,
      );
      if (argM) {
        const subject = argM[2].trim();
        const parsedLoc = subject === "page" ? null : parseLocator(subject);
        steps.push(
          makeStep("capture", {
            captureVar: argM[1],
            captureFrom: argM[3] as Step["captureFrom"],
            ...(argM[4] ? { captureAttr: argM[4] } : {}),
            ...(parsedLoc ? { locator: parsedLoc.locator } : {}),
          }),
        );
      } else {
        skipped++;
      }
      i = close + 1;
      continue;
    }

    // glazeScrollTo(page, <x>, <y>) — a position scroll step. Same narrow
    // positional match as glazeCapture: the args are generator-emitted bare
    // numerals, and anything else is a hand-written call not worth half-parsing.
    const scrM = rest.match(/^[\s;]*(?:await\s+|return\s+)?glazeScrollTo\s*\(/);
    if (scrM) {
      const openIdx = i + scrM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const argM = src
        .slice(openIdx + 1, close)
        .match(/^\s*page\s*,\s*(\d+)\s*,\s*(\d+)\s*$/);
      if (argM) {
        steps.push(
          makeStep("scroll", {
            scrollX: parseInt(argM[1], 10),
            scrollY: parseInt(argM[2], 10),
          }),
        );
      } else {
        skipped++;
      }
      i = close + 1;
      continue;
    }

    // page.goto("…")
    const gotoM = rest.match(/^[\s;]*(?:await\s+|return\s+)?page\.goto\s*\(/);
    if (gotoM) {
      const openIdx = i + gotoM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const url = parseValueArg(src.slice(openIdx + 1, close));
      if (url !== null) steps.push(makeStep("goto", { url }));
      i = close + 1;
      continue;
    }

    // page.keyboard.press("…")
    const kbM = rest.match(/^[\s;]*(?:await\s+|return\s+)?page\.keyboard\.press\s*\(/);
    if (kbM) {
      const openIdx = i + kbM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const key = firstStringLiteral(src.slice(openIdx + 1, close));
      if (key !== null) steps.push(makeStep("press", { value: unescapeLit(key) }));
      i = close + 1;
      continue;
    }

    // page.mouse.down() / page.mouse.up() — the two halves of an `:active`
    // assertion. Neither carries a locator: `mouse.down` acts wherever the
    // cursor already is, which is where the preceding hover put it.
    const mouseM = rest.match(/^[\s;]*(?:await\s+|return\s+)?page\.mouse\.(down|up)\s*\(/);
    if (mouseM) {
      const openIdx = i + mouseM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      steps.push(
        makeStep("state", { elementState: mouseM[1] === "down" ? "press" : "release" }),
      );
      i = close + 1;
      continue;
    }

    // page.waitForTimeout(<ms>)
    const waitM = rest.match(/^[\s;]*(?:await\s+|return\s+)?page\.waitForTimeout\s*\(/);
    if (waitM) {
      const openIdx = i + waitM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const numM = src.slice(openIdx + 1, close).match(/-?\d+(?:\.\d+)?/);
      steps.push(makeStep("wait", numM ? { waitMs: parseFloat(numM[0]) } : {}));
      i = close + 1;
      continue;
    }

    // page.setViewportSize({ width: …, height: … })
    const vpM = rest.match(/^[\s;]*(?:await\s+|return\s+)?page\.setViewportSize\s*\(/);
    if (vpM) {
      const openIdx = i + vpM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const argsStr = src.slice(openIdx + 1, close);
      const wM = argsStr.match(/width\s*:\s*(\d+)/);
      const hM = argsStr.match(/height\s*:\s*(\d+)/);
      steps.push(
        makeStep("viewport", {
          ...(wM ? { width: parseInt(wM[1], 10) } : {}),
          ...(hM ? { height: parseInt(hM[1], 10) } : {}),
        }),
      );
      i = close + 1;
      continue;
    }

    // page.context().addCookies([{ … }]) → one `cookie` set step per entry.
    const addCookiesM = rest.match(
      /^[\s;]*(?:await\s+|return\s+)?page\.context\(\)\.addCookies\s*\(/,
    );
    if (addCookiesM) {
      const openIdx = i + addCookiesM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const argsStr = src.slice(openIdx + 1, close);
      const specs = parseCookieObjects(argsStr);
      if (specs.length === 0) {
        // Recognized the call but couldn't read a cookie out of it — count it
        // as skipped rather than emitting an empty step that would generate a
        // different (broken) line on the way back out.
        skipped++;
      }
      for (const spec of specs) {
        steps.push(makeStep("cookie", { cookieAction: "set", cookie: spec }));
      }
      i = close + 1;
      continue;
    }

    // page.context().clearCookies()            → clearAll
    // page.context().clearCookies({ name: … }) → delete one
    const clearCookiesM = rest.match(
      /^[\s;]*(?:await\s+|return\s+)?page\.context\(\)\.clearCookies\s*\(/,
    );
    if (clearCookiesM) {
      const openIdx = i + clearCookiesM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const argsStr = src.slice(openIdx + 1, close).trim();
      if (!argsStr) {
        steps.push(makeStep("cookie", { cookieAction: "clearAll" }));
      } else {
        const [filter] = parseCookieObjects(argsStr);
        if (filter?.name) {
          steps.push(makeStep("cookie", { cookieAction: "delete", cookie: filter }));
        } else {
          // A filtered clear we can't read (e.g. clears by domain only) is not
          // a per-cookie delete — don't misrepresent it as one.
          skipped++;
        }
      }
      i = close + 1;
      continue;
    }

    // expect(...)/expect.soft(...) — page-level (toHaveURL/toHaveTitle) or
    // locator-level (toBeVisible/toBeHidden/toContainText/toHaveText/
    // toBeEnabled/toBeDisabled/toBeChecked/.not.toBeChecked/toHaveValue/
    // toHaveAttribute/toHaveCount), mirroring script-generator.ts's assertLine.
    const expectM = rest.match(/^[\s;]*(?:await\s+|return\s+)?(expect\.soft|expect)\s*\(/);
    if (expectM) {
      const soft = expectM[1] === "expect.soft";
      const openIdx = i + expectM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const inner = src.slice(openIdx + 1, close).trim();
      const after = src.slice(close + 1);

      // A conditional wait compiles to the SAME expect call as the matching
      // assertion, so the trailing marker is the only thing that tells them
      // apart. Read off the statement's own line: the generator emits one
      // statement per line, and a hand-written expect carries no marker and
      // correctly stays an assertion.
      //
      // Anchored on `close` — the end of the `expect(…)` call — NOT on `i`.
      // `i` is wherever the previous statement stopped, which is usually before
      // the newline that precedes this one, so scanning from there finds the
      // end of the PREVIOUS line and never sees the marker.
      const nlAt = src.indexOf("\n", close);
      const lineEnd = nlAt < 0 ? src.length : nlAt;
      const isWait = /\/\/\s*wait until\s*$/.test(src.slice(close, lineEnd));

      /** Emit the step the current expect statement means: a conditional wait
       *  when the marker is present and the predicate has a wait counterpart,
       *  otherwise the assertion it has always been. `exactText`/`attribute`
       *  have no wait counterpart — the generator never marks them — so a
       *  marked one falls back to an assertion rather than being dropped. */
      const emit = (
        assert: AssertKind,
        base: Record<string, unknown>,
        extra: Record<string, unknown> = {},
      ): void => {
        const waitUntil = isWait ? ASSERT_TO_WAIT_UNTIL[assert] : undefined;
        if (waitUntil) {
          const timeoutMs = parseTimeoutOption(src.slice(close + 1, lineEnd));
          // `soft` is meaningless on a wait and is dropped with the base.
          const { locator } = base as { locator?: Locator };
          steps.push(
            makeStep("wait", {
              ...(locator ? { locator } : {}),
              waitUntil,
              ...(timeoutMs !== null ? { timeoutMs } : {}),
              ...extra,
            }),
          );
        } else {
          steps.push(makeStep("assert", { ...base, assert, ...extra }));
        }
      };

      if (inner === "page") {
        const pageAssertM = after.match(/^\s*\.(toHaveURL|toHaveTitle)\s*\(/);
        if (pageAssertM) {
          const aOpen = close + 1 + after.indexOf("(", pageAssertM[0].length - 1);
          const aClose = matchParen(src, aOpen);
          if (aClose >= 0) {
            const argStr = src.slice(aOpen + 1, aClose).trim();
            // A RegExp argument means the generator embedded the user's literal
            // value in a pattern, and the anchors say which kind it was:
            // `^…$` exact, `…$` ends-with, bare substring. Both matchers use
            // the shape now — a bare `toHaveURL(string)` is an EXACT whole-URL
            // check, so "URL contains" cannot be written that way.
            const reM = argStr.match(/^new\s+RegExp\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*(?:,\s*"(?:[^"\\]|\\.)*"\s*)?\)/);
            if (reM) {
              const pattern = unescapeLit(reM[1].slice(1, -1));
              // "URL path is" first: its pattern is structural — it starts
              // with `^` and ends with `$` INSIDE an alternation, so the
              // anchored-start/anchored-end classification below would file it
              // as `urlIs` and store the whole pattern as the value. The
              // prefix and suffix are `urlPathPattern`'s, verbatim; only the
              // generator writes this shape, because `reEscape` would escape
              // these metacharacters in any literal value.
              const PATH_PREFIX = "^[a-z][a-z0-9+.-]*://[^/?#]*";
              const PATH_SUFFIX = "/?(?:[?#]|$)";
              if (
                pageAssertM[1] === "toHaveURL" &&
                pattern.startsWith(PATH_PREFIX) &&
                pattern.endsWith(PATH_SUFFIX)
              ) {
                const middle = pattern.slice(PATH_PREFIX.length, pattern.length - PATH_SUFFIX.length);
                // An empty middle is the site root — the pattern spells "/" as
                // nothing, so reading it back must restore the "/".
                emit(
                  "urlPathIs",
                  { ...(soft ? { soft: true } : {}) },
                  { value: middle === "" ? "/" : reUnescape(middle) },
                );
                i = isWait ? lineEnd : aClose + 1;
                continue;
              }
              const anchoredStart = pattern.startsWith("^");
              const anchoredEnd = pattern.endsWith("$");
              const isUrl = pageAssertM[1] === "toHaveURL";
              const assert: AssertKind = isUrl
                ? anchoredStart && anchoredEnd
                  ? "urlIs"
                  : anchoredEnd
                    ? "urlEndsWith"
                    : "url"
                : anchoredStart && anchoredEnd
                  ? "title"
                  : "titleContains";
              const bare = pattern.replace(/^\^/, "").replace(/\$$/, "");
              // ALWAYS unescape, not just for a conditional wait.
              //
              // The step stores the user's literal substring; the generator
              // escapes it into a pattern. Reading a pattern back without
              // undoing that escape stores `example\.com`, and the NEXT
              // generation escapes the backslash too — so every hand edit and
              // every applied AI fix pushed the value one escape further from
              // what the user typed, until the assertion could not match
              // anything. `urlEndsWith` and `urlIs` had been drifting this way
              // since they were written; only the wait path was ever correct,
              // and only because it was the only one passing `isWait`.
              emit(assert, { ...(soft ? { soft: true } : {}) }, { value: reUnescape(bare) });
              i = isWait ? lineEnd : aClose + 1;
              continue;
            }
            const value = parseValueArg(argStr);
            // A plain string reaching here is an EXACT whole-value match, which
            // is `urlIs` for a URL and `title` for a title. Reading it back as
            // `url` was the parser agreeing with the generator's old bug: it
            // round-tripped perfectly and preserved an assertion that could not
            // pass, which is how the check suite stayed green over it.
            const assert: AssertKind = pageAssertM[1] === "toHaveURL" ? "urlIs" : "title";
            emit(
              assert,
              { ...(soft ? { soft: true } : {}) },
              value !== null
                ? { value: isWait ? reUnescape(unescapeLit(value)) : unescapeLit(value) }
                : {},
            );
            i = isWait ? lineEnd : aClose + 1;
            continue;
          }
        }
        skipped++;
        i = close + 1;
        continue;
      }

      // `expect(submit)` — the subject is a locator held in a variable, which
      // reads exactly like `expect(page.getByRole(…))` once resolved.
      const varLocator = vars.get(inner);
      const locParse = varLocator ? { locator: varLocator } : parseLocator(inner);
      if (locParse) {
        const base = { locator: locParse.locator, ...(soft ? { soft: true } : {}) };

        const notM = after.match(/^\s*\.not\s*\.(toBeChecked)\s*\(/);
        if (notM) {
          const aOpen = close + 1 + after.indexOf("(", notM[0].length - 1);
          const aClose = matchParen(src, aOpen);
          if (aClose >= 0) {
            emit("unchecked", base);
            i = isWait ? lineEnd : aClose + 1;
            continue;
          }
        }

        const assertM = after.match(
          /^\s*\.(toBeVisible|toBeHidden|toContainText|toHaveText|toBeEnabled|toBeDisabled|toBeChecked|toHaveValue|toHaveAttribute|toHaveCount|toHaveCSS)\s*\(/,
        );
        if (assertM) {
          const method = assertM[1];
          const aOpen = close + 1 + after.indexOf("(", assertM[0].length - 1);
          const aClose = matchParen(src, aOpen);
          if (aClose >= 0) {
            const argsStr = src.slice(aOpen + 1, aClose);
            switch (method) {
              case "toBeVisible":
                emit("visible", base);
                break;
              case "toBeHidden":
                emit("hidden", base);
                break;
              case "toBeEnabled":
                emit("enabled", base);
                break;
              case "toBeDisabled":
                emit("disabled", base);
                break;
              case "toBeChecked":
                emit("checked", base);
                break;
              case "toContainText": {
                const text = parseValueArg(argsStr);
                emit("text", base, text !== null ? { text: unescapeLit(text) } : {});
                break;
              }
              case "toHaveText": {
                const text = parseValueArg(argsStr);
                emit("exactText", base, text !== null ? { text: unescapeLit(text) } : {});
                break;
              }
              case "toHaveValue": {
                const value = parseValueArg(argsStr);
                emit("value", base, value !== null ? { value: unescapeLit(value) } : {});
                break;
              }
              case "toHaveAttribute": {
                const m2 = argsStr.match(/['"`]([^'"`\n]*)['"`]\s*,\s*['"`]([^'"`\n]*)['"`]/);
                emit(
                  "attribute",
                  base,
                  m2 ? { attr: unescapeLit(m2[1]), value: unescapeLit(m2[2]) } : {},
                );
                break;
              }
              case "toHaveCount": {
                const numM = argsStr.match(/-?\d+/);
                emit("count", base, numM ? { count: parseInt(numM[0], 10) } : {});
                break;
              }
              case "toHaveCSS": {
                // Two shapes, and the second argument is what tells them apart:
                //   ("color", "rgb(1, 2, 3)")            → cssMatch "is"
                //   ("color", new RegExp("rgb\\(1", "i")) → cssMatch "contains"
                // The regex arm is checked FIRST because a literal-string match
                // would also match the quoted pattern inside `new RegExp(...)`
                // and silently downgrade every `contains` assert to an `is`
                // against a regex source — which then fails at run time against
                // a value it looks like it should match.
                const reM = argsStr.match(
                  /['"`]([^'"`\n]*)['"`]\s*,\s*new\s+RegExp\s*\(\s*['"`]([^'"`\n]*)['"`]/,
                );
                if (reM) {
                  emit("css", base, {
                    cssProp: unescapeLit(reM[1]),
                    cssMatch: "contains",
                    // Always unescape: the generator regex-escaped this on the
                    // way out, so leaving it escaped would re-escape it on the
                    // next regeneration and the pattern would drift a backslash
                    // further from the value on every round trip.
                    value: reUnescape(unescapeLit(reM[2])),
                  });
                  break;
                }
                const m3 = argsStr.match(/['"`]([^'"`\n]*)['"`]\s*,\s*['"`]([^'"`\n]*)['"`]/);
                emit(
                  "css",
                  base,
                  m3
                    ? { cssProp: unescapeLit(m3[1]), cssMatch: "is", value: unescapeLit(m3[2]) }
                    : {},
                );
                break;
              }
            }
            i = isWait ? lineEnd : aClose + 1;
            continue;
          }
        }
        // Locator resolved but the assert method isn't one we round-trip.
        skipped++;
      } else {
        // The subject is neither `page`, a locator, nor a locator variable —
        // `expect(userLocation).toBeDefined()` over a plain JS value. There is
        // no step for it, and staying silent here made a prompt-generated spec
        // report a step count that matched nothing in the file.
        skipped++;
      }
      i = close + 1;
      continue;
    }

    // page.<locator>.<action>(...)  (page. prefix optional)
    const locM = rest.match(/^[\s;]*(?:await\s+|return\s+)?(?:page\.)?(getByTestId|getByRole|getByLabel|getByPlaceholder|getByText|locator)\s*\(/);
    if (locM) {
      // Find the locator builder's matching close paren in `src`.
      const locOpen = i + locM[0].length - 1;
      const locClose = matchParen(src, locOpen);
      if (locClose < 0) break;
      // Hand `parseLocator` the whole remaining source and let IT say where the
      // locator ends, rather than slicing to the first builder's close paren and
      // hoping nothing follows.
      //
      // This used to slice, and allow exactly one known continuation after the
      // slice — `.nth(k)` — because that was the only thing the generator
      // emitted between the builder and the action. Every other continuation
      // left `after` starting at `.getByRole(`, which matches no action shape,
      // so the statement fell through to `skipped++` and the step vanished.
      // Element context emits three more (`.filter()`, a chained builder, and
      // `.and()`), so the fix is to stop enumerating them here: the locator
      // grammar lives in one place, and the caller asks how much it consumed.
      //
      // `parsed.rest` is the remainder of the FILE, not of the statement — only
      // its start is ever matched against, so that is exactly what is wanted.
      const parsed = parseLocator(src.slice(i));
      if (parsed) {
        const locEnd = src.length - parsed.rest.length - 1;
        const after = parsed.rest;
        const actionM = after.match(new RegExp(`^\\s*\\.(${LOCATOR_ACTION_RE})\\s*\\(`));
        if (actionM) {
          const action = actionM[1];
          const aOpen = locEnd + 1 + after.indexOf("(", actionM[0].length - 1);
          const aClose = matchParen(src, aOpen);
          if (aClose >= 0) {
            const step = locatorActionStep(parsed.locator, action, src.slice(aOpen + 1, aClose));
            if (step) steps.push(step);
            else skipped++;
            i = aClose + 1;
            continue;
          }
        }
        // Locator resolved but chained to an action we don't round-trip
        // (e.g. .hover(), .dblclick()) — count it as a skip.
        skipped++;
      } else {
        // `parseLocator` REFUSED this statement — a refinement it will not read
        // as a bare locator, today `.filter()` on the target. This branch only
        // runs when `locM` already matched a builder call, so we know it is a
        // locator statement, and a locator statement that yields no step must
        // yield a skip.
        //
        // Without this the statement produces no step AND no skip, which is the
        // exact combination the `const <name> = page.…` branch above documents
        // as the worst outcome: the spec silently loses a step and the count
        // that exists to say so agrees that nothing was lost.
        skipped++;
      }
      // Couldn't classify — skip past the locator's close paren to avoid a loop.
      i = locClose + 1;
      continue;
    }

    // <name>.<action>(...) — acting on a locator held in a variable. Only a
    // name declared by the branch above resolves; anything else is a method
    // call on something we have no locator for, and it is COUNTED rather than
    // walked past, because a click that leaves no trace at all is the failure
    // `skipped` exists to surface. `page.` is excluded so the generic fallback
    // below keeps ownership of the legacy `page.click(selector)` API.
    const varActionM = rest.match(
      new RegExp(`^[\\s;]*(?:await\\s+|return\\s+)?([A-Za-z_$][\\w$]*)\\s*\\.(${LOCATOR_ACTION_RE})\\s*\\(`),
    );
    if (varActionM && varActionM[1] !== "page") {
      const aOpen = i + varActionM[0].length - 1;
      const aClose = matchParen(src, aOpen);
      if (aClose < 0) break;
      const locator = vars.get(varActionM[1]);
      const step = locator
        ? locatorActionStep(locator, varActionM[2], src.slice(aOpen + 1, aClose))
        : null;
      if (step) steps.push(step);
      else skipped++;
      i = aClose + 1;
      continue;
    }

    // Nothing matched. If this looks like an action statement we should have
    // recognized (a `page.<method>(...)` call not covered above), count it as
    // skipped and jump to the next top-level `;` instead of limping forward one
    // character at a time and re-triggering this check per char.
    //
    // NESTED paths (`page.mouse.move`, `page.keyboard.down`, `page.clock.*`)
    // match too. They did not before, and the consequence was worse than a
    // miscount: no branch claimed them and no fallback caught them, so the scan
    // walked them character by character and they contributed neither a step
    // NOR a skip. The statement simply vanished on the next `tests:updateScript`
    // resync, taking its behaviour out of the test with nothing on screen
    // saying so — the exact failure `skipped` exists to make visible.
    const skipM = rest.match(/^[\s;]*(?:await\s+|return\s+)?page\.\w+(?:\.\w+)*\s*\(/);
    if (skipM) {
      skipped++;
      // Start scanning just past the call's opening paren (depth 1) so a
      // leftover trailing `;` from the *previous* statement — still sitting
      // at `i` because every branch above stops right after its own close
      // paren, before its `;` — isn't mistaken for this statement's end.
      let depth = 1;
      let j = i + skipM[0].length;
      for (; j < src.length; j++) {
        const c = src[j];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === ";" && depth <= 0) {
          j++;
          break;
        }
      }
      i = j;
      continue;
    }

    i++;
  }

  return { steps, skipped };
}

/**
 * Extract the combined body of every `test("…", …)` callback in the file.
 * `test.describe(...)` and `test.beforeEach(...)` are skipped — only the
 * actual test bodies contribute steps.
 */
function extractTestBodies(src: string): string[] {
  const clean = stripComments(src);
  const bodies: string[] = [];
  const testRe = /\btest(?:\.\w+)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = testRe.exec(clean)) !== null) {
    // Skip test.skip / test.fixme / test.describe — they don't run steps.
    //
    // `test.step` is in the list for the opposite reason: its body DOES run
    // steps, but it sits INSIDE a `test(...)` body that was already extracted,
    // and the scan loop walks straight through the wrapper. Matching it here
    // extracted the same statements a second time, so every spec built out of
    // `await test.step("…", async () => { … })` — the shape a model reaches for
    // whenever it is also writing readable comments — came back with each of
    // its steps duplicated.
    if (/test\.(skip|fixme|describe|step|beforeEach|beforeAll|afterEach|afterAll)\b/.test(m[0])) {
      continue;
    }
    // Find the callback body. The callback is an arrow or function expression
    // passed as the last arg, e.g. `test("…", async ({ page }) => { … })`.
    // Skip past the `=>` (or `function`) so the arrow's destructuring braces
    // like `({ page })` aren't mistaken for the body, then take the first
    // balanced `{ ... }` as the body.
    const arrowIdx = clean.indexOf("=>", m.index);
    const fnIdx = arrowIdx >= 0 ? arrowIdx : clean.indexOf("function", m.index);
    if (fnIdx < 0) continue;
    const braceStart = clean.indexOf("{", fnIdx);
    if (braceStart < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < clean.length; i++) {
      const ch = clean[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end >= 0) bodies.push(clean.slice(braceStart + 1, end));
  }
  return bodies;
}

/**
 * Parse a Playwright spec file's source into the app's Step[] model.
 * Returns [] if nothing could be parsed — the caller then falls back to a
 * stepless (script-only) import.
 */
export function parseSpec(source: string): Step[] {
  return parseSpecDetailed(source).steps;
}

/**
 * Same as parseSpec, but also reports how many statements looked like
 * actions/assertions the parser should round-trip but couldn't classify.
 * `skipped > 0` means the returned steps are an undercount relative to the
 * script — callers that treat steps as authoritative (e.g. resyncing after
 * a script edit) should surface that instead of trusting the count silently.
 */
export function parseSpecDetailed(source: string): { steps: Step[]; skipped: number } {
  const bodies = extractTestBodies(source);
  if (bodies.length === 0) return { steps: [], skipped: 0 };
  const steps: Step[] = [];
  let skipped = 0;
  for (const body of bodies) {
    const result = parseBody(body);
    steps.push(...result.steps);
    skipped += result.skipped;
  }
  return { steps, skipped };
}
