// The per-provider issue defaults.
//
// Runs against a real temp userData dir rather than a mocked `fs`: the whole
// point of this store is what survives a write and a read, and a mocked
// filesystem would prove the calls happened without proving the round trip.
//
// Two behaviours carry weight, and neither is obvious from the type:
//
//   • `undefined` means "leave alone" and `null` means "clear". Collapsing them
//     makes clearing a default impossible to express through the same call.
//   • The file is REBUILT on read. It is JSON on disk that a later feature will
//     send back out as part of a create request, so an unknown key must not
//     ride along — the same rule `normalizeRawStep` follows for page input.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

let dir: string;
let issueConfigStore: typeof import("./issue-config-store.js").issueConfigStore;

function configPath(): string {
  return path.join(dir, "recorder", "issue-tracker-config.json");
}

function writeRaw(contents: string): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), contents, "utf-8");
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-issue-config-"));
  process.env.GLAZE_TEST_USERDATA = dir;
  // Imported after the env var is set: the stub resolves `userData` lazily per
  // call, but importing first would still bind this suite to whatever a
  // previous one left behind.
  ({ issueConfigStore } = await import("./issue-config-store.js"));
});

afterEach(() => {
  delete process.env.GLAZE_TEST_USERDATA;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("reading with nothing stored", () => {
  it("answers with empty defaults rather than undefined", () => {
    // Callers render this straight into a picker; `undefined` would be a crash
    // in the one state every new install is in.
    expect(issueConfigStore.get("linear")).toEqual({
      containerId: null,
      subContainerId: null,
    });
  });
});

describe("the undefined / null distinction", () => {
  it("leaves an omitted field alone", () => {
    issueConfigStore.set("linear", { containerId: "t1", subContainerId: "p1" });
    issueConfigStore.set("linear", { containerId: "t2" });
    expect(issueConfigStore.get("linear")).toEqual({
      containerId: "t2",
      subContainerId: "p1",
    });
  });

  it("clears a field passed as null", () => {
    issueConfigStore.set("linear", { containerId: "t1", subContainerId: "p1" });
    issueConfigStore.set("linear", { subContainerId: null });
    expect(issueConfigStore.get("linear")).toEqual({
      containerId: "t1",
      subContainerId: null,
    });
  });
});

describe("round trip", () => {
  it("survives a write and a fresh read", () => {
    issueConfigStore.set("linear", { containerId: "team-eng", subContainerId: "proj-1" });
    expect(JSON.parse(fs.readFileSync(configPath(), "utf-8"))).toEqual({
      linear: { containerId: "team-eng", subContainerId: "proj-1" },
    });
  });

  it("forgets a provider on clear", () => {
    // Called when a key is removed: an id is only meaningful inside the
    // workspace that key opened, and a stale one would silently file into a
    // stranger's team if a different key were pasted.
    issueConfigStore.set("linear", { containerId: "team-eng", subContainerId: "proj-1" });
    issueConfigStore.clear("linear");
    expect(issueConfigStore.get("linear")).toEqual({
      containerId: null,
      subContainerId: null,
    });
  });
});

describe("a stored file is untrusted input", () => {
  it("drops keys it does not know", () => {
    // The rebuild rule. Spreading whatever `JSON.parse` returned would carry an
    // unknown key into the object a later create request is built from.
    writeRaw(
      JSON.stringify({
        linear: { containerId: "t1", subContainerId: null, injected: "surprise" },
        notAProvider: { containerId: "t9" },
      }),
    );
    const got = issueConfigStore.get("linear") as unknown as Record<string, unknown>;
    expect(Object.keys(got).sort()).toEqual(["containerId", "subContainerId"]);
    expect(got.injected).toBeUndefined();
  });

  it("refuses a non-string id", () => {
    writeRaw(JSON.stringify({ linear: { containerId: { evil: true }, subContainerId: 42 } }));
    expect(issueConfigStore.get("linear")).toEqual({
      containerId: null,
      subContainerId: null,
    });
  });

  it("refuses an unbounded id", () => {
    // Bounded because it ends up in a request body. "No default" is a working
    // state; a 100KB string in an outgoing request is not.
    writeRaw(JSON.stringify({ linear: { containerId: "x".repeat(5000), subContainerId: null } }));
    expect(issueConfigStore.get("linear").containerId).toBeNull();
  });

  it("reads corrupt JSON as no defaults rather than throwing", () => {
    // Degrading to "nothing configured" keeps the pane usable; throwing here
    // would take out the whole settings load.
    writeRaw("{ not json");
    expect(issueConfigStore.get("linear")).toEqual({
      containerId: null,
      subContainerId: null,
    });
  });
});

describe("the active provider", () => {
  it("falls back before anything has been chosen", () => {
    // Every existing install is in this state: a Linear key, no stored
    // preference. It has to keep filing into Linear, not become unconfigured.
    expect(issueConfigStore.activeProvider()).toBe("linear");
  });

  it("survives a write and a read", () => {
    issueConfigStore.setActiveProvider("github");
    expect(issueConfigStore.activeProvider()).toBe("github");
    expect(JSON.parse(fs.readFileSync(configPath(), "utf-8"))).toMatchObject({
      activeProvider: "github",
    });
  });

  it("keeps each provider's defaults separate across a switch", () => {
    // The failure this prevents is filing into a Linear team id that was read
    // while GitHub was selected — both are strings, so nothing would throw.
    issueConfigStore.set("linear", { containerId: "team-eng" });
    issueConfigStore.setActiveProvider("github");
    issueConfigStore.set("github", { containerId: "acme/storefront" });

    expect(issueConfigStore.get("linear").containerId).toBe("team-eng");
    expect(issueConfigStore.get("github").containerId).toBe("acme/storefront");

    issueConfigStore.setActiveProvider("linear");
    expect(issueConfigStore.get("linear").containerId).toBe("team-eng");
  });

  it("does not lose the choice when defaults are written", () => {
    // The two live in one file and one write. A `set` that rebuilt the object
    // without carrying the choice would silently move the user back to Linear
    // the next time they picked a destination.
    issueConfigStore.setActiveProvider("github");
    issueConfigStore.set("github", { containerId: "acme/storefront" });
    expect(issueConfigStore.activeProvider()).toBe("github");
  });

  it("keeps the choice when a provider is disconnected", () => {
    // Disconnecting removes a key. It does not say "and go back to the other
    // tracker" — someone clearing a token to paste a fresh one would otherwise
    // find their next issue filed somewhere else.
    issueConfigStore.setActiveProvider("github");
    issueConfigStore.set("github", { containerId: "acme/storefront" });
    issueConfigStore.clear("github");
    expect(issueConfigStore.activeProvider()).toBe("github");
    expect(issueConfigStore.get("github").containerId).toBeNull();
  });

  it("refuses a provider that is not one", () => {
    issueConfigStore.setActiveProvider("github");
    issueConfigStore.setActiveProvider("nonesuch" as never);
    // Unchanged rather than written: the value indexes the provider registry
    // directly, so storing it would throw on the next read instead of here.
    expect(issueConfigStore.activeProvider()).toBe("github");
  });

  it("ignores a hostile value already on disk", () => {
    // The file is editable, and this string reaches `REGISTRY[id]`.
    writeRaw(JSON.stringify({ activeProvider: "__proto__", linear: {} }));
    expect(issueConfigStore.activeProvider()).toBe("linear");
    writeRaw(JSON.stringify({ activeProvider: "constructor" }));
    expect(issueConfigStore.activeProvider()).toBe("linear");
  });
});
