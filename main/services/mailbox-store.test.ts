// The mailbox store, driven against a throwaway userData dir, plus source pins
// for the run wiring a unit test cannot reach.
//
// The assertions that matter are the silent ones. A register carrying the
// TOKEN would put a credential in a plaintext file nobody thinks of as one.
// Collapsing `unreadable` into `none` reproduces the llm-service bug the
// sibling store's header warns about — the app saying nothing is configured
// while a mailbox the user set up sits on disk. And a run that arms with only
// half the configuration sends an empty Authorization header, which reads as a
// rejected token rather than a missing one.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-mailbox-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { setEncryptionAvailable } = await import("./__tests__/shell-backend-stub.js");
setEncryptionAvailable(true);

const { mailboxStore, MAILBOX_REGISTER_FILE, MAILBOX_SECRET_FILE } = await import(
  "./mailbox-store.js"
);

const registerFile = path.join(userData, "recorder", MAILBOX_REGISTER_FILE);
const secretFile = path.join(userData, "recorder", MAILBOX_SECRET_FILE);

const ENDPOINT = "https://mailbox.example.workers.dev/messages";
const TOKEN = "k7Fq2-x_ABCdef123456";

function reset(): void {
  fs.rmSync(registerFile, { force: true });
  fs.rmSync(secretFile, { force: true });
  mailboxStore.resetCache();
}

beforeEach(reset);

describe("saving", () => {
  it("refuses a bad endpoint or token before writing anything", async () => {
    expect(mailboxStore.problem("http://mailbox.example.com/m", TOKEN)).toMatch(/https/);
    expect(mailboxStore.problem(ENDPOINT, "bad\r\ntoken")).toMatch(/header/);
    await expect(mailboxStore.set("not-a-url", TOKEN)).rejects.toThrow();
    expect(fs.existsSync(registerFile)).toBe(false);
  });

  it("keeps the token OUT of the plaintext register", async () => {
    await mailboxStore.set(ENDPOINT, TOKEN);
    const register = fs.readFileSync(registerFile, "utf-8");
    expect(register).toContain(ENDPOINT);
    expect(register).not.toContain(TOKEN);
  });

  it("reports the host without handing back the token", async () => {
    await mailboxStore.set(ENDPOINT, TOKEN);
    const status = await mailboxStore.status();
    expect(status.state).toBe("configured");
    expect(status.host).toBe("mailbox.example.workers.dev");
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });
});

describe("state", () => {
  it("says `none` with nothing saved", async () => {
    expect((await mailboxStore.status()).state).toBe("none");
    expect(await mailboxStore.credentials()).toBeNull();
  });

  it("says `unreadable`, never `none`, when the token cannot be decrypted", async () => {
    // THE assertion. Folded into `none`, a run that goes without a mailbox
    // because the keychain was locked is indistinguishable from one that was
    // never configured — and the failure it produces is a login step timing
    // out, which reads as a flaky test.
    await mailboxStore.set(ENDPOINT, TOKEN);
    // The register survives and the blob does not — a locked keychain, a
    // restored profile, a half-failed write. The same trigger the signature
    // store's test uses, because it is the same state.
    fs.rmSync(secretFile, { force: true });
    mailboxStore.resetCache();
    const status = await mailboxStore.status();
    expect(status.state).toBe("unreadable");
    expect(status.host).toBe("mailbox.example.workers.dev");
    // And a run is never armed from it: half a configuration would send an
    // empty Authorization header, which reads as a rejected token.
    expect(await mailboxStore.credentials()).toBeNull();
  });

  it("refuses to arm a run from half a configuration", async () => {
    await mailboxStore.set(ENDPOINT, TOKEN);
    fs.rmSync(registerFile, { force: true });
    mailboxStore.resetCache();
    // A token with no endpoint is never sent anywhere.
    expect(await mailboxStore.credentials()).toBeNull();
    expect((await mailboxStore.status()).state).toBe("none");
  });

  it("ignores a register whose endpoint would be refused on entry", async () => {
    // Re-validated on READ, not only on write: the file is on disk, and a
    // hand-edited one must not put an endpoint the app rejects into a run's
    // environment.
    fs.mkdirSync(path.dirname(registerFile), { recursive: true });
    fs.writeFileSync(
      registerFile,
      JSON.stringify({ version: 1, endpoint: "http://evil.example.com/m", savedAt: 1 }),
    );
    expect((await mailboxStore.status()).state).toBe("none");
    expect(await mailboxStore.credentials()).toBeNull();
  });

  it("ignores a register that is not JSON", async () => {
    fs.mkdirSync(path.dirname(registerFile), { recursive: true });
    fs.writeFileSync(registerFile, "{ not json");
    expect((await mailboxStore.status()).state).toBe("none");
  });
});

describe("clearing", () => {
  it("removes both halves", async () => {
    await mailboxStore.set(ENDPOINT, TOKEN);
    await mailboxStore.clear();
    expect(fs.existsSync(registerFile)).toBe(false);
    expect(fs.existsSync(secretFile)).toBe(false);
    expect((await mailboxStore.status()).state).toBe("none");
  });
});

describe("the run wiring", () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf-8");

  it("arms on the TEST'S OWN steps, not on a mailbox existing", async () => {
    // The token is a credential; a run with no emailCode step has no use for
    // one. Same gate as the signature feature, for the same reason.
    const runner = read("main/services/playwright-runner.ts");
    expect(runner).toContain('step.type === "emailCode" && !step.disabled');
    expect(runner).toContain("mailboxEnv.GLAZE_MAILBOX_URL = credentials.endpoint");
    expect(runner).toContain("mailboxEnv.GLAZE_MAILBOX_TOKEN = credentials.token");
    expect(runner).toContain("...mailboxEnv,");
  });

  it("announces all three outcomes", async () => {
    // A run that goes without a mailbox does not fail where the cause is
    // obvious — it fails sixty seconds later, then again at whatever the
    // sign-in was a prerequisite for, and reads as a flaky login.
    const runner = read("main/services/playwright-runner.ts");
    expect(runner).toContain("Reading sign-in codes from");
    expect(runner).toContain("could not be decrypted");
    expect(runner).toContain("no test mailbox is configured");
  });

  it("puts the token in the redaction snapshot and leaves the endpoint out", async () => {
    // The token is attached by the generated spec, so it reaches a Playwright
    // error on a failed fetch and a run recording network traffic records the
    // request carrying it. The endpoint is not a credential, and a run that
    // cannot say which host it polled is one nobody can debug.
    const redaction = read("main/services/secret-redaction.ts");
    expect(redaction).toContain("mailboxStore.credentials()");
    expect(redaction).toContain("c.token");
    expect(redaction).not.toContain("c.endpoint");
  });
});
