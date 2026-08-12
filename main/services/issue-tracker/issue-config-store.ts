// Where issues go by default, per provider — a small JSON file under userData,
// mirroring llm-config-store.
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

type Stored = Partial<Record<ProviderId, IssueDefaults>>;

function read(): Stored {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), "utf-8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    // Rebuilt one known provider at a time — an unknown key in the file is
    // dropped rather than carried.
    return { linear: defaultsOf(parsed.linear) };
  } catch {
    return {};
  }
}

export const issueConfigStore = {
  /** Defaults for a provider. Always a usable object, never undefined. */
  get(provider: ProviderId): IssueDefaults {
    return read()[provider] ?? { ...EMPTY };
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
    const existing = current[provider] ?? { ...EMPTY };
    const next: IssueDefaults = {
      containerId: patch.containerId !== undefined ? id(patch.containerId) : existing.containerId,
      subContainerId:
        patch.subContainerId !== undefined ? id(patch.subContainerId) : existing.subContainerId,
    };
    const merged: Stored = { ...current, [provider]: next };
    try {
      fs.mkdirSync(path.dirname(configFile()), { recursive: true });
      fs.writeFileSync(configFile(), JSON.stringify(merged, null, 2), "utf-8");
      logger.info("issues", "Saved issue defaults", {
        provider,
        hasContainer: !!next.containerId,
        hasSubContainer: !!next.subContainerId,
      });
    } catch (err) {
      logger.warn("issues", "Failed to save issue defaults", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return next;
  },

  /** Forget a provider's defaults. Called when its key is removed: the ids are
   *  only meaningful to the workspace that key opened, and leaving them behind
   *  would silently file into a stranger's team if a different key were pasted. */
  clear(provider: ProviderId): void {
    const current = read();
    delete current[provider];
    try {
      fs.mkdirSync(path.dirname(configFile()), { recursive: true });
      fs.writeFileSync(configFile(), JSON.stringify(current, null, 2), "utf-8");
    } catch (err) {
      logger.warn("issues", "Failed to clear issue defaults", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
