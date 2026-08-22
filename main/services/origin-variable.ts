// Turn a test's baked-in site address into a variable it can be re-pointed by.
//
// ── The problem this solves ────────────────────────────────────────────────
// A recorded test navigates to an ABSOLUTE URL, because the recorder watched it
// happen: `page.goto("https://shop.example.com/cart")`. Playwright's
// `use.baseURL` resolves RELATIVE paths only, so the base-URL machinery this
// app already has cannot re-point a recorded test at a staging host or a PR
// preview — verified against the real CLI, not assumed. Sixty tests against a
// preview URL therefore meant sixty hand edits.
//
// What DOES re-point a recorded test is already here and proven: `${name}`
// interpolation. `mapInterpolatable` defines which fields interpolate, the
// generator substitutes declared names through `valueExpr`, and a dataset row
// or `GLAZE_VARS` supplies the value per run. The only thing missing was the
// edit itself — declare a variable holding the origin, and rewrite every URL on
// that origin to reference it.
//
// ── Why the rewrite goes through `mapInterpolatable` ───────────────────────
// Because a URL is not only in `goto`. It is in URL assertions and waits, in
// `if urlContains` conditions, and in API-request steps. That traversal is
// "the single definition of which fields interpolate" — using it means the
// fields this rewrites and the fields the generator will substitute cannot
// drift apart. Rewriting a hand-picked list would leave an assertion pinned to
// production while the navigation moved, which fails in the confusing
// direction: the run goes to the preview and then asserts it is somewhere else.
//
// ── What counts as "a URL on this origin" ──────────────────────────────────
// The text must START with the origin and continue with nothing, `/`, `?` or
// `#`. Two things that rules out, both of which a bare `startsWith` would
// wrongly rewrite: `https://shop.example.commerce.test` (a different host that
// shares a prefix), and a text assertion that merely mentions the address in
// the middle of a sentence. A value the user typed that IS the address still
// rewrites, which is what someone re-pointing a suite wants.

import {
  isValidVariableName,
  mapInterpolatable,
  type Step,
  type TestVariable,
} from "../recorder/types.js";

/** The variable a test gets when nothing is chosen. Uppercase because it names
 *  an environment-ish value and reads as one in `${SITE_URL}/cart`. */
export const DEFAULT_ORIGIN_VARIABLE = "SITE_URL";

/** An origin found in a test, and how many of its fields carry it. The count is
 *  what lets the UI say "12 places" rather than asking the user to trust it. */
export interface OriginUsage {
  origin: string;
  count: number;
}

/**
 * The origin of a URL, or null.
 *
 * `URL.origin` rather than a regex: it normalises case and the default port, so
 * `https://Shop.Example.com:443/` and `https://shop.example.com/` are one
 * origin rather than two entries the user has to pick between.
 */
export function originOf(text: string): string | null {
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.origin;
  } catch {
    return null;
  }
}

/** Whether `text` is a URL sitting on `origin` — see the header for the two
 *  cases the boundary check rules out. */
export function isOnOrigin(text: string, origin: string): boolean {
  if (!text.startsWith(origin)) return false;
  const rest = text.slice(origin.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#");
}

/**
 * Every origin the steps refer to, the test's OWN site first.
 *
 * Counts FIELDS, not steps: one step can carry a URL in more than one place,
 * and the number the UI shows should be the number of edits about to happen.
 *
 * `preferred` is the origin of the test's own URL, and it wins over the raw
 * count. Without it a test of docs.example.com that happens to call
 * api.example.com twice offers to re-point the API host — which is not what
 * "the site address" means to the person reading it, and is a rewrite they
 * would have to undo. Caught by looking at a real test in the preview, where
 * the two were tied and alphabetical order put the API first.
 *
 * Otherwise most-used first, ties broken alphabetically so the list does not
 * reshuffle between renders of the same test.
 */
export function originsIn(steps: readonly Step[], preferred?: string | null): OriginUsage[] {
  const counts = new Map<string, number>();
  for (const step of steps) {
    for (const text of interpolatableTexts(step)) {
      const origin = originOf(text);
      if (origin && isOnOrigin(text, origin)) {
        counts.set(origin, (counts.get(origin) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([origin, count]) => ({ origin, count }))
    .sort((a, b) => {
      if (preferred) {
        if (a.origin === preferred && b.origin !== preferred) return -1;
        if (b.origin === preferred && a.origin !== preferred) return 1;
      }
      return b.count - a.count || a.origin.localeCompare(b.origin);
    });
}

/** Read every interpolatable field of a step. Goes through the same traversal
 *  the rewrite uses, so a count and an edit cannot disagree. */
function interpolatableTexts(step: Step): string[] {
  const out: string[] = [];
  mapInterpolatable(step, (text) => {
    out.push(text);
    return text;
  });
  return out;
}

export interface ParameteriseResult {
  steps: Step[];
  variables: TestVariable[];
  /** How many fields were rewritten. Zero means nothing matched — the caller
   *  should say so rather than reporting a successful no-op. */
  rewritten: number;
  /** True when the variable already existed and was reused rather than added. */
  reusedVariable: boolean;
}

/**
 * Declare `name` holding `origin`, and point every URL on that origin at it.
 *
 * IDEMPOTENT. A second run finds no remaining literal on that origin and
 * rewrites nothing, because the first pass replaced them all with `${name}` —
 * which is not a URL and so does not match. That matters: this is reachable
 * from a button, and a user who clicks twice must not get `${SITE}${SITE}/cart`.
 *
 * REUSES an existing variable of the same name rather than adding a duplicate.
 * Two entries with one name is a spec whose `V` object silently keeps the last
 * one, so the safe move is to leave the existing declaration alone — including
 * its value, which the user may have deliberately pointed somewhere else.
 *
 * Throws on an invalid name. The name lands in generated source as an
 * identifier, so this is a boundary, not a preference — the same rule
 * `isValidVariableName` enforces everywhere else a name is accepted.
 */
export function parameteriseOrigin(
  steps: readonly Step[],
  variables: readonly TestVariable[],
  origin: string,
  name: string = DEFAULT_ORIGIN_VARIABLE,
): ParameteriseResult {
  if (!isValidVariableName(name)) {
    throw new Error(`"${name}" is not a valid variable name.`);
  }
  if (!originOf(origin) || originOf(origin) !== origin) {
    throw new Error(`"${origin}" is not a site address this can rewrite.`);
  }

  let rewritten = 0;
  const nextSteps = steps.map((step) =>
    mapInterpolatable(step, (text) => {
      if (!isOnOrigin(text, origin)) return text;
      rewritten++;
      return "${" + name + "}" + text.slice(origin.length);
    }),
  );

  const existing = variables.find((v) => v.name === name);
  const nextVariables = existing
    ? [...variables]
    : [
        ...variables,
        {
          name,
          kind: "plain" as const,
          value: origin,
          description: "The site address this test runs against.",
        },
      ];

  return {
    steps: nextSteps,
    variables: nextVariables,
    rewritten,
    reusedVariable: Boolean(existing),
  };
}
