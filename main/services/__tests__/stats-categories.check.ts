// The Stats category board's three structural contracts.
//
// docs/plans/stats-categories.md §8. Source-level, like check:text-color and
// check:scroll-layout, and for the same reason all three are: none of what it
// pins is observable from a rendered test. Two of the three are about code that
// must NOT exist, and you cannot render the absence of something.
//
// WHAT IT PINS, and the failure each one prevents:
//
//  1. THE REGISTRY IS THE ONLY LIST. Every category has a tile, a route and a
//     breadcrumb label because every one of those reads `CATEGORIES`. The bug
//     this makes impossible is a category that exists in one place and not the
//     others — added to the registry, forgotten in the router, and reachable
//     from a tile that lands on "no such category".
//
//  2. NO CROSS-CATEGORY ARITHMETIC. Categories are not commensurable:
//     fourteen unaccepted accessibility steps, three flaky tests and nine
//     healed locators are different units, and a total across them is a number
//     that means nothing while looking authoritative. The verdict band is the
//     most natural place in the whole design for someone to introduce one —
//     "2 categories need attention" is one small edit away from "17 issues" —
//     and nothing else in the toolchain would object.
//
//  3. STATS REPORTS; HEALS AND VISUAL ACT. No accept, revert, delete or clear
//     is reachable from a Stats surface. The second time someone wants to
//     accept a heal from a chart they will simply add the button, and the
//     screen becomes a worse copy of the Heals view.
//
// Run with: npm run check:stats-categories

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { CATEGORIES, FACET_LABELS } from "../../../renderer/lib/stats-categories.js";

const root = process.cwd();
const STATS_DIR = join(root, "renderer/main/stats");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Every file the board and its dashboards are made of, minus their tests —
 *  a test may legitimately name a mutation it is asserting the absence of. */
const sources = walk(STATS_DIR).filter((f) => !/\.test\.tsx?$/.test(f));

// The scanner can see something. A glob that stops matching harvests nothing,
// and every assertion below would then pass vacuously.
assert(sources.length > 0, `found ${sources.length} Stats source files to check`);
assert(CATEGORIES.length > 0, `the registry declares ${CATEGORIES.length} categories`);

// ── 1. Every category is complete ─────────────────────────────────────

{
  // Each category must be able to say "not checked yet". A category that
  // cannot will end up saying `0` instead, which is the confident, wrong
  // all-clear the whole four-state design exists to prevent.
  const mute = CATEGORIES.filter((c) => !c.unmeasured || c.unmeasured.trim().length < 10);
  assert(
    mute.length === 0,
    mute.length === 0
      ? `all ${CATEGORIES.length} categories say what to do when never measured`
      : `no "never measured" copy, so these will render 0 instead:\n     ${mute
          .map((c) => c.id)
          .join("\n     ")}`,
  );

  const dupes = CATEGORIES.map((c) => c.id).filter((id, i, a) => a.indexOf(id) !== i);
  assert(dupes.length === 0, "category ids are unique");
}

{
  // The route exists, takes the category as a PARAM, and is registered in the
  // tree. All three, because a route defined and never added to `addChildren`
  // is a 404 that looks like working code.
  const router = readFileSync(join(root, "renderer/main/router.tsx"), "utf-8");
  assert(
    /path:\s*"\/stats\/\$category"/.test(router),
    "a route exists for a category dashboard",
  );
  assert(
    /path:\s*"\/stats\/\$category\/\$facet"/.test(router),
    "a route exists for the leaf below it",
  );
  for (const name of ["statsCategoryRoute", "statsFacetRoute"]) {
    assert(
      new RegExp(`addChildren\\([\\s\\S]*\\b${name}\\b[\\s\\S]*\\]\\)`).test(router),
      `${name} is registered in the route tree`,
    );
  }
}

{
  // EVERY CATEGORY IN `BUILT` HAS A BODY, AND EVERY FACET HAS A LABEL.
  //
  // `BUILT` is what makes a tile clickable. Adding an id to it without writing
  // the dashboard ships a tile that opens the "isn't built yet" panel — which
  // is worse than the disabled tile it replaced, because the user has to click
  // to find out. Nothing else would object: the id is a valid category, the
  // route resolves, and the fallback renders perfectly.
  //
  // Read from source rather than imported, because importing the view means
  // importing React. The regex is proved against the file first: a pattern that
  // stops matching harvests nothing and this assertion would pass vacuously.
  const view = readFileSync(join(STATS_DIR, "stats-category-view.tsx"), "utf-8");
  const builtBlock = /export const BUILT = \[([\s\S]*?)\] as const;/.exec(view);
  assert(builtBlock !== null, "BUILT is declared in stats-category-view.tsx");
  const built = [...(builtBlock?.[1] ?? "").matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
  assert(built.length > 0, `the BUILT parser still works (found ${built.length} ids)`);

  const unknown = built.filter((id) => !CATEGORIES.some((c) => c.id === id));
  assert(unknown.length === 0, `every id in BUILT is a registry category${
    unknown.length ? `: ${unknown.join(", ")} are not` : ""
  }`);

  // A body branch, spelled the one way the file spells them.
  const bodyless = built.filter((id) => !new RegExp(`meta\\.id === "${id}"`).test(view));
  assert(
    bodyless.length === 0,
    bodyless.length === 0
      ? `all ${built.length} openable categories render a dashboard`
      : `these tiles are clickable and open the "isn't built yet" panel:\n     ${bodyless.join(
          "\n     ",
        )}`,
  );

  // A facet id reaches the URL and therefore the breadcrumb. One with no entry
  // in FACET_LABELS renders there as raw vocabulary — "Stats / Step health /
  // THROWING" — which reads as a bug in the trail rather than a missing label.
  const labelled = Object.keys(FACET_LABELS);
  const missing = built.filter((id) => !labelled.includes(id));
  assert(
    missing.length === 0,
    missing.length === 0
      ? `every openable category has facet labels for its breadcrumb`
      : `these drill into facets with no label:\n     ${missing.join("\n     ")}`,
  );
}

{
  // The breadcrumb resolves a category through the registry rather than
  // title-casing the param. A URL can say /stats/nonsense, and a trail that
  // confidently rendered "Nonsense" would be naming a screen that does not
  // exist.
  const strip = readFileSync(join(root, "renderer/main/app-strip.tsx"), "utf-8");
  assert(
    /categoryMeta\(/.test(strip),
    "the breadcrumb resolves a category through the registry, not from the URL text",
  );
}

{
  // The board reads the registry rather than listing categories itself.
  const board = readFileSync(join(STATS_DIR, "category-board.tsx"), "utf-8");
  assert(
    /CATEGORIES\.map\(/.test(board),
    "the board draws its tiles from CATEGORIES, so a new category cannot be missed",
  );
}

{
  // THE TWO COPIES OF THE STABILITY VERDICT LABELS AGREE.
  //
  // `FACET_LABELS.stability` is what the breadcrumb and the dashboard rows show;
  // `VERDICT_COPY` in flake-panel.tsx is what the Stability panel's chip shows.
  // They cannot be one constant — that file is a `.tsx` beside its component and
  // this check cannot load React — so they are compared instead. Divergence
  // would mean the same verdict is called two different things on two screens,
  // which reads as two different findings.
  //
  // Parsed from source rather than imported, for the reason above. The regex is
  // proved against the file before it is trusted: a pattern that stops matching
  // harvests nothing and this assertion would pass vacuously.
  const panel = readFileSync(join(root, "renderer/main/flake-panel.tsx"), "utf-8");
  const found = new Map<string, string>();
  for (const m of panel.matchAll(
    /^\s*"?([a-z-]+)"?:\s*\{\s*\n\s*label:\s*"([^"]+)"/gm,
  )) {
    found.set(m[1], m[2]);
  }
  assert(
    found.size >= 5,
    `the VERDICT_COPY parser still works (found ${found.size} labels in flake-panel.tsx)`,
  );

  const mismatched: string[] = [];
  for (const [id, label] of Object.entries(FACET_LABELS.stability ?? {})) {
    const theirs = found.get(id);
    if (theirs === undefined) mismatched.push(`${id}: absent from VERDICT_COPY`);
    else if (theirs !== label) mismatched.push(`${id}: "${label}" here vs "${theirs}" in the panel`);
  }
  assert(
    mismatched.length === 0,
    mismatched.length === 0
      ? `all ${found.size} stability verdict labels match between the panel and the board`
      : `the same verdict is named two different things on two screens:\n     ${mismatched.join("\n     ")}`,
  );
}

// ── 2. No cross-category arithmetic ───────────────────────────────────

{
  // The band counts STATES. Anything that reduces over summaries and adds is
  // the bug — and `bandReading` itself lives in renderer/lib, so nothing under
  // renderer/main/stats has any business summing at all.
  //
  // Matched on the shapes that actually produce a total: a `+` inside a
  // reduce, and the aggregate helpers. Deliberately not a blanket ban on `+`,
  // which would catch string concatenation in every label on the screen.
  const offenders: string[] = [];
  for (const file of sources) {
    const src = readFileSync(file, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rel = file.slice(root.length + 1);
    for (const m of src.matchAll(/\.reduce\s*\(/g)) {
      const tail = src.slice(m.index, m.index + 220);
      if (/[+]\s|\bsum\b|\btotal\b/i.test(tail)) {
        offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length} — reduce that adds`);
      }
    }
    for (const m of src.matchAll(/\b(healthScore|overallScore|totalIssues|combinedScore)\b/g)) {
      offenders.push(`${rel} — ${m[1]}`);
    }
  }
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? "nothing under renderer/main/stats adds across categories"
      : `a total across categories with different units means nothing while looking\n     authoritative — the band counts categories in a state instead:\n     ${offenders.join("\n     ")}`,
  );
}

// ── 3. Stats reports; the operational views act ───────────────────────

{
  // No mutation reachable from a Stats surface. `api.heals.accept(...)` is one
  // import away and would work perfectly — which is exactly why a convention
  // is not enough here.
  const BANNED =
    /\bapi\s*\.\s*\w+\s*\.\s*(accept\w*|revert\w*|delete\w*|clear\w*|remove\w*|set\w*|update\w*|resetStats|pruneNow)\s*\(/;
  const offenders: string[] = [];
  for (const file of sources) {
    const src = readFileSync(file, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rel = file.slice(root.length + 1);
    for (const line of src.split("\n").entries()) {
      const [i, text] = line;
      if (text.trim().startsWith("//")) continue;
      const m = BANNED.exec(text);
      if (m) offenders.push(`${rel}:${i + 1} — ${m[1]}`);
    }
  }
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? "no accept / revert / delete is reachable from a Stats surface"
      : `Stats answers "how much, how often, is it getting worse"; Heals and Visual\n     answer "what do I do about this one". These cross that line:\n     ${offenders.join("\n     ")}`,
  );

  // The positive half — a dashboard that mutated nothing AND linked nowhere
  // would pass the rule above while being a dead end, which is the failure
  // mode drill-downs actually have.
  const view = readFileSync(join(STATS_DIR, "stats-category-view.tsx"), "utf-8");
  assert(
    /to:\s*"\/test\/\$id"/.test(view),
    "a leaf can reach the test it names",
  );
  assert(
    /to:\s*"\/heals"/.test(view),
    "the Auto-Heal dashboard hands off to the view that can act on a heal",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll stats-category checks passed.");
