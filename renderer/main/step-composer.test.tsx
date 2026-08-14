// Component tests for the Add-step dialog's WAIT kind.
//
// The wait form is the one place in this dialog where a single submit can emit
// SEVERAL steps: the three wait properties are independent checkboxes, and each
// ticked one becomes its own `wait` step. Two things about that are silent when
// wrong. The order the steps come out in is invisible in the dialog — a
// duration emitted before the condition it was meant to follow still looks
// right on screen and just makes the test slower or flakier. And a ticked box
// with nothing to act on (no element picked) would emit a wait that waits for
// nothing, which passes instantly and reads as a working step.
//
// The condition dropdown itself cannot be driven here: the SDK's Select is
// native-menu-backed, so its options never enter the DOM (see CLAUDE.md). What
// that dropdown feeds is covered at the generator/parser layer instead
// (spec-parser.check.ts section 7); what's covered here is everything around
// it — which boxes are ticked, what each one contributes, and in what order.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { PickedElement, RawStep, WaitDialogMode } from "../lib/recorder-types";
import { StepComposer } from "./step-composer";

const PICKED: PickedElement = {
  tag: "button",
  description: "button#submit",
  candidates: [
    { k: "role", role: "button", name: "Submit" },
    { k: "css", v: "#submit" },
  ],
  css: {},
  attributes: {},
  // A picked element whose best candidate already identifies it — the ordinary
  // case, and the one where the context picker must stay out of the way.
  ambiguous: false,
  contextBaseCount: 1,
  contextSignals: [],
};

function renderWait(opts: { picked?: PickedElement | null; initialWaitMode?: WaitDialogMode } = {}) {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="wait"
      onCancel={() => {}}
      onAdd={onAdd}
      picked={opts.picked === undefined ? PICKED : opts.picked}
      onStartPick={() => {}}
      onClearPick={() => {}}
      initialWaitMode={opts.initialWaitMode}
    />,
  );
  return { onAdd };
}

/** The dialog's confirm button. */
function submit() {
  fireEvent.click(screen.getByRole("button", { name: /add step/i }));
}

/** Tick or untick one of the three wait properties by its visible label. */
function toggle(label: RegExp) {
  fireEvent.click(screen.getByLabelText(label));
}

/** The steps handed to onAdd by the last submit. */
function emitted(onAdd: ReturnType<typeof vi.fn>): RawStep[] {
  expect(onAdd).toHaveBeenCalledTimes(1);
  return onAdd.mock.calls[0][0] as RawStep[];
}

describe("which wait properties are offered", () => {
  it("offers all three, with a duration ticked by default", () => {
    renderWait();
    expect((screen.getByLabelText(/an element/i) as HTMLInputElement).getAttribute("data-state")).toBe(
      "unchecked",
    );
    expect((screen.getByLabelText(/wait until/i) as HTMLInputElement).getAttribute("data-state")).toBe(
      "unchecked",
    );
    // Unchanged from before conditional waits existed: opening "Add wait" and
    // pressing Add still produces a plain duration.
    expect(
      (screen.getByLabelText(/a duration/i) as HTMLInputElement).getAttribute("data-state"),
    ).toBe("checked");
  });

  it("emits a single duration step when nothing else is ticked", () => {
    const { onAdd } = renderWait();
    submit();
    expect(emitted(onAdd)).toEqual([{ type: "wait", waitMs: 1000 }]);
  });
});

describe("combining wait properties", () => {
  it("emits one step per ticked box, in the order they are listed", () => {
    const { onAdd } = renderWait();
    toggle(/an element/i);
    toggle(/wait until/i);
    // A duration is already ticked; all three are now on.
    submit();

    const steps = emitted(onAdd);
    expect(steps).toHaveLength(3);
    // Element first, condition second, duration LAST — the duration is a settle
    // pad, and a pad that runs before the thing it is padding is just a delay.
    expect(steps[0]).toEqual({ type: "wait", locator: { k: "role", role: "button", name: "Submit" } });
    expect(steps[1]).toMatchObject({ type: "wait", waitUntil: "visible", timeoutMs: 10000 });
    expect(steps[2]).toEqual({ type: "wait", waitMs: 1000 });
  });

  it("emits exactly the two that are ticked", () => {
    const { onAdd } = renderWait();
    toggle(/wait until/i);
    toggle(/a duration/i); // untick
    submit();

    const steps = emitted(onAdd);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ waitUntil: "visible" });
  });

  it("emits nothing when every box is unticked", () => {
    const { onAdd } = renderWait();
    toggle(/a duration/i);
    submit();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("shares one target element between both element-scoped waits", () => {
    const { onAdd } = renderWait();
    toggle(/an element/i);
    toggle(/wait until/i);
    submit();

    const steps = emitted(onAdd);
    // The dialog holds a single pick, so both steps must resolve the SAME
    // locator rather than one of them silently getting none.
    expect(steps[0].locator).toEqual(steps[1].locator);
  });
});

describe("a ticked box with nothing to act on", () => {
  it("refuses the whole submit when an element wait has no element", () => {
    const { onAdd } = renderWait({ picked: null });
    toggle(/an element/i);
    submit();
    // Not "emit the duration and drop the element wait" — that would silently
    // deliver something other than what was asked for.
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("refuses when an element-scoped condition has no element", () => {
    const { onAdd } = renderWait({ picked: null });
    toggle(/wait until/i);
    submit();
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe("the timeout", () => {
  it("defaults to 10s and rides along on the emitted step", () => {
    const { onAdd } = renderWait();
    toggle(/wait until/i);
    const timeout = screen.getByLabelText(/timeout/i) as HTMLInputElement;
    expect(timeout.value).toBe("10000");
    submit();
    expect(emitted(onAdd)[0]).toMatchObject({ timeoutMs: 10000 });
  });

  it("carries an edited timeout through", () => {
    const { onAdd } = renderWait();
    toggle(/wait until/i);
    fireEvent.change(screen.getByLabelText(/timeout/i), { target: { value: "45000" } });
    submit();
    expect(emitted(onAdd)[0]).toMatchObject({ timeoutMs: 45000 });
  });

  it("falls back to the default rather than emitting a zero timeout", () => {
    const { onAdd } = renderWait();
    toggle(/wait until/i);
    // A cleared number input reads as "" — emitting timeout: 0 would make the
    // wait give up instantly, which looks like the condition was never true.
    fireEvent.change(screen.getByLabelText(/timeout/i), { target: { value: "" } });
    submit();
    expect(emitted(onAdd)[0]).toMatchObject({ timeoutMs: 10000 });
  });

  it("shows no timeout field until Wait Until is ticked", () => {
    renderWait();
    expect(screen.queryByLabelText(/timeout/i)).toBeNull();
  });
});

describe("opening from the browser right-click menu", () => {
  it('"For element hidden" produces a wait for HIDDEN, not for visible', () => {
    // The bug this fixes was silent and inverted: "hidden" used to collapse
    // into the plain element wait, which generates `.waitFor()` — wait for
    // VISIBLE. The menu said hidden, the test waited for the opposite, and
    // nothing anywhere said so.
    const { onAdd } = renderWait({ initialWaitMode: "hidden" });
    submit();

    const steps = emitted(onAdd);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: "wait", waitUntil: "hidden" });
    expect(steps[0].waitMs).toBeUndefined();
  });

  it('"For element visible" still produces the plain element wait', () => {
    const { onAdd } = renderWait({ initialWaitMode: "element" });
    submit();
    expect(emitted(onAdd)).toEqual([
      { type: "wait", locator: { k: "role", role: "button", name: "Submit" } },
    ]);
  });

  it('"For duration" opens on the duration alone', () => {
    const { onAdd } = renderWait({ initialWaitMode: "time" });
    submit();
    expect(emitted(onAdd)).toEqual([{ type: "wait", waitMs: 1000 }]);
  });

  it('"Until…" opens Wait Until with the duration off', () => {
    const { onAdd } = renderWait({ initialWaitMode: "until" });
    submit();
    const steps = emitted(onAdd);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ waitUntil: "visible" });
  });
});

// ── Element state, the OTHER kind where one submit emits several steps ─────
//
// Same class of silent failure as the wait form, for the same reason: what the
// user picks and what lands in the list are not one-to-one. Two of the four
// picks expand — `:active` into three rows, `:focus-visible` into two — and the
// ORDER is the whole meaning. A `press` emitted before the `hover` that
// positions the cursor presses at wherever the pointer happened to be; a `Tab`
// emitted after the `focus` it was meant to precede sets keyboard modality on
// the wrong element and then moves focus off the one being tested. Both look
// completely correct in the step list.

function renderState(opts: { picked?: PickedElement | null; initialState?: "hover" | "focus" } = {}) {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="elementState"
      onCancel={() => {}}
      onAdd={onAdd}
      picked={opts.picked === undefined ? PICKED : opts.picked}
      onStartPick={() => {}}
      onClearPick={() => {}}
      initialState={opts.initialState}
    />,
  );
  return { onAdd };
}

const LOCATOR = { k: "role", role: "button", name: "Submit" };

describe("element state steps", () => {
  it("hover emits exactly one state step targeting the picked element", () => {
    const { onAdd } = renderState();
    submit();
    expect(emitted(onAdd)).toEqual([
      { type: "state", elementState: "hover", locator: LOCATOR },
    ]);
  });

  it("focus, preselected from the right-click menu, emits a focus step", () => {
    const { onAdd } = renderState({ initialState: "focus" });
    submit();
    expect(emitted(onAdd)).toEqual([
      { type: "state", elementState: "focus", locator: LOCATOR },
    ]);
  });

  it("refuses the whole submit when no element has been picked", () => {
    // Every state needs a target. Emitting a locator-less hover would generate
    // no line at all — a step that looks added and does nothing.
    const { onAdd } = renderState({ picked: null });
    submit();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("states the row count before the user commits", () => {
    renderState();
    expect(screen.getByText(/Adds 1 step/)).toBeTruthy();
  });
});

// ── The panel, as opposed to the forms in it (C §6.2) ───────────────────
//
// What changed when this stopped being a modal. The forms above are unchanged
// and their tests are the same ones; these are about the frame, and each of
// them is something the dialog got from Radix for free and an inline panel has
// to say for itself.

describe("the composer panel", () => {
  const panel = () => document.querySelector('[data-gl="step-composer"]');
  const addButton = () => screen.getByRole("button", { name: /add step/i });

  it("disables Add until the step will actually build", () => {
    // The modal could afford a permanently-enabled confirm that did nothing:
    // it stayed open, so "nothing happened" read as "I have not finished". A
    // panel sitting in the list cannot — a button that silently declines is
    // indistinguishable from a broken one.
    const onAdd = vi.fn();
    render(
      <StepComposer
        kind="goto"
        onCancel={() => {}}
        onAdd={onAdd}
        picked={null}
        onStartPick={() => {}}
        onClearPick={() => {}}
      />,
    );
    expect(addButton().hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/example\.com/), {
      target: { value: "https://example.com/x" },
    });
    expect(addButton().hasAttribute("disabled")).toBe(false);
    fireEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledWith([{ type: "goto", url: "https://example.com/x" }]);
  });

  it("closes itself after adding, so the list is what you are left looking at", () => {
    const onCancel = vi.fn();
    render(
      <StepComposer
        kind="goto"
        onCancel={onCancel}
        onAdd={() => {}}
        picked={null}
        onStartPick={() => {}}
        onClearPick={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/example\.com/), {
      target: { value: "https://example.com/x" },
    });
    fireEvent.click(addButton());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape from inside a field", () => {
    // Radix gave the dialog this. An inline panel has to bind it, and without
    // it the only way out of a half-filled composer is the mouse.
    const onCancel = vi.fn();
    render(
      <StepComposer
        kind="goto"
        onCancel={onCancel}
        onAdd={() => {}}
        picked={null}
        onStartPick={() => {}}
        onClearPick={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByPlaceholderText(/example\.com/), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("offers cancel twice — the header X and the footer button", () => {
    // Both, deliberately. The X is where a dialog's is and where the hand
    // goes; the footer one is where the eye ends up after filling the form.
    const onCancel = vi.fn();
    render(
      <StepComposer
        kind="goto"
        onCancel={onCancel}
        onAdd={() => {}}
        picked={null}
        onStartPick={() => {}}
        onClearPick={() => {}}
      />,
    );
    const cancels = screen.getAllByRole("button", { name: /^cancel$/i });
    expect(cancels).toHaveLength(2);
    for (const c of cancels) fireEvent.click(c);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("names what it is composing, so a panel in a long list is identifiable", () => {
    render(
      <StepComposer
        kind="assertion"
        onCancel={() => {}}
        onAdd={() => {}}
        picked={null}
        onStartPick={() => {}}
        onClearPick={() => {}}
      />,
    );
    expect(panel()?.getAttribute("aria-label")).toBe("Add assertion");
  });
});
