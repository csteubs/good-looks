// Component tests for the tag editor.
//
// The suggestion list is the part that matters. Free-form tags rot fast when
// typing is the only affordance — "checkout" and "check-out" both get created
// and neither groups anything — so offering tags already in use is what keeps
// the feature usable. It's also the only place the renderer must NOT
// canonicalize: normalization is the backend's job, and duplicating it here
// would give two implementations that can disagree.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { TestRecord } from "../lib/recorder-types";
import { TagsDialog } from "./tags-dialog";

let library: TestRecord[] = [];
const setTags = vi.fn(async (_id: string, _tags: string[]) => ({}) as TestRecord);

vi.mock("../lib/api", () => ({
  api: {
    tests: {
      list: async () => library,
      setTags: (id: string, tags: string[]) => setTags(id, tags),
    },
  },
}));

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

function renderDialog(test: TestRecord | null) {
  const onOpenChange = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TagsDialog test={test} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

const input = () => screen.getByPlaceholderText(/smoke, checkout/i) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  library = [];
});

describe("seeding", () => {
  it("starts empty for an untagged test", async () => {
    renderDialog(test_("a", "Alpha"));
    await waitFor(() => expect(input().value).toBe(""));
    expect(screen.getByText(/no tags/i)).toBeTruthy();
  });

  it("seeds the field from the test's existing tags", async () => {
    renderDialog(test_("a", "Alpha", ["smoke", "checkout"]));
    await waitFor(() => expect(input().value).toBe("smoke, checkout"));
  });
});

describe("editing", () => {
  it("previews the tags being typed", async () => {
    renderDialog(test_("a", "Alpha"));
    fireEvent.change(input(), { target: { value: "smoke, checkout" } });
    await waitFor(() => expect(screen.getByText("smoke")).toBeTruthy());
    expect(screen.getByText("checkout")).toBeTruthy();
  });

  it("sends the raw typed tags, leaving normalization to the backend", async () => {
    // Deliberately NOT deduped/trimmed here — one source of truth.
    renderDialog(test_("a", "Alpha"));
    fireEvent.change(input(), { target: { value: " Smoke , smoke " } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(setTags).toHaveBeenCalledTimes(1));
    expect(setTags.mock.calls[0][1]).toEqual(["Smoke", "smoke"]);
  });

  it("saves an empty list when the field is cleared", async () => {
    renderDialog(test_("a", "Alpha", ["smoke"]));
    await waitFor(() => expect(input().value).toBe("smoke"));

    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(setTags).toHaveBeenCalledWith("a", []));
  });
});

describe("suggestions", () => {
  it("offers tags used elsewhere, with counts", async () => {
    library = [
      test_("a", "Alpha"),
      test_("b", "Beta", ["smoke"]),
      test_("c", "Gamma", ["smoke", "nightly"]),
    ];
    renderDialog(test_("a", "Alpha"));

    expect(await screen.findByRole("button", { name: /smoke · 2/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /nightly · 1/ })).toBeTruthy();
  });

  it("adds a suggestion to the field when clicked", async () => {
    library = [test_("a", "Alpha"), test_("b", "Beta", ["smoke"])];
    renderDialog(test_("a", "Alpha"));

    fireEvent.click(await screen.findByRole("button", { name: /smoke · 1/ }));
    await waitFor(() => expect(input().value).toContain("smoke"));
  });

  it("stops offering a tag once it's on this test", async () => {
    // Otherwise clicking it twice produces a duplicate the user has to notice.
    library = [test_("a", "Alpha"), test_("b", "Beta", ["smoke"])];
    renderDialog(test_("a", "Alpha"));

    const chip = await screen.findByRole("button", { name: /smoke · 1/ });
    fireEvent.click(chip);

    await waitFor(() => expect(screen.queryByRole("button", { name: /smoke · 1/ })).toBeNull());
  });

  it("shows no suggestion section when no other test is tagged", async () => {
    library = [test_("a", "Alpha")];
    renderDialog(test_("a", "Alpha"));
    await waitFor(() => expect(input().value).toBe(""));
    expect(screen.queryByText(/used elsewhere/i)).toBeNull();
  });
});
