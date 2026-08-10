// Component tests for the tag cluster.
//
// What's worth covering here is the deletion path, and specifically the things
// that are silent when wrong: an X on "All" or "Untagged" would delete a tag
// that doesn't exist; a wrong count in the confirmation would understate how
// much of the library a click is about to change; and a delete that fires
// before the confirm is the whole failure this feature was built to avoid.
//
// The api module is mocked rather than the IPC bridge, so the tests state
// intent ("the library contains these tests") rather than channel plumbing.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { TestRecord } from "../lib/recorder-types";
import { ALL_TAGS } from "../lib/test-tags";
import { TagCluster } from "./tag-cluster";

const deleteTag = vi.fn(async (tag: string) => ({ tag, removed: 1 }));
const success = vi.fn();

vi.mock("../lib/api", () => ({
  api: { tests: { deleteTag: (tag: string) => deleteTag(tag) } },
}));

vi.mock("@ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ui")>();
  return {
    ...actual,
    toast: { success: (m: string) => success(m), error: vi.fn() },
  };
});

function test_(id: string, name: string, tags?: string[]): TestRecord {
  return {
    id,
    name,
    url: "https://example.com",
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    scriptPath: `/tmp/${id}.spec.ts`,
    ...(tags ? { tags } : {}),
  } as TestRecord;
}

function renderCluster(tests: TestRecord[], value = ALL_TAGS) {
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TagCluster tests={tests} value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

/** Open the confirmation behind a tag's X and return once its dialog is up. */
async function openConfirm(tag: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Delete tag ${tag}` }));
  return await screen.findByRole("alertdialog");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TagCluster delete affordance", () => {
  it("puts an X on every real tag", async () => {
    renderCluster([test_("a", "Alpha", ["smoke"]), test_("b", "Beta", ["checkout"])]);
    expect(await screen.findByRole("button", { name: "Delete tag smoke" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete tag checkout" })).toBeTruthy();
  });

  it("puts NO X on All or Untagged", async () => {
    // Neither is a tag — "deleting" them would either wipe every tag in the
    // library or do nothing at all, and there is no honest version of either.
    renderCluster([test_("a", "Alpha", ["smoke"]), test_("b", "Beta")]);
    await screen.findByRole("button", { name: /^All/ });
    expect(screen.getByRole("button", { name: /^Untagged/ })).toBeTruthy();
    // One X in the whole cluster: the one on "smoke".
    expect(screen.getAllByRole("button", { name: /^Delete tag / })).toHaveLength(1);
  });

  it("keeps the X out of the filter button, so the chip still filters", async () => {
    // The X sits inside the chip; if it were nested in the filter button the
    // click would either filter instead of deleting or not fire at all.
    const onChange = renderCluster([test_("a", "Alpha", ["smoke"])]);
    fireEvent.click(await screen.findByRole("button", { name: /^smoke · 1/ }));
    expect(onChange).toHaveBeenCalledWith("smoke");
    expect(deleteTag).not.toHaveBeenCalled();
  });
});

describe("TagCluster deletion confirmation", () => {
  it("deletes nothing until the confirmation is accepted", async () => {
    renderCluster([test_("a", "Alpha", ["smoke"])]);
    const dialog = await openConfirm("smoke");
    expect(deleteTag).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleteTag).not.toHaveBeenCalled();
  });

  it("deletes the tag once confirmed", async () => {
    renderCluster([test_("a", "Alpha", ["smoke"])]);
    const dialog = await openConfirm("smoke");
    fireEvent.click(within(dialog).getByRole("button", { name: /delete tag/i }));
    await waitFor(() => expect(deleteTag).toHaveBeenCalledWith("smoke"));
  });

  it("tells the user how many tests carry the tag, counting casings as one", async () => {
    // The count is the whole point of confirming: it's what says how much of
    // the library this click re-scopes. `smoke`/`Smoke` are one chip, so they
    // have to be one number here too.
    renderCluster([
      test_("a", "Alpha", ["smoke"]),
      test_("b", "Beta", ["Smoke"]),
      test_("c", "Gamma", ["checkout"]),
    ]);
    const dialog = await openConfirm("smoke");
    expect(within(dialog).getByText(/^2 tests use it\./)).toBeTruthy();
  });

  it("uses the singular for a tag on one test", async () => {
    renderCluster([test_("a", "Alpha", ["smoke"])]);
    const dialog = await openConfirm("smoke");
    expect(within(dialog).getByText(/^1 test uses it\./)).toBeTruthy();
  });

  it("names the affected tests, across casings", async () => {
    renderCluster([test_("a", "Alpha", ["smoke"]), test_("b", "Beta", ["Smoke"])]);
    const dialog = await openConfirm("smoke");
    expect(within(dialog).getByText("Alpha")).toBeTruthy();
    expect(within(dialog).getByText("Beta")).toBeTruthy();
  });

  it("summarizes the tail rather than listing a hundred names", async () => {
    const many = Array.from({ length: 11 }, (_, i) => test_(`t${i}`, `Test ${i}`, ["smoke"]));
    renderCluster(many);
    const dialog = await openConfirm("smoke");
    expect(within(dialog).getByText("+3 more")).toBeTruthy();
  });

  it("reports the BACKEND's removed count, not the number it previewed", async () => {
    // Hidden tests carry tags and are absent from this list, so the preview is
    // a lower bound. Echoing it back would under-report what actually changed.
    deleteTag.mockResolvedValueOnce({ tag: "smoke", removed: 4 });
    renderCluster([test_("a", "Alpha", ["smoke"])]);
    const dialog = await openConfirm("smoke");
    fireEvent.click(within(dialog).getByRole("button", { name: /delete tag/i }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Removed “smoke” from 4 tests."));
  });
});

describe("TagCluster selection is neutral", () => {
  it("announces the active filter with aria-pressed, which is what the stylesheet selects on", async () => {
    // One source of truth: there is no separate `active` class that could
    // disagree with what a screen reader is told — and `[aria-pressed=` is the
    // selector `check:selection-neutral` reads to prove the active filter is
    // not drawn in a status hue. A filter that looked like a verdict would
    // compete with every result on the screen it is filtering.
    renderCluster([test_("a", "Alpha", ["smoke"])], "smoke");
    const active = await screen.findByRole("button", { name: /^smoke · 1/ });
    expect(active.getAttribute("aria-pressed")).toBe("true");
    const all = screen.getByRole("button", { name: /^All · 1/ });
    expect(all.getAttribute("aria-pressed")).toBe("false");
  });

  it("puts no colour of its own on the chosen chip", async () => {
    // The treatment lives in the stylesheet (neutral white at low alpha), so
    // an inline colour here would be a second mechanism — and the one the
    // check cannot see.
    renderCluster([test_("a", "Alpha", ["smoke"])], "smoke");
    const active = await screen.findByRole("button", { name: /^smoke · 1/ });
    expect(active.getAttribute("style")).toBeNull();
  });
});

describe("TagCluster rendering", () => {
  it("renders nothing when no test is tagged", () => {
    // An "All · 3" chip on its own filters nothing and just takes up room.
    renderCluster([test_("a", "Alpha"), test_("b", "Beta")]);
    expect(screen.queryByRole("button", { name: /^All/ })).toBeNull();
  });

  it("hides Untagged when every test has a tag", async () => {
    renderCluster([test_("a", "Alpha", ["smoke"])]);
    await screen.findByRole("button", { name: /^All/ });
    expect(screen.queryByRole("button", { name: /^Untagged/ })).toBeNull();
  });
});
