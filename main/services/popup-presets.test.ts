// The built-in pop-up handlers and the switch over them
// (shared/popup-presets.mjs).
//
// Three things here are silent when wrong. A preset whose target the overlay
// normalizer would refuse is a preset that arms in a run (which never
// normalizes) and could never have been taught in the trainer — the two halves
// of the feature disagreeing about what a rule IS. A switch honoured by the
// arming function but not by one of its callers is a test that keeps its
// pop-up in the app and loses it in CI (that half is check:overlay-rules).
// And an env round trip that drops a preset is a run that says "armed" and
// clicks nothing: the fixture reads names the runner writes, and a preset that
// does not survive `dismissEnv` is invisible in every log.
//
// The DOM half — does each target FIND the vendor's control — is
// main/recorder/popup-presets.dom.test.ts; the real-Playwright half is
// e2e/popup-dismissal.spec.ts.

import { describe, expect, it } from "vitest";

import { normalizeOverlayRule } from "../recorder/types.js";
import { dismissEnv } from "../../shared/dismiss-fixture-names.mjs";
import { dismissFixtureSource } from "../../shared/dismiss-fixture-source.mjs";
import { MAX_OVERLAY_LABEL, OVERLAY_LOCATOR_KINDS } from "../../shared/overlay-rules.mjs";
import type { OverlayRuleLike } from "../../shared/overlay-rules.mjs";
import {
  armedPopupRulesFor,
  DEFAULT_HANDLE_POPUPS,
  isPopupPresetId,
  isPresetRuleId,
  normalizeDisabledPresets,
  POPUP_PRESETS,
  PRESET_ID_PREFIX,
  presetRuleId,
  presetRules,
  resolveHandlePopups,
} from "../../shared/popup-presets.mjs";

const RITUAL = "https://www.ritual.com/";

function rule(over: Partial<OverlayRuleLike> = {}): OverlayRuleLike {
  return {
    id: "r1",
    host: "ritual.com",
    label: "DataGrail — Close (taught)",
    target: { k: "css", v: "button.dg-header-close" },
    ...over,
  };
}

const PRESET_IDS = POPUP_PRESETS.map((p) => presetRuleId(p.id));

/**
 * Run the dismissal fixture's OWN reader over an environment — the
 * check:overlay-rules idiom. Everything up to `const RULES = …` is
 * self-contained (the constants, `note`, `rulesFromEnv`), and slicing at a
 * declaration boundary keeps this a test of the reader rather than of a regex.
 */
function readBackThroughFixture(
  env: Record<string, string>,
): { id: string; label: string; target: { k: string; v?: string } }[] {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const marker = "const RULES = rulesFromEnv();";
    const cut = dismissFixtureSource.indexOf(marker);
    expect(cut, "the fixture's reader boundary").toBeGreaterThan(0);
    const read = new Function(
      `${dismissFixtureSource.slice(0, cut)}; return rulesFromEnv();`,
    ) as () => { id: string; label: string; target: { k: string; v?: string } }[];
    return read();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe("armedPopupRulesFor — the one arming function", () => {
  it("arms NOTHING when Handle pop-ups is off, the taught rules included", () => {
    // Half a switch (presets off, rules still on) would leave a test that
    // asserts on the consent banner watching it vanish anyway.
    expect(armedPopupRulesFor({ rules: [rule()], url: RITUAL, handlePopups: false })).toEqual([]);
  });

  it("arms the host's taught rules first, then the presets", () => {
    const armed = armedPopupRulesFor({
      rules: [rule(), rule({ id: "r2", host: "other.example" })],
      url: RITUAL,
      handlePopups: true,
    });
    expect(armed.map((r) => r.id)).toEqual(["r1", ...PRESET_IDS]);
  });

  it("leaves out a preset switched off in Settings", () => {
    const armed = armedPopupRulesFor({
      rules: [rule()],
      url: RITUAL,
      handlePopups: true,
      disabledPresets: ["klaviyo-form-close"],
    });
    expect(armed.map((r) => r.id)).toEqual(["r1", presetRuleId("datagrail-consent-close")]);
  });

  it("ignores an unknown disabled id rather than disabling everything or nothing", () => {
    const armed = armedPopupRulesFor({
      rules: [],
      url: RITUAL,
      handlePopups: true,
      disabledPresets: ["nope"],
    });
    expect(armed.map((r) => r.id)).toEqual(PRESET_IDS);
  });

  it("a preset carries builtIn and a prefixed id; a taught rule carries neither", () => {
    const [taught, ...presets] = armedPopupRulesFor({
      rules: [rule()],
      url: RITUAL,
      handlePopups: true,
    });
    expect(taught.builtIn).toBeUndefined();
    expect(isPresetRuleId(taught.id)).toBe(false);
    for (const p of presets) {
      expect(p.builtIn).toBe(true);
      expect(p.id.startsWith(PRESET_ID_PREFIX)).toBe(true);
      expect(isPresetRuleId(p.id)).toBe(true);
      // No host: a preset applies wherever its vendor's markup is.
      expect(p.host).toBe("");
    }
  });

  it("a disabled taught rule stays out, as it always did", () => {
    const armed = armedPopupRulesFor({
      rules: [rule({ disabled: true })],
      url: RITUAL,
      handlePopups: true,
    });
    expect(armed.map((r) => r.id)).toEqual(PRESET_IDS);
  });
});

describe("the shipped presets", () => {
  it("ships the two vendors this app was measured against", () => {
    expect(POPUP_PRESETS.map((p) => p.id)).toEqual(["klaviyo-form-close", "datagrail-consent-close"]);
    expect(POPUP_PRESETS.map((p) => p.vendor)).toEqual(["Klaviyo", "DataGrail"]);
  });

  it("every preset is a rule the overlay normalizer would accept, so the trainer and the run agree about what it IS", () => {
    for (const preset of POPUP_PRESETS) {
      const normalized = normalizeOverlayRule({
        id: preset.id,
        host: "vendor.example",
        label: preset.label,
        target: preset.target,
        createdAt: 1,
        updatedAt: 1,
      });
      expect(normalized, `preset ${preset.id} normalizes`).not.toBeNull();
      expect(OVERLAY_LOCATOR_KINDS).toContain(normalized!.target.k);
      expect(normalized!.target.k).not.toBe("xpath");
      // Intact, not merely accepted: a target the normalizer rewrote would be
      // a preset that arms one selector in the run and another in the trainer.
      expect(normalized!.target.v).toBe(preset.target.v);
      expect(preset.label.length).toBeLessThanOrEqual(MAX_OVERLAY_LABEL);
      expect(normalized!.label).toBe(preset.label);
    }
  });

  it("every selector arm is scoped to the vendor's own markup — never a bare Close button", () => {
    // A bare role/name rule would click the site's own dialogs on every page,
    // which is exactly why user rules are per host and these are not.
    for (const preset of POPUP_PRESETS) {
      const arms = String(preset.target.v).split(",").map((s) => s.trim());
      expect(arms.length).toBeGreaterThan(0);
      for (const arm of arms) {
        expect(/klaviyo|dg-/i.test(arm), `${preset.id} arm "${arm}" names its vendor`).toBe(true);
      }
    }
  });

  it("tells a preset id and an ARMED preset id apart", () => {
    expect(isPopupPresetId("klaviyo-form-close")).toBe(true);
    expect(isPopupPresetId(presetRuleId("klaviyo-form-close"))).toBe(false);
    expect(isPresetRuleId(presetRuleId("klaviyo-form-close"))).toBe(true);
    expect(isPresetRuleId("klaviyo-form-close")).toBe(false);
    expect(isPopupPresetId(42)).toBe(false);
    expect(isPresetRuleId(undefined)).toBe(false);
  });

  it("presetRules honours the disabled list and rebuilds each rule", () => {
    const all = presetRules();
    expect(all.map((r) => r.id)).toEqual(PRESET_IDS);
    expect(presetRules(["datagrail-consent-close"]).map((r) => r.id)).toEqual([
      presetRuleId("klaviyo-form-close"),
    ]);
    // A fresh target object per call — a caller mutating one must not reach
    // the frozen preset behind it.
    expect(all[0].target).not.toBe(POPUP_PRESETS[0].target);
    expect(all[0].target).toEqual(POPUP_PRESETS[0].target);
  });
});

describe("resolveHandlePopups — three layers", () => {
  it("the test's own field wins over the setting", () => {
    expect(resolveHandlePopups(false, true)).toBe(false);
    expect(resolveHandlePopups(true, false)).toBe(true);
  });

  it("the setting next", () => {
    expect(resolveHandlePopups(undefined, false)).toBe(false);
    expect(resolveHandlePopups(undefined, true)).toBe(true);
  });

  it("the shipped default last — and it is ON, so taught rules keep firing on upgrade", () => {
    expect(DEFAULT_HANDLE_POPUPS).toBe(true);
    expect(resolveHandlePopups(undefined, undefined)).toBe(DEFAULT_HANDLE_POPUPS);
  });

  it("a non-boolean is not a choice at either layer", () => {
    expect(resolveHandlePopups("no", "yes")).toBe(DEFAULT_HANDLE_POPUPS);
    expect(resolveHandlePopups("no", false)).toBe(false);
    expect(resolveHandlePopups(0, true)).toBe(true);
  });
});

describe("normalizeDisabledPresets", () => {
  it("drops unknown ids and duplicates, and keeps preset order", () => {
    expect(
      normalizeDisabledPresets([
        "nope",
        "datagrail-consent-close",
        "klaviyo-form-close",
        "klaviyo-form-close",
        7,
        null,
      ]),
    ).toEqual(["klaviyo-form-close", "datagrail-consent-close"]);
  });

  it("reads anything that is not a list as nothing disabled", () => {
    expect(normalizeDisabledPresets(undefined)).toEqual([]);
    expect(normalizeDisabledPresets("klaviyo-form-close")).toEqual([]);
    expect(normalizeDisabledPresets({ 0: "klaviyo-form-close" })).toEqual([]);
  });
});

describe("the env round trip", () => {
  it("a preset survives dismissEnv and the fixture's own reader intact", () => {
    // The runner WRITES `dismissEnv(armed)`; the fixture READS it back inside
    // a Playwright worker. Run the shipped list through both halves.
    const parsed = readBackThroughFixture(dismissEnv(presetRules()));
    expect(parsed.map((r) => r.label)).toEqual(POPUP_PRESETS.map((p) => p.label));
    expect(parsed.map((r) => r.target)).toEqual(POPUP_PRESETS.map((p) => ({ ...p.target })));
  });

  it("with handling off the env carries a count of zero and the reader finds nothing", () => {
    const env = dismissEnv(armedPopupRulesFor({ rules: [rule()], url: RITUAL, handlePopups: false }));
    expect(env).toEqual({ GLAZE_DISMISS_COUNT: "0" });
    expect(readBackThroughFixture(env)).toEqual([]);
  });

  it("a taught rule travels ahead of the presets, in the order the watcher sweeps", () => {
    const parsed = readBackThroughFixture(
      dismissEnv(armedPopupRulesFor({ rules: [rule()], url: RITUAL, handlePopups: true })),
    );
    expect(parsed.map((r) => r.label)).toEqual([
      "DataGrail — Close (taught)",
      ...POPUP_PRESETS.map((p) => p.label),
    ]);
  });
});
