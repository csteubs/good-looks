import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { Segmented } from "./segmented";

const MODES = [
  { value: "current", label: "Current" },
  { value: "baseline", label: "Baseline" },
  { value: "diff", label: "Diff", title: "Only the pixels that changed" },
] as const;

describe("<Segmented />", () => {
  it("responds to a plain click", () => {
    // THE REASON THIS IS NOT A RADIX CONTROL. `TabsTrigger` activates on
    // pointer-down, so `fireEvent.click` leaves it unchanged and every
    // assertion afterwards silently runs against the previous tab — a
    // documented trap in this repo (CLAUDE.md). Plain buttons make `click` mean
    // what it says, and this test is the thing that would notice if the
    // primitive were ever swapped back.
    const onChange = vi.fn();
    render(<Segmented options={MODES} value="current" onChange={onChange} label="Compare mode" />);
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(onChange).toHaveBeenCalledWith("diff");
  });

  it("announces the active choice with aria-pressed, which is also what the stylesheet selects on", () => {
    // One source of truth: there is no separate `selected` class that could
    // disagree with what is announced.
    render(<Segmented options={MODES} value="baseline" onChange={vi.fn()} label="Compare mode" />);
    expect(screen.getByRole("button", { name: "Baseline" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Current" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("names the group, so it does not announce as three unrelated buttons", () => {
    render(<Segmented options={MODES} value="current" onChange={vi.fn()} label="Compare mode" />);
    expect(screen.getByRole("group", { name: "Compare mode" })).toBeTruthy();
  });

  it("carries an option's hint as a native title", () => {
    // Native `title`, not a Tooltip — Radix tooltips cannot be opened under
    // jsdom, so copy only reachable by hover cannot be asserted at all.
    render(<Segmented options={MODES} value="current" onChange={vi.fn()} label="Compare mode" />);
    expect(screen.getByRole("button", { name: "Diff" }).getAttribute("title")).toBe(
      "Only the pixels that changed",
    );
  });

  it("does not fire for a disabled option", () => {
    const onChange = vi.fn();
    render(
      <Segmented
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B", disabled: true },
        ]}
        value="a"
        onChange={onChange}
        label="Scope"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders every option, in order", () => {
    render(<Segmented options={MODES} value="current" onChange={vi.fn()} label="Compare mode" />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Current",
      "Baseline",
      "Diff",
    ]);
  });
});
