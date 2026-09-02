import * as React from "react";
import {
  Checkbox,
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
import { RunBrowserField, useRunBrowserChoice } from "./run-browser-field";

import { api } from "../lib/api";
import type { TestSpeed } from "../lib/recorder-types";
import { TEST_SPEEDS, TEST_SPEED_LABELS } from "../lib/recorder-types";
import {
  DEFAULT_VIEWPORT_PRESET_ID,
  VIEWPORT_PRESETS,
  presetIdForViewport,
  viewportForPresetId,
} from "../lib/viewport-presets";
import { startUrlHint } from "../lib/start-url-hint";
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
  // Whether the trainer clicks pop-ups away while this session records — the
  // taught overlay rules for the host and the built-in Klaviyo/DataGrail
  // handlers. Seeded from the global default and NOT persisted back to it: a
  // session that wants the newsletter form left alone (to record signing up to
  // it) is a decision about this recording, and a box that quietly rewrote the
  // default would switch handling off for every test after it.
  const [handlePopups, setHandlePopups] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const browser = useRunBrowserChoice(open);
  const canStart = url.trim().length > 0;
  // What the training browser will actually open. The backend has always
  // prepended the scheme; the field never said so, so `example.com` recorded
  // against an address the user was never shown (#134).
  const resolvedUrl = startUrlHint(url);

  // Load the persisted defaults when the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    api.recorder
      .getSettings()
      .then((s) => {
        setSpeed(s.defaultRunSpeed ?? "slow");
        setWindowSize(presetIdForViewport(s.defaultWindowSize ?? null));
        setHandlePopups(s.defaultHandlePopups ?? true);
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
            browser.toStore,
            handlePopups,
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
        {/* A `div` + `htmlFor`, not a wrapping `label`, because the note below
            is part of this field: inside the label it would join the input's
            ACCESSIBLE NAME ("URL Opens https://example.com") instead of
            describing it. `aria-describedby` is where a description goes. */}
        <div className="gl-create-field">
          <label className="gl-section-title" htmlFor="new-recording-url">
            URL
          </label>
          <input
            id="new-recording-url"
            className="gl-input"
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-describedby={resolvedUrl ? "new-recording-url-resolved" : undefined}
            autoFocus
          />
          {resolvedUrl ? (
            <p className="gl-note" id="new-recording-url-resolved">
              Opens {resolvedUrl}
            </p>
          ) : null}
        </div>

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

        <RunBrowserField value={browser.value} onChange={browser.onChange} />

        <div className="gl-create-field">
          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={handlePopups}
              onCheckedChange={(v) => setHandlePopups(v === true)}
              aria-label="Handle pop-ups while recording"
            />
            <span className="gl-section-title">Handle pop-ups while recording</span>
          </label>
          <p className="gl-note">
            Clicks away the pop-ups and banners this app knows how to close — the rules taught
            for this site, plus the built-in Klaviyo and DataGrail handlers — so they do not
            land in the recording. Untick it to record the pop-up itself.
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
