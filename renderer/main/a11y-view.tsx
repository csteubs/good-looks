// The Accessibility view (route /a11y) — the suite-wide home for axe findings.
//
// Accessibility used to be a tenant of the Visual view: a banner, a per-step
// badge and a frame-rail mark, all scoped to ONE RUN of one test. The findings
// that matter are not run-shaped — the same axe rule fires on five tests, and
// triage means deciding about the RULE once, not re-reading it five times. So
// this view is rule-centric: the board lists rules worst-first, and each rule
// carries the two decisions a finding admits — accept it everywhere it fires,
// or send it to the issue tracker as ONE issue listing every occurrence.
//
// Two tabs. TRIAGE is the board above; BASELINE is its memory — which rules
// each test has accepted, revocable one rule at a time (a11y:revokeRule),
// which is what "Reset accepted" was too blunt for. The trend strip answers
// the question neither tab can alone: is the number of new findings moving?
//
// The per-test Accessibility tab and the Stats severity dashboard both stay:
// the first answers "what about THIS test", the second ranks severities. This
// view is the only one where a rule is a first-class row.
//
// Data: the same `["a11y-rollup"]` query the Stats dashboard reads (in
// RUN_DERIVED_KEYS, so a finished run refreshes it), `["tests"]` for the
// baselines, `["runs"]` for the trend.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertDialog, ScrollArea, toast } from "@ui";
import { Accessibility, ExternalLink, RotateCcw, Send, Stamp } from "lucide-react";

import { Btn, Panel, Segmented, TONE, toneSurface } from "../theme";
import { api } from "../lib/api";
import { IMPACT_TONE } from "./a11y-violations";
import { IssueComposeDialog } from "../components/issue-compose-dialog";
import type { A11yRollup, A11yRuleRollup } from "../../shared/a11y-rollup.mjs";
import type { DefectSource, IssueLink } from "../lib/issue-types";
import type { RunRecord, TestRecord } from "../lib/recorder-types";

// ── Shared bits ─────────────────────────────────────────────────────────

function ImpactChip({ impact }: { impact: string }) {
  const tone = IMPACT_TONE[impact as keyof typeof IMPACT_TONE];
  return tone ? (
    <span className="gl-chip-tone" style={toneSurface(TONE[tone])}>
      {impact}
    </span>
  ) : (
    <span className="gl-chip">{impact}</span>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A rule's identity for selection. Impact is part of it because the rollup
 *  keys rules that way — the same axe id can appear once per impact. */
export function ruleKey(rule: A11yRuleRollup): string {
  return `${rule.impact}|${rule.id}`;
}

/** Unique tests a rule fires on. */
export function testsOf(rule: A11yRuleRollup): number {
  return new Set(rule.where.map((w) => w.testId)).size;
}

/**
 * The anchor occurrence for a rule-scoped issue: the first site that names a
 * step. The draft's screenshot and the link's key both hang off it, and the
 * rollup's order is worst-first, so "first" is also "most representative".
 * Null when no site has a step id — nothing on disk to anchor a draft to.
 */
export function ruleAnchor(rule: A11yRuleRollup): DefectSource | null {
  const site = rule.where.find((w) => w.stepId !== null);
  if (!site || site.stepId === null) return null;
  return {
    kind: "a11y",
    testId: site.testId,
    runId: site.runId,
    stepId: site.stepId,
    ruleId: rule.id,
    scope: "rule",
  };
}

/**
 * A test's accepted baseline, grouped by rule — the shape the Baseline tab
 * shows and `a11y:revokeRule` removes. The baseline stores keys spelled
 * `<ruleId>|<target>` per step; a target can be accepted on several steps, so
 * `elements` counts keys, not unique targets.
 */
export function acceptedRules(
  baseline: Record<string, string[]> | undefined,
): { ruleId: string; elements: number }[] {
  const counts = new Map<string, number>();
  for (const keys of Object.values(baseline ?? {})) {
    for (const key of keys) {
      const ruleId = key.split("|")[0] || key;
      counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([ruleId, elements]) => ({ ruleId, elements }))
    .sort((a, b) => b.elements - a.elements || a.ruleId.localeCompare(b.ruleId));
}

/**
 * The trend's series: every run that completed checks, oldest first, capped to
 * the window. `kind: "baseline-update"` runs are events, not runs — the same
 * exclusion `selectLatestA11yRuns` makes — and a run with the toggle on that
 * completed zero checks is a fault, not a zero.
 */
export const TREND_WINDOW = 20;
export function trendSeries(
  runs: readonly Pick<RunRecord, "id" | "startedAt" | "kind" | "a11yChecks" | "a11yNewSteps">[],
): { id: string; newSteps: number }[] {
  return runs
    .filter((r) => r.kind !== "baseline-update" && (r.a11yChecks ?? 0) > 0)
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-TREND_WINDOW)
    .map((r) => ({ id: r.id, newSteps: r.a11yNewSteps ?? 0 }));
}

// ── Triage: the rule board ──────────────────────────────────────────────

function RuleRow({
  rule,
  selected,
  filed,
  onSelect,
}: {
  rule: A11yRuleRollup;
  selected: boolean;
  filed: IssueLink | null;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="gl-axe-row"
      data-selected={selected ? "" : undefined}
      onClick={onSelect}
    >
      <span className="gl-axe-row-head">
        <ImpactChip impact={rule.impact} />
        <code className="gl-axe-row-id" title={rule.id}>
          {rule.id}
        </code>
        {filed ? <span className="gl-chip">{filed.identifier}</span> : null}
      </span>
      <span className="gl-axe-row-help" title={rule.help}>
        {rule.help}
      </span>
      <span className="gl-axe-row-meta">
        {plural(testsOf(rule), "test")} · {plural(rule.steps, "step")} ·{" "}
        {plural(rule.nodes, "element")}
      </span>
    </button>
  );
}

export function RuleDetail({
  rule,
  filed,
  onAccept,
  accepting,
  onSend,
  onOpenTest,
}: {
  rule: A11yRuleRollup;
  filed: IssueLink | null;
  onAccept: () => void;
  accepting: boolean;
  /** Absent when no occurrence has a step to anchor a draft to. */
  onSend: (() => void) | null;
  onOpenTest: (id: string) => void;
}) {
  // One block per test, its sites under it — the fix list a developer works
  // through, which is also exactly what the filed issue's body says.
  const byTest = React.useMemo(() => {
    const map = new Map<
      string,
      { testName: string; sites: { stepLabel: string | null; nodes: number; key: string }[] }
    >();
    for (const [i, site] of rule.where.entries()) {
      const entry = map.get(site.testId) ?? {
        testName: site.testName ?? "deleted test",
        sites: [],
      };
      entry.sites.push({ stepLabel: site.stepLabel, nodes: site.nodes, key: `${site.runId}:${i}` });
      map.set(site.testId, entry);
    }
    return [...map.entries()];
  }, [rule]);

  return (
    <div className="gl-axe-detail-body">
      <div className="gl-axe-detail-head">
        <ImpactChip impact={rule.impact} />
        <code className="gl-mono-value">{rule.id}</code>
        <div className="flex-1" />
        {filed ? (
          <span className="gl-chip" title={filed.url}>
            Filed as {filed.identifier}
          </span>
        ) : null}
        {onSend ? (
          <Btn tone="ghost" onClick={onSend} aria-label={`Send ${rule.id} to the issue tracker`}>
            <Send aria-hidden="true" />
            Send
          </Btn>
        ) : null}
        <AlertDialog
          trigger={
            <Btn tone="ghost" disabled={accepting}>
              <Stamp aria-hidden="true" />
              Accept everywhere
            </Btn>
          }
          title={`Accept ${rule.id} everywhere it fires?`}
          description="This rule's current violations are accepted on every affected test, so they stop being flagged on future runs. Other rules on the same steps are untouched. Undo per test from the Baseline tab."
          confirmLabel="Accept rule"
          confirmVariant="accent"
          onConfirm={onAccept}
        />
      </div>
      <p className="gl-note">{rule.help}</p>
      <div className="gl-axe-where">
        {byTest.map(([testId, entry]) => (
          <div key={testId} className="gl-axe-where-test">
            <div className="gl-axe-where-head">
              <span className="gl-axe-where-name" title={entry.testName}>
                {entry.testName}
              </span>
              <button
                type="button"
                className="gl-cost-edit"
                onClick={() => onOpenTest(testId)}
                aria-label={`Open ${entry.testName}`}
              >
                <ExternalLink className="gl-mini-icon" aria-hidden="true" />
                Open test
              </button>
            </div>
            {entry.sites.map((site) => (
              <div key={site.key} className="gl-axe-where-row">
                <code className="gl-mono-value" title={site.stepLabel ?? undefined}>
                  {site.stepLabel ?? "(step)"}
                </code>
                <span className="gl-axe-where-nodes">{plural(site.nodes, "element")}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TriagePane({
  rollup,
  links,
  onOpenTest,
}: {
  rollup: A11yRollup;
  /** Every a11y issue link, so rows badge without a query per rule. */
  links: IssueLink[];
  onOpenTest: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState<DefectSource | null>(null);

  const rules = rollup.rules;
  const selected = rules.find((r) => ruleKey(r) === selectedKey) ?? rules[0] ?? null;

  const filedFor = (rule: A11yRuleRollup): IssueLink | null =>
    links.find((l) => l.ruleId === rule.id) ?? null;

  const acceptRule = useMutation({
    mutationFn: (ruleId: string) => api.a11y.acceptRule(ruleId),
    onSuccess: (res) => {
      // The handler emits runs:changed, which refreshes every run-derived key
      // through RecorderProvider — but not in the preview, and a user watching
      // THIS board should not wait on a push either.
      void qc.invalidateQueries({ queryKey: ["a11y-rollup"] });
      void qc.invalidateQueries({ queryKey: ["replays"] });
      toast.success(
        res.steps > 0
          ? `Accepted on ${plural(res.steps, "step")} across ${plural(res.tests, "test")}.`
          : "Nothing new to accept — the rule's violations were already accepted.",
      );
    },
    onError: (err) => toast.error(`Couldn't accept the rule: ${err}`),
  });

  if (rules.length === 0) {
    return (
      <Panel title="Rules" className="gl-axe-detail">
        <div className="gl-empty">
          <span className="gl-empty-title">
            {rollup.checkedRuns === 0 ? "No accessibility results yet" : "Nothing to triage"}
          </span>
          <span className="gl-empty-note">
            {rollup.checkedRuns === 0
              ? "Switch on “Check accessibility” beside Run test, then run a test. Findings across the whole suite land here."
              : "Every issue axe found on the latest checked runs is in the accepted baseline."}
          </span>
        </div>
      </Panel>
    );
  }

  return (
    <>
      <Panel
        title="Rules"
        id={`${rules.length} firing · ${plural(rollup.stepsWithNew, "step")}`}
        className="gl-axe-rules"
      >
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col">
            {rules.map((rule) => (
              <RuleRow
                key={ruleKey(rule)}
                rule={rule}
                selected={selected !== null && ruleKey(rule) === ruleKey(selected)}
                filed={filedFor(rule)}
                onSelect={() => setSelectedKey(ruleKey(rule))}
              />
            ))}
          </div>
        </ScrollArea>
      </Panel>
      <Panel title="Rule" id={selected?.id} className="gl-axe-detail">
        {selected ? (
          <RuleDetail
            rule={selected}
            filed={filedFor(selected)}
            accepting={acceptRule.isPending}
            onAccept={() => acceptRule.mutate(selected.id)}
            onSend={
              ruleAnchor(selected) ? () => setSending(ruleAnchor(selected)) : null
            }
            onOpenTest={onOpenTest}
          />
        ) : null}
      </Panel>
      <IssueComposeDialog
        source={sending}
        open={sending !== null}
        onOpenChange={(open) => {
          if (!open) setSending(null);
        }}
        onFiled={(issue) => {
          toast.success(`Filed as ${issue.identifier}.`);
          void qc.invalidateQueries({ queryKey: ["a11y-links"] });
        }}
        onCommented={(link) => toast.success(`Added to ${link.identifier}.`)}
      />
    </>
  );
}

// ── Baseline & trends ───────────────────────────────────────────────────

function TrendStrip({ runs }: { runs: RunRecord[] }) {
  const series = trendSeries(runs);
  // One point is not a series, and drawing it would imply it is — the same
  // rule the Visual view's drift strip follows.
  if (series.length < 2) return null;
  const peak = Math.max(...series.map((p) => p.newSteps), 1);
  const latest = series[series.length - 1];
  return (
    <div className="gl-axe-trend">
      <div className="gl-axe-trend-strip" aria-hidden>
        {series.map((p) => (
          <span key={p.id} className="gl-axe-trend-slot">
            <span
              className="gl-axe-trend-bar"
              data-new={p.newSteps > 0 ? "" : undefined}
              // The floor keeps "checked, found nothing new" visible — a
              // zero-height bar reads as a run that never checked.
              style={{ height: `${Math.max(0.12, p.newSteps / peak) * 100}%` }}
            />
          </span>
        ))}
      </div>
      <span className="gl-note">
        {latest.newSteps === 0
          ? `Nothing new on the latest checked run · last ${series.length} checked runs`
          : `${plural(latest.newSteps, "step")} with new issues on the latest checked run · last ${series.length} checked runs`}
      </span>
    </div>
  );
}

export function BaselinePane({
  tests,
  runs,
  rollup,
}: {
  tests: TestRecord[];
  runs: RunRecord[];
  rollup: A11yRollup;
}) {
  const qc = useQueryClient();
  const withBaseline = tests.filter(
    (t) => t.a11yBaseline && Object.keys(t.a11yBaseline).length > 0,
  );
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected =
    withBaseline.find((t) => t.id === selectedId) ?? withBaseline[0] ?? null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["tests"] });
    void qc.invalidateQueries({ queryKey: ["a11y-rollup"] });
  };
  const revokeRule = useMutation({
    mutationFn: ({ testId, ruleId }: { testId: string; ruleId: string }) =>
      api.a11y.revokeRule(testId, ruleId),
    onSuccess: (res) => {
      refresh();
      toast.success(
        res.removed > 0
          ? `Un-accepted ${plural(res.removed, "element")}. The next run reports them again.`
          : "Nothing was accepted under that rule.",
      );
    },
    onError: (err) => toast.error(`Couldn't revoke: ${err}`),
  });
  const resetBaseline = useMutation({
    mutationFn: (testId: string) => api.a11y.resetBaseline(testId),
    onSuccess: (res) => {
      refresh();
      toast.success(
        res.cleared > 0
          ? "Accepted issues cleared. The next run reports everything again."
          : "There was nothing accepted for this test.",
      );
    },
    onError: (err) => toast.error(`Couldn't reset: ${err}`),
  });

  return (
    <>
      <Panel
        title="Accepted"
        id={withBaseline.length > 0 ? `${withBaseline.length} tests` : undefined}
        className="gl-axe-rules"
      >
        {withBaseline.length === 0 ? (
          <p className="gl-panel-note">
            No test has accepted issues yet. Accepting — per step, per run, or per rule from
            Triage — records them here.
          </p>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col">
              {withBaseline.map((t) => {
                const rules = acceptedRules(t.a11yBaseline);
                const elements = rules.reduce((n, r) => n + r.elements, 0);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className="gl-axe-row"
                    data-selected={selected?.id === t.id ? "" : undefined}
                    onClick={() => setSelectedId(t.id)}
                  >
                    <span className="gl-axe-row-help" title={t.name}>
                      {t.name}
                    </span>
                    <span className="gl-axe-row-meta">
                      {plural(rules.length, "rule")} · {plural(elements, "element")} accepted
                    </span>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </Panel>
      <Panel title="Baseline" id={selected?.name} className="gl-axe-detail">
        <div className="gl-axe-detail-body">
          {/* Suite posture first: what is still OUT there, before what has been
              signed off. The two together are the compliance picture. */}
          <div className="gl-axe-posture">
            {rollup.byImpact.map((row) =>
              row.steps > 0 ? (
                <span
                  key={row.impact}
                  className="gl-chip-tone"
                  style={toneSurface(
                    TONE[IMPACT_TONE[row.impact as keyof typeof IMPACT_TONE] ?? "amber"],
                  )}
                >
                  {row.steps} {row.impact}
                </span>
              ) : null,
            )}
            {rollup.stepsWithNew === 0 && rollup.checkedRuns > 0 ? (
              <span className="gl-chip-tone" style={toneSurface(TONE.phos)}>
                nothing unaccepted
              </span>
            ) : null}
          </div>
          <TrendStrip runs={runs} />
          {selected ? (
            <div className="gl-axe-baseline">
              <div className="gl-axe-where-head">
                <span className="gl-axe-where-name" title={selected.name}>
                  {selected.name}
                </span>
                <AlertDialog
                  trigger={
                    <Btn tone="ghost" disabled={resetBaseline.isPending}>
                      <RotateCcw aria-hidden="true" />
                      Reset all
                    </Btn>
                  }
                  title="Forget everything this test has accepted?"
                  description="Every accepted accessibility issue on this test is un-accepted. The next run reports all of them again."
                  confirmLabel="Reset"
                  confirmVariant="destructive"
                  onConfirm={() => resetBaseline.mutate(selected.id)}
                />
              </div>
              {acceptedRules(selected.a11yBaseline).map((r) => (
                <div key={r.ruleId} className="gl-axe-where-row">
                  <code className="gl-mono-value">{r.ruleId}</code>
                  <span className="gl-axe-where-nodes">{plural(r.elements, "element")}</span>
                  <AlertDialog
                    trigger={
                      <Btn tone="ghost" disabled={revokeRule.isPending}>
                        Revoke
                      </Btn>
                    }
                    title={`Un-accept ${r.ruleId} for this test?`}
                    description="Only this rule's acceptances are removed — everything else stays accepted. The next run reports this rule's violations again."
                    confirmLabel="Revoke"
                    confirmVariant="destructive"
                    onConfirm={() => revokeRule.mutate({ testId: selected.id, ruleId: r.ruleId })}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="gl-panel-note">
              Select a test to see what it has accepted, rule by rule.
            </p>
          )}
        </div>
      </Panel>
    </>
  );
}

// ── The view ────────────────────────────────────────────────────────────

export function A11yView() {
  const navigate = useNavigate();
  const [tab, setTab] = React.useState<"triage" | "baseline">("triage");

  const rollup = useQuery({ queryKey: ["a11y-rollup"], queryFn: api.a11y.rollup });
  const tests = useQuery({ queryKey: ["tests"], queryFn: api.tests.list });
  const runs = useQuery({ queryKey: ["runs"], queryFn: api.runs.list });
  // ONE links read for the whole board rather than one per rule. Keyed on its
  // own name — links are not run-derived, they change when the user files.
  const links = useQuery({ queryKey: ["a11y-links"], queryFn: api.issues.a11yLinks });

  const onOpenTest = (id: string) => void navigate({ to: "/test/$id", params: { id } });

  return (
    <div className="gl-axe">
      <div className="gl-axe-tabs">
        <Accessibility className="gl-axe-tabs-icon" aria-hidden="true" />
        <Segmented
          label="Accessibility tab"
          value={tab}
          onChange={(v) => setTab(v as "triage" | "baseline")}
          options={[
            { value: "triage", label: "Triage" },
            { value: "baseline", label: "Baseline & trends" },
          ]}
        />
      </div>
      <div className="gl-axe-panes">
        {rollup.isLoading ? (
          <Panel title="Rules" className="gl-axe-detail">
            <div className="gl-visual-loading" />
          </Panel>
        ) : tab === "triage" ? (
          <TriagePane
            rollup={rollup.data ?? { checkedRuns: 0, stepsWithNew: 0, byImpact: [], rules: [] }}
            links={links.data ?? []}
            onOpenTest={onOpenTest}
          />
        ) : (
          <BaselinePane
            tests={tests.data ?? []}
            runs={runs.data ?? []}
            rollup={rollup.data ?? { checkedRuns: 0, stepsWithNew: 0, byImpact: [], rules: [] }}
          />
        )}
      </div>
    </div>
  );
}
