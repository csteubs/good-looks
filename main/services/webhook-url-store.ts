// Stores the user's alert webhook URL encrypted on-device via safeStorage.
//
// The URL is treated as a SECRET, not a setting: a Slack/Discord incoming
// webhook URL is a bearer credential — anyone holding it can post into the
// channel — so it gets the same treatment as the Anthropic API key (encrypted
// at rest, backend-only, never returned to the renderer). The renderer can only
// learn whether one is configured and its host, which is enough to render
// "Sending to hooks.slack.com" without handing back the token.

import * as fs from "fs/promises";
import * as path from "path";

import { app, safeStorage, logger } from "@glaze/core/backend";

function urlFile(): string {
  return path.join(app.getPath("userData"), "recorder", "alert-webhook.bin");
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

/**
 * Only http(s) is accepted. Without this a `file://` or custom-scheme URL would
 * be handed to fetch, and the whole point of the feature is a deliberate,
 * visible network call to a host the user chose.
 */
export function validateWebhookUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Webhook URL is empty.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Webhook URL must start with https:// or http://");
  }
  return trimmed;
}

/** Host only — safe to show in the UI, unlike the full URL (which is the secret). */
export function hostOfUrl(raw: string): string | null {
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

// Cached in-process so a batch doesn't hit disk + decrypt per alert.
let cached: string | null | undefined;

export const webhookUrlStore = {
  async setUrl(plain: string): Promise<void> {
    const url = validateWebhookUrl(plain);
    if (!(await safeStorage.isEncryptionAvailable())) {
      throw new Error("Secure storage is unavailable on this system; cannot save the webhook URL.");
    }
    const file = urlFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const encrypted = await safeStorage.encryptString(url);
    const tempPath = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tempPath, encrypted);
      await fs.rename(tempPath, file);
    } finally {
      await fs.rm(tempPath, { force: true });
    }
    cached = url;
    logger.info("alerts", "Saved alert webhook URL", { host: hostOfUrl(url) });
  },

  async clear(): Promise<void> {
    cached = null;
    try {
      await fs.rm(urlFile(), { force: true });
    } catch (err) {
      logger.warn("alerts", "Failed to remove alert webhook URL", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async getUrl(): Promise<string | null> {
    if (cached !== undefined) return cached;
    try {
      const encrypted = await fs.readFile(urlFile());
      cached = await safeStorage.decryptString(encrypted);
      return cached;
    } catch (err) {
      if (isFileNotFound(err)) {
        cached = null;
        return null;
      }
      logger.warn("alerts", "Failed to read alert webhook URL", {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },

  /** What the renderer is allowed to know: configured or not, and to where. */
  async status(): Promise<{ hasUrl: boolean; host: string | null }> {
    const url = await this.getUrl();
    return { hasUrl: !!url, host: url ? hostOfUrl(url) : null };
  },
};
