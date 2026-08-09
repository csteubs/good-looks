// What happens when a step's locator stops matching.
//
// Four rows, so it could have been folded into Test defaults. It isn't,
// because the two parameter rows are meaningless unless you have already
// decided the first two questions, and because "a wrong heal usually still
// succeeds" is a caveat that needs room to be read rather than a line competing
// with twenty other rows.
//
// The parameters unmount when Auto-Heal is off. They used to sit there
// editable, writing settings that nothing would read.

import { NumberInput, Switch } from "@ui";

import type { HealApplyMode } from "../../lib/recorder-types";
import { clampHealRetries, clampHealTimeoutMs } from "../../lib/settings-schema";
import { useSettingsController } from "../settings-controller";
import { SettingRow, useRowVisible } from "../setting-row";
import { PaneSection } from "../pane-section";

// Both parameter controls share one width so their edges line up. "ms" used to
// be a `<span>` OUTSIDE the input; because the row right-aligns its control,
// that span pushed the field left by its own width and the two inputs sat on
// different vertical lines. `NumberInput`'s `unit` renders the suffix INSIDE
// the control, so the field is the whole control again and equal widths are
// enough. Same fix as `storage-pane.tsx`; see DECISIONS 2026-08-07.
const PARAM_CONTROL_WIDTH = "w-32";

export function AutoHealPane() {
  const { settings, save } = useSettingsController();
  const enabled = settings.autoHealEnabled ?? true;
  const applyMode: HealApplyMode = settings.autoHealApply ?? "suggest";
  const retriesVisible = useRowVisible("auto-heal-retries");
  const timeoutVisible = useRowVisible("auto-heal-timeout");

  return (
    <PaneSection>
      <SettingRow
        id="auto-heal-enabled"
        label="Auto-Heal"
        summary="When a step's locator can't be found during replay, search the page for alternative targets."
        details="Uses all locator strategies plus context from past runs, matched against what the element looked like when the step was recorded. Applies during trainer replays and real runs. Every heal is recorded on the test's Heals tab, with a one-click way back."
      >
        <Switch
          id="auto-heal-enabled"
          checked={enabled}
          onCheckedChange={(checked) => void save({ autoHealEnabled: checked })}
        />
      </SettingRow>

      {enabled ? (
        <SettingRow
          id="auto-heal-apply"
          label="Apply heals automatically"
          nested
          summary="Off (recommended): a heal gets the step past its failure and is recorded on the Heals tab for you to apply or discard — your saved test is not changed. On: the new locator is written to the step straight away. Worth knowing first: a wrong heal usually still succeeds, because clicking the wrong button rarely raises an error."
        >
          <Switch
            id="auto-heal-apply"
            checked={applyMode === "apply"}
            onCheckedChange={(checked) =>
              void save({ autoHealApply: (checked ? "apply" : "suggest") as HealApplyMode })
            }
          />
        </SettingRow>
      ) : null}

      {enabled && retriesVisible ? (
        <SettingRow
          id="auto-heal-retries"
          label="Heal attempts"
          nested
          summary="How many times the engine retries finding candidates before giving up (1–10)."
        >
          <NumberInput
            id="auto-heal-retries"
            min={1}
            max={10}
            step={1}
            className={PARAM_CONTROL_WIDTH}
            value={settings.autoHealRetries ?? 3}
            onValueChange={(v) => void save({ autoHealRetries: clampHealRetries(v ?? "") })}
          />
        </SettingRow>
      ) : null}

      {enabled && timeoutVisible ? (
        <SettingRow
          id="auto-heal-timeout"
          label="Per-attempt timeout"
          nested
          summary="How long to wait before a single heal attempt is considered timed out (1000–30000 ms)."
        >
          <NumberInput
            id="auto-heal-timeout"
            min={1000}
            max={30000}
            step={500}
            unit="ms"
            className={PARAM_CONTROL_WIDTH}
            value={settings.autoHealAttemptTimeoutMs ?? 4000}
            onValueChange={(v) =>
              void save({ autoHealAttemptTimeoutMs: clampHealTimeoutMs(v ?? "") })
            }
            // The unit is `aria-hidden` decoration, so the accessible name has
            // to say "milliseconds" itself — otherwise the label reads
            // "Per-attempt timeout" with no unit anywhere a screen reader sees.
            aria-label="Per-attempt timeout in milliseconds"
          />
        </SettingRow>
      ) : null}
    </PaneSection>
  );
}
