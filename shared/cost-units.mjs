// The units the Cost panel's money is denominated in, and the published prices
// a user can pick instead of guessing.
//
// IN shared/ BECAUSE THREE PLACES NEED THE SAME LISTS. The Settings pane offers
// them, the Cost panel formats with them, and the main-process settings store
// has to VALIDATE against them — a currency id arriving from a hand-edited JSON
// file is untrusted the same way anything else read off disk is. Transcribing
// the table into the store would be right the day it was written and silently
// divergent after the first currency is added.
//
// Pure, like everything here: no fs, no shell import, no process.

/**
 * The currencies the app will stamp on a money figure.
 *
 * `none` IS A REAL OPTION AND IS NOT AN OVERSIGHT. Until this feature the panel
 * printed bare numbers on purpose — the rate is whatever the user typed, in
 * whatever currency they think in, and the app was never told which. Picking a
 * currency is now how the app is told; `none` is how a user whose currency
 * isn't listed goes back to a number that claims nothing it can't support.
 *
 * The symbol is all that is stored per entry. No locale, no minor-unit table:
 * every figure here is rendered to two decimals regardless, because the input
 * is a rate the user typed and the output's precision is bounded by that guess,
 * not by the currency's smallest coin.
 *
 * CAD AND AUD TAKE `CA$` AND `A$` RATHER THAN A BARE `$`. Three entries here
 * are dollars, the app never converts between them, and a panel that renders
 * all three identically would let someone read a US figure as a Canadian one
 * with nothing on screen to catch it. The picker's labels disambiguate; the
 * figures have to as well, because the figures are what gets screenshotted.
 */
export const COST_CURRENCIES = [
  { id: "usd", symbol: "$", label: "US dollar ($)" },
  { id: "eur", symbol: "€", label: "Euro (€)" },
  { id: "gbp", symbol: "£", label: "Pound sterling (£)" },
  { id: "jpy", symbol: "¥", label: "Japanese yen (¥)" },
  { id: "cad", symbol: "CA$", label: "Canadian dollar (CA$)" },
  { id: "aud", symbol: "A$", label: "Australian dollar (A$)" },
  { id: "none", symbol: "", label: "No symbol" },
];

/** The shipped currency. USD because the runner prices below are published in
 *  it — a panel that offered US dollar prices under a euro sign would be
 *  wrong in the one direction nobody would notice. */
export const DEFAULT_COST_CURRENCY = "usd";

/** True when `x` is one of the ids above. Used by the settings store on the way
 *  in, where the value has been through a JSON file. */
export function isCostCurrency(x) {
  return typeof x === "string" && COST_CURRENCIES.some((c) => c.id === x);
}

/** The symbol for a currency id, or "" for anything unrecognised — including
 *  `none`. Never throws: this runs inside a render. */
export function currencySymbol(id) {
  const found = COST_CURRENCIES.filter((c) => c.id === id)[0];
  return found ? found.symbol : "";
}

/**
 * GitHub's published per-minute rates for its standard hosted runners.
 *
 * WHY A LIST AND NOT ONE DEFAULT: the spread is 31× between the cheapest Linux
 * runner and macOS. A macOS-runner user reading a spend figure computed at the
 * Linux rate is being shown a number that is wrong by an order of magnitude,
 * and no amount of "this is an assumption" copy fixes a default nobody can
 * check against the invoice they actually get.
 *
 * `custom` is first and carries no rate: it is what the app's own shipped guess
 * (0.008) resolves to, and what anything typed by hand resolves to. Selecting
 * it deliberately does nothing — see `runnerForRate`.
 *
 * These are rates PUBLISHED BY GITHUB and copied here on 2026-08-12. They are
 * not tracked automatically and this app cannot know when they change, which is
 * the other reason the price stays hand-editable.
 */
export const CI_RUNNER_PRESETS = [
  {
    id: "custom",
    rate: null,
    label: "Custom",
    consequence: "Whatever price you type below.",
  },
  {
    id: "linux-1-x64",
    rate: 0.002,
    label: "Linux 1-core (x64)",
    consequence: "$0.002 per minute — GitHub's cheapest hosted runner.",
  },
  {
    id: "linux-2-arm64",
    rate: 0.005,
    label: "Linux 2-core (arm64)",
    consequence: "$0.005 per minute.",
  },
  {
    id: "linux-2-x64",
    rate: 0.006,
    label: "Linux 2-core (x64)",
    consequence: "$0.006 per minute — the common default for a CI job.",
  },
  {
    id: "windows-2",
    rate: 0.01,
    label: "Windows 2-core (x64 / arm64)",
    consequence: "$0.010 per minute.",
  },
  {
    id: "macos-3-4",
    rate: 0.062,
    label: "macOS 3-core or 4-core (M1 / Intel)",
    consequence: "$0.062 per minute — 31× a Linux 1-core runner.",
  },
];

/**
 * Which preset a rate corresponds to, or `"custom"`.
 *
 * THE SELECTED RUNNER IS DERIVED FROM THE PRICE, NEVER STORED ALONGSIDE IT.
 * Storing both would create the one bug this dropdown exists to prevent: a
 * panel that says "Linux 2-core" over a price that is nothing of the sort,
 * because one of the two was written and the other wasn't. Every published rate
 * above is distinct, so the mapping is unambiguous in both directions.
 *
 * Compared with a tolerance rather than `===` because the rate makes a round
 * trip through a text input and a JSON file, and 0.006 is not exactly
 * representable — a strict compare would report a freshly-picked preset as
 * "Custom" on the next load.
 */
export function runnerForRate(rate) {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "custom";
  const hit = CI_RUNNER_PRESETS.filter(
    (p) => p.rate !== null && Math.abs(p.rate - rate) < 1e-9,
  )[0];
  return hit ? hit.id : "custom";
}

/** The rate a preset id stands for, or null for `custom` / anything unknown. */
export function rateForRunner(id) {
  const hit = CI_RUNNER_PRESETS.filter((p) => p.id === id)[0];
  return hit ? hit.rate : null;
}

/** Bounds for the two editable numbers.
 *
 *  NOT VALIDATION THEATRE. Both values arrive from a number input and from a
 *  JSON file on disk, and `Number("")` is 0 while `Number("abc")` is NaN —
 *  either would turn every figure on the panel into a confident "$0.00" or a
 *  "$NaN" rather than into a visible mistake. The floor on a manual run is half
 *  a minute because zero would claim the suite bought infinite time. */
export const COST_LIMITS = {
  costPerCiMinute: { min: 0, max: 100 },
  minutesPerManualRun: { min: 0.5, max: 480 },
  minutesPerManualDebug: { min: 1, max: 480 },
  hourlyRate: { min: 0, max: 10000 },
};

/** The shipped guesses. Deliberately conservative: every headline figure on the
 *  panel scales off them and a flattering default makes the whole thing a sales
 *  pitch. 0.008 matches no published runner above, so the dropdown opens on
 *  "Custom" and the panel keeps saying the numbers are its own guess. */
export const COST_DEFAULT_PER_CI_MINUTE = 0.008;
export const COST_DEFAULT_MINUTES_PER_MANUAL_RUN = 12;

/**
 * How long a person would take to work out why a test failed, without the model.
 *
 * The AI Debug category multiplies this by diagnoses that were actually kept —
 * not by every session — and then subtracts the time spent waiting on the
 * model. Fifteen minutes is a deliberately unflattering figure for reading a
 * stack trace, finding the step, and checking the page: the number is on screen
 * and editable precisely because a failure you already understand costs two
 * minutes and one you don't can cost an afternoon.
 */
export const COST_DEFAULT_MINUTES_PER_MANUAL_DEBUG = 15;

/**
 * What an hour of that person's time is worth. ZERO MEANS "DON'T SAY".
 *
 * `cost-model.mjs`'s sibling comment explains the rule this bends: spend is
 * money because a CI minute has a published price, and value is TIME because an
 * hourly rate varies by an order of magnitude between users, nobody would
 * notice a bad default, and a currency figure carries far more authority than
 * the guess behind it deserves. So the default is 0 and 0 renders NOTHING —
 * every saving stays in hours until a user states their own rate. The panel
 * then shows a figure derived from a number they typed, which is a calculation
 * they can check, rather than one the app invented on their behalf.
 */
export const COST_DEFAULT_HOURLY_RATE = 0;

function clamp(n, fallback, bounds) {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

/** Clamp a price per CI minute, falling back to the shipped guess. */
export function clampCostPerCiMinute(n) {
  return clamp(n, COST_DEFAULT_PER_CI_MINUTE, COST_LIMITS.costPerCiMinute);
}

/** Clamp minutes per manual run, falling back to the shipped guess. */
export function clampMinutesPerManualRun(n) {
  return clamp(n, COST_DEFAULT_MINUTES_PER_MANUAL_RUN, COST_LIMITS.minutesPerManualRun);
}

/** Clamp minutes per manual debug, falling back to the shipped guess. */
export function clampMinutesPerManualDebug(n) {
  return clamp(n, COST_DEFAULT_MINUTES_PER_MANUAL_DEBUG, COST_LIMITS.minutesPerManualDebug);
}

/** Clamp an hourly rate. Falls back to 0, which is not a price — it is the
 *  app's "you have not told me", and every money figure derived from it is
 *  suppressed rather than rendered as free. */
export function clampHourlyRate(n) {
  return clamp(n, COST_DEFAULT_HOURLY_RATE, COST_LIMITS.hourlyRate);
}
