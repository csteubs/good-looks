// Tests for the Settings window's shape-as-data.
//
// Three things are being pinned here, and they fail in three different ways:
//
//   • The INVARIANTS (unique ids, every pane reachable, every default claimed
//     by exactly one pane). These catch the failure this module exists to
//     prevent: a setting that is persisted by the backend and surfaced nowhere,
//     or surfaced twice. Both are invisible on screen — the window looks fine,
//     the setting is just unreachable or fights itself.
//   • SEARCH, against words a user would actually type. A settings search is
//     only worth having if "headers" finds the header toggle; asserting the
//     matcher's mechanics without asserting its vocabulary passes while the
//     feature is useless.
//   • The CLAMPS, which used to be inline arithmetic in async handlers. Their
//     inputs are raw strings from a number input, so the interesting cases are
//     the non-numbers: "", "abc", "-", "1e9". Each of those used to reach
//     Math.round via `Number(x) || fallback` and the only test was a rendered
//     window firing change events.

import { describe, it, expect } from "vitest";

import type { RecorderSettings } from "./recorder-types";
import {
  DEFAULT_PANE_ID,
  PANES,
  SETTINGS_DEFAULTS,
  SETTING_INDEX,
  clampHealRetries,
  clampHealTimeoutMs,
  clampRetainedRuns,
  clampRetentionDays,
  clampTestTimeoutSec,
  formatBytes,
  matchCountByPane,
  modifiedKeys,
  paneById,
  paneKeys,
  paneSegments,
  resetPatch,
  searchSettings,
  type PaneId,
} from "./settings-schema";

describe("pane definitions", () => {
  it("gives every pane a unique id", () => {
    const ids = PANES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every pane a title and a subtitle", () => {
    // The subtitle is load-bearing: it carries the "each test can override
    // this" fact that used to be repeated in half the row descriptions. A blank
    // one silently drops that.
    for (const pane of PANES) {
      expect(pane.title.length, pane.id).toBeGreaterThan(0);
      expect(pane.subtitle.length, pane.id).toBeGreaterThan(0);
    }
  });

  it("resolves the default pane", () => {
    expect(paneById(DEFAULT_PANE_ID)).toBeDefined();
  });

  it("returns undefined for an unknown pane rather than throwing", () => {
    // The selected pane can come from a stale value; the shell falls back.
    expect(paneById("no-such-pane")).toBeUndefined();
  });

  it("places every pane in exactly one segment, in declaration order", () => {
    const segmented = paneSegments().flatMap((s) => s.panes.map((p) => p.id));
    expect(segmented).toEqual(PANES.map((p) => p.id));
  });

  it("keeps the two ungrouped stretches apart", () => {
    // THE reason segments exist. Appearance sits above the titled groups and
    // the developer panes below them. Bucketing by group value instead of by
    // run would merge them and render Diagnostics at the top, directly under
    // Appearance — which looks like a sort bug and puts a developer pane in the
    // first position.
    const segments = paneSegments();
    const ungrouped = segments.filter((s) => s.group === null);
    expect(ungrouped).toHaveLength(2);
    expect(segments[0].panes.map((p) => p.id)).toEqual(["appearance"]);
    expect(segments[segments.length - 1].panes.map((p) => p.id)).toEqual([
      "documentation",
      "diagnostics",
      "experiments",
    ]);
  });

  it("gives every titled segment a distinct heading", () => {
    const titled = paneSegments().filter((s) => s.group !== null).map((s) => s.group);
    expect(new Set(titled).size).toBe(titled.length);
  });
});

describe("the setting index", () => {
  it("gives every setting a unique id", () => {
    const ids = SETTING_INDEX.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("assigns every setting to a real pane", () => {
    for (const entry of SETTING_INDEX) {
      expect(paneById(entry.pane), entry.id).toBeDefined();
    }
  });

  it("leaves no pane empty", () => {
    // An empty pane renders as a heading over nothing.
    for (const pane of PANES) {
      const rows = SETTING_INDEX.filter((e) => e.pane === pane.id);
      expect(rows.length, pane.id).toBeGreaterThan(0);
    }
  });

  it("gives every indexed key a known default", () => {
    // Without one, `modifiedKeys` can never report the row and `resetPatch`
    // silently skips it — the row looks resettable and isn't.
    for (const entry of SETTING_INDEX) {
      if (!entry.key) continue;
      expect(entry.key in SETTINGS_DEFAULTS, entry.id).toBe(true);
    }
  });

  it("surfaces every persisted default in exactly one pane", () => {
    // The invariant that matters most. A key in the store with no row is a
    // setting the user cannot reach; a key claimed by two panes is one that
    // shows two different modified-counts for the same value.
    for (const key of Object.keys(SETTINGS_DEFAULTS) as (keyof RecorderSettings)[]) {
      const owners = PANES.filter((p) => paneKeys(p.id).indexOf(key) !== -1);
      expect(owners.map((p) => p.id), String(key)).toHaveLength(1);
    }
  });

  it("dedupes a key claimed by two rows of the same pane", () => {
    // Both aesthetic flourishes write disabledAestheticEnhancements.
    const keys = paneKeys("appearance");
    expect(keys.filter((k) => k === "disabledAestheticEnhancements")).toHaveLength(1);
  });

  it("gives credential and action rows no key", () => {
    // This is what keeps "reset section" away from the API key and the webhook.
    const keyless = [
      "anthropic-key",
      "alert-webhook-url",
      "prune-now",
      "debug-capture-now",
      "theme",
      // The role slots live in the LLM config, not RecorderSettings.
      "llm-role-instant",
      "llm-role-autocomplete",
    ];
    for (const id of keyless) {
      const entry = SETTING_INDEX.filter((e) => e.id === id)[0];
      expect(entry, id).toBeDefined();
      expect(entry.key, id).toBeUndefined();
    }
  });
});

describe("search", () => {
  it("returns everything for an empty query", () => {
    expect(searchSettings("")).toHaveLength(SETTING_INDEX.length);
  });

  it("returns everything for a whitespace-only query", () => {
    // Typing a space then deleting it must not empty the window.
    expect(searchSettings("   ")).toHaveLength(SETTING_INDEX.length);
  });

  it("matches the label case-insensitively", () => {
    expect(searchSettings("HEADLESS")).toContain("default-run-headless");
  });

  it("requires every term, not any", () => {
    // "heal timeout" must find the heal timeout, not every heal row plus every
    // timeout row.
    const hits = searchSettings("heal timeout");
    expect(hits).toContain("auto-heal-timeout");
    expect(hits).not.toContain("default-test-timeout");
    expect(hits).not.toContain("auto-heal-retries");
  });

  it("matches on the owning pane's title", () => {
    // "storage" is in no label; without the pane title in the haystack the
    // pane's own name finds nothing in it.
    const hits = searchSettings("storage");
    expect(hits).toContain("artifact-retained-runs");
    expect(hits).toContain("artifact-retention-days");
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchSettings("zzzznotasetting")).toHaveLength(0);
  });

  // The vocabulary test. Each of these is a word someone would plausibly type
  // while looking for that row, and none of them is a substring of an adjacent
  // row's label — so a keyword deleted from the index fails here rather than
  // quietly narrowing what search can find.
  const vocabulary: ReadonlyArray<[string, string]> = [
    ["headers", "record-all-headers"],
    ["authorization", "record-all-headers"],
    ["cookie", "record-all-headers"],
    ["slack", "alert-webhook-enabled"],
    ["discord", "alert-webhook-enabled"],
    ["dark", "theme"],
    ["webkit", "default-run-browser"],
    ["firefox", "default-run-browser"],
    ["axe", "default-a11y"],
    ["wcag", "default-a11y"],
    ["crawl", "default-run-speed"],
    ["viewport", "default-window-size"],
    ["mobile", "default-window-size"],
    ["ollama", "llm-provider"],
    ["anthropic", "llm-provider"],
    ["locator", "auto-heal-enabled"],
    ["disk", "artifact-retained-runs"],
    ["mcp", "debug-screenshots"],
    ["notification", "notify-run-issues"],
    ["insights", "ai-insights-enabled"],
    ["monthly", "ai-insights-cadence"],
    ["black hole", "home-black-hole"],
  ];

  it.each(vocabulary)("finds %s", (query, expectedId) => {
    expect(searchSettings(query)).toContain(expectedId);
  });

  it("counts matches per pane", () => {
    const counts = matchCountByPane(searchSettings("heal"));
    expect(counts["auto-heal"]).toBe(5);
  });

  it("omits panes with no match rather than reporting zero", () => {
    // The sidebar filters on presence; a 0 entry would render an empty pane.
    const counts = matchCountByPane(searchSettings("headers"));
    expect(counts["auto-heal"]).toBeUndefined();
    expect(counts["test-defaults"]).toBe(1);
  });

  it("ignores an id that is not in the index", () => {
    expect(matchCountByPane(["not-a-real-id"])).toEqual({});
  });
});

describe("modified detection", () => {
  const clean: Partial<RecorderSettings> = { ...SETTINGS_DEFAULTS };

  it("reports nothing before settings have loaded", () => {
    // A null here used to flash a count on every pane for one frame.
    expect(modifiedKeys(null, "test-defaults")).toHaveLength(0);
  });

  it("reports nothing for a settings object at its defaults", () => {
    for (const pane of PANES) {
      expect(modifiedKeys(clean, pane.id), pane.id).toHaveLength(0);
    }
  });

  it("reports a changed primitive", () => {
    expect(modifiedKeys({ ...clean, defaultRunHeadless: true }, "test-defaults")).toContain(
      "defaultRunHeadless",
    );
  });

  it("reports a changed number", () => {
    expect(modifiedKeys({ ...clean, defaultTestTimeoutMs: 120_000 }, "test-defaults")).toContain(
      "defaultTestTimeoutMs",
    );
  });

  it("does not report a key the pane does not own", () => {
    expect(modifiedKeys({ ...clean, autoHealRetries: 9 }, "test-defaults")).toHaveLength(0);
    expect(modifiedKeys({ ...clean, autoHealRetries: 9 }, "auto-heal")).toEqual(["autoHealRetries"]);
  });

  it("treats a missing key as unmodified rather than as different", () => {
    // A partial object is what arrives mid-load.
    expect(modifiedKeys({ defaultRunHeadless: true }, "test-defaults")).toEqual([
      "defaultRunHeadless",
    ]);
  });

  it("does not report an array that arrived fresh from JSON but is equal", () => {
    // `[] !== []`. Reference equality would have called this modified on every
    // single load, permanently showing a count on Appearance.
    expect(modifiedKeys({ ...clean, disabledAestheticEnhancements: [] }, "appearance")).toHaveLength(
      0,
    );
  });

  it("reports a non-empty enhancements array", () => {
    expect(
      modifiedKeys({ ...clean, disabledAestheticEnhancements: ["aiThinkingGif"] }, "appearance"),
    ).toEqual(["disabledAestheticEnhancements"]);
  });

  it("ignores the order of the enhancements array", () => {
    // The toggle handler appends, so the order depends on which was turned off
    // first. Two users with the same flourishes off must read the same.
    const a = modifiedKeys(
      { ...clean, disabledAestheticEnhancements: ["a", "b"] },
      "appearance",
    );
    const b = modifiedKeys(
      { ...clean, disabledAestheticEnhancements: ["b", "a"] },
      "appearance",
    );
    expect(a).toEqual(b);
  });

  it("compares a viewport by value, not by reference", () => {
    expect(
      modifiedKeys({ ...clean, defaultWindowSize: { width: 1280, height: 800 } }, "recording"),
    ).toEqual(["defaultWindowSize"]);
    expect(modifiedKeys({ ...clean, defaultWindowSize: null }, "recording")).toHaveLength(0);
  });

  it("reports a viewport differing only in height", () => {
    const settings = { ...clean, defaultWindowSize: { width: 1280, height: 800 } };
    const same = { ...clean, defaultWindowSize: { width: 1280, height: 801 } };
    expect(modifiedKeys(settings, "recording")).toEqual(["defaultWindowSize"]);
    expect(modifiedKeys(same, "recording")).toEqual(["defaultWindowSize"]);
  });

  it("counts a default that is true, not just a default that is false", () => {
    // showUrlBar and autoHealEnabled default ON. A modified-check written as
    // "is it truthy" would call them modified out of the box.
    expect(modifiedKeys({ ...clean, showUrlBar: true }, "recording")).toHaveLength(0);
    expect(modifiedKeys({ ...clean, showUrlBar: false }, "recording")).toEqual(["showUrlBar"]);
    expect(modifiedKeys({ ...clean, autoHealEnabled: false }, "auto-heal")).toEqual([
      "autoHealEnabled",
    ]);
  });
});

describe("reset", () => {
  it("returns every owned key to its default", () => {
    const patch = resetPatch("auto-heal");
    expect(patch).toEqual({
      autoHealEnabled: true,
      autoHealApply: "suggest",
      propagateFixes: true,
      autoHealRetries: 3,
      autoHealAttemptTimeoutMs: 4000,
    });
  });

  it("produces a patch that clears every modification it covers", () => {
    for (const pane of PANES) {
      const dirty: Partial<RecorderSettings> = { ...SETTINGS_DEFAULTS, ...resetPatch(pane.id) };
      expect(modifiedKeys({ ...dirty, ...resetPatch(pane.id) }, pane.id), pane.id).toHaveLength(0);
    }
  });

  it("never includes a credential-backed row", () => {
    // The webhook URL and API key live in safeStorage, not in RecorderSettings.
    // A reset that reached them would delete a secret the window cannot even
    // read back to restore.
    const alerts = resetPatch("alerts");
    expect(Object.keys(alerts)).not.toContain("alertWebhookUrl");
    expect(Object.keys(resetPatch("ai"))).not.toContain("anthropicApiKey");
  });

  it("hands out a fresh array, not the shared default", () => {
    // The patch goes into setState. Aliasing the module-level array would let
    // one pane's reset mutate SETTINGS_DEFAULTS for the whole session.
    const patch = resetPatch("appearance");
    (patch.disabledAestheticEnhancements as string[]).push("mutated");
    expect(SETTINGS_DEFAULTS.disabledAestheticEnhancements).toHaveLength(0);
  });

  it("covers exactly the keys the pane owns", () => {
    for (const pane of PANES) {
      expect(Object.keys(resetPatch(pane.id)).slice().sort(), pane.id).toEqual(
        paneKeys(pane.id).slice().sort(),
      );
    }
  });
});

describe("clamps", () => {
  // [raw input, expected] — the raw column is what an <input type="number">
  // actually hands over, including the states it passes through mid-typing.
  const cases: ReadonlyArray<[(raw: string | number) => number, string, string | number, number]> = [
    [clampTestTimeoutSec, "timeout", "120", 120],
    [clampTestTimeoutSec, "timeout", "4", 5],
    [clampTestTimeoutSec, "timeout", "5", 5],
    [clampTestTimeoutSec, "timeout", "1800", 1800],
    [clampTestTimeoutSec, "timeout", "99999", 1800],
    [clampTestTimeoutSec, "timeout", "", 60],
    [clampTestTimeoutSec, "timeout", "abc", 60],
    [clampTestTimeoutSec, "timeout", "-", 60],
    [clampTestTimeoutSec, "timeout", "-50", 5],
    [clampTestTimeoutSec, "timeout", "60.4", 60],
    [clampTestTimeoutSec, "timeout", "60.6", 61],
    [clampTestTimeoutSec, "timeout", "1e9", 1800],

    [clampRetainedRuns, "retained runs", "25", 25],
    [clampRetainedRuns, "retained runs", "0", 10],
    [clampRetainedRuns, "retained runs", "1", 1],
    [clampRetainedRuns, "retained runs", "50", 50],
    [clampRetainedRuns, "retained runs", "9999", 50],
    [clampRetainedRuns, "retained runs", "", 10],
    [clampRetainedRuns, "retained runs", "-3", 1],

    [clampRetentionDays, "retention days", "30", 30],
    [clampRetentionDays, "retention days", "0", 0],
    [clampRetentionDays, "retention days", "365", 365],
    [clampRetentionDays, "retention days", "400", 365],
    [clampRetentionDays, "retention days", "", 0],
    [clampRetentionDays, "retention days", "-1", 0],

    [clampHealRetries, "heal retries", "5", 5],
    [clampHealRetries, "heal retries", "1", 1],
    [clampHealRetries, "heal retries", "10", 10],
    [clampHealRetries, "heal retries", "11", 10],
    [clampHealRetries, "heal retries", "0", 3],
    [clampHealRetries, "heal retries", "", 3],

    [clampHealTimeoutMs, "heal timeout", "4000", 4000],
    [clampHealTimeoutMs, "heal timeout", "999", 1000],
    [clampHealTimeoutMs, "heal timeout", "1000", 1000],
    [clampHealTimeoutMs, "heal timeout", "30000", 30000],
    [clampHealTimeoutMs, "heal timeout", "30001", 30000],
    [clampHealTimeoutMs, "heal timeout", "", 4000],
    [clampHealTimeoutMs, "heal timeout", "0", 4000],
  ];

  it.each(cases)("%# clamps %s of %o to %i", (fn, _name, raw, expected) => {
    expect(fn(raw)).toBe(expected);
  });

  it("always returns an integer", () => {
    // The value is persisted and handed to Playwright / the retention sweep;
    // a float would reach the CLI as "60.5".
    const fns = [
      clampTestTimeoutSec,
      clampRetainedRuns,
      clampRetentionDays,
      clampHealRetries,
      clampHealTimeoutMs,
    ];
    for (const fn of fns) {
      for (const raw of ["3.7", "12.2", "0.5", "1e2"]) {
        expect(Number.isInteger(fn(raw)), `${fn.name}(${raw})`).toBe(true);
      }
    }
  });

  it("never returns NaN, whatever it is handed", () => {
    // A NaN reaching setSettings persists as null and the control renders
    // blank forever after.
    const fns = [
      clampTestTimeoutSec,
      clampRetainedRuns,
      clampRetentionDays,
      clampHealRetries,
      clampHealTimeoutMs,
    ];
    for (const fn of fns) {
      for (const raw of ["", " ", "abc", "-", "+", ".", "NaN", "Infinity", "-Infinity"]) {
        expect(Number.isFinite(fn(raw)), `${fn.name}(${JSON.stringify(raw)})`).toBe(true);
      }
    }
  });

  it("clamps the same whether handed a string or a number", () => {
    // The reset path passes numbers; the input path passes strings.
    expect(clampTestTimeoutSec(120)).toBe(clampTestTimeoutSec("120"));
    expect(clampRetainedRuns(99)).toBe(clampRetainedRuns("99"));
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [1024 * 1024 - 1, "1024 KB"],
    [1024 * 1024, "1.0 MB"],
    [Math.round(1024 * 1024 * 1.6), "1.6 MB"],
    [1024 * 1024 * 1024, "1.0 GB"],
    [1024 * 1024 * 1024 * 2.5, "2.5 GB"],
  ])("formats %i as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("switches to a decimal only past 1 MB", () => {
    // Under a megabyte it stays in whole KB — "600 KB" rather than "0.6 MB".
    expect(formatBytes(614_400)).toBe("600 KB");
    expect(formatBytes(6_144_000)).toBe("5.9 MB");
  });
});

describe("pane ids used by the tests above all exist", () => {
  // Guards the tests themselves: every literal PaneId written above must still
  // name a real pane, or those assertions silently test nothing.
  const used: PaneId[] = [
    "appearance",
    "recording",
    "test-defaults",
    "auto-heal",
    "storage",
    "ai",
    "alerts",
    "diagnostics",
    "experiments",
  ];
  it.each(used)("%s", (id) => {
    expect(paneById(id)).toBeDefined();
  });
});
