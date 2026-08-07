// Standalone regression check for "a replay never records itself".
//
// THE BUG THIS EXISTS FOR. A replayed step is a real interaction in a live
// recording session: the injected replayer clicks a real element, and the
// capture script is sitting on that same element listening. With capture on,
// replaying step 3 appends a fourth step identical to it. Nothing throws, the
// step list is still valid, and the appended step looks exactly like one the
// user performed — so the only symptom is a test that grew while you were
// checking it, which is discovered much later and blamed on something else.
//
// WHY SOURCE-LEVEL. The mechanism is a DOM attribute (`data-pw-paused`) read by
// a script injected into a real page, driven by module-level state in a service
// that owns a native window. There is no seam to render this through: proving
// it end-to-end needs a browser window and a live site. What CAN be pinned
// cheaply is the shape that makes it correct — one helper, used by every replay
// path, with the restore in a `finally` — and that shape is exactly what a new
// replay path silently fails to copy.
//
// The failure mode is a NEW path, not a broken existing one. Someone adds
// `replayRange` or `replaySelected` next to the four here, writes it the
// obvious way, and it records everything it replays. Assertion 2 is the whole
// point of this file.
//
// Run with: npm run check:replay-suspend

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

// ── 1. The helper exists and does the four things, in order ──────────

const helperStart = service.indexOf("async function withCaptureSuspended");
assert(helperStart > 0, "recorder-service.ts: defines withCaptureSuspended");

const helper = service.slice(helperStart, service.indexOf("\n}\n", helperStart));

assert(
  /session\.paused = true/.test(helper),
  "withCaptureSuspended: suspends capture",
);
assert(
  /session\.replaying = true/.test(helper),
  "withCaptureSuspended: sets `replaying`, the flag BOTH trainer windows gate their controls on",
);
assert(
  /applyStateAttributes\(\)/.test(helper),
  "withCaptureSuspended: pushes the state to the page — `session.paused` alone changes nothing, " +
    "the capture script gates on the data-pw-paused ATTRIBUTE",
);
assert(
  /broadcastState\(\)/.test(helper),
  "withCaptureSuspended: broadcasts, so the trainer window that did NOT start the replay also " +
    "locks its controls",
);
assert(
  /recWindow\.focus\(\)/.test(helper),
  "withCaptureSuspended: focuses the training window — a `press` step types into whatever the OS " +
    "considers focused, which is the trainer panel if the user replayed from there",
);
assert(
  /sleep\(REPLAY_FOCUS_SETTLE_MS\)/.test(helper),
  "withCaptureSuspended: settles before the first step — neither the focus change nor the " +
    "attribute write lands synchronously",
);

// Order matters: focus and settle are worthless after the body has run.
const iPaused = helper.indexOf("session.paused = true");
const iAttrs = helper.indexOf("applyStateAttributes()");
const iFocus = helper.indexOf("recWindow.focus()");
const iSettle = helper.indexOf("sleep(REPLAY_FOCUS_SETTLE_MS)");
const iBody = helper.indexOf("await body()");
assert(
  iPaused < iAttrs && iAttrs < iFocus && iFocus < iSettle && iSettle < iBody,
  "withCaptureSuspended: suspend → push → focus → settle → run, in that order",
);

const finallyBlock = helper.slice(helper.indexOf("} finally {"));
assert(
  /finally/.test(helper) && /session\.paused = wasPaused/.test(finallyBlock),
  "withCaptureSuspended: restores capture in a `finally` — every replay path has early returns " +
    "(a failed step stops the run), and capture that never comes back is worse than any " +
    "replay failure",
);
assert(
  /session\.replaying = false/.test(finallyBlock),
  "withCaptureSuspended: clears `replaying` in the same `finally`, or the trainers stay locked",
);
assert(
  !/session\.paused = false/.test(finallyBlock),
  "withCaptureSuspended: restores the PRIOR pause state, not false — replaying while the user " +
    "had deliberately paused recording must not resume it behind their back",
);

// ── 2. Every replay path goes through it ─────────────────────────────

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
    /withCaptureSuspended\(/.test(body),
    `${name}: runs inside withCaptureSuspended — a replay path that doesn't RECORDS WHAT IT ` +
      "REPLAYS, appending a duplicate step every time the user previews one",
  );
  assert(
    !/session\.paused = /.test(body),
    `${name}: does not touch session.paused directly — four hand-rolled copies of the ` +
      "suspend/restore dance is how three of them ended up without the focus and the broadcast",
  );
}

// A path that suspends capture but never restores it would leave the session
// permanently deaf, so no replay method may own a bare `applyStateAttributes`
// restore of its own.
const serviceAfterHelper = service.slice(helperStart + helper.length);
assert(
  !/session\.paused = wasPaused/.test(serviceAfterHelper),
  "recorder-service.ts: withCaptureSuspended is the ONLY place that restores a suspended " +
    "capture — a second copy is a second thing to forget",
);

// ── 3. The state field is broadcast, not local ───────────────────────

assert(
  /replaying: session\?\.replaying \?\? false/.test(service),
  "currentState(): includes `replaying`, or the broadcast carries nothing and both trainer " +
    "windows are back to guessing",
);

for (const rel of ["main/recorder/types.ts", "renderer/lib/recorder-types.ts"]) {
  assert(
    /replaying: boolean/.test(read(rel)),
    `${rel}: RecorderState declares "replaying" — the two copies of this interface are hand-` +
      "mirrored, and a field in only one of them type-checks on both sides while the renderer " +
      "reads undefined",
  );
}

for (const rel of ["renderer/main/recording-view.tsx", "renderer/trainer/trainer-panel-view.tsx"]) {
  const src = read(rel);
  assert(
    /const running = [^\n]*state\.replaying/.test(src),
    `${rel}: folds state.replaying into "running" — "executing" and "replayRun" are both local ` +
      "to the window that started the replay, so without this the OTHER trainer stays live and " +
      "its Add step lands mid-run",
  );
}

// ── 4. The resize log doesn't claim a replayed resize was manual ─────

const resizedHandler = service.slice(
  service.indexOf('recWindow.on("resized"'),
  service.indexOf('recWindow.on("resized"') + 900,
);
assert(
  /session\?\.replaying/.test(resizedHandler),
  "the `resized` listener ignores replayed resizes — a `viewport` step resizes this window " +
    "through the same host API, and that log exists to record the manual resizes which leave " +
    "no other trace",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll replay-suspend checks passed");
