// The console's History tab: this test's past runs, and the freshest pictures.
//
// TWO HALVES, ONE QUESTION. "What has this test been doing?" is answered by the
// run list (outcome, when, how long, on what engine, and the amber facts — a
// heal, a retry, an a11y finding — that make a green row worth a second look)
// and by the most recent captured run's screenshots, which are the only part of
// a run's evidence that can be read at a glance. Deeper answers stay where they
// live: the Stats view for the full history, the Visual view for comparing
// frames — this tab links there rather than growing its own viewer.
//
// THE LIST COMES IN AS A PROP, THE PICTURES ARE QUERIED HERE. The detail view
// already holds `["runs"]` for its a11y badge and run summary, so handing the
// list down costs nothing; the replay index and the frames are only wanted
// while this tab is OPEN, and Radix unmounts an inactive tab — so querying here
// means a user who never opens History never pays for it. The keys are the
// Visual view's own (`["replays"]`, `["replay", …]`, `["shot", …]`), so the two
// screens share a cache instead of asking twice; `["replays"]` is run-derived
// and listed in RUN_DERIVED_KEYS, and the per-run keys are immutable once a run
// has finished, which is why they are not.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@ui";
import { Camera, ImageOff } from "lucide-react";

import { api } from "../lib/api";
import { formatDuration } from "../theme";
import { runsForTest } from "../lib/run-summary";
import { RUN_BROWSER_LABELS, type RunRecord } from "../lib/recorder-types";

/** Rows shown before deferring to Stats — the tab is a strip, not an archive. */
const ROW_CAP = 30;
/** Thumbnails shown before deferring to the Visual view. */
const SHOT_CAP = 8;

/** "just now" / "12m ago" / "3h ago" / "2d ago", then the date. Relative up
 *  close because "which run was that" is asked about recent ones; absolute past
 *  a week, where "37d ago" would hand the reader the calendar math. */
export function whenLabel(ts: number, now: number): string {
  const mins = Math.round((now - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** One run, one line. The amber chips carry the same caveats the run panel's
 *  verdict chip does — a healed or retried pass is worth less than it looks —
 *  so a row is never just "PASS" when the record knows better. */
function RunRow({ run, now }: { run: RunRecord; now: number }) {
  const ok = run.status === "passed";
  return (
    <div
      className="flex items-center gap-2 border-b border-separator px-3 py-1 last:border-b-0"
      data-gl="history-run"
      data-status={run.status}
    >
      <span className={`w-9 shrink-0 font-semibold ${ok ? "text-support-green" : "text-support-red"}`}>
        {ok ? "PASS" : "FAIL"}
      </span>
      <span className="w-16 shrink-0 text-tertiary" title={new Date(run.startedAt).toLocaleString()}>
        {whenLabel(run.startedAt, now)}
      </span>
      <span className="w-14 shrink-0 text-secondary">{formatDuration(run.durationMs)}</span>
      <span className="w-16 shrink-0 truncate text-tertiary">
        {RUN_BROWSER_LABELS[run.runBrowser ?? "chromium"]}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {(run.healedSteps ?? 0) > 0 ? (
          <span className="gl-chip" title="Auto-Heal substituted a locator to get this run past a step — review it on the Heals tab">
            healed {run.healedSteps}
          </span>
        ) : null}
        {run.passedOnRetry || (run.attempt ?? 0) > 0 ? (
          <span className="gl-chip" title="This run failed and passed on a retry — a pass that counts, and a flake signal that also counts">
            retry
          </span>
        ) : null}
        {(run.a11yNewSteps ?? 0) > 0 ? (
          <span className="gl-chip" title="Steps with unaccepted accessibility violations on this run">
            a11y {run.a11yNewSteps}
          </span>
        ) : null}
        {(run.shotCount ?? 0) > 0 ? (
          <span className="gl-chip inline-flex items-center gap-1" title="Screenshots captured on this run">
            <Camera className="size-3" aria-hidden="true" />
            {run.shotCount}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** One frame, read on demand. Its own component because each file is its own
 *  query, and a hook cannot sit inside the strip's map. */
function ShotThumb({
  testId,
  runId,
  file,
  label,
  onOpen,
}: {
  testId: string;
  runId: string;
  file: string;
  label: string;
  onOpen?: () => void;
}) {
  const shotQuery = useQuery({
    queryKey: ["shot", testId, runId, file],
    queryFn: () => api.artifacts.readShot(testId, runId, file),
    staleTime: 5 * 60 * 1000,
  });
  const frame = shotQuery.data ? (
    <img src={shotQuery.data} alt={label} className="h-full w-auto object-contain" />
  ) : (
    <span className="block h-full w-28" aria-hidden="true" />
  );
  return (
    <figure className="flex h-full min-h-0 shrink-0 flex-col gap-1">
      {onOpen ? (
        <button
          type="button"
          className="min-h-0 flex-1 cursor-pointer overflow-hidden rounded border border-separator bg-black"
          onClick={onOpen}
          title="Open the Visual view"
        >
          {frame}
        </button>
      ) : (
        <span className="min-h-0 flex-1 overflow-hidden rounded border border-separator bg-black">
          {frame}
        </span>
      )}
      <figcaption className="max-w-40 truncate text-[10px] text-tertiary" title={label}>
        {label}
      </figcaption>
    </figure>
  );
}

export function RunHistoryPanel({
  testId,
  runs,
  onOpenVisual,
}: {
  /** Absent only in fixtures with no test behind them; without it the pictures
   *  half has nothing to query and reports its empty state. */
  testId?: string;
  /** Every recorded run, unfiltered — `runsForTest` owns the filtering rules
   *  (this test, real runs only, no baseline-update bookkeeping rows). */
  runs: RunRecord[];
  /** Opens the Visual view, where the frames can actually be compared. */
  onOpenVisual?: () => void;
}) {
  const now = Date.now();
  const history = React.useMemo(
    () => (testId ? runsForTest(runs, testId).reverse() : []),
    [runs, testId],
  );

  // The most recent captured run, from the replay index rather than from run
  // history: retention can prune the JSON history while the replay is still on
  // disk, and the index is what says a replay actually exists to read.
  const replaysQuery = useQuery({
    queryKey: ["replays"],
    queryFn: api.artifacts.list,
    enabled: Boolean(testId),
  });
  const latestReplay = React.useMemo(() => {
    const mine = (replaysQuery.data ?? []).filter((r) => r.testId === testId);
    return mine.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  }, [replaysQuery.data, testId]);
  const replayQuery = useQuery({
    queryKey: ["replay", latestReplay?.testId, latestReplay?.runId],
    queryFn: () => api.artifacts.getReplay(latestReplay!.testId, latestReplay!.runId),
    enabled: Boolean(latestReplay),
  });
  const shots = React.useMemo(
    () => (replayQuery.data?.steps ?? []).filter((s) => s.screenshot),
    [replayQuery.data],
  );
  const shown = shots.slice(0, SHOT_CAP);

  if (history.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
        <span className="text-[12px] text-secondary">No runs recorded yet</span>
        <span className="text-[11px] text-tertiary">
          Run the test and every execution lands here, newest first.
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <ScrollArea className="min-h-0 flex-1">
        <div className="font-mono text-[11px] leading-relaxed">
          {history.slice(0, ROW_CAP).map((run) => (
            <RunRow key={run.id} run={run} now={now} />
          ))}
          {history.length > ROW_CAP ? (
            <div className="px-3 py-1.5 text-tertiary">
              …and {history.length - ROW_CAP} older — the Stats view lists them all.
            </div>
          ) : null}
        </div>
      </ScrollArea>
      <div className="flex w-[38%] min-w-72 max-w-xl shrink-0 flex-col border-l border-separator">
        <div className="gl-run-console-bar">
          <span className="min-w-0 truncate text-[11px] text-secondary">
            {latestReplay
              ? `Recent screenshots · ${whenLabel(latestReplay.startedAt, now)}`
              : "Recent screenshots"}
          </span>
          {onOpenVisual && shots.length > 0 ? (
            <button
              type="button"
              className="ml-auto shrink-0 cursor-pointer text-[11px] text-accent hover:underline"
              onClick={onOpenVisual}
            >
              Visual view →
            </button>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
            <ImageOff className="size-4 text-tertiary" aria-hidden="true" />
            <span className="text-[11px] text-tertiary">
              No screenshots yet — turn on “Capture screenshots” and run the test.
            </span>
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1" scrollbars="horizontal">
            <div className="flex h-full items-center gap-2 px-3 py-2">
              {shown.map((s) => (
                <ShotThumb
                  key={s.stepId}
                  testId={latestReplay!.testId}
                  runId={latestReplay!.runId}
                  file={s.screenshot!}
                  label={`Step ${s.index + 1} · ${s.label}`}
                  onOpen={onOpenVisual}
                />
              ))}
              {shots.length > shown.length ? (
                <span className="shrink-0 text-[11px] text-tertiary">
                  +{shots.length - shown.length} more in the Visual view
                </span>
              ) : null}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
