import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";

import { INSPECTIONS, defaultInspections } from "../../../shared/inspections.mjs";
import { makeController, renderPane } from "../__tests__/harness";
import { InspectionsPane } from "./inspections-pane";

describe("<InspectionsPane />", () => {
  it("renders one switch per rule, on by default, and a toggle saves the whole map with that rule flipped", () => {
    const controller = makeController({ settings: { inspections: defaultInspections() } });
    renderPane(<InspectionsPane />, { controller });
    for (const i of INSPECTIONS) {
      // The flag badge ("error · quick fix") joins the accessible name.
      const sw = screen.getByRole("switch", { name: new RegExp("^" + i.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
      expect(sw.getAttribute("aria-checked")).toBe("true");
    }
    fireEvent.click(screen.getByRole("switch", { name: /^Fixed-time wait/ }));
    expect(controller.save).toHaveBeenCalledWith({ inspections: { ...defaultInspections(), "no-wait-for-timeout": false } });
  });

  it("names the severity and whether a quick fix exists beside each rule", () => {
    renderPane(<InspectionsPane />);
    expect(screen.getByText("error · quick fix")).toBeTruthy();
    expect(screen.getAllByText("hint").length).toBeGreaterThan(0);
  });
});
