// The category board.
//
// The arithmetic is proved in `renderer/lib/stats-categories.test.ts`, in the
// node project, where a wrong number is easiest to catch. What only a rendered
// test can prove is the part that ties a number to a control: that the board
// draws one tile per REGISTRY ENTRY rather than per hardcoded list, that the
// four states look different on screen, and that pressing a tile navigates.
//
// Wait for CONTENT, not containers (CLAUDE.md): the panel renders before its
// summaries exist, so asserting on the panel would pass against an empty board.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { CategoryBoard } from "./category-board";
import { CATEGORIES, type CategorySummary } from "../../lib/stats-categories";

function summary(over: Partial<CategorySummary> & { id: CategorySummary["id"] }): CategorySummary {
  return {
    state: "clean",
    display: "0",
    say: "nothing to report",
    window: "3 runs",
    tone: "phos",
    ...over,
  };
}

/** One summary per registry entry, so the board renders complete. */
function allClean(): CategorySummary[] {
  return CATEGORIES.map((c) => summary({ id: c.id }));
}

function tiles(): HTMLElement[] {
  return screen.getAllByRole("button").filter((b) => b.className.includes("gl-tile"));
}

describe("the board", () => {
  it("draws one tile per registry entry, counted against the registry", () => {
    // Asserted against CATEGORIES rather than against the number 7 — adding a
    // category without a tile is the bug a registry makes impossible, and a
    // hardcoded count here would let it through.
    render(<CategoryBoard summaries={allClean()} onOpen={() => {}} />);
    expect(tiles()).toHaveLength(CATEGORIES.length);
    for (const c of CATEGORIES) {
      expect(screen.getByText(c.short), `${c.id} has a tile`).toBeTruthy();
    }
  });

  it("renders nothing at all before any category has answered", () => {
    // An empty board would read as "you have no categories", which is not a
    // state this feature has.
    const { container } = render(<CategoryBoard summaries={[]} onOpen={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("navigates with the category id when a tile is pressed", () => {
    const onOpen = vi.fn();
    render(<CategoryBoard summaries={allClean()} onOpen={onOpen} />);
    // A real <button>, so a plain click works — the SDK's pointer-down controls
    // are why so much of this suite reaches for fireEvent.mouseDown.
    fireEvent.click(screen.getByText("Stability").closest("button")!);
    expect(onOpen).toHaveBeenCalledWith("stability");
  });

  it("disables a category whose dashboard is not built, instead of dead-linking", () => {
    const onOpen = vi.fn();
    render(<CategoryBoard summaries={allClean()} onOpen={onOpen} openable={["stability"]} />);
    const visual = screen.getByText("Visual").closest("button")!;
    expect(visual.hasAttribute("disabled")).toBe(true);
    fireEvent.click(visual);
    expect(onOpen).not.toHaveBeenCalled();
    // …and it says why, rather than looking broken.
    expect(visual.getAttribute("title")).toMatch(/no dashboard/i);
  });
});

describe("zero and never-measured do not look the same", () => {
  // The rendered half of the rule the whole feature rests on. The node tests
  // prove `display` is null; this proves nothing downstream prints a 0 anyway.

  it("prints the number when a category measured and found nothing", () => {
    render(
      <CategoryBoard summaries={[summary({ id: "a11y", state: "clean", display: "0" })]} onOpen={() => {}} />,
    );
    const tile = screen.getByText("A11y").closest("button")!;
    expect(within(tile).getByText("0")).toBeTruthy();
  });

  it("prints NO number when a category was never measured", () => {
    render(
      <CategoryBoard
        summaries={[
          summary({
            id: "a11y",
            state: "unmeasured",
            display: null,
            tone: null,
            window: null,
            say: "Switch on “Check accessibility” beside Run test.",
          }),
        ]}
        onOpen={() => {}}
      />,
    );
    const tile = screen.getByText("A11y").closest("button")!;
    // Asserted on the VALUE SLOT rather than on the tile's text. The first
    // version of this test checked the whole tile for a digit and failed on the
    // category's own name — "A11y" — which is a good illustration of why the
    // slot is the right subject: the rule is "no number is presented as this
    // category's reading", not "no digit appears".
    expect(tile.querySelector(".gl-tile-value")).toBeNull();
    expect(tile.querySelector(".gl-tile-none")).not.toBeNull();
    expect(within(tile).getByText("Not checked")).toBeTruthy();
    expect(within(tile).getByText(/check accessibility/i)).toBeTruthy();
  });

  it("distinguishes never-measured from the mechanism being unavailable", () => {
    render(
      <CategoryBoard
        summaries={[
          summary({ id: "a11y", state: "unmeasured", display: null, tone: null, window: null }),
          summary({ id: "steps", state: "unavailable", display: null, tone: null, window: null }),
        ]}
        onOpen={() => {}}
      />,
    );
    expect(within(screen.getByText("A11y").closest("button")!).getByText("Not checked")).toBeTruthy();
    expect(within(screen.getByText("Steps").closest("button")!).getByText("No data")).toBeTruthy();
  });

  it("carries the reading in the tile's accessible name", () => {
    // The tile's parts are separate elements; without this a screen reader
    // announces three unrelated fragments.
    render(
      <CategoryBoard
        summaries={[summary({ id: "stability", state: "findings", display: "3", say: "3 tests are not settled", tone: "amber" })]}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Stability: 3 — 3 tests are not settled/ })).toBeTruthy();
  });
});

describe("the band", () => {
  it("counts categories in a state and never their values", () => {
    render(
      <CategoryBoard
        summaries={[
          summary({ id: "a11y", state: "findings", display: "9999" }),
          summary({ id: "stability", state: "clean", display: "0" }),
          summary({ id: "visual", state: "unmeasured", display: null }),
        ]}
        onOpen={() => {}}
      />,
    );
    expect(
      screen.getByText(
        "1 category needs attention, 1 is clean, and 1 has never been measured.",
      ),
    ).toBeTruthy();
    // The one number that must NOT appear anywhere in the band.
    const band = screen.getByText(/needs attention/).closest(".gl-band")!;
    expect(band.textContent).not.toContain("9999");
  });

  it("shows a skeleton, not an unmeasured tile, for a query still in flight", () => {
    // "Loading" and "you have never switched this on" are different sentences,
    // and flashing the second at someone who switched it on last week is the
    // rule breaking on a technicality.
    render(<CategoryBoard summaries={[summary({ id: "outcomes" })]} onOpen={() => {}} />);
    expect(screen.queryByText("Not checked")).toBeNull();
    // Six of the seven have not answered, so six skeletons.
    expect(document.querySelectorAll(".gl-tile-loading")).toHaveLength(CATEGORIES.length - 1);
  });
});
