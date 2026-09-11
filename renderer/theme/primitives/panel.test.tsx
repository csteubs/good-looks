import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { Panel } from "./panel";

describe("<Panel />", () => {
  it("has no header at all when there is nothing to put in one", () => {
    // A 32px empty strip above the content is not a neutral default — it eats
    // the same space a real header would and reads as a heading that failed to
    // render.
    const { container } = render(<Panel>body</Panel>);
    expect(container.querySelector(".gl-panel-head")).toBeNull();
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("renders a header for a title alone, an id alone, or controls alone", () => {
    for (const props of [{ title: "Steps" }, { id: "t-checkout" }, { right: <b>x</b> }]) {
      const { container, unmount } = render(<Panel {...props}>b</Panel>);
      expect(container.querySelector(".gl-panel-head")).not.toBeNull();
      unmount();
    }
  });

  it("gives the truncating id its full text as a hint, never as a title attribute", () => {
    // The id truncates by design, and it is the one thing in the header someone
    // needs the whole of. It was a `title` attribute until the pinned Electron
    // stopped showing those on macOS (primitives/hint.tsx); now the span is a
    // hint trigger. Hover-only — an id is not a control — so what jsdom can
    // pin is the wiring and the absence of the attribute that no longer works.
    render(<Panel title="Run" id="run-2026-08-08-a-very-long-identifier" />);
    const id = screen.getByText("run-2026-08-08-a-very-long-identifier");
    expect(id.className).toBe("gl-panel-id");
    expect(id.getAttribute("title")).toBeNull();
    expect(id.getAttribute("data-state")).toBe("closed");
  });

  it("caps the BODY's height, not the panel's", () => {
    // Capping the panel would scroll the header out of view, which is how a
    // long list loses the control that filters it.
    const { container } = render(
      <Panel title="Steps" bodyMax={200}>
        b
      </Panel>,
    );
    const panel = container.querySelector(".gl-panel") as HTMLElement;
    const body = container.querySelector(".gl-panel-body") as HTMLElement;
    expect(body.style.maxHeight).toBe("200px");
    expect(panel.style.maxHeight).toBe("");
  });

  it("treats pad={true} as the default 10 and pad={0} as none", () => {
    const { container: a } = render(<Panel pad>b</Panel>);
    expect((a.querySelector(".gl-panel-body") as HTMLElement).style.padding).toBe("10px");

    const { container: b } = render(<Panel pad={0}>b</Panel>);
    expect((b.querySelector(".gl-panel-body") as HTMLElement).style.padding).toBe("0px");

    // Unset is genuinely unset — the body has no padding declaration at all, so
    // a caller can style it from outside without fighting a default.
    const { container: c } = render(<Panel>b</Panel>);
    expect((c.querySelector(".gl-panel-body") as HTMLElement).style.padding).toBe("");
  });

  it("keeps a caller's own style rather than dropping it for the flex default", () => {
    const { container } = render(
      <Panel flex style={{ minWidth: 330 }}>
        b
      </Panel>,
    );
    const panel = container.querySelector(".gl-panel") as HTMLElement;
    expect(panel.style.minWidth).toBe("330px");
    expect(panel.style.flex).toBe("1 1 auto");
  });
});
