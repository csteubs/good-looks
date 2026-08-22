// Standalone regression check for the newly-added-step highlight.
//
// The highlight is the only thing that tells a user WHICH rows an applied AI
// fix (or an inserted AI-generated flow) put in their step list. Every way of
// breaking it is silent — the list still renders, the steps are still right,
// there is just no longer anything saying what changed — so the pieces that no
// rendered test can observe are pinned here instead.
//
// Three things live at source level because jsdom cannot reach them:
//
//  1. The CSS. jsdom has no layout or animation engine: `.step-new` and its
//     keyframes could be deleted outright and every component test would still
//     pass, because those assert on the CLASS, not on what it draws.
//
//  2. `outline` rather than `border`, and an animation that touches ONLY
//     `outline-color`. Both are load-bearing and both failed in development:
//     a real border shifts the row by 2px and collides with the drag-over
//     border utility, and animating `box-shadow` silently erased the `ring-*`
//     selection and run-status highlights, which are box-shadows too.
//
//  3. Which insert path the Generate Steps dialog uses. `insertStep` clears
//     the highlight (a hand edit retires it), so routing generated steps
//     through it leaves them unmarked no matter how correct the diff is. That
//     is one identifier's difference in a JSX prop and reads as fine.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npm run check:step-glow

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

// ── 1. The stylesheet ────────────────────────────────────────────────

const css = read("renderer/styles.css");

assert(
  /@keyframes\s+step-new-pulse\b/.test(css),
  "styles.css: defines the step-new-pulse keyframes",
);
assert(/\.step-new\s*\{/.test(css), "styles.css: defines the .step-new rule");

const rule = css.slice(css.indexOf(".step-new {"), css.indexOf("}", css.indexOf(".step-new {")));
assert(
  /animation:\s*step-new-pulse/.test(rule),
  ".step-new: runs the pulse animation — a static outline would not read as a change",
);
assert(
  /outline:/.test(rule) && !/(^|\s)border:/.test(rule),
  ".step-new: draws with outline, not border — a border shifts the row's layout and " +
    "fights the drag-over border utility on the same element",
);
assert(
  /outline-offset:\s*-/.test(rule),
  ".step-new: negative outline-offset, so the outline sits inside the row's rounded corners",
);

const keyframes = css.slice(
  css.indexOf("@keyframes step-new-pulse"),
  css.indexOf(".step-new {"),
);
assert(
  /outline-color:/.test(keyframes),
  "step-new-pulse: animates outline-color",
);
assert(
  !/box-shadow:/.test(keyframes),
  "step-new-pulse: animates NO box-shadow — the row's selection and run-status " +
    "highlights are box-shadows (ring-*), and an animated box-shadow silently replaces them",
);

assert(
  /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.step-new[\s\S]*animation:\s*none/.test(css),
  "styles.css: the pulse stops under prefers-reduced-motion — the highlight is not " +
    "time-limited, so it can pulse for minutes",
);

// ── 2. The component ─────────────────────────────────────────────────

const stepRow = read("renderer/main/step-row.tsx");

assert(/isNew\?:\s*boolean/.test(stepRow), "step-row.tsx: takes an isNew prop");
assert(
  /"step-new"/.test(stepRow),
  "step-row.tsx: applies the .step-new class — the stylesheet is dead weight without it",
);
assert(
  /data-new-step=/.test(stepRow),
  "step-row.tsx: exposes data-new-step, the only handle the rendered tests have on the highlight",
);

// ── 3. The step lists ────────────────────────────────────────────────

const consumers = [
  "renderer/main/test-detail-view.tsx",
  "renderer/main/recording-view.tsx",
  "renderer/trainer/trainer-panel-view.tsx",
];
for (const rel of consumers) {
  assert(
    /isNew=\{/.test(read(rel)),
    `${rel}: passes isNew to its StepRow — a list that never passes it can never glow`,
  );
}

// ── 4. Generated steps take the tracked (and verifying) insert path ───
//
// Since 2026-08-22 the dialog VERIFIES proposed steps against the live page
// through `verifyGeneratedSteps`, which is also the path that marks what
// landed as new. A dialog wired to anything else would either insert
// unverified or land its steps unmarked — both silent.

for (const rel of ["renderer/main/recording-view.tsx", "renderer/trainer/trainer-panel-view.tsx"]) {
  const src = read(rel);
  const dialog = src.slice(src.indexOf("<GenerateStepsDialog"));
  assert(dialog.includes("onVerify="), `${rel}: GenerateStepsDialog is given onVerify`);
  const onVerify = dialog.slice(dialog.indexOf("onVerify="), dialog.indexOf("/>"));
  assert(
    /verifyGeneratedSteps/.test(onVerify),
    `${rel}: GenerateStepsDialog verifies and inserts via verifyGeneratedSteps`,
  );
  assert(
    !/\binsertStep\b/.test(onVerify) && !/\binsertGeneratedSteps\b/.test(onVerify),
    `${rel}: GenerateStepsDialog does NOT use a plain insert — that path inserts unverified, ` +
      "and the plain insertStep also clears the highlight rather than setting it",
  );
}

// ── 5. The diff must not read ids ────────────────────────────────────

const diff = read("renderer/lib/diff-steps.ts");
const signature = diff.slice(diff.indexOf("export function stepSignature"), diff.indexOf("export interface StepDiff"));
assert(
  !/\bstep\.id\b/.test(signature),
  "diff-steps.ts: stepSignature ignores step.id — the spec parser mints a fresh id for every " +
    "step on every parse, so an id in the signature marks the whole list as new after any apply",
);
assert(
  !/\bstep\.timestamp\b/.test(signature),
  "diff-steps.ts: stepSignature ignores step.timestamp, for the same reason as the id",
);

// ── 6. The replay pass/fail flash ────────────────────────────────────
//
// A second outline highlight on the same row, drawn by the same mechanism for
// the same reasons, and invisible to jsdom for the same reasons. It lives here
// rather than in its own file because the properties below are not two
// independent contracts — they are ONE contract about what may draw on a step
// row, and the way to break it is to add a third highlight that ignores it.

for (const cls of ["step-replay-pass", "step-replay-fail"]) {
  assert(new RegExp(`\\.${cls}\\s*\\{`).test(css), `styles.css: defines the .${cls} rule`);

  const start = css.indexOf(`.${cls} {`);
  const flashRule = css.slice(start, css.indexOf("}", start));
  assert(
    /outline:/.test(flashRule) && !/(^|\s)border:/.test(flashRule),
    `.${cls}: draws with outline, not border — same reason as .step-new above (a border shifts ` +
      "the row and fights the drag-over border utility)",
  );
  assert(
    /outline-offset:\s*-/.test(flashRule),
    `.${cls}: negative outline-offset, so it sits inside the row's rounded corners`,
  );
  assert(
    /animation:[^;]*forwards/.test(flashRule),
    `.${cls}: holds its final frame (\`forwards\`) — without it the fade snaps back to full ` +
      "opacity for the rest of the row's life, which is the opposite of ephemeral",
  );
  assert(
    !/infinite/.test(flashRule),
    `.${cls}: does NOT loop — this highlight lives ~2.5s, and a pulse that short reads as a ` +
      "flicker rather than as a state",
  );

  const kf = css.slice(css.indexOf(`@keyframes ${cls}`), css.indexOf(`.${cls} {`));
  assert(
    /outline-color:/.test(kf),
    `${cls}: animates outline-color`,
  );
  assert(
    !/box-shadow:/.test(kf),
    `${cls}: animates NO box-shadow — the row's selection and run-status highlights are ` +
      "box-shadows (ring-*), and an animated box-shadow silently replaces them",
  );
}

assert(
  /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.step-replay-pass[\s\S]*animation:\s*none/.test(css),
  "styles.css: the replay flash drops its motion under prefers-reduced-motion (the outline stays — " +
    "it is the whole signal)",
);

// The component must pick ONE outline. Both .step-new and the flash set
// `outline`, so a row that is new AND just-replayed would otherwise resolve by
// stylesheet order — a choice neither caller made, and one that silently
// changes if the rules are ever reordered.
assert(
  /replayFlash\?:\s*"pass"\s*\|\s*"fail"/.test(stepRow),
  "step-row.tsx: takes a replayFlash prop",
);
assert(
  /data-replay-flash=/.test(stepRow),
  "step-row.tsx: exposes data-replay-flash, the handle the rendered tests have on the flash",
);
assert(
  /replayFlash\s*\n?\s*\?[\s\S]{0,200}:\s*isNew/.test(stepRow),
  "step-row.tsx: the flash and .step-new are mutually exclusive, flash first — two `outline` " +
    "rules on one element resolve by stylesheet order otherwise",
);

for (const rel of ["renderer/main/recording-view.tsx", "renderer/trainer/trainer-panel-view.tsx"]) {
  assert(
    /replayFlash=\{/.test(read(rel)),
    `${rel}: passes replayFlash to its StepRow — a list that never passes it can never flash`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll step-glow checks passed");
