// What leaves the main process, and by which door.
//
// Two rules are already written down in this repo, one per outbound concern,
// and both had exactly one call site that did not follow them. Neither was
// caught by lint, type-check or any test, because both deviations are perfectly
// valid code that merely asks a narrower question than the app's rule does.
//
// ── Rule one: every app request goes through `appFetch` ──────────────────────
//
// `main/services/proxy-service.ts` exists so that "does THIS request use the
// proxy" is answered once. Settings > Proxy reaches the app's own Node-side
// traffic ONLY through `appFetch`; a bare global `fetch` is a request the
// setting cannot see. `mailbox-service.ts` called the global one for the
// Settings > Integrations probe, so on a machine whose app traffic is proxied
// the Test button was not testing the path anything else in the app uses —
// reachable-but-failing, or unreachable-but-fine, with no way to tell which
// from the message.
//
// ── Rule two: outgoing text is redacted over `allRedactableValues()` ─────────
//
// `main/services/secret-redaction.ts` names THREE stores, because there are
// three ways a credential reaches a run's output — a secret variable typed into
// the page, a Shopify crawler signature this app attaches to a request, and the
// test-mailbox token the generated spec sends. `alert-service.ts` records why
// asking one of them is not enough: "widening the snapshot silently leaves this
// one behind — as it did when Shopify signatures were added to it".
// `issue-tracker-service.ts` redacted the outgoing issue title and body over
// `testSecretsStore.allValues()`, so a signature or a mailbox token in the text
// would have gone out as written. It is the LAST gate before an issue leaves
// the machine and the one over text this process did not build — `issues:
// createIssue` takes the title and body from the renderer, because the compose
// dialog lets the user edit the draft. No leak was demonstrated: the evidence a
// draft is assembled from is already redacted over the full set upstream. A
// layer of defence in depth that covers less than the ones above it is the
// worse failure, because they are what hide its narrowness.
//
// ── Why a SOURCE check and not only a test ──────────────────────────────────
//
// Both deviations are absences. A behavioural test proves the paths that exist
// today are closed; it says nothing about the next service that reaches the
// network or the next thing that files something. This is the guard that makes
// a third one someone's deliberate decision — the same posture, and the same
// annoying-on-purpose allowlist, as `check:renderer-egress`.
//
// Each rule therefore carries its own PROOF THAT IT STILL WORKS, because a
// scan whose healthy state is zero findings is otherwise indistinguishable
// from a scan that read nothing: a synthetic battery of spellings that must
// and must not match, and a LIVE positive control run through the whole
// apparatus — the walk, the reader, the blanking, the regex — against the one
// file each rule exempts. Being exempt is exactly what frees a file to be the
// fixture.
//
// Run with: npm run check:main-egress

import { join } from "node:path";

// The reader lives in one place because both egress checks had the same bug in
// their own copy of it, three months apart. See `source-scan.ts`.
import { codeOf, offendersIn, scanFile, walk } from "./source-scan.js";

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

/** Not shipped, and allowed to name whatever it asserts about — including this
 *  check's own subject matter. `email-code-emission.test.ts` asserts on the
 *  literal string "await fetch(url", which is a FIXTURE's source and not this
 *  process's traffic; `llm-service.test.ts` assigns `globalThis.fetch` to keep
 *  itself off a real provider. */
function isTest(file: string): boolean {
  return /\.test\.tsx?$/.test(file) || file.includes("/__tests__/");
}

// ── 1. Only proxy-service.ts may call the global fetch ───────────────

/**
 * A bare call to the global `fetch`.
 *
 * The leading class is what makes the check usable rather than a source of
 * suppressions: `appFetch(`, `net.fetch(` and `worker.fetch(` are all preceded
 * by an identifier character or a dot and do NOT match, which is correct — an
 * injected `fetchImpl`, Chromium's `net` (which honours the session proxy this
 * same service configures) and a Cloudflare Worker's own handler are not this
 * app deciding to skip the proxy. `fetchModels(` does not match either: the
 * token has to be exactly `fetch` before the paren.
 *
 * `undiciFetch(` is the one exempted spelling that WOULD be a bypass — undici's
 * own fetch, called without a dispatcher, answers to no proxy setting. It is
 * unreachable rather than judged safe: getting that binding needs an undici
 * import, and rule 2 below allows one only in the file this rule already
 * exempts. The two rules cover each other there, which is why they are
 * separate rules and not one.
 *
 * It does match a DECLARATION spelled `fetch(…)` — an interface member, or an
 * object-literal shorthand method — which is a false positive and the line
 * hatch is its answer. Narrowing the regex to exclude declarations would mean
 * parsing, and the failure directions are not symmetric: a missed call is the
 * bug this file exists to prevent, and a flagged declaration is a comment.
 */
const BARE_FETCH = /(^|[^A-Za-z0-9_$.])fetch\s*\(/;

/** The same call spelled through a global object, which the dot in the class
 *  above would otherwise wave through. `\??\.` because `globalThis?.fetch(url)`
 *  is one character away from the plain form and reads as ordinary caution. */
const GLOBAL_FETCH = /\b(?:globalThis|global|window|self)\s*\??\.\s*fetch\s*\(/;

/** …and through a computed property, which lives inside a literal and so is
 *  asked of the literal-preserving text. */
const INDEXED_FETCH = /\[\s*["'`]fetch["'`]\s*\]\s*\(/;

/**
 * The global taken as a VALUE rather than called, which is how every
 * call-shaped rule above is escaped: `const go = fetch` and then `go(url)`
 * one line later, where nothing at the call site names `fetch` at all.
 *
 * Two shapes, because a binding is either assigned or destructured. Neither
 * matches anything in shipped `main/**` today — `undiciFetch` is renamed
 * inside a nested array pattern in the owner, which is exempt regardless.
 */
const TAKEN_FETCH = /(^|[^A-Za-z0-9_$.])fetch\s*(?:;|,|\)|\]|\}|$)/;
const DESTRUCTURED_FETCH = /\{[^}]*\bfetch\b\s*(?::\s*[A-Za-z_$][\w$]*)?[^}]*\}\s*=/;

function callsGlobalFetch(code: string, quoted: string = code): boolean {
  return (
    BARE_FETCH.test(code) ||
    GLOBAL_FETCH.test(code) ||
    INDEXED_FETCH.test(quoted) ||
    TAKEN_FETCH.test(code) ||
    DESTRUCTURED_FETCH.test(code)
  );
}

/**
 * Files allowed to call the global `fetch`, each with the reason.
 *
 * Paths are repository-relative and matched exactly. Adding an entry is
 * deliberately a decision someone writes down: "this request does not honour
 * Settings > Proxy" is a sentence, not a line of code. For a single line —
 * page-world source, a declaration — use the line hatch instead; a file-wide
 * exemption for one line is how a rule stops covering a file nobody meant to
 * exempt.
 */
const FETCH_OWNERS: Array<{ file: string; why: string }> = [
  {
    file: "main/services/proxy-service.ts",
    why: "appFetch itself — it IS the door, and the direct branch is a plain global fetch by design",
  },
];

{
  const offenders: string[] = [];
  let scanned = 0;

  for (const file of walk(join(root, "main"))) {
    const rel = file.slice(root.length + 1);
    if (isTest(file)) continue;
    if (FETCH_OWNERS.some((o) => o.file === rel)) continue;
    scanned++;
    offenders.push(...offendersIn(file, rel, callsGlobalFetch));
  }

  assert(
    scanned > 50,
    `walked ${scanned} shipped main-process files (a low number means the walk rotted)`,
  );
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? "every outbound request in the main process goes through appFetch, so Settings > Proxy reaches it"
      : `a request the proxy setting cannot see:\n     ${offenders.join(
          "\n     ",
        )}\n\n     Use appFetch from main/services/proxy-service.ts. If this line is not a\n     request the app makes — page-world source, a declaration — mark it\n     \`egress-ok: <reason>\`. If a whole FILE genuinely must bypass the proxy,\n     add it to FETCH_OWNERS in this check WITH THE REASON.`,
  );
}

{
  // The detector's own battery. Every negative is a real shape from this tree.
  const positives = [
    "  const r = await fetch(url);",
    "return fetch(url, init);",
    "const r = globalThis.fetch(url);",
    "const r = await globalThis?.fetch(url);",
    "const r = window . fetch (url);",
    'const r = globalThis["fetch"](url);',
    "  const go = fetch;",
    "  const { fetch: go } = globalThis;",
    "  const { fetch } = globalThis;",
  ];
  const negatives = [
    "  const res = await appFetch(`${base}/v1/models`, {",
    "  const models = await fetchModels(provider, base);",
    "  res = await fetchImpl(ENDPOINT, {",
    "  const response = await net.fetch(`file://${real}`);",
    "  const res = await worker.fetch(get(URL_BASE), env);",
    "  const [{ fetch: undiciFetch }, dispatcher] = await Promise.all([",
    "  fetchImpl: FetchLike,",
    "  const doFetch: FetchLike = (url, init) => appFetch(url, init);",
  ];
  assert(
    // An explicit arrow, not a bare reference: `Array.every` passes the INDEX
    // as the second argument, which would silently land in `quoted`.
    positives.every((line) => callsGlobalFetch(line)),
    "the detector still recognises the global fetch — called, optional-chained, indexed or merely taken",
  );
  assert(
    negatives.every((line) => !callsGlobalFetch(line)),
    "…and still ignores appFetch, an injected fetchImpl, a member fetch and a renamed import",
  );
}

{
  // The LIVE positive control: the whole apparatus, not just the regex. A file
  // exempt from the offender list is free to be the fixture, and `appFetch`'s
  // direct branch is a bare global fetch permanently and on purpose.
  const owner = FETCH_OWNERS[0].file;
  const { code, quoted } = scanFile(join(root, owner));
  const hits = code.filter((line, i) => callsGlobalFetch(line, quoted[i]));
  assert(
    hits.length === 1,
    `${owner} still shows exactly one bare global fetch to this scan — appFetch's direct branch (found ${hits.length})`,
  );
}

{
  // …and the reader does not blank live code on its way there. The pipeline
  // this replaced lost 48 lines of `recorder-service.ts` to the glob in
  // `urls: ["*://*/*"]`, including the block that attaches the Shopify
  // signature to an outgoing request. Measured on the file that found it.
  const { raw, code } = scanFile(join(root, "main/services/recorder-service.ts"));
  // Every line the reader emptied must BE a comment line, not merely be
  // outnumbered by them — the count comparison this replaced was satisfied by
  // blanking a hundred lines of code in a file with a hundred comments.
  const lost = raw
    .map((line, i) => ({ line, i }))
    .filter(({ line, i }) => line.trim() !== "" && (code[i] ?? "").trim() === "")
    .filter(({ line }) => !/^\s*(\/\/|\/?\*)/.test(line));
  assert(
    lost.length === 0,
    lost.length === 0
      ? "the reader empties comment lines and nothing else in recorder-service.ts, so no live code is invisible to it"
      : `the reader blanked ${lost.length} lines of live code, which this scan then cannot see — first at recorder-service.ts:${lost[0].i + 1}: ${lost[0].line.trim().slice(0, 70)}`,
  );
  assert(
    code.some((line) => line.includes("onBeforeSendHeaders")),
    "…so the request-header block, where a signature is attached, is still scanned",
  );
}

{
  // The deviation that actually happened, pinned by name. The rule above would
  // catch it too, but a check that names the bug it was written for is the one
  // someone understands when it fires.
  const mailbox = codeOf(join(root, "main/services/mailbox-service.ts"));
  assert(
    /appFetch\(messagesUrl\(/.test(mailbox),
    "the mailbox probe asks through appFetch, so Settings > Proxy reaches the app's own probe",
  );
  // The bound covering the WHOLE probe — `appFetch` awaits a proxy decision
  // first, and an `AbortSignal` reaches neither the PAC evaluation nor the
  // password decrypt — is a BEHAVIOUR, and `mailbox-service.test.ts` proves it
  // by never settling the call and watching the deadline answer. It used to be
  // pinned here as source text, and that pin went red against the very rewrite
  // that introduced the deadline: it named the line it was replacing. Source
  // gets the question source can answer — that the timeout constant is still
  // spent on the probe rather than orphaned — and the test gets the rest.
  assert(
    /PROBE_TIMEOUT_MS/.test(mailbox.slice(mailbox.indexOf("probeMailbox"))),
    "…and the probe still spends its timeout constant (the bound itself is mailbox-service.test.ts's)",
  );
}

// ── 2. undici belongs to the door ────────────────────────────────────

/**
 * A VALUE import of undici — the bypass no `fetch(` regex can see, since
 * `const { fetch } = await import("undici")` never spells the call anywhere a
 * scan would read it. undici is the only way to get such a handle in this
 * tree, so owning the import closes what the regex leaves open.
 *
 * Its own list, not `FETCH_OWNERS`. Permission to build a dispatcher and
 * permission to call the global `fetch` are two different decisions, and one
 * list would grant both to whoever needed either.
 */
const UNDICI_OWNERS: Array<{ file: string; why: string }> = [
  {
    file: "main/services/proxy-service.ts",
    why: "the dispatchers appFetch's proxied branch is built from — dynamically imported, so a check bundle without the createRequire banner never loads it",
  },
];

/** A type-only import erases at compile time and makes no request, so it is
 *  not the thing being banned. Both spellings: `import type { X }` and
 *  `import { type X }` where every specifier is type-prefixed. */
function isTypeOnlyImport(line: string): boolean {
  if (/\bimport\s+type\b/.test(line)) return true;
  const braces = /\bimport\s*\{([^}]*)\}/.exec(line);
  if (!braces) return false;
  const specifiers = braces[1].split(",").map((s) => s.trim()).filter(Boolean);
  return specifiers.length > 0 && specifiers.every((s) => /^type\s/.test(s));
}

/**
 * A raw HTTP client, which is the other half of the same hole.
 *
 * The `fetch` rule enforces a SPELLING; this one and the undici rule enforce
 * the CAPABILITY. `https.request(url, …)` never writes `fetch(` anywhere a
 * scan would read it and answers to no proxy setting — and neither does an
 * `axios` or a `node-fetch` somebody adds because it was the client they knew.
 * Nothing under shipped `main/**` imports one today, which is what makes the
 * rule free: the first one to appear is a decision rather than a discovery.
 *
 * `node:net` is deliberately absent — a raw socket is not an HTTP client, and
 * a port check is a legitimate reason to import it. Electron's `net`, which
 * `main/shell/` uses, comes through `@shell/backend` and is Chromium's stack,
 * already carrying the session proxy this same service sets.
 */
const RAW_CLIENTS =
  /["'`](?:node:)?(?:https?|axios|node-fetch|got|superagent|phin)["'`]/;

/** Only on a line that actually imports. `"https:"` in a scheme comparison
 *  carries a colon and cannot match, but requiring the import keyword is what
 *  keeps a bare `"http"` in some future table from reading as egress. */
function importsRawClient(line: string): boolean {
  return /(?:^|[^\w$])(?:import|require)\b/.test(line) && RAW_CLIENTS.test(line);
}

{
  const offenders: string[] = [];
  for (const file of walk(join(root, "main"))) {
    const rel = file.slice(root.length + 1);
    if (isTest(file)) continue;
    offenders.push(
      ...offendersIn(file, rel, (_code, quoted) =>
        importsRawClient(quoted) && !isTypeOnlyImport(quoted),
      ),
    );
  }
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? "no raw HTTP client in the main process — the only way out is appFetch"
      : `an HTTP client that answers to no proxy setting:\n     ${offenders.join(
          "\n     ",
        )}\n\n     Use appFetch. Nothing here has ever needed a raw client, so the first one\n     is a decision: say why on the line with \`egress-ok: <reason>\`, or route it\n     through proxy-service.`,
  );
  // The battery, since this rule's healthy state is zero findings and there is
  // no live positive control available — nothing in the tree imports one.
  assert(
    [
      'import * as https from "node:https";',
      "const http = require('http');",
      'import axios from "axios";',
    ].every(importsRawClient),
    "the raw-client detector still recognises an HTTP client import",
  );
  assert(
    [
      '  if (url.protocol !== "https:") return "Use https.";',
      '  const PROXY_URL_SCHEMES = ["http:", "https:", "socks5:"];',
      '  out.push(`http://${hostPort}`);',
      '  import { app, logger, net, session } from "@shell/backend";',
    ].every((line) => !importsRawClient(line)),
    "…and still ignores a scheme comparison, a scheme table and the shell's own net",
  );
}

{
  const offenders: string[] = [];
  for (const file of walk(join(root, "main"))) {
    const rel = file.slice(root.length + 1);
    if (isTest(file)) continue;
    if (UNDICI_OWNERS.some((o) => o.file === rel)) continue;
    offenders.push(
      ...offendersIn(file, rel, (_code, quoted) =>
        /["'`]undici["'`]/.test(quoted) && !isTypeOnlyImport(quoted),
      ),
    );
  }
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? "only the proxy owner reaches for undici, so a dispatcher cannot be built around appFetch"
      : `undici belongs to proxy-service.ts — a fetch built here answers to no proxy setting:\n     ${offenders.join(
          "\n     ",
        )}\n\n     A type-only import is fine and is not flagged. If this file genuinely\n     needs undici's runtime, add it to UNDICI_OWNERS in this check WITH THE\n     REASON — that is a separate decision from FETCH_OWNERS, on purpose.`,
  );
}

{
  // …and the seam is actually carrying traffic rather than merely present. Zero
  // call sites would mean the app stopped making requests, or that they moved
  // somewhere this check does not walk; either is worth a red row.
  let callers = 0;
  for (const file of walk(join(root, "main"))) {
    if (isTest(file)) continue;
    callers += (codeOf(file).match(/\bappFetch\(/g) ?? []).length;
  }
  assert(
    callers > 5,
    `saw ${callers} appFetch() call sites in shipped main-process code (a low number means the seam moved)`,
  );
}

// ── 3. Outgoing text is redacted over every store, not one ───────────

/**
 * A read of ONE credential store where the redaction set is the question.
 *
 * Two of the three are here. `testSecretsStore.allValues()` is the call the
 * straggler made, and `shopifySignatureStore.headerValuesForRedaction()` exists
 * for no other purpose than this one — outside the composition, either is a
 * redaction that sees a third of what it should.
 *
 * `mailboxStore.credentials()` is deliberately NOT on the list: the probe and
 * the runner both read it to USE the credential, which is not this rule's
 * subject. And this rule bans known narrow reads rather than proving every
 * `redact(` call's argument, because `recorder-service.ts` passes a per-test
 * value set on purpose (`maskValues`, with the trainer's own `MASKED` marker) —
 * a blanket rule would report the one deliberately narrow redaction in the
 * tree.
 */
const NARROW_READS: RegExp[] = [
  /testSecretsStore\s*\.\s*allValues\s*\(/,
  /shopifySignatureStore\s*\.\s*headerValuesForRedaction\s*\(/,
];

function readsOneStore(line: string): boolean {
  return NARROW_READS.some((re) => re.test(line));
}

/**
 * Files allowed to read one store, each with the reason.
 *
 * The value set is one question with one answer, and `allRedactableValues()` is
 * it. Reading a single store is right only where the composition is built.
 */
const SINGLE_STORE_OWNERS: Array<{ file: string; why: string }> = [
  {
    file: "main/services/secret-redaction.ts",
    why: "allRedactableValues composes the three stores here — this is the one place that reads them one at a time",
  },
];

{
  const offenders: string[] = [];
  for (const file of walk(join(root, "main"))) {
    const rel = file.slice(root.length + 1);
    if (isTest(file)) continue;
    if (SINGLE_STORE_OWNERS.some((o) => o.file === rel)) continue;
    offenders.push(...offendersIn(file, rel, (code) => readsOneStore(code)));
  }
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? "nothing redacts over one credential store alone — the value set is allRedactableValues()"
      : `a redaction that sees one store out of three:\n     ${offenders.join(
          "\n     ",
        )}\n\n     Use allRedactableValues() from main/services/secret-redaction.ts. Widening\n     the set is worthless if a send path still asks a narrower question.`,
  );
}

{
  // The same two proofs rule 1 carries, for the same reason: this rule's
  // healthy state is zero findings, and a method renamed during an unrelated
  // refactor would turn it green and silent forever.
  const positives = [
    "    const secrets = await testSecretsStore.allValues();",
    "  const s = await testSecretsStore . allValues ( );",
    "      shopifySignatureStore.headerValuesForRedaction(),",
  ];
  const negatives = [
    "  const secrets = await allRedactableValues();",
    "    const secrets = await redactionValues();",
    "  const credentials = await mailboxStore.credentials();",
    "  async headerValuesForRedaction(): Promise<string[]> {",
  ];
  assert(
    positives.every((line) => readsOneStore(line)),
    "the narrow-read detector still recognises a one-store read, however it is spaced",
  );
  assert(
    negatives.every((line) => !readsOneStore(line)),
    "…and still ignores the composed set, the definition, and a credential read that is not a redaction",
  );

  // The live control, through the whole apparatus. The owner is exempt from
  // the scan above, which is what frees it to be the fixture: composing the
  // set is exactly what reading the stores one at a time looks like.
  const owner = SINGLE_STORE_OWNERS[0].file;
  const hits = scanFile(join(root, owner)).code.filter(readsOneStore);
  assert(
    hits.length === 2,
    `${owner} still shows two one-store reads to this scan — the composition itself (found ${hits.length})`,
  );
}

{
  // The straggler, pinned by name — and by the shape that let it hide: both
  // sites redacted, so nothing looked wrong; the defect was which list they
  // handed to `redact`.
  const service = codeOf(join(root, "main/services/issue-tracker/issue-tracker-service.ts"));
  // The CALL, not the binding it lands in. Pinning `const secrets = await …`
  // makes a pure rename of a local variable report "the redaction is missing",
  // which is a check that punishes a refactor for a property it still has —
  // and the same shape had already gone red once, against a rewrite that made
  // the probe strictly MORE bounded than the line it was pinned to.
  const sites = service.match(/await\s+redactionValues\(\)/g) ?? [];
  assert(
    sites.length === 2,
    `both issue send paths take their list from redactionValues() (found ${sites.length} of 2 — createIssue and commentRecurrence)`,
  );
  // …and that ONE function is where the store set and the failure posture are
  // decided. Two call sites reaching for the set separately is how they came
  // to disagree with `sendAlert` in the first place.
  assert(
    (service.match(/allRedactableValues\(\)/g) ?? []).length === 1,
    "…and it reads allRedactableValues() exactly once, so there is one place the set is chosen",
  );
  // And what is redacted, by the field rather than by the argument's name: the
  // title and the body are what `issues:createIssue` takes from the renderer,
  // so they are the two the last gate exists for.
  for (const field of ["title", "body"]) {
    assert(
      new RegExp(`redact\\(\\s*draft\\.${field}`).test(service),
      `…and draft.${field} still goes through redact() on its way out`,
    );
  }
  assert(
    (service.match(/redact\(/g) ?? []).length >= 3,
    "…with the recurrence comment redacted too, so all three send paths are covered",
  );
}

{
  // What `allRedactableValues` is FOR. The straggler was invisible precisely
  // because widening this function is silent at every call site that does not
  // use it; a store quietly dropped from here would be silent at every call
  // site that does.
  const source = codeOf(join(root, "main/services/secret-redaction.ts"));
  const body = source.slice(source.indexOf("export async function allRedactableValues"));
  for (const store of ["testSecretsStore", "shopifySignatureStore", "mailboxStore"]) {
    assert(
      body.includes(store),
      `allRedactableValues still reads ${store} — three stores, three ways a credential reaches run output`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} main-egress check(s) failed.`);
  process.exit(1);
}
console.log("\nAll main-egress checks passed.");
