// The top strip, wired to the router.
//
// Two things here can be wrong in a way nothing else would catch. The
// breadcrumb can name the wrong screen — which is worse than naming none,
// because it is confidently wrong — and the rail handle can stop reaching the
// SplitView it is meant to collapse, which reads as a dead button.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SplitView } from "@ui";

import type { TestRecord } from "../lib/recorder-types";
import { AppStrip } from "./app-strip";

let pathname = "/";
let params: { id?: string } = {};
let tests: TestRecord[] = [];
const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => params,
  useRouterState: (opts: { select: (s: unknown) => unknown }) =>
    opts.select({ location: { pathname } }),
}));

vi.mock("../lib/api", () => ({
  api: { tests: { list: async () => tests } },
}));

const invoke = vi.fn(async () => {});

function record(over: Partial<TestRecord> = {}): TestRecord {
  return {
    id: "t1",
    name: "Checkout",
    url: "https://example.test/",
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    scriptPath: "/tmp/t1.spec.ts",
    ...over,
  } as TestRecord;
}

/** Mounted the way the app mounts it: as the SplitView's header slot, so the
 *  rail handle has the context it reads. */
function renderStrip(props: { recording?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SplitView header={<AppStrip {...props} />} sidebar={<div>rail</div>} storageKey="test-strip">
        <div>content</div>
      </SplitView>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  pathname = "/";
  params = {};
  tests = [];
  navigate.mockClear();
  invoke.mockClear();
  window.localStorage.clear();
  (window as unknown as { glazeAPI: Record<string, unknown> }).glazeAPI = {
    glaze: { ipc: { invoke } },
  };
});

describe("breadcrumb", () => {
  it("says Home, and offers no link to where you already are", () => {
    renderStrip();
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
  });

  it("names the view under a Home you can click", () => {
    pathname = "/stats";
    renderStrip();
    expect(screen.getByText("Stats").getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("names the OPEN TEST, not its id", () => {
    pathname = "/test/t1";
    params = { id: "t1" };
    tests = [record()];
    renderStrip();
    return waitFor(() => expect(screen.getByText("Checkout")).toBeTruthy());
  });

  it("says Test until the name has loaded, rather than flashing an id", () => {
    // A crumb that shows `t-9f2c` and then becomes "Checkout" is two different
    // sentences in the same place. The id is never the answer here.
    pathname = "/test/t1";
    params = { id: "t1" };
    tests = [];
    renderStrip();
    expect(screen.getByText("Test")).toBeTruthy();
    expect(screen.queryByText("t1")).toBeNull();
  });

  it("says Recording while the trainer has replaced the outlet", () => {
    // THE ONE CASE THE ROUTER CANNOT ANSWER. `RootShell` swaps the whole outlet
    // for the trainer WITHOUT navigating, so the route still reads /stats under
    // a screen showing the recorder. A breadcrumb derived purely from the
    // router would confidently name the wrong screen.
    pathname = "/stats";
    renderStrip({ recording: true });
    expect(screen.getByText("Recording")).toBeTruthy();
    expect(screen.queryByText("Stats")).toBeNull();
  });

  it("falls back to Home alone on a route it has no label for", () => {
    pathname = "/somewhere-new";
    renderStrip();
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.queryByText("/somewhere-new")).toBeNull();
  });
});

describe("rail handle", () => {
  it("collapses and restores the rail", () => {
    renderStrip();
    expect(screen.getByText("rail")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide library" }));
    expect(screen.queryByText("rail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show library" }));
    expect(screen.getByText("rail")).toBeTruthy();
  });

  it("labels itself by what pressing it does", () => {
    // The state is announced by aria-pressed; the label is the ACTION, which is
    // the part a screen-reader user cannot work out for themselves.
    renderStrip();
    const handle = screen.getByRole("button", { name: "Hide library" });
    expect(handle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(handle);
    expect(screen.getByRole("button", { name: "Show library" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("survives the rail it collapsed", () => {
    // The reason the handle is in the strip rather than in the rail's own
    // header: a control that disappears with the thing it hides leaves ⌃⌘S as
    // the only way back.
    renderStrip();
    fireEvent.click(screen.getByRole("button", { name: "Hide library" }));
    expect(screen.getByRole("button", { name: "Show library" })).toBeTruthy();
  });
});

describe("settings", () => {
  it("opens the settings window", () => {
    renderStrip();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(invoke).toHaveBeenCalledWith("window:openSettings");
  });
});

describe("the two Phase C slots", () => {
  it("renders no ⌘K affordance and no ticker", () => {
    // Neither feature exists (REDESIGN §6.7, §6.8). A hint for a palette that
    // does not open teaches a shortcut that answers with silence — so the slot
    // stays empty until there is something to put in it, and this is the test
    // that would notice a placeholder creeping in.
    renderStrip();
    expect(screen.queryByText(/⌘K/)).toBeNull();
    const buttons = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(buttons).toEqual(["Hide library", "Settings"]);
  });
});
