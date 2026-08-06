// Source-level guard on the trainer panel's window plumbing.
//
// panel-dock.test.ts proves the GEOMETRY is right. This proves the structure
// around it holds — facts about the source that no unit test can observe,
// because breaking any of them produces no error at all:
//
//   • A `setBounds` written outside the guarded helper reintroduces the
//     move/resize feedback loop. mabl shipped that bug ("resizing the browser
//     while training resulted in an endless loop that hangs the product"), and
//     it is silent: nothing throws, the app just wedges with two windows
//     shoving each other. A test cannot catch it because a wedged event loop
//     never returns to the assertion.
//   • A follow event nobody subscribed to raises no failure — the panel just
//     stops keeping up in one particular way, which reads as flakiness.
//   • A push channel that skips the panel leaves two trainers disagreeing about
//     the step list, which reads as a step-ordering bug in the recorder.
//
// Same reasoning, and the same shape, as check:recorder-navigation.
//
// Run with: npm run check:trainer-panel

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { FOLLOW_EVENTS } from "../../windows/trainer-panel-window.js";

// Anchored on the npm-script cwd (the project root), NOT on import.meta.url:
// this check is bundled into node_modules/.cache, so the module's own location
// says nothing about where the sources it reads live.
const projectRoot = process.cwd();
const mainDir = resolve(projectRoot, "main");
const panelPath = resolve(mainDir, "windows/trainer-panel-window.ts");
const panel = readFileSync(panelPath, "utf8");
const appWindow = readFileSync(resolve(mainDir, "services/app-window.ts"), "utf8");
const recorder = readFileSync(resolve(mainDir, "services/recorder-service.ts"), "utf8");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** Source with comments stripped — a rule quoted in prose is not a call. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const panelCode = code(panel);

// ── 1. Every bounds write goes through the guard ─────────────────────
// The loop-breaker only works if it is on the ONLY path that moves a window.
{
  const setBoundsCalls = [...panelCode.matchAll(/(\w+)\.setBounds\(/g)].map((m) => m[1]);
  assert(
    setBoundsCalls.length > 0,
    "trainer-panel-window actually writes bounds (the check has something to guard)",
  );
  // The single permitted call site is inside applyBounds, whose receiver is the
  // `win` parameter. Any other receiver is a bypass.
  const bypasses = setBoundsCalls.filter((receiver) => receiver !== "win");
  assert(
    bypasses.length === 0,
    `every setBounds goes through applyBounds (bypassed by: ${bypasses.join(", ") || "none"})`,
  );
  assert(
    /function applyBounds\([\s\S]*?applying = true[\s\S]*?\n}/.test(panelCode),
    "applyBounds raises the `applying` flag around the write",
  );
  assert(
    /function applyBounds\([\s\S]*?lastPanelWrite = stamp[\s\S]*?\n}/.test(panelCode),
    "applyBounds records the rectangle it wrote, so the echo can be recognised",
  );
}

// ── 2. The flag alone is not the whole guard ─────────────────────────
// A native event can arrive a tick after `applying` clears, so identity+time
// has to be checked too. Losing this leaves a guard that works on a fast
// machine and loops on a slow one.
assert(
  panelCode.includes("isDuplicateApply(lastBrowserWrite"),
  "the follower rejects an event echoing our own write to the browser",
);
assert(
  panelCode.includes("isDuplicateApply(lastPanelWrite"),
  "the follower rejects a panel placement identical to the last one applied",
);
assert(
  /if \(applying\) return;/.test(panelCode),
  "the follower bails while a write of ours is in flight",
);

// ── 3. The follower listens to the browser, never to the panel ───────
// The panel's own movement is a CONSEQUENCE. Feeding it back in is the loop.
{
  const listensToPanel = /panelWindow\.on\(\s*["'](move|moved|resize|resized)["']/.test(panelCode);
  assert(!listensToPanel, "the panel's own move/resize is never an input to the follower");
}

// ── 4. Follow events are wired by iteration ──────────────────────────
// Hand-wiring is how `will-redirect` came to have no listener at all.
assert(
  panelCode.includes("for (const event of FOLLOW_EVENTS)"),
  "follow handlers are attached by iterating FOLLOW_EVENTS, so adding one wires it",
);
for (const event of FOLLOW_EVENTS) {
  const handWired = new RegExp(`win\\.on\\(\\s*["']${event}["']`).test(panelCode);
  assert(!handWired, `"${event}" is wired through the loop, not by hand`);
}
assert(
  FOLLOW_EVENTS.includes("moved") && FOLLOW_EVENTS.includes("resized"),
  "the end-of-gesture events are covered, which is the floor if move/resize don't stream",
);

// ── 5. Pushes reach the panel ────────────────────────────────────────
// One fan-out, inside sendToMain, so a channel added later is included without
// anyone remembering to.
assert(
  /export function sendToMain[\s\S]*?getAuxWindows\(\)/.test(code(appWindow)),
  "sendToMain fans out to registered auxiliary windows",
);
assert(
  code(appWindow).includes("registerAuxWindow") && code(appWindow).includes("unregisterAuxWindow"),
  "auxiliary windows can be registered and unregistered",
);
assert(
  panelCode.includes("registerAuxWindow(panelWindow)"),
  "the panel registers itself for pushes",
);
assert(
  /on\(\s*"closed"[\s\S]*?unregisterAuxWindow/.test(panelCode),
  "the panel unregisters on close, so a dead handle is not retained",
);

// ── 6. The panel is torn down on every session exit ──────────────────
// Three teardown paths exist and they do NOT share a tail: `finalize` runs from
// the window's `closed` event, `discardExit` REMOVES that listener and installs
// its own, and the load-failure path tears down before either. A panel left
// behind by any one of them is an always-on-top window controlling nothing.
{
  const recorderCode = code(recorder);
  const closes = [...recorderCode.matchAll(/closeTrainerPanel\(\)/g)].length;
  assert(
    closes >= 3,
    `closeTrainerPanel is called on every teardown path (found ${closes}, need finalize + discardExit + load-failure)`,
  );
  assert(
    /async function finalize\(\)[\s\S]*?closeTrainerPanel\(\)/.test(recorderCode),
    "finalize closes the panel",
  );
  assert(
    /discardExit\(\)[\s\S]{0,400}?closeTrainerPanel\(\)/.test(recorderCode),
    "discardExit closes the panel (it removes finalize's `closed` listener, so it cannot rely on it)",
  );
}

// ── 7. Undock precedes teardown ──────────────────────────────────────
// Closing the panel must first give the browser back the width docking took.
// Once the window is gone there is nothing left to restore it from, and the
// user's training browser stays permanently narrower than they left it.
assert(
  /export function closeTrainerPanel[\s\S]*?undock\([\s\S]*?panelWindow\.close\(\)/.test(panelCode),
  "closeTrainerPanel undocks before closing the window",
);

// ── 8. The panel is our own page, never the untrusted one ────────────
// The training window runs an arbitrary site in a throwaway partition. The
// panel must never share it: it holds the controls, and page script reaching
// them would cross the capture boundary in the wrong direction.
assert(
  !/partition/.test(panelCode),
  "the panel does not join the training window's session partition",
);
assert(
  panelCode.includes("getPreloadPath()"),
  "the panel loads the app preload (it is a first-party window)",
);
assert(
  /getWindowUrl\("trainer-window\.html"\)/.test(panelCode),
  "the panel loads its own local HTML entry",
);

// ── 9. The renderer entry exists to match the window it loads ────────
// The SDK generates <name>-window.html from renderer/<name>/index.tsx, so a
// mismatch here is a window that opens blank.
{
  const rendererDir = resolve(projectRoot, "renderer/trainer");
  const entries = statSync(rendererDir).isDirectory() ? readdirSync(rendererDir) : [];
  assert(entries.includes("index.tsx"), "renderer/trainer/index.tsx exists (generates trainer-window.html)");
  const html = readFileSync(resolve(projectRoot, "trainer-window.html"), "utf8");
  assert(
    html.includes("./renderer/trainer/index.tsx"),
    "trainer-window.html points at the trainer entry",
  );
}

console.log(failures === 0 ? "\nAll trainer-panel checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
