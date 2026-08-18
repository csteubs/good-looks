// AI Debug — the category dashboard and its leaf.
//
// THE READING ORDER IS THE ARGUMENT. How did the attempts end, what came out of
// them, what did they cost in time, what did that buy, why did the failures
// fail, is it getting better, and which tests keep needing it. Each panel
// answers the question the one above it raises, and the two that carry any
// judgement — fixes and savings — come before the ones that merely describe
// activity, because a screen that opens with volume invites "we used it a lot"
// as the conclusion.
//
// IT REPORTS; THE PANEL AND THE TESTS ACT. No accept, revert or re-send is
// reachable from here — `check:stats-categories` enforces that across this
// whole directory — so every row that names a test exits to it.
//
// WHAT IS DELIBERATELY NOT ON THIS SCREEN: anything the model SAID. The history
// behind these figures holds no answers, no reasoning and no error text (see
// main/services/ai-debug-history-store.ts), which is exactly what lets it count
// sessions whose content was deleted with their test. A panel here quoting a
// diagnosis would quietly re-create the store this one was built to avoid.

import { Panel, TONE } from "../../theme";
import { facetLabel } from "../../lib/stats-categories";
import {
  CHARS_PER_TOKEN,
  OUTCOME_FACETS,
  type AiDebugReport,
  type OutcomeFacet,
} from "../../lib/ai-debug-stats";
import { formatSpend } from "../../lib/cost-model";
import type { CostCurrency } from "../../../shared/cost-units.mjs";
import { StatCard } from "./outcomes-dashboard";
import { DrillRow, ExitRow } from "./rows";

/** What each outcome MEANS, in the user's words. Kept beside the dashboard
 *  rather than in the pure module because it is row copy, and `FACET_LABELS`
 *  already owns the names themselves — this is the sentence under the name. */
const OUTCOME_DETAIL: Record<OutcomeFacet, string> = {
  done: "The model finished and produced an answer",
  error: "Something stopped it before it could answer",
  cancelled: "You stopped it — nothing was billed after that",
  interrupted: "The app closed while the model was still answering",
};

const OUTCOME_TONE: Record<OutcomeFacet, "phos" | "amber" | null> = {
  done: "phos",
  error: "amber",
  cancelled: null,
  interrupted: null,
};

/** ms → the coarsest unit that still says something. Minutes matter here in a
 *  way they do not for a step: a diagnosis is tens of seconds, and a suite's
 *  worth of them is hours. */
export function formatWait(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = ms / 60_000;
  if (minutes < 60) return `${minutes.toFixed(1)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

/** Minutes at the precision the assumption behind them deserves. SIGNED,
 *  because a net saving CAN be negative and flooring it at zero would hide the
 *  single most useful thing this screen can tell someone. */
export function formatNetMinutes(minutes: number): string {
  const abs = Math.abs(minutes);
  const body = abs < 60 ? `${Math.round(abs)} min` : `${(abs / 60).toFixed(1)} h`;
  return minutes < 0 ? `−${body}` : body;
}

/** Approximate tokens, in the units people quote them in. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export interface AiDebugDashboardProps {
  report: AiDebugReport;
  /** The two assumptions behind the savings panel, stated on screen so the
   *  arithmetic can be checked without leaving it. */
  minutesPerManualDebug: number;
  currency: CostCurrency;
  onDrill: (facet: string) => void;
}

export function AiDebugDashboard({
  report,
  minutesPerManualDebug,
  currency,
  onDrill,
}: AiDebugDashboardProps) {
  if (report.attempts === 0) {
    return (
      <Panel title="AI Debug">
        <p className="gl-panel-note">
          Nothing has been diagnosed yet. Press “Debug with AI” on a failed run, and what each
          diagnosis costs — and what it saves — is counted here.
        </p>
      </Panel>
    );
  }

  const { outcomes, timing, fixes, savings, local, errors, trend, byTest } = report;
  const settled = report.attempts - outcomes.live;

  return (
    <>
      {/* 1. HOW THEY ENDED. */}
      <Panel
        title="By outcome"
        id={report.firstAt ? `since ${fmtDate(report.firstAt)}` : undefined}
      >
        {OUTCOME_FACETS.map((facet) => (
          <DrillRow
            key={facet}
            label={facetLabel("ai-debug", facet)}
            count={outcomes[facet]}
            detail={OUTCOME_DETAIL[facet]}
            tone={OUTCOME_TONE[facet]}
            onClick={() => onDrill(facet)}
          />
        ))}
        {/* Live attempts are a state, not an outcome, so they are stated rather
            than given a row of their own to drill into. */}
        {outcomes.live > 0 ? (
          <p className="gl-panel-note">
            {outcomes.live} {outcomes.live === 1 ? "attempt is" : "attempts are"} still running, and
            {outcomes.live === 1 ? " is" : " are"} counted in none of the figures below.
          </p>
        ) : null}
      </Panel>

      {/* 2. WHAT CAME OUT OF THEM — the effectiveness question, and the only
          one on this screen the model does not get a vote in. */}
      <Panel title="What the answers changed" id={`${fixes.applied} applied`}>
        {fixes.applied === 0 ? (
          <p className="gl-panel-note">
            No diagnosis has been applied to a test yet. Applying one from the AI Debug panel is
            what makes it measurable here — until then the model has produced reading, not changes.
          </p>
        ) : (
          <>
            <div className="gl-kpis">
              <StatCard
                label="Confirmed by a run"
                value={String(fixes.confirmed)}
                hint="the next run of that test passed"
              />
              <StatCard
                label="Refuted"
                value={String(fixes.refuted)}
                hint="the next run still failed"
              />
              <StatCard
                label="Reverted"
                value={String(fixes.reverted)}
                hint="you put the old script back"
              />
              <StatCard
                label="Not proven yet"
                value={String(fixes.unproven)}
                hint="no run since the fix landed"
              />
            </div>
            <DrillRow
              label={facetLabel("ai-debug", "fixes")}
              count={fixes.applied}
              detail={
                fixes.unreviewed > 0
                  ? `${fixes.unreviewed} applied automatically and never read`
                  : "Every applied fix, and what the run after it did"
              }
              tone={fixes.unreviewed > 0 ? "amber" : "phos"}
              onClick={() => onDrill("fixes")}
            />
          </>
        )}
      </Panel>

      {/* 3. WHAT IT COST IN TIME. */}
      <Panel title="Time spent waiting" id={`${settled} settled ${settled === 1 ? "attempt" : "attempts"}`}>
        <div className="gl-kpis">
          <StatCard label="Total" value={formatWait(timing.totalMs)} hint="across every attempt" />
          <StatCard
            label="Typical attempt"
            value={timing.medianMs === null ? "—" : formatWait(timing.medianMs)}
            hint="median"
          />
          <StatCard
            label="Longest"
            value={timing.longestMs === null ? "—" : formatWait(timing.longestMs)}
          />
          <StatCard
            label="First token"
            value={
              timing.medianFirstTokenMs === null ? "—" : formatWait(timing.medianFirstTokenMs)
            }
            hint={
              timing.medianFirstTokenMs === null
                ? "nothing ever arrived"
                : "median wait before it started"
            }
          />
        </div>
      </Panel>

      {/* 4. WHAT THAT BOUGHT. */}
      <Panel title="What it saved">
        <div className="gl-kpis">
          <StatCard
            label="Net time saved"
            value={savings.countedFixes === 0 ? "—" : formatNetMinutes(savings.netMinutes)}
            hint={
              savings.countedFixes === 0
                ? "no kept fix to claim time for"
                : `${savings.countedFixes} kept ${savings.countedFixes === 1 ? "fix" : "fixes"}, minus the wait`
            }
          />
          {/* Money ONLY when a rate has been stated AND there is something to
              price. The app ships no default rate on purpose
              (`shared/cost-units.mjs`), so this card is absent rather than zero
              until the user says what an hour is worth.
              
              THE SECOND CONDITION IS THE ONE THAT WAS WRONG ON SCREEN. With no
              kept fix the card beside this one refuses to state a figure —
              "no kept fix to claim time for" — while this one happily rendered
              the wait as a cost. Two cards side by side, one declining to
              answer and one answering, read as a bug in whichever the reader
              trusts less. They now say the same thing or nothing. */}
          {savings.netValue !== null && savings.countedFixes > 0 ? (
            <StatCard
              label="At your hourly rate"
              value={formatSpend(Math.abs(savings.netValue), currency)}
              hint={savings.netValue < 0 ? "net cost, not saving" : "net"}
            />
          ) : null}
          <StatCard
            label="Ran on your machine"
            value={`${local.local} of ${report.attempts}`}
            hint={
              local.hosted === 0
                ? "no hosted calls at all"
                : `${local.hosted} went to a hosted model`
            }
          />
          <StatCard
            label="Tokens kept local"
            value={`~${formatTokens(local.localTokens)}`}
            hint={`approx, at ${CHARS_PER_TOKEN} chars per token`}
          />
        </div>
        {/* THE ASSUMPTION, IN PROSE, UNDER THE FIGURE IT PRODUCED. The Cost
            panel's rule, and for its reason: a number nobody can check is a
            number nobody believes. */}
        <p className="gl-panel-note">
          Assuming {minutesPerManualDebug} minutes to work out one failure by hand, counting only
          diagnoses you kept, and subtracting the {formatWait(timing.totalMs)} spent waiting on the
          model. Both assumptions are yours to set in Settings → Cost.
          {local.unknown > 0
            ? ` ${local.unknown} ${local.unknown === 1 ? "attempt predates" : "attempts predate"} provider tracking and ${local.unknown === 1 ? "is" : "are"} counted as neither local nor hosted.`
            : ""}
        </p>
      </Panel>

      {/* 5. WHY THE FAILURES FAILED. Rendered only when there were any — an
          empty table here would read as a feature that fails in ways nobody
          has enumerated. */}
      {errors.length > 0 ? (
        <Panel title="Why attempts failed" id={`${outcomes.error}`}>
          {errors.map((row) => (
            <div key={row.kind} className="gl-exit">
              <div className="gl-rowline">
                <div className="gl-rowline-main">{row.label}</div>
                <div className="gl-rowline-sub">{row.fix}</div>
              </div>
              <span className="gl-drill-count" style={{ color: TONE.amber }}>
                {row.count}
              </span>
            </div>
          ))}
        </Panel>
      ) : null}

      {/* 6. IS IT MOVING. Two windows, or nothing — one window is a
          measurement and two are a comparison. */}
      <Panel title="Last 7 days">
        <div className="gl-kpis">
          <StatCard
            label="Attempts"
            value={String(trend.recent.attempts)}
            hint={
              trend.comparable
                ? `${trend.previous.attempts} the week before`
                : "no earlier week to compare"
            }
          />
          {/* "Answer rate", not "Answered" — the panel above already has an
              Answered row, and that one is a COUNT of attempts while this is a
              percentage of a week. Two things with one name on one screen make
              a reader look for the difference between them. */}
          <StatCard
            label="Answer rate"
            value={
              trend.recent.answeredRate === null
                ? "—"
                : `${Math.round(trend.recent.answeredRate * 100)}%`
            }
            hint={
              trend.comparable && trend.previous.answeredRate !== null
                ? `${Math.round(trend.previous.answeredRate * 100)}% the week before`
                : undefined
            }
          />
          <StatCard
            label="Time waiting"
            value={formatWait(trend.recent.totalMs)}
            hint={trend.comparable ? `${formatWait(trend.previous.totalMs)} the week before` : undefined}
          />
        </div>
      </Panel>

      {/* 7. WHICH TESTS KEEP NEEDING IT. Titled "By test" rather than
          "Most debugged tests", which is the LABEL of the row inside it —
          a panel whose heading repeats its only row's name reads as a
          rendering mistake. "By outcome" above it sets the pattern. */}
      <Panel title="By test">
        <DrillRow
          label={facetLabel("ai-debug", "tests")}
          count={byTest.length}
          detail="Tests you have asked the model about, most first"
          tone={null}
          onClick={() => onDrill("tests")}
        />
      </Panel>
    </>
  );
}

export interface AiDebugLeafProps {
  facet: string;
  report: AiDebugReport;
  onOpenTest: (id: string) => void;
}

/**
 * The leaf.
 *
 * THREE SHAPES OF FACET, and they are genuinely different questions rather
 * than one list filtered three ways: an outcome breaks down by test (nothing
 * else survives in the history), the fixes list is the script-change journal's
 * own rows, and the tests list is the usage table. Each still exits to a real
 * object, which is the rule every leaf on this screen owes the user.
 */
export function AiDebugLeaf({ facet, report, onOpenTest }: AiDebugLeafProps) {
  if (facet === "tests" || (OUTCOME_FACETS as readonly string[]).includes(facet)) {
    const isOutcome = facet !== "tests";
    // The usage table is already per test; an outcome facet needs its own,
    // because a row here has to name something the user can open and a single
    // attempt is not a thing this app has a screen for.
    const rows = report.byTest;
    return (
      <Panel title={facetLabel("ai-debug", facet)} id={`${rows.length}`}>
        {isOutcome ? (
          <p className="gl-panel-note">
            {report.outcomes[facet as OutcomeFacet]}{" "}
            {report.outcomes[facet as OutcomeFacet] === 1 ? "attempt" : "attempts"} ended this way.
            An attempt is not something this app can open on its own, so what follows is every test
            that has been debugged — with the totals each one accounts for.
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="gl-panel-note">No test has been debugged yet.</p>
        ) : (
          rows.map((row) => (
            <ExitRow
              key={row.testId}
              name={row.testDeleted ? `${row.testName} (deleted)` : row.testName}
              detail={`${row.attempts} ${row.attempts === 1 ? "attempt" : "attempts"} · ${
                row.answered
              } answered · ${formatWait(row.totalMs)} waiting`}
              action={row.testDeleted ? "Test deleted" : "Open test"}
              // A deleted test has no page to open. The row stays — its
              // attempts really happened and they are inside every total on the
              // screen above — and the button says why it does nothing.
              onOpen={() => {
                if (!row.testDeleted) onOpenTest(row.testId);
              }}
            />
          ))
        )}
      </Panel>
    );
  }

  if (facet === "fixes") {
    const { fixes } = report;
    return (
      <Panel title={facetLabel("ai-debug", "fixes")} id={`${fixes.applied}`}>
        {fixes.applied === 0 ? (
          <p className="gl-panel-note">No diagnosis has been applied to a test yet.</p>
        ) : (
          <>
            <div className="gl-kpis">
              <StatCard label="Applied" value={String(fixes.applied)} />
              <StatCard label="Kept" value={String(fixes.kept)} hint="accepted, or a run agreed" />
              <StatCard label="Reverted" value={String(fixes.reverted)} />
              <StatCard
                label="Unreviewed"
                value={String(fixes.unreviewed)}
                hint="applied automatically, never read"
              />
            </div>
            {/* THE EXIT, and it leaves Stats deliberately. Reading a fix,
                accepting it and reverting it all live in the Heals view beside
                the test's other changes; this screen counts them. */}
            <p className="gl-panel-note">
              Every applied fix is listed on its test’s Heals tab, with the diff it made and the
              button to put the old script back. This screen counts them; that one changes them.
            </p>
          </>
        )}
      </Panel>
    );
  }

  return (
    <Panel title="Unknown breakdown">
      <p className="gl-panel-note">
        “{facet}” is not an AI Debug breakdown. Go back and pick one from the list.
      </p>
    </Panel>
  );
}
