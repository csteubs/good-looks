import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { KeyValue } from "./key-value";

const ROWS = [
  { label: "Browser", value: "chromium" },
  { label: "Viewport", value: "1280×800" },
  { label: "Accepted by", value: "chris", title: "chris.desteuben@gmail.com" },
];

describe("<KeyValue />", () => {
  it("pairs each label with its value in the markup, not just visually", () => {
    // A `<dl>` is what makes a screen reader announce "Browser, chromium"
    // rather than two adjacent strings that happen to look related.
    const { container } = render(<KeyValue rows={ROWS} />);
    expect(container.querySelector("dl")).not.toBeNull();
    const terms = [...container.querySelectorAll("dt")].map((t) => t.textContent);
    const defs = [...container.querySelectorAll("dd")].map((d) => d.textContent);
    expect(terms).toEqual(["Browser", "Viewport", "Accepted by"]);
    expect(defs).toEqual(["chromium", "1280×800", "chris"]);
  });

  it("keeps the pairs in the order they were given", () => {
    // These are facts about one thing, and the order is an editorial choice by
    // whoever wrote the panel.
    const { container } = render(<KeyValue rows={ROWS} />);
    const cells = [...container.querySelectorAll("dt, dd")].map((n) => n.textContent);
    expect(cells).toEqual(["Browser", "chromium", "Viewport", "1280×800", "Accepted by", "chris"]);
  });

  it("carries a truncating value's full text as a title", () => {
    render(<KeyValue rows={ROWS} />);
    expect(screen.getByText("chris").getAttribute("title")).toBe("chris.desteuben@gmail.com");
  });

  it("sizes the label column per instance", () => {
    // Not a global width: "Viewport" and "Accepted by" need different room, and
    // forcing one measurement on both wastes half of a narrow panel.
    const { container } = render(<KeyValue rows={ROWS} labelWidth={130} />);
    expect((container.querySelector("dl") as HTMLElement).style.gridTemplateColumns).toBe(
      "130px minmax(0, 1fr)",
    );
  });

  it("renders a node value, not only a string", () => {
    render(<KeyValue rows={[{ label: "Status", value: <b data-testid="chip">Passed</b> }]} />);
    expect(screen.getByTestId("chip")).toBeTruthy();
  });

  it("renders nothing rather than an empty grid for no rows", () => {
    const { container } = render(<KeyValue rows={[]} />);
    expect(container.querySelectorAll("dt")).toHaveLength(0);
  });
});
