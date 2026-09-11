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

  it("shows an option's hint as a tooltip on focus, never as a native title", async () => {
    // It was a native `title` — chosen as the assertable, hover-only idiom —
    // until the pinned Electron stopped showing those on macOS
    // (primitives/hint.tsx). The option is a real button, so focus reaches it
    // and opens the words; an option without a hint is the bare button.
    render(<Segmented options={MODES} value="current" onChange={vi.fn()} label="Compare mode" />);
    const diff = screen.getByRole("button", { name: "Diff" });
    expect(diff.getAttribute("title")).toBeNull();
    expect(diff.getAttribute("data-state")).toBe("closed");
    expect(screen.getByRole("button", { name: "Current" }).getAttribute("data-state")).toBeNull();
    fireEvent.focus(diff);
    expect((await screen.findAllByText("Only the pixels that changed")).length).toBeGreaterThan(0);
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
