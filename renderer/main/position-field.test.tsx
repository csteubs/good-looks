// The position field's one conversion rule: people count matches from one,
// the model counts from zero, and "Last" is the model's -1. A mapping bug
// here is invisible on screen (the segment highlights either way) and shifts
// which element every ordinal step acts on.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { PositionField } from "./position-field";

function renderField(value: number | null = null) {
  const onChange = vi.fn();
  render(<PositionField value={value} onChange={onChange} />);
  return { onChange };
}

describe("PositionField", () => {
  it("maps the segments onto the model's values", () => {
    const { onChange } = renderField();
    fireEvent.click(screen.getByRole("radio", { name: "First" }));
    expect(onChange).toHaveBeenLastCalledWith(0);
    fireEvent.click(screen.getByRole("radio", { name: "Last" }));
    expect(onChange).toHaveBeenLastCalledWith(-1);
  });

  it("clears back to strict-unique on Auto", () => {
    const { onChange } = renderField(2);
    fireEvent.click(screen.getByRole("radio", { name: "Auto" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("converts the 1-based typed position to the 0-based model", () => {
    const { onChange } = renderField();
    fireEvent.click(screen.getByRole("radio", { name: "Nth…" }));
    const input = screen.getByLabelText("Match position (1-based)");
    fireEvent.change(input, { target: { value: "3" } });
    // The 3rd match is index 2 — the whole reason this component exists
    // instead of a bare number input.
    expect(onChange).toHaveBeenLastCalledWith(2);
  });

  it("renders an existing index back as its 1-based position", () => {
    renderField(4);
    const input = screen.getByLabelText("Match position (1-based)") as HTMLInputElement;
    expect(input.value).toBe("5");
  });

  it("explains strict mode while on Auto", () => {
    renderField();
    expect(screen.getByText(/exactly one element/i)).toBeTruthy();
  });
});
