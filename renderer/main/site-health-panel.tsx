// Site Health tab on a test's detail view.
//
// The per-domain series lives in the Site Health view; this tab answers the
// narrower question next to the switch that asks for it — "what did THIS
// test's last run read?" — the way the Accessibility tab sits beside its
// toggle. It describes the most recent run that MEASURED, not the most recent
// run: a later run with the check off must not blank the results.
//
// The one copy rule the a11y panel follows holds here too: "found nothing"
// and "measured nothing" never render the same. A run whose summary says
// zero pages is reported as a fault of the probe, not as a clean site.

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";

import { api } from "../lib/api";
import { shortDate } from "./site-health-view";
import { describeSiteHealthOutcome, formatBytes, formatVital } from "../../shared/site-health.mjs";
import type { TestRecord } from "../lib/recorder-types";

function score(n: number | null): string {
  return n === null ? "—" : String(n);
}

export function SiteHealthPanel({ test }: { test: TestRecord }) {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["site-health", "test", test.id],
    queryFn: () => api.siteHealth.forTest(test.id),
  });

  if (q.isLoading) return <div className="gl-visual-loading" />;
  const data = q.data;
  if (!data) {
    return (
      <div className="gl-empty">
        <span className="gl-empty-title">No Site Health reading yet</span>
        <span className="gl-empty-note">
          Switch on “Check Site Health” in Settings → Test defaults, then run this test. Every page the run loads is scored for SEO and performance.
        </span>
      </div>
    );
  }

  const { run, summary, pages } = data;
  return (
    <div className="gl-sh-panel">
      <div className="gl-sh-head">
        <span className="gl-sh-head-meta">
          {describeSiteHealthOutcome(summary)}
          {` Run of ${shortDate(run.startedAt)}${run.ingested ? ", ingested from another machine" : ""}.`}
        </span>
      </div>
      {summary.hosts.map((h) => (
        <div key={h.host} className="gl-sh-panel-host">
          <span className="gl-sh-host-name" title={h.host}>
            {h.host}
          </span>
          <span className="gl-sh-host-meta">
            SEO {score(h.seo)} · performance {score(h.perf)} · {h.pages} page{h.pages === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="gl-cost-edit"
            onClick={() =>
              void navigate({
                to: "/site-health/$host/$category",
                params: { host: h.host, category: "seo" },
              })
            }
            aria-label={`Open Site Health for ${h.host}`}
          >
            <ExternalLink className="gl-mini-icon" aria-hidden="true" />
            Site Health
          </button>
        </div>
      ))}
      {pages.length > 0 ? (
        <div className="gl-sh-table-wrap">
          <table className="gl-sh-table">
            <thead>
              <tr>
                <th>Page</th>
                <th>Title</th>
                <th className="gl-sh-num">SEO</th>
                <th className="gl-sh-num">Perf</th>
                <th className="gl-sh-num">LCP</th>
                <th className="gl-sh-num">CLS</th>
                <th className="gl-sh-num">Transferred</th>
                <th>Engine</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((p, i) => (
                <tr key={`${p.reading.id}-${i}`}>
                  <td>
                    <span className="gl-sh-path" title={p.reading.url}>
                      {p.reading.host}
                      {p.reading.path}
                    </span>
                  </td>
                  <td>
                    <span className="gl-sh-path" title={p.reading.title}>
                      {p.reading.title || "(no title)"}
                    </span>
                  </td>
                  <td className="gl-sh-num">{score(p.seo)}</td>
                  <td className="gl-sh-num">{score(p.perf)}</td>
                  <td className="gl-sh-num">{formatVital("lcp", p.reading.metrics.lcp)}</td>
                  <td className="gl-sh-num">{formatVital("cls", p.reading.metrics.cls)}</td>
                  <td className="gl-sh-num">{formatBytes(p.reading.metrics.transferBytes)}</td>
                  <td>
                    {p.reading.engine}
                    {p.partial ? " (partial)" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : summary.pages > 0 ? (
        <p className="gl-panel-note">
          The per-page readings for this run have been cleaned up; the summary above is what the run recorded.
        </p>
      ) : null}
    </div>
  );
}
