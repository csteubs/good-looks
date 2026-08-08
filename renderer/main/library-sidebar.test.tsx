// Component tests for the sidebar's Duplicate flow.
//
// The branch is the whole point and it is invisible from either side: a test
// with nothing active duplicates on the click, while a test carrying variables,
// cookies, secrets or a hand-edited script stops at a dialog first. Get that
// backwards in the quiet direction and a stored credential is copied with no
// mention of it; get it backwards in the loud direction and every duplication
// grows a dialog, which is how people learn to click through the one that
// mattered.
//
// The other silent failure is the one after confirming: a copy that is created
// but never navigated to, or created without the sidebar refetching, both read
// as "nothing happened" and invite a second click — and a second copy.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toastTexts, clearToastCalls } from "../__tests__/sonner-stub";

import type { SecretStatus, Step, TestRecord } from "../lib/recorder-types";
import { LibrarySidebar } from "./library-sidebar";

let tests: TestRecord[] = [];
let secretStatus: SecretStatus[] = [];

const navigate = vi.fn();
const duplicate = vi.fn(
  async (id: string): Promise<TestRecord> => ({ ...record({ id: "copy" }), name: "Login [2]", id: `${id}-copy` }),
);

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => ({}),
  useRouterState: () => "/",
}));

// The sidebar's other dialogs each open their own queries and native bridges;
// none of them is what this file is about.
vi.mock("./new-recording-dialog", () => ({ NewRecordingDialog: () => null }));
vi.mock("./generate-test-dialog", () => ({ GenerateTestDialog: () => null }));
vi.mock("./import-git-dialog", () => ({ ImportGitDialog: () => null }));
vi.mock("./tags-dialog", () => ({ TagsDialog: () => null }));

vi.mock("../lib/api", () => ({
  api: {
    tests: {
      list: async () => tests,
      duplicate: (id: string) => duplicate(id),
      secretStatus: async () => secretStatus,
      setHidden: async () => null,
      setSpeed: async () => ({}) as TestRecord,
      importFiles: async () => ({ imported: 0, names: [], ids: [] }),
    },
    llm: {
      getConfig: async () => ({ provider: "ollama" }),
      status: async () => ({ reachable: true, models: [] }),
    },
  },
}));

function step(type: Step["type"], id: string = type): Step {
  return { id, type, timestamp: 1 } as Step;
}

function record(over: Partial<TestRecord> = {}): TestRecord {
  return {
    id: "t1",
    name: "Login",
    url: "https://example.test/login",
    createdAt: 1,
    updatedAt: 1,
    steps: [step("click")],
    scriptPath: "/tmp/t1.spec.ts",
    ...over,
  };
}

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LibrarySidebar />
    </QueryClientProvider>,
  );
}

/** Right-click the first test row and pick "Duplicate Test". */
async function chooseDuplicate() {
  const row = await screen.findByText("Login");
  fireEvent.contextMenu(row);
  const item = await screen.findByText("Duplicate Test");
  fireEvent.click(item);
}

beforeEach(() => {
  tests = [record()];
  secretStatus = [];
  navigate.mockClear();
  duplicate.mockClear();
  clearToastCalls();
});

describe("LibrarySidebar — Duplicate Test", () => {
  it("offers Duplicate Test in a test's context menu", async () => {
    renderSidebar();
    const row = await screen.findByText("Login");
    fireEvent.contextMenu(row);
    expect(await screen.findByText("Duplicate Test")).toBeTruthy();
  });

  it("duplicates immediately when the test has nothing active", async () => {
    renderSidebar();
    await chooseDuplicate();

    await waitFor(() => expect(duplicate).toHaveBeenCalledWith("t1"));
    // No dialog: a prompt that always appears is one nobody reads.
    expect(screen.queryByText(/behave differently in a copy/i)).toBeNull();
  });

  it("navigates to the copy and reports its real name", async () => {
    // A duplication whose only visible result is a sidebar row the user has to
    // find themselves reads as nothing having happened.
    renderSidebar();
    await chooseDuplicate();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t1-copy" } }),
    );
    expect(toastTexts().some((t) => t.type === "success" && t.title.includes("Login [2]"))).toBe(
      true,
    );
  });

  it("reports a failure instead of leaving the click looking successful", async () => {
    duplicate.mockRejectedValueOnce(new Error("Disk is full"));
    renderSidebar();
    await chooseDuplicate();

    await waitFor(() =>
      expect(toastTexts().some((t) => t.type === "error" && t.title === "Disk is full")).toBe(true),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("asks first when the test declares variables", async () => {
    tests = [record({ variables: [{ name: "user", kind: "plain", value: "ada" }] })];
    renderSidebar();
    await chooseDuplicate();

    expect(await screen.findByText(/Duplicate “Login”\?/)).toBeTruthy();
    expect(duplicate).not.toHaveBeenCalled();
  });

  it("asks first when the test records cookies", async () => {
    tests = [record({ steps: [step("click"), step("cookie", "c1")] })];
    renderSidebar();
    await chooseDuplicate();

    expect(await screen.findByText(/1 cookie step/)).toBeTruthy();
    expect(duplicate).not.toHaveBeenCalled();
  });

  it("asks first when a secret has a value stored, even with nothing else active", async () => {
    // The credential case. `secretStatus` is the ONLY source for it — the
    // record never carries a secret's value, so a copy could otherwise take one
    // across with nothing on screen having mentioned it.
    tests = [record({ variables: [{ name: "password", kind: "secret" }] })];
    secretStatus = [{ name: "password", hasValue: true }];
    renderSidebar();
    await chooseDuplicate();

    expect(await screen.findByText(/1 stored secret value/)).toBeTruthy();
  });

  it("duplicates once the dialog is confirmed", async () => {
    tests = [record({ variables: [{ name: "user", kind: "plain", value: "ada" }] })];
    renderSidebar();
    await chooseDuplicate();

    fireEvent.click(await screen.findByRole("button", { name: /^duplicate$/i }));

    await waitFor(() => expect(duplicate).toHaveBeenCalledWith("t1"));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t1-copy" } }),
    );
  });

  it("does nothing when the dialog is cancelled", async () => {
    tests = [record({ variables: [{ name: "user", kind: "plain", value: "ada" }] })];
    renderSidebar();
    await chooseDuplicate();

    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByText(/Duplicate “Login”\?/)).toBeNull());
    expect(duplicate).not.toHaveBeenCalled();
  });

  it("still duplicates when the secret status can't be read", async () => {
    // Losing that one number must not block the action, and must not invent a
    // secrets line the app couldn't verify.
    tests = [record()];
    const api = await import("../lib/api");
    const spy = vi
      .spyOn(api.api.tests, "secretStatus")
      .mockRejectedValueOnce(new Error("no keychain"));
    renderSidebar();
    await chooseDuplicate();

    await waitFor(() => expect(duplicate).toHaveBeenCalledWith("t1"));
    spy.mockRestore();
  });
});
