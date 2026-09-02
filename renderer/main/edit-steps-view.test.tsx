// Component tests for the step editor.
//
// The editor works on a DRAFT: nothing is written until Save, so Cancel must
// discard every edit and Save must persist exactly what's on screen. That
// draft/commit boundary is the whole contract, and getting it wrong destroys
// the user's recorded test rather than merely misbehaving.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { Step, StepType } from "../lib/recorder-types";
import { EditStepsView } from "./edit-steps-view";
import { INSERT_HERE } from "./step-row";

function step(id: string, partial: Partial<Step> & { type: StepType }): Step {
  return { id, timestamp: 0, ...partial } as Step;
}

const STEPS: Step[] = [
  step("a", { type: "goto", url: "https://example.com" }),
  step("b", { type: "click", locator: { k: "role", role: "button", name: "Submit" } }),
  step("c", { type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.test" }),
];

function renderEditor(steps: Step[] = STEPS) {
  const onCancel = vi.fn();
  const onSave = vi.fn(async (_s: Step[]) => {});
  render(<EditStepsView steps={steps} onCancel={onCancel} onSave={onSave} />);
  return { onCancel, onSave };
}

describe("rendering", () => {
  it("lists the steps it was given", () => {
    renderEditor();
    expect(screen.getByText(/example\.com/)).toBeTruthy();
    expect(screen.getByText(/Submit/)).toBeTruthy();
  });

  it("renders an empty step list without crashing", () => {
    expect(() => renderEditor([])).not.toThrow();
  });
});

// Whether editing here can change what runs depends on the test, and the user
// can't tell by looking at the step rows. Saying it only at save time means the
// work is already done; saying nothing at all is how this whole flow used to
// read as working when it changed nothing.
describe("warning when the script isn't generated from these steps", () => {
  it("says saving asks about the script when the script was edited directly", () => {
    render(<EditStepsView steps={STEPS} scriptEdited onCancel={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByText(/isn't generated from these steps/i)).toBeTruthy();
  });

  it("says an imported script is never regenerated, rather than offering hope", () => {
    // Different promise from the hand-edited case: there is no "apply these"
    // for an imported spec, so the warning must not imply one.
    render(
      <EditStepsView steps={STEPS} scriptEdited imported onCancel={vi.fn()} onSave={vi.fn()} />,
    );
    expect(screen.getByText(/never regenerated/i)).toBeTruthy();
    expect(screen.queryByText(/isn't generated from these steps/i)).toBeNull();
  });

  it("stays quiet for a test whose script is generated from its steps", () => {
    renderEditor();
    expect(screen.queryByText(/isn't generated from these steps/i)).toBeNull();
    expect(screen.queryByText(/never regenerated/i)).toBeNull();
  });
});

describe("the draft/commit boundary", () => {
  it("saves the current draft", async () => {
    const { onSave } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("saves a deletion", async () => {
    const { onSave } = renderEditor();
    const deletes = screen.getAllByLabelText(/delete step/i);
    fireEvent.click(deletes[1]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("Cancel discards edits without saving", async () => {
    // The destructive direction: an edit that survives a Cancel silently
    // rewrites a recorded test the user chose not to change.
    const { onCancel, onSave } = renderEditor();
    fireEvent.click(screen.getAllByLabelText(/delete step/i)[0]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not mutate the steps it was handed", async () => {
    // The caller's array is live app state; mutating it would apply edits even
    // after a Cancel.
    const original = STEPS.map((s) => ({ ...s }));
    const { onSave } = renderEditor(original);
    fireEvent.click(screen.getAllByLabelText(/delete step/i)[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());

    expect(original.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});

describe("reordering", () => {
  it("moves a step and saves the new order", async () => {
    const { onSave } = renderEditor();
    const grips = screen.getAllByLabelText(/drag to reorder/i);

    // Drag the third step onto the first.
    fireEvent.dragStart(grips[2]);
    fireEvent.dragEnter(grips[0]);
    fireEvent.dragEnd(grips[2]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps every step when reordering", async () => {
    const { onSave } = renderEditor();
    const grips = screen.getAllByLabelText(/drag to reorder/i);
    fireEvent.dragStart(grips[0]);
    fireEvent.dragEnter(grips[2]);
    fireEvent.dragEnd(grips[0]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0].map((s) => s.id).sort();
    expect(saved).toEqual(["a", "b", "c"]);
  });

  it("is a no-op when a step is dropped on itself", async () => {
    const { onSave } = renderEditor();
    const grips = screen.getAllByLabelText(/drag to reorder/i);
    fireEvent.dragStart(grips[1]);
    fireEvent.dragEnter(grips[1]);
    fireEvent.dragEnd(grips[1]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});

// ── Variables, from the step editor ───────────────────────────────────────
//
// The second of the two paths to the same job. This editor is the only place a
// step recorded MONTHS ago can be fixed — the trainer's browser is not open,
// and the recorded password is sitting in the step list — so the insert
// affordance has to be here too, not only where steps are first made.
//
// The create form is here for a narrower reason: the Variables tab is one tab
// away, but this editor holds an UNSAVED draft of the step list, so going there
// costs the user every edit they have made. A declare-in-place is what makes
// "replace this password with a secret" a single sitting.
describe("using a variable in a step", () => {
  const VARS = [{ name: "storePassword", kind: "secret" as const }];

  it("offers the insert button on a value the test can interpolate", () => {
    render(
      <EditStepsView steps={STEPS} variables={VARS} onCancel={() => {}} onSave={async () => {}} />,
    );
    // The `fill` row — click its value to edit, and the button appears beside
    // it. Last of the edit buttons, not the third: the `click` step has no
    // inline-editable field and so renders none.
    const edits = screen.getAllByLabelText(/edit step/i);
    fireEvent.click(edits[edits.length - 1]);
    expect(screen.getByLabelText(/insert a variable/i)).toBeTruthy();
  });

  it("says how to use one, so the syntax is not something to be already known", () => {
    render(
      <EditStepsView steps={STEPS} variables={VARS} onCancel={() => {}} onSave={async () => {}} />,
    );
    expect(screen.getByText(/\$\{name\}/)).toBeTruthy();
  });

  it("warns that a plain variable is stored unencrypted", () => {
    render(
      <EditStepsView
        steps={STEPS}
        variables={[{ name: "email", kind: "plain", value: "a@b.c" }]}
        onCancel={() => {}}
        onSave={async () => {}}
      />,
    );
    expect(screen.getByText(/stored\s+unencrypted/i)).toBeTruthy();
  });

  it("hides the create affordance when the host cannot persist one", () => {
    // An imported test: its spec is never regenerated, so a variable declared
    // against it would be a promise nothing keeps.
    render(
      <EditStepsView steps={STEPS} variables={VARS} onCancel={() => {}} onSave={async () => {}} />,
    );
    expect(screen.queryByRole("button", { name: /new variable/i })).toBe(null);
  });

  it("declares one without losing the step draft", async () => {
    const onCreateVariable = vi.fn(async () => {});
    render(
      <EditStepsView
        steps={STEPS}
        variables={[]}
        onCreateVariable={onCreateVariable}
        onCancel={() => {}}
        onSave={async () => {}}
      />,
    );
    // Edit a step first — this is the draft that going to the Variables tab
    // would have discarded.
    fireEvent.click(screen.getAllByLabelText(/edit step/i)[0]);
    const url = screen.getByLabelText(/edit url/i);
    fireEvent.change(url, { target: { value: "https://shop.example.com" } });
    fireEvent.keyDown(url, { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: /new variable/i }));
    fireEvent.change(screen.getByLabelText(/new variable name/i), {
      target: { value: "storePassword" },
    });
    fireEvent.change(screen.getByLabelText(/new variable value/i), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create variable/i }));
    await waitFor(() =>
      expect(onCreateVariable).toHaveBeenCalledWith({
        name: "storePassword",
        kind: "secret",
        value: "hunter2",
      }),
    );
    expect(screen.getByText(/shop\.example\.com/)).toBeTruthy();
  });
});

// ── Placing a new step ────────────────────────────────────────────────────
//
// New steps land at the INSERT CURSOR — the gap-between-rows control the
// trainer has — not at the end. This editor is for a test recorded months ago,
// where the step that is missing is almost never the last one; before the
// cursor, every add appended and the user dragged the row up into place. The
// rules pinned here are the trainer's: the cursor opens at the end, a click on
// a gap moves it, an add lands there and advances it past what landed, and a
// deletion above it pulls it back so it still names the same gap.
describe("placing a new step", () => {
  /** Stand in for the native "+ Add step" menu, answering with the chosen
   *  kind, then drive the dialog it opens through to its confirm. */
  async function addStep(label: string) {
    (window as unknown as { glazeAPI: { Menu: { popup: unknown } } }).glazeAPI.Menu.popup = vi.fn(
      async (opts: { items: { label?: string; commandId?: number }[] }) => {
        const item = opts.items.find((i) => i.label === label);
        // Not found means the kind was renamed or dropped — answer "nothing
        // chosen" so the test fails on the missing dialog, not on a wrong
        // commandId opening another kind's form.
        return item?.commandId === undefined ? {} : { commandId: item.commandId };
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /add step/i }));
    const dialog = await screen.findByRole("dialog");
    const confirm = Array.from(dialog.querySelectorAll("button")).find((b) =>
      /^add step$/i.test(b.textContent ?? ""),
    );
    if (!confirm) throw new Error("the add-step dialog has no confirm button");
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }

  async function savedTypes(onSave: ReturnType<typeof vi.fn>): Promise<string[]> {
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    return (onSave.mock.calls[0][0] as Step[]).map((s) => s.type);
  }

  it("offers a cursor gap before every step and after the last", () => {
    renderEditor();
    expect(screen.getAllByLabelText(/move insert point here/i)).toHaveLength(STEPS.length + 1);
  });

  it("opens at the end, unlabelled, and appends there by default", async () => {
    // The end needs no label — steps appearing under the last row is what
    // everyone already expects — so the label's absence is the cursor's
    // position made visible.
    const { onSave } = renderEditor();
    expect(screen.queryByText(INSERT_HERE)).toBeNull();
    await addStep("Wait (duration)");
    expect(await savedTypes(onSave)).toEqual(["goto", "click", "fill", "wait"]);
  });

  it("puts a new step where the cursor was clicked, and says where that is", async () => {
    const { onSave } = renderEditor();
    // Gap 1: between the goto and the click.
    fireEvent.click(screen.getAllByLabelText(/move insert point here/i)[1]);
    expect(screen.getByText(INSERT_HERE)).toBeTruthy();
    await addStep("Wait (duration)");
    expect(await savedTypes(onSave)).toEqual(["goto", "wait", "click", "fill"]);
  });

  it("advances past what landed, so two adds keep their order", async () => {
    // The backend's insertStep rule (`cursor = at + 1`). Without it the second
    // add lands ABOVE the first, and a hand-composed sequence comes out
    // reversed.
    const { onSave } = renderEditor();
    fireEvent.click(screen.getAllByLabelText(/move insert point here/i)[1]);
    await addStep("Wait (duration)");
    await addStep("Press key");
    expect(await savedTypes(onSave)).toEqual(["goto", "wait", "press", "click", "fill"]);
  });

  it("follows a deletion above it, so it still names the same gap", async () => {
    // Cursor between click and fill (gap 2); delete the goto above it. The
    // cursor is a gap index, so unchanged it would now point AFTER the fill.
    const { onSave } = renderEditor();
    fireEvent.click(screen.getAllByLabelText(/move insert point here/i)[2]);
    fireEvent.click(screen.getAllByLabelText(/delete step/i)[0]);
    await addStep("Wait (duration)");
    expect(await savedTypes(onSave)).toEqual(["click", "wait", "fill"]);
  });

  it("stays put when a step below it is deleted", async () => {
    const { onSave } = renderEditor();
    fireEvent.click(screen.getAllByLabelText(/move insert point here/i)[1]);
    fireEvent.click(screen.getAllByLabelText(/delete step/i)[2]);
    await addStep("Wait (duration)");
    expect(await savedTypes(onSave)).toEqual(["goto", "wait", "click"]);
  });

  it("marks the step that just landed so the list scrolls it into view", async () => {
    // jsdom has no layout, so the scroll itself is unobservable here; what is
    // pinned is the marker StepRow scrolls on (`justAdded`), on exactly one
    // row, the one that arrived.
    renderEditor();
    fireEvent.click(screen.getAllByLabelText(/move insert point here/i)[1]);
    await addStep("Wait (duration)");
    const marked = document.querySelectorAll("[data-just-added]");
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toMatch(/wait/i);
  });
});
