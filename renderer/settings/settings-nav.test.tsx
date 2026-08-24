// Tests for the Settings sidebar.
//
// The accessory does double duty — match count while searching, modified count
// otherwise — so most of the risk is in showing the wrong one, or showing a
// modified count before the settings have loaded (which flashes a badge on
// every pane each time Settings is opened).
//
// The other half is the search behaviour that makes the redesign worth having:
// a pane with no match must LEAVE the list, not sit there greyed. Greying keeps
// the list the same length, which hides the fact that search narrowed anything.
//
// THE ROWS AND THE FIELD ARE RENDERED TOGETHER HERE and are two components in
// the app, because `Rail` pins the search field ABOVE its scrolling body — see
// `settings-nav.tsx`. What is asserted is what the user sees in one rail, so
// the harness assembles both rather than testing half a sidebar.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { PANES, SETTINGS_DEFAULTS, matchCountByPane, searchSettings } from "../lib/settings-schema";
import { SettingsNav, SettingsSearchField } from "./settings-nav";
import type { SettingsNavProps } from "./settings-nav";

interface NavHarnessProps extends SettingsNavProps {
  search: string;
  onSearchChange: (value: string) => void;
}

function Nav({ search, onSearchChange, ...nav }: NavHarnessProps) {
  return (
    <>
      <SettingsSearchField value={search} onChange={onSearchChange} />
      <SettingsNav {...nav} />
    </>
  );
}

function renderNav(overrides: Partial<NavHarnessProps> = {}) {
  const props: NavHarnessProps = {
    selected: "appearance",
    onSelect: vi.fn(),
    search: "",
    onSearchChange: vi.fn(),
    matchCounts: null,
    settings: { ...SETTINGS_DEFAULTS },
    loaded: true,
    ...overrides,
  };
  return { ...render(<Nav {...props} />), props };
}

/** The sidebar row for a pane, by its visible title. */
function row(title: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(title, "i") });
}

/** CLICK SINCE B4, and that is a real behaviour change rather than a test edit.
 *  These rows were `SidebarListItem`, which fires on MOUSE-DOWN — the native
 *  macOS idiom, and a documented trap in this repo because `fireEvent.click`
 *  leaves such a row untouched and the assertion then reports "0 calls", which
 *  reads as a broken handler rather than as the wrong event. `RailRow` is an
 *  ordinary button, so a press that lands on a row and is dragged off it no
 *  longer selects the pane. */
function selectRow(title: string) {
  fireEvent.click(row(title));
}

describe("the pane list", () => {
  it("lists every pane", () => {
    renderNav();
    for (const pane of PANES) {
      expect(screen.getByText(pane.title), pane.id).toBeTruthy();
    }
  });

  it("renders the group headings", () => {
    renderNav();
    expect(screen.getByText("Testing")).toBeTruthy();
    expect(screen.getByText("Connections")).toBeTruthy();
  });

  it("puts Appearance first and the developer panes last", () => {
    // The segments model exists for exactly this. Bucketing by group value
    // would render Diagnostics directly under Appearance, at the top.
    const { container } = renderNav();
    const titles = Array.from(container.querySelectorAll("button"))
      .map((b) => b.textContent?.trim() ?? "")
      .filter((t) => PANES.some((p) => t.startsWith(p.title)));
    expect(titles[0]).toContain("Appearance");
    expect(titles[titles.length - 2]).toContain("Diagnostics");
    expect(titles[titles.length - 1]).toContain("Experiments");
  });

  it("selects a pane when its row is clicked", () => {
    const { props } = renderNav();
    selectRow("Storage");
    expect(props.onSelect).toHaveBeenCalledWith("storage");
  });

  it("marks the selected pane for assistive tech", () => {
    // Without this the rail announces nothing about which pane is showing.
    // `"true"` rather than `"page"` since B4: `RailRow` says it, and it says
    // the same thing about the library rows this list replaces.
    renderNav({ selected: "storage" });
    expect(row("Storage").getAttribute("aria-current")).toBe("true");
  });

  it("marks only the selected pane", () => {
    renderNav({ selected: "storage" });
    expect(row("Appearance").getAttribute("aria-current")).toBeNull();
  });

  it("marks nothing on the board", () => {
    // `/settings` is a screen of its own and is not one of these rows, so no
    // row may claim to be what is showing. `selected` is undefined there — and
    // a nav that defaulted to Appearance would put a current row beside a
    // screen that is not it.
    const { container } = renderNav({ selected: undefined });
    // Counted off the attribute rather than row by row: `row()` matches on a
    // substring, and "AI" is inside "Failure reasons".
    expect(container.querySelectorAll("[aria-current]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-selected]")).toHaveLength(0);
  });

  it("styles the selected row", () => {
    // Belt and braces: aria-current is for screen readers, the attribute below
    // is what a sighted user sees. Losing either one is a real regression.
    //
    // `data-selected` and not a class, and BARE rather than `="false"` on the
    // others: `RailRow` carries the whole selection treatment on that attribute
    // so `check:selection-neutral` can prove no selection in this app is drawn
    // in a status colour, and `[data-selected]` matches an empty attribute — a
    // literal `data-selected="false"` would style every row as selected.
    renderNav({ selected: "storage" });
    expect(row("Storage").hasAttribute("data-selected")).toBe(true);
    expect(row("Appearance").hasAttribute("data-selected")).toBe(false);
  });
});

describe("the modified-count badge", () => {
  it("is absent when everything is at its default", () => {
    const { container } = renderNav();
    expect(container.querySelectorAll("[aria-label*='changed from default']")).toHaveLength(0);
  });

  it("counts a pane's changed settings", () => {
    renderNav({
      settings: { ...SETTINGS_DEFAULTS, autoHealRetries: 9, autoHealEnabled: false },
    });
    expect(within(row("Auto-Heal")).getByLabelText(/2 changed from default/i)).toBeTruthy();
  });

  it("counts only the owning pane's settings", () => {
    renderNav({ settings: { ...SETTINGS_DEFAULTS, autoHealRetries: 9 } });
    expect(within(row("Auto-Heal")).getByLabelText(/1 changed from default/i)).toBeTruthy();
    expect(within(row("Storage")).queryByLabelText(/changed from default/i)).toBeNull();
  });

  it("shows nothing until the settings have loaded", () => {
    // Mid-load `settings` is `{}`. A count drawn then would flash on open.
    const { container } = renderNav({ loaded: false, settings: {} });
    expect(container.querySelectorAll("[aria-label*='changed from default']")).toHaveLength(0);
  });

  it("does not count a setting that merely arrived from JSON", () => {
    // `disabledAestheticEnhancements` is a fresh array on every load; reference
    // equality would permanently badge Appearance.
    renderNav({ settings: { ...SETTINGS_DEFAULTS, disabledAestheticEnhancements: [] } });
    expect(within(row("Appearance")).queryByLabelText(/changed from default/i)).toBeNull();
  });
});

describe("search", () => {
  it("passes typing up to the shell", () => {
    const { props } = renderNav();
    fireEvent.change(screen.getByPlaceholderText(/search settings/i), {
      target: { value: "headless" },
    });
    expect(props.onSearchChange).toHaveBeenCalledWith("headless");
  });

  it("drops panes with no match from the list entirely", () => {
    const counts = matchCountByPane(searchSettings("headers"));
    renderNav({ search: "headers", matchCounts: counts });
    expect(screen.getByText("Test defaults")).toBeTruthy();
    expect(screen.queryByText("Storage")).toBeNull();
    expect(screen.queryByText("Auto-Heal")).toBeNull();
  });

  it("shows the match count instead of the modified count", () => {
    const counts = matchCountByPane(searchSettings("heal"));
    renderNav({
      search: "heal",
      matchCounts: counts,
      // Auto-Heal also has a modified setting; the search count must win.
      settings: { ...SETTINGS_DEFAULTS, autoHealRetries: 9 },
    });
    const autoHeal = row("Auto-Heal");
    expect(autoHeal.textContent).toContain("4");
    expect(within(autoHeal).queryByLabelText(/changed from default/i)).toBeNull();
  });

  it("hides a group heading whose panes all filtered away", () => {
    // "slack" reaches the webhook rows, which live in Integrations since the
    // pane split — Alerts keeps only the local notifications.
    const counts = matchCountByPane(searchSettings("slack"));
    renderNav({ search: "slack", matchCounts: counts });
    expect(screen.getByText("Integrations")).toBeTruthy();
    expect(screen.queryByText("Testing")).toBeNull();
  });

  it("finds the manual by a word only the manual uses", () => {
    // The reason the Documentation pane is indexed on full text at all. Before
    // it, searching "mcp" in Settings returned exactly one result — the debug
    // screenshot toggle, whose keywords happen to include the acronym — and
    // nothing in the app explained what an MCP client was for.
    const counts = matchCountByPane(searchSettings("mcp"));
    renderNav({ search: "mcp", matchCounts: counts });
    const docs = row("Documentation");
    expect(docs.textContent).toMatch(/\d/);
  });

  it("does not put the manual first when a search misses the open pane", () => {
    // `settings-scope` moves to the FIRST pane with a hit. Docs match on full
    // text, so if they were indexed ahead of the settings almost every search
    // would jump out of the controls and into the prose about them.
    const first = Object.keys(matchCountByPane(searchSettings("webhook")))[0];
    expect(first).not.toBe("documentation");
  });

  it("renders an empty list rather than everything when nothing matches", () => {
    // `{}` means "searched, found nothing". Falling back to the full list here
    // would make an unmatched search look like a cleared one.
    renderNav({ search: "zzzz", matchCounts: {} });
    for (const pane of PANES) {
      expect(screen.queryByText(pane.title), pane.id).toBeNull();
    }
  });

  it("restores the full list when the search is cleared", () => {
    const { rerender } = renderNav({ search: "slack", matchCounts: matchCountByPane(searchSettings("slack")) });
    expect(screen.queryByText("Storage")).toBeNull();
    rerender(
      <Nav
        selected="appearance"
        onSelect={vi.fn()}
        search=""
        onSearchChange={vi.fn()}
        matchCounts={null}
        settings={{ ...SETTINGS_DEFAULTS }}
        loaded
      />,
    );
    expect(screen.getByText("Storage")).toBeTruthy();
  });
});

describe("icons", () => {
  it("gives every pane one", () => {
    // A missing entry in PANE_ICONS renders as a crash, not a blank — the map
    // is keyed by PaneId, so this also pins that the map stays exhaustive.
    const { container } = renderNav();
    for (const pane of PANES) {
      const el = screen.getByText(pane.title).closest("button");
      expect(el?.querySelector("svg"), pane.id).toBeTruthy();
    }
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(PANES.length);
  });
});
