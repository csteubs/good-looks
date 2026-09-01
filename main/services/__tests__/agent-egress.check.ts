// check:agent-egress — what the trainer's AI features are ALLOWED to send.
//
// The suggestion strip is the trainer's one UNATTENDED LLM egress: after a
// captured step, on a debounce, with nobody reviewing the individual send, a
// payload leaves for the configured provider — off the machine entirely when
// that provider is Claude. The Recording pane's disclosure promises the
// payload is inventory-shaped: the step list's descriptions and a bounded
// summary of the page's visible controls — never what the user typed into a
// field, page HTML, run logs, script sources, headers, or secret values.
// The agent drawer's runs are attended (each starts from an explicit send),
// but they carry the same page-derived payload, so both are pinned here.
//
// An inaccurate disclosure is worse than none, so this check pins the
// promise the way check:insights-egress pins the report's, three ways:
//
//   1. SOURCE: no module under main/services/agent/ reaches for a log, a
//      script, the filesystem, or a signature header value — and the page
//      summary never carries a field's VALUE (the one hole specific to this
//      surface: the inventory describes inputs the user may just have typed
//      a password into).
//   2. BEHAVIOR: a planted secret riding inside the context (a step label,
//      the page title, an element's text) does not survive into the built
//      messages once the services' redaction step runs over them — for the
//      suggestion messages AND the agent-turn messages.
//   3. WIRING: both real services pass every message through `deps.redact`
//      BEFORE `deps.completeJson`, wire `redact` to `redactWithSnapshot`,
//      and the suggestion service re-checks `suggestionsEnabled` at send
//      time — the flag wired to the recorder settings store's
//      `aiSuggestionsEnabled`, whose default is OFF. Redaction (or a flag)
//      that exists but is not on the send path is invisible in review.
//
// Comments are stripped before the source scans — a guard that fires on the
// sentence documenting the rule teaches people to delete the documentation.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  redactWithSnapshot,
  setSecretSnapshotForTesting,
  REDACTED,
} from "../secret-redaction.js";
import { buildAgentMessages, buildSuggestionMessages } from "../agent/agent-prompts.js";
import type { PageSummary } from "../agent/page-summary.js";

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
const agentDir = path.join(process.cwd(), "main", "services", "agent");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ── 1. Source: no path from the agent modules to forbidden content ─────────

console.log("agent sources reach no log, script, filesystem, header or field value");

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

for (const file of fs.readdirSync(agentDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
  const source = stripComments(fs.readFileSync(path.join(agentDir, file), "utf-8"));
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(source)) {
      fail(`${file} ${why} (${pattern})`);
    }
  }
}
if (failures === 0) ok("every agent module is clean");

// The inventory probe must never read what is TYPED into a field — `.value`
// on the collected elements is the password the user just entered. The probe
// is a string (it runs in the page), so the scan covers the string too;
// `el.value` has no legitimate use anywhere in the collector.
{
  const source = fs.readFileSync(path.join(agentDir, "page-summary.ts"), "utf-8");
  if (/\bel\.value\b|\.value\s*[,;)\]}]/.test(stripComments(source))) {
    fail("page-summary.ts reads an element's value — the inventory would carry what the user typed");
  } else {
    ok("the page inventory never reads a field's value");
  }
}

// ── 2. Behavior: a planted secret does not survive the redaction step ──────

console.log("a planted secret inside the context never reaches the messages");

const SECRET = "hunter2-planted-secret-value";
setSecretSnapshotForTesting([SECRET]);

const summary: PageSummary = {
  url: `https://shop.test/checkout?token=${SECRET}`,
  title: `Checkout — ${SECRET}`,
  elements: [
    { tag: "button", role: "button", name: `Pay with ${SECRET}`, text: SECRET },
    { tag: "input", placeholder: `Enter ${SECRET}`, type: "text" },
  ],
  total: 2,
};

// The exact transformation each service applies before deps.completeJson().
const suggestionJoined = buildSuggestionMessages({
  url: summary.url,
  title: summary.title,
  stepsTail: [`Fill "Email" with ${SECRET}`],
  summary,
})
  .map((m) => redactWithSnapshot(m.content))
  .join("\n");

const agentJoined = buildAgentMessages({
  goal: `log in as ${SECRET}`,
  url: summary.url,
  title: summary.title,
  stepsTail: [`Fill "Email" with ${SECRET}`],
  summary,
  userNotes: [`use ${SECRET}`],
  evidence: [`ERROR: ${SECRET} matched nothing`],
  remainingSteps: 5,
})
  .map((m) => redactWithSnapshot(m.content))
  .join("\n");

for (const [label, joined] of [
  ["suggestion", suggestionJoined],
  ["agent-turn", agentJoined],
] as const) {
  if (joined.includes(SECRET)) {
    fail(`the planted secret survived into the outgoing ${label} messages`);
  } else {
    ok(`the planted secret was scrubbed from the ${label} messages`);
  }
  if (!joined.includes(REDACTED)) {
    fail(`nothing was redacted in the ${label} messages — the plant never entered the payload, so this proved nothing`);
  } else {
    ok(`the ${label} redaction marker is present, so the plant actually exercised the scrubber`);
  }
}

// ── 3. Wiring: redaction and the flag sit ON the send path ─────────────────

console.log("both real services redact before they send; the strip's flag gates the send");

for (const file of ["suggestion-service.ts", "trainer-agent-service.ts"]) {
  const source = stripComments(fs.readFileSync(path.join(agentDir, file), "utf-8"));

  if (!/redact:\s*\(text\)\s*=>\s*redactWithSnapshot\(text\)/.test(source)) {
    fail(`${file}: the real deps no longer wire \`redact\` to redactWithSnapshot`);
  } else {
    ok(`${file}: real deps wire redact → redactWithSnapshot`);
  }
  if (!/refreshRedaction:\s*\(\)\s*=>\s*refreshSecretSnapshot\(\)/.test(source)) {
    fail(`${file}: the real deps no longer refresh the secret snapshot before redacting`);
  } else {
    ok(`${file}: real deps refresh the snapshot`);
  }

  const redactAt = source.indexOf("deps.redact(");
  const completeAt = source.indexOf("deps.completeJson(");
  if (redactAt === -1) {
    fail(`${file}: the send path no longer passes messages through deps.redact`);
  } else if (completeAt === -1) {
    fail(`${file}: could not find the deps.completeJson call to order against`);
  } else if (redactAt > completeAt) {
    fail(`${file}: deps.redact runs AFTER deps.completeJson — the payload leaves before it is scrubbed`);
  } else {
    ok(`${file}: messages are redacted before the completion call`);
  }
}

{
  const source = stripComments(fs.readFileSync(path.join(agentDir, "suggestion-service.ts"), "utf-8"));

  // The OFF-by-default setting is the consent; it has to be read at send
  // time (a flag flipped off mid-debounce must win) and again after the
  // model answers, and the real binding has to read the store's
  // aiSuggestionsEnabled rather than a copy that drifts.
  const guards = source.match(/if \(!deps\.suggestionsEnabled\(\)\) return;/g) ?? [];
  if (guards.length < 2) {
    fail(
      `suggestion-service.ts re-checks suggestionsEnabled ${guards.length} time(s) on the send path — need the send-time check AND the post-answer discard`,
    );
  } else {
    ok("the flag is re-checked at send time and after the model answers");
  }
  if (!/suggestionsEnabled:\s*\(\)\s*=>\s*recorderSettingsStore\.get\(\)\.aiSuggestionsEnabled/.test(source)) {
    fail("the real deps no longer wire suggestionsEnabled to the settings store's aiSuggestionsEnabled");
  } else {
    ok("real deps wire suggestionsEnabled → recorderSettingsStore.get().aiSuggestionsEnabled");
  }
}

{
  // And the default really is OFF — the disclosure's whole claim.
  const store = stripComments(
    fs.readFileSync(path.join(process.cwd(), "main", "services", "recorder-settings-store.ts"), "utf-8"),
  );
  if (!/aiSuggestionsEnabled:\s*false/.test(store)) {
    fail("DEFAULT_SETTINGS no longer defaults aiSuggestionsEnabled to false");
  } else {
    ok("aiSuggestionsEnabled defaults to false");
  }
}

// ── verdict ────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\ncheck:agent-egress FAILED (${failures})`);
  process.exit(1);
}
console.log("\ncheck:agent-egress passed");
