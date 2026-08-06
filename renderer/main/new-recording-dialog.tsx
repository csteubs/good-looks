import * as React from "react";
import {
  Dialog,
  Field,
  Input,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@glaze/core/components";

import { api } from "../lib/api";
import type { TestSpeed } from "../lib/recorder-types";
import {
  DEFAULT_VIEWPORT_PRESET_ID,
  VIEWPORT_PRESETS,
  presetIdForViewport,
  viewportForPresetId,
} from "../lib/viewport-presets";
import { useRecorder } from "./recorder-store";

const SPEEDS: TestSpeed[] = ["slow", "medium", "fast"];
const SPEED_LABEL: Record<TestSpeed, string> = { slow: "Slow", medium: "Medium", fast: "Fast" };

export function NewRecordingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { start } = useRecorder();
  const [url, setUrl] = React.useState("");
  const [name, setName] = React.useState("");
  // Run speed is a persisted trainer preference (slow by default) so the
  // dialog remembers the last choice and Settings reflects it. New recordings
  // inherit this speed; the sidebar "Adjust Test Speed" menu still overrides
  // per-test.
  const [speed, setSpeed] = React.useState<TestSpeed>("slow");
  // Window size is persisted the same way. It sizes the training window AND is
  // recorded as the test's first viewport step, so the test replays at the size
  // it was recorded at instead of the runner's own default.
  const [windowSize, setWindowSize] = React.useState<string>(DEFAULT_VIEWPORT_PRESET_ID);
  const canStart = url.trim().length > 0;

  // Load the persisted defaults when the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    api.recorder
      .getSettings()
      .then((s) => {
        setSpeed(s.defaultRunSpeed ?? "slow");
        setWindowSize(presetIdForViewport(s.defaultWindowSize ?? null));
      })
      .catch(() => {
        /* keep defaults */
      });
  }, [open]);

  const handleSpeedChange = (v: string) => {
    const next = v as TestSpeed;
    setSpeed(next);
    // Persist so Settings stays in sync and the next recording remembers it.
    void api.recorder.setSettings({ defaultRunSpeed: next }).catch(() => {
      /* non-fatal — the in-memory choice still applies for this recording */
    });
  };

  const handleWindowSizeChange = (v: string) => {
    setWindowSize(v);
    void api.recorder.setSettings({ defaultWindowSize: viewportForPresetId(v) }).catch(() => {
      /* non-fatal — the in-memory choice still applies for this recording */
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New recording"
      description="Enter a site to record. It opens in a browser window, and every interaction becomes a test step."
      confirmLabel="Start recording"
      confirmDisabled={!canStart}
      onConfirm={async () => {
        await start(
          url.trim(),
          name.trim() || "Recorded test",
          undefined,
          viewportForPresetId(windowSize),
        );
        setUrl("");
        setName("");
      }}
    >
      <div className="flex flex-col gap-3">
        <Field label="URL" orientation="vertical">
          <Input
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Test name" orientation="vertical">
          <Input placeholder="My test" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Window size"
          orientation="vertical"
          description="Size of the browser window this records in. The test replays at this size too."
        >
          <Select value={windowSize} onValueChange={handleWindowSizeChange}>
            <SelectTrigger size="small">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VIEWPORT_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Run speed" orientation="vertical">
          <SegmentedControl
            value={speed}
            onValueChange={handleSpeedChange}
            variant="filled"
            size="small"
          >
            {SPEEDS.map((s) => (
              <SegmentedControlItem key={s} value={s}>
                {SPEED_LABEL[s]}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Field>
      </div>
    </Dialog>
  );
}
