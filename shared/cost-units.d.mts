// Types for cost-units.mjs.
//
// Hand-written, like run-pacing.d.mts: the implementation is plain ESM so it can
// be imported without a build step, and this file is what keeps
// `npm run type-check` a real gate over every TypeScript caller.
//
// The two id unions are declared HERE rather than in main/recorder/types.ts,
// and both settings mirrors import them. A currency the store accepts but the
// picker never offers — or the reverse — is then a compile error rather than a
// value that renders as an empty symbol.

export type CostCurrency = "usd" | "eur" | "gbp" | "jpy" | "cad" | "aud" | "none";

export type CiRunnerId =
  | "custom"
  | "linux-1-x64"
  | "linux-2-arm64"
  | "linux-2-x64"
  | "windows-2"
  | "macos-3-4";

export interface CostCurrencyDef {
  id: CostCurrency;
  /** "" for `none`, which is how the panel renders a bare number. */
  symbol: string;
  label: string;
}

export interface CiRunnerPreset {
  id: CiRunnerId;
  /** null for `custom` — it stands for "whatever is typed", not for a price. */
  rate: number | null;
  label: string;
  /** What picking this means, rendered in the menu rather than on hover. */
  consequence: string;
}

export declare const COST_CURRENCIES: readonly CostCurrencyDef[];
export declare const DEFAULT_COST_CURRENCY: CostCurrency;
export declare const CI_RUNNER_PRESETS: readonly CiRunnerPreset[];

export declare const COST_LIMITS: {
  costPerCiMinute: { min: number; max: number };
  minutesPerManualRun: { min: number; max: number };
  minutesPerManualDebug: { min: number; max: number };
  hourlyRate: { min: number; max: number };
};

export declare const COST_DEFAULT_PER_CI_MINUTE: number;
export declare const COST_DEFAULT_MINUTES_PER_MANUAL_RUN: number;
export declare const COST_DEFAULT_MINUTES_PER_MANUAL_DEBUG: number;
/** 0, which means "no rate stated" rather than "free" — see the .mjs. */
export declare const COST_DEFAULT_HOURLY_RATE: number;

export declare function isCostCurrency(x: unknown): x is CostCurrency;
export declare function currencySymbol(id: CostCurrency | string | undefined): string;
export declare function runnerForRate(rate: unknown): CiRunnerId;
export declare function rateForRunner(id: CiRunnerId | string): number | null;
export declare function clampCostPerCiMinute(n: unknown): number;
export declare function clampMinutesPerManualRun(n: unknown): number;
export declare function clampMinutesPerManualDebug(n: unknown): number;
export declare function clampHourlyRate(n: unknown): number;
