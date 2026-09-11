// check:insights-egress — what the insights report is ALLOWED to send.
//
// The insights service is the app's only UNATTENDED LLM egress: on a schedule,
// with nobody reviewing the individual send, a payload leaves for the
// configured provider — off the machine entirely when that provider is Claude.
// The Alerts pane's disclosure promises the payload is summary-shaped: run
// counts, test names, error signatures — never run logs, console/network
// captures, script sources, Shopify header values, or secret values.
//
// An inaccurate disclosure is worse than none, so this check pins the promise
// three ways, none of which lint or type-check can hold:
//
//   1. SOURCE: no module under main/services/insights/ reaches for a log, a
//      script, the filesystem, or a signature header value. The facts builder
//      reads indexes and aggregates through its deps, and a new call that
//      widens that has to turn this check red first.
//   2. BEHAVIOR: a planted secret riding INSIDE the facts (a test name, an
//      offender line, an error signature) does not survive into the built
//      messages once the service's redaction step runs over them.
//   3. WIRING: the real service passes every message through `deps.redact`
//      BEFORE `deps.complete`, and wires `redact` to `redactWithSnapshot` —
//      the same scrubber the report emitters use. Redaction that exists but
//      is not on the send path is the failure check:emit-redaction was
//      written against, and it is invisible in review.
//
// Comments are stripped before the source scans — a guard that fires on the
// sentence documenting the rule teaches people to delete the documentation
// (the lesson check:emit-redaction learned on its first run).

import * as fs from "node:fs";
import * as path from "node:path";

import {
  redactWithSnapshot,
  setSecretSnapshotForTesting,
  REDACTED,
} from "../secret-redaction.js";
import { buildInsightMessages, describeInsightsSending } from "../insights/insight-prompts.js";
import type { InsightFacts } from "../insights/facts-builder.js";

let failures = 0;
function fail(message: string): void {
  failures++;
  console.error(`  ✗ ${message}`);
}
function ok(message: string): void {
  console.log(`  ✓ ${message}`);
}

// From the repo root, where every check runs — the bundle itself executes out
// of node_modules/.cache, so import.meta.url would point the source scan at
// the wrong tree.
const insightsDir = path.join(process.cwd(), "main", "services", "insights");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ── 1. Source: no path from the insights modules to forbidden content ──────

console.log("insights sources reach no log, script, filesystem or header value");

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /\bgetLog\b|\breadLogs\b|\bgetRunLog\b/, why: "reads a run log" },
  { pattern: /\bgetScript\b|\breadScript\b/, why: "reads a script source" },
  { pattern: /\blogFile\b/, why: "touches the raw log file field" },
  { pattern: /console\.json|network\.json/, why: "reads a console/network capture" },
  { pattern: /from ["']fs["']|from ["']node:fs["']|require\(["']fs["']\)/, why: "imports the filesystem" },
  { pattern: /\breadFileSync\b|\breadFile\b/, why: "reads a file" },
  { pattern: /\bsignatureFor\b|\bsignatureInput\b|\bsignatureAgent\b/, why: "reaches a Shopify header value" },
  { pattern: /NO_REDACTION/, why: "opts out of redaction" },
];

for (const file of fs.readdirSync(insightsDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
  const source = stripComments(fs.readFileSync(path.join(insightsDir, file), "utf-8"));
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(source)) {
      fail(`${file} ${why} (${pattern})`);
    }
  }
}
if (failures === 0) ok("every insights module is clean");

// ── 2. Behavior: a planted secret does not survive the redaction step ──────

console.log("a planted secret inside the facts never reaches the messages");

const SECRET = "hunter2-planted-secret-value";
setSecretSnapshotForTesting([SECRET]);

const facts: InsightFacts = {
  cadence: "weekly",
  periodLabel: "week",
  window: { since: 0, until: 1 },
  digest: {
    runs: 3,
    failed: 2,
    previousRuns: 0,
    offenders: [{ testId: "t1", testName: `Login with ${SECRET}`, failures: 2 }],
    flaky: 0,
    lines: [`Worst: Login with ${SECRET} (2×).`],
  },
  clusters: [
    {
      signature: `TimeoutError: waiting for ${SECRET}`,
      totalRuns: 2,
      tests: 1,
      firstSeenAt: 0,
      lastSeenAt: 1,
      isNew: true,
    },
  ],
  visualChangedSteps: null,
  heals: { healedSteps: 0, healFailures: 0, topTests: [{ testName: SECRET, healedSteps: 1 }] },
  a11y: { newViolationSteps: 0 },
  siteHealth: null,
  library: { totalTests: 1, testsCreated: 0, unreviewedScriptChanges: 0, pendingHeals: 0 },
  routines: [{ name: `Nightly ${SECRET}`, overdue: false, lastScheduledRunAt: null }],
  shopify: [],
  app: { version: "1.0.0", previousVersion: null, releaseNotes: [] },
  tests: [{ id: "t1", name: `Login with ${SECRET}` }],
};

// The exact transformation the service applies before deps.complete().
const redactedMessages = buildInsightMessages(facts).map((m) => ({
  ...m,
  content: redactWithSnapshot(m.content),
}));

const joined = redactedMessages.map((m) => m.content).join("\n");
if (joined.includes(SECRET)) {
  fail("the planted secret survived into the outgoing messages");
} else {
  ok("the planted secret was scrubbed everywhere it was planted");
}
if (!joined.includes(REDACTED)) {
  fail("nothing was redacted at all — the planted secret never entered the payload, so this check proved nothing");
} else {
  ok("the redaction marker is present, so the plant actually exercised the scrubber");
}

// The disclosure derives from the same payload — a category count mismatch
// means the pane would describe a send that no longer matches reality.
const userJson = JSON.parse(
  String(buildInsightMessages(facts)[1]?.content).replace(/^Data \(JSON\):\n/, ""),
) as Record<string, unknown>;
const sending = describeInsightsSending(facts);
if (sending.length !== Object.keys(userJson).length) {
  fail(
    `describeInsightsSending covers ${sending.length} categories but the payload has ${Object.keys(userJson).length}`,
  );
} else {
  ok("the sending disclosure covers every payload category");
}

// ── 3. Wiring: redaction sits ON the send path in the real service ─────────

console.log("the real service redacts before it sends");

const serviceSource = stripComments(
  fs.readFileSync(path.join(insightsDir, "insights-service.ts"), "utf-8"),
);

if (!/redact:\s*\(text\)\s*=>\s*redactWithSnapshot\(text\)/.test(serviceSource)) {
  fail("the real deps no longer wire `redact` to redactWithSnapshot");
} else {
  ok("real deps wire redact → redactWithSnapshot");
}
if (!/refreshRedaction:\s*\(\)\s*=>\s*refreshSecretSnapshot\(\)/.test(serviceSource)) {
  fail("the real deps no longer refresh the secret snapshot before redacting");
} else {
  ok("real deps refresh the snapshot");
}

const redactAt = serviceSource.indexOf("deps.redact(");
const completeAt = serviceSource.indexOf("deps.complete(");
if (redactAt === -1) {
  fail("the generate path no longer passes messages through deps.redact");
} else if (completeAt === -1) {
  fail("could not find the deps.complete call to order against");
} else if (redactAt > completeAt) {
  fail("deps.redact runs AFTER deps.complete — the payload leaves before it is scrubbed");
} else {
  ok("messages are redacted before the completion call");
}

// ── verdict ────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\ncheck:insights-egress FAILED (${failures})`);
  process.exit(1);
}
console.log("\ncheck:insights-egress passed");
