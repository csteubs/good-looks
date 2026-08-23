// Settings → Inspections: one switch per rule the TypeScript service runs
// over a spec (shared/inspections.mjs). Off here means the editor stops
// marking it; the rule still exists, and a run is never affected either way.

import { Switch } from "@ui";

import { INSPECTIONS, type InspectionRule } from "../../../shared/inspections.mjs";
import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

const SEVERITY_LABEL = { error: "error", warning: "warning", hint: "hint" } as const;

export function InspectionsPane() {
  const { settings, save } = useSettingsController();
  const on: Partial<Record<InspectionRule, boolean>> = settings.inspections ?? {};
  return (
    <PaneSection>
      {INSPECTIONS.map((i) => (
        <SettingRow
          key={i.id}
          id={`inspection-${i.id}`}
          label={i.label}
          flag={`${SEVERITY_LABEL[i.severity]}${i.fixes ? " · quick fix" : ""}`}
          summary={i.summary}
        >
          <Switch
            id={`inspection-${i.id}`}
            checked={on[i.id] ?? true}
            onCheckedChange={(checked) => void save({ inspections: { ...on, [i.id]: checked } as Record<InspectionRule, boolean> })}
          />
        </SettingRow>
      ))}
    </PaneSection>
  );
}
