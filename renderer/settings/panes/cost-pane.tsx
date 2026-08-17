// What a CI minute costs, and what one manual test run costs in time.
//
// THESE TWO NUMBERS USED TO LIVE ON THE COST PANEL ITSELF, edited in place and
// thrown away on reload, and the reasoning was good: "a number nobody can check
// is a number nobody believes", so the assumptions belonged under the figures
// they produce rather than in a window you have to go looking for. What that
// argument missed is that an assumption you have to retype on every visit is
// one nobody sets twice — so in practice the panel was read at the shipped
// guess, which is the outcome the whole design was trying to avoid.
//
// So the numbers persist, and they live here. The panel still states them, in
// prose, directly under the figures — the checkability the old design was
// protecting is intact — but the value is now a decision the user makes once.
//
// THE RUNNER DROPDOWN IS A PRE-FILL, NOT A SETTING. It writes `costPerCiMinute`
// and stores nothing of its own; what it displays is derived back out of that
// number by `runnerForRate`. Storing the runner beside the price would create
// the one failure this control exists to prevent — a pane reading "Linux
// 2-core" over a price that is nothing of the sort, because one of the two was
// written and the other was not.

import { NumberInput, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui";

import {
  CI_RUNNER_PRESETS,
  clampCostPerCiMinute,
  clampHourlyRate,
  clampMinutesPerManualDebug,
  clampMinutesPerManualRun,
  COST_CURRENCIES,
  COST_DEFAULT_HOURLY_RATE,
  COST_DEFAULT_MINUTES_PER_MANUAL_DEBUG,
  COST_DEFAULT_MINUTES_PER_MANUAL_RUN,
  COST_DEFAULT_PER_CI_MINUTE,
  currencySymbol,
  DEFAULT_COST_CURRENCY,
  rateForRunner,
  runnerForRate,
} from "../../../shared/cost-units.mjs";
import type { CostCurrency } from "../../lib/recorder-types";
import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

// Both numeric fields share one width so their edges line up, the same way the
// two retention fields in `storage-pane.tsx` do. The unit renders INSIDE the
// control (NumberInput's `unit`), so the field is the whole control and equal
// widths are enough.
const COST_CONTROL_WIDTH = "w-36";

export function CostPane() {
  const { settings, save } = useSettingsController();

  const currency = (settings.costCurrency ?? DEFAULT_COST_CURRENCY) as CostCurrency;
  const perCiMinute = settings.costPerCiMinute ?? COST_DEFAULT_PER_CI_MINUTE;
  const minutesPerManualRun =
    settings.costMinutesPerManualRun ?? COST_DEFAULT_MINUTES_PER_MANUAL_RUN;
  const minutesPerManualDebug =
    settings.costMinutesPerManualDebug ?? COST_DEFAULT_MINUTES_PER_MANUAL_DEBUG;
  // `?? default` and not `|| default` — 0 is the whole point of this setting
  // ("no rate stated"), and `||` would replace it with the default on every
  // read, which is the one value it must be able to hold.
  const hourlyRate = settings.costHourlyRate ?? COST_DEFAULT_HOURLY_RATE;
  const symbol = currencySymbol(currency);

  return (
    <>
      <PaneSection
        title="Money"
        description="Stats → Cost multiplies these by your run history. Nothing here changes how a test runs; it changes what the app claims your suite costs and buys."
      >
        <SettingRow
          id="cost-currency"
          label="Currency"
          summary="The symbol on every money figure in Stats → Cost."
          details="No conversion happens — this is a label, not an exchange rate. Pick “No symbol” to go back to bare numbers, which is what the app showed before it was ever told a currency."
        >
          <Select
            value={currency}
            onValueChange={(v) => void save({ costCurrency: v as CostCurrency })}
          >
            <SelectTrigger id="cost-currency" className={COST_CONTROL_WIDTH}>
              <SelectValue placeholder="US dollar ($)" />
            </SelectTrigger>
            <SelectContent>
              {COST_CURRENCIES.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          id="cost-ci-runner"
          label="CI runner"
          summary="Fills in the price below with GitHub's published rate for that runner."
          details="These are GitHub-hosted standard runner rates in US dollars, copied by hand on 2026-08-12. The app does not track them, so check them against your own bill. Choosing a runner only sets the price — nothing else in the app changes, and typing a price of your own puts this back to Custom."
        >
          <Select
            value={runnerForRate(perCiMinute)}
            onValueChange={(v) => {
              const rate = rateForRunner(v);
              // "Custom" is the DERIVED value, never a choice that writes
              // anything: it is what an off-list price reports as. Selecting it
              // deliberately does nothing rather than resetting the price the
              // user typed, which is the reason this branch exists.
              if (rate === null) return;
              void save({ costPerCiMinute: rate });
            }}
          >
            <SelectTrigger id="cost-ci-runner" className="w-64">
              <SelectValue placeholder="Custom" />
            </SelectTrigger>
            <SelectContent>
              {CI_RUNNER_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.rate === null ? p.label : `${p.label} — $${p.rate.toFixed(3)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          id="cost-per-ci-minute"
          label="Price per CI minute"
          summary="What one minute of CI costs you. 0 is a real answer if you run on your own hardware."
        >
          <NumberInput
            id="cost-per-ci-minute"
            min={0}
            max={100}
            step={0.001}
            unit={symbol || undefined}
            className={COST_CONTROL_WIDTH}
            value={perCiMinute}
            // `clampCostPerCiMinute` takes `unknown` and falls back on anything
            // non-finite, so the `null` NumberInput reports for an empty field
            // needs no coalescing here — and a typed 0 survives, which the
            // `Number(raw) || fallback` clamps in settings-schema would not.
            onValueChange={(v) => void save({ costPerCiMinute: clampCostPerCiMinute(v) })}
          />
        </SettingRow>
      </PaneSection>

      <PaneSection
        title="Time"
        description="The other half of the sum: what the suite saved by running instead of someone clicking through it, and what the model saved by diagnosing instead of you."
      >
        <SettingRow
          id="cost-minutes-per-manual-run"
          label="Minutes to run one test by hand"
          summary="How long a person would take to click through one test. Only passed runs count — a failed run verified nothing."
          details="Twelve is a working figure for a multi-step flow with waits in it. A smoke test is faster and a checkout is slower, which is exactly why this is a number you can set rather than one the app insists on."
        >
          <NumberInput
            id="cost-minutes-per-manual-run"
            min={0.5}
            max={480}
            step={0.5}
            unit="min"
            className={COST_CONTROL_WIDTH}
            value={minutesPerManualRun}
            onValueChange={(v) =>
              void save({ costMinutesPerManualRun: clampMinutesPerManualRun(v) })
            }
          />
        </SettingRow>

        <SettingRow
          id="cost-minutes-per-manual-debug"
          label="Minutes to debug one failure by hand"
          summary="How long you would spend working out why a test failed, without the model. Behind the savings figure in Stats → AI Debug."
          details="Only diagnoses you KEPT count — a fix you reverted saved nothing — and the time spent waiting on the model is subtracted, so the figure is a net saving. Fifteen minutes is deliberately unflattering: a failure you already understand costs two minutes, and one you don't can cost an afternoon."
        >
          <NumberInput
            id="cost-minutes-per-manual-debug"
            min={1}
            max={480}
            step={1}
            unit="min"
            className={COST_CONTROL_WIDTH}
            value={minutesPerManualDebug}
            onValueChange={(v) =>
              void save({ costMinutesPerManualDebug: clampMinutesPerManualDebug(v) })
            }
          />
        </SettingRow>

        {/* THE ONE NUMBER THIS APP REFUSED TO GUESS, now askable.
            `cost-model.ts` states the rule and it has not changed: an hourly
            rate varies by an order of magnitude between users, nobody would
            notice a bad default, and a currency figure carries far more
            authority than the guess behind it deserves. So the default is 0,
            0 means "not stated", and every money figure derived from saved
            time stays hidden until a user puts their own number here. What
            they then read is a multiplication they can check. */}
        <SettingRow
          id="cost-hourly-rate"
          label="Value of an hour of your time"
          summary="Optional. Leave at 0 and saved time is reported only as time — which is what the app does on its own."
          details="The app ships no default for this on purpose: the right figure varies by an order of magnitude between users, and a dollar amount reads as more authoritative than the guess behind it. Set it and Stats also states saved time in money; leave it and nothing is hidden from you, it is just reported in hours."
        >
          <NumberInput
            id="cost-hourly-rate"
            min={0}
            max={10000}
            step={1}
            unit={symbol || undefined}
            className={COST_CONTROL_WIDTH}
            value={hourlyRate}
            onValueChange={(v) => void save({ costHourlyRate: clampHourlyRate(v) })}
          />
        </SettingRow>
      </PaneSection>
    </>
  );
}
