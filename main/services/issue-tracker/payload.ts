// What an issue SAYS. Pure, and the single place the outgoing shape is decided.
//
// Pure for the same reason `buildAlertPayload` is: it makes the guarantee
// checkable. `check:issue-payload` calls these functions with deliberately
// hostile inputs — a run log stuffed into a step label, a page's HTML in an axe
// message, headers in a network entry — and asserts against the returned object
// that none of it came through. A builder that reached for a store instead of
// taking data would leave that check able to prove nothing.
//
// WHAT THE CHECK PROTECTS, precisely, because it is narrower than "no logs":
//
//   • The raw Playwright `.log` NEVER appears. Its only redaction is for
//     declared secret variables, while it carries DOM snippets around a failing
//     locator, assertion expected-vs-actual, and unscrubbed page URLs. What
//     goes instead is `errorSignature()` — first line only, paths, timings,
//     ids and numbers normalised out, 200 chars.
//   • Console entries are allowed for a FAILURE only, filtered to errors and
//     page errors, count-capped and truncated. That is where a diagnosis lives;
//     the rest is page chatter.
//   • Network entries are allowed for a FAILURE only, and ONLY from a run whose
//     headers were filtered. A run recorded with `GLAZE_RECORD_ALL_HEADERS=1`
//     holds real Authorization and Cookie values — and is exactly the run
//     someone debugging an auth failure would have produced.
//   • Header VALUES never appear at all, filtered or not. A header's presence
//     is diagnostic; its value is the credential.
//
// Everything user-visible is bounded here, not trusted: an axe `help` string is
// remote page content, and a step label can carry a value typed during
// recording. Redaction of declared secrets happens on top of this, at the send.

import { buildDeepLink, buildSiteHealthDeepLink } from "../../../shared/deep-link.mjs";
import { errorSignature } from "../../../shared/error-signature.mjs";
import type { DefectSource, IssueDraft } from "../../../renderer/lib/issue-types.js";

/** One line of prose from a remote source. Long enough to be useful, short
 *  enough that no single field can dominate an issue. */
const MAX_TEXT = 300;
/** A selector list is evidence; a hundred of them is a page dump. */
const MAX_TARGETS = 5;
/** Console errors worth reading before someone opens the app anyway. */
const MAX_OCCURRENCES = 25;

const MAX_CONSOLE = 10;
/** Requests around a failure. Past this it stops being a clue. */
const MAX_NETWORK = 10;

/**
 * Collapse to one line, neutralise backticks, and bound.
 *
 * Newlines matter: a multi-line value in a bullet or a table breaks the
 * structure around it. Backticks matter for two separate reasons, and doing it
 * HERE rather than only in `code()` is what covers both — the second one was
 * missed when it lived there:
 *
 *   • Inside a code span, a backtick closes it early and everything after
 *     renders as markdown — including a link.
 *   • Inside a fenced block, ``` ends the fence. `failureBody` fences the error
 *     signature, and an error message is remote text that can contain anything.
 *
 * Titles go through this too. A title is plain text in both Linear and GitHub
 * so nothing renders there, but a value that is safe in one place and not
 * another is a distinction nobody maintains.
 */
export function line(v: unknown, max = MAX_TEXT): string {
  if (typeof v !== "string") return "";
  const flat = v.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Wrap a value in a code span. Safe because `line` has already removed the one
 *  character that could close it. */
function code(v: unknown): string {
  const text = line(v);
  return text ? `\`${text}\`` : "";
}

function pct(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return "0%";
  const p = fraction * 100;
  return p < 0.1 ? "<0.1%" : `${p.toFixed(p < 10 ? 2 : 1)}%`;
}

// ── Inputs ───────────────────────────────────────────────────────────────────
//
// Deliberately plain data. The loader reads these off disk; this file never
// touches a store, so the check can construct them by hand.

export interface DraftContext {
  testName: string;
  /** The test's start URL. A page URL from the run is NOT used — it can carry a
   *  session token in its query, and the start URL is what identifies the test. */
  testUrl: string;
  stepLabel: string | null;
  browser?: string;
}

/** One place a rule fires, for a rule-scoped draft. Strings are untrusted like
 *  everything else here — they pass through `line`/`code` on the way out. */
export interface A11yOccurrence {
  testName: string;
  stepLabel: string | null;
  /** offending elements at this site */
  nodes: number;
}

export interface A11yDefect {
  kind: "a11y";
  ruleId: string;
  impact: string;
  help: string;
  targets: string[];
  /** Present on a rule-scoped draft (the Accessibility view's batch send):
   *  every current occurrence of the rule across the suite, the anchor
   *  included. Absent on the ordinary per-step send. */
  occurrences?: A11yOccurrence[];
}

export interface VisualDefect {
  kind: "visual";
  changedFraction: number;
  maskedCount: number;
  threshold: number | null;
}

/** A console line, already narrowed by the loader to errors and page errors. */
export interface FailureConsoleLine {
  type: string;
  text: string;
}

/** A request around the failure. Headers are absent by construction — the type
 *  has nowhere to put them, which is a stronger guarantee than remembering to
 *  strip them. */
export interface FailureRequest {
  method: string;
  url: string;
  status: number;
}

export interface FailureDefect {
  kind: "failure";
  /** Already reduced by `errorSignature` upstream, or raw — reduced again here
   *  regardless, because the one that matters is the one nearest the output. */
  rawError: string;
  healOutcome: "exhausted" | "no-candidates" | null;
  healLocator: string | null;
  console: FailureConsoleLine[];
  network: FailureRequest[];
  /** False when the run recorded ALL headers. Network entries are then dropped
   *  and a notice explains why. */
  headersFiltered: boolean;
}

/** One page of a Site Health draft: its path and its score in the category
 *  being filed. NO TITLE, by shape — a page title is page-authored text and
 *  the path already identifies the page. */
export interface SiteHealthPage {
  path: string;
  score: number | null;
}

export interface SiteHealthDefect {
  kind: "site-health";
  host: string;
  category: "seo" | "performance";
  /** the current score and the prior period's, both already rounded */
  score: number | null;
  prev: number | null;
  runs: number;
  /** ms, the window the score was read over; 0 since = all time */
  since: number;
  until: number;
  pages: SiteHealthPage[];
  /** SEO: failing audits with how many pages they cover. */
  findings: { label: string; pages: number; of: number }[];
  /** Performance: the vitals, formatted, against their targets. */
  vitals: { label: string; value: string; target: string; over: boolean }[];
}

export type Defect = A11yDefect | VisualDefect | FailureDefect | SiteHealthDefect;

export interface BuildInput {
  /** Defect coordinates only — an insight-report source never reaches this
   *  builder (the loader assembles that draft from the stored report itself),
   *  and the type is what keeps the deep-link block below honest about it. */
  source: Exclude<DefectSource, { kind: "insight-report" }>;
  context: DraftContext;
  defect: Defect;
}

// ── Titles ───────────────────────────────────────────────────────────────────

export function buildTitle(input: BuildInput): string {
  const { context, defect } = input;
  const test = line(context.testName, 80) || "Untitled test";
  const step = line(context.stepLabel, 60);
  if (defect.kind === "a11y") {
    // A rule-scoped draft is about the RULE, not the anchor test — titling it
    // "on Checkout" would read as one test's problem when the body lists five.
    if (defect.occurrences && defect.occurrences.length > 0) {
      const tests = new Set(defect.occurrences.map((o) => line(o.testName, 80))).size;
      return line(
        `a11y: ${line(defect.ruleId, 60) || "violation"} across ${tests} test${tests === 1 ? "" : "s"}`,
        200,
      );
    }
    return line(`a11y: ${line(defect.ruleId, 60) || "violation"} on ${test}`, 200);
  }
  if (defect.kind === "visual") {
    return line(`Visual change (${pct(defect.changedFraction)}) — ${test}${step ? ` · ${step}` : ""}`, 200);
  }
  if (defect.kind === "site-health") {
    // "Performance: store.example.com scores 54/100, −4 vs prior" — the
    // category, the domain, the number and the change. No status word: a 54
    // is a 54, and what the title adds is which way it moved.
    const cat = defect.category === "seo" ? "SEO" : "Performance";
    const score = defect.score === null ? "has no score" : `scores ${defect.score}/100`;
    return line(`${cat}: ${line(defect.host, 253)} ${score}, ${siteHealthDelta(defect)}`, 200);
  }
  // A signature is far more useful in a title than "Test failed": it is what
  // makes two issues about the same failure recognisably the same.
  const sig = line(errorSignature(defect.rawError), 90);
  return line(`${test} failed${step ? ` at ${step}` : ""}${sig ? ` — ${sig}` : ""}`, 200);
}

// ── Body ─────────────────────────────────────────────────────────────────────

function contextBlock(context: DraftContext): string[] {
  const rows = [
    `- **Test:** ${line(context.testName, 120) || "—"}`,
    `- **URL:** ${code(context.testUrl) || "—"}`,
  ];
  if (context.stepLabel) rows.push(`- **Step:** ${code(context.stepLabel)}`);
  if (context.browser) rows.push(`- **Browser:** ${line(context.browser, 40)}`);
  return rows;
}

function a11yBody(d: A11yDefect): string[] {
  const out = [
    `**${line(d.impact, 20) || "unknown"}** · ${code(d.ruleId)}`,
    "",
    line(d.help) || "No description was provided for this rule.",
  ];
  const targets = d.targets.filter((t) => typeof t === "string" && t.trim()).slice(0, MAX_TARGETS);
  if (targets.length) {
    out.push("", "**Elements**", "");
    for (const t of targets) out.push(`- ${code(t)}`);
    if (d.targets.length > targets.length) {
      out.push(`- …and ${d.targets.length - targets.length} more`);
    }
  }
  // The rule-scoped section: where the rule fires, one line per site, so the
  // issue is the checklist a fix can be worked through. Capped like every list
  // that leaves this file — an unbounded suite must not build an unbounded
  // issue body.
  if (d.occurrences && d.occurrences.length > 0) {
    const shown = d.occurrences.slice(0, MAX_OCCURRENCES);
    out.push("", "**Where it occurs**", "");
    for (const o of shown) {
      const test = line(o.testName, 80) || "Untitled test";
      const step = line(o.stepLabel, 60);
      const nodes = Number.isFinite(o.nodes) && o.nodes > 0 ? o.nodes : 0;
      out.push(
        `- ${test}${step ? ` · ${code(step)}` : ""}${
          nodes ? ` — ${nodes} element${nodes === 1 ? "" : "s"}` : ""
        }`,
      );
    }
    if (d.occurrences.length > shown.length) {
      out.push(`- …and ${d.occurrences.length - shown.length} more`);
    }
  }
  return out;
}

/** "−4 vs prior" / "+3 vs prior" / "no change vs prior" / "no prior period". */
function siteHealthDelta(d: SiteHealthDefect): string {
  if (d.score === null || d.prev === null) return "no prior period";
  const delta = d.score - d.prev;
  if (delta === 0) return "no change vs prior";
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta)} vs prior`;
}

const MAX_PAGES = 25;
const MAX_FINDINGS = 25;

function siteHealthBody(d: SiteHealthDefect): string[] {
  const cat = d.category === "seo" ? "SEO" : "Performance";
  const days = d.since > 0 ? Math.max(1, Math.round((d.until - d.since) / 86_400_000)) : null;
  const out = [
    `**${cat} score ${d.score === null ? "—" : `${d.score}/100`}** for ${code(d.host)} · ${siteHealthDelta(d)}`,
    "",
    days === null
      ? `Mean of the latest reading of each page, over every run this library has (${d.runs} run${d.runs === 1 ? "" : "s"}).`
      : `Mean of the latest reading of each page over the last ${days} day${days === 1 ? "" : "s"} (${d.runs} run${d.runs === 1 ? "" : "s"}), against the ${days} days before.`,
  ];
  if (d.category === "seo") {
    const findings = d.findings.slice(0, MAX_FINDINGS);
    if (findings.length) {
      out.push("", "**Failing audits**", "");
      for (const f of findings) {
        out.push(`- ${line(f.label, 80)} — ${Number(f.pages) || 0} of ${Number(f.of) || 0} page${f.of === 1 ? "" : "s"}`);
      }
      if (d.findings.length > findings.length) out.push(`- …and ${d.findings.length - findings.length} more`);
    } else {
      out.push("", "Every weighted audit passes on every page read in this window.");
    }
  } else {
    if (d.vitals.length) {
      out.push("", "**Web vitals · 75th percentile**", "");
      for (const v of d.vitals.slice(0, 10)) {
        out.push(`- ${line(v.label, 20)}: ${line(v.value, 20)} (target ${line(v.target, 20)})${v.over ? " — over the target" : ""}`);
      }
    }
  }
  const pages = d.pages.slice(0, MAX_PAGES);
  if (pages.length) {
    out.push("", "**Pages · latest reading of each**", "");
    for (const p of pages) {
      out.push(`- ${code(p.path)} — ${p.score === null ? "—" : `${p.score}/100`}`);
    }
    if (d.pages.length > pages.length) out.push(`- …and ${d.pages.length - pages.length} more`);
  }
  return out;
}

function visualBody(d: VisualDefect): string[] {
  const out = [`**${pct(d.changedFraction)} of pixels changed** on this step's screenshot.`];
  if (d.threshold !== null) {
    out.push("", `Threshold for this test is ${pct(d.threshold)}.`);
  }
  if (d.maskedCount > 0) {
    // Worth stating: a reader who does not know regions were excluded may go
    // looking for a difference that was deliberately ignored.
    out.push(
      "",
      `${d.maskedCount} region${d.maskedCount === 1 ? " was" : "s were"} masked and excluded from the comparison.`,
    );
  }
  return out;
}

function failureBody(d: FailureDefect): string[] {
  const out: string[] = [];
  const sig = line(errorSignature(d.rawError), 200);
  out.push("**Failure**", "", sig ? `\`\`\`\n${sig}\n\`\`\`` : "_No error text was recorded._");

  if (d.healOutcome) {
    out.push(
      "",
      d.healOutcome === "no-candidates"
        ? "Auto-Heal found nothing on the page resembling this element — it looks **gone**, not renamed."
        : "Auto-Heal ranked candidates and every one of them failed — the element looks **gone**, not renamed.",
    );
    if (d.healLocator) out.push("", `Original locator: ${code(d.healLocator)}`);
  }

  const consoleLines = d.console.slice(0, MAX_CONSOLE);
  if (consoleLines.length) {
    out.push("", "**Console at this step**", "");
    for (const c of consoleLines) {
      out.push(`- \`${line(c.type, 20) || "log"}\` ${line(c.text, 200)}`);
    }
    if (d.console.length > consoleLines.length) {
      out.push(`- …and ${d.console.length - consoleLines.length} more`);
    }
  }

  if (!d.headersFiltered) {
    // Not a silent omission. The reader is told the requests exist and why they
    // are not here, so a missing section never reads as "nothing happened".
    out.push(
      "",
      "_Network requests are withheld: this run was recorded with full request headers, which include credentials._",
    );
  } else {
    const requests = d.network.slice(0, MAX_NETWORK);
    if (requests.length) {
      out.push("", "**Requests at this step**", "");
      for (const r of requests) {
        out.push(`- \`${line(r.method, 10) || "GET"}\` ${line(r.url, 160)} → ${Number(r.status) || 0}`);
      }
      if (d.network.length > requests.length) {
        out.push(`- …and ${d.network.length - requests.length} more`);
      }
    }
  }
  return out;
}

/**
 * The whole draft.
 *
 * `attachments` and `notices` are filled by the loader — the first needs file
 * sizes off disk and the second needs to know what the loader chose to withhold,
 * neither of which a pure function can know. They are declared here so the
 * shape has one definition.
 */
export function buildIssueDraft(input: BuildInput): IssueDraft {
  const { source, context, defect } = input;
  const parts: string[] = [];

  parts.push(
    ...(defect.kind === "a11y"
      ? a11yBody(defect)
      : defect.kind === "visual"
        ? visualBody(defect)
        : defect.kind === "site-health"
          ? siteHealthBody(defect)
          : failureBody(defect)),
  );

  parts.push("", "---", "", ...contextBlock(context));

  // The way back. Built by the same module that parses it, so the two cannot
  // drift into producing links that look right and open nothing. Carries only
  // ids — no content — and opening it selects a view and does nothing else.
  // A Site Health link goes to the DOMAIN's screen, not to the anchor run.
  const link =
    source.kind === "site-health"
      ? buildSiteHealthDeepLink({ host: source.host, category: source.category })
      : buildDeepLink({
          testId: source.testId,
          runId: source.runId,
          stepId: source.stepId,
        });
  parts.push("", `[Open in Good Looks!](${link})`);
  parts.push("", "_Filed from Good Looks!_");

  const notices: string[] = [];
  if (defect.kind === "failure" && !defect.headersFiltered) {
    notices.push(
      "This run was recorded with full request headers, so its network requests are not included.",
    );
  }

  return {
    source,
    title: buildTitle(input),
    body: parts.join("\n"),
    attachments: [],
    notices,
  };
}
