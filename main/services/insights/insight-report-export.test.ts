// The two export builders: the issue body (markdown) and the PDF page (HTML).
//
// The HTML builder's load-bearing claim is ESCAPING: its input is model
// output and test names — text a web page can influence — and this module is
// where that text becomes markup, which is exactly the join injection lives
// at. The other shared claim is the null-stats rule both builders inherit
// from the view's strip: metrics-unavailable renders as absence, never as a
// reassuring zero. And the page must be self-contained — it is loaded into a
// hidden window and printed, so an external asset would be a network call
// nobody asked for.

import { describe, expect, it } from "vitest";

import type { InsightReport } from "../../recorder/types.js";
import { insightReportIssueTitle, insightReportMarkdown } from "./insight-report-markdown.js";
import { insightReportHtml, insightReportPdfName } from "./insight-report-html.js";

function report(over: Partial<InsightReport> = {}): InsightReport {
  return {
    id: "r1",
    cadence: "weekly",
    periodStart: Date.UTC(2026, 7, 10),
    periodEnd: Date.UTC(2026, 7, 17),
    generatedAt: Date.UTC(2026, 7, 17, 9, 0),
    provider: "ollama",
    model: "qwen",
    headline: "One failure worth a look.",
    sections: [{ title: "Overview", body: "First paragraph.\n\nSecond paragraph." }],
    actions: [
      { kind: "debug-test", testId: "t1", testName: "Login", label: "Keeps failing." },
      { kind: "open-heals", label: "Review the heals." },
    ],
    stats: {
      runs: 12,
      failed: 3,
      previousRuns: 9,
      flakyRuns: 1,
      healedSteps: 2,
      healFailures: 0,
      visualChanges: null,
      newClusters: null,
      a11yNewSteps: 0,
      testsCreated: 0,
      unreviewedScriptChanges: 0,
      expiringSignatures: 0,
      siteHealthDomains: null,
    },
    sending: [],
    promptChars: 100,
    answerChars: 50,
    durationMs: 1000,
    firstTokenMs: 10,
    read: true,
    ...over,
  };
}

describe("insightReportMarkdown", () => {
  it("carries the headline, sections, recommendations and provider meta", () => {
    const md = insightReportMarkdown(report());
    expect(md).toContain("**One failure worth a look.**");
    expect(md).toContain("## Overview");
    expect(md).toContain("First paragraph.");
    expect(md).toContain("- Keeps failing. (Login)");
    expect(md).toContain("- Review the heals.");
    expect(md).toContain("ollama (qwen)");
  });

  it("omits null metrics rows rather than writing zeros", () => {
    const md = insightReportMarkdown(report());
    expect(md).toContain("| Runs | 12 |");
    expect(md).not.toContain("Visual changes");
    expect(md).not.toContain("New failure signatures");
  });

  it("labels a degraded report", () => {
    expect(insightReportMarkdown(report({ degraded: true }))).toContain("unstructured");
    expect(insightReportMarkdown(report())).not.toContain("unstructured");
  });

  it("titles by cadence and date", () => {
    expect(insightReportIssueTitle(report())).toBe("Weekly testing report — 2026-08-17");
  });
});

describe("insightReportHtml", () => {
  it("escapes model-influenced text everywhere it becomes markup", () => {
    const hostile = report({
      headline: `<script>alert(1)</script> & "quotes"`,
      sections: [{ title: "<img src=x onerror=1>", body: "Body with <b>tags</b>." }],
      actions: [
        {
          kind: "run-test",
          testId: "t1",
          testName: `<iframe>`,
          label: `</style><script>1</script>`,
        },
      ],
    });
    const html = insightReportHtml(hostile);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>tags</b>");
    expect(html).not.toContain("<iframe>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("is self-contained — no external URL anywhere in the page", () => {
    const html = insightReportHtml(report());
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("@import");
  });

  it("omits null metrics rows, like the strip and the markdown", () => {
    const html = insightReportHtml(report());
    expect(html).toContain("Runs");
    expect(html).not.toContain("Visual changes");
  });

  it("names the file by cadence and day", () => {
    expect(insightReportPdfName(report())).toBe("insights-weekly-2026-08-17.pdf");
  });
});
