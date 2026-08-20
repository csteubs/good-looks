// Classify and lint a hand-typed locator for the custom-locator field.
//
// Two locator kinds — `css` and `xpath` — have been first-class in the model,
// the generator, the parser and the heal keys since the beginning; what never
// existed was a way to TYPE one (DECISIONS 7491 removed the original free-text
// input in favour of the picker). The custom field brings typing back as the
// last resort under the candidates, and this module is its gatekeeper.
//
// The gate matters because of what the trainer PROMISES about a locator: a
// live match count evaluated by the in-page oracle (`matchesForBase`), which
// evaluates CSS with `querySelectorAll` and XPath with `document.evaluate`.
// Playwright's own selector language is bigger than both — engines (`text=`),
// chaining (`>>`), and Playwright-only pseudo-classes (`:has-text(...)`) all
// work at run time but are invisible to the oracle, which would report a
// confident, wrong count. Those are REFUSED with directions rather than
// accepted and miscounted: an honest "can't do that here" beats a number that
// lies. (See the memo rationale: oracle-vs-run disagreement is this repo's
// most documented failure class.)
//
// Pure string logic, no DOM — syntax validation needs a live `document` and
// lives in the field component. Tested in custom-locator.test.ts (node).

import type { Locator } from "./recorder-types";

export type CustomLocatorParse =
  | { ok: true; loc: Locator }
  | { ok: false; error: string };

/** Playwright selector-engine prefixes the oracle cannot evaluate. `xpath=` is
 *  the one exception — it maps onto the model's own `xpath` kind. */
const ENGINE_PREFIX = /^(text|role|id|data-testid|css|nth|visible|internal:[a-z-]+)\s*=/i;

/** Playwright-only CSS extensions: valid in a generated spec, invisible to
 *  `querySelectorAll`, so a count here would be wrong rather than missing. */
const PW_PSEUDO = /:(has-text|text|text-is|text-matches|visible|nth-match|light|near|right-of|left-of|above|below)\(/i;
const PW_PSEUDO_BARE = /:visible(?![\w(-])/i;

export function classifyCustomLocator(input: string): CustomLocatorParse {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Type a CSS selector, or an XPath starting with // or xpath=." };

  if (raw.includes(">>")) {
    return {
      ok: false,
      error:
        "Playwright chaining (>>) isn't supported here — use an Inside clause in the context section for container relationships.",
    };
  }

  const xpathPrefixed = raw.match(/^xpath\s*=\s*(.*)$/is);
  if (xpathPrefixed) {
    const expr = xpathPrefixed[1].trim();
    if (!expr) return { ok: false, error: "xpath= needs an expression after it." };
    return { ok: true, loc: { k: "xpath", v: expr } };
  }

  if (ENGINE_PREFIX.test(raw)) {
    return {
      ok: false,
      error:
        "Playwright engine selectors (text=, role=, …) aren't supported here — the picker's candidates cover those kinds. Plain CSS and xpath= work.",
    };
  }

  // `//…` and `(//…)` are how people actually paste XPath; accept both without
  // demanding the prefix.
  if (raw.startsWith("//") || raw.startsWith("(//")) {
    return { ok: true, loc: { k: "xpath", v: raw } };
  }

  if (PW_PSEUDO.test(raw) || PW_PSEUDO_BARE.test(raw)) {
    return {
      ok: false,
      error:
        "That pseudo-class is Playwright-only — the trainer can't count matches for it. Use standard CSS here, or pick the element and add a Text clause instead.",
    };
  }

  return { ok: true, loc: { k: "css", v: raw } };
}

/** Advisory warnings for a locator that will work but probably not for long.
 *  Straight from the guidance the feature was modelled on: selectors copied
 *  out of DevTools are position-heavy and build-hashed, and break on the next
 *  deploy. Never blocking — the user may know something we don't. */
export function lintCustomLocator(loc: Locator): string[] {
  const v = loc.v ?? "";
  const warnings: string[] = [];

  if (loc.k === "css") {
    const positional = (v.match(/:nth-(?:child|of-type)\(/g) ?? []).length;
    if (positional >= 2) {
      warnings.push(
        "Two or more :nth-child/:nth-of-type hops pin this to the page's current shape — it breaks when anything reorders. Prefer the picker's candidates.",
      );
    }
    if (/\.(?:css|sc|jss|emotion)-[A-Za-z0-9_-]+/.test(v) || /\.[A-Za-z][\w-]*__[\w-]+--[\w-]+/.test(v) || /\.[A-Za-z][\w-]*_[A-Za-z0-9]{5,}\b/.test(v)) {
      warnings.push(
        "That class name looks build-generated — it changes on the next deploy. Selectors copied from DevTools usually carry these.",
      );
    }
    const depth = v.split(/\s*>\s*|\s+/).filter(Boolean).length;
    if (depth >= 5) {
      warnings.push(
        "A path this deep depends on every layer of markup between here and the target. Shorter selectors survive refactors better.",
      );
    }
  }

  if (loc.k === "xpath") {
    const positional = (v.match(/\[\d+\]/g) ?? []).length;
    if (positional >= 2) {
      warnings.push(
        "Two or more [n] indexes make this a positional path — it breaks when anything reorders. Prefer the picker's candidates.",
      );
    }
  }

  return warnings;
}
