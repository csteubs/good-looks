import { describe, expect, it } from "vitest";

import { parseCommand } from "./command-parse";

describe("parseCommand — waits", () => {
  it("reads plain durations, defaulting to seconds", () => {
    expect(parseCommand("wait 2 seconds")).toEqual({ kind: "compose-wait", waitMs: 2000 });
    expect(parseCommand("wait for 1.5s")).toEqual({ kind: "compose-wait", waitMs: 1500 });
    expect(parseCommand("pause 500ms")).toEqual({ kind: "compose-wait", waitMs: 500 });
    expect(parseCommand("sleep 3")).toEqual({ kind: "compose-wait", waitMs: 3000 });
    expect(parseCommand("Wait 1 minute")).toEqual({ kind: "compose-wait", waitMs: 60000 });
  });

  it("leaves a conditional wait to the agent — a condition is not a duration", () => {
    expect(parseCommand("wait for the banner to disappear")).toBeNull();
    expect(parseCommand("wait until the cart updates")).toBeNull();
  });
});

describe("parseCommand — element assertions arm the picker", () => {
  it("maps the state vocabulary", () => {
    expect(parseCommand("assert the heading is visible")).toEqual({ kind: "arm-assert", assert: "visible" });
    expect(parseCommand("check that the spinner is hidden")).toEqual({ kind: "arm-assert", assert: "hidden" });
    expect(parseCommand("make sure the submit button is enabled")).toEqual({ kind: "arm-assert", assert: "enabled" });
    expect(parseCommand("verify the checkbox is checked")).toEqual({ kind: "arm-assert", assert: "checked" });
    expect(parseCommand("expect the coupon field to be disabled")).toEqual({ kind: "arm-assert", assert: "disabled" });
  });

  it("reads negations before their positives — 'not visible' must not arm 'visible'", () => {
    expect(parseCommand("assert the banner is not visible")).toEqual({ kind: "arm-assert", assert: "hidden" });
    expect(parseCommand("check the box is not checked")).toEqual({ kind: "arm-assert", assert: "unchecked" });
    expect(parseCommand("assert the field is not enabled")).toEqual({ kind: "arm-assert", assert: "disabled" });
  });

  it("arms the text kinds", () => {
    expect(parseCommand("assert the heading text")).toEqual({ kind: "arm-assert", assert: "text" });
    expect(parseCommand("check the exact text of the title")).toEqual({ kind: "arm-assert", assert: "exactText" });
  });
});

describe("parseCommand — page assertions open the prefilled form", () => {
  it("maps the URL kinds, path as the default", () => {
    expect(parseCommand("assert the url path is /cart")).toEqual({ kind: "compose-assert", assert: "urlPathIs" });
    expect(parseCommand("check the url contains checkout")).toEqual({ kind: "compose-assert", assert: "url" });
    expect(parseCommand("verify the url ends with /done")).toEqual({ kind: "compose-assert", assert: "urlEndsWith" });
    expect(parseCommand("assert the url is exactly this")).toEqual({ kind: "compose-assert", assert: "urlIs" });
    expect(parseCommand("check the url")).toEqual({ kind: "compose-assert", assert: "urlPathIs" });
  });

  it("maps the title kinds", () => {
    expect(parseCommand("assert the page title")).toEqual({ kind: "compose-assert", assert: "title" });
    expect(parseCommand("check the title contains Order")).toEqual({ kind: "compose-assert", assert: "titleContains" });
  });
});

describe("parseCommand — everything else is the agent's", () => {
  it("declines goals, multi-step asks and value claims", () => {
    expect(parseCommand("add the multivitamin to the cart and check out")).toBeNull();
    expect(parseCommand("assert the total is $40")).toBeNull();
    expect(parseCommand("log in as chris and open settings")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("   ")).toBeNull();
  });

  it("declines an assert verb that is not at the start — that sentence is a goal", () => {
    expect(parseCommand("open the cart and verify the badge is visible")).toBeNull();
  });
});
