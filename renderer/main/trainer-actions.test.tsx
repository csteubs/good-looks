// trainer-actions — the shared bar vocabulary, its menu encoding, and the
// create-flow gate. A `.tsx` file although nothing renders: a plain `.ts`
// test under renderer/main matches NEITHER vitest project and silently never
// runs (CLAUDE.md's glob trap), and the dom project is where this module's
// only consumers live anyway.

import { describe, expect, it, vi } from "vitest";

import type { Step } from "../lib/recorder-types";
import {
  ASSERT_PAGE,
  ASSERT_PICKABLE,
  CREATE_FLOW_HINT,
  CREATE_FLOW_READY,
  createFlowGate,
  pickAddStepFromMenu,
  pickAssertFromMenu,
} from "./trainer-actions";
import { ADD_STEP_KINDS } from "./trainer-actions";

/** A popup stub that answers with one commandId and records what it was shown. */
function stubMenu(commandId: number | undefined) {
  const popup = vi.fn().mockResolvedValue({ commandId });
  (window as unknown as { glazeAPI: { Menu: { popup: typeof popup } } }).glazeAPI = {
    Menu: { popup },
  };
  return popup;
}

const anchor = () =>
  ({
    currentTarget: {
      getBoundingClientRect: () => ({ left: 10, bottom: 20 }),
    },
  }) as unknown as React.MouseEvent<HTMLButtonElement>;

const step = (id: string): Step => ({ id, type: "click" }) as Step;

describe("the assert menu's commandId encoding", () => {
  // The +100 offset for the URL group is the one encoding that used to live
  // as two hand-synced copies — a drift here means a commandId silently
  // resolves to an ELEMENT assert in one trainer and a URL assert in the
  // other. One builder now; these rows pin both sides of the boundary.

  it("an element commandId arms that element kind", async () => {
    stubMenu(3);
    expect(await pickAssertFromMenu(anchor())).toEqual({
      group: "element",
      kind: ASSERT_PICKABLE[3].kind,
    });
  });

  it("a commandId of 100+i is the i-th PAGE kind, never an element", async () => {
    stubMenu(100);
    expect(await pickAssertFromMenu(anchor())).toEqual({
      group: "page",
      kind: ASSERT_PAGE[0].kind,
    });
  });

  it("a dismissed menu answers null, and an out-of-range id answers null", async () => {
    stubMenu(undefined);
    expect(await pickAssertFromMenu(anchor())).toBeNull();
    stubMenu(100 + ASSERT_PAGE.length);
    expect(await pickAssertFromMenu(anchor())).toBeNull();
  });

  it("shows every element kind, the separator, then every page kind offset by 100", async () => {
    const popup = stubMenu(undefined);
    await pickAssertFromMenu(anchor());
    const items = popup.mock.calls[0][0].items as {
      label?: string;
      type?: string;
      commandId?: number;
    }[];
    expect(items).toHaveLength(ASSERT_PICKABLE.length + 1 + ASSERT_PAGE.length);
    expect(items[ASSERT_PICKABLE.length].type).toBe("separator");
    expect(items[items.length - 1].commandId).toBe(100 + ASSERT_PAGE.length - 1);
  });
});

describe("the add-step menu", () => {
  it("maps commandId i to ADD_STEP_KINDS[i]", async () => {
    stubMenu(4);
    expect(await pickAddStepFromMenu(anchor())).toBe(ADD_STEP_KINDS[4]);
  });

  it("answers null when dismissed", async () => {
    stubMenu(undefined);
    expect(await pickAddStepFromMenu(anchor())).toBeNull();
  });
});

describe("createFlowGate — disabled-gated, never render-gated", () => {
  const steps = [step("a"), step("b"), step("c"), step("d")];

  it("no selection: disabled, the hint says what a selection would earn", () => {
    expect(createFlowGate(steps, [])).toEqual({
      count: 0,
      disabled: true,
      title: CREATE_FLOW_HINT,
    });
  });

  it("a gapped selection: disabled, the REASON is the title", () => {
    const gate = createFlowGate(steps, ["a", "c"]);
    expect(gate.disabled).toBe(true);
    expect(gate.title).toMatch(/contiguous run of steps/i);
  });

  it("a contiguous selection: enabled, count carried for the label", () => {
    expect(createFlowGate(steps, ["b", "c"])).toEqual({
      count: 2,
      disabled: false,
      title: CREATE_FLOW_READY,
    });
  });
});
