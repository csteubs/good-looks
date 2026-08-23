import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";

import { makeController, renderPane } from "../__tests__/harness";
import { AiInstructionsRows } from "./ai-instructions-rows";

describe("<AiInstructionsRows />", () => {
  it("saves the global text on blur, and only when it changed", () => {
    const controller = makeController({ settings: { aiInstructions: "old" } });
    renderPane(<AiInstructionsRows />, { controller });
    const ta = screen.getByLabelText("Standing instructions") as HTMLTextAreaElement;
    expect(ta.value).toBe("old");
    fireEvent.blur(ta);
    expect(controller.save).not.toHaveBeenCalled();
    fireEvent.change(ta, { target: { value: "Prefer roles." } });
    fireEvent.blur(ta);
    expect(controller.save).toHaveBeenCalledWith({ aiInstructions: "Prefer roles." });
  });

  it("lists the hosts, saves a host's text on blur, and removes one with the whole table", () => {
    const controller = makeController({
      settings: { aiInstructionsByHost: { "shop.example.com": "Cart is a dialog.", "b.example": "bee" } },
    });
    renderPane(<AiInstructionsRows />, { controller });
    const shop = screen.getByLabelText("Instructions for shop.example.com") as HTMLTextAreaElement;
    expect(shop.value).toBe("Cart is a dialog.");
    fireEvent.change(shop, { target: { value: "Cart is a drawer." } });
    fireEvent.blur(shop);
    expect(controller.save).toHaveBeenCalledWith({ aiInstructionsByHost: { "shop.example.com": "Cart is a drawer.", "b.example": "bee" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove b.example" }));
    expect(controller.save).toHaveBeenLastCalledWith({ aiInstructionsByHost: { "shop.example.com": "Cart is a dialog." } });
  });

  it("adds a site as a draft row, lowercased, and saves once text is written", () => {
    const controller = makeController({ settings: { aiInstructionsByHost: {} } });
    renderPane(<AiInstructionsRows />, { controller });
    const input = screen.getByPlaceholderText("shop.example.com");
    fireEvent.change(input, { target: { value: "Staging.Example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const ta = screen.getByLabelText("Instructions for staging.example.com") as HTMLTextAreaElement;
    fireEvent.blur(ta);
    expect(controller.save).not.toHaveBeenCalled();
    fireEvent.change(ta, { target: { value: "Uses a login wall." } });
    fireEvent.blur(ta);
    expect(controller.save).toHaveBeenCalledWith({ aiInstructionsByHost: { "staging.example.com": "Uses a login wall." } });
  });
});
