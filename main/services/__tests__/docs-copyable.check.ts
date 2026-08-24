// A command in the manual can be taken out of the app.
//
// THE DEFAULT IN THIS APP IS THAT TEXT CANNOT BE SELECTED. `renderer/styles.css`
// sets `user-select: none` on `body`, because the app is a native-feeling shell
// and a drag across a step list is a gesture, not a selection. Only `input`,
// `textarea` and `[contenteditable]` opt back in.
//
// The Documentation pane is the one screen made entirely of text the reader is
// meant to run somewhere ELSE, and it inherited that rule: the register command
// — ~130 characters of absolute path — could not be dragged over, and no block
// but one had a button. The only way to get a command out of the app was to
// retype it off the screen.
//
// WHY A CHECK AND NOT A TEST. Both halves of the fix are invisible to the
// suites that could otherwise hold them:
//
//   • `user-select` is a STYLESHEET fact. The dom project runs with
//     `css: false`, so `getComputedStyle(pre).userSelect` reads "" whether the
//     rule is there or not — an assertion on it would pass against the bug it
//     was written for. jsdom cannot host a drag-selection either.
//   • Deleting the rule breaks nothing visible. The pane renders identically,
//     the copy buttons still work, and the only symptom is a cursor that will
//     not select — which nobody sees until they try to select something.
//
// So this reads the two files and asserts the property directly. The button
// half is covered from the DOM by `documentation-pane.test.tsx`; what is
// asserted here is the source-level shape it depends on — every fenced block
// goes through the one component, so a block cannot be added without one.
//
// Verified to fail against the code before the fix: both the `user-select`
// assertions and the "no bare `<pre>`" one.
//
// Run with: npm run check:docs-copyable

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const styles = readFileSync(join(root, "renderer/styles.css"), "utf8");
const screens = readFileSync(join(root, "renderer/theme/screens.css"), "utf8");
const pane = readFileSync(join(root, "renderer/settings/panes/documentation-pane.tsx"), "utf8");

/**
 * Every rule whose selector list names `selector`, declarations joined.
 *
 * ALL of them, not the first: a selector is styled in more than one place here
 * (`.gl-doc-pre` has its own treatment rule and then the selection rule), and
 * reading only the first would report a property as missing while it is
 * declared two rules down. This is a "was it declared at all" oracle rather
 * than a cascade — an inner rule that later overrode one of these would slip
 * past, which is a trade the alternative (a CSS parser in a plain script) does
 * not pay for.
 */
function declarationsFor(source: string, selector: string): string {
  // Comments first. A rule's "head" is everything since the last `}`, so the
  // block comment these stylesheets put above every rule lands inside it and
  // welds itself to the FIRST selector in the list — which is how a selector
  // that is plainly there reads as missing.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const [, head, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = head.split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) out.push(body);
  }
  return out.join("\n");
}

// ── The premise ───────────────────────────────────────────────────────
// Stated as an assertion rather than a comment: if `body` ever stops
// suppressing selection, the opt-ins below are dead weight and this check is
// the thing that should say so out loud.

{
  const body = declarationsFor(styles, "body");
  assert(
    /user-select:\s*none/.test(body),
    "renderer/styles.css still suppresses selection app-wide (the reason the rules below exist)",
  );
}

// ── The opt-in ────────────────────────────────────────────────────────

for (const selector of [".gl-doc-pre", ".gl-doc-pre code", ".gl-doc-code"]) {
  const rule = declarationsFor(screens, selector);
  assert(
    /user-select:\s*text/.test(rule),
    `${selector} opts back into selection — a command that cannot be dragged over is one retyped by hand`,
  );
  assert(
    /cursor:\s*text/.test(rule),
    `${selector} shows an I-beam — \`body\` sets \`cursor: default\`, so without this a selectable block looks inert`,
  );
}

// ── The button ────────────────────────────────────────────────────────
// Source-level, and about the SHAPE rather than the behaviour: the pane's own
// test presses the buttons, but only this can say that a `<pre>` cannot be
// drawn without one. The failure it rules out is the next code surface added
// here going back to a bare block.

{
  assert(
    /className="gl-doc-copy"|className="gl-icon-btn gl-doc-copy"/.test(pane),
    "the pane draws a copy control on its command blocks",
  );

  const component = /function DocCodeBlock\b[\s\S]*?\n}\n/.exec(pane);
  assert(component !== null, "DocCodeBlock is where a command block is drawn");

  const elsewhere = component === null ? pane : pane.replace(component[0], "");
  assert(
    !/<pre\b/.test(elsewhere),
    "every command block goes through DocCodeBlock — a bare <pre> is a block with no way out of the app",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll documentation-copy checks passed.");
