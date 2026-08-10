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
import { ChevronRight } from "lucide-react";

import { Panel, TONE, Verdict } from "../../theme";
import { api } from "../../lib/api";
import {
  categoryMeta,
  facetLabel,
  isMeasured,
  summariseHeals,
  summariseStability,
  type CategorySummary,
} from "../../lib/stats-categories";
import { VERDICT_COPY } from "../flake-panel";
import type { HealListEntry, StabilityVerdict, TestFlake } from "../../lib/recorder-types";

/** The categories with a dashboard built. The board renders the rest as tiles
 *  that state why they do not open — a map that omits where you cannot go yet
 *  is a map you stop trusting. */
export const BUILT = ["stability", "heals"] as const;

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
  const meta = categoryMeta(summary.id)!;
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
        <p className="gl-cat-say">{measured ? `${summary.display} ${meta.unit}` : summary.say}</p>
      </div>
    </Panel>
  );
}

/** A drillable row: a label, a count, and a chevron. The whole row is the
 *  button — a chevron you have to hit is a target the width of a character. */
function DrillRow({
  label,
  count,
  detail,
  tone,
  onClick,
}: {
  label: string;
  count: number;
  detail: string;
  tone?: keyof typeof TONE | null;
  onClick: () => void;
}) {
  return (
    <button type="button" className="gl-drill" onClick={onClick}>
      <span className="gl-drill-label">{label}</span>
      <span className="gl-drill-count" style={tone ? { color: TONE[tone] } : undefined}>
        {count}
      </span>
      <span className="gl-drill-detail">{detail}</span>
      <ChevronRight aria-hidden="true" className="gl-drill-arrow" />
    </button>
  );
}

/** A row that leaves Stats for the thing it names. Every leaf has these. */
function ExitRow({ name, detail, onOpen }: { name: string; detail: string; onOpen: () => void }) {
  return (
    <div className="gl-exit">
      <div className="gl-rowline">
        <div className="gl-rowline-main">{name}</div>
        <div className="gl-rowline-sub">{detail}</div>
      </div>
      {/* Cyan, which the palette declares "running / live / focus" and which
          `check:selection-neutral` allows on a focus affordance. It is not
          reporting an outcome — it is the way out. */}
      <button type="button" className="gl-exit-go" onClick={onOpen}>
        Open test ›
      </button>
    </div>
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

  // Same query keys the board and the panels use, so arriving here costs no
  // round trip and going back costs none either.
  const flakeQuery = useQuery({ queryKey: ["flake"], queryFn: () => api.runs.flake() });
  const healsQuery = useQuery({ queryKey: ["heals", "all"], queryFn: () => api.heals.listAll() });
  const runsQuery = useQuery({ queryKey: ["runs"], queryFn: api.runs.list });

  const meta = categoryMeta(category);

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

  const summary: CategorySummary | null =
    meta.id === "stability" && flake
      ? summariseStability(flake)
      : meta.id === "heals" && heals && runs
        ? summariseHeals(heals, runs)
        : null;

  const body = (() => {
    if (meta.id === "stability") {
      if (!flake) return <p className="gl-panel-note">Loading…</p>;
      return facet ? (
        <StabilityLeaf verdict={facet} tests={flake.tests} onOpenTest={openTest} />
      ) : (
        <StabilityDashboard
          tests={flake.tests}
          onDrill={(v) =>
            navigate({
              to: "/stats/$category/$facet",
              params: { category: meta.id, facet: v },
            })
          }
        />
      );
    }
    if (meta.id === "heals") {
      if (!heals) return <p className="gl-panel-note">Loading…</p>;
      return facet ? (
        <HealsLeaf facet={facet} heals={heals} onOpenTest={openTest} />
      ) : (
        <HealsDashboard
          heals={heals}
          onDrill={(f) =>
            navigate({
              to: "/stats/$category/$facet",
              params: { category: meta.id, facet: f },
            })
          }
          onOpenHeals={() => navigate({ to: "/heals" })}
        />
      );
    }
    // A category the board should not have opened. Reachable by typing a route,
    // so it says what it will show rather than rendering an empty screen.
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
