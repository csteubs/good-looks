// The composed dialog's top-right corner: the close "X" plus whatever
// `headerActions` puts beside it.
//
// It exists for window-level controls — minimize being the first one — which
// belong with close rather than in the description row's icon strip, where a
// "put this away" gesture reads as another action on the content. The property
// worth pinning is placement, not appearance: the control must land inside the
// same corner group as the close button, because that group is what positions
// it (`absolute right-3 top-3`). A headerActions node rendered anywhere else
// still renders, still clicks, and still passes every by-role query — it just
// sits in the wrong corner, which is exactly the failure jsdom cannot see.
//
// Same limit as `dialog-actions.test.tsx`: jsdom has no layout engine and the
// dom project runs with `css: false`, so containment is asserted structurally
// and the padding class as a proxy for the title not running under the icons.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Dialog, dialogHeaderActionClass } from "./index";

function closeButton(): HTMLElement {
  return screen.getByRole("button", { name: "Close" });
}

/** The corner group that positions the close button and its neighbours. */
function cornerGroup(): HTMLElement {
  const el = closeButton().parentElement;
  if (!el) throw new Error("close button has no parent");
  return el;
}

describe("Dialog headerActions", () => {
  it("renders the action inside the same corner group as the close button", () => {
    render(
      <Dialog open title="Debugging with AI" description="Element Selector Test"
        headerActions={
          <button type="button" className={dialogHeaderActionClass} aria-label="Minimize">
            m
          </button>
        }
      >
        body
      </Dialog>,
    );

    const minimize = screen.getByRole("button", { name: "Minimize" });
    expect(cornerGroup().contains(minimize)).toBe(true);
    // Order matters: the action sits to the LEFT of close, so close stays in
    // the outermost corner where every dialog in the app puts it.
    const order = Array.from(cornerGroup().children);
    expect(order.indexOf(minimize)).toBeLessThan(order.indexOf(closeButton()));
  });

  it("keeps the action out of the description row", () => {
    render(
      <Dialog open title="Debugging with AI"
        description={<span data-testid="desc">Element Selector Test</span>}
        headerActions={
          <button type="button" aria-label="Minimize">
            m
          </button>
        }
      >
        body
      </Dialog>,
    );

    const desc = screen.getByTestId("desc").parentElement!;
    expect(desc.contains(screen.getByRole("button", { name: "Minimize" }))).toBe(false);
  });

  it("widens the header's right padding to clear the extra control", () => {
    const { rerender } = render(
      <Dialog open title="Debugging with AI">
        body
      </Dialog>,
    );
    const headerOf = () => screen.getByText("Debugging with AI").parentElement!;
    expect(headerOf().className).toContain("pr-6");

    rerender(
      <Dialog open title="Debugging with AI" headerActions={<button type="button">m</button>}>
        body
      </Dialog>,
    );
    expect(headerOf().className).toContain("pr-14");
    expect(headerOf().className).not.toContain("pr-6");
  });

  it("still renders the corner group when the close button is suppressed", () => {
    render(
      <Dialog open title="Debugging with AI" showCloseButton={false}
        headerActions={<button type="button" aria-label="Minimize">m</button>}
      >
        body
      </Dialog>,
    );

    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByRole("button", { name: "Minimize" })).toBeTruthy();
  });
});
