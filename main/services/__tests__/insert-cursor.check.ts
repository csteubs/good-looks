// Where a recorded step lands, and whether the user can see it land there.
//
// THE RULE: the insert cursor marks WHERE THE BROWSER IS. Opening a session
// executes exactly one thing — the initial navigation — so `initialCursor` puts
// the cursor just past the `goto`. A replay executes more, so it moves the
// cursor too. Both halves are the same rule, and the second one was missing.
//
// WHY THIS IS A CHECK AND NOT A UNIT TEST. Every way of breaking it is silent
// and none of them is observable from jsdom:
//
//  1. A replay path that forgets to advance the cursor produces no error. The
//     step is captured, the count grows, the list renders — and the step is
//     spliced in BEFORE the steps that reach the state it was recorded in. It
//     is wrong only when the test is next run. There are four replay entry
//     points and this is exactly the shape that left three of them without the
//     focus-and-broadcast dance (see check:replay-suspend).
//
//  2. `autoScrollToBottom` written unconditionally scrolls the view AWAY from
//     the row that just changed, whenever the cursor is not at the end — i.e.
//     for the whole of a continued test. jsdom has no layout engine, so
//     `scrollTop = scrollHeight` is 0 = 0 there and a rendered test cannot tell
//     the two versions apart. This is what the original report described as
//     "it doesn't appear to record any manual page interaction".
//
//  3. The trainers are two renderings of one list, so anything true of one and
//     not the other is a bug that only appears in whichever window the user
//     happens to be looking at.
//
// Run with: npm run check:insert-cursor

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

const service = read("main/services/recorder-service.ts");

// ── 1. One helper owns the advance ───────────────────────────────────

assert(
  /function cursorPastReplayed\(index: number\): void/.test(service),
  "recorder-service.ts: `cursorPastReplayed` exists — one place that moves the cursor for a " +
    "replay, so the four replay paths cannot drift into four slightly different rules",
);

const helperStart = service.indexOf("function cursorPastReplayed");
const helper = service.slice(helperStart, service.indexOf("\n}", helperStart));
assert(
  /clampCursor\(index \+ 1\)/.test(helper),
  "cursorPastReplayed: lands PAST the step, clamped — an unclamped index off the end of the " +
    "list is a crash on the next insert",
);
assert(
  /broadcastState\(\)/.test(helper),
  "cursorPastReplayed: broadcasts — a cursor that moves only in the backend leaves both " +
    "trainers drawing their caret in the wrong place, which is the same lie as not moving it",
);

// ── 2. Every replay path advances it ─────────────────────────────────

const REPLAY_METHODS = ["replayStep", "replayFromStart", "replayAll", "replayFromCurrent"];

for (const name of REPLAY_METHODS) {
  const start = service.indexOf(`  async ${name}(`);
  assert(start > 0, `recorder-service.ts: has ${name}`);
  if (start < 0) continue;
  // Method bodies end at the next top-level method in the service object.
  const rest = service.slice(start + 1);
  const nextMethod = rest.search(/\n {2}(?:async )?[a-zA-Z]+\(/);
  const body = nextMethod > 0 ? rest.slice(0, nextMethod) : rest;

  assert(
    /cursorPastReplayed\(/.test(body),
    `${name}: moves the insert cursor past what it replayed — otherwise a step recorded after ` +
      "this runs is written into the spec BEFORE the steps that produce the state it was " +
      "recorded in, and nothing says so until the test is run",
  );
}

// A failure must NOT advance the cursor: the page state after one is unknown,
// and leaving the cursor at the failed index is what puts the user's next
// recorded step exactly where the flow broke.
assert(
  !/if \(!ok[^)]*\) \{\s*cursorPastReplayed/.test(service),
  "recorder-service.ts: no replay path advances the cursor on a failed step",
);

// ── 3. Both trainers follow the cursor, not the bottom ───────────────

const TRAINERS = ["renderer/main/recording-view.tsx", "renderer/trainer/trainer-panel-view.tsx"];

for (const rel of TRAINERS) {
  const src = read(rel);

  assert(
    /const cursorAtEnd = state\.cursor >= liveSteps\.length/.test(src),
    `${rel}: derives whether the cursor is at the end of the list`,
  );
  assert(
    /autoScrollToBottom=\{cursorAtEnd\}/.test(src),
    `${rel}: follows the bottom only while the bottom IS the insert point. Unconditional here ` +
      "scrolls away from the row that just arrived for the whole of a continued test",
  );
  assert(
    !/autoScrollToBottom\s+autoScrollDeps=\{\[liveSteps/.test(src),
    `${rel}: no bare \`autoScrollToBottom\` left on the step list`,
  );
  assert(
    /justAdded=\{s\.id === lastAddedStepId\}/.test(src),
    `${rel}: hands the arriving step to StepRow, which is what scrolls it into view — the ` +
      "other half of the same fix, and useless in only one of the two trainers",
  );
  assert(
    /label=\{i \+ 1 === liveSteps\.length \? undefined : INSERT_HERE\}/.test(src),
    `${rel}: labels the active cursor everywhere EXCEPT the end of the list, where steps ` +
      "appearing under the last row is what everyone already expects",
  );
  assert(
    !/\{state\.editing \? "Editing" : "Recording"\}/.test(src),
    `${rel}: the live-capture chip never reads "Editing" — capture is on in a continued ` +
      "session, and the one indicator whose job is to say so must not say the opposite",
  );
}

// ── 4. The row scrolls itself into view ──────────────────────────────

const stepRow = read("renderer/main/step-row.tsx");

assert(
  /justAdded\?: boolean/.test(stepRow),
  "step-row.tsx: StepRow takes `justAdded`",
);
assert(
  /scrollIntoView\(\{ block: "nearest" \}\)/.test(stepRow),
  'step-row.tsx: scrolls with `block: "nearest"` — a row already on screen must stay exactly ' +
    "where it is, or a step captured at the bottom of a short list makes the list jump",
);
assert(
  /export const INSERT_HERE/.test(stepRow),
  "step-row.tsx: exports the cursor's copy, so both trainers say the same words and a test can " +
    "assert them without retyping",
);

// ── 5. The CSS the class names refer to ──────────────────────────────
//
// Same reason as check:step-glow: jsdom asserts on the CLASS, so the rule it
// names could be deleted outright and every component test would still pass.

const css = read("renderer/styles.css");
assert(/@keyframes\s+step-just-added\b/.test(css), "styles.css: defines the step-just-added keyframes");
assert(/\.step-just-added\s*\{/.test(css), "styles.css: defines the .step-just-added rule");
assert(
  /outline: 1px solid transparent;[\s\S]{0,120}animation: step-just-added/.test(css),
  ".step-just-added: outline (not border) and animated — a border shifts the row by 2px and " +
    "collides with the drag-over border utility, exactly as it did for .step-new",
);
assert(
  /outline-color: transparent;/.test(css.slice(css.indexOf("@keyframes step-just-added"))),
  ".step-just-added: fades to nothing. A marker that never expires accumulates until several " +
    "rows look special and none of them means anything",
);
assert(
  /prefers-reduced-motion[\s\S]{0,400}\.step-just-added\s*\{\s*animation: none/.test(css),
  ".step-just-added: honours prefers-reduced-motion",
);

const shared = read("renderer/theme/shared.css");
assert(
  /\.gl-cursor-gap-label\s*\{/.test(shared),
  "shared.css: defines .gl-cursor-gap-label — a class that does not exist renders nothing and " +
    "throws nothing, which is how this repo has shipped invisible copy three times",
);
assert(
  /\.gl-cursor-gap\[data-labelled\]\s*\{/.test(shared),
  "shared.css: gives the labelled cursor room — the 8px strip cannot hold text, so without " +
    "this the label is clipped to nothing",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll insert-cursor checks passed");
