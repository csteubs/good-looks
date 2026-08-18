// The git-import dialog's lifecycle: what happens to the modal after Import.
//
// The bug this pins (docs/issue-audit/fix-137.md): the composed `Dialog`'s
// confirm calls `onConfirm()` and nothing else — it never closes. This dialog
// is mounted by the library rail's `+` menu, OUTSIDE the outlet `RootShell`
// swaps, so a successful import navigated to the new test and left the modal —
// plus a full-viewport Radix overlay that swallows every pointer event — on top
// of it. The file even carried a comment citing "Dialog semantics" that were
// lost in the SDK port.
//
// Both directions are pinned, because they are what makes a per-caller close
// the right fix rather than a restored auto-close: success closes, failure
// stays open with the reason on screen and the URL still there to correct.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { ImportResult } from "../lib/api";
import { clearToastCalls, toastTexts } from "../__tests__/sonner-stub";
import { ImportGitDialog, protocolOf } from "./import-git-dialog";

const navigate = vi.fn();
const invalidateQueries = vi.fn();
const importGit = vi.fn(async (_url: string, _ref?: string): Promise<ImportResult> => result);

let result: ImportResult = {
  imported: 1,
  names: ["login"],
  ids: ["t-1"],
  needsBaseUrl: [],
  unsupported: [],
};

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock("../lib/api", () => ({
  api: { tests: { importGit: (url: string, ref?: string) => importGit(url, ref) } },
}));

const onOpenChange = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  clearToastCalls();
  result = { imported: 1, names: ["login"], ids: ["t-1"], needsBaseUrl: [], unsupported: [] };
});

function open() {
  render(<ImportGitDialog open onOpenChange={onOpenChange} />);
}

async function importFrom(url = "https://github.com/user/repo.git") {
  fireEvent.change(screen.getByPlaceholderText("https://github.com/user/repo.git"), {
    target: { value: url },
  });
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(importGit).toHaveBeenCalled());
}

describe("dialog lifecycle", () => {
  it("closes once the import has succeeded", async () => {
    open();
    await importFrom();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("navigates to the first imported test", async () => {
    // Pinned beside the close, because the two together are the whole reason
    // the stuck modal was invisible in review: the app DID move to the new
    // test, so the only symptom was a page that would not respond.
    open();
    await importFrom();
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t-1" } }),
    );
  });

  it("stays open when the clone fails, with the reason on screen", async () => {
    importGit.mockRejectedValueOnce(new Error("repository not found"));
    open();
    await importFrom();

    await waitFor(() => expect(screen.getByText("repository not found")).toBeTruthy());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // The URL is still there to correct — a close here would take the typed
    // value with it.
    expect(
      (screen.getByPlaceholderText("https://github.com/user/repo.git") as HTMLInputElement).value,
    ).toBe("https://github.com/user/repo.git");
  });

  it("raises the import's warnings as toasts", async () => {
    // The warnings are the one thing a closed dialog must not take with it:
    // they are raised as toasts precisely so they outlive the modal.
    result = {
      imported: 2,
      names: ["login", "checkout"],
      ids: ["t-1", "t-2"],
      needsBaseUrl: ["login"],
      unsupported: ["storageState"],
    };
    open();
    await importFrom();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const texts = toastTexts();
    expect(texts.some((t) => t.type === "success")).toBe(true);
    expect(texts.some((t) => t.type === "warning")).toBe(true);
  });
});

// ── The GitHub-clone shape (B10) ──────────────────────────────────────────
describe("the protocol row", () => {
  it("switches the field's placeholder", () => {
    open();
    expect(screen.getByPlaceholderText("https://github.com/user/repo.git")).toBeTruthy();

    // Plain buttons with `aria-pressed`, so a click drives them — a Radix
    // `TabsTrigger` would need `mouseDown` and would leave this assertion
    // running against the previous tab (CLAUDE.md).
    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    expect(screen.getByPlaceholderText("git@github.com:user/repo.git")).toBeTruthy();
  });

  it("flips to match a pasted URL rather than rejecting it", () => {
    // The tab is a HINT. The backend accepts both protocols whatever the row
    // says, so a control that erred here would be refusing a URL the app would
    // have cloned.
    open();
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "git@github.com:user/repo.git" },
    });
    expect(screen.getByRole("button", { name: "SSH" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not twitch while a URL is still being typed", () => {
    // Half a URL names no protocol, and a tab row that moves on every keystroke
    // is worse than one that never moves.
    open();
    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    fireEvent.change(screen.getByLabelText("Repository URL"), { target: { value: "git" } });
    expect(screen.getByRole("button", { name: "SSH" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("classifies the URLs the backend accepts", () => {
    expect(protocolOf("https://github.com/u/r.git")).toBe("https");
    expect(protocolOf("git://example.com/r.git")).toBe("https");
    expect(protocolOf("ssh://git@example.com/r.git")).toBe("ssh");
    expect(protocolOf("git@example.com:u/r.git")).toBe("ssh");
    expect(protocolOf("  ")).toBeNull();
    expect(protocolOf("example.com/u/r")).toBeNull();
  });
});

describe("the branch field", () => {
  it("sends the ref alongside the URL", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Branch or tag"), { target: { value: "release/2.0" } });
    await importFrom();
    expect(importGit).toHaveBeenCalledWith("https://github.com/user/repo.git", "release/2.0");
  });

  it("sends no ref when it is left blank, so the default branch is cloned", async () => {
    // Not an empty string: `--branch ""` is an argument git will try to resolve
    // and fail on, which would turn "I didn't fill this in" into a clone error.
    open();
    await importFrom();
    expect(importGit).toHaveBeenCalledWith("https://github.com/user/repo.git", undefined);
  });
});
