import * as React from "react";
import {
  Dialog,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui";

// B10. `Select` stays — it is native-menu-backed, so the OS draws the menu and
// the redesign draws only the box. Everything else here is the theme's own
// vocabulary: there is no themed dialog PRIMITIVE (the SDK `Dialog` is
// allow-listed for its focus trap), so what gets themed is the content.
import { Segmented } from "../theme";

import { api } from "../lib/api";
import type { TestSpeed } from "../lib/recorder-types";
import { TEST_SPEEDS, TEST_SPEED_LABELS } from "../lib/recorder-types";
import {
  DEFAULT_VIEWPORT_PRESET_ID,
  VIEWPORT_PRESETS,
  presetIdForViewport,
  viewportForPresetId,
} from "../lib/viewport-presets";
import { useRecorder } from "./recorder-store";


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
  const [error, setError] = React.useState<string | null>(null);
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

  const handleSpeedChange = (next: TestSpeed) => {
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
        setError(null);
        try {
          await start(
            url.trim(),
            name.trim() || "Recorded test",
            undefined,
            viewportForPresetId(windowSize),
          );
        } catch (err) {
          // A start that failed leaves the dialog up with the reason on it, the
          // same shape as the git import. Before this the rejection escaped
          // `void onConfirm()` unhandled and the dialog just sat there saying
          // nothing, which reads as a dead button.
          setError(err instanceof Error ? err.message : String(err));
          return;
        }
        setUrl("");
        setName("");
        // The composed `Dialog` never closes itself on a resolved confirm —
        // callers close themselves (see `dialog-actions.test.tsx`). This one is
        // mounted by the library rail and the ⌘K palette, both OUTSIDE the
        // outlet RootShell swaps while recording, so without this the dialog
        // and its full-viewport overlay sit over the app for the whole session.
        onOpenChange(false);
      }}
    >
      <div className="gl-create">
        <label className="gl-create-field">
          <span className="gl-section-title">URL</span>
          <input
            className="gl-input"
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
          />
        </label>

        <label className="gl-create-field">
          <span className="gl-section-title">Test name</span>
          <input
            className="gl-input"
            placeholder="My test"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="gl-create-field">
          <span className="gl-section-title" id="new-recording-size">
            Window size
          </span>
          <Select value={windowSize} onValueChange={handleWindowSizeChange}>
            <SelectTrigger size="small" aria-labelledby="new-recording-size">
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
          <p className="gl-note">
            Size of the browser window this records in. The test replays at this size too.
          </p>
        </div>

        <div className="gl-create-field">
          <span className="gl-section-title">Run speed</span>
          <Segmented
            options={TEST_SPEEDS.map((s) => ({ value: s, label: TEST_SPEED_LABELS[s] }))}
            value={speed}
            onChange={handleSpeedChange}
            label="Run speed"
          />
        </div>

        {error ? <p className="gl-note gl-create-error">{error}</p> : null}
      </div>
    </Dialog>
  );
}
