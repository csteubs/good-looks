// The compose dialog, at the two points a second provider changed it.
//
// It deliberately has NO provider picker — the tracker is chosen in Settings,
// once, and asking again at the moment someone is looking at a failure is one
// more thing to get wrong on the way. What the dialog does have to do is honour
// whichever provider is active, and two behaviours follow from that:
//
//   • DESTINATION-SCOPED LISTS. GitHub's milestones and labels live inside one
//     repository. Keeping the previous container's rows after the user picks a
//     different one offers a destination that does not exist there, and the
//     failure lands at send time — after the report is written.
//   • THE ATTACHMENT WARNING. GitHub has no image upload in its API, so the
//     screenshots do not travel. This has to be said BEFORE the send, next to
//     the pictures it is about. An issue that silently lost its evidence looks
//     complete, which is the expensive way to find out.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { IssueComposeDialog } from "./issue-compose-dialog";
import type { DefectSource, ProviderVocabulary } from "../lib/issue-types";

const LINEAR: ProviderVocabulary = {
  name: "Linear",
  container: "Team",
  containerPlural: "Teams",
  subContainer: "Project",
  keyHelpUrl: "https://linear.app/settings/api",
  keyPlaceholder: "lin_api_…",
  supportsImageUpload: true,
};

const GITHUB: ProviderVocabulary = {
  name: "GitHub",
  container: "Repository",
  containerPlural: "Repositories",
  subContainer: "Milestone",
  keyHelpUrl: "https://github.com/settings/tokens",
  keyPlaceholder: "ghp_…",
  supportsImageUpload: false,
};

const SOURCE: DefectSource = {
  kind: "visual",
  testId: "t-checkout",
  runId: "r-1",
  stepId: "s5",
};

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Mocked at the `api` module, not the IPC bridge, so these tests state intent
// rather than channel plumbing.
const api = {
  issues: {
    buildDraft: vi.fn(),
    vocabulary: vi.fn(),
    getDefaults: vi.fn(),
    linksForTest: vi.fn(),
    listContainers: vi.fn(),
    listSubContainers: vi.fn(),
    listLabels: vi.fn(),
    createIssue: vi.fn(),
    commentRecurrence: vi.fn(),
  },
};
vi.mock("../lib/api", () => ({ api: { get issues() { return api.issues; } } }));

function draft(attachments = 2) {
  return {
    source: SOURCE,
    title: "Step 5 looks different",
    body: "The button moved.",
    notices: [],
    attachments: Array.from({ length: attachments }, (_, i) => ({
      label: ["Baseline", "This run", "Difference"][i] ?? `Image ${i}`,
      file: `img-${i}.png`,
      previewUrl: PNG,
      bytes: 1024,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.issues.buildDraft.mockResolvedValue(draft());
  api.issues.vocabulary.mockResolvedValue(LINEAR);
  api.issues.getDefaults.mockResolvedValue({ containerId: "team-eng", subContainerId: null });
  api.issues.linksForTest.mockResolvedValue([]);
  api.issues.listContainers.mockResolvedValue([{ id: "team-eng", name: "Engineering", key: "ENG" }]);
  api.issues.listSubContainers.mockResolvedValue([]);
  api.issues.listLabels.mockResolvedValue([]);
});

function open() {
  return render(
    <IssueComposeDialog source={SOURCE} open onOpenChange={() => {}} />,
  );
}

describe("the destination scopes what can be picked", () => {
  it("asks for milestones and labels against the chosen container", async () => {
    // Without the argument GitHub cannot answer at all — there is no
    // cross-repository milestone list — so a call with no scope reads as "this
    // repository has none".
    open();
    await waitFor(() => expect(api.issues.listLabels).toHaveBeenCalled());
    expect(api.issues.listSubContainers).toHaveBeenCalledWith("team-eng");
    expect(api.issues.listLabels).toHaveBeenCalledWith("team-eng");
  });

  it("does not fetch the same scope twice on open", async () => {
    // The load pass and the scope effect would otherwise both fire against the
    // default, doubling every open — two requests per list, on a dialog someone
    // is waiting in front of.
    open();
    await waitFor(() => expect(api.issues.listLabels).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(api.issues.listLabels).toHaveBeenCalledTimes(1);
    expect(api.issues.listSubContainers).toHaveBeenCalledTimes(1);
  });

  it("passes null rather than an empty string when nothing is chosen", async () => {
    // Null is the honest "none selected yet". An empty string would reach the
    // backend as a container id and be validated as one.
    api.issues.getDefaults.mockResolvedValue({ containerId: null, subContainerId: null });
    open();
    await waitFor(() => expect(api.issues.listLabels).toHaveBeenCalled());
    expect(api.issues.listLabels).toHaveBeenCalledWith(null);
  });
});

describe("the attachment warning", () => {
  it("says the screenshots will NOT be attached on a provider that cannot", async () => {
    api.issues.vocabulary.mockResolvedValue(GITHUB);
    open();
    await waitFor(() => expect(screen.getByText(/will NOT be attached/i)).toBeTruthy());
    // And explains why, rather than only stating it — the user's next question
    // is whether they did something wrong.
    expect(screen.getByText(/no image upload/i)).toBeTruthy();
  });

  it("says nothing of the sort on a provider that carries them", async () => {
    // A warning shown on every provider is one nobody reads on the provider it
    // is true for.
    open();
    await waitFor(() => expect(screen.getByText(/will be attached/i)).toBeTruthy());
    expect(screen.queryByText(/will NOT be attached/i)).toBeNull();
    expect(screen.queryByText(/no image upload/i)).toBeNull();
  });

  it("stays quiet when there is nothing to warn about", async () => {
    // No screenshots kept, so nothing is being lost and the warning would be
    // noise on an issue it does not apply to.
    api.issues.vocabulary.mockResolvedValue(GITHUB);
    api.issues.buildDraft.mockResolvedValue(draft(0));
    open();
    await waitFor(() => expect(screen.getByDisplayValue("Step 5 looks different")).toBeTruthy());
    expect(screen.queryByText(/no image upload/i)).toBeNull();
  });

  it("does not flash before the provider is known", async () => {
    // The vocabulary load can fail or lag. Defaulting to "uploads work" means
    // the warning appears only once it is known to be true — the opposite
    // default would show it briefly on Linear at every open and train people to
    // ignore it on GitHub.
    api.issues.vocabulary.mockResolvedValue(null);
    open();
    await waitFor(() => expect(screen.getByDisplayValue("Step 5 looks different")).toBeTruthy());
    expect(screen.queryByText(/no image upload/i)).toBeNull();
  });
});

describe("the dialog does not ask which tracker", () => {
  it("names the active one instead of offering a choice", async () => {
    // The provider is a configuration decision made once in Settings. If this
    // ever grows a picker, the destination question moves to the moment someone
    // is looking at a failure — which is exactly when it will be answered
    // wrongly.
    api.issues.vocabulary.mockResolvedValue(GITHUB);
    open();
    await waitFor(() => expect(screen.getByText(/create an issue in GitHub/i)).toBeTruthy());
    expect(screen.queryByText(/^Linear$/)).toBeNull();
    expect(document.getElementById("issue-tracker-provider")).toBeNull();
  });
});
