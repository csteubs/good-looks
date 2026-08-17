// The run history behind the Stats screen: what is kept, and how to clear it.
//
// WHY THIS IS ITS OWN PANE AND NOT A SECTION OF STORAGE. Storage is about
// screenshots — how many runs' worth per test, how old before they go, and the
// live byte count they cost. This is about the run RECORDS: a different
// artifact, a different lifetime, and a different failure when you get it
// wrong. Screenshots going early costs you pictures; records going early costs
// you the history every number on the Stats screen is computed from.
//
// THE READOUT IS THE POINT OF THE PANE. "Total runs" on the Stats board read
// 1000 for as long as the index was capped at 1000 records, because the count
// WAS the length of that list. It is a real counter now, and this is the one
// screen that can say what it holds and what the app can still show you of it
// — the difference between "1240 runs happened" and "1000 of them are still
// on disk" is invisible everywhere else.
//
// The two destructive controls also exist in the Stats view's Manage-data
// native menu, and that is deliberate rather than an oversight. A native menu
// inside one view cannot be searched, so Settings could not answer "how do I
// clear my run history" at all — and Settings is where that question gets
// asked. Both call the same IPC handlers.

import { Button, NumberInput } from "@ui";

import { clampRunLogRetainedRuns } from "../../lib/settings-schema";
import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

/** Matches Storage's retention control width so the two panes' number fields
 *  sit on the same vertical line when you switch between them. */
const RETENTION_CONTROL_WIDTH = "w-32";

function fmtCount(n: number): string {
  return n.toLocaleString();
}

/**
 * What the history holds, stated as the two numbers that differ.
 *
 * Modelled on Storage's usage readout — same shape, same position, because it
 * answers the same shape of question. The second line is what nothing else in
 * the app says out loud: how much of that history still has records behind it.
 */
function HistoryReadout() {
  const { runTotals } = useSettingsController();

  return (
    <div className="border-separator bg-well flex items-center gap-4 rounded-lg border p-4">
      <div className="min-w-0 flex-1">
        <div className="text-2xl tabular-nums" data-testid="run-history-total">
          {runTotals ? fmtCount(runTotals.runs) : "—"}
        </div>
        <div className="text-secondary text-sm">
          {runTotals
            ? runTotals.pruned > 0
              ? `runs recorded · ${fmtCount(runTotals.retained)} still stored, ${fmtCount(
                  runTotals.pruned,
                )} counted but pruned`
              : `runs recorded, all still stored`
            : "Runs recorded"}
        </div>
      </div>
    </div>
  );
}

export function StatsPane() {
  const { settings, save, clearingRuns, resetRunStats, deleteRunStatsAndLogs } =
    useSettingsController();

  return (
    <>
      <HistoryReadout />

      {/* The log budget is the only DIAL here. How many records the history
          keeps is not a setting: it is bounded by what rewriting the file costs
          on every run, which is a number about this machine rather than a
          preference. The logs are the disk cost, and that is a preference. */}
      <PaneSection description="A run's record is a few hundred bytes and is kept for a long time — that is what every count on the Stats screen is drawn from. Its raw console log is tens of kilobytes, so the logs have their own limit. A run past it keeps its record and its result, and loses only the console output behind Run history's log viewer and log search.">
        <SettingRow
          id="run-log-retained-runs"
          label="Keep console logs for"
          summary="How many of the most recent runs keep their raw console output (0–50,000). Set it to 0 to keep none."
        >
          <NumberInput
            id="run-log-retained-runs"
            min={0}
            max={50_000}
            step={100}
            unit="runs"
            className={RETENTION_CONTROL_WIDTH}
            value={settings.runLogRetainedRuns ?? 1000}
            onValueChange={(v) => void save({ runLogRetainedRuns: clampRunLogRetainedRuns(v ?? "") })}
          />
        </SettingRow>
      </PaneSection>

      {/* Destructive, and separated from the dial above it by its own section
          so a mis-click cannot be confused for editing a number. Neither
          control is behind a confirm here — the Stats view's menu is the one
          that guards them with a dialog, and duplicating that dialog into a
          second window is a second copy of the same copy to keep true. */}
      <PaneSection description="Clearing the history resets every count on the Stats screen, including the total runs figure above — the app cannot recover a run it has forgotten. Screenshots are governed separately, in Storage.">
        <SettingRow
          id="reset-stats"
          label="Reset stats"
          summary="Clear every run record, keeping the raw logs on disk."
        >
          <Button variant="secondary" onClick={() => void resetRunStats()} disabled={clearingRuns}>
            {clearingRuns ? "Clearing…" : "Reset stats"}
          </Button>
        </SettingRow>
        <SettingRow
          id="delete-stats-and-logs"
          label="Delete stats and logs"
          summary="Clear every run record and delete every raw log file."
        >
          <Button
            variant="secondary"
            onClick={() => void deleteRunStatsAndLogs()}
            disabled={clearingRuns}
          >
            {clearingRuns ? "Deleting…" : "Delete everything"}
          </Button>
        </SettingRow>
      </PaneSection>
    </>
  );
}
