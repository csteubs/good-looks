// Experiments — behaviour that is still being decided.
//
// SPLIT OUT OF THE AI PANE IN B4. Both of these flags change how a RUN behaves:
// one decides whether a job survives a re-run, the other lets a suggestion be
// applied to a script without anyone looking at it. A user asking "why did my
// script change?" or "why is this job still going?" has no reason to open a
// pane about which model answers questions, so the two settings that can
// explain it were unreachable in practice.
//
// The other half of the reason is what "Experimental" was doing as a SECTION.
// A titled section inside a pane is a subheading; a user scanning the sidebar
// never sees it, so the warning only reached someone already reading the AI
// pane top to bottom. As a pane it is in the list, and its subtitle carries the
// caveat for everything inside it — which is also what makes it the right place
// for the next flag of this kind, instead of Diagnostics.
//
// Both rows are `risk`: what they cost is unconditional, not a detail behind a
// disclosure. See `setting-row.tsx`.

import { Switch } from "@ui";

import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

export function ExperimentsPane() {
  const { settings, save } = useSettingsController();

  return (
    <PaneSection>
      <SettingRow
        id="keep-running-ai-debug-jobs"
        label="Keep a running AI debug job when a test is re-run"
        summary="A job that is still working survives the re-run instead of being cancelled."
        risk="A surviving job describes the previous run, not the one on screen."
        details="Re-running a test normally clears its AI debug session, so each run starts from a blank slate. With this on, a surviving job is reachable from the AI debug chip and marked as belonging to the previous run. Finished answers are still cleared either way. Useful with a slow local model, at the cost of a session on screen that describes output you can no longer see."
      >
        <Switch
          id="keep-running-ai-debug-jobs"
          checked={settings.keepRunningAiDebugJobs ?? false}
          onCheckedChange={(checked) => void save({ keepRunningAiDebugJobs: checked })}
        />
      </SettingRow>

      <SettingRow
        id="auto-accept-ai-debug-fixes"
        label="Apply AI debug fixes automatically"
        summary="A run-debug job that finishes while minimized applies its corrected script on its own."
        risk="Your script can change without you reading the change first."
        details="Guarded three ways: only while the job's dialog is minimized, only when the model produced a complete corrected script, and only when the script is byte-identical to the one the prompt was built from — an edit made while the AI was thinking always wins, and the suggestion falls back to a review toast instead of applying over it. Applied fixes are highlighted in the step list, exactly as a manual Apply would be."
      >
        <Switch
          id="auto-accept-ai-debug-fixes"
          checked={settings.autoAcceptAiDebugFixes ?? false}
          onCheckedChange={(checked) => void save({ autoAcceptAiDebugFixes: checked })}
        />
      </SettingRow>
    </PaneSection>
  );
}
