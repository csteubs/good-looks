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

/** The router's memory history, as much of it as the strip reads.
 *
 *  `__TSR_index` and `length` are how the forward button knows whether there is
 *  anywhere ahead: the history API has `canGoBack()` and no `canGoForward()`,
 *  and memory history stamps the index into each entry's state. */
const history = {
  index: 0,
  length: 1,
  canGoBack: vi.fn(() => history.index > 0),
  back: vi.fn(),
  forward: vi.fn(),
};

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => params,
  useRouter: () => ({ history }),
  useRouterState: (opts: { select: (s: unknown) => unknown }) =>
    opts.select({ location: { pathname, state: { __TSR_index: history.index } } }),
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
  history.index = 0;
  history.length = 1;
  history.back.mockClear();
  history.forward.mockClear();
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
    // The exact inventory, deliberately — this is the test that notices a
    // placeholder creeping in, and it can only do that by enumerating.
    // Back/Forward joined the strip with the Stats drill: they are real
    // controls over the router's own history, not slots for a future feature,
    // and both are disabled here because there is nowhere to go.
    expect(buttons).toEqual(["Hide library", "Back", "Forward", "Settings"]);
  });
});

// ── The Stats drill's trail, and the controls beside it ───────────────
//
// The breadcrumb is the reason the category board is ROUTED rather than holding
// a stack in the view: the app already has one surface that says where you are.
// These pin that it says the right thing at each depth, including for a
// category that does not exist — a URL can say anything, and a trail that
// confidently rendered "Nonsense" would be naming a screen that isn't there.

describe("the Stats drill", () => {
  it("names the category at depth two", async () => {
    pathname = "/stats/stability";
    renderStrip();
    await waitFor(() => expect(screen.getByText("Stability")).toBeTruthy());
    // "Stats" is a link back up; the category is where you are.
    fireEvent.click(screen.getByRole("button", { name: "Stats" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/stats" });
  });

  it("names the facet at depth three, with the category still a link", async () => {
    pathname = "/stats/stability/flaky";
    renderStrip();
    // "Flaky", not "flaky" — the trail names the facet the way the app names
    // it, never the way the route spells it. The ids that reach the URL are
    // internal vocabulary ("changed-since"), and leaking one into the
    // breadcrumb puts an implementation detail on screen.
    await waitFor(() => expect(screen.getByText("Flaky")).toBeTruthy());
    expect(screen.queryByText("flaky")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stability" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/stats/$category",
      params: { category: "stability" },
    });
  });

  it("does not invent a name for a category that does not exist", async () => {
    // Resolved through the registry rather than title-cased from the URL.
    pathname = "/stats/nonsense";
    renderStrip();
    await waitFor(() => expect(screen.getByText("Stats")).toBeTruthy());
    expect(screen.queryByText(/nonsense/i)).toBeNull();
  });
});

describe("back and forward", () => {
  // The app had neither before the Stats drill, and it genuinely was not
  // missing: every screen was one level deep and the router runs on memory
  // history, so there was never anywhere to go back TO.

  it("disables both when there is nowhere to go", async () => {
    renderStrip();
    await waitFor(() => expect(screen.getByRole("button", { name: "Back" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Forward" }).hasAttribute("disabled")).toBe(true);
  });

  it("enables Back once there is history behind you", async () => {
    history.index = 2;
    history.length = 3;
    renderStrip();
    const back = await screen.findByRole("button", { name: "Back" });
    expect(back.hasAttribute("disabled")).toBe(false);
    fireEvent.click(back);
    expect(history.back).toHaveBeenCalled();
    // Nothing ahead — the last entry IS where we are.
    expect(screen.getByRole("button", { name: "Forward" }).hasAttribute("disabled")).toBe(true);
  });

  it("enables Forward only when an entry is actually ahead", async () => {
    // The assertion that would go red if someone rendered Forward always-on.
    // The history API has no canGoForward(); this is derived from the index.
    history.index = 0;
    history.length = 3;
    renderStrip();
    const fwd = await screen.findByRole("button", { name: "Forward" });
    expect(fwd.hasAttribute("disabled")).toBe(false);
    fireEvent.click(fwd);
    expect(history.forward).toHaveBeenCalled();
  });

  it("takes the keyboard shortcuts", async () => {
    history.index = 1;
    history.length = 2;
    renderStrip();
    await screen.findByRole("button", { name: "Back" });
    fireEvent.keyDown(window, { key: "[", metaKey: true });
    expect(history.back).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "]", metaKey: true });
    expect(history.forward).toHaveBeenCalled();
  });

  it("does NOT steal the keystroke from a text field", async () => {
    // The log search and every inline editor in the app are plain inputs, and
    // "[" is a character someone may well be typing.
    history.index = 1;
    history.length = 2;
    renderStrip();
    await screen.findByRole("button", { name: "Back" });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "[", metaKey: true });
    expect(history.back).not.toHaveBeenCalled();
    input.remove();
  });
});
