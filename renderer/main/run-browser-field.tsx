// "Which browser does this test run in?", asked at creation time.
//
// The engine was settable only from the test-detail toolbar, i.e. only AFTER
// the test existed — so every test was born on the global default and a user
// who wanted WebKit found that out on the first red run.
//
// ONE COMPONENT FOR THREE DIALOGS. Record, Generate and Import-from-URL each
// ask this, and three copies would mean three chances to seed it differently.
// It carries its own settings read for the same reason: the seeding rule (start
// on the global default, do not write back to it) is the part worth having in
// exactly one place.
//
// IT DOES NOT WRITE THE GLOBAL DEFAULT. The New Recording dialog's speed and
// window-size pickers do — a one-off choice for one recording silently
// retargets every future one — and `docs/plans/test-creation-and-charter.md`
// §2.1 names that as a defect rather than a pattern to copy.

import * as React from "react";

import { Segmented } from "../theme";
import { api } from "../lib/api";
import type { RunBrowser } from "../lib/recorder-types";
import { RUN_BROWSERS, RUN_BROWSER_LABELS } from "../lib/recorder-types";

const OPTIONS = RUN_BROWSERS.map((b) => ({ value: b, label: RUN_BROWSER_LABELS[b] }));

/**
 * The engine a creation dialog should start on, and what to store for it.
 *
 * `value` is what the control shows. `toStore` is what belongs on the created
 * record: the chosen engine when it DIFFERS from the global default, and
 * `undefined` when it does not.
 *
 * That asymmetry is the whole point, and it is the model's own rule rather than
 * a new one — `TestRecord.runBrowser` is documented as "when absent, the global
 * `defaultRunBrowser` applies". Pinning every new test to the engine that
 * happened to be the default at the moment it was created would quietly retire
 * the Settings default: changing it later would move nothing, because every
 * test would carry its own copy. Leaving the control alone keeps the test
 * inheriting; touching it pins that test and only that test.
 */
export function useRunBrowserChoice(open: boolean): {
  value: RunBrowser;
  toStore: RunBrowser | undefined;
  onChange: (next: RunBrowser) => void;
} {
  const [fallback, setFallback] = React.useState<RunBrowser>("chromium");
  const [value, setValue] = React.useState<RunBrowser>("chromium");

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.recorder
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        const next = s.defaultRunBrowser ?? "chromium";
        setFallback(next);
        // The control follows the default until the user touches it. Re-seeding
        // on every open is deliberate: a dialog that reopens on a stale choice
        // after the default changed in Settings is showing a lie.
        setValue(next);
      })
      .catch(() => {
        /* keep chromium — a failed settings read is not a reason to be unable
           to create a test, and chromium is what the backend falls back to. */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return {
    value,
    toStore: value === fallback ? undefined : value,
    onChange: setValue,
  };
}

export function RunBrowserField({
  value,
  onChange,
  hint,
}: {
  value: RunBrowser;
  onChange: (next: RunBrowser) => void;
  /** Overrides the caption. The git import sets one, because there the choice
   *  applies to every test in the repository rather than to one test. */
  hint?: string;
}): React.ReactElement {
  return (
    <div className="gl-create-field">
      <span className="gl-section-title">Browser</span>
      <Segmented options={OPTIONS} value={value} onChange={onChange} label="Browser" />
      <p className="gl-note">
        {hint ?? "The engine test runs use. The trainer always records in Chromium."}
      </p>
    </div>
  );
}
