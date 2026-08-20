// The inline-flow scope's structural guarantees, pinned at source level — the
// same shape as check:capture-egress's single-ingest guard, and for the same
// reason: every way of breaking these is silent.
//
//  • Routing lives in `addStep`, the ONE funnel both capture channels and
//    insertStep reach. Routed anywhere shallower, a new arrival path lands a
//    captured step in the CALLER while the banner says it is recording into
//    the flow — no error, wrong test edited.
//  • Every path that runs or saves what the store holds commits the scope
//    first (the three whole-list replays, finalize, runner:run). One that
//    doesn't runs the STALE flow at the exact moment the user is verifying
//    their edit.
//  • `discardExit` must NOT commit — "Discard" means the working copy is
//    dropped unwritten.
//  • The scope's steps travel on their own push, never on `recorder:steps`,
//    whose payload two other consumers type as the session's Step[].
//
// Run with: npm run check:flow-scope

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

function methodBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) return "";
  return source.slice(start, source.indexOf("\n  },", start));
}

const service = read("main/services/recorder-service.ts");
const handlers = read("main/handlers/index.ts");

// ── 1. Ingest routing lives in the funnel ────────────────────────────

const addStepStart = service.indexOf("function addStep(raw: RawStep): void {");
const addStepBody = service.slice(addStepStart, service.indexOf("\n}", addStepStart));
assert(addStepStart >= 0, "recorder-service.ts still has the addStep funnel");
assert(
  /session\.flowScope/.test(addStepBody),
  "addStep routes an open scope's arrivals into the working copy — routed anywhere " +
    "shallower, a new capture path lands steps in the caller while the banner says otherwise",
);
assert(
  addStepBody.indexOf("session.flowScope") < addStepBody.indexOf("session.steps.splice"),
  "…and the scope check comes BEFORE the session splice, so the scope path cannot fall through",
);

// ── 2. Every run/save path commits first ─────────────────────────────

for (const name of ["replayFromStart", "replayAll", "replayFromCurrent"] as const) {
  const body = methodBody(service, `async ${name}(`);
  assert(
    /commitFlowScope\(\)/.test(body),
    `${name} commits an open scope before replaying — a whole-list replay runs the caller's ` +
      "list, and an uncommitted scope means it replays the stale flow",
  );
  assert(
    body.indexOf("commitFlowScope()") < body.indexOf("withCaptureSuspended"),
    `${name}: …and BEFORE the run starts, not somewhere inside it`,
  );
}

const finalizeStart = service.indexOf("async function finalize(");
const finalizeBody = service.slice(finalizeStart, service.indexOf("\n}", finalizeStart));
assert(
  /commitFlowScope\(\)/.test(finalizeBody),
  "finalize commits an open scope — Save Test must not silently drop edits the banner " +
    "said were being recorded into the flow",
);

const discardBody = methodBody(service, "discardExit(): void {");
assert(
  !/commitFlowScope\(\)/.test(discardBody),
  "discardExit does NOT commit — a discard drops the working copy unwritten, which is " +
    "what the button promises",
);

assert(
  /recorderService\.exitFlowScope\(\)/.test(
    handlers.slice(handlers.indexOf('"runner:run"'), handlers.indexOf('"runner:replayRun"')),
  ),
  "runner:run commits an open scope before spawning — the run executes stored specs, and " +
    "an uncommitted scope means it runs yesterday's flow",
);

// ── 3. The scope's steps never ride recorder:steps ───────────────────

assert(
  /sendToMain\(\s*"recorder:flowScope"/.test(service),
  "the scope broadcasts on its own channel (recorder:flowScope)",
);
const broadcastStepsStart = service.indexOf("function broadcastSteps(): void {");
const broadcastStepsBody = service.slice(
  broadcastStepsStart,
  service.indexOf("\n}", broadcastStepsStart),
);
assert(
  !/flowScope/.test(broadcastStepsBody),
  "broadcastSteps carries ONLY the session's list — two consumers type that payload as " +
    "the session's Step[], and a second list smuggled in would be read as the wrong one",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll flow-scope checks passed");
