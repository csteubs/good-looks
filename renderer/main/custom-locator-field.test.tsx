// The custom-locator field's contract with its parents: emit a locator only
// while the draft is one (null otherwise — the confirm buttons key off it),
// refuse what the oracle can't count with a visible reason, and show a live
// count that includes the pending context, because the number on screen must
// be the number the finished step resolves to.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { Locator } from "../lib/recorder-types";
import { CustomLocatorField } from "./custom-locator-field";

let countResult: number = 1;
const countMatches = vi.fn(async (_loc: Locator) => countResult);

vi.mock("../lib/api", () => ({
  api: {
    recorder: {
      countMatches: (loc: Locator) => countMatches(loc),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  countResult = 1;
});

function renderField(props: Partial<React.ComponentProps<typeof CustomLocatorField>> = {}) {
  const onLocator = vi.fn();
  render(<CustomLocatorField ctx={null} onLocator={onLocator} debounceMs={0} {...props} />);
  return { onLocator, input: screen.getByLabelText("Custom locator") as HTMLInputElement };
}

describe("emitting", () => {
  it("emits a css locator for a valid selector, with the kind badged", async () => {
    const { onLocator, input } = renderField();
    fireEvent.change(input, { target: { value: "button.add-to-cart" } });
    await waitFor(() =>
      expect(onLocator).toHaveBeenLastCalledWith({ k: "css", v: "button.add-to-cart" }),
    );
    expect(screen.getByText("CSS")).toBeTruthy();
  });

  it("emits an xpath locator for xpath= input", async () => {
    const { onLocator, input } = renderField();
    fireEvent.change(input, { target: { value: "xpath=//button[@id='submit']" } });
    await waitFor(() =>
      expect(onLocator).toHaveBeenLastCalledWith({ k: "xpath", v: "//button[@id='submit']" }),
    );
    expect(screen.getByText("XPath")).toBeTruthy();
  });

  it("emits null again when a valid draft is edited into an invalid one", async () => {
    // The stale-locator trap: without the null, a parent keeps the last valid
    // locator while the field shows an error, and Add inserts something the
    // screen no longer shows.
    const { onLocator, input } = renderField();
    fireEvent.change(input, { target: { value: "button" } });
    await waitFor(() => expect(onLocator).toHaveBeenLastCalledWith({ k: "css", v: "button" }));
    fireEvent.change(input, { target: { value: "text=button" } });
    await waitFor(() => expect(onLocator).toHaveBeenLastCalledWith(null));
  });
});

describe("refusals", () => {
  it("explains a Playwright engine selector instead of counting it", async () => {
    const { onLocator, input } = renderField();
    fireEvent.change(input, { target: { value: "text=Add to cart" } });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/engine selectors/i);
    expect(onLocator).toHaveBeenLastCalledWith(null);
    expect(countMatches).not.toHaveBeenCalled();
  });

  it("reports broken CSS syntax without calling the count channel", async () => {
    const { input } = renderField();
    fireEvent.change(input, { target: { value: "div[" } });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/valid CSS/i);
    expect(countMatches).not.toHaveBeenCalled();
  });
});

describe("the live count", () => {
  it("counts with the pending context composed in", async () => {
    const ctx = { within: { k: "testid", v: "billing" } as Locator };
    const { input } = renderField({ ctx });
    fireEvent.change(input, { target: { value: "button" } });
    await waitFor(() => expect(countMatches).toHaveBeenCalled());
    expect(countMatches).toHaveBeenLastCalledWith({ k: "css", v: "button", ctx });
    expect(await screen.findByText("Matches 1 element.")).toBeTruthy();
  });

  it("says what an ambiguous count means for a run", async () => {
    countResult = 9;
    const { input } = renderField();
    fireEvent.change(input, { target: { value: "li" } });
    expect(await screen.findByText(/Matches 9 elements — a run needs exactly one/)).toBeTruthy();
  });

  it("owns up when it cannot count", async () => {
    countResult = -1;
    const { input } = renderField();
    fireEvent.change(input, { target: { value: "li" } });
    expect(await screen.findByText(/Can't count matches right now/)).toBeTruthy();
  });

  it("reports zero matches as a page fact, not an error", async () => {
    countResult = 0;
    const { input } = renderField();
    fireEvent.change(input, { target: { value: ".gone" } });
    expect(await screen.findByText(/No matches on the current page/)).toBeTruthy();
  });
});

describe("lint", () => {
  it("warns about build-generated class names without blocking", async () => {
    const { onLocator, input } = renderField();
    fireEvent.change(input, { target: { value: ".css-1q2w3e" } });
    await waitFor(() => expect(screen.getByText(/build-generated/)).toBeTruthy());
    // Advisory only: the locator still emits.
    expect(onLocator).toHaveBeenLastCalledWith({ k: "css", v: ".css-1q2w3e" });
  });
});
