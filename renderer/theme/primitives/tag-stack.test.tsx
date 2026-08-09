import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { TagStack } from "./tag-stack";

const MANY = ["checkout", "smoke", "critical", "payments", "regression"];

describe("<TagStack />", () => {
  it("renders nothing at all for no tags", () => {
    // An empty stack would still take its cell's width and leave a gap in the
    // row grid that reads as a rendering failure.
    const { container } = render(<TagStack tags={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("draws the first few and counts the rest", () => {
    render(<TagStack tags={MANY} />);
    expect(screen.getByText("CH")).toBeTruthy();
    expect(screen.getByText("SM")).toBeTruthy();
    expect(screen.getByText("CR")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("shows no count when everything fits", () => {
    const { container } = render(<TagStack tags={["smoke", "critical"]} />);
    expect(container.querySelector(".gl-tag-count")).toBeNull();
  });

  it("names every tag, including the ones it did not draw", () => {
    // THE POINT OF THE PRIMITIVE. Truncation that hides tags with no way to see
    // them is the problem this replaces; "+2" that cannot be read is the same
    // problem with extra steps.
    render(<TagStack tags={MANY} />);
    const stack = document.querySelector('[data-gl="tag-stack"]') as HTMLElement;
    expect(stack.title).toBe("checkout, smoke, critical, payments, regression");
    expect(stack.getAttribute("aria-label")).toBe(
      "Tags: checkout, smoke, critical, payments, regression",
    );
  });

  it("opens the full list when there is somewhere to open", () => {
    const onOpen = vi.fn();
    render(<TagStack tags={MANY} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("is not a button when there is nothing to open", () => {
    // A button that does nothing is worse than no button: it invites a click
    // and then reports nothing back.
    render(<TagStack tags={MANY} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("overlaps the marks but keeps the first one flush", () => {
    // The overlap is what buys the room. Applying it to the first mark too
    // would pull the whole stack 5px into the cell before it.
    const { container } = render(<TagStack tags={MANY} />);
    const marks = [...container.querySelectorAll(".gl-tag-mark")] as HTMLElement[];
    expect(marks[0].style.marginInlineStart).toBe("0px");
    expect(marks[1].style.marginInlineStart).toBe("-5px");
  });

  it("stacks earlier marks above later ones, so the initials stay readable", () => {
    const { container } = render(<TagStack tags={MANY} />);
    const marks = [...container.querySelectorAll(".gl-tag-mark")] as HTMLElement[];
    expect(Number(marks[0].style.zIndex)).toBeGreaterThan(Number(marks[1].style.zIndex));
  });

  it("honours a different max", () => {
    render(<TagStack tags={MANY} max={1} />);
    expect(screen.getByText("+4")).toBeTruthy();
  });
});
