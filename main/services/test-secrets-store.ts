// Secret variable values, encrypted on-device via safeStorage.
//
// Why a store at all: before variables existed, a password typed during
// recording was written verbatim into the generated .spec.ts, into the run log
// on disk, and (via Debug with AI on the Claude provider) off the machine. A
// secret variable is the fix — the value lives here, the spec only ever carries
// a `process.env.GLAZE_SECRET_<NAME>` reference, and the plaintext reaches the
// Playwright child process and nowhere else.
//
// Everything is kept in ONE encrypted blob rather than a file per secret. That
// is deliberate: llm-service shipped a bug where `hasKey()` (file exists) and
// `getKey()` (decrypt succeeds) disagreed whenever the file was present but
// undecryptable, so the app reported a provider as connected that could not
// authenticate. Reading the blob is the only way to answer any question here,
// so the two can't drift — an undecryptable blob reads as "no secrets", loudly.

import * as fs from "fs/promises";
import * as path from "path";

import { app, safeStorage, logger } from "@shell/backend";

/** testId → variable name → plaintext value. */
type SecretBlob = Record<string, Record<string, string>>;

function secretsFile(): string {
  return path.join(app.getPath("userData"), "recorder", "test-secrets.bin");
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

// In-process cache so a run doesn't decrypt once per secret. `undefined` means
// "not loaded yet"; a loaded blob (possibly empty) means the disk state is known.
let cached: SecretBlob | undefined;

async function load(): Promise<SecretBlob> {
  if (cached !== undefined) return cached;
  try {
    const encrypted = await fs.readFile(secretsFile());
    const json = await safeStorage.decryptString(encrypted);
    const parsed: unknown = JSON.parse(json);
    cached = parsed && typeof parsed === "object" ? (parsed as SecretBlob) : {};
    return cached;
  } catch (err) {
    if (isFileNotFound(err)) {
      cached = {};
      return cached;
    }
    // Corrupt, or encrypted under a key this machine no longer has. Report it
    // as empty rather than throwing: a run should fail on a missing secret with
    // a clear message, not crash the backend. Do NOT cache — a later read may
    // succeed once whatever broke (keychain lock, permissions) is fixed.
    logger.warn("secrets", "Could not read test secrets", {
      message: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

async function persist(blob: SecretBlob): Promise<void> {
  if (!(await safeStorage.isEncryptionAvailable())) {
    throw new Error("Secure storage is unavailable on this system; cannot save a secret.");
  }
  const file = secretsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const encrypted = await safeStorage.encryptString(JSON.stringify(blob));
  const tempPath = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tempPath, encrypted);
    await fs.rename(tempPath, file);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
  cached = blob;
}

export const testSecretsStore = {
  /** Store one secret's value. */
  async set(testId: string, name: string, value: string): Promise<void> {
    const blob = { ...(await load()) };
    blob[testId] = { ...(blob[testId] ?? {}), [name]: value };
    await persist(blob);
    logger.info("secrets", "Saved a secret variable", { testId, name });
  },

  /** Forget one secret. */
  async clear(testId: string, name: string): Promise<void> {
    const blob = { ...(await load()) };
    const forTest = { ...(blob[testId] ?? {}) };
    if (!(name in forTest)) return;
    delete forTest[name];
    if (Object.keys(forTest).length === 0) delete blob[testId];
    else blob[testId] = forTest;
    await persist(blob);
  },

  /** Forget every secret belonging to a test — called when the test is deleted,
   *  so deleting a test doesn't leave its credentials on disk forever. */
  async clearTest(testId: string): Promise<void> {
    const blob = { ...(await load()) };
    if (!(testId in blob)) return;
    delete blob[testId];
    await persist(blob);
  },

  /** Which secrets this test has values for. Names only — this is what crosses
   *  IPC to the renderer. */
  async names(testId: string): Promise<string[]> {
    const blob = await load();
    return Object.keys(blob[testId] ?? {}).sort();
  },

  /** Every secret value for a test, for injection into a run's child process.
   *  Backend-only: no IPC handler returns this, and none ever should. */
  async valuesFor(testId: string): Promise<Record<string, string>> {
    const blob = await load();
    return { ...(blob[testId] ?? {}) };
  },

  /** Every stored secret value across all tests, for redaction. Redaction has
   *  to scan text for values it must remove, which means it needs the values —
   *  the alternative (redacting only the current test's secrets) would leak one
   *  test's password through another test's log. */
  async allValues(): Promise<string[]> {
    const blob = await load();
    const out: string[] = [];
    for (const perTest of Object.values(blob)) {
      for (const value of Object.values(perTest)) {
        if (value && !out.includes(value)) out.push(value);
      }
    }
    return out;
  },

  /** Test seam — drops the in-process cache so the next read hits disk. */
  resetCache(): void {
    cached = undefined;
  },
};
