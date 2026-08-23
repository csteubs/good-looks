// check:editor-egress — what the Script IDE's AI, and AI debug, may send.
//
// The insights report has its egress check because it is the app's one
// UNATTENDED send. The interactive sends — Debug with AI, and since Phase 3
// the Script IDE's inline affordances — have a user present, but the user
// cannot read a prompt before it leaves, and the prompt quotes a script, a
// run's output, a page's structure and (Phase 3) the user's own instructions
// and selections. The place all of them pass through is ONE function:
// `streamChatOnce` in llm-service.ts, for every provider. So this check pins
// the chokepoint rather than the builders:
//
//   1. WIRING: llm-service refreshes the secret snapshot before each send and
//      scrubs every outgoing message with `redactWithSnapshot` BEFORE the
//      fetch, on the Anthropic branch and on the local branch alike.
//   2. BEHAVIOUR: a planted secret riding inside a DebugContext — the script,
//      the run output, the test name — does not survive the service's exact
//      transformation of the messages the real builder produces; and the
//      redaction marker IS present, so the plant exercised the scrubber.
//   3. STRUCTURE: the artifact readers that feed `artifacts:getStructure`
//      (step matches, heal failures) redact like `readLogs` does — the claim
//      the handler's comment made for a year before it was true.
//
// Comments are stripped before the source scans, as the insights check does.

import * as fs from "node:fs";
import * as path from "node:path";

import { REDACTED, redactWithSnapshot, setSecretSnapshotForTesting } from "../secret-redaction.js";
import { buildDebugMessages, buildStepDebugMessages, describeSending } from "../../../renderer/lib/llm-prompts.js";
import type { DebugContext } from "../../../renderer/lib/llm-prompts.js";

let failures = 0;
function fail(message: string): void {
  failures++;
  console.error(`  ✗ ${message}`);
}
function ok(message: string): void {
  console.log(`  ✓ ${message}`);
}
const read = (rel: string): string =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── 1. Wiring ───────────────────────────────────────────────────────────────
console.log("llm-service scrubs every outgoing message before the fetch");
const service = read("main/services/llm-service.ts");
const fnStart = service.indexOf("async function streamChatOnce(");
const fnEnd = service.indexOf("\nasync function", fnStart + 10);
const body = service.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
const redactAt = body.indexOf("redactedMessages(params.messages)");
const firstFetch = body.indexOf("appFetch(");
if (redactAt === -1) fail("streamChatOnce no longer builds its payload from redactedMessages(params.messages)");
else if (firstFetch === -1) fail("could not find the fetch in streamChatOnce");
else if (redactAt > firstFetch) fail("the messages are scrubbed AFTER the first fetch — the payload leaves unredacted");
else ok("messages are scrubbed before the first fetch");
if (/messages:\s*params\.messages/.test(body)) fail("a request body still sends params.messages raw");
else ok("no request body sends params.messages raw");
if (!/toAnthropicPayload\(outgoing\)/.test(body)) fail("the Anthropic branch does not build from the scrubbed messages");
else ok("the Anthropic branch builds from the scrubbed messages");
if (!/messages:\s*outgoing/.test(body)) fail("the local branch does not send the scrubbed messages");
else ok("the local branch sends the scrubbed messages");
const helper = service.slice(service.indexOf("function redactedMessages("), service.indexOf("async function streamChatOnce("));
if (!/redactWithSnapshot\(m\.content\)/.test(helper)) fail("redactedMessages no longer runs redactWithSnapshot over each message");
else ok("redactedMessages runs redactWithSnapshot over each message");
const refreshes = (service.match(/await refreshSecretSnapshot\(\);/g) ?? []).length;
if (refreshes < 2) fail(`the snapshot is refreshed on ${refreshes} send path(s); chat() and complete() both need it`);
else ok(`the snapshot is refreshed on ${refreshes} send paths`);

// ── 2. Behaviour ────────────────────────────────────────────────────────────
console.log("a planted secret inside the debug context never reaches the messages");
const SECRET = "hunter2-planted-secret-value";
setSecretSnapshotForTesting([SECRET]);
const ctx: DebugContext = {
  testName: `Login with ${SECRET}`,
  testUrl: `https://example.com/?token=${SECRET}`,
  script: `import { test } from "@playwright/test";\ntest("t", async ({ page }) => {\n  await page.fill("#pw", "${SECRET}");\n});\n`,
  output: `Error: expected "${SECRET}" to be visible`,
  imported: false,
  failedStepIndex: 1,
  logsAvailable: true,
  structureAvailable: true,
};
const scrub = (ms: { role: string; content: string }[]) => ms.map((m) => redactWithSnapshot(m.content)).join("\n");
for (const [label, messages] of [
  ["buildDebugMessages", buildDebugMessages(ctx)],
  [
    "buildStepDebugMessages",
    buildStepDebugMessages({
      testName: ctx.testName,
      url: ctx.testUrl,
      stepLabel: `click ${SECRET}`,
      logs: [{ level: "error", message: `page said ${SECRET}` }],
    } as unknown as Parameters<typeof buildStepDebugMessages>[0]),
  ],
] as const) {
  const raw = messages.map((m) => m.content).join("\n");
  if (!raw.includes(SECRET)) {
    fail(`${label}: the plant never entered the payload, so this proves nothing`);
    continue;
  }
  const joined = scrub(messages);
  if (joined.includes(SECRET)) fail(`${label}: the planted secret survived the service's scrub`);
  else ok(`${label}: the planted secret was scrubbed everywhere it was planted`);
  if (!joined.includes(REDACTED)) fail(`${label}: no redaction marker — the scrubber did not run`);
  else ok(`${label}: the redaction marker is present`);
}
// The disclosure strip names every payload the builder attaches.
const sending = describeSending(ctx).map((i) => i.label.toLowerCase()).join(" | ");
for (const needle of ["test name", "url", "script", "run output", "console", "structure"]) {
  if (!sending.includes(needle)) fail(`describeSending no longer names "${needle}" — the privacy strip has fallen behind the prompt`);
  else ok(`describeSending names "${needle}"`);
}
if (!buildDebugMessages(ctx).map((m) => m.content).join("\n").includes("Failed step:")) {
  fail("the failed step index no longer reaches the prompt");
} else ok("the failed step index reaches the prompt");

// ── 3. Structure readers redact ─────────────────────────────────────────────
console.log("the artifact readers behind artifacts:getStructure redact");
const store = read("main/services/artifact-store.ts");
for (const fn of ["readStepMatches", "readHealFailures", "readLogs"]) {
  const at = store.indexOf(`${fn}(testId: string, runId: string)`);
  const slice = store.slice(at, store.indexOf("\n  },", at));
  if (at === -1) fail(`could not find ${fn}`);
  else if (!/redactWithSnapshot\(/.test(slice)) fail(`${fn} reads the file without redactWithSnapshot`);
  else ok(`${fn} redacts what it reads`);
}

if (failures > 0) {
  console.error(`\ncheck:editor-egress FAILED (${failures})`);
  process.exit(1);
}
console.log("\ncheck:editor-egress passed");
