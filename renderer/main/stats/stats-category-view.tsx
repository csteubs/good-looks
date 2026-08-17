// One category's dashboard, and the leaf below it.
//
// docs/plans/stats-categories.md §5–§6. Route `/stats/$category`, and
// `/stats/$category/$facet` one level down. Back and forward are the router's
// own and the trail is the top strip's breadcrumb — there is deliberately no
// second Back button on this screen, because the app already has one place that
// says where you are.
//
// TWO RULES GOVERN EVERYTHING BELOW.
//
// 1. STATS REPORTS; HEALS AND VISUAL ACT. This screen answers "how much, how
//    often, is it getting worse". It carries no accept, revert or delete
//    control — those live in the operational views, which are one click away
//    from every row here. `check:stats-categories` enforces it rather than
//    leaving it to convention, because the second time someone wants to accept
//    a heal from a chart they will just add the button.
//
// 2. EVERY LEAF EXITS TO A REAL OBJECT. The failure mode of a drill-down
//    hierarchy is a beautifully broken-down number you cannot act on. Every row
//    at the bottom navigates to the test, the run, or the view that owns it.

import * as React from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { Panel, TONE, Verdict } from "../../theme";
import { api } from "../../lib/api";
import {
  categoryMeta,
  facetLabel,
  isMeasured,
  summariseAll,
  type CategoryId,
  type CategorySummary,
} from "../../lib/stats-categories";
import { VERDICT_COPY } from "../flake-panel";
import type { HealListEntry, StabilityVerdict, TestFlake } from "../../lib/recorder-types";
import { DrillRow, ExitRow } from "./rows";
import { OutcomesDashboard, OutcomesLeaf } from "./outcomes-dashboard";
import { A11yDashboard, A11yLeaf } from "./a11y-dashboard";
import { VisualDashboard, VisualLeaf } from "./visual-dashboard";
import { SpeedDashboard, SpeedLeaf } from "./speed-dashboard";
import { StepsDashboard, StepsLeaf } from "./steps-dashboard";

/** The categories with a dashboard built.
 *
 *  ALL SEVEN as of 2026-08-14. It stays a list rather than becoming
 *  `CATEGORIES.map(c => c.id)`, because the next category added to the registry
 *  will not have a dashboard on the day it is added, and a tile that opens a
 *  screen saying "not built yet" is worse than one that says so up front.
 *  `check:stats-categories` proves every id in here actually has a body. */
export const BUILT = [
  "outcomes",
  "stability",
  "heals",
  "a11y",
  "visual",
  "speed",
  "steps",
] as const;

// ── The header block ──────────────────────────────────────────────────

/** The instrument tile from the board options, used where it belongs: one
 *  subject, with room to say what its number means.
 *
 *  DELIBERATELY HEADERLESS. The breadcrumb names this category and so does the
 *  page header directly above; a panel title here would be the third copy of
 *  the same word on one screen, and repetition at that density stops reading as
 *  structure and starts reading as a mistake. The panel keeps its box, which is
 *  what separates the headline from the breakdown below it. */
function CategoryHead({ summary }: { summary: CategorySummary }) {
  const measured = isMeasured(summary.state);
  return (
    <Panel>
      <div className="gl-cat-head">
        {measured ? (
          <span
            className="gl-cat-value"
            style={summary.tone ? { color: TONE[summary.tone] } : undefined}
          >
            {summary.display}
          </span>
        ) : (
          <span className="gl-tile-none">
            {summary.state === "unavailable" ? "No data" : "Not checked"}
          </span>
        )}
        {/* THE SUMMARISER'S OWN SENTENCE, in every state.
            It used to be `display + unit` when measured, and a registry `unit`
            is a fixed plural — so a category with exactly one finding read "1
            steps carry violations you haven’t accepted". Every summariser
            already pluralises its `say` around the same number, so this is one
            sentence written once rather than a second phrasing assembled here.
            The tile keeps `unit`, where it is a column label with no number
            beside it and reads correctly. */}
        <p className="gl-cat-say">{summary.say}</p>
      </div>
    </Panel>
  );
}

// ── Stability ─────────────────────────────────────────────────────────

/** The verdicts worth drilling into, worst first. `stable` and `unknown` are
 *  omitted: neither is a finding, and a list where most rows say "nothing to
 *  report" is a list people stop reading. */
const DRILLABLE: StabilityVerdict[] = [
  "still-failing",
  "changed-since",
  "flaky",
  "data-dependent",
  "fixed",
];

function StabilityDashboard({
  tests,
  onDrill,
}: {
  tests: TestFlake[];
  onDrill: (verdict: string) => void;
}) {
  const byVerdict = DRILLABLE.map((v) => ({
    verdict: v,
    copy: VERDICT_COPY[v],
    tests: tests.filter((t) => t.verdict === v),
  })).filter((g) => g.tests.length > 0);

  if (byVerdict.length === 0) {
    return (
      <Panel title="By verdict">
        <p className="gl-panel-note">
          Every test with enough runs is passing consistently. Nothing to break down.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="By verdict" id="worst first">
      {byVerdict.map((g) => (
        <DrillRow
          key={g.verdict}
          label={facetLabel("stability", g.verdict)}
          count={g.tests.length}
          detail={g.copy.hint}
          tone={g.copy.tone}
          onClick={() => onDrill(g.verdict)}
        />
      ))}
    </Panel>
  );
}

function StabilityLeaf({
  verdict,
  tests,
  onOpenTest,
}: {
  verdict: string;
  tests: TestFlake[];
  onOpenTest: (id: string) => void;
}) {
  const copy = VERDICT_COPY[verdict as StabilityVerdict];
  const matching = tests.filter((t) => t.verdict === verdict);
  if (!copy) {
    return (
      <Panel title="Unknown verdict">
        <p className="gl-panel-note">
          “{verdict}” is not a stability verdict this app produces. Go back and pick one from the
          list.
        </p>
      </Panel>
    );
  }
  return (
    <>
      <Panel title={facetLabel("stability", verdict)}>
        <Verdict tone={copy.tone ?? "cyan"} detail={copy.rule}>
          {copy.hint}
        </Verdict>
      </Panel>
      <Panel title="Tests" id={`${matching.length}`}>
        {matching.length === 0 ? (
          <p className="gl-panel-note">No test currently has this verdict.</p>
        ) : (
          matching.map((t) => (
            <ExitRow
              key={t.testId}
              name={t.testName}
              detail={`${t.passed}/${t.runs} passed · changed its mind ${t.transitions} ${
                t.transitions === 1 ? "time" : "times"
              }`}
              onOpen={() => onOpenTest(t.testId)}
            />
          ))
        )}
      </Panel>
    </>
  );
}

// ── Auto-Heal ─────────────────────────────────────────────────────────

/** Ids and their explanations. The LABELS come from `FACET_LABELS` so the
 *  breadcrumb and these rows cannot name the same facet differently. */
const HEAL_FACETS = [
  { id: "pending", detail: "Applied or suggested, and not yet judged" },
  { id: "accepted", detail: "You approved the substitution" },
  { id: "reverted", detail: "You put the original locator back" },
] as const;

function healsIn(heals: HealListEntry[], facet: string): HealListEntry[] {
  return heals.filter((h) => h.status === facet);
}

function HealsDashboard({
  heals,
  onDrill,
  onOpenHeals,
}: {
  heals: HealListEntry[];
  onDrill: (facet: string) => void;
  onOpenHeals: () => void;
}) {
  return (
    <>
      <Panel title="By state">
        {HEAL_FACETS.map((f) => (
          <DrillRow
            key={f.id}
            label={facetLabel("heals", f.id)}
            count={healsIn(heals, f.id).length}
            detail={f.detail}
            tone={f.id === "pending" ? "amber" : f.id === "accepted" ? "phos" : null}
            onClick={() => onDrill(f.id)}
          />
        ))}
      </Panel>
      <Panel title="Acting on these">
        {/* The line between analytics and operations, stated on screen rather
            than only in a plan. Accept and revert live in the Heals view; this
            screen counts. */}
        <div className="gl-exit">
          <div className="gl-rowline">
            <div className="gl-rowline-main">Heals</div>
            <div className="gl-rowline-sub">
              Accept or revert a substitution, and see what each one changed
            </div>
          </div>
          <button type="button" className="gl-exit-go" onClick={onOpenHeals}>
            Open Heals ›
          </button>
        </div>
      </Panel>
    </>
  );
}

function HealsLeaf({
  facet,
  heals,
  onOpenTest,
}: {
  facet: string;
  heals: HealListEntry[];
  onOpenTest: (id: string) => void;
}) {
  const meta = HEAL_FACETS.find((f) => f.id === facet);
  if (!meta) {
    return (
      <Panel title="Unknown state">
        <p className="gl-panel-note">
          “{facet}” is not a heal state. Go back and pick one from the list.
        </p>
      </Panel>
    );
  }
  const rows = healsIn(heals, facet);
  return (
    <Panel title={facetLabel("heals", facet)} id={`${rows.length}`}>
      {rows.length === 0 ? (
        <p className="gl-panel-note">Nothing is in this state.</p>
      ) : (
        rows.map((h) => (
          <ExitRow
            key={h.id}
            name={h.stepLabel || `Step ${h.stepIndex + 1}`}
            // A heal whose test has been deleted keeps its record; naming it
            // "null" would be worse than saying so.
            detail={`${h.testName ?? "deleted test"} · ${h.applied ? "applied to the test" : "suggested only"}`}
            onOpen={() => onOpenTest(h.testId)}
          />
        ))
      )}
    </Panel>
  );
}

// ── The route component ───────────────────────────────────────────────

export function StatsCategoryView(): React.ReactElement {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { category?: string; facet?: string };
  const category = params.category ?? "";
  const facet = params.facet;

  const meta = categoryMeta(category);

  // THE SAME QUERY KEYS THE BOARD AND THE LANDING'S PANELS USE, so arriving
  // here costs no round trip and going back costs none either (plan §8.9).
  const flakeQuery = useQuery({ queryKey: ["flake"], queryFn: () => api.runs.flake() });
  const healsQuery = useQuery({ queryKey: ["heals", "all"], queryFn: () => api.heals.listAll() });
  const runsQuery = useQuery({ queryKey: ["runs"], queryFn: api.runs.list });
  // Lifetime counts. A second round trip rather than `runs.length`, because the
  // run index is capped and its length is therefore a different number from the
  // one the Outcomes cards and the pass-rate headline claim to state.
  const totalsQuery = useQuery({ queryKey: ["run-totals"], queryFn: api.runs.totals });
  const replaysQuery = useQuery({ queryKey: ["replays"], queryFn: api.artifacts.list });
  const stepHealthQuery = useQuery({
    queryKey: ["metrics", "stepHealth"],
    queryFn: () => api.metrics.stepHealth(),
  });
  const slownessQuery = useQuery({
    queryKey: ["metrics", "slowness"],
    queryFn: () => api.metrics.slowness(),
  });
  const overheadQuery = useQuery({
    queryKey: ["captureOverhead"],
    queryFn: () => api.runs.captureOverhead(),
  });
  // THE ONE QUERY NOTHING ELSE MAKES. Every other key above is already warm
  // from the board; this one opens each test's replay file on disk, so it is
  // fetched only while you are actually standing on the a11y category rather
  // than on every visit to any of the seven. It is in RUN_DERIVED_KEYS, so a
  // finished run still marks it stale.
  const a11yQuery = useQuery({
    queryKey: ["a11y-rollup"],
    queryFn: () => api.a11y.rollup(),
    enabled: meta?.id === "a11y",
  });

  const openTest = (id: string) => navigate({ to: "/test/$id", params: { id } });

  // An unknown category. Route params are strings out of history, so this is
  // reachable, and it must explain rather than crash or render blank.
  if (!meta) {
    return (
      <div className="flex h-full flex-col">
        <header className="gl-stats-head">
          <span className="gl-stats-title">Stats</span>
        </header>
        <div className="gl-empty">
          <span className="gl-empty-title">No such category</span>
          <p className="gl-empty-note">
            “{category}” is not one of the Stats categories. Go back to Stats and pick one from the
            board.
          </p>
        </div>
      </div>
    );
  }

  const flake = flakeQuery.data;
  const heals = healsQuery.data;
  const runs = runsQuery.data;
  const replays = replaysQuery.data;
  const stepHealth = stepHealthQuery.data;
  const slowness = slownessQuery.data;

  // THE HEADLINE COMES FROM THE SAME SUMMARISER THE TILE USED. Recomputing it
  // here — even "the same way" — is how a category comes to state one number on
  // the board and a different one on its own screen. A category whose query has
  // not resolved is absent from this list rather than given a state, which is
  // why the lookup can legitimately find nothing and render no head at all.
  const summary: CategorySummary | null =
    summariseAll({
      runs,
      runTotals: totalsQuery.data,
      flake,
      heals,
      replays,
      stepHealth,
      slowness,
    }).find(
      (s) => s.id === (meta.id as CategoryId),
    ) ?? null;

  const drill = (f: string) =>
    navigate({ to: "/stats/$category/$facet", params: { category: meta.id, facet: f } });

  // EVERY BRANCH WAITS FOR ITS OWN DATA, and "loading" is never rendered as an
  // empty result. A dashboard drawn from an unresolved query says "no findings"
  // in the most confident possible voice.
  const body = (() => {
    if (meta.id === "outcomes") {
      if (!runs) return <p className="gl-panel-note">Loading…</p>;
      return facet ? (
        <OutcomesLeaf facet={facet} runs={runs} onOpenTest={openTest} />
      ) : (
        <OutcomesDashboard
          runs={runs}
          totals={totalsQuery.data}
          overhead={overheadQuery.data}
          onDrill={drill}
        />
      );
    }
    if (meta.id === "stability") {
      if (!flake) return <p className="gl-panel-note">Loading…</p>;
      return facet ? (
        <StabilityLeaf verdict={facet} tests={flake.tests} onOpenTest={openTest} />
      ) : (
        <StabilityDashboard tests={flake.tests} onDrill={drill} />
      );
    }
    if (meta.id === "heals") {
      if (!heals) return <p className="gl-panel-note">Loading…</p>;
      return facet ? (
        <HealsLeaf facet={facet} heals={heals} onOpenTest={openTest} />
      ) : (
        <HealsDashboard
          heals={heals}
          onDrill={drill}
          onOpenHeals={() => navigate({ to: "/heals" })}
        />
      );
    }
    if (meta.id === "a11y") {
      if (!a11yQuery.data) return <p className="gl-panel-note">Loading…</p>;
      return facet ? (
        <A11yLeaf facet={facet} rollup={a11yQuery.data} onOpenTest={openTest} />
      ) : (
        <A11yDashboard rollup={a11yQuery.data} onDrill={drill} />
      );
    }
    if (meta.id === "visual") {
      if (!replays) return <p className="gl-panel-note">Loading…</p>;
      return facet ? (
        <VisualLeaf facet={facet} replays={replays} onOpenTest={openTest} />
      ) : (
        <VisualDashboard
          replays={replays}
          onDrill={drill}
          onOpenVisual={() => navigate({ to: "/visual" })}
        />
      );
    }
    if (meta.id === "speed") {
      if (!slowness) return <p className="gl-panel-note">Loading…</p>;
      return facet ? (
        <SpeedLeaf facet={facet} slowness={slowness} onOpenTest={openTest} />
      ) : (
        <SpeedDashboard slowness={slowness} onDrill={drill} />
      );
    }
    if (meta.id === "steps") {
      if (!stepHealth) return <p className="gl-panel-note">Loading…</p>;
      return facet ? (
        <StepsLeaf facet={facet} stepHealth={stepHealth} onOpenTest={openTest} />
      ) : (
        <StepsDashboard stepHealth={stepHealth} onDrill={drill} />
      );
    }
    // Unreachable while `BUILT` and this switch agree, which
    // `check:stats-categories` proves. Kept as the honest fallback rather than
    // a throw: a blank screen in a packaged build is worse than a sentence.
    return (
      <Panel title={meta.label}>
        <p className="gl-panel-note">
          This category’s dashboard isn’t built yet. It will break down {meta.unit}. For now the
          tile on the Stats board carries its headline.
        </p>
      </Panel>
    );
  })();

  return (
    <div className="flex h-full flex-col">
      <header className="gl-stats-head">
        <span className="gl-stats-title">{meta.label}</span>
        {summary?.window ? <span className="gl-stats-meta">{summary.window}</span> : null}
        {/* No status chip here, and that is a decision rather than an omission.
            The headline number sits in the block immediately below at 32px; a
            chip repeating it in the header would be the same figure twice
            within one screenful, which makes a reader look for the difference
            between them. `gl-stats-actions` stays empty on this screen. */}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-5 p-5 pb-10">
          {summary ? <CategoryHead summary={summary} /> : null}
          {body}
        </div>
      </div>
    </div>
  );
}
