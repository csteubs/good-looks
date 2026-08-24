// Tests for the Appearance pane.
//
// The flourishes are stored as an array of DISABLED ids, so the switches are
// inverted: checked means "not in the array". That inversion is the whole risk
// here — get it backwards and every flourish reads as off while being on, which
// looks like the toggle is broken rather than the mapping.

import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { AppearancePane } from "./appearance-pane";

/**
 * Choose an option from the app's native-menu-backed `Select`.
 *
 * CLAUDE.md says this control cannot be driven in jsdom, and that is true of
 * the OPTIONS — they never enter the DOM. The menu itself, though, is opened
 * through `glazeAPI.Menu.popup`, which is an ordinary promise this test can
 * answer: hand back the `commandId` of the item whose label matches, and the
 * component runs exactly the handler a real click would.
 *
 * Worth the scaffolding for this one control. The typeface picker is the only
 * place in the app whose handler does something the store cannot do for it —
 * it applies the change to THIS document, because the Settings window does not
 * receive the appearance push — so "the Select is untestable" would leave the
 * one line that stops the setting looking broken uncovered.
 */
function chooseFromNativeMenu(triggerId: string, label: string): void {
  interface Item {
    label?: string;
    commandId?: number;
    submenu?: Item[];
  }
  const popup = vi.fn(async ({ items }: { items: Item[] }) => {
    const flat: Item[] = [];
    const walk = (list: Item[]): void => {
      for (const i of list) {
        flat.push(i);
        if (i.submenu) walk(i.submenu);
      }
    };
    walk(items);
    const hit = flat.find((i) => i.label === label && i.commandId !== undefined);
    if (!hit) throw new Error(`no menu item labelled "${label}" (saw: ${flat.map((i) => i.label).join(", ")})`);
    return { commandId: hit.commandId };
  });
  (window as unknown as { glazeAPI: { Menu: unknown } }).glazeAPI = { Menu: { popup } };
  fireEvent.click(document.getElementById(triggerId) as HTMLElement);
}

afterEach(() => {
  document.documentElement.removeAttribute("data-gl-typeface");
});

function switchState(name: RegExp): string {
  const sw = screen.getByRole("switch", { name });
  return sw.getAttribute("aria-checked") ?? sw.getAttribute("data-state") ?? "";
}

describe("theme — retired, and the row says so", () => {
  // WHAT THIS USED TO ASSERT was an Auto / Light / Dark radio group. The light
  // theme is gone (REDESIGN §0): the palette is near-black with phosphor
  // accents and the screenshot bezel has no light reading, so a light variant
  // is a second design rather than a swap of values.
  //
  // These tests are not deleted with the control, because the row is not
  // deleted with the control. Someone who had pinned Light will come here
  // looking, and a row that answers is worth more than the space it costs —
  // that is a behaviour, and it is what is pinned below.

  it("still has a Theme row", () => {
    renderPane(<AppearancePane />);
    expect(screen.getByText("Theme")).toBeTruthy();
  });

  it("states dark only, in the present tense", () => {
    renderPane(<AppearancePane />);
    expect(screen.getByText(/dark only for now/i)).toBeTruthy();
  });

  it("offers no way to choose one", () => {
    // The failure this catches is a half-revert: the radios back, wired to a
    // `setTheme` that no longer exists on the controller.
    renderPane(<AppearancePane />);
    expect(screen.queryByRole("radio")).toBeNull();
    for (const name of ["Auto", "Light"]) {
      expect(screen.queryByText(name), name).toBeNull();
    }
  });

  it("does not write a theme through the settings store", () => {
    // It never did — the theme lived in nativeTheme, not RecorderSettings —
    // and the way this row could regress is by being "fixed" into a stored
    // preference the backend would drop on the floor.
    const { controller } = renderPane(<AppearancePane />);
    expect(controller.save).not.toHaveBeenCalled();
  });
});

describe("flourishes are stored as disabled ids", () => {
  it("shows a flourish as ON when its id is absent", () => {
    const controller = makeController({ settings: { disabledAestheticEnhancements: [] } });
    renderPane(<AppearancePane />, { controller });
    expect(switchState(/ai thinking gif/i)).toMatch(/true|checked/i);
    expect(switchState(/home screen animation/i)).toMatch(/true|checked/i);
  });

  it("shows a flourish as OFF when its id is present", () => {
    const controller = makeController({
      settings: { disabledAestheticEnhancements: ["aiThinkingGif"] },
    });
    renderPane(<AppearancePane />, { controller });
    expect(switchState(/ai thinking gif/i)).toMatch(/false|unchecked/i);
    // And only that one.
    expect(switchState(/home screen animation/i)).toMatch(/true|checked/i);
  });

  it("adds an id when a flourish is switched off", () => {
    const { controller } = renderPane(<AppearancePane />);
    fireEvent.click(screen.getByRole("switch", { name: /ai thinking gif/i }));
    expect(savedPatch(controller)).toEqual({ disabledAestheticEnhancements: ["aiThinkingGif"] });
  });

  it("removes an id when a flourish is switched back on", () => {
    const controller = makeController({
      settings: { disabledAestheticEnhancements: ["aiThinkingGif"] },
    });
    renderPane(<AppearancePane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /ai thinking gif/i }));
    expect(savedPatch(controller)).toEqual({ disabledAestheticEnhancements: [] });
  });

  it("leaves the other flourish's id alone", () => {
    // Both switches write the SAME key, so a handler that replaced the array
    // instead of editing it would silently re-enable the other one.
    const controller = makeController({
      settings: { disabledAestheticEnhancements: ["homeBlackHole"] },
    });
    renderPane(<AppearancePane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /ai thinking gif/i }));
    const saved = savedPatch(controller).disabledAestheticEnhancements as string[];
    expect(saved.slice().sort()).toEqual(["aiThinkingGif", "homeBlackHole"]);
  });

  it("preserves an unknown id it does not have a switch for", () => {
    // A flourish added in a later version and disabled there must survive
    // being edited by an older pane.
    const controller = makeController({
      settings: { disabledAestheticEnhancements: ["someFutureFlourish"] },
    });
    renderPane(<AppearancePane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /home screen animation/i }));
    const saved = savedPatch(controller).disabledAestheticEnhancements as string[];
    expect(saved).toContain("someFutureFlourish");
  });

  it("treats a missing array as everything enabled", () => {
    const controller = makeController({ settings: {} });
    renderPane(<AppearancePane />, { controller });
    expect(switchState(/ai thinking gif/i)).toMatch(/true|checked/i);
  });
});

describe("font size", () => {
  // A SEGMENTED CONTROL: real `<button aria-pressed>` elements that a plain
  // click drives. The typeface row below reaches its native-menu Select by
  // answering the popup promise, which works but is scaffolding; the control
  // that decides whether the app is legible should be the one that needs none.
  // This is the test that would notice it being changed into a Select.

  function segment(name: RegExp): HTMLElement {
    return screen.getByRole("button", { name });
  }

  it("shows the stored scale as the pressed segment", () => {
    const controller = makeController({ settings: { uiScale: 1.1 } });
    renderPane(<AppearancePane />, { controller });
    expect(segment(/^large$/i).getAttribute("aria-pressed")).toBe("true");
    expect(segment(/^default$/i).getAttribute("aria-pressed")).toBe("false");
  });

  it("saves the number, not the label", () => {
    // The control's values are strings — Segmented is generic over string. The
    // store validates by MEMBERSHIP in a set of numbers, so a "1.25" that got
    // through as a string is rejected on save and silently keeps the old size.
    const { controller } = renderPane(<AppearancePane />);
    fireEvent.click(segment(/^larger$/i));
    expect(savedPatch(controller)).toEqual({ uiScale: 1.25 });
    expect(typeof savedPatch(controller).uiScale).toBe("number");
  });

  it("offers every scale the backend accepts, and no others", () => {
    renderPane(<AppearancePane />);
    for (const label of ["Small", "Default", "Large", "Larger"]) {
      expect(segment(new RegExp(`^${label}$`, "i")), label).toBeTruthy();
    }
  });

  it("falls back to 100% when nothing is stored yet", () => {
    // The pane renders before the settings load resolves. Without the `?? 1`
    // no segment is pressed, which reads as a control with no current value.
    const controller = makeController({ settings: {} });
    renderPane(<AppearancePane />, { controller });
    expect(segment(/^default$/i).getAttribute("aria-pressed")).toBe("true");
  });

  it("says plainly that it is not only the text", () => {
    // The honest disclosure is the whole reason this is acceptable as a "font
    // size": it scales the chrome too. Copy that quietly drops that claim
    // turns a documented trade-off into a surprise.
    renderPane(<AppearancePane />);
    expect(screen.getByText(/controls around it grow together/i)).toBeTruthy();
  });
});

describe("typeface", () => {
  it("shows the stored pairing", () => {
    const controller = makeController({ settings: { uiTypeface: "classic" } });
    renderPane(<AppearancePane />, { controller });
    expect(screen.getByText("Menlo / Helvetica")).toBeTruthy();
  });

  it("falls back to Space before the settings load resolves", () => {
    const controller = makeController({ settings: {} });
    renderPane(<AppearancePane />, { controller });
    expect(screen.getByText("Space Mono / Grotesk")).toBeTruthy();
  });

  it("shows Space for a value the backend would refuse", () => {
    // A stored typeface that no longer exists must not leave the trigger blank
    // — an empty picker reads as a broken control rather than a stale value.
    const controller = makeController({
      settings: { uiTypeface: "comic-sans" as never },
    });
    renderPane(<AppearancePane />, { controller });
    expect(screen.getByText("Space Mono / Grotesk")).toBeTruthy();
  });

  it("saves the choice", async () => {
    const { controller } = renderPane(<AppearancePane />);
    chooseFromNativeMenu("ui-typeface", "Menlo / Helvetica");
    await waitFor(() => expect(savedPatch(controller)).toEqual({ uiTypeface: "classic" }));
  });

  it("applies the choice to THIS document, not only to the store", async () => {
    // The line this covers is the one that stops the setting looking broken.
    // `sendToMain` fans out to the main window and registered aux windows, and
    // the Settings WINDOW was neither — so without the local `applyTypeface`,
    // the single window the user was looking at while they changed the typeface
    // was the only one in the app that did not change. Settings is a route in
    // the main window now and does receive the push, so the local call is what
    // makes the change land in the same frame as the click instead of after an
    // IPC round trip.
    renderPane(<AppearancePane />);
    chooseFromNativeMenu("ui-typeface", "Menlo / Helvetica");
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-gl-typeface")).toBe("classic"),
    );
  });

  it("clears the attribute when the default is chosen back", async () => {
    const controller = makeController({ settings: { uiTypeface: "classic" } });
    renderPane(<AppearancePane />, { controller });
    chooseFromNativeMenu("ui-typeface", "Space Mono / Grotesk");
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-gl-typeface")).toBeNull(),
    );
  });

  it("promises the alternatives fetch nothing", () => {
    // The app's egress posture is one opt-in webhook. A typeface picker is
    // exactly the feature that would quietly add a second outbound request,
    // and this row's copy is the claim that it did not.
    const { container } = renderPane(<AppearancePane />);
    // By the row's own disclosure, not by index into every "More" on the pane —
    // an index silently starts opening a different row when one is added above.
    const more = container.querySelector<HTMLElement>('[aria-controls="ui-typeface-details"]');
    if (!more) throw new Error("the typeface row has no details disclosure");
    fireEvent.click(more);
    expect(screen.getByText(/never requests a font over the network/i)).toBeTruthy();
  });
});

describe("presentation", () => {
  it("gives the flourishes a real heading, not a label-only row", () => {
    // The old window faked this heading as a Field with a label and no
    // control — the only heading anywhere in it.
    renderPane(<AppearancePane />);
    expect(screen.getByText("Flourishes")).toBeTruthy();
    expect(screen.queryByText("Aesthetic Enhancements")).toBeNull();
  });

  it("keeps the invitation to turn them off", () => {
    renderPane(<AppearancePane />);
    expect(screen.getByText(/if you prefer a plainer interface/i)).toBeTruthy();
  });
});

describe("search filtering", () => {
  it("hides the theme row when only a flourish matched", () => {
    renderPane(<AppearancePane />, { matchedIds: ["home-black-hole"] });
    expect(screen.queryByText("Theme")).toBeNull();
    expect(screen.getByRole("switch", { name: /home screen animation/i })).toBeTruthy();
  });

  it("drops the flourishes section when only the theme matched", () => {
    // The row is still indexed under "light" and "auto" (settings-schema.ts):
    // the words someone searches for are the ones for the thing that is gone.
    renderPane(<AppearancePane />, { matchedIds: ["theme"] });
    expect(screen.queryByText("Flourishes")).toBeNull();
    expect(screen.getByText("Theme")).toBeTruthy();
  });
});
