// Shared scaffolding for the Settings pane tests.
//
// Every pane reads its state from one controller context. Building that
// controller by hand — rather than mounting `SettingsProvider` and mocking the
// whole `api` module in each file — means a pane test states the case it is
// about ("headless is already on, and the user turns it off") instead of
// re-deriving it through six async loads. It also makes the assertion the
// direct one: `save` was called with this patch, not "some IPC eventually
// happened".
//
// The shell's own test (`settings-view.test.tsx`) does mock `api`, because
// there the wiring IS the subject.

import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { vi } from "vitest";

import type { RecorderSettings } from "../../lib/recorder-types";
import { SETTINGS_DEFAULTS } from "../../lib/settings-schema";
import { SettingsControllerProvider } from "../settings-controller";
import type { SettingsController } from "../settings-controller";
import { RowFilterProvider } from "../setting-row";

/** A controller at its defaults, with every action a spy.
 *
 *  Settings start at `SETTINGS_DEFAULTS` rather than `{}` so a pane test that
 *  toggles something asserts a real transition. A test that wants the
 *  mid-load state passes `settings: {}` explicitly. */
export function makeController(overrides: Partial<SettingsController> = {}): SettingsController {
  return {
    settings: { ...SETTINGS_DEFAULTS } as Partial<RecorderSettings>,
    loaded: true,
    save: vi.fn(async () => {}),

    provider: "ollama",
    model: null,
    llmStatus: null,
    baseUrl: "http://127.0.0.1:11434",
    hasApiKey: false,
    hasLmStudioToken: false,
    testing: false,
    savingKey: false,
    defaultUrlFor: (p) =>
      p === "anthropic"
        ? "https://api.anthropic.com"
        : p === "lmstudio"
          ? "http://127.0.0.1:1234"
          : "http://127.0.0.1:11434",
    setBaseUrl: vi.fn(),
    commitBaseUrl: vi.fn(async () => {}),
    changeProvider: vi.fn(async () => {}),
    saveApiKey: vi.fn(async () => {}),
    clearApiKey: vi.fn(async () => {}),
    saveLmStudioToken: vi.fn(async () => {}),
    clearLmStudioToken: vi.fn(async () => {}),
    testConnection: vi.fn(async () => {}),
    changeModel: vi.fn(async () => {}),

    signatures: [],
    signaturesBusy: false,
    addSignature: vi.fn(async () => true),
    removeSignature: vi.fn(async () => {}),
    mailbox: { state: "none" },
    mailboxBusy: false,
    saveMailbox: vi.fn(async () => true),
    clearMailbox: vi.fn(async () => {}),
    testMailbox: vi.fn(async () => ({ ok: true, detail: "The mailbox answered." })),

    webhookStatus: { hasUrl: false, host: null },
    webhookBusy: false,
    saveWebhookUrl: vi.fn(async () => true),
    clearWebhookUrl: vi.fn(async () => {}),
    testWebhook: vi.fn(async () => {}),

    // Disconnected by default, which is the state most pane tests want to start
    // from: it is what a fresh install shows, and the connected case is the one
    // worth spelling out in the test that is about it.
    issuesStatus: { provider: "linear", hasKey: false, account: null, error: null },
    issuesVocabulary: {
      name: "Linear",
      container: "Team",
      containerPlural: "Teams",
      subContainer: "Project",
      keyHelpUrl: "https://linear.app/settings/api",
      keyPlaceholder: "lin_api_…",
      supportsImageUpload: true,
    },
    // Both providers offered, Linear selected — the shape the pane actually
    // renders. An empty list would exercise the fallback path instead, and the
    // fallback is precisely the case where a switching bug cannot show up.
    issueProviders: [
      {
        id: "linear",
        hasKey: false,
        vocabulary: {
          name: "Linear",
          container: "Team",
          containerPlural: "Teams",
          subContainer: "Project",
          keyHelpUrl: "https://linear.app/settings/api",
          keyPlaceholder: "lin_api_…",
          supportsImageUpload: true,
        },
      },
      {
        id: "github",
        hasKey: false,
        vocabulary: {
          name: "GitHub",
          container: "Repository",
          containerPlural: "Repositories",
          subContainer: "Milestone",
          keyHelpUrl: "https://github.com/settings/tokens",
          keyPlaceholder: "ghp_… or github_pat_…",
          supportsImageUpload: false,
        },
      },
    ],
    issuesBusy: false,
    issueContainers: [],
    issueSubContainers: [],
    issueDefaults: { containerId: null, subContainerId: null },
    selectIssueProvider: vi.fn(async () => {}),
    connectIssues: vi.fn(async () => true),
    verifyIssues: vi.fn(async () => {}),
    disconnectIssues: vi.fn(async () => {}),
    setIssueDefaults: vi.fn(async () => {}),

    hasGithubToken: false,
    githubBusy: false,
    saveGithubToken: vi.fn(async () => true),
    clearGithubToken: vi.fn(async () => {}),

    artifactUsage: null,
    pruning: false,
    pruneNow: vi.fn(async () => {}),

    runTotals: null,
    clearingRuns: false,
    resetRunStats: vi.fn(async () => {}),
    deleteRunStatsAndLogs: vi.fn(async () => {}),

    debugShortcut: "⌘⌥⇧S",
    capturing: false,
    captureNow: vi.fn(async () => {}),

    ...overrides,
  };
}

/** Render a pane against a controller. `matchedIds` drives the search filter;
 *  `null` (the default) means no search is running. */
export function renderPane(
  ui: ReactElement,
  {
    controller = makeController(),
    matchedIds = null,
  }: { controller?: SettingsController; matchedIds?: readonly string[] | null } = {},
) {
  // The real settings window mounts a QueryClient (renderer/settings/index.tsx),
  // and a pane may read app state through react-query the way the Alerts pane
  // reads the insights status. Fresh per render, retries off — a pane test
  // that reaches an unmocked query should fail once, not spin.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <SettingsControllerProvider value={controller}>
        <RowFilterProvider matchedIds={matchedIds}>{ui}</RowFilterProvider>
      </SettingsControllerProvider>
    </QueryClientProvider>,
  );
  return { ...result, controller };
}

/** The single patch a spied `save` was called with. Fails loudly rather than
 *  returning undefined, so a test that asserts on "the patch" cannot pass
 *  because no save happened at all. */
export function savedPatch(controller: SettingsController, callIndex = 0): Partial<RecorderSettings> {
  const mock = controller.save as unknown as { mock: { calls: [Partial<RecorderSettings>][] } };
  const call = mock.mock.calls[callIndex];
  if (!call) throw new Error(`save was not called (index ${callIndex})`);
  return call[0];
}
