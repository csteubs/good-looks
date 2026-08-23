// The language service over the REAL typescript and the REAL @playwright/test
// types in this checkout's node_modules: what a type error looks like, what
// `page.` completes to, what hover says, and what each inspection reports and
// fixes.

import * as path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

import { createTsService, stepTitleFor, type TsService, type Inspection } from "./core.js";

const NODE_MODULES = path.resolve(__dirname, "..", "..", "..", "node_modules");

const SPEC = [
  'import { test, expect } from "@playwright/test";',
  "",
  'test("t", async ({ page }) => {',
  '  await page.goto("https://a.example");',
  '  await page.getByRole("button", { name: "Go" }).click();',
  "});",
  "",
].join("\n");

let svc: TsService;
beforeAll(() => {
  svc = createTsService({ nodeModules: NODE_MODULES });
});

function applyFix(text: string, i: Inspection): string {
  let out = text;
  for (const e of [...i.fix!.edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return out;
}

describe("createTsService", () => {
  it("resolves @playwright/test from the bundled tree: a correct spec has no diagnostics", () => {
    svc.update("t1", SPEC);
    expect(svc.diagnostics("t1")).toEqual([]);
  });

  it("reports a type error with its span", () => {
    svc.update("t1", SPEC.replace('.click();', '.clik();'));
    const d = svc.diagnostics("t1");
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe("error");
    expect(d[0].message).toContain("clik");
    expect(SPEC.replace('.click();', '.clik();').slice(d[0].from, d[0].to)).toBe("clik");
  });

  it("completes page. with Playwright's page methods, and hovers a method with its signature", () => {
    const text = SPEC.replace('  await page.goto("https://a.example");', "  await page.");
    svc.update("t1", text);
    const at = text.indexOf("await page.") + "await page.".length;
    const labels = svc.completions("t1", at).map((c) => c.label);
    expect(labels).toContain("goto");
    expect(labels).toContain("getByRole");
    expect(labels.length).toBeLessThanOrEqual(200);

    svc.update("t1", SPEC);
    const h = svc.hover("t1", SPEC.indexOf("goto") + 1);
    expect(h?.text).toContain("goto(url: string");
    expect(SPEC.slice(h!.from, h!.to)).toBe("goto");
  });

  it("types a helper imported from the runtime module handed in as text", () => {
    const runtime = "export function glHelper(n) { return n + 1; }\n";
    const text = SPEC.replace('import { test, expect } from "@playwright/test";', 'import { test, expect } from "@playwright/test";\nimport { glHelper } from "./glaze-runtime.mjs";').replace("});\n", "  glHelper(1);\n});\n");
    svc.update("t2", text, runtime);
    expect(svc.diagnostics("t2")).toEqual([]);
    svc.close("t2");
  });
});

describe("inspections", () => {
  const inspect = (text: string, id = "i") => {
    svc.update(id, text);
    return svc.inspections(id);
  };
  const inBody = (...stmts: string[]) => SPEC.replace("});\n", stmts.map((s) => "  " + s + "\n").join("") + "});\n");

  it("no-wait-for-timeout: warns and the fix removes the statement", () => {
    const text = inBody("await page.waitForTimeout(500);");
    const [i] = inspect(text).filter((x) => x.rule === "no-wait-for-timeout");
    expect(i.severity).toBe("warning");
    expect(applyFix(text, i)).toBe(SPEC);
  });

  it("no-force-without-reason: warns without a comment, stays quiet with one, and the fix drops the property", () => {
    const text = inBody('await page.getByRole("link").click({ force: true });');
    const hits = inspect(text).filter((x) => x.rule === "no-force-without-reason");
    expect(hits).toHaveLength(1);
    expect(applyFix(text, hits[0])).toBe(inBody('await page.getByRole("link").click({});'));
    const withTimeout = inBody('await page.getByRole("link").click({ timeout: 1000, force: true });');
    const [h2] = inspect(withTimeout).filter((x) => x.rule === "no-force-without-reason");
    expect(applyFix(withTimeout, h2)).toBe(inBody('await page.getByRole("link").click({ timeout: 1000 });'));
    const commented = inBody("// the overlay is a decoration, it never intercepts", 'await page.getByRole("link").click({ force: true });');
    expect(inspect(commented).filter((x) => x.rule === "no-force-without-reason")).toEqual([]);
  });

  it("missing-await: an un-awaited promise is an error, and the fix adds await", () => {
    const text = inBody('expect(page.getByRole("heading")).toBeVisible();');
    const [i] = inspect(text).filter((x) => x.rule === "missing-await");
    expect(i.severity).toBe("error");
    expect(applyFix(text, i)).toBe(inBody('await expect(page.getByRole("heading")).toBeVisible();'));
    // Nothing to report once awaited.
    expect(inspect(applyFix(text, i)).filter((x) => x.rule === "missing-await")).toEqual([]);
  });

  it("raw-css-locator and index-pinned-locator are hints without fixes; semantic locators are quiet", () => {
    const text = inBody('await page.locator("#submit").click();', 'await page.getByRole("button").nth(2).click();');
    const hits = inspect(text);
    const css = hits.find((x) => x.rule === "raw-css-locator")!;
    expect(css.severity).toBe("hint");
    expect(css.fix).toBeUndefined();
    expect(text.slice(css.from, css.to)).toBe('"#submit"');
    const nth = hits.find((x) => x.rule === "index-pinned-locator")!;
    expect(text.slice(nth.from, nth.to)).toBe("nth");
    expect(inspect(SPEC).filter((x) => x.rule === "raw-css-locator" || x.rule === "index-pinned-locator")).toEqual([]);
  });

  it("unwrapped-statement: a page statement outside test.step is a hint whose fix wraps it; wrapped ones are quiet", () => {
    const wrapped = SPEC.replace(
      '  await page.getByRole("button", { name: "Go" }).click();',
      '  await test.step("click Go", async () => {\n    await page.getByRole("button", { name: "Go" }).click();\n  });',
    );
    const hits = inspect(wrapped).filter((x) => x.rule === "unwrapped-statement");
    // Only the goto is unwrapped now.
    expect(hits).toHaveLength(1);
    expect(wrapped.slice(hits[0].from, hits[0].to)).toBe('await page.goto("https://a.example");');
    const fixed = applyFix(wrapped, hits[0]);
    expect(fixed).toContain('  await test.step("goto \\"https://a.example\\"", async () => {\n    await page.goto("https://a.example");\n  });');
    expect(inspect(fixed).filter((x) => x.rule === "unwrapped-statement")).toEqual([]);
  });

  it("format returns TypeScript's edits, and a generated spec needs none", () => {
    svc.update("f", SPEC);
    expect(svc.format("f")).toEqual([]);
    const messy = SPEC.replace('  await page.goto("https://a.example");', 'await page.goto(  "https://a.example" )');
    svc.update("f", messy);
    const edits = svc.format("f");
    expect(edits.length).toBeGreaterThan(0);
    let out = messy;
    for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.text + out.slice(e.to);
    expect(out).toBe(SPEC);
  });

  it("a rule switched off reports nothing", () => {
    svc.update("off", inBody("await page.waitForTimeout(500);"));
    expect(svc.inspections("off", { "no-wait-for-timeout": false }).filter((x) => x.rule === "no-wait-for-timeout")).toEqual([]);
    expect(svc.inspections("off").filter((x) => x.rule === "no-wait-for-timeout")).toHaveLength(1);
  });

  it("stepTitleFor spells a plain title", () => {
    expect(stepTitleFor('await page.getByRole("button", { name: "Go" }).click();')).toBe('click getByRole("button", { name: "Go" })');
    expect(stepTitleFor('await expect(page.getByText("Hi")).toBeVisible();')).toBe('expect page.getByText("Hi") toBeVisible');
    expect(stepTitleFor('await page.goto("https://a.example");')).toBe('goto "https://a.example"');
  });
});
