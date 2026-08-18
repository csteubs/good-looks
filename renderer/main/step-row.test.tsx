// Component tests for the step row.
//
// StepRow is the most-reused component in the app — it renders every step in
// the trainer, the step editor and the test detail view — so a regression here
// shows up in three places at once. It's also where run status becomes visible:
// the pass/fail highlight during a run is this component's job, and "the step
// list didn't update" is a bug users notice immediately.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

import type { Step, StepType } from "../lib/recorder-types";
import { SEL_RING, TONE, hexToRgb } from "../theme";
import { StepRow } from "./step-row";

/** jsdom normalises an inline `color` to `rgb(r, g, b)`, so a hex assertion
 *  never matches what reads back. (`box-shadow` is NOT normalised — see
 *  CLAUDE.md; that difference has cost time here before.) */
function rgb(hex: string): string {
  const c = hexToRgb(hex);
  return `rgb(${c![0]}, ${c![1]}, ${c![2]})`;
}

/**
 * Does this row carry the status rail in `tone`?
 *
 * CHECKS BOTH NOTATIONS, and that is not belt-and-braces. jsdom leaves
 * `box-shadow` exactly as written, so today `inset 2px 0 0 0 #ff4d61` reads back
 * with the hex — but the same string run through anything that normalises it
 * comes back as `rgb(...)`, and an assertion pinned to one notation would then
 * report a working rail as missing. The rule in CLAUDE.md is about the NEGATIVE
 * case, which is worse: `not.toContain("rgb(...)")` can never fire against a
 * shadow written in hex, so it passes against the very thing it forbids.
 */
function hasRail(el: HTMLElement, hex: string): boolean {
  const shadow = el.style.boxShadow;
  return shadow.includes(hex) || shadow.includes(rgb(hex));
}

function step(partial: Partial<Step> & { type: StepType }): Step {
  return { id: "s1", timestamp: 0, ...partial } as Step;
}

const LOCATOR = { k: "role", role: "button", name: "Submit" } as const;

describe("rendering", () => {
  it("shows a 1-based position", () => {
    // The list is 0-indexed internally; showing "0" would be confusing.
    render(<StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />);
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("describes the step", () => {
    render(<StepRow index={0} step={step({ type: "goto", url: "https://example.com" })} />);
    expect(screen.getByText(/example\.com/)).toBeTruthy();
  });

  it("labels the step type", () => {
    render(<StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />);
    expect(screen.getByText("click")).toBeTruthy();
  });

  it("renders 'end if' rather than the raw type name", () => {
    const { container } = render(<StepRow index={0} step={step({ type: "endif" })} />);
    // Both the badge and the description read "end if"; what matters is that
    // the raw type token never surfaces.
    expect(container.textContent).toContain("end if");
    expect(container.textContent).not.toContain("endif");
  });

  it("renders a cookie step", () => {
    render(
      <StepRow
        index={0}
        step={step({
          type: "cookie",
          cookieAction: "set",
          cookie: { name: "session", value: "abc", domain: "example.com" },
        })}
      />,
    );
    expect(screen.getByText("cookie")).toBeTruthy();
    expect(screen.getByText(/set cookie session/)).toBeTruthy();
  });
});

describe("the type chip is not a verdict", () => {
  it("draws the step type with the theme's chip", () => {
    // The SDK `Badge` this replaced mapped `assert` onto its GREEN colour —
    // the pass hue — on every assertion in every list, so a step list read as
    // a list of results. `TypeChip`'s palette is deliberately separate from
    // the status palette: a step's type is not an outcome.
    const { container } = render(
      <StepRow index={0} step={step({ type: "assert", locator: LOCATOR })} />,
    );
    const chip = container.querySelector('[data-gl="type-chip"]') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.dataset.type).toBe("assert");
    for (const [name, hex] of Object.entries(TONE)) {
      expect(chip.style.color, name).not.toBe(rgb(hex));
    }
  });
});

describe("run status", () => {
  it("colours the glyph with the tone the palette declares for it", () => {
    // COLOUR MEANS OUTCOME, and this glyph is the one thing on the row
    // reporting one. `running` is cyan — the token's own definition is
    // "running / live / focus" — and it used to be the SDK's accent, which is
    // a different blue that means nothing in this palette.
    for (const [status, hex] of [
      ["running", TONE.cyan],
      ["passed", TONE.phos],
      ["failed", TONE.red],
    ] as const) {
      const { container } = render(
        <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} runStatus={status} />,
      );
      const glyph = container.querySelector(`[aria-label="Step ${status}"]`) as HTMLElement;
      expect(glyph, status).not.toBeNull();
      expect(glyph.style.color, status).toBe(rgb(hex));
    }
  });

  it("marks a passed step with the leading rail, not a fill", () => {
    // A RAIL SINCE B5a. It was a tinted background plus a ring, which in this
    // palette makes the row itself the largest coloured surface on screen — a
    // list with four failures reads as mostly-red before a word is scanned —
    // and put the colour UNDER the description, which is the text it is about.
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} runStatus="passed" />,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(hasRail(row, TONE.phos)).toBe(true);
    // The fill is the half that had to go; a rail beside a green row is the
    // same bug wearing a smaller coat.
    expect(row.style.background).toBe("");
  });

  it("marks a failed step with the leading rail, not a fill", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} runStatus="failed" />,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(hasRail(row, TONE.red)).toBe(true);
    expect(row.style.background).toBe("");
  });

  it("marks a running step in cyan, which is not one of the outcomes", () => {
    // Running is the ABSENCE of a result. Giving it phos or red would make a
    // step still in flight look like one that has finished and reported.
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} runStatus="running" />,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(hasRail(row, TONE.cyan)).toBe(true);
    expect(hasRail(row, TONE.phos)).toBe(false);
    expect(hasRail(row, TONE.red)).toBe(false);
  });

  it("looks different from an unrun step", () => {
    const plain = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />,
    ).container.innerHTML;
    const failed = render(
      <StepRow index={1} step={step({ type: "click", locator: LOCATOR })} runStatus="failed" />,
    ).container.innerHTML;
    expect(failed).not.toBe(plain);
  });
});

describe("newly-added highlight", () => {
  // jsdom has no layout or animation engine, so the pulse itself cannot be
  // observed here — `check:step-glow-css` pins the stylesheet side. What these
  // tests own is the decision: WHICH rows claim to be new, and whether that
  // claim quietly cancels one of the other highlights the row already carries.

  /** The row element itself — the highlight lives on the row, not a child. */
  function row(container: HTMLElement): HTMLElement {
    const el = container.firstElementChild;
    if (!(el instanceof HTMLElement)) throw new Error("StepRow rendered no element");
    return el;
  }

  it("marks a new step", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} isNew />,
    );
    expect(row(container).getAttribute("data-new-step")).toBe("true");
    expect(row(container).className).toContain("step-new");
  });

  it("does NOT mark an ordinary step", () => {
    // The default matters more than it looks: every other caller of StepRow —
    // the trainer, the step editor, the detail view — renders without this
    // prop, and a truthy default would light up every row in the app.
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />,
    );
    expect(row(container).hasAttribute("data-new-step")).toBe(false);
    expect(row(container).className).not.toContain("step-new");
  });

  it("does NOT mark a step passed isNew={false}", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} isNew={false} />,
    );
    expect(row(container).hasAttribute("data-new-step")).toBe(false);
  });

  it("keeps the failed run highlight on a step that is also new", () => {
    // A step the AI just added AND that just failed is the most important row
    // on the screen. Earlier drafts put the new-step style in the same
    // precedence chain as run status, which silently dropped one or the other.
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} runStatus="failed" isNew />,
    );
    expect(row(container).getAttribute("data-new-step")).toBe("true");
    expect(row(container).className).toContain("step-new");
    expect(hasRail(row(container), TONE.red)).toBe(true);
  });

  it("keeps the passed run highlight on a step that is also new", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} runStatus="passed" isNew />,
    );
    expect(row(container).className).toContain("step-new");
    expect(hasRail(row(container), TONE.phos)).toBe(true);
  });

  it("keeps the selection ring on a step that is also new", () => {
    // NEUTRAL SINCE B5a, and that is the palette rule rather than a restyle:
    // colour means outcome, so a selected row in the accent competes with what
    // the rail beside it is reporting. `check:selection-neutral` pins that no
    // selection in this app is drawn in a status hue.
    const plain = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} selected onSelect={() => {}} />,
    );
    expect(row(plain.container).style.boxShadow).toContain(SEL_RING);
    expect(row(plain.container).className).not.toContain("ring-accent");

    const { container } = render(
      <StepRow index={1} step={step({ type: "click", locator: LOCATOR })} selected onSelect={() => {}} isNew />,
    );
    expect(row(container).style.boxShadow).toContain(SEL_RING);
    expect(row(container).className).toContain("step-new");
  });

  it("shows the rail and the selection lift at once on a selected failing row", () => {
    // The single most interesting row on a failed run's step list. They are
    // both box-shadows, so they compose in one declaration — earlier drafts had
    // one property replacing the other and whichever rendered last won.
    const { container } = render(
      <StepRow
        index={0}
        step={step({ type: "click", locator: LOCATOR })}
        runStatus="failed"
        selected
        onSelect={() => {}}
      />,
    );
    const el = row(container);
    expect(hasRail(el, TONE.red)).toBe(true);
    expect(el.style.boxShadow).toContain(SEL_RING);
  });

  it("leaves the drag-over drop indicator intact", () => {
    const { container } = render(
      <StepRow
        index={0}
        step={step({ type: "click", locator: LOCATOR })}
        isNew
        drag={{
          onDragStart: () => {},
          onDragEnter: () => {},
          onDragEnd: () => {},
          isDragging: false,
          isOver: true,
        }}
      />,
    );
    expect(row(container).className).toContain("border-accent");
    expect(row(container).className).toContain("step-new");
  });
});

describe("actions", () => {
  it("calls onSelect when the row is clicked", () => {
    const onSelect = vi.fn();
    render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByText(/Submit/));
    expect(onSelect).toHaveBeenCalled();
  });

  it("does NOT select when an inner control is clicked", () => {
    // Otherwise deleting a step also selects it, which fights the user.
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(
      <StepRow
        index={0}
        step={step({ type: "click", locator: LOCATOR })}
        onSelect={onSelect}
        onDelete={onDelete}
      />,
    );
    const button = container.querySelector("button");
    // Assert the control EXISTS: guarding with `if (button)` would let this
    // test pass vacuously the day the delete button stops rendering.
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("offers no replay control for steps that can't be replayed alone", () => {
    // goto restarts the session's navigation; endif is a block delimiter.
    // `viewport` is deliberately NOT here — see the test below.
    for (const type of ["goto", "endif"] as StepType[]) {
      const { container, unmount } = render(
        <StepRow index={0} step={step({ type })} onReplay={async () => ({ ok: true })} />,
      );
      const labels = [...container.querySelectorAll("button")].map((b) =>
        (b.getAttribute("aria-label") ?? "").toLowerCase(),
      );
      expect(labels.some((l) => l.includes("replay")), type).toBe(false);
      unmount();
    }
  });

  it("offers a replay control for a click step", () => {
    const { container } = render(
      <StepRow
        index={0}
        step={step({ type: "click", locator: LOCATOR })}
        onReplay={async () => ({ ok: true })}
      />,
    );
    const labels = [...container.querySelectorAll("button")].map((b) =>
      (b.getAttribute("aria-label") ?? "").toLowerCase(),
    );
    expect(labels.some((l) => l.includes("replay"))).toBe(true);
  });
});

describe("indentation for conditional blocks", () => {
  it("indents a nested step", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} indent={2} />,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.style.marginLeft).toBe("40px");
  });

  it("leaves a top-level step unindented", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.style.marginLeft).toBe("");
  });
});

describe("drag affordance", () => {
  it("shows a grip only when dragging is enabled", () => {
    const withDrag = render(
      <StepRow
        index={0}
        step={step({ type: "click", locator: LOCATOR })}
        drag={{
          onDragStart: vi.fn(),
          onDragEnter: vi.fn(),
          onDragEnd: vi.fn(),
          isDragging: false,
          isOver: false,
        }}
      />,
    );
    expect(within(withDrag.container).getByLabelText(/drag to reorder/i)).toBeTruthy();
    withDrag.unmount();

    const without = render(<StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />);
    expect(within(without.container).queryByLabelText(/drag to reorder/i)).toBeNull();
  });

  it("starts a drag from the grip", () => {
    const onDragStart = vi.fn();
    render(
      <StepRow
        index={0}
        step={step({ type: "click", locator: LOCATOR })}
        drag={{
          onDragStart,
          onDragEnter: vi.fn(),
          onDragEnd: vi.fn(),
          isDragging: false,
          isOver: false,
        }}
      />,
    );
    fireEvent.dragStart(screen.getByLabelText(/drag to reorder/i));
    expect(onDragStart).toHaveBeenCalled();
  });
});

describe("viewport (window resize) rows", () => {
  // A resize step is the one recorded action with no on-page target, so it
  // reaches none of the affordances above through a locator. Everything it
  // does get, it gets because this type is handled explicitly.

  it("offers a replay control, because a resize CAN be previewed alone", () => {
    // The counterpart to "offers no replay control…" above. Replaying a resize
    // resizes the training window, which is the whole thing worth checking
    // before trusting the step.
    const { container } = render(
      <StepRow
        index={0}
        step={step({ type: "viewport", width: 390, height: 844 })}
        onReplay={async () => ({ ok: true })}
      />,
    );
    const labels = [...container.querySelectorAll("button")].map((b) =>
      (b.getAttribute("aria-label") ?? "").toLowerCase(),
    );
    expect(labels.some((l) => l.includes("replay"))).toBe(true);
  });

  it("edits both dimensions from one field", () => {
    const onEdit = vi.fn();
    render(
      <StepRow
        index={0}
        step={step({ type: "viewport", width: 1280, height: 800 })}
        onEdit={onEdit}
      />,
    );
    fireEvent.click(screen.getByLabelText(/edit step/i));
    const input = screen.getByLabelText(/edit size/i) as HTMLInputElement;
    // Seeded with the current size — an empty box would make an edit read as
    // "type a size" rather than "change this one".
    expect(input.value).toBe("1280x800");
    fireEvent.change(input, { target: { value: "390 × 844" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEdit).toHaveBeenCalledWith({ width: 390, height: 844 });
  });

  it("commits nothing when the typed size can't be parsed", () => {
    // Half a size is not a smaller edit — it's a step that generates a spec
    // Playwright rejects. Leaving the step alone is the safe answer.
    const onEdit = vi.fn();
    render(
      <StepRow
        index={0}
        step={step({ type: "viewport", width: 1280, height: 800 })}
        onEdit={onEdit}
      />,
    );
    fireEvent.click(screen.getByLabelText(/edit step/i));
    const input = screen.getByLabelText(/edit size/i);
    fireEvent.change(input, { target: { value: "1280 wide" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("clamps a typed size into the range a window can actually be", () => {
    const onEdit = vi.fn();
    render(
      <StepRow index={0} step={step({ type: "viewport", width: 1280, height: 800 })} onEdit={onEdit} />,
    );
    fireEvent.click(screen.getByLabelText(/edit step/i));
    const input = screen.getByLabelText(/edit size/i);
    fireEvent.change(input, { target: { value: "99999x10" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEdit).toHaveBeenCalledWith({ width: 4000, height: 200 });
  });
});

describe("the replay pass/fail flash", () => {
  // The ephemeral outline that says "this step just ran, and here's how it
  // went". Its whole contract is a CSS class, so these tests can only assert
  // that the right class lands on the row — what the class DRAWS is pinned at
  // source level in check:step-glow, because jsdom has no animation engine and
  // the rules could be deleted outright without failing anything here.

  it("outlines a passing step in green", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} replayFlash="pass" />,
    );
    const row = container.firstElementChild!;
    expect(row.className).toContain("step-replay-pass");
    expect(row.getAttribute("data-replay-flash")).toBe("pass");
  });

  it("outlines a failing step in red", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} replayFlash="fail" />,
    );
    const row = container.firstElementChild!;
    expect(row.className).toContain("step-replay-fail");
    expect(row.getAttribute("data-replay-flash")).toBe("fail");
  });

  it("draws nothing when the step has not just been replayed", () => {
    const { container } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />,
    );
    const row = container.firstElementChild!;
    expect(row.className).not.toContain("step-replay");
    expect(row.getAttribute("data-replay-flash")).toBe(null);
  });

  it("wins over the new-step glow, and only for as long as it lasts", () => {
    // Both draw an `outline`, so only one can be on the element — otherwise
    // which one shows is decided by the order of two rules in a stylesheet,
    // which is not a decision this component made. A step inserted by an AI fix
    // and then immediately replayed is the row this actually happens to.
    const { container, rerender } = render(
      <StepRow index={0} step={step({ type: "click", locator: LOCATOR })} isNew replayFlash="fail" />,
    );
    const row = container.firstElementChild!;
    expect(row.className).toContain("step-replay-fail");
    expect(row.className).not.toContain("step-new");
    // `isNew` is still true underneath — the row must not lose its provenance
    // marker just because it was replayed once.
    expect(row.getAttribute("data-new-step")).toBe("true");

    // Flash expires; the glow comes back rather than the row going bare.
    rerender(<StepRow index={0} step={step({ type: "click", locator: LOCATOR })} isNew />);
    expect(container.firstElementChild!.className).toContain("step-new");
  });

  it("leaves the run-status highlight alone", () => {
    // The run highlight is an inset box-shadow and the flash is an outline,
    // which is the entire reason they are different CSS properties: a failing
    // step that just replayed should show both, not whichever one rendered
    // last.
    const { container } = render(
      <StepRow
        index={0}
        step={step({ type: "click", locator: LOCATOR })}
        runStatus="failed"
        replayFlash="fail"
      />,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain("step-replay-fail");
    expect(hasRail(row, TONE.red)).toBe(true);
  });
});

// ── Change temp, against real medians (C §6.3) ──────────────────────────
//
// The step list's whole job in this design is to let someone find the row that
// is UNUSUAL without reading forty durations. Two ways that fails silently: a
// temp that lights on a single run's noise (a GC pause, a slow DNS answer), and
// one that colours confidently against a median it does not have.

describe("the step's change temp", () => {
  const temp = () => document.querySelector('[data-gl="temp"]') as HTMLElement | null;

  it("renders nothing when metrics have no timings for this step", () => {
    render(<StepRow index={0} step={step({ type: "click", locator: LOCATOR })} />);
    expect(temp()).toBeNull();
    render(<StepRow index={0} step={step({ type: "click", locator: LOCATOR })} trend={{ recentP50Ms: null, previousP50Ms: 900 }} />);
    expect(temp()).toBeNull();
  });

  it("measures the recent median against the earlier one, not against a run", () => {
    // Both numbers are medians on purpose. A single run's duration for a single
    // step is noise, and colouring it would light half the list on every run
    // for reasons that are not about the test.
    render(<StepRow index={0} step={step({ type: "click", locator: LOCATOR })} trend={{ recentP50Ms: 2400, previousP50Ms: 900 }} />);
    expect(temp()?.dataset.mode).toBe("rule");
    expect(temp()?.getAttribute("title")).toContain("vs median");
  });

  it("goes neutral rather than confident when there is nothing to compare against", () => {
    // `Temp` falls to `off` on a missing median by itself — this pins that the
    // call site does not paper over it with a substituted number, and that the
    // row says WHY instead of just showing a colourless figure.
    render(<StepRow index={0} step={step({ type: "click", locator: LOCATOR })} trend={{ recentP50Ms: 2400, previousP50Ms: null }} />);
    expect(temp()?.dataset.mode).toBe("off");
    expect(temp()?.getAttribute("title")).toContain("no earlier runs to compare against");
  });
});

// ── Inserting a variable into an inline edit ──────────────────────────────
//
// The path for a step that ALREADY EXISTS — a password typed during recording,
// captured verbatim. Replacing that value with `${storePassword}` is the whole
// remediation, and before this button the only way to do it was to know the
// syntax existed.
//
// The button is offered through the app's native menu, so the pick itself is
// not in the DOM (CLAUDE.md). What IS testable, and what matters, is that
// opening it does not destroy the editor underneath it: `Menu.popup` takes
// focus off the page, the input blurs, and a blur that commits would close the
// field before the pick came back — leaving the chosen variable with nowhere
// to go and the user looking at their unchanged step.

describe("inserting a variable inline", () => {
  const VARS = [
    { name: "storePassword", kind: "secret" as const },
    { name: "customerEmail", kind: "plain" as const, value: "a@b.c" },
  ];

  /** Answer the native menu with the item whose label matches. */
  function stubMenu(label: string | null) {
    const popup = vi.fn(async (opts: { items: { label?: string; commandId?: number }[] }) => {
      if (label === null) return {};
      const hit = opts.items.find((i) => i.label === label);
      if (!hit) throw new Error(`no menu item labelled "${label}"`);
      return { commandId: hit.commandId };
    });
    (window as unknown as { glazeAPI: { Menu: unknown } }).glazeAPI = { Menu: { popup } };
    return popup;
  }

  function openEditor(s: Step, variables = VARS) {
    const onEdit = vi.fn();
    render(<StepRow index={0} step={s} onEdit={onEdit} variables={variables} />);
    fireEvent.click(screen.getByLabelText(/edit step/i));
    return { onEdit };
  }

  it("offers the button on a value field", () => {
    openEditor(step({ type: "fill", locator: LOCATOR, value: "hunter2" }));
    expect(screen.getByLabelText(/insert a variable/i)).toBeTruthy();
  });

  it("does not offer it on a numeric field", () => {
    // `waitMs` is emitted as a bare numeral; a reference there is not a
    // variable, it's a spec that doesn't parse.
    openEditor(step({ type: "wait", waitMs: 1000 }));
    expect(screen.queryByLabelText(/insert a variable/i)).toBe(null);
  });

  it("does not offer it when the test declares none", () => {
    openEditor(step({ type: "fill", locator: LOCATOR, value: "hunter2" }), []);
    expect(screen.queryByLabelText(/insert a variable/i)).toBe(null);
  });

  it("is absent entirely on a read-only row", () => {
    // No `onEdit` — the detail view's list. Nothing here should gain a control.
    render(
      <StepRow index={0} step={step({ type: "fill", locator: LOCATOR, value: "x" })} variables={VARS} />,
    );
    expect(screen.queryByLabelText(/insert a variable/i)).toBe(null);
  });

  it("splices the reference in at the caret", async () => {
    stubMenu("${customerEmail}");
    openEditor(step({ type: "fill", locator: LOCATOR, value: "@example.com" }));
    const input = screen.getByLabelText(/edit value/i) as HTMLInputElement;
    input.setSelectionRange(0, 0);
    const button = screen.getByLabelText(/insert a variable/i);
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    await waitFor(() => expect(input.value).toBe("${customerEmail}@example.com"));
  });

  it("keeps the editor open while the menu is up", async () => {
    // The regression this exists for: `Menu.popup` blurs the input, and a blur
    // that commits unmounts the field mid-pick.
    stubMenu("${storePassword}");
    const { onEdit } = openEditor(step({ type: "fill", locator: LOCATOR, value: "" }));
    const button = screen.getByLabelText(/insert a variable/i);
    fireEvent.mouseDown(button);
    fireEvent.blur(screen.getByLabelText(/edit value/i));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/edit value/i)).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() =>
      expect((screen.getByLabelText(/edit value/i) as HTMLInputElement).value).toBe(
        "${storePassword}",
      ),
    );
  });

  it("commits the reference as the step's value", async () => {
    stubMenu("${storePassword}");
    const { onEdit } = openEditor(step({ type: "fill", locator: LOCATOR, value: "hunter2" }));
    const input = screen.getByLabelText(/edit value/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    const button = screen.getByLabelText(/insert a variable/i);
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    await waitFor(() => expect(input.value).toBe("${storePassword}"));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEdit).toHaveBeenCalledWith({ value: "${storePassword}" });
  });

  it("leaves the draft alone when the menu is dismissed", async () => {
    const popup = stubMenu(null);
    openEditor(step({ type: "fill", locator: LOCATOR, value: "hunter2" }));
    const input = screen.getByLabelText(/edit value/i) as HTMLInputElement;
    const button = screen.getByLabelText(/insert a variable/i);
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    await waitFor(() => expect(popup).toHaveBeenCalled());
    expect(input.value).toBe("hunter2");
  });
});
