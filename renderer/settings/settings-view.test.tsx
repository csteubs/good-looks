// Integration tests for the Settings screens.
//
// The panes are covered individually against a hand-built controller (see
// panes/*.test.tsx). What is left for this file is everything that only exists
// when the real thing is assembled: the board, the pane below it, the search
// wiring that spans the RAIL and the rows at once, the reset footer, and the
// fact that a control in a pane still reaches `recorder:setSettings` through
// the real provider rather than through a spy.
//
// WHAT IS ASSEMBLED HERE IS DELIBERATELY NOT ONE COMPONENT. Settings became two
// routed views in the main window (docs/plans/settings-view.md), and its rail
// is the app's own — `library-sidebar.tsx` renders `SettingsRailRows` where the
// library would be. So the harness below stands up the same three pieces the
// app does, around the same `SettingsScope`, with the router mocked at
// `useNavigate`/`useParams` — the pattern `stats-category-view.test.tsx` and
// `library-sidebar.test.tsx` already use. Mounting a real router here would
// test TanStack.
//
// The webhook and API-key write-only assertions that used to live here moved to
// panes/alerts-pane.test.tsx and panes/ai-pane.test.tsx, where the controls now
// are. They did not go away.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { RecorderSettings } from "../lib/recorder-types";
import { PANES, SETTINGS_DEFAULTS } from "../lib/settings-schema";
import { SettingsPaneView, SettingsView } from "./settings-view";
import { SettingsScope } from "./settings-scope";
import { SettingsRailRows, SettingsRailSearch } from "./settings-rail";
import { StoragePane } from "./panes/storage-pane";

/** The router, as much of it as these screens use — and STATEFUL, because the
 *  thing under test is a drill: clicking a section has to actually put you on
 *  it, or the search-moves-you rule and the reset footer cannot be exercised
 *  at all. `params.pane` is the whole address. */
const nav = vi.hoisted(() => ({
  params: {} as { pane?: string; topic?: string },
  bump: null as null | (() => void),
  calls: [] as { to: string; params?: Record<string, string>; replace?: boolean }[],
  /** The most recent navigation. A helper because this project targets ES2020
   *  and `Array.prototype.at` does not exist here. */
  last() {
    return nav.calls[nav.calls.length - 1];
  },
  go(opts: { to: string; params?: Record<string, string>; replace?: boolean }) {
    nav.calls.push(opts);
    nav.params = opts.params ?? {};
    nav.bump?.();
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => nav.go,
  useParams: () => nav.params,
}));

const setSettings = vi.fn(async (_u: Partial<RecorderSettings>) => ({}) as RecorderSettings);
const invoke = vi.fn(async () => {});

let settings: Partial<RecorderSettings> = {};

vi.mock("../lib/api", () => ({
  api: {
    recorder: {
      getSettings: async () => settings as RecorderSettings,
      setSettings: (u: Partial<RecorderSettings>) => setSettings(u),
    },
    alerts: {
      status: async () => ({ hasUrl: false, host: null }),
      setWebhookUrl: async () => ({ hasUrl: true, host: "hooks.example.com" }),
      clearWebhookUrl: async () => ({ hasUrl: false, host: null }),
      test: async () => ({ ok: true }),
    },
    llm: {
      getConfig: async () => ({ provider: "ollama", model: "", baseUrls: {} }),
      setConfig: async () => ({ provider: "ollama", model: "", baseUrls: {} }),
      status: async () => ({ provider: "ollama", reachable: true, models: [], baseUrl: "http://x" }),
      detect: async () => [],
      setApiKey: async () => ({ hasKey: true }),
      clearApiKey: async () => ({ hasKey: false }),
      hasApiKey: async () => ({ hasKey: false }),
      setLmStudioToken: async () => ({ hasToken: true }),
      clearLmStudioToken: async () => ({ hasToken: false }),
      hasLmStudioToken: async () => ({ hasToken: false }),
    },
    artifacts: {
      usage: async () => ({ bytes: 0, runs: 0, tests: 0 }),
      pruneNow: async () => ({ removedRuns: 0, freedBytes: 0 }),
    },
    debug: {
      shortcut: async () => "⌘⌥⇧S",
      capture: async () => ({ shots: [], error: null }),
      dir: async () => "/tmp",
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  nav.params = {};
  nav.calls = [];
  settings = { ...SETTINGS_DEFAULTS, batchOrder: [] };
  (window as unknown as { glazeAPI: Record<string, unknown> }).glazeAPI = {
    glaze: { ipc: { invoke } },
  };
});

/** The rail and the content, around one scope — what `RootShell` assembles.
 *
 *  `bump` is registered from an effect rather than during render: `nav.go` is
 *  called from an event handler, and a render-phase assignment would be a side
 *  effect in render for no benefit here. */
function Screen() {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    nav.bump = () => setTick((t) => t + 1);
    return () => {
      nav.bump = null;
    };
  }, []);
  return (
    <SettingsScope>
      <SettingsRailSearch />
      <SettingsRailRows />
      {nav.params.pane === undefined ? <SettingsView /> : <SettingsPaneView />}
    </SettingsScope>
  );
}

/** Settings runs its loads on mount. Anchor on the rail, which renders before
 *  any of them resolve, then let the screen settle.
 *
 *  Wrapped in a QueryClient like the main window (renderer/main/index.tsx) —
 *  the Alerts pane reads the insights status through react-query. */
async function renderSettings(opts: { pane?: string; topic?: string } = {}) {
  if (opts.pane !== undefined) nav.params = { pane: opts.pane, topic: opts.topic };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <Screen />
    </QueryClientProvider>,
  );
  await screen.findAllByText("Test defaults");
  return result;
}

/** A rail row, by its pane title. Anchored at the start — rows carry a trailing
 *  count chip, and an unanchored /AI/i also matches "F-AI-lure reasons", which
 *  makes which row is found depend on the rail's order. */
function railRow(title: string): HTMLElement {
  const rows = screen.getAllByRole("button", { name: new RegExp(`^${title}`, "i") });
  // The rail row, not the board card: both are buttons naming the section while
  // the board is up. The rail's row is the one inside a `gl-rail-row`.
  return (rows.find((r) => r.classList.contains("gl-rail-row")) ?? rows[0]) as HTMLElement;
}

/** Click, not mouse-down: the rows are `RailRow` — see settings-nav.test.tsx
 *  for why that distinction has its own comment. */
async function goToPane(title: string) {
  fireEvent.click(railRow(title));
  await waitFor(() =>
    expect(screen.getByText(PANES.find((p) => p.title === title)!.subtitle)).toBeTruthy(),
  );
}

function search(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/search settings/i), { target: { value } });
}

describe("the board", () => {
  it("lists every section", async () => {
    await renderSettings();
    for (const pane of PANES) {
      expect(screen.getAllByText(pane.title).length, pane.id).toBeGreaterThan(0);
    }
  });

  it("says what is in each one, which the rail has no room for", async () => {
    // The whole reason `/settings` is a screen rather than a redirect to the
    // first pane. Losing this leaves a board that duplicates the rail.
    await renderSettings();
    for (const pane of PANES) {
      expect(screen.getByText(pane.subtitle), pane.id).toBeTruthy();
    }
  });

  it("opens a section when its card is clicked", async () => {
    await renderSettings();
    const card = screen
      .getAllByRole("button", { name: /^Storage/ })
      .find((b) => b.classList.contains("gl-settings-card"))!;
    fireEvent.click(card);
    expect(nav.last()).toEqual({ to: "/settings/$pane", params: { pane: "storage" } });
  });

  it("marks no rail row as current", async () => {
    // The board is a screen of its own and is not one of the rail's rows.
    const { container } = await renderSettings();
    expect(container.querySelectorAll(".gl-rail-row[aria-current]")).toHaveLength(0);
  });
});

describe("navigation", () => {
  it("shows only the selected pane's controls", async () => {
    await renderSettings({ pane: "appearance" });
    // Headless lives in Test defaults, not Appearance.
    expect(screen.queryByRole("switch", { name: /headless/i })).toBeNull();
    await goToPane("Test defaults");
    expect(screen.getByRole("switch", { name: /headless/i })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /ai thinking gif/i })).toBeNull();
  });

  it("names the pane in the address rather than in local state", async () => {
    // The reason this is a route at all: back, forward and the breadcrumb all
    // operate on history, and a pane held in `useState` is in none of them.
    await renderSettings({ pane: "appearance" });
    fireEvent.click(railRow("Storage"));
    expect(nav.last()).toEqual({ to: "/settings/$pane", params: { pane: "storage" } });
  });

  it("shows the pane subtitle", async () => {
    await renderSettings({ pane: "test-defaults" });
    // The fact that used to be repeated in half the row descriptions.
    expect(screen.getByText(/Every one can be overridden per test/i)).toBeTruthy();
  });

  it("marks the open pane in the rail", async () => {
    await renderSettings({ pane: "storage" });
    expect(railRow("Storage").getAttribute("aria-current")).toBe("true");
  });

  it("reaches every pane", async () => {
    // A representative walk rather than all eighteen: the panes that reach APIs
    // this file does not stub (Failure reasons, Overlay rules, Proxy) have their
    // own tests, and stubbing the whole backend here to click through them would
    // make this file the place a new pane's mocks have to be remembered.
    await renderSettings({ pane: "appearance" });
    for (const title of [
      "Recording",
      "Test defaults",
      "Auto-Heal",
      "Storage",
      "AI",
      "Alerts",
      "Diagnostics",
      "Experiments",
      "Appearance",
    ]) {
      await goToPane(title);
    }
  });

  it("explains an address that names no section", async () => {
    // A param is a string out of history. Silently falling back to Appearance
    // would make a stale link look like a menu item that does the wrong thing.
    await renderSettings({ pane: "nonsense" });
    expect(screen.getByText(/no such settings section/i)).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /ai thinking gif/i })).toBeNull();
  });
});

describe("a control still reaches the backend", () => {
  it("persists through the real provider, not a spy", async () => {
    await renderSettings({ pane: "test-defaults" });
    fireEvent.click(await screen.findByRole("switch", { name: /headless/i }));
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ defaultRunHeadless: true }),
      ),
    );
  });

  it("sends one key per call, so the backend merge is unambiguous", async () => {
    // Every feature writes settings independently; a patch carrying unrelated
    // keys would let one pane's stale copy overwrite another's write.
    await renderSettings({ pane: "test-defaults" });
    fireEvent.click(await screen.findByRole("switch", { name: /headless/i }));
    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    expect(Object.keys(setSettings.mock.calls[0][0])).toEqual(["defaultRunHeadless"]);
  });

  it("reflects a stored value rather than a hardcoded default", async () => {
    settings = { ...settings, defaultTestTimeoutMs: 180_000 };
    await renderSettings({ pane: "test-defaults" });
    const input = (await screen.findByRole("spinbutton", {
      name: /default test timeout/i,
    })) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("180"));
  });

  it("survives a settings load that resolves to nothing", async () => {
    // A RESOLVED null does not reach the catch. It used to go straight into
    // state, and the first pane to read a key off it crashed the screen — the
    // rail still rendered, so the failure looked like a blank content area
    // rather than an error.
    settings = null as unknown as Partial<RecorderSettings>;
    await renderSettings({ pane: "appearance" });
    // The PANE, not just the rail.
    expect(await screen.findByRole("switch", { name: /ai thinking gif/i })).toBeTruthy();
  });
});

describe("search", () => {
  it("narrows the rail to panes that hold a match", async () => {
    await renderSettings({ pane: "test-defaults" });
    search("headers");
    await waitFor(() => expect(screen.queryByText("Storage")).toBeNull());
    expect(railRow("Test defaults")).toBeTruthy();
  });

  it("narrows the pane to the matching rows", async () => {
    settings = { ...settings, defaultRecordLogs: true };
    await renderSettings({ pane: "test-defaults" });
    search("headers");
    expect(
      await screen.findByRole("switch", { name: /include all request headers/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /headless/i })).toBeNull();
  });

  it("moves off a pane the search emptied", async () => {
    // Staying put would show an empty pane beside a rail advertising matches
    // elsewhere — which reads as broken search rather than a narrowed list.
    await renderSettings({ pane: "appearance" });
    search("webkit");
    await waitFor(() =>
      expect(nav.last()).toEqual({
        to: "/settings/$pane",
        params: { pane: "test-defaults" },
        replace: true,
      }),
    );
  });

  it("replaces rather than pushes when the search moves you", async () => {
    // A history entry per keystroke would make Back walk out of Settings one
    // letter at a time instead of returning where you came from.
    await renderSettings({ pane: "appearance" });
    search("webkit");
    await waitFor(() => expect(nav.last()?.replace).toBe(true));
  });

  it("stays put when the query matches nothing anywhere", async () => {
    // There is nowhere to move to. Navigating to "the first pane with hits"
    // when there are none would be a navigation to nowhere.
    await renderSettings({ pane: "appearance" });
    search("zzzznotasetting");
    await waitFor(() => expect(screen.getByText(/No settings match/i)).toBeTruthy());
    expect(nav.calls).toHaveLength(0);
  });

  it("names the query in the empty state", async () => {
    await renderSettings({ pane: "appearance" });
    search("zzzznotasetting");
    expect(await screen.findByText(/zzzznotasetting/)).toBeTruthy();
  });

  it("says so on the board too", async () => {
    await renderSettings();
    search("zzzznotasetting");
    expect(await screen.findByText(/No settings match/i)).toBeTruthy();
  });

  it("narrows the board to the sections that hold a match", async () => {
    await renderSettings();
    search("headers");
    await waitFor(() => expect(screen.queryByText("Storage")).toBeNull());
    expect(screen.getAllByText("Test defaults").length).toBeGreaterThan(0);
  });

  it("restores everything when the search is cleared", async () => {
    // "headers" empties Appearance, so the search moves to Test defaults —
    // which is what makes this the interesting case: clearing must bring the
    // whole rail back AND un-filter the pane it left you on, rather than
    // restoring one and not the other.
    await renderSettings({ pane: "appearance" });
    search("headers");
    await waitFor(() => expect(screen.queryByText("Storage")).toBeNull());
    search("");
    await waitFor(() => expect(screen.getByText("Storage")).toBeTruthy());
    expect(screen.getByRole("switch", { name: /headless/i })).toBeTruthy();
  });

  it("treats a whitespace-only query as no search", async () => {
    await renderSettings({ pane: "appearance" });
    search("   ");
    await waitFor(() => expect(screen.getByText("Storage")).toBeTruthy());
    expect(screen.queryByText(/No settings match/i)).toBeNull();
  });
});

describe("the reset footer", () => {
  it("is absent when the pane is at its defaults", async () => {
    await renderSettings({ pane: "auto-heal" });
    expect(screen.queryByRole("button", { name: /reset section/i })).toBeNull();
  });

  it("appears once something differs", async () => {
    settings = { ...settings, autoHealRetries: 9 };
    await renderSettings({ pane: "auto-heal" });
    expect(await screen.findByText(/1 setting differs from the default/i)).toBeTruthy();
  });

  it("counts more than one", async () => {
    settings = { ...settings, autoHealRetries: 9, autoHealEnabled: false };
    await renderSettings({ pane: "auto-heal" });
    expect(await screen.findByText(/2 settings differ from the default/i)).toBeTruthy();
  });

  it("writes every one of the pane's keys back to its default", async () => {
    settings = { ...settings, autoHealRetries: 9 };
    await renderSettings({ pane: "auto-heal" });
    fireEvent.click(await screen.findByRole("button", { name: /reset section/i }));
    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    expect(setSettings).toHaveBeenCalledWith({
      autoHealEnabled: true,
      autoHealApply: "suggest",
      autoHealRetries: 3,
      autoHealAttemptTimeoutMs: 4000,
    });
  });

  it("never touches a credential", async () => {
    // safeStorage holds the webhook URL and the API key; this screen cannot
    // read one back, so it must not be able to delete one either.
    settings = { ...settings, notifyOnRunIssues: true };
    await renderSettings({ pane: "alerts" });
    fireEvent.click(await screen.findByRole("button", { name: /reset section/i }));
    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    const patch = setSettings.mock.calls[0][0];
    // Every plain setting on the pane, and NOTHING else — the assertion is the
    // exhaustive key list precisely so a credential added here later fails
    // loudly rather than being quietly resettable.
    expect(Object.keys(patch).slice().sort()).toEqual([
      "aiInsightsCadence",
      "aiInsightsEnabled",
      "notifyOnAiDebugDone",
      "notifyOnBatchDone",
      "notifyOnInsightsReady",
      "notifyOnRunIssues",
    ]);
  });

  it("never touches a credential on the Integrations pane either", async () => {
    // The pane the guarantee matters most on: it holds FOUR credentials — the
    // Linear key, two webhook URLs and the GitHub token — and none of them is
    // a `RecorderSettings` key, so none may appear in a reset patch. The
    // exhaustive list is the point: a credential wired up as a setting later
    // fails here rather than becoming quietly resettable from a screen that
    // cannot even read it back.
    settings = { ...settings, alertWebhookEnabled: true };
    await renderSettings({ pane: "integrations" });
    fireEvent.click(await screen.findByRole("button", { name: /reset section/i }));
    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    const patch = setSettings.mock.calls[0][0];
    expect(Object.keys(patch).slice().sort()).toEqual([
      "alertWebhookEnabled",
      "insightsSlackEnabled",
    ]);
  });

  it("is hidden while a search is running", async () => {
    // The footer describes a whole pane; with the pane filtered to two rows it
    // would be counting settings that aren't on screen.
    settings = { ...settings, autoHealRetries: 9 };
    await renderSettings({ pane: "auto-heal" });
    await screen.findByRole("button", { name: /reset section/i });
    search("heal");
    await waitFor(() => expect(screen.queryByRole("button", { name: /reset section/i })).toBeNull());
  });
});

describe("the frame between the scope and the screen", () => {
  // THE BUG THIS PINS WAS REAL AND WAS SILENT. `RootShell` mounts
  // `SettingsScope` from its own reading of the pathname; the outlet renders
  // these screens and `LibrarySidebar` renders the rail rows from theirs. Three
  // subscriptions to one router store, and React does not promise they
  // re-render in the same commit — so clicking Back out of Settings dropped the
  // scope while the outlet was still showing the screen, and every one of them
  // threw "useSettingsController must be used inside <SettingsProvider>" into
  // the console. It recovered a beat later, when the navigation landed and
  // re-rendered everything consistently, which is exactly what made it
  // invisible: the screen looked right and only the log said otherwise.
  //
  // Rendering NOTHING is the correct answer, and the important half of it is
  // what these must not do — draw a settings screen out of default values, or
  // a rail of panes with no counts. Whatever renders here is on its way off
  // screen.
  //
  // Verified by reverting: with the throwing read, all three of these fail.
  const bare = (ui: React.ReactElement) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  };

  it("renders the board as nothing rather than throwing", () => {
    const { container } = bare(<SettingsView />);
    expect(container.textContent).toBe("");
  });

  it("renders a pane as nothing rather than throwing", () => {
    nav.params = { pane: "storage" };
    const { container } = bare(<SettingsPaneView />);
    expect(container.textContent).toBe("");
  });

  it("renders the rail rows as nothing rather than throwing", () => {
    const { container } = bare(<SettingsRailRows />);
    expect(container.textContent).toBe("");
  });

  it("still refuses to render a PANE without a controller", () => {
    // The throwing read stays where it earns its keep. A pane drawn outside
    // the provider would show every control at its fallback and save nothing,
    // which is a settings screen that lies rather than one that is leaving.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => bare(<StoragePane />)).toThrow(/SettingsProvider/);
    spy.mockRestore();
  });
});

describe("escape", () => {
  it("does nothing", async () => {
    // IT USED TO CLOSE THE WINDOW. There is no window and no close now, and
    // this screen deliberately installs no global Escape handler: the main
    // window's command palette, AI debug panel and every dialog already own
    // that key, and a fourth claimant would be competing to do what Back does.
    await renderSettings({ pane: "appearance" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(invoke).not.toHaveBeenCalled();
    expect(nav.calls).toHaveLength(0);
  });
});
