// Types for popup-presets.mjs. See run-pacing.d.mts for why these are
// hand-written.

import type { OverlayRuleLike, OverlayTarget } from "./overlay-rules.mjs";

/** One shipped handler: a vendor's close control, as a scoped locator. */
export interface PopupPreset {
  id: string;
  vendor: string;
  label: string;
  target: OverlayTarget;
}

/** A rule as it is ARMED — what `dismissEnv` writes and the watcher reads.
 *  `host` is empty for a preset. Structurally a superset of a stored rule's
 *  arming fields, so a taught rule and a preset travel in one list. */
export interface ArmedRuleLike {
  id: string;
  host?: string;
  label: string;
  target: OverlayTarget;
  builtIn?: boolean;
}

/** The shipped default for `RecorderSettings.defaultHandlePopups`. */
export declare const DEFAULT_HANDLE_POPUPS: boolean;

/** Prefix on a preset's armed id. */
export declare const PRESET_ID_PREFIX: string;

export declare const POPUP_PRESETS: readonly PopupPreset[];

export declare function isPopupPresetId(id: unknown): id is string;

/** Rebuild a `disabledPopupPresets` list from checked values. */
export declare function normalizeDisabledPresets(raw: unknown): string[];

export declare function presetRuleId(presetId: string): string;

export declare function isPresetRuleId(id: unknown): boolean;

export declare function presetRules(
  disabledIds?: readonly string[] | null | undefined,
): ArmedRuleLike[];

/** A test's own field, else the setting, else the shipped default. */
export declare function resolveHandlePopups(testValue: unknown, settingValue: unknown): boolean;

/** The user's rules for this URL's host, then the enabled presets — or `[]`
 *  when `handlePopups` is false. */
export declare function armedPopupRulesFor<T extends OverlayRuleLike>(input: {
  rules: readonly T[] | null | undefined;
  url: string | null | undefined;
  handlePopups: boolean;
  disabledPresets?: readonly string[] | null | undefined;
}): ArmedRuleLike[];
