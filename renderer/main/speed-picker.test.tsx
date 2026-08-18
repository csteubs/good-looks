// Every speed the app supports is offered everywhere a speed can be chosen.
//
// THE GAP THIS CLOSES. The speed list used to be re-declared in four separate
// components, each with its own label map. Adding a speed meant editing all
// four, and missing one is invisible: the picker renders, the other speeds
// still work, and the new one simply isn't there — so it looks like the feature
// was never built rather than like a bug. They all derive from `TEST_SPEEDS`
// now, and these tests are what notices if one goes back to a local list.
//
// Driven off `TEST_SPEEDS` on purpose rather than a hardcoded ["Crawl", ...].
// A test that names the speeds would need editing alongside the fifth speed,
// which is exactly the maintenance step this is meant to catch being skipped.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import type { RecorderSettings } from "../lib/recorder-types";
import { TEST_SPEEDS, TEST_SPEED_LABELS } from "../lib/recorder-types";
import { NewRecordingDialog } from "./new-recording-dialog";
import { GenerateTestDialog } from "./generate-test-dialog";

const start = vi.fn(async () => {});
let settings: Partial<RecorderSettings> = {};

vi.mock("./recorder-store", () => ({
  useRecorder: () => ({ start }),
}));

// The Generate dialog reaches for the router and the query client on render;
// neither is what these tests are about (see generate-test-dialog.test.tsx for
// the same two stubs).
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

vi.mock("../lib/api", () => ({
  api: {
    recorder: {
      getSettings: async () => settings,
      setSettings: async () => ({}) as RecorderSettings,
    },
    llm: {
      getConfig: async () => ({ provider: "claude", model: "claude-opus-5", baseUrls: {} }),
      status: async () => ({
        provider: "claude",
        reachable: true,
        baseUrl: "",
        models: [],
      }),
      chat: async () => ({ requestId: "req-1" }),
      cancel: async () => {},
    },
    tests: { createFromPrompt: vi.fn() },
    on: () => () => {},
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  settings = {};
});

describe("speed pickers offer every speed", () => {
  it("offers all of them in the New Recording dialog", async () => {
    render(<NewRecordingDialog open onOpenChange={vi.fn()} />);
    for (const speed of TEST_SPEEDS) {
      // findBy, not queryBy: the dialog loads its persisted speed
      // asynchronously, and asserting against the pre-load render would pass
      // for the wrong reason.
      expect(await screen.findByText(TEST_SPEED_LABELS[speed])).toBeTruthy();
    }
  });

  it("offers all of them in the Generate Test dialog", async () => {
    render(<GenerateTestDialog open onOpenChange={vi.fn()} />);
    for (const speed of TEST_SPEEDS) {
      expect(await screen.findByText(TEST_SPEED_LABELS[speed])).toBeTruthy();
    }
  });

  it("starts the New Recording dialog on the persisted speed, including Crawl", async () => {
    // Crawl specifically: it is the newest value, so it is the one a stale
    // list or a stale validator would silently drop back to a default. The
    // control has to come up ON it, not merely contain it.
    settings = { defaultRunSpeed: "crawl" };
    render(<NewRecordingDialog open onOpenChange={vi.fn()} />);
    await waitFor(() => {
      // `aria-pressed` as well as the SDK's two spellings: B10 moved this row
      // to the theme's `Segmented`, which is real buttons with `aria-pressed`
      // — chosen so the visual state cannot disagree with the announced one.
      const checked = document.querySelector(
        '[data-state="checked"], [aria-checked="true"], [aria-pressed="true"]',
      );
      // NOT `checked?.textContent`. With the optional chain a miss produces
      // `undefined` and `toContain` fails on the ARGUMENT TYPE, which reads as
      // a broken test rather than a control that never came up selected.
      expect(checked).not.toBeNull();
      expect(checked!.textContent).toContain(TEST_SPEED_LABELS.crawl);
    });
  });
});
