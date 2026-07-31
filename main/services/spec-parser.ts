// Best-effort parser that reads a Playwright spec file's source and extracts
// the actions inside its `test(...)` bodies as the app's Step[] model — the
// reverse of script-generator.ts. Used by the import flow so imported tests
// show their steps in the Steps view (and only fall back to the Script view
// when no steps could be parsed).
//
// This is a pragmatic line-by-line parser, not a full TS parser. It strips
// comments, then walks the body of each `test(...)`/`test.describe(...)` block
// looking for the Playwright calls the recorder itself emits (page.goto,
// getByRole/getByLabel/.../locator(...).click/.fill/.selectOption/.check/
// .uncheck/.press, and expect(...).toBeVisible/.toContainText). Anything it
// can't classify is silently skipped — the verbatim script is still the
// runnable artifact, so unrecognized lines don't break anything.

import { randomUUID } from "crypto";

import type { AssertKind, Locator, LocatorKind, Step, StepType } from "../recorder/types.js";

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

/** Pull the first string-literal argument out of `fn("x"…)` / `fn('x'…)` / `fn(`x`…)`. */
function firstStringLiteral(s: string): string | null {
  const m = s.match(/['"`]([^'"`\n]*)['"`]/);
  return m ? m[1] : null;
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

/**
 * Parse a Playwright locator expression starting at `expr` and return the
 * modeled Locator plus the remainder of the string (the action tail).
 * Recognizes getByTestId / getByRole / getByLabel / getByPlaceholder /
 * getByText / locator(...) chains. Returns null if no locator is found.
 */
function parseLocator(expr: string): { locator: Locator; rest: string } | null {
  // Match the first locator-builder call.
  const m = expr.match(
    /(?:page\.)?(getByTestId|getByRole|getByLabel|getByPlaceholder|getByText|locator)\s*\(/,
  );
  if (!m) return null;
  const kind = m[1];
  const openIdx = expr.indexOf("(", m.index);
  // Find the matching close paren of the builder call.
  let depth = 0;
  let end = -1;
  for (let i = openIdx; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const argsStr = expr.slice(openIdx + 1, end);
  let locator: Locator;
  if (kind === "getByRole") {
    // parseRoleOptions regex-anchors on `getByRole(...)`, so pass the whole
    // expression (which contains the builder call), not the args-only slice.
    const { role, name } = parseRoleOptions(expr);
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
  return { locator, rest: expr.slice(end + 1) };
}

function makeStep(type: StepType, partial: Partial<Step>): Step {
  return {
    id: randomUUID(),
    type,
    timestamp: 0,
    ...partial,
  } as Step;
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

/** Parse the body of a single test callback into steps. */
function parseBody(body: string): Step[] {
  const steps: Step[] = [];
  const src = stripComments(body);

  // A single forward scan. At each position we test the known call shapes;
  // when one matches we consume the whole balanced call (and, for expect/locator,
  // the chained `.action(...)` call that follows) before advancing.
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);

    // page.goto("…")
    const gotoM = rest.match(/^[\s;]*(?:await\s+|return\s+)?page\.goto\s*\(/);
    if (gotoM) {
      const openIdx = i + gotoM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const url = firstStringLiteral(src.slice(openIdx + 1, close));
      if (url !== null) steps.push(makeStep("goto", { url: unescapeLit(url) }));
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

    // expect(page.<locator>).toBeVisible() / .toContainText("…")
    const expectM = rest.match(/^[\s;]*(?:await\s+|return\s+)?expect\s*\(/);
    if (expectM) {
      const openIdx = i + expectM[0].length - 1;
      const close = matchParen(src, openIdx);
      if (close < 0) break;
      const inner = src.slice(openIdx + 1, close).trim();
      const locParse = parseLocator(inner);
      // The assert call follows immediately: `.toBeVisible()` or `.toContainText("…")`.
      const after = src.slice(close + 1);
      const assertM = after.match(/^\s*\.(toBeVisible|toContainText)\s*\(/);
      if (locParse && assertM) {
        const isText = assertM[1] === "toContainText";
        let text: string | null = null;
        if (isText) {
          const aOpen = close + 1 + after.indexOf("(", assertM[0].length - 1);
          const aClose = matchParen(src, aOpen);
          if (aClose >= 0) {
            text = firstStringLiteral(src.slice(aOpen + 1, aClose));
            // advance past the assert call too
            const finalClose = aClose;
            const assert: AssertKind = "text";
            steps.push(
              makeStep("assert", {
                locator: locParse.locator,
                assert,
                ...(text !== null ? { text: unescapeLit(text) } : {}),
              }),
            );
            i = finalClose + 1;
            continue;
          }
        } else {
          steps.push(makeStep("assert", { locator: locParse.locator, assert: "visible" }));
          // toBeVisible() has no args; advance past its close paren
          const aOpen = close + 1 + after.indexOf("(", assertM[0].length - 1);
          const aClose = matchParen(src, aOpen);
          i = aClose < 0 ? src.length : aClose + 1;
          continue;
        }
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
      // Parse the locator from the whole statement prefix (from `i`, which
      // includes the `await page.getByRole(...)` text) — parseLocator's regex
      // anchors on the builder name, so it needs the name, not just the args
      // slice that starts at the open paren.
      const parsed = parseLocator(src.slice(i, locClose + 1));
      if (parsed) {
        const after = src.slice(locClose + 1);
        const actionM = after.match(/^\s*\.(click|fill|selectOption|check|uncheck|press)\s*\(/);
        if (actionM) {
          const action = actionM[1];
          const aOpen = locClose + 1 + after.indexOf("(", actionM[0].length - 1);
          const aClose = matchParen(src, aOpen);
          if (aClose >= 0) {
            const typeMap: Record<string, StepType> = {
              click: "click",
              fill: "fill",
              selectOption: "select",
              check: "check",
              uncheck: "uncheck",
              press: "press",
            };
            const value = firstStringLiteral(src.slice(aOpen + 1, aClose));
            steps.push(
              makeStep(typeMap[action], {
                locator: parsed.locator,
                ...(value !== null ? { value: unescapeLit(value) } : {}),
              }),
            );
            i = aClose + 1;
            continue;
          }
        }
      }
      // Couldn't classify — skip past the locator's close paren to avoid a loop.
      i = locClose + 1;
      continue;
    }

    i++;
  }

  return steps;
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
    if (/test\.(skip|fixme|describe|beforeEach|beforeAll|afterEach|afterAll)\b/.test(m[0])) {
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
  const bodies = extractTestBodies(source);
  if (bodies.length === 0) return [];
  const steps: Step[] = [];
  for (const body of bodies) {
    steps.push(...parseBody(body));
  }
  return steps;
}
