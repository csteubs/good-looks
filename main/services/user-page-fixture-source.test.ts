import { describe, it, expect } from "vitest";
import { transform } from "esbuild";

import { USER_CSS_ENV, USER_INIT_ENV, userPageEnv, userPageFixtureSource, USER_PAGE_FIXTURE_FILE } from "../../shared/user-page-fixture-source.mjs";

describe("user page fixture", () => {
  it("carries each setting as one base64 value, and nothing when both are blank", () => {
    expect(userPageEnv({ userStylesheet: "", userInitScript: "  " })).toEqual({});
    const env = userPageEnv({ userStylesheet: "#x { display: none }\n", userInitScript: 'window.__ok = "yes";' });
    expect(Buffer.from(env[USER_CSS_ENV], "base64").toString("utf-8")).toBe("#x { display: none }");
    expect(Buffer.from(env[USER_INIT_ENV], "base64").toString("utf-8")).toBe('window.__ok = "yes";');
  });

  it("is valid ESM that installs an init script on the context and a style tag on every document", async () => {
    const out = await transform(userPageFixtureSource, { loader: "js", format: "esm" });
    expect(out.code).toContain("addInitScript");
    expect(userPageFixtureSource).toContain('page.on("domcontentloaded", apply)');
    expect(userPageFixtureSource).toContain('page.on("load", apply)');
    expect(userPageFixtureSource).toContain(`process.env.${USER_CSS_ENV}`);
    expect(userPageFixtureSource).toContain(`process.env.${USER_INIT_ENV}`);
    expect(USER_PAGE_FIXTURE_FILE).toMatch(/\.mjs$/);
  });
});
