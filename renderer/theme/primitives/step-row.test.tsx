import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { StepRow } from "./step-row";
import { SEL_RING, TONE, hexToRgb } from "../tokens";

/** Does this style text mention that hue, in EITHER notation?
 *
 *  jsdom normalises `color` and `background` to `rgb()`/`rgba()` but leaves
 *  `box-shadow` exactly as written. A negative assertion checking only one form
 *  can therefore never fire — which is what the "selection is never a status
 *  hue" test below was doing before this helper existed, and it is the precise
 *  shape of vacuous test CLAUDE.md warns about. */
function mentions(styleText: string, hex: string): boolean {
  const [r, g, b] = hexToRgb(hex) as [number, number, number];
  return (
    styleText.toLowerCase().includes(hex.toLowerCase()) || styleText.includes(`rgb(${r}, ${g}, ${b})`)
  );
}

function row(): HTMLElement {
  return document.querySelector('[data-gl="step-row"]') as HTMLElement;
}

describe("<StepRow />", () => {
  it("draws status as an inset rail, not a border", () => {
    // A real `border` participates in layout, so a list where some rows have
    // one and some do not jumps by 2px per status change. `renderer/styles.css`
    // records this exact bug being fixed once already, for `.step-new`.
    render(<StepRow index={1} type="click" description="Sign in" tone="red" />);
    expect(row().style.boxShadow).toContain("inset 2px 0 0");
    expect(row().style.border).toBe("");
    expect(row().style.borderLeft).toBe("");
  });

  it("composes the status rail and the selection ring rather than choosing between them", () => {
    // THE ONE THAT MATTERS. A row can be selected AND failing, and neither
    // claim may hide the other. Both are box-shadows on the same element, so
    // the failure mode is one silently replacing the other — which is exactly
    // what happened when `.step-new` animated the whole `box-shadow` property
    // and erased the selection highlight.
    render(<StepRow index={1} type="click" description="Sign in" tone="red" selected />);
    const shadow = row().style.boxShadow;
    expect(shadow).toContain("inset 2px 0 0");
    expect(shadow).toContain("inset 0 0 0 1px");
  });

  it("uses a neutral selection treatment, never a status hue", () => {
    // Pinned here as behaviour and at source level by
    // `check:selection-neutral`. A green selected row would be a second thing
    // on the row claiming to report an outcome.
    render(<StepRow index={1} type="click" description="Sign in" selected />);
    const styles = `${row().style.background} ${row().style.boxShadow}`;
    for (const tone of Object.values(TONE)) {
      expect(mentions(styles, tone), `selection used ${tone}`).toBe(false);
    }
    expect(row().style.boxShadow).toContain("255, 255, 255");
    expect(SEL_RING).toContain("255, 255, 255");
  });

  it("has no shadow at all when a step has neither run nor been selected", () => {
    // An unrun step is not a neutral-grey outcome, it is the absence of one.
    render(<StepRow index={1} type="click" description="Sign in" />);
    expect(row().style.boxShadow).toBe("");
    expect(row().dataset.tone).toBe("none");
  });

  it("shows the number the reader counts from", () => {
    // A failure report that says "step 0" costs someone a minute working out
    // whether it means the first step or the one before it.
    render(<StepRow index={1} type="click" description="Sign in" />);
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("indents nested steps without moving the rail off the edge", () => {
    // The rail marks the ROW, so it stays at the row's leading edge whatever
    // the nesting; the indent is padding inside it.
    render(<StepRow index={3} type="click" description="Buy" tone="phos" indent={2} />);
    expect(row().style.paddingInlineStart).toBe("44px");
    expect(row().style.boxShadow).toContain("inset 2px 0 0");
  });

  it("renders a Temp only when there is a timing", () => {
    const { rerender } = render(<StepRow index={1} type="click" description="Sign in" />);
    expect(document.querySelector('[data-gl="temp"]')).toBeNull();

    rerender(<StepRow index={1} type="click" description="Sign in" ms={1200} median={1000} />);
    expect(document.querySelector('[data-gl="temp"]')).not.toBeNull();
  });

  it("passes a missing median through to Temp, which refuses to colour a guess", () => {
    render(<StepRow index={1} type="click" description="Sign in" ms={1200} />);
    expect((document.querySelector('[data-gl="temp"]') as HTMLElement).dataset.mode).toBe("off");
  });

  it("selects on click", () => {
    const onSelect = vi.fn();
    render(<StepRow index={1} type="click" description="Sign in" onSelect={onSelect} />);
    fireEvent.click(row());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("keeps trailing controls clickable in their own right", () => {
    // They are not nested inside a button — which would be invalid markup and
    // would swallow their clicks.
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(
      <StepRow
        index={1}
        type="click"
        description="Sign in"
        onSelect={onSelect}
        right={<button onClick={onDelete}>Delete</button>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("gives the truncating description its full text as a title", () => {
    const long = "Click the button labelled Continue to checkout in the order summary panel";
    render(<StepRow index={1} type="click" description={long} />);
    expect(screen.getByText(long).getAttribute("title")).toBe(long);
  });
});
