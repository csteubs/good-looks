import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { EditorPane } from "./editor-pane";

describe("<EditorPane />", () => {
  it("shows every row at its default", () => {
    renderPane(<EditorPane />);
    expect(screen.getByRole("button", { name: "13px", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2 spaces", pressed: true })).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Wrap long lines" }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Line numbers" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Check with Playwright before saving" }).getAttribute("aria-checked")).toBe("true");
  });

  it("saves a font size as a number, a tab size as one of the two, and the switches as booleans", () => {
    const controller = makeController();
    renderPane(<EditorPane />, { controller });
    fireEvent.click(screen.getByRole("button", { name: "16px" }));
    expect(savedPatch(controller, 0)).toEqual({ editorFontSize: 16 });
    fireEvent.click(screen.getByRole("button", { name: "4 spaces" }));
    expect(savedPatch(controller, 1)).toEqual({ editorTabSize: 4 });
    fireEvent.click(screen.getByRole("switch", { name: "Wrap long lines" }));
    expect(savedPatch(controller, 2)).toEqual({ editorLineWrap: true });
    fireEvent.click(screen.getByRole("switch", { name: "Check with Playwright before saving" }));
    expect(savedPatch(controller, 3)).toEqual({ editorCheckOnSave: false });
  });

  it("still shows a stored size that is not one of the offered buttons", () => {
    const controller = makeController();
    controller.settings = { ...controller.settings, editorFontSize: 17 };
    renderPane(<EditorPane />, { controller });
    expect(screen.getByRole("button", { name: "17px", pressed: true })).toBeTruthy();
  });
});
