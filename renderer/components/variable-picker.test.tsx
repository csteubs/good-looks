// Component tests for declaring and picking a variable from a step.
//
// The property worth pinning here is the WARNING, not the layout. A "Value"
// variable's default is written verbatim into the test record and baked into
// the generated spec; a "Secret" is encrypted and referenced by env. Those two
// outcomes are indistinguishable in this form — same field, same placement —
// and the only thing that separates them is a sentence. If that sentence stops
// rendering, the form still works perfectly and quietly stores passwords in
// plain text, which is exactly the failure this feature exists to prevent.
//
// The second half is the create contract: the backend owns the rules, and this
// form has to SHOW what it says rather than swallowing it. A rejected create
// that looks like a successful one leaves the user picking a variable that
// does not exist.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { TestVariable } from "../lib/recorder-types";
import { NewVariableForm, VariableChips, insertAtCaret, varRef } from "./variable-picker";

const VARS: TestVariable[] = [
  { name: "storePassword", kind: "secret" },
  { name: "customerEmail", kind: "plain", value: "a@b.c" },
];

function type(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("the reference spelling", () => {
  it("wraps a name the way the generator reads it", () => {
    // The generator's VAR_REF_RE is the authority; a second spelling here would
    // produce a step that interpolates nothing and looks fine on screen.
    expect(varRef("storePassword")).toBe("${storePassword}");
  });
});

describe("picking a declared variable", () => {
  it("offers one chip per variable, spelled as a reference", () => {
    render(<VariableChips variables={VARS} onPick={() => {}} />);
    expect(screen.getByText("${storePassword}")).toBeTruthy();
    expect(screen.getByText("${customerEmail}")).toBeTruthy();
  });

  it("hands back the name, not the reference", () => {
    // The caller decides where the `${}` goes — a fill step's whole value, or
    // spliced into text the user is already typing.
    const onPick = vi.fn();
    render(<VariableChips variables={VARS} onPick={onPick} />);
    fireEvent.click(screen.getByText("${storePassword}"));
    expect(onPick).toHaveBeenCalledWith("storePassword");
  });

  it("marks the chosen one when it is a choice, and no chip otherwise", () => {
    // `selected` distinguishes the fill composer (one variable IS the value)
    // from the inline editor (a click inserts and nothing stays chosen). A
    // pressed state in the second case would claim a selection that isn't real.
    const { rerender } = render(
      <VariableChips variables={VARS} onPick={() => {}} selected="customerEmail" />,
    );
    expect(screen.getByText("${customerEmail}").closest("button")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByText("${storePassword}").closest("button")?.getAttribute("aria-pressed")).toBe(
      "false",
    );
    rerender(<VariableChips variables={VARS} onPick={() => {}} />);
    expect(
      screen.getByText("${customerEmail}").closest("button")?.getAttribute("aria-pressed"),
    ).toBe(null);
  });

  it("says so when the test declares none, rather than rendering an empty row", () => {
    render(
      <VariableChips variables={[]} onPick={() => {}} emptyHint="No variables yet." />,
    );
    expect(screen.getByText(/no variables yet/i)).toBeTruthy();
  });
});

describe("the plaintext warning", () => {
  it("warns when the kind is Value", () => {
    render(<NewVariableForm onCreate={async () => {}} onCancel={() => {}} existingNames={[]} />);
    fireEvent.click(screen.getByText("Value"));
    expect(screen.getByText(/stored as plain text/i)).toBeTruthy();
  });

  it("does not warn for a Secret, and says what happens instead", () => {
    // Secret is the default, so this is what the form opens on.
    render(<NewVariableForm onCreate={async () => {}} onCancel={() => {}} existingNames={[]} />);
    expect(screen.queryByText(/stored as plain text/i)).toBe(null);
    expect(screen.getByText(/encrypted on this mac/i)).toBeTruthy();
  });

  it("masks a secret's value and shows a plain one", () => {
    render(<NewVariableForm onCreate={async () => {}} onCancel={() => {}} existingNames={[]} />);
    expect(screen.getByLabelText(/new variable value/i).getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByText("Value"));
    expect(screen.getByLabelText(/new variable value/i).getAttribute("type")).toBe("text");
  });
});

describe("creating", () => {
  it("submits the name, kind and value", async () => {
    const onCreate = vi.fn(async () => {});
    render(<NewVariableForm onCreate={onCreate} onCancel={() => {}} existingNames={[]} />);
    type(/new variable name/i, "storePassword");
    type(/new variable value/i, "hunter2");
    fireEvent.click(screen.getByRole("button", { name: /create variable/i }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        name: "storePassword",
        kind: "secret",
        value: "hunter2",
      }),
    );
  });

  it("refuses a name that isn't a JS identifier", () => {
    // The name becomes `V.name` in the spec, so anything else emits a file that
    // doesn't parse. Caught here so the user sees why, not just a dropped row.
    const onCreate = vi.fn(async () => {});
    render(<NewVariableForm onCreate={onCreate} onCancel={() => {}} existingNames={[]} />);
    type(/new variable name/i, "store-password");
    type(/new variable value/i, "hunter2");
    expect(screen.getByText(/letters, numbers and underscores/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /create variable/i }));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("refuses a name the test already declares", () => {
    const onCreate = vi.fn(async () => {});
    render(
      <NewVariableForm
        onCreate={onCreate}
        onCancel={() => {}}
        existingNames={["storePassword"]}
      />,
    );
    type(/new variable name/i, "storePassword");
    type(/new variable value/i, "hunter2");
    expect(screen.getByText(/already declares/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /create variable/i }));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("refuses an empty secret", () => {
    // An empty secret declares a name whose value resolves to "" at run time —
    // a login that submits a blank password and fails for the wrong reason.
    const onCreate = vi.fn(async () => {});
    render(<NewVariableForm onCreate={onCreate} onCancel={() => {}} existingNames={[]} />);
    type(/new variable name/i, "storePassword");
    fireEvent.click(screen.getByRole("button", { name: /create variable/i }));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("allows an empty value for a plain variable", async () => {
    // A plain variable with no default is legitimate — a dataset row supplies
    // it. Only a secret has nowhere else for its value to come from.
    const onCreate = vi.fn(async () => {});
    render(<NewVariableForm onCreate={onCreate} onCancel={() => {}} existingNames={[]} />);
    fireEvent.click(screen.getByText("Value"));
    type(/new variable name/i, "orderId");
    fireEvent.click(screen.getByRole("button", { name: /create variable/i }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ name: "orderId", kind: "plain", value: "" }),
    );
  });

  it("shows the backend's rejection rather than reporting success", async () => {
    const onCreate = vi.fn(async () => {
      throw new Error("A test can declare at most 50 variables.");
    });
    render(<NewVariableForm onCreate={onCreate} onCancel={() => {}} existingNames={[]} />);
    type(/new variable name/i, "storePassword");
    type(/new variable value/i, "hunter2");
    fireEvent.click(screen.getByRole("button", { name: /create variable/i }));
    await waitFor(() => expect(screen.getByText(/at most 50 variables/i)).toBeTruthy());
  });
});

describe("splicing a reference into text", () => {
  it("inserts at the caret, not at the end", () => {
    // The common edit is a substitution inside existing text
    // (`${user}@example.com`), which an append would make a two-step fix.
    expect(insertAtCaret("@example.com", 0, "${user}")).toBe("${user}@example.com");
  });

  it("clamps a caret outside the draft", () => {
    expect(insertAtCaret("abc", 99, "${x}")).toBe("abc${x}");
    expect(insertAtCaret("abc", -5, "${x}")).toBe("${x}abc");
  });
});
