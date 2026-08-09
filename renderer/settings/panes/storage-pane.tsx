// How long captured screenshots stay on disk.
//
// The usage figure is the only LIVE number in the whole Settings window, and it
// used to be appended to the middle of a description string — "…never deleted.
// Currently using 1.4 MB across 12 runs." — where nobody looking for "how much
// space is this costing me" would ever find it. Here it is the first thing in
// the pane, and it is what the Clean up button reports against.

import { Button, NumberInput } from "@ui";

import { clampRetainedRuns, clampRetentionDays, formatBytes } from "../../lib/settings-schema";
import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

// Both retention controls share one width so their edges line up. "days" used
// to be a `<span>` OUTSIDE the input; because the row right-aligns its control,
// that span pushed the field left by its own width and the two inputs in this
// section sat on different vertical lines. `NumberInput`'s `unit` renders the
// suffix INSIDE the control, so the field is the whole control again and equal
// widths are enough to align them.
const RETENTION_CONTROL_WIDTH = "w-32";

function UsageReadout() {
  const { artifactUsage, pruning, pruneNow } = useSettingsController();

  return (
    <div className="border-separator bg-well flex items-center gap-4 rounded-lg border p-4">
      <div className="min-w-0 flex-1">
        <div className="text-2xl tabular-nums" data-testid="artifact-usage-bytes">
          {artifactUsage ? formatBytes(artifactUsage.bytes) : "—"}
        </div>
        <div className="text-secondary text-sm">
          {artifactUsage
            ? `across ${artifactUsage.runs} ${artifactUsage.runs === 1 ? "run" : "runs"} of ${
                artifactUsage.tests
              } ${artifactUsage.tests === 1 ? "test" : "tests"}`
            : "Screenshot storage"}
        </div>
      </div>
      <Button variant="secondary" onClick={() => void pruneNow()} disabled={pruning}>
        {pruning ? "Cleaning up…" : "Clean up now"}
      </Button>
    </div>
  );
}

export function StoragePane() {
  const { settings, save } = useSettingsController();

  return (
    <>
      <UsageReadout />

      <PaneSection description="A run's screenshots are kept only while they satisfy both rules. Pinned visual baselines are never deleted, and retention also runs when the app launches and after each test run.">
        <SettingRow
          id="artifact-retained-runs"
          label="Screenshot history per test"
          summary="How many runs' screenshots to keep for each test before the oldest are deleted (1–50)."
        >
          <NumberInput
            id="artifact-retained-runs"
            min={1}
            max={50}
            step={1}
            className={RETENTION_CONTROL_WIDTH}
            value={settings.artifactRetainedRuns ?? 10}
            onValueChange={(v) => void save({ artifactRetainedRuns: clampRetainedRuns(v ?? "") })}
          />
        </SettingRow>

        <SettingRow
          id="artifact-retention-days"
          label="Delete screenshots older than"
          summary="Days to keep captured screenshots, on top of the history limit. 0 disables the age rule."
        >
          <NumberInput
            id="artifact-retention-days"
            min={0}
            max={365}
            step={1}
            unit="days"
            className={RETENTION_CONTROL_WIDTH}
            value={settings.artifactRetentionDays ?? 0}
            onValueChange={(v) => void save({ artifactRetentionDays: clampRetentionDays(v ?? "") })}
          />
        </SettingRow>
      </PaneSection>
    </>
  );
}
