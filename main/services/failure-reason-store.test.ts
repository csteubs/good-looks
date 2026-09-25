// Tests for the custom failure-reason store. The properties here protect
// history: a rename that minted a new id would orphan every labelled run, a
// delete that erased the record would strand a bare uuid where a label was,
// and a duplicate name would put two identical rows in the picker (or, for a
// deleted reason, in the Stats breakdown) with different meanings.
//
// Driven against the real store writing into a throwaway userData dir.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-failure-reasons-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { failureReasonStore } = await import("./failure-reason-store.js");
const { MAX_ACTIVE_CUSTOM_REASONS, MAX_REASON_DESCRIPTION, MAX_REASON_NAME } = await import(
  "../../shared/failure-reasons.mjs"
);

const indexFile = path.join(userData, "recorder", "failure-reasons.json");

beforeEach(() => {
  fs.rmSync(indexFile, { force: true });
});

describe("create", () => {
  it("stores a trimmed name and description and returns the record", () => {
    const rec = failureReasonStore.create("  Vendor outage  ", " Third-party API down. ");
    expect(rec.name).toBe("Vendor outage");
    expect(rec.description).toBe("Third-party API down.");
    expect(rec.disabled).toBeUndefined();
    expect(failureReasonStore.list()).toEqual([rec]);
  });

  it("refuses an empty or missing name", () => {
    expect(() => failureReasonStore.create("   ")).toThrow(/needs a name/);
    expect(() => failureReasonStore.create(42)).toThrow(/needs a name/);
  });

  it("enforces the field limits", () => {
    expect(() => failureReasonStore.create("x".repeat(MAX_REASON_NAME + 1))).toThrow(/limited/);
    expect(() =>
      failureReasonStore.create("ok", "x".repeat(MAX_REASON_DESCRIPTION + 1)),
    ).toThrow(/limited/);
    // At the limit is fine.
    failureReasonStore.create("y".repeat(MAX_REASON_NAME), "z".repeat(MAX_REASON_DESCRIPTION));
  });

  it("refuses a name colliding with a built-in or an existing custom reason", () => {
    expect(() => failureReasonStore.create("site regression")).toThrow(/built-in/);
    failureReasonStore.create("Vendor outage");
    expect(() => failureReasonStore.create("VENDOR OUTAGE")).toThrow(/already exists/);
  });

  it("caps ACTIVE reasons — disabled ones do not consume the budget", () => {
    for (let i = 0; i < MAX_ACTIVE_CUSTOM_REASONS; i++) failureReasonStore.create(`Reason ${i}`);
    expect(() => failureReasonStore.create("One more")).toThrow(/limited/);
    const first = failureReasonStore.list()[0];
    failureReasonStore.update(first.id, { disabled: true });
    const again = failureReasonStore.create("One more");
    expect(again.name).toBe("One more");
  });
});

describe("update", () => {
  it("renames in place, keeping the id — history resolves through it", () => {
    const rec = failureReasonStore.create("Vendor outage");
    const renamed = failureReasonStore.update(rec.id, { name: "Upstream outage" });
    expect(renamed.id).toBe(rec.id);
    expect(renamed.name).toBe("Upstream outage");
    expect(failureReasonStore.list()).toHaveLength(1);
  });

  it("refuses renaming onto another reason's name, but allows a case change of its own", () => {
    const a = failureReasonStore.create("Alpha");
    failureReasonStore.create("Beta");
    expect(() => failureReasonStore.update(a.id, { name: "beta" })).toThrow(/already exists/);
    expect(failureReasonStore.update(a.id, { name: "ALPHA" }).name).toBe("ALPHA");
  });

  it("disables and re-enables, and re-enabling respects the active cap", () => {
    const rec = failureReasonStore.create("Alpha");
    expect(failureReasonStore.update(rec.id, { disabled: true }).disabled).toBe(true);
    // Fill the active budget while Alpha is disabled…
    for (let i = 0; i < MAX_ACTIVE_CUSTOM_REASONS; i++) failureReasonStore.create(`Reason ${i}`);
    // …so re-enabling would exceed it.
    expect(() => failureReasonStore.update(rec.id, { disabled: false })).toThrow(/limited/);
  });

  it("clears the disabled flag rather than storing disabled: false", () => {
    const rec = failureReasonStore.create("Alpha");
    failureReasonStore.update(rec.id, { disabled: true });
    failureReasonStore.update(rec.id, { disabled: false });
    const raw = JSON.parse(fs.readFileSync(indexFile, "utf-8")) as Record<string, unknown>[];
    expect("disabled" in raw[0]).toBe(false);
  });

  it("throws for unknown ids — which is what makes built-ins immutable", () => {
    expect(() => failureReasonStore.update("regression", { name: "x" })).toThrow(/No such/);
  });
});

describe("remove", () => {
  it("tombstones the record — it stays in the file, deleted AND disabled", () => {
    const rec = failureReasonStore.create("Cloudflare", "Behind a firewall.");
    const removed = failureReasonStore.remove(rec.id);
    expect(removed.id).toBe(rec.id);
    expect(removed.deleted).toBe(true);
    expect(removed.disabled).toBe(true);
    const raw = JSON.parse(fs.readFileSync(indexFile, "utf-8")) as Record<string, unknown>[];
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ id: rec.id, name: "Cloudflare", deleted: true, disabled: true });
  });

  it("keeps resolving for the runs that already carry it", async () => {
    const { resolveFailureReason } = await import("../../shared/failure-reasons.mjs");
    const rec = failureReasonStore.create("Cloudflare", "Behind a firewall.");
    failureReasonStore.remove(rec.id);
    expect(resolveFailureReason(rec.id, failureReasonStore.list())).toEqual({
      id: rec.id,
      name: "Cloudflare",
      description: "Behind a firewall.",
    });
  });

  it("frees an active slot, like disabling does", () => {
    for (let i = 0; i < MAX_ACTIVE_CUSTOM_REASONS; i++) failureReasonStore.create(`Reason ${i}`);
    expect(() => failureReasonStore.create("One more")).toThrow(/limited/);
    failureReasonStore.remove(failureReasonStore.list()[0].id);
    expect(failureReasonStore.create("One more").name).toBe("One more");
  });

  it("is a no-op on an already-deleted reason, and throws for unknown or built-in ids", () => {
    const rec = failureReasonStore.create("Cloudflare");
    const first = failureReasonStore.remove(rec.id);
    expect(failureReasonStore.remove(rec.id).updatedAt).toBe(first.updatedAt);
    expect(() => failureReasonStore.remove("regression")).toThrow(/No such/);
    expect(() => failureReasonStore.remove("nope")).toThrow(/No such/);
  });

  it("refuses edits to a deleted reason — re-adding its name is the way back", () => {
    const rec = failureReasonStore.create("Cloudflare");
    failureReasonStore.remove(rec.id);
    expect(() => failureReasonStore.update(rec.id, { disabled: false })).toThrow(/was deleted/);
    expect(() => failureReasonStore.update(rec.id, { name: "Other" })).toThrow(/was deleted/);
  });

  it("restores the SAME record when its name is added again, with what was typed now", () => {
    const rec = failureReasonStore.create("Cloudflare", "Old description.");
    failureReasonStore.remove(rec.id);
    const again = failureReasonStore.create("cloudflare", "New description.");
    expect(again.id).toBe(rec.id);
    expect(again.name).toBe("cloudflare");
    expect(again.description).toBe("New description.");
    expect(again.deleted).toBeUndefined();
    expect(again.disabled).toBeUndefined();
    expect(failureReasonStore.list()).toHaveLength(1);
    const raw = JSON.parse(fs.readFileSync(indexFile, "utf-8")) as Record<string, unknown>[];
    expect("deleted" in raw[0]).toBe(false);
    expect("disabled" in raw[0]).toBe(false);
  });

  it("restoring respects the active cap", () => {
    const rec = failureReasonStore.create("Cloudflare");
    failureReasonStore.remove(rec.id);
    for (let i = 0; i < MAX_ACTIVE_CUSTOM_REASONS; i++) failureReasonStore.create(`Reason ${i}`);
    expect(() => failureReasonStore.create("Cloudflare")).toThrow(/limited/);
  });

  it("refuses renaming another reason onto a deleted reason's name", () => {
    const gone = failureReasonStore.create("Cloudflare");
    failureReasonStore.remove(gone.id);
    const other = failureReasonStore.create("Firewall");
    expect(() => failureReasonStore.update(other.id, { name: "CLOUDFLARE" })).toThrow(
      /deleted reason named/,
    );
  });
});

describe("reading", () => {
  it("answers an empty list for a missing or corrupt file", () => {
    expect(failureReasonStore.list()).toEqual([]);
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(indexFile, "{not json", "utf-8");
    expect(failureReasonStore.list()).toEqual([]);
  });
});
