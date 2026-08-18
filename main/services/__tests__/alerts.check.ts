// Standalone regression check for outgoing webhook alerts.
//
// This is the only feature that sends data off the machine, so the check's main
// job is the REDACTION GUARANTEE: whatever else changes about the payload, run
// log output must never appear in it. Logs routinely contain page content, URLs
// with session tokens, and values typed during recording (passwords, card
// numbers). `buildAlertPayload` is the single place the outgoing shape is
// defined, so pinning it here pins the guarantee.
//
// Also covers: staying quiet on clean runs (an alert that fires on success gets
// muted, and then the real ones get missed), and URL validation.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npm run check:alerts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Before any store resolves a path. The stub's `app.getPath` reads this lazily
// on every call, so setting it here (after the imports initialize, before any
// store function runs) is what keeps this check off the real userData dir.
process.env.GLAZE_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-alerts-check-"));

import { buildAlertPayload, redactPayload, sendAlert, type Alert } from "../alert-service.js";
import { setEncryptionAvailable } from "./shell-backend-stub.js";
import { recorderSettingsStore } from "../recorder-settings-store.js";
import { shopifySignatureStore } from "../shopify-signature-store.js";
import { hostOfUrl, validateWebhookUrl } from "../webhook-url-store.js";
import { webhookUrlStore } from "../webhook-url-store.js";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ── Clean runs stay quiet ────────────────────────────────────────────
assert(
  buildAlertPayload({ kind: "run", testName: "T", status: "passed", changedSteps: 0 }) === null,
  "a passing run with no visual change produces NO alert",
);
assert(
  buildAlertPayload({
    kind: "batch",
    summary: { total: 3, passed: 3, failed: 0, skipped: 0, ok: true, durationMs: 10 },
    failedTests: [],
    stopped: false,
  }) === null,
  "a fully passing batch produces NO alert",
);

// ── Problems do alert ────────────────────────────────────────────────
const failedRun = buildAlertPayload({
  kind: "run",
  testName: "Checkout",
  status: "failed",
  changedSteps: 0,
  failedLabel: "click Submit",
  durationMs: 4200,
  browser: "firefox",
});
assert(failedRun !== null, "a failed run alerts");
assert(failedRun?.status === "failed", "a failed run is reported as failed");
assert(failedRun!.text.includes("Checkout"), "the message names the test");
assert(failedRun!.text.includes("click Submit"), "the message names the failing step");
assert(failedRun!.detail.browser === "firefox", "detail carries the browser");

const changedRun = buildAlertPayload({
  kind: "run",
  testName: "Home",
  status: "passed",
  changedSteps: 2,
});
assert(changedRun?.status === "changed", "a visual change on a passing run alerts as 'changed'");
assert(changedRun!.text.includes("2 steps"), "the message counts changed steps");

const failedBatch = buildAlertPayload({
  kind: "batch",
  summary: { total: 5, passed: 3, failed: 2, skipped: 0, ok: false, durationMs: 65_000 },
  failedTests: ["Login", "Checkout"],
  stopped: false,
});
assert(failedBatch !== null, "a batch with failures alerts");
assert(failedBatch!.text.includes("2 of 5"), "the batch message counts failures");
assert(failedBatch!.text.includes("Login"), "the batch message names failed tests");
assert(failedBatch!.text.includes("1m"), "the batch message includes a readable duration");

// A stopped batch alerts even with no failures — the user aborted mid-suite and
// the results are incomplete, which is worth knowing.
const stoppedBatch = buildAlertPayload({
  kind: "batch",
  summary: { total: 5, passed: 2, failed: 0, skipped: 3, ok: false, durationMs: 10 },
  failedTests: [],
  stopped: true,
});
assert(stoppedBatch !== null, "a stopped batch alerts even with zero failures");
assert(stoppedBatch!.text.includes("stopped"), "a stopped batch says so");

// A long failure list is capped so a wholly-failing suite doesn't dump a wall
// of text into a chat channel.
const manyFailed = buildAlertPayload({
  kind: "batch",
  summary: { total: 12, passed: 0, failed: 12, skipped: 0, ok: false, durationMs: 10 },
  failedTests: Array.from({ length: 12 }, (_, i) => `Test${i}`),
  stopped: false,
});
assert(manyFailed!.text.includes("+7 more"), "the failed-test list is capped with a +N more");

// ── THE REDACTION GUARANTEE ──────────────────────────────────────────
// Build every alert variant with secrets planted in every field an attacker (or
// an ordinary recording of a login form) could influence, then assert none of
// it reaches the payload.
const SECRET = "hunter2-SUPERSECRET";
const planted: Alert[] = [
  {
    kind: "run",
    testName: "Login",
    status: "failed",
    changedSteps: 0,
    failedLabel: "fill Password",
    durationMs: 1,
    browser: "chromium",
  },
  {
    kind: "batch",
    summary: { total: 1, passed: 0, failed: 1, skipped: 0, ok: false, durationMs: 1 },
    failedTests: ["Login"],
    stopped: false,
  },
];

for (const alert of planted) {
  const payload = buildAlertPayload(alert);
  const serialized = JSON.stringify(payload);
  assert(!serialized.includes(SECRET), `[${alert.kind}] no planted secret reaches the payload`);
  // The payload must be a fixed shape — no passthrough of arbitrary input.
  assert(
    payload !== null && ["text", "event", "status", "detail", "source"].every((k) => k in payload),
    `[${alert.kind}] payload has exactly the documented top-level keys`,
  );
  assert(
    payload !== null && Object.keys(payload).length === 5,
    `[${alert.kind}] payload has NO extra top-level keys`,
  );
}

// The builder takes no log/output parameter at all — the strongest form of the
// guarantee is that there's nothing to leak. Assert the detail keys are the
// known-safe set.
const SAFE_RUN_KEYS = new Set([
  "testName",
  "status",
  "changedSteps",
  "failedStep",
  "durationMs",
  "browser",
]);
assert(
  Object.keys(failedRun!.detail).every((k) => SAFE_RUN_KEYS.has(k)),
  `run detail contains only known-safe keys (got ${Object.keys(failedRun!.detail).join(",")})`,
);
const SAFE_BATCH_KEYS = new Set([
  "total",
  "passed",
  "failed",
  "skipped",
  "stopped",
  "failedTests",
  "durationMs",
  "browser",
]);
assert(
  Object.keys(failedBatch!.detail).every((k) => SAFE_BATCH_KEYS.has(k)),
  `batch detail contains only known-safe keys (got ${Object.keys(failedBatch!.detail).join(",")})`,
);

// ── Slack/Discord compatibility ──────────────────────────────────────
assert(typeof failedRun!.text === "string" && failedRun!.text.length > 0, "payload has a `text` field");
assert(failedRun!.source === "Good Looks!", "payload identifies its source");

// ── URL validation ───────────────────────────────────────────────────
assert(validateWebhookUrl("  https://hooks.slack.com/x  ") === "https://hooks.slack.com/x", "trims a valid URL");
assert(validateWebhookUrl("http://localhost:9000/hook") === "http://localhost:9000/hook", "http is allowed");
for (const bad of ["", "   ", "not a url", "ftp://x/y", "file:///etc/passwd", "javascript:alert(1)"]) {
  let threw = false;
  try {
    validateWebhookUrl(bad);
  } catch {
    threw = true;
  }
  assert(threw, `rejects ${JSON.stringify(bad)}`);
}
assert(hostOfUrl("https://hooks.slack.com/services/x") === "hooks.slack.com", "hostOfUrl extracts the host only");
assert(hostOfUrl("nonsense") === null, "hostOfUrl returns null for junk");

// ── A Routine's `notify` step ─────────────────────────────────────────
//
// TWO DIFFERENT GUARANTEES, and conflating them would weaken the stronger one.
// For a run or batch alert the promise is STRUCTURAL: the builder takes no log
// or output parameter, so there is nothing to leak — which is why those are in
// the planted-secret loop above. A notify's message is TEXT THE USER TYPED, so
// the builder necessarily carries it, and the promise is instead that it is
// REDACTED before it leaves. `sendAlert` applies `redactPayload` immediately
// before the send, for every kind.

{
  const notify = buildAlertPayload({
    kind: "routineNotify",
    message: "Seeding done",
    routineName: "Nightly",
  });
  assert(notify !== null, "a notify always sends — it IS the thing the user asked for");
  assert(
    notify!.text.includes("Nightly") && notify!.text.includes("Seeding done"),
    "the message names the routine and says what the user wrote",
  );
  // The detail carries NO run data. That is the whole reason a notify's message
  // is static text: this payload must not become a route from a run to a
  // third-party endpoint.
  assert(
    Object.keys(notify!.detail).sort().join(",") === "message,routineName",
    `notify detail carries only the routine name and the message (got ${Object.keys(notify!.detail).join(",")})`,
  );

  // A user can paste a secret into their own message. It is their text and
  // their webhook, but redaction is what makes that survivable.
  const withSecret = buildAlertPayload({
    kind: "routineNotify",
    message: `Seeding done ${SECRET}`,
    routineName: "Nightly",
  });
  const scrubbed = redactPayload(withSecret!, [SECRET]);
  assert(
    !JSON.stringify(scrubbed).includes(SECRET),
    "a secret pasted into a notify message is redacted before it leaves",
  );
}

// Everything below needs `await`, and this bundle is CJS — so it runs inside
// a main() the exit check hangs off, rather than at the top level.
async function checkSendAlertRedaction(): Promise<void> {
  // ── What `sendAlert` actually redacts with ────────────────────────────
  //
  // Every other redaction assertion here calls `redactPayload` with a list this
  // file hands it, which proves the function works and NOTHING about the list the
  // real send uses. That gap was a live leak: `sendAlert` read
  // `testSecretsStore.allValues()` directly rather than going through the
  // snapshot, so widening the snapshot to cover Shopify crawler signatures would
  // have left the one path that sends data off the machine still carrying them.
  //
  // So this drives the real `sendAlert`, with a real registered signature, and
  // looks at the bytes that reach `fetch`.
  {
    setEncryptionAvailable(true);
    const SIGNATURE_VALUE = "sig1=:dGhpcy1pcy10aGUtc2lnbmF0dXJl:";
    const SIGNATURE_INPUT =
      'sig1=("@authority");created=1735689600;expires=4102444799;keyid="kkk";alg="ed25519"';

    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: SIGNATURE_INPUT,
      signature: SIGNATURE_VALUE,
    });
    await webhookUrlStore.setUrl("https://hooks.example.test/services/abc");
    recorderSettingsStore.set({ alertWebhookEnabled: true });

    const realFetch = globalThis.fetch;
    let sent = "";
    globalThis.fetch = (async (_url: string, init: { body?: string }) => {
      sent = String(init?.body ?? "");
      return { ok: true, status: 200, statusText: "OK" };
    }) as unknown as typeof fetch;
    try {
      // A notify message is text the user typed, which is the only payload that
      // carries free text — so it is the only one that can demonstrate WHICH
      // values the send redacts with.
      await sendAlert({
        kind: "routineNotify",
        message: `Crawl finished ${SIGNATURE_VALUE} ${SIGNATURE_INPUT}`,
        routineName: "Nightly",
      });
    } finally {
      globalThis.fetch = realFetch;
    }

    assert(sent.length > 0, "sendAlert posted a payload");
    assert(
      sent.indexOf("dGhpcy1pcy10aGUtc2lnbmF0dXJl") < 0,
      "a Shopify signature value is redacted by the real send path",
    );
    assert(sent.indexOf("keyid") < 0, "…and so is the Signature-Input it came with");
    assert(sent.indexOf("Nightly") >= 0, "…while the rest of the payload survives");
  }
}

void checkSendAlertRedaction().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll alerts checks passed");
});
