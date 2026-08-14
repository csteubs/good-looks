// WHICH tracker issues go to, and where they land in it — a small JSON file
// under userData, mirroring llm-config-store.
//
// The active provider lives HERE rather than in RecorderSettings even though it
// is exactly the kind of value that pane holds — a choice from a fixed list.
// It is here because it is meaningless apart from the per-provider defaults
// beside it: choosing GitHub and reading a Linear team id is the one failure
// this file exists to prevent, and splitting the choice from the ids it selects
// puts them in two files that can disagree.
//
// Keyed by provider because the ids are provider-scoped: a Linear team id means
// nothing to GitHub, and storing them in one flat pair would silently hand one
// provider's ids to another the first time someone switched. Same reasoning as
// `LlmConfig.baseUrls`, which is per-provider for the same reason.
//
// NOT in RecorderSettings. Everything there is a value the user typed or picked
// from a fixed list; these are opaque ids minted by a remote API, they are only
// meaningful while a particular key is stored, and they are cleared when that
// key is removed. A settings key that silently means nothing after an unrelated
// action is a settings key that lies in the "differs from default" count.
//
// Values are REBUILT on read rather than spread, for the reason
// `normalizeRawStep` is: these ids come back from a remote API, get written to
// disk, and are later sent out again as part of a create request. Spreading
// whatever JSON.parse returned would carry unknown keys straight through.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@shell/backend";

import { DEFAULT_PROVIDER, isProviderId, PROVIDER_IDS } from "./provider-registry.js";
import type { IssueDefaults, ProviderId } from "./types.js";

/** Long enough for any id a tracker mints, short enough that a corrupt or
 *  hostile file cannot put an unbounded string into a request body. */
const MAX_ID_LEN = 200;

const EMPTY: IssueDefaults = { containerId: null, subContainerId: null };

function configFile(): string {
  return path.join(app.getPath("userData"), "recorder", "issue-tracker-config.json");
}

/** A stored id is only usable if it is a non-empty, bounded string. Anything
 *  else reads as "no default", which is a working state. */
function id(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed || trimmed.length > MAX_ID_LEN) return null;
  return trimmed;
}

function defaultsOf(v: unknown): IssueDefaults {
  if (!v || typeof v !== "object") return { ...EMPTY };
  const raw = v as Record<string, unknown>;
  return { containerId: id(raw.containerId), subContainerId: id(raw.subContainerId) };
}

interface Stored {
  defaults: Partial<Record<ProviderId, IssueDefaults>>;
  /** Null when the user has never chosen. Distinct from "chose the default":
   *  only an explicit choice is written, so the fallback can change later
   *  without silently overriding somebody's decision. */
  activeProvider: ProviderId | null;
}

function read(): Stored {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), "utf-8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return { defaults: {}, activeProvider: null };
    // Rebuilt one KNOWN provider at a time — an unknown key in the file is
    // dropped rather than carried. `PROVIDER_IDS` rather than a literal list, so
    // a third provider is a registry row and nothing here.
    const defaults: Partial<Record<ProviderId, IssueDefaults>> = {};
    for (const id of PROVIDER_IDS) {
      if (parsed[id] !== undefined) defaults[id] = defaultsOf(parsed[id]);
    }
    // Validated, not trusted: this is a file on disk a user can edit, and the
    // value indexes the provider registry directly.
    return {
      defaults,
      activeProvider: isProviderId(parsed.activeProvider) ? parsed.activeProvider : null,
    };
  } catch {
    return { defaults: {}, activeProvider: null };
  }
}

/** One write, so the two things this file holds cannot half-save. */
function write(next: Stored, what: string): void {
  const out: Record<string, unknown> = { ...next.defaults };
  if (next.activeProvider) out.activeProvider = next.activeProvider;
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(out, null, 2), "utf-8");
  } catch (err) {
    logger.warn("issues", `Failed to save ${what}`, {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export const issueConfigStore = {
  /** Defaults for a provider. Always a usable object, never undefined. */
  get(provider: ProviderId): IssueDefaults {
    return read().defaults[provider] ?? { ...EMPTY };
  },

  /**
   * The provider the user chose, or the fallback if they never have.
   *
   * Read per call rather than cached in a module variable. The settings window
   * and the main window are separate renderers over one main process, and a
   * cached copy here is a copy that goes stale the moment the choice is made in
   * the window that is not the one filing the issue.
   */
  activeProvider(): ProviderId {
    return read().activeProvider ?? DEFAULT_PROVIDER;
  },

  /** Record the choice. Rejects anything not a real provider rather than
   *  writing a value that would throw on the next read. */
  setActiveProvider(provider: ProviderId): ProviderId {
    if (!isProviderId(provider)) return this.activeProvider();
    write({ ...read(), activeProvider: provider }, "the active issue provider");
    logger.info("issues", "Switched issue provider", { provider });
    return provider;
  },

  /**
   * Merge a patch into one provider's defaults.
   *
   * `undefined` leaves a field alone; an explicit `null` clears it — which is
   * how the UI says "no default project" as distinct from "don't touch the
   * project". Losing that distinction would make the clear action impossible to
   * express through the same call.
   */
  set(provider: ProviderId, patch: Partial<IssueDefaults>): IssueDefaults {
    const current = read();
    const existing = current.defaults[provider] ?? { ...EMPTY };
    const next: IssueDefaults = {
      containerId: patch.containerId !== undefined ? id(patch.containerId) : existing.containerId,
      subContainerId:
        patch.subContainerId !== undefined ? id(patch.subContainerId) : existing.subContainerId,
    };
    write({ ...current, defaults: { ...current.defaults, [provider]: next } }, "issue defaults");
    logger.info("issues", "Saved issue defaults", {
      provider,
      hasContainer: !!next.containerId,
      hasSubContainer: !!next.subContainerId,
    });
    return next;
  },

  /** Forget a provider's defaults. Called when its key is removed: the ids are
   *  only meaningful to the workspace that key opened, and leaving them behind
   *  would silently file into a stranger's team if a different key were pasted. */
  clear(provider: ProviderId): void {
    const current = read();
    const defaults = { ...current.defaults };
    delete defaults[provider];
    // The CHOICE survives a disconnect, deliberately. Disconnecting removes a
    // key; it does not say "and go back to filing into the other tracker". A
    // user who cleared a token to paste a fresh one would otherwise find their
    // next issue quietly filed somewhere else.
    write({ ...current, defaults }, "issue defaults");
  },
};
