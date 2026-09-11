# Site Health: SEO and web vitals per domain

**Status: landed 2026-09-10.** See DECISIONS 2026-09-10 and the Site Health bullet in ARCHITECTURE.md; this plan is the record of what was decided and why.

Written 2026-09-10 against 06c680b.

**Status: proposed, awaiting approval.** A per-domain SEO score and page
performance statistics, measured inside the runs the app already performs,
surfaced in one new view and switchable from Settings.

---

## 0. Settled decisions

Answered in the scoping questions before this document was written.

| Question | Decision |
|---|---|
| Where the numbers come from | An in-run probe: a dependency-free script the capture fixture injects into every document a run loads. Nothing leaves the machine. Storage is shaped so a later PageSpeed Insights source can add field data beside lab data (`source` on every reading). |
| View shape and name | One view, **Site Health** (capitalised as a name, review 2026-09-10), rail row between Heals and Insights with lucide's `Heart` icon, route `/site-health`, subtitle "SEO & web vitals by domain". A Segmented switch **SEO / Performance** inside it. Two scores per domain, never combined. |
| The switch | Settings → Test defaults → "What a run records" → **Check Site Health** (`RecorderSettings.siteHealthChecks`, off by default). Global only in v1. The rail row is hidden while it is off; the route stays registered and explains itself. |
| Domain key | Hostname, lowercased, with a leading `www.` folded; scheme and port ignored. `shop.example.com` and `blog.example.com` are two domains. One shared rule, `shared/site-host.mjs`. |
| Which page loads count | Every document load in every run: each `goto`, each click that navigates, each tab. |
| Unattended runs | The CLI, the MCP `run_test` tool and the GitHub Action collect the same readings, and `good-looks ingest` carries them back. |
| Extra surfaces in v1 | A run Output line, a per-test **Site Health** tab, per-domain facts in the scheduled AI report, an MCP `get_site_health` tool. |
| Ticketing | **Send** a domain's SEO or performance score to Linear or GitHub from the Domain panel, the way an accessibility rule or a visual change is sent today: one issue per domain and category, a "Filed as ENG-142" badge, and a recurrence comment with the fresh numbers instead of a duplicate. Added after the first review of this plan. |

## 1. What a reading is

One reading per DOCUMENT the browser loaded. A document is identified by an id
the init script mints when it starts; every reading of the same document
replaces the previous one, so the stored reading is the LAST state of that
document before the run navigated away or ended. LCP grows and CLS accumulates
across a document's life, and the last reading is the honest one.

```
{
  id, url, host, path, title, tab, cold, navType, engine,
  status, xRobotsTag,                          // from the document response
  facts: {                                     // the SEO probe (in-page, bounded)
    title, titleLength, description, descriptionLength, lang, viewport,
    canonical: [...hrefs], robots: [...contents], h1Count,
    imagesTotal, imagesMissingAlt, links: { total, generic, uncrawlable },
    hreflang: [{ lang, href }], jsonLd: { blocks, invalid, types },
    og: { title, description, image }, twitterCard, protocol, insecureResources
  },
  metrics: {                                   // Navigation Timing + observers
    ttfb, fcp, lcp, cls, tbt, inp, dcl, load, requests, transferBytes,
    coverage: ["fcp","lcp","cls","tbt"]        // what THIS engine could measure
  },
  source: "lab"
}
```

Facts, not verdicts, cross the page boundary. The page says "h1Count: 3"; the
rule that turns that into a warning lives in `shared/site-health.mjs`, so a
scorer can be corrected without re-running anything, and a page cannot claim a
pass. Every string is capped and every list is bounded before it leaves the
page (the `runAxe` rule: caps passed as arguments, never closed over).

## 2. Scores

### 2.1 SEO

Each audit is pass / fail / warn / n-a. Score = 100 × weight of passing audits
÷ weight of applicable audits, rounded. Warn counts as pass; n-a is excluded.
Weights follow Lighthouse's SEO category, where every scored audit weighs 1.

| id | Audit | Weight | Passes when |
|---|---|---|---|
| `document-title` | Page has a title | 1 | `<title>` is non-empty (over 60 characters warns) |
| `meta-description` | Meta description present | 1 | `meta[name=description]` is non-empty |
| `html-lang` | Document language set | 1 | `<html lang>` is a plausible BCP 47 tag |
| `viewport` | Viewport meta present | 1 | `meta[name=viewport]` exists |
| `http-status` | Page answered 2xx | 1 | the document response status is 200–299; n-a when unknown |
| `indexable` | Page is indexable | 1 | no `noindex` in `meta[name=robots]`, `meta[name=googlebot]` or the `X-Robots-Tag` header |
| `canonical` | Canonical is valid | 1 | n-a when absent; exactly one, absolute `http(s)`, on the same site host |
| `single-h1` | One H1 | 1 | exactly one `<h1>`; none fails, more than one warns |
| `image-alt` | Images have alt text | 1 | every `<img>` carries an `alt` attribute (empty alt is decorative and passes) |
| `link-text` | Links have descriptive text | 1 | no `<a href>` whose text is generic ("click here", "learn more", "read more", "here", "more", "link", "this", "start", "right here", "more info") |
| `crawlable-anchors` | Links are crawlable | 1 | every `<a href>` has a real href — not `javascript:`, not empty |
| `hreflang` | hreflang links are valid | 1 | n-a when absent; every `link[rel=alternate][hreflang]` has a plausible tag or `x-default` and an absolute href |
| `https` | Served over HTTPS | 1 | `location.protocol` is `https:`; n-a on loopback and `.local` hosts |
| `mixed-content` | No insecure subresources | 1 | on an https page, no resource entry loaded over `http:`; n-a on http pages |
| `structured-data` | Structured data present | 0 | informational: JSON-LD blocks parse; the `@type`s found are listed |
| `social-preview` | Social preview tags | 0 | informational: `og:title`, `og:description`, `og:image`, `twitter:card` |

### 2.2 Performance

Lighthouse v10's lab weights without Speed Index (which needs frame capture):
FCP 10, LCP 25, TBT 30, CLS 25, renormalised over the metrics the engine
delivered. Each metric is scored on Lighthouse's log-normal curve with its
control points — FCP p10 1800 ms / median 3000 ms, LCP 2500 / 4000, TBT 200 /
600, CLS 0.1 / 0.25 — and the weighted mean × 100 is the score. `coverage`
records which of the four were available; a reading missing any of them is
`partial` and the view says so.

| Engine | FCP | LCP | CLS | TBT (long tasks) | INP |
|---|---|---|---|---|---|
| Chromium | yes | yes | yes | yes | yes |
| Firefox 153 | yes | yes | no | no | no |
| WebKit 26 | yes | no | no | no | no |

TTFB, INP, DOMContentLoaded, load, request count and transferred bytes are
recorded and shown, not scored — Lighthouse does not score INP in the lab
either, and TTFB is a component of the scored metrics.

### 2.3 No status words

A score carries NO status label — not "good", "needs work" or "poor". A 54 may
be an acceptable score to the person reading it, and a word that says
otherwise is the app's opinion, not a measurement (review, 2026-09-10). What a
score is shown with is its CHANGE against the prior period of the same length
("−4 vs prior"), in the box where a status word would have gone, and that box
is the one thing that takes a colour: amber for a drop, phos for a rise,
neutral for no change. The score digits, the trend line, the sparkline bars and
the page-table scores stay neutral.

Vitals are shown at p75 beside their published Core Web Vitals target, stated
as a number — "over the 2.5 s target", "within the 0.1 target" — never as a
grade. Targets: LCP 2.5 s, CLS 0.1, INP 200 ms, FCP 1.8 s, TTFB 0.8 s, TBT
200 ms. A vital over its target is the one other reading that takes amber; a
vital within it stays neutral. Each vital card explains its statistic, its
sample and its target on hover and on keyboard focus — a DOM-rendered
Tooltip (`@ui`'s), never a native `title`: on the pinned Electron, macOS
shows a `title` on the first hover and rarely again (electron/electron#49843).
The card is in the tab order, focus opens the same words, and the target also
stays visible as text. The same goes for every other explanation on the
screen — the change boxes, the series bars, the pages table's column heads;
a `title` remains only where it reveals text the row truncates.

"Transferred" is the name of the bytes column and the issue-body figure: bytes
over the network for the page and its resources, compressed. Not "weight",
which reads as the decoded size.

### 2.4 Per-domain arithmetic

- A page's identity is `host + path`; the query string is not part of it.
- A domain's **current score** is the mean of the latest reading per page,
  over the selected range.
- A run's **point** on the trend is the mean of that run's readings on the
  domain. One point per run; a run that loaded no page on the domain is not a
  point, and the chart draws a gap, never a zero.
- **Vitals** per domain are the 75th percentile of readings in the range, the
  Core Web Vitals convention, each with its sample count.
- The **delta** compares the current range with the same length of time
  before it, in words: "−6 vs the 30 days before".
- Cold and warm loads are both scored and each reading says which it was.
  Slow and Crawl speeds delay ACTIONS, not page loads, so they count.

## 3. Where it lives

Three homes, each with its own lifetime, mirroring accessibility.

1. **The run artifact** `artifacts/<testId>/<runId>/site-health.json` —
   the raw readings (§1), written by the fixture into the attempt directory.
   Pruned with the run directory by retention; rolled up before pruning.
2. **The run record** `RunRecord.siteHealth` — a compact per-host summary
   `{ pages, ms, hosts: [{ host, pages, seo, perf }] }`, at most twelve hosts,
   computed at run end by BOTH runners from the artifact through one shared
   function. Survives retention (the 50,000-run index) and travels through
   `good-looks ingest`.
3. **metrics.db** — two new tables, SCHEMA_VERSION 2 (drop and replay):
   - `host_health (run_id, host, pages, seo_score, perf_score)` from the
     run record summary — durable, the trend's source.
   - `page_health (run_id, page_index, host, path, url, title, tab, cold,
     nav_type, engine, status, seo_score, seo_failed, perf_score,
     perf_coverage, fcp, lcp, cls, tbt, inp, ttfb, dcl, load_ms, requests,
     transfer_bytes)` from the artifact — the page list, the findings
     (`seo_failed` holds the failing audit ids) and the vitals. Written when
     the artifact is present, so a page row outlives the pictures beside it
     the way step rows do.

Every query lives in `shared/metrics-query.mjs`; the shaping of rows into
"the overview" and "one domain" lives in `shared/site-health.mjs` so the IPC
handler and the MCP tool cannot describe the same domain two ways.

## 4. The fixture

A separate module, `shared/site-health-fixture-source.mjs` →
`glaze-site-health.mjs`, the settle / signature / user-page idiom. The capture
fixture imports it unconditionally (so it joins `CAPABILITY_FIXTURES` and
`check:ci-fixtures` derives it from the import) and installs it when
`GLAZE_SITE_HEALTH=1`.

- **Install**: one `context.addInitScript` that, in every document, mints the
  document id, buffers `paint`, `largest-contentful-paint`, `layout-shift`,
  `longtask` and `event` observers behind `PerformanceObserver.supportedEntryTypes`,
  and keeps a reader under a namespaced global. One `context.on("response")`
  filtered to `resourceType === "document"`, keeping status and `X-Robots-Tag`
  per URL — in THIS module, because `check:log-capture` pins the capture
  fixture's own response subscription at exactly one.
- **Read**: after every wrapped action (from the capture hook, beside axe),
  on every page's `load` event after a short settle, and once more at
  teardown for the current page of every tab. Each read is one
  `page.evaluate` handing caps in as the argument; the latest reading per
  document id wins.
- **Write**: at teardown, `site-health.json` beside the manifest. Diagnostics
  to stderr only. Nothing here can fail or alter a test; every await is
  bounded and caught.
- Imported specs never get it, like every fixture-borne capability.

## 5. The runners

**App** (`playwright-runner.ts`): `siteHealth = settings.siteHealthChecks &&
!rec.sourceDir`; joins the redirect condition and the `artifactRun` OR (it
writes a file); a "Checking Site Health for this run." announcement; the
skipped-features list; `GLAZE_SITE_HEALTH` in the env block. At teardown the
artifact is read, summarised through `summariseSiteHealth`, written onto the
run record, and one Output line says what happened
(`describeSiteHealthOutcome`): "Site Health: 4 pages scored on
store.example.com — SEO 78, performance 54." Zero pages with the switch on is
a FAULT and is worded as one, the accessibility rule.

**Unattended** (`mcp/run-tests.mjs`): `const wantsSiteHealth = !imported &&
Boolean(settings.siteHealthChecks)`, in `anyCapability`, the env and the
artifact-dir condition; the record carries the same summary; `ran.siteHealth`
reports it; `describeRun` names it when wanted but not run; a
`CI_FIXTURE_POLICY` row (on, "a dependency-free probe that measures the pages
the run loads anyway"); a `GATES` row in `check:ci-fixtures`.

**Ingest** (`cli/ingest.mjs`, `shared/run-ingest.mjs`): `siteHealth` is
admitted through a shared normaliser (rebuilt from named keys, host capped,
scores clamped); `site-health.json` is copied by validated ids beside the run;
and — new — every ingested run is recorded into metrics.db through the MCP's
own `recordRun`. Today ingested runs reach metrics only on a schema rebuild,
which would leave every CI run out of the trend this feature exists to draw.

## 6. The view

`renderer/main/site-health-view.tsx`, on the theme layer. Three routes in the
Stats drill's shape, because a domain needs an ADDRESS — the issue tracker's
deep link points at one:

| Route | Screen | Breadcrumb |
|---|---|---|
| `/site-health` | the domain list, with the worst domain's detail beside it | Home / Site Health |
| `/site-health/$host` | one domain | Home / Site Health / store.example.com |
| `/site-health/$host/$category` | one domain, on SEO or Performance | Home / Site Health / store.example.com / Performance |

`$host` and `$category` are strings out of history and are not trusted: the
view checks the host against the shared host rule and the category against the
two it knows, and renders an explained empty state otherwise. Rail selection is
a prefix test (`isSiteHealthPath`, the `settings-route.ts` shape), so the row
stays selected on the drill. Domain rows navigate rather than select.

- **Chrome**: a Segmented **SEO / Performance** and a Segmented range
  **7 d / 30 d / 90 d / All** (default 30 d; All is every retained reading of
  the domain, `sinceMs` 0). Handlers take `sinceMs`, so the range scopes
  everything on the screen — the rule the Stats board deferred its own range
  on. The "vs prior" comparison uses the same length of time before the range;
  on All there is no prior period and the box says so.
- **Domains** panel (300 px, left): one row per host, lowest score first for
  the active category by default. The panel's sort label ("lowest SEO first")
  is a button: clicking it reverses the order to highest-first and back, and
  the choice is ONE state shared by the SEO and Performance tabs, so switching
  category never silently flips the order. Lowest/highest, not worst/best —
  the no-status-word rule of §2.3 applies to the label too. Monogram, host, the two score chips (the active
  category's emphasised by weight, never by hue), then a footer row: the
  20-run sparkline of the active score at the left, and at the right, always
  separated from it by a fixed gap, the change ("−6 vs prior") and the page and
  run counts — right-aligned, each with its own max-width and ellipsis, so the
  row holds its shape at the rail's width and the full text sits in a
  `title`.
- **Domain** panel (right): the host, page and run counts, a **Send** button
  (and a "Filed as ENG-142" chip once an issue exists for this domain and
  category — §7), a 48 px score with its change box ("−4 vs prior") and one
  sentence saying what the score is a mean of, over which range, and when a
  change was DETECTED ("change detected 28 Aug" — the app observes a run, it
  does not know when a site deployed, so the copy never says "landed" or
  "deployed"; the trend marks the same run with the same word), then the
  trend — score per run over the range, 0–100, with
  hairlines at 50 and 90, a hover crosshair naming the run and the test — and
  then, per tab:
  - **SEO**: Findings — one row per failing audit, "N of M pages", expandable
    to the pages with an "Open test" exit; then the informational audits.
  - **Performance**: a vitals row — LCP, CLS, INP, TTFB, FCP, TBT at p75, each
    with its sample count and its target stated as a number, and its definition
    on hover and focus — then a pages table: path, score, LCP, CLS, TBT,
    transferred bytes, requests, engine, last measured, each row exiting to the
    test that loaded it. A partial reading says which metrics its engine
    lacked.
- **States**: switch off → the view explains itself with a button to Test
  defaults (the route stays reachable from ⌘K and history); switch on with no
  measured run yet → "Run a test to score its pages"; a domain with fewer than
  two points draws no trend.

## 7. Sending a domain's score to the tracker

The verb is **Send**, in the Domain panel's header, and it files the ACTIVE
category — SEO or Performance — for the domain on screen. One issue per domain
and category, the accessibility view's rule-scoped shape: the issue is about
the site, not about one page or one run, so the body lists the pages and the
runs rather than being filed once per page.

- **The source.** A fifth `DefectSource` kind:
  `{ kind: "site-health", host, category: "seo" | "performance", testId, runId }`.
  Host and category are the defect's identity. `testId`/`runId` name the
  ANCHOR — the latest run that measured the domain, captured when Send is
  clicked (the a11y rule anchor rule, DECISIONS 2026-08-25): it is where the
  screenshot comes from and what the deep link falls back to for an app that
  predates the site-health link form. `normalizeSource` validates the host
  through the shared host rule and the category against the two it knows.
- **The link.** Keyed through the ONE `keyFor` derivation, the way the
  insights-report source maps its slots: `testId` empty, the host where a
  step id goes, the category where a rule id goes. So a link made from one run
  is found from every later run of the domain, and a second Send offers
  "Comment on ENG-142" with the fresh numbers ("Seen again" plus the current
  draft body) rather than a duplicate. `issues:siteHealthLinks` reads every
  such link in one call so the view badges every domain row and both category
  tabs from one query, `["site-health-links"]` (not run-derived; it changes
  when the user files).
- **The draft**, pure, in `payload.ts`, pinned by `check:issue-payload`:
  - title: `Performance: store.example.com scores 54/100, −4 vs prior`;
  - the score line — the change against the period before, runs, pages,
    window; no status word, §2.3;
  - Performance: the p75 vitals, each against its target ("over the 2.5 s
    target"), then the slowest pages (at most 10: path, score, LCP, TBT,
    transferred bytes, requests, the test that loaded it), then the engines
    and any partial readings;
  - SEO: the failing audits — "Meta description missing — 6 of 14 pages" —
    each with at most 5 example paths, then the informational audits;
  - context: domain, the tests that measured it (at most 10), the scoring rule;
  - the deep link, "Filed from Good Looks!".
  Bounded like everything that leaves: paths go through `line()`, page TITLES
  are never included (page-authored text), URLs are path-only with no query,
  and no log, console line, header or request appears — the four properties the
  check already pins, plus a fifth for this kind.
- **The screenshot.** The anchor run's screenshot of the worst page, when that
  run captured screenshots. A reading records the capture action index current
  at its last read (`action`), so the page ↔ `<action>.png` join is the
  manifest's own rather than a second matching. Labelled "Example · /checkout".
  GitHub's provider declares no image upload and the dialog says so before the
  send, exactly as today.
- **The deep link.** `goodlooks://site-health/<host>/<category>`, parsed by
  `shared/deep-link.mjs` beside the test form under the same refusals (dot
  segments, bounded segments, nothing past what is implemented); the target
  gains a `kind`, the shell forwards it unchanged, and `root-view` routes it
  to `/site-health/$host/$category`. Builder and parser stay in one module.
- **The loader**, the impure half, reads the same metrics.db rows the view reads
  and shapes them through the same shared function, so the issue and the screen
  cannot state two numbers; the anchor run's artifact supplies the
  page ↔ screenshot join. Plain data goes to the builder.
- **The preview** fakes `issues:buildDraft` for the kind and answers
  `issues:siteHealthLinks`, so the filed and unfiled states can be looked at.

## 8. The other surfaces

- **Per-test tab** "Site Health", last tab, hidden for imported tests: the
  pages the latest MEASURED run loaded, with both scores, the vitals and the
  failing audits (with details while the artifact lives).
- **Run Output line**, §5.
- **Insights facts**: `siteHealth` — per host, scores and their change vs the
  previous period, top five by pages — through a new narrow dep, added to
  `payloadFor` and `SENDING_LABELS` ("Site Health scores by domain"). Numbers
  only, so the planted-secret egress check passes unchanged.
- **MCP** `get_site_health({ host?, days? })`: the overview, or one domain's
  series, findings, vitals and pages, over `metricsDb()` and the same shared
  shaping the view reads. Read-only.
- ⌘K entry, breadcrumb label, `?view=site-health` in the preview, preview
  fixtures with a multi-run series so the trend renders.

## 9. Deliberately out of v1

- Field data (PageSpeed Insights / CrUX) — a new egress host; the `source`
  field is where it would land.
- Fetching `robots.txt` or a sitemap — requests the test did not make.
- An accepted baseline per domain, a score-threshold gate step, a Stats board
  tile, the trainer's live page.
- A per-test override of the switch.
- SPA route changes without a document load (one reading per document).
- Speed Index (needs frame capture).

## 10. Tests and checks

- `shared/site-health.test` (node): every audit's pass/fail/warn/n-a, the
  log-normal curve at its control points, coverage renormalisation, bands,
  the host key, the summary and normaliser, the overview/detail shaping.
- `site-health-fixture.dom.test.ts`: the shipped in-page reader evaluated
  from its source against jsdom documents with planted defects and faked
  performance entries — the `capture-fixture-a11y` pattern.
- `check:site-health`: the worker-side fixture string executed against a
  stubbed page/context — install order, the document-response join, the
  latest-reading-wins rule, the file written into the attempt directory.
- `e2e/site-health.spec.ts`: a generated spec run through the real Playwright
  CLI against a local page with known defects; asserts the artifact and the
  summary the runner derives — the one place the probe meets a real browser.
- Ticketing: a site-health section in `check:issue-payload` (a planted marker
  in a path, an audit label and a host never survives; page titles never
  appear; lists are capped), `issue-link-store.test.ts` (the key round-trips
  and ignores the run), `issue-tracker-service.test.ts` (`normalizeSource`
  refuses a bad host or category), the dialog's `defectSourceKey` (the
  exhaustive switch makes the new kind a type error until spelled), the view
  test (Send opens the dialog with the anchor; the Filed chip), and
  `deep-link.test.ts` for the new form.
- Extended: `check:metrics-db` (both tables, idempotence, rebuild, cascade),
  `check:ci-fixtures` (gate row, policy row), `check:run-ingest` (field
  agreement), `check:derived-cache` (`["site-health"]`), `check:mcp-parity`
  (the skipped sentence), `run-history-append.test.ts`, the settings schema
  and label-parity tests, `library-sidebar.test.tsx` and
  `e2e/app-launch.spec.ts` (the row, on and off), view/panel/handler tests,
  the insights egress fixture, `preview-bridge.test.ts` mustHandle.

## 11. Docs

ARCHITECTURE.md (an Overview bullet in the accessibility bullet's shape, the
shared modules, the view, the store layout, the IPC channels, the MCP tool,
the issue tracker's new kind and deep-link form),
a DECISIONS.md entry (facts-not-verdicts across the page boundary; three
homes; the separate fixture module and why; ingest recording metrics; hidden
row vs the Insights precedent), CLAUDE.md's directory map, mcp/README.md,
docs/MCP-GUIDE.md's question table, docs/CI-GUIDE.md's capability note.

## 12. Order of work

One pull request, committed in this order so each step is gated by the one
before it: shared rules → fixture → settings switch → app runner and record →
metrics tables and queries → unattended runner and ingest → IPC and preview →
the view and rail → the tracker send → per-test tab → insights facts and MCP
tool → e2e → docs.
