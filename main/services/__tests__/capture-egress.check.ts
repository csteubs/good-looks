// The wiring that carries a captured step out of the page — pinned at source.
//
//   npm run check:capture-egress
//
// ── Why a source-level check ───────────────────────────────────────────────
// `recorder-service.ts` opens real windows and imports `@shell/backend`; there
// is no unit test of it, and the properties below are exactly the ones with no
// visible symptom when they break:
//
//  • Delete the `console-message` listener and the recorder falls back to the
//    poll — which is the bug that was reported (a click that navigates is
//    silently never recorded). Everything else keeps working, and every
//    non-navigating click still records perfectly.
//  • Ingest a step without `normalizeRawSteps` and the capture boundary is
//    open. A step becomes a spec that is executed in Node, so that is remote
//    code execution, and the second channel is a second place to forget it.
//  • Re-inject without the world-scoped install guard and every step after the
//    first navigation is recorded twice.
//
// The end-to-end proof lives in e2e/click-navigation.spec.ts, which the local
// gate does not run. This is what fails on a laptop, in a second.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCaptureScript,
  DRAIN_SCRIPT,
  WORLD_STATE_KEY,
} from "../../recorder/capture-script.js";
import {
  CAPTURE_MESSAGE_PREFIX,
  CaptureLedger,
  parseCaptureMessage,
  parseDrainPayload,
} from "../../recorder/capture-channel.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, "..", "..", rel), "utf8");

let failures = 0;
function assert(ok: boolean, label: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

const service = read("services/recorder-service.ts");

// ── 1. The primary channel is wired at all ────────────────────────────────
{
  assert(
    /wc\.on\("console-message"/.test(service),
    "the training page's console-message event is subscribed to",
  );
  assert(
    /parseCaptureMessage\(details\.message, session\.captureNonce\)/.test(service),
    "console messages are read with THIS session's nonce",
  );
  assert(
    /captureNonce: randomUUID\(\)/.test(service),
    "the nonce is generated per session, not a constant",
  );
  assert(
    // The nonce must be the FIRST argument; the attribute list rides second.
    /buildCaptureScript\(\s*session\.captureNonce[,)]/.test(service),
    "the injected script carries that session's nonce",
  );
}

// ── 2. Every channel crosses the capture boundary ─────────────────────────
{
  // The one place page-authored steps become session steps.
  const ingestSites = service.match(/normalizeRawSteps\(/g) ?? [];
  assertEqual(ingestSites.length, 1, "there is exactly ONE normalizeRawSteps call site");
  assert(
    /function recordCaptured\(steps: unknown\[\]\): void \{[\s\S]*?normalizeRawSteps\(steps\)/.test(
      service,
    ),
    "that call site is recordCaptured",
  );
  for (const source of ["console", "drain"]) {
    assert(
      new RegExp(`ingestCapture\\(entry, "${source}"\\)`).test(service),
      `the ${source} channel ingests through ingestCapture`,
    );
  }
  assert(
    /function ingestCapture\([\s\S]*?captureLedger\.admit\([\s\S]*?recordCaptured\(ready\)/.test(
      service,
    ),
    "ingestCapture admits through the ledger and records through recordCaptured",
  );
  // A step must never reach addStep straight off a channel.
  assert(
    !/addStep\((?:step|entry|raw)\)/.test(service.replace(/normalizeRawSteps\(steps\)\) addStep\(step\)/g, "")),
    "no channel calls addStep with an unnormalized page value",
  );
}

// ── 3. Self-healing injection, and why it cannot double-install ───────────
{
  assert(
    /if \(!payload\.installed\) \{[\s\S]*?injectCapture\(\)/.test(service),
    "a drain that reports capture missing re-injects it",
  );
  const script = buildCaptureScript("nonce");
  assert(
    script.includes(`if (window.${WORLD_STATE_KEY}) return;`),
    "the capture script refuses to install over its own live state",
  );
  assert(
    DRAIN_SCRIPT.includes(`window.${WORLD_STATE_KEY}`),
    "the drain reports installed-ness from that same state",
  );
  // The pair is the whole safety argument for re-injecting: the marker the
  // drain reads and the guard the script checks must be ONE thing.
  assert(
    !/data-pw-installed|data-pw-queue/.test(script + DRAIN_SCRIPT),
    "no page-writable attribute is left claiming to mark capture as installed",
  );
}

// ── 4. Egress happens inside the dispatch, not after it ───────────────────
{
  const script = buildCaptureScript("nonce");
  const push = /function push\(step\) \{([\s\S]*?)\n {2}\}/.exec(script)?.[1] ?? "";
  assert(push.includes("emit(entry)"), "push emits the step");
  assert(
    push.indexOf("emit(entry)") < push.indexOf("gl.queue.push"),
    "push emits BEFORE it queues — the queue is the backup, and a queue write that throws must not cost the step",
  );
  assert(
    script.includes('window.addEventListener("click", onClickOnce, true)'),
    "clicks are captured at window, ahead of anything on the document",
  );
  assert(
    !script.includes('addEventListener("beforeunload"'),
    "the pointerdown rescue is NOT on beforeunload — it fires mid-click and records the click twice",
  );
  assert(
    script.includes('window.addEventListener("pagehide", flushPendingDown, true)'),
    "the pointerdown rescue is on pagehide",
  );
}

// ── 5. The two channels agree, end to end ─────────────────────────────────
{
  // Not a mock: this is the real emitted line, the real drain payload and the
  // real ledger, wired the way the service wires them.
  const step = { type: "click", locator: { k: "css", v: "#pay" } };
  const line = CAPTURE_MESSAGE_PREFIX + JSON.stringify({ n: "N", d: "doc1", i: 1, s: step });
  const fromConsole = parseCaptureMessage(line, "N");
  const fromDrain = parseDrainPayload(
    JSON.stringify({ d: "doc1", installed: 1, q: [{ i: 1, s: step }] }),
  );
  assert(!!fromConsole && !!fromDrain, "both channels parse the same step");

  const ledger = new CaptureLedger();
  const first = ledger.admit(fromConsole!, 1_000);
  const second = ledger.admit(fromDrain!.entries[0], 1_250);
  assertEqual(first.length, 1, "the console delivery is recorded");
  assertEqual(second.length, 0, "the drain's copy of it is not recorded again");
}

console.log(failures === 0 ? "\nAll capture-egress checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
