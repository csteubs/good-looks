// The composer's VARIABLE comparison: the assertion kind and the condition
// kind, which are the same claim in two places and share their fields.
//
// The operator dropdown is a native-menu-backed Select, so its options never
// enter the DOM (CLAUDE.md) — what is covered here is the part on the near side
// of it: which fields appear, what the submit builds, and the refusals. The
// refusals are the ones that would be silent: a step submitted with no variable
// chosen looks added and compares nothing, and the boundary would drop
// `captureVar` while keeping the rest rather than refusing the step.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { RawStep, TestVariable } from "../lib/recorder-types";
import { StepComposer } from "./step-composer";

vi.mock("../lib/api", () => ({
  api: {
    recorder: { countMatches: vi.fn(async () => 1) },
    tests: { listFlows: async () => [] },
  },
}));

const VARIABLES: TestVariable[] = [
  { name: "orderTotal", kind: "plain", value: "49.99" },
  { name: "role", kind: "plain", value: "admin" },
];

interface MenuItem {
  label?: string;
  commandId?: number;
  submenu?: MenuItem[];
}

/**
 * Answer the app's native menu with the item whose label matches.
 *
 * The kind pickers are native-menu-backed Selects, so their options never
 * enter the DOM and no query reaches them — but `Menu.popup` is an ordinary
 * promise, so handing back a `commandId` runs exactly the handler a real click
 * would. Same scaffolding, and same justification, as appearance-pane.test.tsx:
 * there is behaviour on the near side of the picker worth covering, and "the
 * Select is undrivable" would leave it uncovered.
 */
function answerMenuWith(label: string) {
  const popup = vi.fn(async ({ items }: { items: MenuItem[] }) => {
    const flat: MenuItem[] = [];
    const walk = (list: MenuItem[]): void => {
      for (const i of list) {
        flat.push(i);
        if (i.submenu) walk(i.submenu);
      }
    };
    walk(items);
    const hit = flat.find((i) => i.label === label);
    if (!hit) {
      throw new Error(`no menu item labelled "${label}" — saw: ${flat.map((i) => i.label).join(" | ")}`);
    }
    return { commandId: hit.commandId };
  });
  (window as unknown as { glazeAPI: { Menu: unknown } }).glazeAPI = { Menu: { popup } };
  return popup;
}

function renderComposer(
  kind: "assertion" | "condition" | "echo",
  variables: TestVariable[] = VARIABLES,
) {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind={kind}
      initialAssert={kind === "assertion" ? "variable" : undefined}
      variables={variables}
      onCancel={() => {}}
      onAdd={onAdd}
      picked={null}
      onStartPick={() => {}}
      onClearPick={() => {}}
    />,
  );
  return { onAdd };
}

/** The condition kind has no `initialCond` prop — the composer's own picker is
 *  how it is chosen, so the test chooses it the same way a click would. */
async function chooseVariableCondition(): Promise<void> {
  answerMenuWith("Variable value");
  fireEvent.click(screen.getByText("Element is visible"));
  await screen.findByText(/case matters and whitespace is not tidied up/i);
}

/** The chips render `${name}`, not the bare name. */
const chip = (name: string): HTMLElement =>
  screen.getByRole("button", { name: new RegExp("\\$\\{" + name + "\\}") });

const submit = (): void => {
  fireEvent.click(screen.getByRole("button", { name: /add step/i }));
};

describe("the variable assertion", () => {
  it("offers the test's variables to compare", () => {
    renderComposer("assertion");
    expect(chip("orderTotal")).toBeTruthy();
    expect(chip("role")).toBeTruthy();
  });

  it("asks for no element — it looks at nothing on the page", () => {
    renderComposer("assertion");
    expect(screen.queryByText(/pick an element/i)).toBe(null);
  });

  it("says the comparison is raw, because that is what the run really does", () => {
    // The consequence worth knowing: a value captured from textContent carries
    // the page's whitespace, so `contains` is the forgiving operator and `eq`
    // is not. Said out loud rather than fixed by a hidden trim.
    renderComposer("assertion");
    expect(screen.getByText(/case matters and whitespace is not tidied up/i)).toBeTruthy();
  });

  it("builds the step from the picked variable", () => {
    const { onAdd } = renderComposer("assertion");
    fireEvent.click(chip("orderTotal"));
    submit();
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0]).toEqual([
      { type: "assert", assert: "variable", soft: undefined, captureVar: "orderTotal", compareOp: "eq", value: "" },
    ]);
  });

  it("REFUSES the submit when no variable was chosen", () => {
    // The boundary would drop `captureVar` and keep the rest, planting a step
    // that looks added and compares nothing.
    const { onAdd } = renderComposer("assertion");
    submit();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("says so when the test declares no variables at all", () => {
    renderComposer("assertion", []);
    expect(screen.getByText(/declares no variables yet/i)).toBeTruthy();
  });
});

describe("the variable condition", () => {
  it("offers the same fields as the assertion", async () => {
    renderComposer("condition");
    await chooseVariableCondition();
    expect(chip("orderTotal")).toBeTruthy();
  });

  it("inserts an if/end-if pair carrying the comparison", async () => {
    const { onAdd } = renderComposer("condition");
    await chooseVariableCondition();
    fireEvent.click(chip("role"));
    submit();
    expect(onAdd.mock.calls[0][0]).toEqual([
      { type: "if", cond: "variable", captureVar: "role", compareOp: "eq", value: "" },
      { type: "endif" },
    ]);
  });

  it("REFUSES the submit when no variable was chosen", async () => {
    // Worse here than on the assertion: a condition that compares nothing takes
    // the same branch on every run, silently.
    const { onAdd } = renderComposer("condition");
    await chooseVariableCondition();
    submit();
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe("the echo kind", () => {
  it("refuses an empty message", () => {
    const { onAdd } = renderComposer("echo");
    submit();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("inserts the message it was given", () => {
    const { onAdd } = renderComposer("echo");
    fireEvent.change(screen.getByPlaceholderText("order is ${orderId}"), {
      target: { value: "role is ${role}" },
    });
    submit();
    expect(onAdd.mock.calls[0][0]).toEqual([{ type: "echo", text: "role is ${role}" }]);
  });

  it("says it can never fail", () => {
    renderComposer("echo");
    expect(screen.getByText(/never fail/i)).toBeTruthy();
  });
});
