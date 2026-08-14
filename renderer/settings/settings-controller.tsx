// Every piece of state the Settings window holds, and every handler that
// writes one — lifted out of `settings-view.tsx` when that file was split into
// panes.
//
// It is one controller rather than per-pane state on purpose. Two of these
// loads have side effects that used to fire when the WINDOW opened, not when a
// section was looked at: the LLM auto-probe can rewrite the configured model if
// the stored one is no longer installed, and the settings load is what every
// pane's "differs from default" count reads. Moving either into the pane that
// renders it would mean a stale model is repaired only if you happen to click
// AI, and a modified-count that is blank until you visit the pane.
//
// The ~20 individual `useState`s the old view kept for RecorderSettings fields
// collapse into one object plus `save(patch)`. The patch shape is unchanged —
// still one key per call to `recorder:setSettings`, which the backend merges —
// so nothing about what crosses IPC moved.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "@ui";

import { api } from "../lib/api";
import type { LlmProvider, LlmProviderStatus } from "../lib/llm-types";
import type {
  ConnectionStatus,
  IssueContainer,
  IssueDefaults,
  IssueSubContainer,
  ProviderChoice,
  ProviderId,
  ProviderVocabulary,
} from "../lib/issue-types";
import type { ArtifactUsage, RecorderSettings } from "../lib/recorder-types";
import { formatBytes } from "../lib/settings-schema";

/** Before the status load resolves, and if it never does. Disconnected is the
 *  safe direction to be wrong in: it offers a key field, where the opposite
 *  error would claim a connection that isn't there. */
const DISCONNECTED: ConnectionStatus = {
  provider: "linear",
  hasKey: false,
  account: null,
  error: null,
};

const NO_DEFAULTS: IssueDefaults = { containerId: null, subContainerId: null };

export interface WebhookStatus {
  hasUrl: boolean;
  host: string | null;
}

export interface SettingsController {
  /** Persisted recorder settings. Partial because it is empty until the load
   *  resolves — panes read through `??` defaults exactly as the old view did. */
  settings: Partial<RecorderSettings>;
  /** True once `recorder:getSettings` has settled either way. The nav waits on
   *  this before drawing modified-counts, or every pane flashes one. */
  loaded: boolean;
  /** Optimistic write: local state updates first, then IPC. A failure toasts
   *  and leaves the optimistic value in place — same as before the split.
   *  Rolling back would fight the user's next keystroke. */
  save: (patch: Partial<RecorderSettings>) => Promise<void>;

  provider: LlmProvider;
  model: string | null;
  llmStatus: LlmProviderStatus | null;
  baseUrl: string;
  hasApiKey: boolean;
  /** Whether an LM Studio API token is stored. Only meaningful for LM Studio. */
  hasLmStudioToken: boolean;
  testing: boolean;
  savingKey: boolean;
  defaultUrlFor: (p: LlmProvider) => string;
  setBaseUrl: (value: string) => void;
  commitBaseUrl: (value: string) => Promise<void>;
  changeProvider: (value: string) => Promise<void>;
  saveApiKey: (key: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  saveLmStudioToken: (token: string) => Promise<void>;
  clearLmStudioToken: () => Promise<void>;
  testConnection: () => Promise<void>;
  changeModel: (value: string) => Promise<void>;

  webhookStatus: WebhookStatus;
  webhookBusy: boolean;
  saveWebhookUrl: (url: string) => Promise<boolean>;
  clearWebhookUrl: () => Promise<void>;
  testWebhook: () => Promise<void>;

  /** Issue tracker. `issuesStatus.hasKey` and `issuesStatus.account` answer
   *  different questions — a key is saved, and the key works — so the pane can
   *  say "saved, but not reachable" instead of picking one and being wrong. */
  issuesStatus: ConnectionStatus;
  /** The provider's own words. Null until the load resolves; the pane falls
   *  back rather than rendering "undefined Team". */
  issuesVocabulary: ProviderVocabulary | null;
  /** Every tracker that can be chosen, newest read wins. Empty until the load
   *  resolves, which the pane renders as "just the current one". */
  issueProviders: ProviderChoice[];
  issuesBusy: boolean;
  issueContainers: IssueContainer[];
  issueSubContainers: IssueSubContainer[];
  issueDefaults: IssueDefaults;
  /** Switch trackers. Reloads everything downstream of the choice — the
   *  connection, the vocabulary and both pickers all belong to the provider,
   *  not to this pane. */
  selectIssueProvider: (provider: ProviderId) => Promise<void>;
  /** Resolves true when the key was accepted, so the pane knows whether to
   *  clear its input — same contract as `saveWebhookUrl`. */
  connectIssues: (key: string) => Promise<boolean>;
  verifyIssues: () => Promise<void>;
  disconnectIssues: () => Promise<void>;
  setIssueDefaults: (patch: Partial<IssueDefaults>) => Promise<void>;

  /** GitHub token, used by the branch switcher. Had no settings UI before the
   *  Integrations pane — it could only be set from inside `/branches`. */
  hasGithubToken: boolean;
  githubBusy: boolean;
  saveGithubToken: (token: string) => Promise<boolean>;
  clearGithubToken: () => Promise<void>;

  artifactUsage: ArtifactUsage | null;
  pruning: boolean;
  pruneNow: () => Promise<void>;

  debugShortcut: string;
  capturing: boolean;
  captureNow: () => Promise<void>;
}

const Ctx = createContext<SettingsController | null>(null);

/** Read the controller. Throws rather than handing back a null-shaped object:
 *  a pane rendered outside the provider would otherwise show every control at
 *  its fallback value and silently save nothing. */
export function useSettingsController(): SettingsController {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSettingsController must be used inside <SettingsProvider>");
  return ctx;
}

function defaultUrlFor(p: LlmProvider): string {
  return p === "anthropic"
    ? "https://api.anthropic.com"
    : p === "lmstudio"
      ? "http://127.0.0.1:1234"
      : "http://127.0.0.1:11434";
}

export function useSettingsControllerState(): SettingsController {
  const [settings, setSettings] = useState<Partial<RecorderSettings>>({});
  const [loaded, setLoaded] = useState(false);

  const [provider, setProvider] = useState<LlmProvider>("ollama");
  const [model, setModel] = useState<string | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmProviderStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [hasLmStudioToken, setHasLmStudioToken] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const autoFetchInflight = useRef(0);

  // The URL itself is a bearer credential and is never read back from the
  // backend — only whether one exists, and its host.
  const [webhookStatus, setWebhookStatus] = useState<WebhookStatus>({ hasUrl: false, host: null });
  const [webhookBusy, setWebhookBusy] = useState(false);

  // Same contract as the webhook above: the key travels renderer→backend only,
  // and what comes back is whether one is stored and who it belongs to.
  const [issuesStatus, setIssuesStatus] = useState<ConnectionStatus>(DISCONNECTED);
  const [issuesVocabulary, setIssuesVocabulary] = useState<ProviderVocabulary | null>(null);
  const [issueProviders, setIssueProviders] = useState<ProviderChoice[]>([]);
  const [issuesBusy, setIssuesBusy] = useState(false);
  const [issueContainers, setIssueContainers] = useState<IssueContainer[]>([]);
  const [issueSubContainers, setIssueSubContainers] = useState<IssueSubContainer[]>([]);
  const [issueDefaults, setIssueDefaultsState] = useState<IssueDefaults>(NO_DEFAULTS);

  const [hasGithubToken, setHasGithubToken] = useState(false);
  const [githubBusy, setGithubBusy] = useState(false);

  const [artifactUsage, setArtifactUsage] = useState<ArtifactUsage | null>(null);
  const [pruning, setPruning] = useState(false);

  const [debugShortcut, setDebugShortcut] = useState("");
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    /**
     * Start one load, independently of the others.
     *
     * The `try` matters as much as the `.catch`: these calls are made
     * synchronously inside the effect, so a surface that THROWS rather than
     * rejecting — a preload that didn't expose it, an IPC channel removed in a
     * later version — would abort the effect at that line and skip every load
     * after it. The window would then open with no settings at all because
     * something unrelated was missing. Each load is independently optional;
     * the one that isn't (`recorder:getSettings`) reports through `loaded`.
     */
    const load = <T,>(run: () => Promise<T>, apply: (value: T) => void, done?: () => void) => {
      try {
        run()
          .then(apply)
          .catch(() => {
            /* every one of these has a usable fallback */
          })
          .finally(() => done?.());
      } catch {
        done?.();
      }
    };

    load(
      () => api.llm.getConfig(),
      (cfg) => {
        setProvider(cfg.provider);
        setModel(cfg.model);
        setBaseUrl((cfg.baseUrls?.[cfg.provider] ?? "").trim() || defaultUrlFor(cfg.provider));
      },
    );
    load(
      () => api.llm.hasApiKey(),
      ({ hasKey }) => setHasApiKey(hasKey),
    );
    load(
      () => api.llm.hasLmStudioToken(),
      ({ hasToken }) => setHasLmStudioToken(hasToken),
    );
    load(
      () => api.recorder.getSettings(),
      // A RESOLVED null is not the same as a rejection and doesn't reach the
      // catch: an IPC handler that returns nothing (removed channel, backend
      // mid-upgrade) would put null straight into state, and the first pane to
      // read a key off it takes the whole window down. Every pane already
      // treats a missing key as its default, so an empty object is the right
      // shape for "we have nothing".
      (loadedSettings) =>
        setSettings(
          loadedSettings && typeof loadedSettings === "object" ? loadedSettings : {},
        ),
      () => setLoaded(true),
    );
    load(
      () => api.alerts.status(),
      setWebhookStatus,
    );
    load(
      () => api.issues.status(),
      (next) => setIssuesStatus(next ?? DISCONNECTED),
    );
    load(
      () => api.issues.vocabulary(),
      setIssuesVocabulary,
    );
    load(
      () => api.issues.getDefaults(),
      (next) => setIssueDefaultsState(next ?? NO_DEFAULTS),
    );
    load(
      () => api.issues.providers(),
      (next) => setIssueProviders(next ?? []),
    );
    load(
      () => api.branches.status(),
      (next) => setHasGithubToken(!!next?.hasToken),
    );
    load(
      () => api.artifacts.usage(),
      setArtifactUsage,
    );
    load(
      () => api.debug.shortcut(),
      setDebugShortcut,
    );
  }, []);

  const save = useCallback(async (patch: Partial<RecorderSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    try {
      await api.recorder.setSettings(patch);
    } catch (error) {
      toast.error(`Failed to save setting: ${error}`);
    }
  }, []);

  // ── LLM provider ──────────────────────────────────────────────────────────

  const changeProvider = useCallback(async (value: string) => {
    const next: LlmProvider =
      value === "lmstudio" ? "lmstudio" : value === "anthropic" ? "anthropic" : "ollama";
    setProvider(next);
    setLlmStatus(null);
    setModel(null);
    setBaseUrl(defaultUrlFor(next));
    try {
      // Switching providers resets the newly-selected provider to its default URL.
      await api.llm.setConfig({ provider: next, model: null, baseUrls: { [next]: "" } });
    } catch (error) {
      toast.error(`Failed to save provider: ${error}`);
    }
  }, []);

  const saveApiKey = useCallback(
    async (raw: string) => {
      const key = raw.trim();
      if (!key) return;
      setSavingKey(true);
      try {
        await api.llm.setApiKey(key);
        setHasApiKey(true);
        // Refresh status so the model list populates.
        const status = await api.llm.status("anthropic");
        setLlmStatus(status);
        if (status.reachable) {
          const nextModel = status.models.some((m) => m.id === model)
            ? model
            : (status.models[0]?.id ?? null);
          setModel(nextModel);
          await api.llm.setConfig({ model: nextModel });
        }
        toast.success(
          status.reachable ? "Connected to Claude." : (status.error ?? "Saved, but not reachable."),
        );
      } catch (error) {
        toast.error(`Failed to save API key: ${error}`);
      } finally {
        setSavingKey(false);
      }
    },
    [model],
  );

  const clearApiKey = useCallback(async () => {
    try {
      await api.llm.clearApiKey();
      setHasApiKey(false);
      setLlmStatus(null);
      setModel(null);
      await api.llm.setConfig({ model: null });
      toast.success("API key removed.");
    } catch (error) {
      toast.error(`Failed to remove API key: ${error}`);
    }
  }, []);

  // Saving a token has to re-probe explicitly: the auto-probe effect below is
  // keyed on provider + base URL, and neither of those changed — so without
  // this the model list stays empty after the one action that unblocks it.
  const saveLmStudioToken = useCallback(
    async (raw: string) => {
      const token = raw.trim();
      if (!token) return;
      setSavingKey(true);
      try {
        await api.llm.setLmStudioToken(token);
        setHasLmStudioToken(true);
        const status = await api.llm.status("lmstudio");
        setLlmStatus(status);
        if (status.reachable) {
          const nextModel = status.models.some((m) => m.id === model)
            ? model
            : (status.models[0]?.id ?? null);
          setModel(nextModel);
          await api.llm.setConfig({ model: nextModel });
        }
        toast.success(
          status.reachable
            ? "Connected to LM Studio."
            : (status.error ?? "Saved, but not reachable."),
        );
      } catch (error) {
        toast.error(`Failed to save API token: ${error}`);
      } finally {
        setSavingKey(false);
      }
    },
    [model],
  );

  const clearLmStudioToken = useCallback(async () => {
    try {
      await api.llm.clearLmStudioToken();
      setHasLmStudioToken(false);
      // Re-probe rather than blanking the status: without a token the server may
      // well be reachable (authentication off is the default), and showing
      // "Offline" for a server that answers is the same lie in reverse.
      setLlmStatus(await api.llm.status("lmstudio"));
      toast.success("API token removed.");
    } catch (error) {
      toast.error(`Failed to remove API token: ${error}`);
    }
  }, []);

  const commitBaseUrl = useCallback(
    async (value: string) => {
      setBaseUrl(value);
      const trimmed = value.trim();
      const override = trimmed && trimmed !== defaultUrlFor(provider) ? trimmed : "";
      try {
        await api.llm.setConfig({ baseUrls: { [provider]: override } });
      } catch (error) {
        toast.error(`Failed to save server URL: ${error}`);
      }
    },
    [provider],
  );

  const testConnection = useCallback(async () => {
    setTesting(true);
    try {
      const status = await api.llm.status(provider);
      setLlmStatus(status);
      if (status.reachable) {
        // Keep the chosen model if it's still present, else default to the first.
        const stillValid = status.models.some((m) => m.id === model);
        const nextModel = stillValid ? model : (status.models[0]?.id ?? null);
        setModel(nextModel);
        await api.llm.setConfig({ model: nextModel });
        toast.success(
          status.models.length
            ? `Connected. ${status.models.length} model${status.models.length === 1 ? "" : "s"} available.`
            : "Connected, but no models are loaded.",
        );
      } else {
        toast.error(status.error ?? "Connection failed.");
      }
    } catch (error) {
      toast.error(`Connection failed: ${error}`);
    } finally {
      setTesting(false);
    }
  }, [provider, model]);

  // Auto-fetch available models whenever the provider or server URL changes,
  // so the model list populates without a manual "Test connection" click.
  useEffect(() => {
    if (!baseUrl) return;
    const handle = ++autoFetchInflight.current;
    let cancelled = false;
    (async () => {
      try {
        const status = await api.llm.status(provider);
        if (cancelled || handle !== autoFetchInflight.current) return;
        setLlmStatus(status);
        if (status.reachable) {
          const stillValid = status.models.some((m) => m.id === model);
          const nextModel = stillValid ? model : (status.models[0]?.id ?? null);
          if (nextModel !== model) {
            setModel(nextModel);
            await api.llm.setConfig({ model: nextModel });
          }
        }
      } catch {
        /* ignore — user can retry with Test connection */
      }
    })();
    return () => {
      cancelled = true;
    };
    // `model` is deliberately absent from the deps: it is read to decide
    // whether the stored model is still valid, but the effect also SETS it, so
    // depending on it would re-trigger the probe on every repair.
  }, [provider, baseUrl]);

  const changeModel = useCallback(async (value: string) => {
    setModel(value);
    try {
      await api.llm.setConfig({ model: value });
    } catch (error) {
      toast.error(`Failed to save model: ${error}`);
    }
  }, []);

  // ── Webhook ───────────────────────────────────────────────────────────────

  /** Resolves true when the URL was accepted, so the pane knows whether to
   *  clear its input. Clearing on failure would lose what the user pasted. */
  const saveWebhookUrl = useCallback(async (url: string) => {
    setWebhookBusy(true);
    try {
      const next = await api.alerts.setWebhookUrl(url);
      setWebhookStatus(next);
      toast.success(`Webhook saved${next.host ? ` — sending to ${next.host}` : ""}.`);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to save webhook: ${error}`);
      return false;
    } finally {
      setWebhookBusy(false);
    }
  }, []);

  const clearWebhookUrl = useCallback(async () => {
    setWebhookBusy(true);
    try {
      setWebhookStatus(await api.alerts.clearWebhookUrl());
      toast.success("Webhook removed.");
    } catch (error) {
      toast.error(`Failed to remove webhook: ${error}`);
    } finally {
      setWebhookBusy(false);
    }
  }, []);

  const testWebhook = useCallback(async () => {
    setWebhookBusy(true);
    try {
      await api.alerts.test();
      toast.success("Test alert sent.");
    } catch (error) {
      // Surfaced rather than swallowed — the point of a test button is to find
      // out that it doesn't work.
      toast.error(error instanceof Error ? error.message : `Test alert failed: ${error}`);
    } finally {
      setWebhookBusy(false);
    }
  }, []);

  // ── Issue tracker ─────────────────────────────────────────────────────────

  /** Teams and projects, fetched only when there is a verified connection to
   *  fetch them with. Failures are swallowed: the pickers simply have nothing
   *  to offer, and the connection row above already carries the reason. */
  const loadIssueLists = useCallback(async () => {
    try {
      // The defaults are re-read rather than taken from state, and that is not
      // belt-and-braces: sub-containers are scoped to the selected container for
      // providers that scope them, so this call NEEDS the container id, and the
      // one in state belongs to whichever provider was active when it was set.
      // Reading first is what makes this correct immediately after a switch.
      const defaults = (await api.issues.getDefaults().catch(() => null)) ?? NO_DEFAULTS;
      const [containers, subContainers] = await Promise.all([
        api.issues.listContainers(),
        api.issues.listSubContainers(defaults.containerId),
      ]);
      setIssueDefaultsState(defaults);
      setIssueContainers(containers ?? []);
      setIssueSubContainers(subContainers ?? []);
    } catch {
      setIssueContainers([]);
      setIssueSubContainers([]);
    }
  }, []);

  /** Re-read which providers have a key. Called after anything that stores or
   *  removes one, so the picker's "key saved" marks do not go stale — they are
   *  the only on-screen answer to "which of these am I set up for?". */
  const refreshIssueProviders = useCallback(async () => {
    setIssueProviders((await api.issues.providers().catch(() => null)) ?? []);
  }, []);

  /**
   * Switch trackers.
   *
   * Everything downstream of the choice is dropped BEFORE the new provider's
   * lists arrive, rather than replaced when they do. A Linear team id and a
   * GitHub repository are both strings, so a picker left holding the old list
   * across the switch is a picker offering destinations that do not exist in
   * the tracker now selected — and the failure lands at send time, on someone
   * who has already written the report.
   */
  const selectIssueProvider = useCallback(
    async (provider: ProviderId) => {
      setIssuesBusy(true);
      try {
        const next = await api.issues.setActiveProvider(provider);
        setIssuesStatus(next);
        setIssueContainers([]);
        setIssueSubContainers([]);
        setIssueDefaultsState(NO_DEFAULTS);
        setIssuesVocabulary((await api.issues.vocabulary().catch(() => null)) ?? null);
        // Verified here rather than left to the auto-verify effect below: that
        // one is keyed on `hasKey`, and switching between two providers that
        // both have a key does not change it — so the effect would not fire and
        // the pane would sit on the previous provider's verified account.
        if (next.hasKey) {
          const verifiedNext = await api.issues.verify().catch(() => next);
          setIssuesStatus(verifiedNext);
          if (verifiedNext.account) await loadIssueLists();
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Failed to switch tracker: ${error}`);
      } finally {
        setIssuesBusy(false);
      }
    },
    [loadIssueLists],
  );

  const connectIssues = useCallback(
    async (raw: string) => {
      const key = raw.trim();
      if (!key) return false;
      setIssuesBusy(true);
      try {
        const next = await api.issues.connect(key);
        setIssuesStatus(next);
        if (next.account) {
          toast.success(
            next.account.workspaceName
              ? `Connected to ${next.account.workspaceName}.`
              : `Connected as ${next.account.accountName}.`,
          );
          await loadIssueLists();
        } else {
          // The key IS saved — connect stores before it verifies — so this is
          // "saved, but not working", and saying only the second half would
          // send someone off to paste it again for nothing.
          toast.error(next.error ?? "Saved, but the key could not be verified.");
        }
        // Stored either way, so the picker's marks are stale either way.
        await refreshIssueProviders();
        // True either way: the key was stored, so the field should clear. A
        // verification that failed on a flaky network is not a reason to make
        // someone paste it again.
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Failed to save the key: ${error}`);
        return false;
      } finally {
        setIssuesBusy(false);
      }
    },
    [loadIssueLists, refreshIssueProviders],
  );

  const verifyIssues = useCallback(async () => {
    setIssuesBusy(true);
    try {
      const next = await api.issues.verify();
      setIssuesStatus(next);
      if (next.account) {
        toast.success(
          next.account.workspaceName
            ? `Connected to ${next.account.workspaceName}.`
            : `Connected as ${next.account.accountName}.`,
        );
        await loadIssueLists();
      } else {
        // Surfaced, not swallowed — the point of a test button is to find out
        // that it doesn't work.
        toast.error(next.error ?? "Could not verify the connection.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Verification failed: ${error}`);
    } finally {
      setIssuesBusy(false);
    }
  }, [loadIssueLists]);

  const disconnectIssues = useCallback(async () => {
    setIssuesBusy(true);
    try {
      setIssuesStatus(await api.issues.disconnect());
      // The backend clears the defaults with the key, because a team id only
      // means something inside the workspace that key opened. Mirror it here
      // rather than re-reading, so the pickers empty in the same paint.
      setIssueDefaultsState(NO_DEFAULTS);
      setIssueContainers([]);
      setIssueSubContainers([]);
      await refreshIssueProviders();
      toast.success("Disconnected.");
    } catch (error) {
      toast.error(`Failed to disconnect: ${error}`);
    } finally {
      setIssuesBusy(false);
    }
  }, [refreshIssueProviders]);

  const setIssueDefaults = useCallback(async (patch: Partial<IssueDefaults>) => {
    try {
      // Authoritative: the backend clears the sub-container when the container
      // changes, so echoing the patch optimistically would leave a project
      // showing under a team it no longer belongs to.
      const next = await api.issues.setDefaults(patch);
      setIssueDefaultsState(next);
      // A container change re-fetches the sub-containers, because for a provider
      // that scopes them the previous list belongs to the previous container.
      // Filtering the stale list client-side — which is all the Linear-only
      // version had to do — would leave the picker empty against GitHub and read
      // as "this repository has no milestones".
      if (patch.containerId !== undefined) {
        setIssueSubContainers(await api.issues.listSubContainers(next.containerId).catch(() => []));
      }
    } catch (error) {
      toast.error(`Failed to save the destination: ${error}`);
    }
  }, []);

  // Verify once per window, and only when a key is actually stored. Same shape
  // as the LLM auto-probe above: the alternative is a pane that says "saved"
  // and makes you click a button to learn the key was revoked last week.
  const autoVerified = useRef(false);
  useEffect(() => {
    if (!issuesStatus.hasKey || autoVerified.current) return;
    autoVerified.current = true;
    (async () => {
      try {
        const next = await api.issues.verify();
        setIssuesStatus(next);
        if (next.account) await loadIssueLists();
      } catch {
        /* the row renders the stored status; a retry is one click away */
      }
    })();
  }, [issuesStatus.hasKey, loadIssueLists]);

  // ── GitHub token ──────────────────────────────────────────────────────────

  const saveGithubToken = useCallback(async (raw: string) => {
    const token = raw.trim();
    if (!token) return false;
    setGithubBusy(true);
    try {
      const { hasToken } = await api.branches.setToken(token);
      setHasGithubToken(hasToken);
      toast.success("GitHub token saved.");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to save the token: ${error}`);
      return false;
    } finally {
      setGithubBusy(false);
    }
  }, []);

  const clearGithubToken = useCallback(async () => {
    setGithubBusy(true);
    try {
      const { hasToken } = await api.branches.clearToken();
      setHasGithubToken(hasToken);
      toast.success("GitHub token removed.");
    } catch (error) {
      toast.error(`Failed to remove the token: ${error}`);
    } finally {
      setGithubBusy(false);
    }
  }, []);

  // ── Artifacts ─────────────────────────────────────────────────────────────

  const pruneNow = useCallback(async () => {
    setPruning(true);
    try {
      const { removedRuns, freedBytes } = await api.artifacts.pruneNow();
      setArtifactUsage(await api.artifacts.usage());
      toast.success(
        removedRuns > 0
          ? `Deleted ${removedRuns} run${removedRuns === 1 ? "" : "s"}, freeing ${formatBytes(freedBytes)}.`
          : "Nothing to clean up — every run is within your limits.",
      );
    } catch (error) {
      toast.error(`Cleanup failed: ${error}`);
    } finally {
      setPruning(false);
    }
  }, []);

  // ── Debug capture ─────────────────────────────────────────────────────────

  const captureNow = useCallback(async () => {
    setCapturing(true);
    try {
      const session = await api.debug.capture();
      if (session.error) toast.error(session.error);
      else {
        // Say what it actually got. "Saved" alone leaves you wondering whether
        // it caught the window you cared about.
        const names = session.shots.map((s) => s.window).join(", ");
        toast.success(
          `Captured ${session.shots.length} ${session.shots.length === 1 ? "window" : "windows"}: ${names}`,
        );
      }
    } catch (error) {
      toast.error(`Capture failed: ${error}`);
    } finally {
      setCapturing(false);
    }
  }, []);

  return {
    settings,
    loaded,
    save,
    provider,
    model,
    llmStatus,
    baseUrl,
    hasApiKey,
    hasLmStudioToken,
    testing,
    savingKey,
    defaultUrlFor,
    setBaseUrl,
    commitBaseUrl,
    changeProvider,
    saveApiKey,
    clearApiKey,
    saveLmStudioToken,
    clearLmStudioToken,
    testConnection,
    changeModel,
    webhookStatus,
    webhookBusy,
    saveWebhookUrl,
    clearWebhookUrl,
    testWebhook,
    issuesStatus,
    issuesVocabulary,
    issueProviders,
    issuesBusy,
    issueContainers,
    issueSubContainers,
    issueDefaults,
    selectIssueProvider,
    connectIssues,
    verifyIssues,
    disconnectIssues,
    setIssueDefaults,
    hasGithubToken,
    githubBusy,
    saveGithubToken,
    clearGithubToken,
    artifactUsage,
    pruning,
    pruneNow,
    debugShortcut,
    capturing,
    captureNow,
  };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const controller = useSettingsControllerState();
  return <Ctx.Provider value={controller}>{children}</Ctx.Provider>;
}

/** Test seam: render a pane against a hand-built controller without the async
 *  loads. Production code always goes through `SettingsProvider`. */
export function SettingsControllerProvider({
  value,
  children,
}: {
  value: SettingsController;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
