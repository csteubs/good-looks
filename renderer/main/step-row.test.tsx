// Component tests for the step row.
//
// StepRow is the most-reused component in the app — it renders every step in
// the trainer, the step editor and the test detail view — so a regression here
// shows up in three places at once. It's also where run status becomes visible:
// the pass/fail highlight during a run is this component's job, and "the step
// list didn't update" is a bug users notice immediately.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import type { Step, StepType } from "../lib/recorder-types";
import { StepRow } from "./step-row";

function step(partial: Partial<Step> & { type: StepType }): Step {
  return { id: "s1", timestamp: 0, ...partial } as Step;
}

const LOCATOR = { k: "role", role: "button", name: "Submit" } as const;

describe("rendering", () => {
  it("shows a 1-based position", () => {
    // The list is 0-indexed internally; showing "0" would be confusing.
    render(<StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />);
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("describes the step", () => {
    render(<StepRow index={0} step={step({ type: "goto", url: "https://example.com" })} />);
    expect(screen.getByText(/example\.com/)).toBeTruthy();
  });

  it("labels the step type", () => {
    render(<StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />);
    expect(screen.getByText("click")).toBeTruthy();
  });

  it("renders 'end if' rather than the raw type name", () => {
    const { container } = render(<StepRow index={0} step={step({ type: "endif" })} />);
    // Both the badge and the description read "end if"; what matters is that
    // the raw type token never surfaces.
    expect(container.textContent).toContain("end if");
    expect(container.textContent).not.toContain("endif");
  });

  it("renders a cookie step", () => {
    render(
      <StepRow
        index={0}
        step={step({
          type: "cookie",
          cookieAction: "set",
          cookie: { name: "session", value: "abc", domain: "example.com" },
        })}
      />,
    );
    expect(screen.getByText("cookie")).toBeTruthy();
    expect(screen.getByText(/set cookie session/)).toBeTruthy();
  });
});

describe("run status", () => {
  it("marks a passed step", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} runStatus="passed" />,
    );
    // Asserted via the accent class rather than an icon name — the point is
    // that the row is visually distinguished at all.
    expect(container.innerHTML).toMatch(/support-green|green/);
  });

  it("marks a failed step", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} runStatus="failed" />,
    );
    expect(container.innerHTML).toMatch(/support-red|red/);
  });

  it("looks different from an unrun step", () => {
    const plain = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />,
    ).container.innerHTML;
    const failed = render(
      <StepRow index={1} step={step({ type: "click", locator: LOCATOR })} runStatus="failed" />,
    ).container.innerHTML;
    expect(failed).not.toBe(plain);
  });
});

describe("newly-added highlight", () => {
  // jsdom has no layout or animation engine, so the pulse itself cannot be
  // observed here — `check:step-glow-css` pins the stylesheet side. What these
  // tests own is the decision: WHICH rows claim to be new, and whether that
  // claim quietly cancels one of the other highlights the row already carries.

  /** The row element itself — the highlight lives on the row, not a child. */
  function row(container: HTMLElement): HTMLElement {
    const el = container.firstElementChild;
    if (!(el instanceof HTMLElement)) throw new Error("StepRow rendered no element");
    return el;
  }

  it("marks a new step", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} isNew />,
    );
    expect(row(container).getAttribute("data-new-step")).toBe("true");
    expect(row(container).className).toContain("step-new");
  });

  it("does NOT mark an ordinary step", () => {
    // The default matters more than it looks: every other caller of StepRow —
    // the trainer, the step editor, the detail view — renders without this
    // prop, and a truthy default would light up every row in the app.
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />,
    );
    expect(row(container).hasAttribute("data-new-step")).toBe(false);
    expect(row(container).className).not.toContain("step-new");
  });

  it("does NOT mark a step passed isNew={false}", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} isNew={false} />,
    );
    expect(row(container).hasAttribute("data-new-step")).toBe(false);
  });

  it("keeps the failed run highlight on a step that is also new", () => {
    // A step the AI just added AND that just failed is the most important row
    // on the screen. Earlier drafts put the new-step style in the same
    // precedence chain as run status, which silently dropped one or the other.
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} runStatus="failed" isNew />,
    );
    expect(row(container).getAttribute("data-new-step")).toBe("true");
    expect(row(container).className).toContain("step-new");
    expect(container.innerHTML).toMatch(/support-red|red/);
  });

  it("keeps the passed run highlight on a step that is also new", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} runStatus="passed" isNew />,
    );
    expect(row(container).className).toContain("step-new");
    expect(container.innerHTML).toMatch(/support-green|green/);
  });

  it("keeps the selection ring on a step that is also new", () => {
    const plain = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} selected onSelect={() => {}} />,
    );
    const selectedClasses = row(plain.container).className;
    expect(selectedClasses).toContain("ring-accent");

    const { container } = render(
      <StepRow index={1} step={step({ type: "click", locator: LOCATOR })} selected onSelect={() => {}} isNew />,
    );
    expect(row(container).className).toContain("ring-accent");
    expect(row(container).className).toContain("step-new");
  });

  it("leaves the drag-over drop indicator intact", () => {
    const { container } = render(
      <StepRow
        index={0}
        step={step({ type: "click", locator: LOCATOR })}
        isNew
        drag={{
          onDragStart: () => {},
          onDragEnter: () => {},
          onDragEnd: () => {},
          isDragging: false,
          isOver: true,
        }}
      />,
    );
    expect(row(container).className).toContain("border-accent");
    expect(row(container).className).toContain("step-new");
  });
});

describe("actions", () => {
  it("calls onSelect when the row is clicked", () => {
    const onSelect = vi.fn();
    render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByText(/Submit/));
    expect(onSelect).toHaveBeenCalled();
  });

  it("does NOT select when an inner control is clicked", () => {
    // Otherwise deleting a step also selects it, which fights the user.
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(
      <StepRow
        index={0}
        step={step({ type: "click", locator: LOCATOR })}
        onSelect={onSelect}
        onDelete={onDelete}
      />,
    );
    const button = container.querySelector("button");
    // Assert the control EXISTS: guarding with `if (button)` would let this
    // test pass vacuously the day the delete button stops rendering.
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("offers no replay control for steps that can't be replayed alone", () => {
    // goto/viewport/endif aren't meaningful to replay in isolation.
    for (const type of ["goto", "viewport", "endif"] as StepType[]) {
      const { container, unmount } = render(
        <StepRow index={0} step={step({ type })} onReplay={async () => ({ ok: true })} />,
      );
      const labels = [...container.querySelectorAll("button")].map((b) =>
        (b.getAttribute("aria-label") ?? "").toLowerCase(),
      );
      expect(labels.some((l) => l.includes("replay")), type).toBe(false);
      unmount();
    }
  });

  it("offers a replay control for a click step", () => {
    const { container } = render(
      <StepRow
        index={0}
        step={step({ type: "click", locator: LOCATOR })}
        onReplay={async () => ({ ok: true })}
      />,
    );
    const labels = [...container.querySelectorAll("button")].map((b) =>
      (b.getAttribute("aria-label") ?? "").toLowerCase(),
    );
    expect(labels.some((l) => l.includes("replay"))).toBe(true);
  });
});

describe("indentation for conditional blocks", () => {
  it("indents a nested step", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} indent={2} />,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.style.marginLeft).toBe("40px");
  });

  it("leaves a top-level step unindented", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.style.marginLeft).toBe("");
  });
});

describe("drag affordance", () => {
  it("shows a grip only when dragging is enabled", () => {
    const withDrag = render(
      <StepRow
        index={0}
        step={step({ type: "click", locator: LOCATOR })}
        drag={{
          onDragStart: vi.fn(),
          onDragEnter: vi.fn(),
          onDragEnd: vi.fn(),
          isDragging: false,
          isOver: false,
        }}
      />,
    );
    expect(within(withDrag.container).getByLabelText(/drag to reorder/i)).toBeTruthy();
    withDrag.unmount();

    const without = render(<StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />);
    expect(within(without.container).queryByLabelText(/drag to reorder/i)).toBeNull();
  });

  it("starts a drag from the grip", () => {
    const onDragStart = vi.fn();
    render(
      <StepRow
        index={0}
        step={step({ type: "click", locator: LOCATOR })}
        drag={{
          onDragStart,
          onDragEnter: vi.fn(),
          onDragEnd: vi.fn(),
          isDragging: false,
          isOver: false,
        }}
      />,
    );
    fireEvent.dragStart(screen.getByLabelText(/drag to reorder/i));
    expect(onDragStart).toHaveBeenCalled();
  });
});
