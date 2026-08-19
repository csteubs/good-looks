// Component tests for the Add-step composer's RUN FLOW kind — the argument
// half of the flows UI.
//
// What matters here is what the submitted step CARRIES: the picked flow's id,
// and flowArgs holding exactly the filled-in parameters. Blank fields must
// leave their keys out (the generator reads an absent key as "use the flow's
// default" — see main/services/flow-binding.test.ts), and switching flows must
// drop drafted values rather than smuggle them across on a shared name.
//
// The flow dropdown is the app's native-menu-backed Select, so its options
// never enter the DOM. It IS drivable the appearance-pane way: the menu opens
// through `glazeAPI.Menu.popup`, and stubbing that to answer with the wanted
// item's commandId runs the same onValueChange a real click would.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { FlowInfo } from "../lib/api";
import type { RawStep } from "../lib/recorder-types";
import { StepComposer } from "./step-composer";

let flowList: FlowInfo[] = [];

vi.mock("../lib/api", () => ({
  api: {
    tests: {
      listFlows: async (_fromId?: string) => flowList,
    },
  },
}));

/** Answer the NEXT native-menu popup with the item labelled `label`. */
function armNativeMenu(label: string): void {
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
    if (!hit) {
      throw new Error(
        `no menu item labelled "${label}" (saw: ${flat.map((i) => i.label).join(", ")})`,
      );
    }
    return { commandId: hit.commandId };
  });
  (window as unknown as { glazeAPI: { Menu: { popup: unknown } } }).glazeAPI = {
    Menu: { popup },
  };
}

function renderComposer() {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="runFlow"
      currentTestId="t-current"
      onCancel={() => {}}
      onAdd={onAdd}
      picked={null}
      onStartPick={() => {}}
      onClearPick={() => {}}
    />,
  );
  return { onAdd };
}

/** Pick a flow from the native-menu Select by its visible name.
 *
 *  `triggerText` is what the closed trigger currently shows — the placeholder
 *  before any selection, the selected flow's name after one. */
async function chooseFlow(name: string, triggerText = "Choose a flow"): Promise<void> {
  armNativeMenu(name);
  fireEvent.click(await screen.findByText(triggerText));
  // The popup promise resolves on a microtask; one findBy below absorbs it.
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /add step/i }));
}

const LOGIN: FlowInfo = {
  id: "f1",
  name: "Login",
  flowParams: ["email", "password"],
  paramDefaults: { email: "default@x.com", password: "" },
};
const RESET: FlowInfo = {
  id: "f2",
  name: "Reset",
  flowParams: ["email"],
  paramDefaults: { email: "" },
};

describe("run flow insertion", () => {
  it("inserts without flowArgs when every parameter is left blank", async () => {
    flowList = [LOGIN];
    const { onAdd } = renderComposer();
    await chooseFlow("Login");
    await screen.findByLabelText("Flow argument email");
    submit();
    expect(onAdd).toHaveBeenCalledTimes(1);
    const step = (onAdd.mock.calls[0][0] as RawStep[])[0];
    expect(step).toEqual({ type: "runFlow", flowId: "f1", label: "Login" });
    // The KEY must be absent, not empty — an empty flowArgs object would still
    // read as "the caller supplied nothing", but shipping one invites the next
    // reader to treat it as a value.
    expect("flowArgs" in step).toBe(false);
  });

  it("stores exactly the filled-in parameters", async () => {
    flowList = [LOGIN];
    const { onAdd } = renderComposer();
    await chooseFlow("Login");
    const email = await screen.findByLabelText("Flow argument email");
    fireEvent.change(email, { target: { value: "caller@x.com" } });
    submit();
    const step = (onAdd.mock.calls[0][0] as RawStep[])[0];
    expect(step.flowArgs).toEqual({ email: "caller@x.com" });
  });

  it("shows each parameter's default as placeholder text", async () => {
    flowList = [LOGIN];
    renderComposer();
    await chooseFlow("Login");
    const email = (await screen.findByLabelText("Flow argument email")) as HTMLInputElement;
    expect(email.placeholder).toBe("Default: default@x.com");
    const password = screen.getByLabelText("Flow argument password") as HTMLInputElement;
    expect(password.placeholder).toBe("Uses the flow's default");
  });

  it("drops drafted values when the flow changes", async () => {
    // Both flows declare `email`. A value drafted for Login must not ride
    // along to Reset on the shared name — same parameter name, different
    // meaning, and the field would look deliberately filled.
    flowList = [LOGIN, RESET];
    const { onAdd } = renderComposer();
    await chooseFlow("Login");
    const email = await screen.findByLabelText("Flow argument email");
    fireEvent.change(email, { target: { value: "caller@x.com" } });
    await chooseFlow("Reset", "Login");
    const emailAfter = (await screen.findByLabelText(
      "Flow argument email",
    )) as HTMLInputElement;
    expect(emailAfter.value).toBe("");
    submit();
    const step = (onAdd.mock.calls[0][0] as RawStep[])[0];
    expect(step.flowId).toBe("f2");
    expect("flowArgs" in step).toBe(false);
  });
});
