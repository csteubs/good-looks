// Starting values for new tests.
//
// The pane the whole redesign is built around. A third of the window's
// settings answer the same question — "what should a NEW test do, before
// anyone touches its own controls" — and they map one-to-one onto the six run
// controls in `test-detail-view.tsx`. Scattered through a flat list, each row
// had to re-explain that relationship in its own prose ("Each test remembers
// its own choice", "each test has its own toggle", "Each test can still be
// overridden from its sidebar menu"). Collected here, the pane subtitle says it
// once and every row gets shorter.
//
// The order deliberately matches the test detail toolbar's, so the two read as
// the same panel at two scopes.

import {
  Input,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@ui";

import { BROWSER_SF_SYMBOLS } from "../../lib/browser-icons";
import type { RunBrowser, TestSpeed } from "../../lib/recorder-types";
import {
  RUN_BROWSERS,
  RUN_BROWSER_LABELS,
  TEST_SPEEDS,
  TEST_SPEED_LABELS,
} from "../../lib/recorder-types";
import {
  BATCH_CONCURRENCY_CHOICES,
  batchConcurrencyLabel,
  choiceFromSetting,
  settingFromChoice,
} from "../../lib/batch-parallel";
import { clampTestTimeoutSec } from "../../lib/settings-schema";
import { useSettingsController } from "../settings-controller";
import { SettingRow, useRowVisible } from "../setting-row";
import { PaneSection } from "../pane-section";

export function TestDefaultsPane() {
  const { settings, save } = useSettingsController();
  const recordLogs = settings.defaultRecordLogs ?? false;
  // The nested header row must know whether its child survived the search, or
  // it draws a dependency rule pointing at a row that isn't there.
  const headersRowVisible = useRowVisible("record-all-headers");

  return (
    <>
      <PaneSection title="Running">
        <SettingRow
          id="default-run-speed"
          label="Run speed"
          summary="Adds a delay between actions so runs are watchable. Slow by default."
          details="Crawl goes further and waits for the page to finish loading after every step, which is slower but steadier on pages that load in stages."
        >
          <SegmentedControl
            id="default-run-speed"
            value={settings.defaultRunSpeed ?? "slow"}
            onValueChange={(value) => void save({ defaultRunSpeed: value as TestSpeed })}
            variant="filled"
            size="small"
          >
            {TEST_SPEEDS.map((s) => (
              <SegmentedControlItem key={s} value={s}>
                {TEST_SPEED_LABELS[s]}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </SettingRow>

        <SettingRow
          id="default-run-browser"
          label="Browser"
          summary="Which browser engine test runs use. Each engine downloads once, on its first run."
          details="Only affects test runs — the trainer always records in the app's own browser."
        >
          <Select
            value={settings.defaultRunBrowser ?? "chromium"}
            onValueChange={(v) => void save({ defaultRunBrowser: v as RunBrowser })}
          >
            <SelectTrigger id="default-run-browser" className="w-36">
              {/* SelectValue draws the selected item's SF Symbol already;
                  a lucide glyph here would double it. */}
              <SelectValue placeholder="Chromium" />
            </SelectTrigger>
            <SelectContent>
              {RUN_BROWSERS.map((b) => (
                <SelectItem key={b} value={b} icon={BROWSER_SF_SYMBOLS[b]}>
                  {RUN_BROWSER_LABELS[b]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          id="default-run-headless"
          label="Run tests in headless mode"
          summary="Runs tests without opening a visible browser window."
          details="Only affects test runs — the trainer always opens a visible browser."
        >
          <Switch
            id="default-run-headless"
            checked={settings.defaultRunHeadless ?? false}
            onCheckedChange={(checked) => void save({ defaultRunHeadless: checked })}
          />
        </SettingRow>

        <SettingRow
          id="default-batch-headless"
          label="Run routines in headless mode"
          summary="A routine runs without opening browser windows, whatever a single run does."
          details="Separate from the setting above because the two cases differ: watching one run is usually the point of starting it, while sixty windows opening in turn — each taking focus as it launches — is not something a tick box should hand you. A row's own Headless toggle still overrides this."
        >
          <Switch
            id="default-batch-headless"
            checked={settings.defaultBatchHeadless ?? true}
            onCheckedChange={(checked) => void save({ defaultBatchHeadless: checked })}
          />
        </SettingRow>

        <SettingRow
          id="default-batch-concurrency"
          label="Tests at once"
          summary="How many tests a routine run starts in parallel. Off runs them one after another."
          details="Each parallel test is its own browser, so this trades CPU for wall-clock time. Run headed and the Routines view asks before opening more than 10 windows at once."
        >
          <Select
            value={String(choiceFromSetting(settings.defaultBatchConcurrency))}
            onValueChange={(v) =>
              void save({
                defaultBatchConcurrency: settingFromChoice(v === "all" ? "all" : Number(v)),
              })
            }
          >
            <SelectTrigger id="default-batch-concurrency" className="w-36">
              <SelectValue placeholder="Off" />
            </SelectTrigger>
            <SelectContent>
              {BATCH_CONCURRENCY_CHOICES.map((c) => (
                <SelectItem key={String(c)} value={String(c)}>
                  {batchConcurrencyLabel(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          id="default-test-timeout"
          label="Test timeout"
          summary="How long a single test may run before it fails."
          details="Playwright's built-in limit is 30 seconds — raise this for longer flows. 5 seconds to 30 minutes."
        >
          <div className="flex items-center gap-2">
            <Input
              id="default-test-timeout"
              type="number"
              min={5}
              max={1800}
              step={1}
              className="w-24"
              value={Math.round((settings.defaultTestTimeoutMs ?? 60_000) / 1000)}
              onChange={(e) =>
                void save({ defaultTestTimeoutMs: clampTestTimeoutSec(e.target.value) * 1000 })
              }
              aria-label="Default test timeout in seconds"
            />
            <span className="text-secondary text-sm">sec</span>
          </div>
        </SettingRow>
      </PaneSection>

      <PaneSection title="What a run records">
        <SettingRow
          id="default-capture-artifacts"
          label="Capture screenshots"
          summary="Records a screenshot per step, for the visual diff."
        >
          <Switch
            id="default-capture-artifacts"
            checked={settings.defaultCaptureArtifacts ?? false}
            onCheckedChange={(checked) => void save({ defaultCaptureArtifacts: checked })}
          />
        </SettingRow>

        <SettingRow
          id="default-record-logs"
          label="Record console &amp; network"
          summary="Stores the page's console output and request URLs with each run, so “Debug with AI” can offer them when the model asks."
          details="Off by default: it is page-controlled data kept on disk. Nothing is ever sent to a model without your explicit approval."
        >
          <Switch
            id="default-record-logs"
            checked={recordLogs}
            onCheckedChange={(checked) => void save({ defaultRecordLogs: checked })}
          />
        </SettingRow>

        {/* Unmounted rather than greyed when the parent is off. The old flat
            list left it on screen, disabled, with nothing saying why — a
            dead control the user cannot explain. */}
        {recordLogs && headersRowVisible ? (
          <SettingRow
            id="record-all-headers"
            label="Include all request headers"
            flag="stores credentials"
            nested
            summary="Turns off the safe allowlist. Stores Authorization, Cookie and anything else the page sends. By default only content type, caching and CORS headers are stored, and every other header is recorded by name with its value omitted."
          >
            <Switch
              id="record-all-headers"
              checked={settings.recordAllHeaders ?? false}
              onCheckedChange={(checked) => void save({ recordAllHeaders: checked })}
            />
          </SettingRow>
        ) : null}

        <SettingRow
          id="default-a11y"
          label="Check accessibility"
          summary="Runs axe against the page after each action and reports WCAG violations per step. It never fails a run."
          details="A third-party widget shouldn't be able to turn your suite red overnight. Off by default because the check usually costs more per step than everything else the step does."
        >
          <Switch
            id="default-a11y"
            checked={settings.defaultA11yChecks ?? false}
            onCheckedChange={(checked) => void save({ defaultA11yChecks: checked })}
          />
        </SettingRow>

        {/* Global rather than per test, unlike its three siblings: a domain's
            score is a rollup across every test that reaches it, and a
            per-test switch would make the series depend on which tests had
            it on. The rail's Site Health row shows only while this is on. */}
        <SettingRow
          id="site-health-checks"
          label="Check Site Health"
          summary="Scores every page a run loads for SEO and performance, grouped by domain in the Site Health view. A low score cannot fail a run."
          details="Applies to every test, including unattended runs from the CLI and CI. Off by default because it is one more read per action and one more file per run. Nothing leaves the machine: the readings are counts, lengths and timings taken in the page."
        >
          <Switch
            id="site-health-checks"
            checked={settings.siteHealthChecks ?? false}
            onCheckedChange={(checked) => void save({ siteHealthChecks: checked })}
          />
        </SettingRow>
      </PaneSection>
    </>
  );
}
