// Tests for the shared Settings row.
//
// The row is where three redesign decisions actually live, so this is where
// they can regress:
//
//   • The disclosure. It is the reason the window fits on a screen; a row that
//     forgets to offer it just renders a wall again.
//   • The danger rule — `danger` suppresses `details`. This is the one
//     assertion here with a security consequence: the two rows that carry it
//     warn about storing credentials and about sending data off the Mac, and a
//     warning behind a click is a warning nobody reads. It must hold even when
//     a caller passes `details` anyway, because the next person to add a
//     dangerous row will.
//   • Search filtering. It happens at the row so panes have ONE rendering path.
//     If a filtered row rendered anyway, search would look like it worked while
//     showing everything.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Switch } from "@ui";

import { RowFilterProvider, SettingRow, useRowVisible } from "./setting-row";

describe("content", () => {
  it("renders the label and the summary", () => {
    render(<SettingRow id="x" label="Run headless" summary="No visible window." />);
    expect(screen.getByText("Run headless")).toBeTruthy();
    expect(screen.getByText(/no visible window/i)).toBeTruthy();
  });

  it("renders the control it is given", () => {
    render(
      <SettingRow id="x" label="Run headless">
        <Switch id="x" />
      </SettingRow>,
    );
    expect(screen.getByRole("switch")).toBeTruthy();
  });

  it("wires the label to the control", () => {
    // One id for the row, the index entry and the control. A label pointing at
    // nothing still LOOKS right — it just stops toggling the switch when
    // clicked, and stops naming it for getByRole.
    render(
      <SettingRow id="run-headless" label="Run headless">
        <Switch id="run-headless" />
      </SettingRow>,
    );
    expect(screen.getByRole("switch", { name: /run headless/i })).toBeTruthy();
  });

  it("renders without a summary", () => {
    // Rows whose control is self-explanatory (Model) pass none.
    render(<SettingRow id="x" label="Model" />);
    expect(screen.getByText("Model")).toBeTruthy();
  });

  it("tags the row with its setting id", () => {
    const { container } = render(<SettingRow id="auto-heal-retries" label="Heal attempts" />);
    expect(container.querySelector('[data-setting-row="auto-heal-retries"]')).toBeTruthy();
  });
});

describe("the details disclosure", () => {
  it("hides details behind a trigger", () => {
    render(
      <SettingRow id="x" label="L" summary="Short version." details="The long version." />,
    );
    expect(screen.queryByText("The long version.")).toBeNull();
    expect(screen.getByRole("button", { name: /more/i })).toBeTruthy();
  });

  it("reveals them when the trigger is clicked", () => {
    render(
      <SettingRow id="x" label="L" summary="Short version." details="The long version." />,
    );
    fireEvent.click(screen.getByRole("button", { name: /more/i }));
    expect(screen.getByText("The long version.")).toBeTruthy();
  });

  it("collapses them again", () => {
    render(
      <SettingRow id="x" label="L" summary="Short version." details="The long version." />,
    );
    fireEvent.click(screen.getByRole("button", { name: /more/i }));
    fireEvent.click(screen.getByRole("button", { name: /less/i }));
    expect(screen.queryByText("The long version.")).toBeNull();
  });

  it("announces its state to assistive tech", () => {
    render(<SettingRow id="x" label="L" summary="S." details="D." />);
    const trigger = screen.getByRole("button", { name: /more/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: /less/i }).getAttribute("aria-expanded")).toBe("true");
  });

  it("points the trigger at the element it reveals", () => {
    render(<SettingRow id="row" label="L" summary="S." details="D." />);
    const trigger = screen.getByRole("button", { name: /more/i });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-controls")).toBe("row-details");
    expect(document.getElementById("row-details")).toBeTruthy();
  });

  it("offers no trigger when there is nothing more to say", () => {
    render(<SettingRow id="x" label="L" summary="All of it." />);
    expect(screen.queryByRole("button", { name: /more/i })).toBeNull();
  });

  it("offers no trigger when there is no summary to hang it off", () => {
    // details without summary would put a bare "More" under a naked label.
    render(<SettingRow id="x" label="L" details="Orphaned." />);
    expect(screen.queryByRole("button", { name: /more/i })).toBeNull();
    expect(screen.queryByText("Orphaned.")).toBeNull();
  });

  it("keeps each row's disclosure independent", () => {
    render(
      <>
        <SettingRow id="a" label="A" summary="SA." details="DA." />
        <SettingRow id="b" label="B" summary="SB." details="DB." />
      </>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: /more/i })[0]);
    expect(screen.getByText("DA.")).toBeTruthy();
    expect(screen.queryByText("DB.")).toBeNull();
  });
});

describe("danger rows never hide their warning", () => {
  it("renders the badge", () => {
    render(<SettingRow id="x" label="Include all headers" danger="stores credentials" />);
    expect(screen.getByText("stores credentials")).toBeTruthy();
  });

  it("keeps the whole explanation on screen with no disclosure", () => {
    // THE assertion. A credential warning behind a click is a warning nobody
    // reads, so `danger` refuses the disclosure outright rather than trusting
    // every future caller to leave `details` unset.
    render(
      <SettingRow
        id="x"
        label="Include all headers"
        danger="stores credentials"
        summary="Stores Authorization and Cookie."
        details="Should never be hidden."
      />,
    );
    expect(screen.getByText(/stores authorization and cookie/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /more/i })).toBeNull();
    // And the text passed as details is not silently dropped-but-reachable —
    // it is simply not rendered, so the caller sees their mistake.
    expect(screen.queryByText("Should never be hidden.")).toBeNull();
  });

  it("draws the accent rule", () => {
    const { container } = render(<SettingRow id="x" label="L" danger="risky" />);
    const row = container.querySelector('[data-setting-row="x"]');
    expect(row?.className).toContain("border-l-red-9");
  });

  it("squares the corners on the accent rule", () => {
    // A single-sided border with rounded corners renders as a detached arc.
    const { container } = render(<SettingRow id="x" label="L" danger="risky" />);
    expect(container.querySelector('[data-setting-row="x"]')?.className).toContain("rounded-none");
  });

  it("draws no badge or rule on an ordinary row", () => {
    const { container } = render(<SettingRow id="x" label="L" summary="S." />);
    const row = container.querySelector('[data-setting-row="x"]');
    expect(row?.className ?? "").not.toContain("border-l-red-9");
  });
});

describe("nested rows", () => {
  it("indents under the row above", () => {
    const { container } = render(<SettingRow id="x" label="Child" nested />);
    const row = container.querySelector('[data-setting-row="x"]');
    expect(row?.className).toContain("ml-4");
    expect(row?.className).toContain("border-l-2");
  });

  it("uses the danger rule when the nested row is itself dangerous", () => {
    // record-all-headers is both nested under its parent AND a credential
    // risk; the accent must be the red one, not the neutral dependency rule.
    const { container } = render(<SettingRow id="x" label="Child" nested danger="risky" />);
    expect(container.querySelector('[data-setting-row="x"]')?.className).toContain("border-l-red-9");
  });

  it("uses the neutral rule when it is not", () => {
    const { container } = render(<SettingRow id="x" label="Child" nested />);
    const cls = container.querySelector('[data-setting-row="x"]')?.className ?? "";
    expect(cls).toContain("border-l-separator");
    expect(cls).not.toContain("border-l-red-9");
  });

  it("does not indent a top-level row", () => {
    const { container } = render(<SettingRow id="x" label="Top" />);
    expect(container.querySelector('[data-setting-row="x"]')?.className ?? "").not.toContain("ml-4");
  });
});

describe("search filtering", () => {
  it("renders every row when no search is active", () => {
    render(
      <RowFilterProvider matchedIds={null}>
        <SettingRow id="a" label="Alpha" />
        <SettingRow id="b" label="Beta" />
      </RowFilterProvider>,
    );
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
  });

  it("renders only the matched rows", () => {
    render(
      <RowFilterProvider matchedIds={["a"]}>
        <SettingRow id="a" label="Alpha" />
        <SettingRow id="b" label="Beta" />
      </RowFilterProvider>,
    );
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("renders nothing when a search matches none of the rows", () => {
    render(
      <RowFilterProvider matchedIds={[]}>
        <SettingRow id="a" label="Alpha" />
      </RowFilterProvider>,
    );
    expect(screen.queryByText("Alpha")).toBeNull();
  });

  it("distinguishes an empty match list from no search", () => {
    // `[]` means "searched, found nothing"; `null` means "not searching". If
    // these collapsed, an unmatched search would show the whole window.
    const { rerender } = render(
      <RowFilterProvider matchedIds={[]}>
        <SettingRow id="a" label="Alpha" />
      </RowFilterProvider>,
    );
    expect(screen.queryByText("Alpha")).toBeNull();
    rerender(
      <RowFilterProvider matchedIds={null}>
        <SettingRow id="a" label="Alpha" />
      </RowFilterProvider>,
    );
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("hides the control along with the row", () => {
    // A filtered row that left its Switch mounted would keep the setting
    // toggleable by keyboard from a pane that appears not to contain it.
    render(
      <RowFilterProvider matchedIds={["b"]}>
        <SettingRow id="a" label="Alpha">
          <Switch id="a" />
        </SettingRow>
      </RowFilterProvider>,
    );
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("treats a row outside any provider as visible", () => {
    // Panes are rendered directly in tests; a missing provider must not blank
    // the window.
    render(<SettingRow id="a" label="Alpha" />);
    expect(screen.getByText("Alpha")).toBeTruthy();
  });
});

describe("useRowVisible", () => {
  function Probe({ id }: { id: string }) {
    return <span>{useRowVisible(id) ? "visible" : "hidden"}</span>;
  }

  it("reports visible with no active search", () => {
    render(
      <RowFilterProvider matchedIds={null}>
        <Probe id="a" />
      </RowFilterProvider>,
    );
    expect(screen.getByText("visible")).toBeTruthy();
  });

  it("reports hidden for an unmatched id", () => {
    render(
      <RowFilterProvider matchedIds={["b"]}>
        <Probe id="a" />
      </RowFilterProvider>,
    );
    expect(screen.getByText("hidden")).toBeTruthy();
  });

  it("lets a pane hide a sub-group whose rows all filtered away", () => {
    // The nested header/parent has to know, or it renders a dependency rule
    // pointing at nothing.
    const seen = vi.fn();
    function Group() {
      const parent = useRowVisible("parent");
      const child = useRowVisible("child");
      seen(parent, child);
      return <span>{parent || child ? "some" : "none"}</span>;
    }
    render(
      <RowFilterProvider matchedIds={["unrelated"]}>
        <Group />
      </RowFilterProvider>,
    );
    expect(screen.getByText("none")).toBeTruthy();
    expect(seen).toHaveBeenCalledWith(false, false);
  });
});
