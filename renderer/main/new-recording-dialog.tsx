import * as React from "react";
import { Dialog, Field, Input, SegmentedControl, SegmentedControlItem } from "@glaze/core/components";

import { api } from "../lib/api";
import type { TestSpeed } from "../lib/recorder-types";
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
  const canStart = url.trim().length > 0;

  // Load the persisted default when the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    api.recorder
      .getSettings()
      .then((s) => setSpeed(s.defaultRunSpeed ?? "slow"))
      .catch(() => {
        /* keep default */
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

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New recording"
      description="Enter a site to record. It opens in a browser window, and every interaction becomes a test step."
      confirmLabel="Start recording"
      confirmDisabled={!canStart}
      onConfirm={async () => {
        await start(url.trim(), name.trim() || "Recorded test");
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
