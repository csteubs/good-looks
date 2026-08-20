// Staging for upload steps: the copy lands inside scripts/uploads/<id>/,
// hostile basenames are flattened into OUR alphabet, and the returned relPath
// always passes the emission guard — the two halves must agree, or a staged
// file would produce a step the generator refuses.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setOpenDialogResult } from "./__tests__/shell-backend-stub.js";
import { stageUploadFile, uploadsRootDir } from "./upload-store.js";
import { isSafeUploadRelPath } from "../recorder/types.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gl-upload-"));
  process.env.GLAZE_TEST_USERDATA = tmp;
});

afterEach(() => {
  setOpenDialogResult(null);
  delete process.env.GLAZE_TEST_USERDATA;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function pickable(name: string, content = "data"): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

describe("stageUploadFile", () => {
  it("copies the pick into the test's uploads dir and returns the step value", async () => {
    setOpenDialogResult(pickable("report.csv", "a,b\n1,2"));
    const res = await stageUploadFile("t-123");
    expect(res.relPath).toBe("uploads/t-123/report.csv");
    const stored = path.join(uploadsRootDir(), "t-123", "report.csv");
    expect(fs.readFileSync(stored, "utf8")).toBe("a,b\n1,2");
    // The two halves must agree: everything staging returns, emission accepts.
    expect(isSafeUploadRelPath(res.relPath)).toBe(true);
  });

  it("flattens a hostile basename into the safe alphabet", async () => {
    setOpenDialogResult(pickable('we"ird $name;.csv'));
    const res = await stageUploadFile("t-1");
    expect(res.relPath).toMatch(/^uploads\/t-1\/[A-Za-z0-9._-]+$/);
    expect(isSafeUploadRelPath(res.relPath)).toBe(true);
  });

  it("dedupes a second pick of the same name instead of overwriting", async () => {
    setOpenDialogResult(pickable("a.csv", "one"));
    const first = await stageUploadFile("t-1");
    setOpenDialogResult(pickable("a.csv", "two"));
    const second = await stageUploadFile("t-1");
    expect(first.relPath).not.toBe(second.relPath);
    expect(
      fs.readFileSync(path.join(uploadsRootDir(), "t-1", "a.csv"), "utf8"),
    ).toBe("one");
  });

  it("reports a cancelled picker as cancelled, staging nothing", async () => {
    setOpenDialogResult(null);
    const res = await stageUploadFile("t-1");
    expect(res.canceled).toBe(true);
    expect(fs.existsSync(path.join(uploadsRootDir(), "t-1"))).toBe(false);
  });

  it("flattens a hostile test id rather than letting it shape the path", async () => {
    setOpenDialogResult(pickable("x.txt"));
    const res = await stageUploadFile("../../evil");
    expect(res.relPath).toMatch(/^uploads\/[A-Za-z0-9._-]+\/x\.txt$/);
    expect(res.relPath).not.toContain("..");
    // Nothing landed outside the uploads root.
    expect(fs.existsSync(path.join(tmp, "evil"))).toBe(false);
  });
});
