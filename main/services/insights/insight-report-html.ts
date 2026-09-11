// One insights report as a self-contained printable page, for the PDF export.
//
// Print-styled and LIGHT on purpose — a PDF is paper, not the app's dark
// chrome — with every style inline and no external assets: the page is loaded
// into a hidden window and printed, and a fetch from that window would be a
// network call nobody asked for. All content is escaped on the way in; the
// report's text is model output and test names, and this file turns it into
// markup, which is exactly the join injection lives at.
//
// Pure, so the emitted page is assertable without Electron.

import type { InsightReport } from "../../recorder/types.js";

const CADENCE_WORD: Record<InsightReport["cadence"], string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function paragraphs(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("\n");
}

/** The default filename the save dialog opens on. */
export function insightReportPdfName(report: InsightReport): string {
  const day = new Date(report.generatedAt).toISOString().slice(0, 10);
  return `insights-${report.cadence}-${day}.pdf`;
}

export function insightReportHtml(report: InsightReport): string {
  const statRows: string[] = [];
  const stat = (label: string, value: number | null) => {
    if (value !== null) {
      statRows.push(`<div class="stat"><dt>${esc(label)}</dt><dd>${value}</dd></div>`);
    }
  };
  stat("Runs", report.stats.runs);
  stat("Failed", report.stats.failed);
  stat("Previous period", report.stats.previousRuns);
  stat("Possible flake", report.stats.flakyRuns);
  stat("Healed steps", report.stats.healedSteps);
  stat("Heal failures", report.stats.healFailures);
  stat("Visual changes", report.stats.visualChanges);
  stat("Site Health domains", report.stats.siteHealthDomains ?? null);
  stat("New failure signatures", report.stats.newClusters);
  stat("New a11y violations", report.stats.a11yNewSteps);
  stat("Tests created", report.stats.testsCreated);
  stat("Unreviewed changes", report.stats.unreviewedScriptChanges);
  stat("Signature warnings", report.stats.expiringSignatures);

  const sections = report.sections
    .map(
      (s) => `
      <section>
        ${s.title ? `<h2>${esc(s.title)}</h2>` : ""}
        ${paragraphs(s.body)}
      </section>`,
    )
    .join("\n");

  const actions =
    report.actions.length > 0
      ? `
      <section>
        <h2>Recommended</h2>
        <ul>
          ${report.actions
            .map((a) => {
              const target = a.testName ?? a.testId ?? "";
              return `<li>${esc(a.label)}${target ? ` <span class="target">(${esc(target)})</span>` : ""}</li>`;
            })
            .join("\n")}
        </ul>
      </section>`
      : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(CADENCE_WORD[report.cadence])} testing report</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #1c1e21;
    background: #ffffff;
    padding: 40px 48px;
    font-size: 12px;
    line-height: 1.55;
  }
  h1 { font-size: 19px; line-height: 1.3; margin-bottom: 6px; }
  h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #6b7075;
    margin: 22px 0 8px;
  }
  .meta { color: #6b7075; margin-bottom: 18px; }
  .degraded {
    border: 1px solid #b8860b;
    color: #7a5a05;
    padding: 8px 10px;
    margin-bottom: 16px;
  }
  dl.stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px 24px;
    border: 1px solid #d9dcdf;
    padding: 12px 14px;
    margin-bottom: 8px;
  }
  .stat { display: flex; justify-content: space-between; gap: 8px; }
  .stat dt { color: #6b7075; }
  .stat dd { font-variant-numeric: tabular-nums; }
  p { margin-bottom: 8px; }
  ul { padding-left: 18px; }
  li { margin-bottom: 6px; }
  .target { color: #6b7075; }
  footer {
    margin-top: 26px;
    padding-top: 10px;
    border-top: 1px solid #d9dcdf;
    color: #6b7075;
    font-size: 10px;
  }
</style>
</head>
<body>
  <h1>${esc(report.headline)}</h1>
  <p class="meta">${esc(CADENCE_WORD[report.cadence])} report · ${esc(fmtDate(report.periodStart))} to ${esc(fmtDate(report.periodEnd))} · written by ${esc(report.provider)} (${esc(report.model)})</p>
  ${report.degraded ? `<p class="degraded">The model's answer didn't follow the report format, so it is shown as plain text.</p>` : ""}
  ${statRows.length > 0 ? `<dl class="stats">${statRows.join("\n")}</dl>` : ""}
  ${sections}
  ${actions}
  <footer>Generated by Good Looks! on ${esc(fmtDate(report.generatedAt))}.</footer>
</body>
</html>`;
}
