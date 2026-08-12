// The emitters. REDESIGN §6.5 / §7.3 (MCP Phase 5).
//
// EMIT, NOT SEND. Every function here returns a STRING. Nothing opens a socket,
// stores a credential, or knows a hostname — the app writes the string to a file
// the user chose, the MCP hands it to whatever asked. That is the whole shape of
// the feature and it is the answer to REDESIGN §10's open question 3: yes,
// emit-only, and this module is where that is enforced rather than promised,
// because a pure string function has nowhere to send anything to.
//
// It also settles what the mockup drew. §6.5's design shows an Export panel with
// PDF and "public link" chips and a list of delivery CHANNELS with toggles. None
// of those exist: a public link is an outbound path with no server behind it,
// PDF needs a renderer this app does not carry, and channel toggles promise a
// Slack integration that was never built. §7.3 already says to rewrite that copy
// "before it ships, or it promises a Slack integration that does not exist" —
// so the panel lists EMITTERS, and the list of "where it goes" is a list of what
// was last written to disk.
//
// SHARED, because the app and the standalone MCP both emit and a second copy is
// right the day it is written and silently divergent afterwards. Which is why it
// is `.mjs` with a hand-written `.d.mts`: the app is bundled TypeScript, the MCP
// is plain ESM with no build step, and they cannot share a `.ts`.
//
// PURE: no fs, no process, no shell import. Redaction is passed IN as a function
// — `redactWithSnapshot` reads an encrypted store and lives on the app side, and
// dragging it here would make this module impure and untestable in one move.

/**
 * XML text escaping.
 *
 * ALL FIVE, INCLUDING THE QUOTES. A test name is user text and routinely
 * contains an apostrophe; a JUnit consumer that parses attributes with a quoted
 * value gets a truncated name or a parse error from one unescaped character.
 * Ampersand first, or it re-escapes the escapes.
 */
function xmlEscape(text) {
  return String(text)
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&apos;");
}

/**
 * Strip characters XML 1.0 cannot represent AT ALL.
 *
 * Escaping does not help here: control bytes below 0x20 are simply not legal in
 * XML 1.0, escaped or not, and Playwright output carries them — terminal
 * cursor moves survive `strip-ansi`'s escape-sequence removal as bare bytes.
 * A single one makes the whole file unparseable, which turns "the report is
 * wrong" into "CI cannot read the report", a much worse failure.
 */
function xmlSafe(text) {
  let out = "";
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code === 0x9 || code === 0xa || code === 0xd) {
      out += ch;
    } else if (code >= 0x20 && code !== 0xfffe && code !== 0xffff) {
      out += ch;
    }
    // Everything else is dropped rather than replaced: a placeholder would
    // claim something was there, and nothing here knows what.
  }
  return out;
}

/** No-op redaction, so a caller that genuinely has no secrets does not have to
 *  invent one. Named rather than inline so `check:emit-redaction` can prove
 *  every emitter routes through the parameter. */
export const NO_REDACTION = (text) => text;

/**
 * JUnit XML — one `<testsuite>`, one `<testcase>` per run.
 *
 * The format every CI reads, and the one with the least room for
 * interpretation. `time` is SECONDS, which is the single most commonly
 * mis-emitted field in this format: emitting milliseconds makes every job look
 * a thousand times slower and no consumer will tell you.
 *
 * A failed run's log is NOT inlined. It can be megabytes, JUnit consumers
 * truncate at wildly different lengths, and the useful part — which step failed
 * — is in the message. The file name is given so a human can go and read it.
 */
export function junitXml(runs, { suiteName = "Good Looks", redact = NO_REDACTION } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const failures = list.filter((r) => r.status === "failed").length;
  const totalMs = list.reduce((n, r) => n + (r.durationMs ?? 0), 0);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${xmlEscape(suiteName)}" tests="${list.length}" failures="${failures}" errors="0" skipped="0" time="${msToSeconds(totalMs)}">`,
  ];
  for (const run of list) {
    const name = xmlEscape(xmlSafe(redact(run.testName ?? run.testId ?? "unnamed")));
    // `classname` is what most CIs group by. The test id rather than the name:
    // grouping has to survive a rename, and a name is the one field a user
    // edits freely.
    const cls = xmlEscape(xmlSafe(run.testId ?? "test"));
    const time = msToSeconds(run.durationMs ?? 0);
    if (run.status === "failed") {
      const message = xmlEscape(
        xmlSafe(redact(`exit ${run.exitCode ?? 1} · log ${run.logFile ?? "(none)"}`)),
      );
      lines.push(`  <testcase classname="${cls}" name="${name}" time="${time}">`);
      lines.push(`    <failure message="${message}" type="failure"/>`);
      lines.push("  </testcase>");
    } else {
      lines.push(`  <testcase classname="${cls}" name="${name}" time="${time}"/>`);
    }
  }
  lines.push("</testsuite>");
  return lines.join("\n") + "\n";
}

/** Milliseconds → the seconds JUnit wants, to 3dp. */
function msToSeconds(ms) {
  return (Math.max(0, ms ?? 0) / 1000).toFixed(3);
}

/**
 * GitHub Actions workflow commands — one `::error` line per failed run.
 *
 * ONLY FAILURES. An annotation per passing test buries the failures under a
 * hundred notices, which is the opposite of what an annotation is for.
 *
 * Newlines are encoded as `%0A` and `%`/`\r` alongside them, because a raw
 * newline ENDS the workflow command: the rest of the message would be printed
 * as ordinary log output and the annotation would carry only its first line.
 */
export function githubAnnotations(runs, { redact = NO_REDACTION } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const out = [];
  for (const run of list) {
    if (run.status !== "failed") continue;
    const title = ghEscape(redact(run.testName ?? run.testId ?? "unnamed"));
    const body = ghEscape(
      redact(`exit ${run.exitCode ?? 1} after ${run.durationMs ?? 0}ms · log ${run.logFile ?? "(none)"}`),
    );
    out.push(`::error title=${title}::${body}`);
  }
  return out.length > 0 ? out.join("\n") + "\n" : "";
}

/** Percent-encode the three characters a workflow command cannot carry. The
 *  percent MUST go first or it re-encodes the encodings. */
function ghEscape(text) {
  return String(text)
    .split("%")
    .join("%25")
    .split("\r")
    .join("%0D")
    .split("\n")
    .join("%0A");
}

/**
 * A ticket body, in markdown.
 *
 * For pasting into whatever tracker the user has, which is why it is markdown
 * and not a tracker's JSON: every tracker accepts markdown and none accept each
 * other's payloads. The app already files Linear issues through its own
 * integration; this is the path for everyone who does not have one.
 */
export function ticketMarkdown(runs, { title = "Test run report", redact = NO_REDACTION } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const failed = list.filter((r) => r.status === "failed");
  const lines = [`# ${redact(title)}`, ""];
  lines.push(
    failed.length === 0
      ? `All ${list.length} run${list.length === 1 ? "" : "s"} passed.`
      : `**${failed.length} of ${list.length} failed.**`,
  );
  if (failed.length > 0) {
    lines.push("", "| Test | Browser | Duration | Exit |", "| --- | --- | --- | --- |");
    for (const run of failed) {
      // Pipes are escaped because a test name containing one silently adds a
      // column and shifts every cell after it — a table that renders, wrongly.
      const name = mdCell(redact(run.testName ?? run.testId ?? "unnamed"));
      lines.push(
        `| ${name} | ${mdCell(run.runBrowser ?? "chromium")} | ${run.durationMs ?? 0}ms | ${run.exitCode ?? 1} |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

function mdCell(text) {
  return String(text).split("|").join("\\|").split("\n").join(" ");
}

/**
 * NDJSON of step metrics — one JSON object per line.
 *
 * UNAGGREGATED, and that is the point AND the risk. Every other emitter here
 * reports outcomes; this one hands over the raw per-step rows, which is what
 * makes it useful to load somewhere else and what makes it the emitter with the
 * most in it. The Export panel says so per-emitter rather than once at the top,
 * because a warning about "exports" in general is one nobody reads as being
 * about the row they are looking at.
 *
 * NDJSON rather than a JSON array: the rows are appended by a database and read
 * by tools that stream, and an array requires the whole file in memory at both
 * ends to say the same thing.
 */
export function stepMetricsNdjson(rows, { redact = NO_REDACTION } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  // The redaction runs over the SERIALIZED line rather than per field. A secret
  // can land in any string column — a step label, an error, a URL — and a
  // field-by-field pass has to know which, which is a list that goes stale the
  // first time a column is added.
  return list.map((row) => redact(JSON.stringify(row))).join("\n") + (list.length > 0 ? "\n" : "");
}

/**
 * CSV of the same rows.
 *
 * Offered beside NDJSON because the two have different readers — a spreadsheet
 * cannot open NDJSON and a stream processor should not have to parse CSV.
 * Columns come from the FIRST row, and every row is written against that header
 * rather than its own keys: rows with differing shapes would otherwise produce a
 * file whose columns mean different things on different lines, which opens
 * cleanly in a spreadsheet and is wrong.
 */
export function stepMetricsCsv(rows, { redact = NO_REDACTION } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return "";
  const columns = Object.keys(list[0]);
  const lines = [columns.map(csvCell).join(",")];
  for (const row of list) {
    lines.push(columns.map((c) => csvCell(redact(stringifyCell(row[c])))).join(","));
  }
  return lines.join("\n") + "\n";
}

function stringifyCell(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * One CSV cell.
 *
 * ALWAYS QUOTED, rather than quoted-when-needed. The conditional version has to
 * decide what "needed" means and gets it wrong on a leading space, a lone CR, or
 * a value that looks like a formula; quoting everything costs two bytes a cell
 * and has no edge cases. Inner quotes are doubled, which is the CSV escape.
 */
function csvCell(value) {
  return `"${stringifyCell(value).split('"').join('""')}"`;
}

/**
 * OTLP JSON — the runs as spans.
 *
 * The shape an OpenTelemetry collector accepts over its HTTP JSON receiver, so
 * a suite's timings can go where the rest of a team's traces already are.
 *
 * TIMES ARE NANOSECONDS AS STRINGS. OTLP specifies uint64 nanos, and 2026 in
 * nanoseconds is ~1.8e18 — past `Number.MAX_SAFE_INTEGER`, so computing them as
 * a JS number silently loses the low digits and every span drifts. Building the
 * string by concatenation is the fix and the reason this is not a one-liner.
 *
 * IT CARRIES THE MOST OF ANY EMITTER HERE, which is why the panel gives it its
 * own risk note: a span's attributes include the URL under test, and a URL is
 * where query-string credentials live.
 */
export function otlpTrace(runs, { serviceName = "good-looks", redact = NO_REDACTION } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const spans = list.map((run) => ({
    traceId: hex32(run.id ?? ""),
    spanId: hex16(run.id ?? ""),
    name: redact(run.testName ?? run.testId ?? "run"),
    kind: 1,
    startTimeUnixNano: msToNanoString(run.startedAt ?? 0),
    endTimeUnixNano: msToNanoString(run.finishedAt ?? run.startedAt ?? 0),
    status: { code: run.status === "failed" ? 2 : 1 },
    attributes: [
      strAttr("gl.test.id", run.testId ?? ""),
      strAttr("gl.run.url", redact(run.url ?? "")),
      strAttr("gl.run.browser", run.runBrowser ?? "chromium"),
      intAttr("gl.run.exit_code", run.exitCode ?? 0),
    ],
  }));
  return (
    JSON.stringify(
      {
        resourceSpans: [
          {
            resource: { attributes: [strAttr("service.name", serviceName)] },
            scopeSpans: [{ scope: { name: "good-looks" }, spans }],
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

/** Epoch ms → epoch NANOSECONDS, as a decimal string. Concatenated rather than
 *  multiplied — see `otlpTrace`. */
function msToNanoString(ms) {
  const whole = Math.max(0, Math.floor(ms ?? 0));
  return `${whole}000000`;
}

function strAttr(key, value) {
  return { key, value: { stringValue: String(value) } };
}

function intAttr(key, value) {
  return { key, value: { intValue: Math.trunc(value ?? 0) } };
}

/** A stable hex id of `width` characters, derived from a run id.
 *
 *  OTLP wants fixed-width hex; run ids are UUIDs and arbitrary strings. A hash
 *  rather than a random value, so re-emitting the same runs produces the same
 *  trace instead of a new one every time — a report you can diff. */
function hexOfWidth(seed, width) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const text = String(seed);
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + text.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  let out = "";
  let a = h1;
  let b = h2;
  while (out.length < width) {
    out += a.toString(16).padStart(8, "0");
    const next = (Math.imul(a ^ b, 0x27d4eb2f) >>> 0) || 1;
    a = b;
    b = next;
  }
  return out.slice(0, width);
}

function hex32(seed) {
  return hexOfWidth(seed, 32);
}

function hex16(seed) {
  return hexOfWidth(seed, 16);
}

/**
 * The emitters, as data.
 *
 * The panel renders this rather than a hand-written list, so an emitter cannot
 * be added to the module and forgotten in the UI — the failure mode of every
 * "list of formats" that exists in two places.
 *
 * `risk` is null for the three that report outcomes and set for the two that
 * carry more: §7.3 names them explicitly, and stating it per-emitter rather than
 * once at the top is deliberate — a general warning about "exports" is not read
 * as being about the row under the cursor.
 */
export const EMITTERS = [
  {
    id: "junit",
    label: "JUnit XML",
    extension: "xml",
    summary: "One testcase per run. What CI reads.",
    risk: null,
  },
  {
    id: "github",
    label: "GitHub annotations",
    extension: "txt",
    summary: "An ::error line per failed run, for a workflow log.",
    risk: null,
  },
  {
    id: "ticket",
    label: "Ticket (markdown)",
    extension: "md",
    summary: "A body to paste into a tracker.",
    risk: null,
  },
  {
    id: "otlp",
    label: "OTLP trace (JSON)",
    extension: "json",
    summary: "Runs as spans, for an OpenTelemetry collector.",
    risk: "Span attributes include the URL under test — check it for credentials in the query string.",
  },
  {
    id: "ndjson",
    label: "Step metrics (NDJSON)",
    extension: "ndjson",
    summary: "Raw per-step rows, one JSON object per line.",
    risk: "Unaggregated: every step of every run, including labels and errors.",
  },
  {
    id: "csv",
    label: "Step metrics (CSV)",
    extension: "csv",
    summary: "The same rows, for a spreadsheet.",
    risk: "Unaggregated: every step of every run, including labels and errors.",
  },
];

/** A filename for an emitter's output. Date is passed in rather than read —
 *  this module is pure, and a filename that changes under a test is a test that
 *  cannot assert one. */
export function emitFileName(emitterId, stamp) {
  const meta = EMITTERS.find((e) => e.id === emitterId);
  const ext = meta ? meta.extension : "txt";
  return `good-looks-${emitterId}-${stamp}.${ext}`;
}
