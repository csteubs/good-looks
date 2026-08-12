// The branch menu's rows.
//
// The ORDERING and MATCHING rules are `renderer/lib/branch-menu.test.ts`'s job,
// in the node project, with no DOM. What is left for this file is what only
// exists once the model is drawn: that the pull-request icon is a real second
// control rather than a button nested inside a button, that it names which PR
// it opens, and that it goes through the validated shell seam.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BranchMenu } from "./branch-menu";
import type { BranchMenuModel } from "../lib/branch-menu";

const openExternal = vi.fn();

beforeEach(() => {
  openExternal.mockClear();
  (window as unknown as { glazeAPI: unknown }).glazeAPI = {
    shell: { openExternal, showItemInFolder: vi.fn() },
  };
});

function model(over: Partial<BranchMenuModel> = {}): BranchMenuModel {
  return {
    entries: [
      { branch: null, label: "main", detail: "You are here", current: true, home: true },
      {
        branch: "feat/a",
        label: "feat/a",
        detail: "add the thing",
        current: false,
        home: false,
        pull: {
          number: 42,
          title: "Add the thing",
          url: "https://github.com/csteubs/good-looks/pull/42",
          draft: false,
        },
      },
      { branch: "feat/b", label: "feat/b", detail: "fix the thing", current: false, home: false },
    ],
    hidden: 0,
    ...over,
  };
}

function renderMenu(over: Partial<BranchMenuModel> = {}, props: Partial<{ loading: boolean }> = {}) {
  const onChoose = vi.fn();
  const onSeeAll = vi.fn();
  render(
    <BranchMenu model={model(over)} onChoose={onChoose} onSeeAll={onSeeAll} {...props} />,
  );
  return { onChoose, onSeeAll };
}

describe("BranchMenu — the rows", () => {
  it("draws every entry the model gave it", () => {
    renderMenu();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("feat/a")).toBeTruthy();
    expect(screen.getByText("feat/b")).toBeTruthy();
  });

  it("shows the second line, which is what makes a generated branch name readable", () => {
    renderMenu();
    expect(screen.getByText("add the thing")).toBeTruthy();
  });

  it("reports the chosen branch, and null for the pinned row", () => {
    const { onChoose } = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /feat\/a/ }));
    expect(onChoose).toHaveBeenCalledWith("feat/a");

    fireEvent.click(screen.getByRole("menuitem", { name: /main/ }));
    expect(onChoose).toHaveBeenCalledWith(null);
  });

  it("marks the current row with an empty attribute, never the string 'false'", () => {
    // `[data-current]` matches an empty attribute, so `data-current="false"`
    // would style every row as current. The same trap `RailRow`'s
    // `data-selected` documents, and it is invisible on screen until two rows
    // are highlighted at once.
    renderMenu();
    const rows = screen.getAllByRole("menuitem");
    const marked = rows.filter((r) => r.hasAttribute("data-current"));
    expect(marked).toHaveLength(1);
    expect(marked[0].getAttribute("data-current")).toBe("");
    expect(marked[0].textContent).toContain("main");
  });
});

describe("BranchMenu — the pull-request icon", () => {
  it("is a sibling control, not a button nested inside the row's button", () => {
    // Nesting is invalid HTML, and browsers resolve it by DROPPING the inner
    // control — so the icon would render and do nothing, on a surface where
    // "nothing happened" is the expected result of hovering.
    renderMenu();
    const pr = screen.getByRole("menuitem", { name: /Open pull request #42/ });
    const branchRow = screen.getByRole("menuitem", { name: /feat\/a/ });
    expect(branchRow.contains(pr)).toBe(false);
    expect(pr.tagName).toBe("BUTTON");
  });

  it("opens the PR through the validated shell seam, with the URL the API gave", () => {
    // Not a constructed github.com URL: this file builds no URLs, which is why
    // there is no github.com string in the renderer for check:renderer-egress
    // to have an opinion about.
    renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Open pull request #42/ }));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/csteubs/good-looks/pull/42");
  });

  it("names WHICH pull request it opens", () => {
    // Six rows of "open pull request" tells a screen-reader user nothing.
    renderMenu();
    const pr = screen.getByRole("menuitem", { name: /Open pull request #42/ });
    expect(pr.getAttribute("aria-label")).toContain("#42");
    expect(pr.getAttribute("aria-label")).toContain("Add the thing");
  });

  it("says when the pull request is a draft", () => {
    renderMenu({
      entries: [
        { branch: null, label: "main", detail: "You are here", current: true, home: true },
        {
          branch: "feat/a",
          label: "feat/a",
          detail: "wip",
          current: false,
          home: false,
          pull: { number: 7, title: "Draft it", url: "https://github.com/o/r/pull/7", draft: true },
        },
      ],
    });
    expect(
      screen.getByRole("menuitem", { name: /Open pull request #7.*draft/i }),
    ).toBeTruthy();
  });

  it("gives rows without a pull request no icon at all", () => {
    renderMenu();
    // feat/b has no PR, so the only PR control in the menu is feat/a's.
    expect(screen.getAllByRole("menuitem", { name: /Open pull request/ })).toHaveLength(1);
  });

  it("does not choose the branch when the icon is clicked", () => {
    // Two controls on one row: clicking the icon must not also start a switch,
    // which in this app means a build and a relaunch.
    const { onChoose } = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Open pull request #42/ }));
    expect(onChoose).not.toHaveBeenCalled();
  });
});

describe("BranchMenu — the footer", () => {
  it("opens the full view", () => {
    const { onSeeAll } = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /All branches and pull requests/ }));
    expect(onSeeAll).toHaveBeenCalled();
  });

  it("says how many branches are not shown", () => {
    renderMenu({ hidden: 12 });
    expect(screen.getByText("12 more branches")).toBeTruthy();
  });

  it("does not say 'more' when the menu is the whole list", () => {
    // A footer promising more where there is none sends people to a view that
    // shows them exactly what they were already looking at.
    renderMenu({ hidden: 0 });
    expect(screen.queryByText(/more branch/)).toBeNull();
    expect(screen.getByText("Open the Branches view")).toBeTruthy();
  });

  it("says 'branch' for one and 'branches' for several", () => {
    renderMenu({ hidden: 1 });
    expect(screen.getByText("1 more branch")).toBeTruthy();
  });
});

describe("BranchMenu — nothing to show", () => {
  it("distinguishes 'still loading' from 'there are none'", () => {
    // Two different facts, and only one of them is worth acting on.
    const empty = {
      entries: [
        { branch: null, label: "main", detail: "You are here", current: true, home: true },
      ],
      hidden: 0,
    };
    const { unmount } = render(
      <BranchMenu model={empty} onChoose={vi.fn()} onSeeAll={vi.fn()} loading />,
    );
    expect(screen.getByText("Reading branches…")).toBeTruthy();
    unmount();

    render(<BranchMenu model={empty} onChoose={vi.fn()} onSeeAll={vi.fn()} />);
    expect(screen.getByText("No other branches on origin.")).toBeTruthy();
  });

  it("keeps the pinned row even with no branches", () => {
    // "Return to my checkout" is the row most worth having when everything
    // else failed to load.
    render(
      <BranchMenu
        model={{
          entries: [
            { branch: null, label: "main", detail: "Return to your checkout", current: false, home: true },
          ],
          hidden: 0,
        }}
        onChoose={vi.fn()}
        onSeeAll={vi.fn()}
      />,
    );
    expect(screen.getByText("main")).toBeTruthy();
  });
});
