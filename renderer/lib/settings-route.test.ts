// Which pathnames are Settings.
//
// This is one regex, and it would not be worth a file if three components did
// not have to agree with it exactly. They do: `RootShell` mounts the settings
// controller on it, `LibrarySidebar` swaps the rail's whole body on it, and
// `AppStrip` builds the trail from it. A rail that swapped one screen wider
// than the scope that mounts the controller throws out of
// `useSettingsController` — a blank window and a clean log, which is this
// repo's quietest failure mode.
//
// The cases that matter are the near misses. `/settingsomething` is not
// Settings, `/stats/settings` is not Settings, and `/settings/a/b/c` is not a
// screen at all.

import { describe, it, expect } from "vitest";

import { isSettingsPath, parseSettingsPath, SETTINGS_PATH } from "./settings-route";

describe("isSettingsPath", () => {
  it("recognises the board and everything under it", () => {
    for (const path of [
      "/settings",
      "/settings/",
      "/settings/appearance",
      "/settings/documentation",
      "/settings/documentation/setup",
    ]) {
      expect(isSettingsPath(path), path).toBe(true);
    }
  });

  it("refuses a path that merely starts with the word", () => {
    // `pathname.startsWith("/settings")` is the obvious spelling and this is
    // why it is not the one used: it would put the rail into settings mode on
    // a route that renders something else entirely.
    for (const path of [
      "/settingsomething",
      "/settings-x",
      "/stats/settings",
      "/",
      "/stats",
      "/test/settings",
    ]) {
      expect(isSettingsPath(path), path).toBe(false);
    }
  });

  it("refuses a fourth level", () => {
    // No route registers one, so the pathname names no screen — and a rail
    // that swapped for it would be standing beside a not-found page.
    expect(isSettingsPath("/settings/documentation/setup/extra")).toBe(false);
  });
});

describe("parseSettingsPath", () => {
  it("answers null for a path that is not Settings", () => {
    expect(parseSettingsPath("/stats")).toBeNull();
  });

  it("names no pane on the board", () => {
    expect(parseSettingsPath(SETTINGS_PATH)).toEqual({ pane: undefined, topic: undefined });
  });

  it("returns the segments as history spells them", () => {
    expect(parseSettingsPath("/settings/test-defaults")).toEqual({
      pane: "test-defaults",
      topic: undefined,
    });
    expect(parseSettingsPath("/settings/documentation/setup")).toEqual({
      pane: "documentation",
      topic: "setup",
    });
  });

  it("passes an unknown segment through rather than judging it", () => {
    // Deciding whether "nonsense" names a pane is `paneById`'s job, in the view
    // and in the breadcrumb. If this file guessed too, there would be two
    // answers to one question. Same split as `stats-categories.ts`.
    expect(parseSettingsPath("/settings/nonsense")).toEqual({
      pane: "nonsense",
      topic: undefined,
    });
  });

  it("leaves a percent-encoded segment encoded", () => {
    // The caller decodes, because the caller is what compares it to a registry
    // key. Decoding here would hide the fact that it needs doing.
    expect(parseSettingsPath("/settings/test%2Ddefaults")?.pane).toBe("test%2Ddefaults");
  });
});
