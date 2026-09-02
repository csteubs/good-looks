// Handle pop-ups: the run-level switch over overlay dismissal, and the
// BUILT-IN handlers it arms beside the rules a user taught.
//
// ── Why a switch exists now, when overlay rules deliberately had none ──────
//
// Standing overlay rules (shared/overlay-rules.mjs) shipped without a toggle:
// a host with no rules armed nothing and paid nothing, so there was no setting
// to forget. That held while every rule was one the user had taught by
// right-clicking the overlay in the trainer. It stops holding the moment the
// app ships handlers of its own — a built-in that clicks something on every
// site is a behaviour a test must be able to decline, and a test whose whole
// point is the newsletter form needs the pop-up left alone. So the switch is
// an OPT-OUT: on by default, per test, with a global default underneath, and
// "off" means nothing is clicked away — the taught rules included. Half a
// switch (presets off, rules still on) would leave a test that asserts on the
// consent banner watching it vanish anyway.
//
// ── Why built-in handlers, when a rule cannot be typed by hand ─────────────
//
// A rule is taught while looking at the overlay, and the store refuses a
// retyped target because a selector nobody saw match is a selector that fires
// on nothing (overlay-rule-store.ts). That rule is right and it leaves a hole:
// a pop-up on a TIMER or on exit intent may never show during the recording
// session, so there is nothing to right-click, and the first time it appears
// is in a run at 3am. The presets below are the answer for the two vendors
// this app has already been measured against on ritual.com — Klaviyo forms
// and DataGrail consent banners. They are not typed targets: each is scoped to
// markup only that vendor renders, so it resolves to nothing everywhere else,
// and each is exercised by a real Playwright run against that markup in
// e2e/popup-dismissal.spec.ts.
//
// They CLICK, like every rule. Neither vendor documents an API that closes
// its overlay (Klaviyo's `_klOnsite` only opens forms; DataGrail's
// `DG_BANNER_API` shows and reads, never hides), and hiding by stylesheet was
// rejected on 2026-08-22 because a hidden banner is still in the accessibility
// tree. The DataGrail preset clicks the CLOSE control and never Accept or
// Reject: a preset must not make a consent decision on the user's behalf.
//
// ── Pure ──────────────────────────────────────────────────────────────────
//
// No fs, no shell import, no IPC, no process. Three processes arm these — the
// app's runner, the trainer's injection and the MCP/CLI runner — and
// `armedPopupRulesFor` is the ONE function all three call, so the switch cannot
// be honoured in one and not another. A transcribed copy of "is handling on"
// is how a test that turned pop-ups off in the app would still have them
// clicked away in CI.

import { armedRulesFor } from "./overlay-rules.mjs";

/** The shipped default for `defaultHandlePopups`. ON, because taught rules
 *  were always on before the switch existed and a default of off would turn
 *  every one of them silently off. Spelled once: the app's settings store, the
 *  renderer's schema defaults and the unattended runner all read it here. */
export const DEFAULT_HANDLE_POPUPS = true;

/** Prefix on a preset's ARMED id, so it can never collide with a stored rule's
 *  UUID and a run's report can tell the two apart. */
export const PRESET_ID_PREFIX = "preset:";

/**
 * The built-in handlers, in the order they are armed.
 *
 * Every target is a CSS selector SCOPED TO THE VENDOR'S OWN MARKUP — the
 * container class, test id or class the vendor's script renders — so a preset
 * cannot match a control the site itself drew. A bare role/name rule ("button
 * named Close") would click the site's own dialogs on every page, which is
 * exactly why user rules are per host and these are not.
 *
 * KLAVIYO: pop-up and flyout forms are in-page DOM (no iframe) rendered as
 * `div[role="dialog"][aria-modal="true"]` carrying class and data-testid
 * `klaviyo-form-<id>`. Klaviyo requires a close control on every form and its
 * accessible name is author-configurable; "Close dialog" is what ritual.com
 * renders. The close button is removed about 600ms AFTER the click, which is
 * why the watcher clicks each element once (overlay-rules.mjs).
 *
 * DATAGRAIL: the banner is `<aside class="dg-consent-banner">` with an OPEN
 * shadow root, and the close control carries the vendor-documented class
 * `dg-header-close` ("present only if the banner is configured with a close
 * button"). The selector is ROOT-RELATIVE on purpose: the resolver pierces open
 * shadow roots by running the selector inside each one, and a descendant
 * selector starting at the `aside` host cannot cross that boundary. The test-id
 * spelling is the one this repo's fixtures recorded and is kept as a second
 * arm. Four arms, because "the close control" is a button, a container holding
 * a button, or a plain element with a click handler depending on the layout —
 * the watcher clicks each visible match once and a second click on a close
 * control is harmless (measured: seven were).
 *
 * Adding a vendor: one entry here, a row in shared/popup-presets tests, a
 * fixture in main/recorder/__fixtures__/vendor-popups.ts, and a row in the e2e
 * spec. Nothing else — the settings pane, the env transport and the watcher all
 * read this list.
 */
export const POPUP_PRESETS = Object.freeze([
  Object.freeze({
    id: "klaviyo-form-close",
    vendor: "Klaviyo",
    label: "Klaviyo form — Close",
    target: Object.freeze({
      k: "css",
      v:
        '[class*="klaviyo-form"] button[aria-label="Close dialog"], ' +
        '[data-testid^="klaviyo-form-"] button[aria-label="Close dialog"], ' +
        '[class*="klaviyo-form"] button[aria-label="Close"]',
    }),
  }),
  Object.freeze({
    id: "datagrail-consent-close",
    vendor: "DataGrail",
    label: "DataGrail consent banner — Close",
    target: Object.freeze({
      k: "css",
      v:
        "button.dg-header-close, .dg-header-close button, .dg-header-close, " +
        '[data-testid="dg-header-close"]',
    }),
  }),
]);

/** Is this the id of a shipped preset? */
export function isPopupPresetId(id) {
  return typeof id === "string" && POPUP_PRESETS.some((p) => p.id === id);
}

/**
 * The stored `disabledPopupPresets` list, rebuilt from checked values: strings
 * only, known ids only, deduplicated, in preset order. An unknown id is DROPPED
 * rather than kept — a preset that was renamed or removed has nothing to
 * disable, and a list carrying ghosts is a list that says more than it does.
 */
export function normalizeDisabledPresets(raw) {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(raw.filter((id) => isPopupPresetId(id)));
  return POPUP_PRESETS.filter((p) => wanted.has(p.id)).map((p) => p.id);
}

/** A preset's id as it is ARMED — prefixed so it cannot collide with a rule. */
export function presetRuleId(presetId) {
  return PRESET_ID_PREFIX + presetId;
}

/** Was this armed id a preset's? The run report reads it back this way. */
export function isPresetRuleId(id) {
  return typeof id === "string" && id.startsWith(PRESET_ID_PREFIX);
}

/**
 * The presets as armed rules — the shape `dismissEnv` writes and the watcher
 * reads: `{ id, host, label, target }`, plus `builtIn` so a report can say
 * which is which. `host` is empty: a preset applies wherever its vendor's
 * markup is, which is the selector's job to decide, not a host list's.
 */
export function presetRules(disabledIds) {
  const disabled = new Set(normalizeDisabledPresets(disabledIds));
  return POPUP_PRESETS.filter((p) => !disabled.has(p.id)).map((p) => ({
    id: presetRuleId(p.id),
    host: "",
    label: p.label,
    target: { ...p.target },
    builtIn: true,
  }));
}

/**
 * Whether a test handles pop-ups: its own field when it has one, else the
 * global default, else the shipped default. The three-layer rule every other
 * per-test run option resolves by (`captureArtifacts ?? defaultCaptureArtifacts`),
 * spelled here once because the app runner, the trainer and the unattended
 * runner all ask it.
 */
export function resolveHandlePopups(testValue, settingValue) {
  if (typeof testValue === "boolean") return testValue;
  if (typeof settingValue === "boolean") return settingValue;
  return DEFAULT_HANDLE_POPUPS;
}

/**
 * Everything one run (or one trainer document) arms: the user's rules for this
 * URL's host, then the built-in handlers — or NOTHING when handling is off.
 *
 * The ONE function every arming site calls. User rules come first so a taught
 * rule for the same control is the one whose id the report names; the
 * watcher's clicked-set is by node identity, so the preset behind it never
 * clicks that node a second time.
 */
export function armedPopupRulesFor({ rules, url, handlePopups, disabledPresets }) {
  if (handlePopups === false) return [];
  return [...armedRulesFor(rules, url), ...presetRules(disabledPresets)];
}
