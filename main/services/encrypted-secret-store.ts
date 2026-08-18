// One on-disk, safeStorage-encrypted secret, behind a write-only-ish API: the
// renderer hands a value in and can only ever read back WHETHER one exists.
//
// Extracted from anthropic-key-store.ts when LM Studio's own API token needed
// the same treatment. The two are the same mechanism with a different filename,
// and the parts worth not re-typing are the ones that are silently wrong when
// re-typed: the temp-file-plus-rename write (a crash mid-write otherwise leaves
// a truncated blob that decrypts to nothing, which reads downstream as "no
// secret saved" rather than "corrupt"), and the ENOENT-vs-anything-else split in
// get() — a decryption failure must NOT be cached, because it is usually a
// recoverable keychain state and caching it makes it permanent for the session.

import * as fs from "fs/promises";
import * as path from "path";

import { app, safeStorage, logger } from "@shell/backend";

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

export interface EncryptedSecretStore {
  /** Persist the plaintext value, encrypted. Throws if encryption is unavailable. */
  set(plain: string): Promise<void>;
  /** Remove the stored value. */
  clear(): Promise<void>;
  /** Decrypt and return the stored value, or null if none is saved. */
  get(): Promise<string | null>;
  /** Whether a value is stored, without decrypting or returning it. */
  has(): Promise<boolean>;
  /** Test seam — drops the in-process cache so the next read hits disk.
   *
   *  Same seam `testSecretsStore` has, and needed for the same reason: a test
   *  that deletes the file behind the store's back is otherwise answered from
   *  the cache, so the case it meant to set up never happens and it passes for
   *  the wrong reason. */
  resetCache(): void;
}

export function createEncryptedSecretStore(opts: {
  /** Filename under `userData/recorder/`. */
  fileName: string;
  /** Human-readable name of the secret, used in errors and logs ("API key"). */
  label: string;
}): EncryptedSecretStore {
  const { fileName, label } = opts;
  const file = (): string => path.join(app.getPath("userData"), "recorder", fileName);

  // Cache the decrypted value in-process so requests don't hit disk + decrypt
  // on every call. `undefined` = not yet read; `null` = known to be absent.
  let cached: string | null | undefined;

  return {
    async set(plain: string): Promise<void> {
      const trimmed = plain.trim();
      if (!trimmed) throw new Error(`${label} is empty.`);
      if (!(await safeStorage.isEncryptionAvailable())) {
        throw new Error(`Secure storage is unavailable on this system; cannot save the ${label}.`);
      }
      const target = file();
      await fs.mkdir(path.dirname(target), { recursive: true });
      const encrypted = await safeStorage.encryptString(trimmed);
      const tempPath = `${target}.${process.pid}.tmp`;
      try {
        await fs.writeFile(tempPath, encrypted);
        await fs.rename(tempPath, target);
      } finally {
        await fs.rm(tempPath, { force: true });
      }
      cached = trimmed;
      logger.info("llm", `Saved ${label}`);
    },

    async clear(): Promise<void> {
      cached = null;
      try {
        await fs.rm(file(), { force: true });
      } catch (err) {
        logger.warn("llm", `Failed to remove ${label}`, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },

    async get(): Promise<string | null> {
      if (cached !== undefined) return cached;
      try {
        const encrypted = await fs.readFile(file());
        cached = await safeStorage.decryptString(encrypted);
        return cached;
      } catch (err) {
        if (isFileNotFound(err)) {
          cached = null;
          return null;
        }
        // Decryption/permission failure — don't cache; surface as "none saved".
        logger.warn("llm", `Failed to read ${label}`, {
          message: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    async has(): Promise<boolean> {
      if (cached !== undefined) return cached !== null;
      try {
        await fs.access(file());
        return true;
      } catch {
        return false;
      }
    },

    resetCache(): void {
      cached = undefined;
    },
  };
}
