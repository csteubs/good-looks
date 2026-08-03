// Stores the user's Anthropic API key encrypted on-device via safeStorage.
// The key never leaves the backend: the renderer sends it once when saving,
// and only ever reads back whether a key is present (see llm:hasApiKey).

import * as fs from "fs/promises";
import * as path from "path";

import { app, safeStorage, logger } from "@glaze/core/backend";

function keyFile(): string {
  return path.join(app.getPath("userData"), "recorder", "anthropic-key.bin");
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

// Cache the decrypted key in-process so chat requests don't hit disk + decrypt
// on every call. Invalidated on set/clear.
let cached: string | null | undefined;

export const anthropicKeyStore = {
  /** Persist the plaintext key, encrypted. Throws if encryption is unavailable. */
  async setKey(plain: string): Promise<void> {
    const trimmed = plain.trim();
    if (!trimmed) throw new Error("API key is empty.");
    if (!(await safeStorage.isEncryptionAvailable())) {
      throw new Error("Secure storage is unavailable on this system; cannot save the API key.");
    }
    const file = keyFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const encrypted = await safeStorage.encryptString(trimmed);
    const tempPath = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tempPath, encrypted);
      await fs.rename(tempPath, file);
    } finally {
      await fs.rm(tempPath, { force: true });
    }
    cached = trimmed;
    logger.info("llm", "Saved Anthropic API key");
  },

  /** Remove the stored key. */
  async clear(): Promise<void> {
    cached = null;
    try {
      await fs.rm(keyFile(), { force: true });
    } catch (err) {
      logger.warn("llm", "Failed to remove Anthropic API key", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /** Decrypt and return the stored key, or null if none is saved. */
  async getKey(): Promise<string | null> {
    if (cached !== undefined) return cached;
    try {
      const encrypted = await fs.readFile(keyFile());
      cached = await safeStorage.decryptString(encrypted);
      return cached;
    } catch (err) {
      if (isFileNotFound(err)) {
        cached = null;
        return null;
      }
      // Decryption/permission failure — don't cache; surface as "no key".
      logger.warn("llm", "Failed to read Anthropic API key", {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },

  /** Whether a key is stored, without decrypting or returning it. */
  async hasKey(): Promise<boolean> {
    if (cached !== undefined) return cached !== null;
    try {
      await fs.access(keyFile());
      return true;
    } catch {
      return false;
    }
  },
};
