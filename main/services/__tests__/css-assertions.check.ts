// Standalone regression check for the CSS-assertion property vocabulary.
//
// Three properties, none of which any other test can see, and all three fail
// SILENTLY — the feature keeps working and simply stops telling the truth:
//
//  1. KEBAB-CASE. `background-color` and `backgroundColor` are both valid
//     JavaScript identifiers and both look right in a list. But every consumer
//     goes through `getComputedStyle().getPropertyValue()` — the capture script
//     reading the value, and Playwright's `toHaveCSS` comparing it — and that
//     call answers "" for a camelCase name instead of throwing. A camelCase
//     entry therefore shows no value in the picker and fails every assertion
//     made with it, with nothing anywhere saying why.
//
//  2. ONE LIST. The property list is interpolated into BOTH injected scripts
//     rather than written out in them. It was two hand-written copies before,
//     which is the failure `page-actions.ts` exists to prevent: a property
//     added to one copy is simply absent from the other, and the only symptom
//     is a picker that offers a property it never has a value for.
//
//  3. THE TWO MIRRORS AGREE. `main/recorder/types.ts` and
//     `renderer/lib/recorder-types.ts` each declare the list (the renderer
//     cannot import backend modules). If they drift, the dialog offers a
//     property the capture script never read.
//
// Run with: npm run check:css-assertions

import { CAPTURE_SCRIPT, PICK_AT_POINT_SCRIPT } from "../../recorder/capture-script.js";
import { CSS_ASSERT_PROPS, isCssPropName } from "../../recorder/types.js";
import { CSS_ASSERT_PROPS as RENDERER_PROPS } from "../../../renderer/lib/recorder-types.js";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(
      `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  } else {
    console.log(`ok   ${label}`);
  }
}

// ── 1. Every offered property is kebab-case and syntactically valid ────────
{
  assert(CSS_ASSERT_PROPS.length > 0, "the curated property list is not empty");
  for (const p of CSS_ASSERT_PROPS) {
    assert(!/[A-Z]/.test(p), `"${p}" is kebab-case (getPropertyValue answers "" for camelCase)`);
    assert(isCssPropName(p), `"${p}" passes the boundary's own property-name check`);
  }
  assertEqual(
    CSS_ASSERT_PROPS.length,
    new Set(CSS_ASSERT_PROPS).size,
    "the property list has no duplicates (a duplicate renders twice in the picker)",
  );
}

// ── 2. Both injected scripts carry ONE interpolated copy of the list ───────
{
  for (const [name, src] of [
    ["CAPTURE_SCRIPT", CAPTURE_SCRIPT],
    ["PICK_AT_POINT_SCRIPT", PICK_AT_POINT_SCRIPT],
  ] as const) {
    const defs = (src.match(/function cssPropsOf/g) ?? []).length;
    assertEqual(defs, 1, `${name} defines cssPropsOf exactly once`);

    // The list itself, not merely a list: every property must appear in the
    // emitted source, which is only true if it was interpolated.
    for (const p of CSS_ASSERT_PROPS) {
      assert(src.includes(`"${p}"`), `${name} carries "${p}" from the shared list`);
    }

    // The old camelCase bracket-access form must be gone from both. This is the
    // regression that would reintroduce silently-empty values.
    assert(
      !/cs\[keys\[i\]\]/.test(src),
      `${name} reads styles with getPropertyValue, not camelCase bracket access`,
    );
    assert(
      src.includes("getPropertyValue"),
      `${name} uses getPropertyValue — the same call toHaveCSS compares against`,
    );
  }
}

// ── 3. The backend list and its renderer mirror agree ─────────────────────
{
  assertEqual(
    RENDERER_PROPS,
    CSS_ASSERT_PROPS,
    "the renderer's CSS_ASSERT_PROPS mirror matches the backend list exactly",
  );
}

// ── 4. The property-name guard accepts real CSS and refuses the rest ──────
//
// Pinned here as well as in check:step-ingest because that check is about the
// trust boundary and this one is about the vocabulary: a guard loosened to
// admit a property somebody wanted would widen an injection sink at the same
// time, and the two reasons live in different files.
{
  for (const good of [
    "color",
    "background-color",
    "-webkit-line-clamp",
    "--brand-accent",
    "z-index",
  ]) {
    assert(isCssPropName(good), `accepts a real property: ${good}`);
  }
  for (const bad of [
    "",
    "background color",
    "background_color",
    "1color",
    "color;",
    "color)",
    'color"',
    "color/*",
    "a".repeat(101),
  ]) {
    assert(!isCssPropName(bad), `refuses: ${JSON.stringify(bad.slice(0, 24))}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll css-assertion checks passed");
