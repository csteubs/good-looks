// The three input-fidelity features, executed by real Playwright against a
// real page.
//
// Each one is a claim about what a generated line DOES, and none of them can be
// settled by looking at the emitted text. "pressSequentially fires an event per
// character" is a fact about Playwright and a browser; "{ timeout: 500 } bounds
// the wait" is a fact about whether the option reached the call at all — a spec
// that merely CONTAINS the option would pass a source-shape test while the
// argument sat in the wrong position and was ignored. `page.reload()` is the
// same: only a page that observes its own reload can report one.
//
// A plain browser page rather than `_electron`, for the same reason
// assert-parity is: the subject is emission semantics, not a window.
//
// VERIFIED TO FAIL: with the generator emitting `fill()` for the sequential
// mode, "an autocomplete opens" goes red and its `fill` counterpart stays
// green — which IS the bug, stated as a test. With the timeout option dropped
// from the emitted call, "a short timeout gives up early" goes red.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page } from "@playwright/test";

import { generateSpec } from "../main/services/script-generator.js";
import type { Step } from "../main/recorder/types.js";

// An autocomplete that only reveals its list on PER-CHARACTER input, which is
// how a real one behaves: it listens for keystrokes, not for the field's final
// value. `fill()` sets the value and fires ONE input event carrying the whole
// string, so the `data-keys` counter never passes 1 and the list stays closed.
//
// `#slow` appears two seconds after load — long enough that a step with a
// half-second timeout must give up and a step with three seconds must not.
//
// `#reload-count` survives a reload only in sessionStorage, so the page can
// report how many times it has loaded.
const FIXTURE = `<!doctype html>
<html><head><title>Input fidelity fixture</title></head>
<body>
  <label for="city">City</label>
  <input id="city" type="text" aria-autocomplete="list" role="combobox" data-keys="0" />
  <ul id="suggestions" hidden><li id="suggestion">London</li></ul>

  <label for="plain">Plain</label>
  <input id="plain" type="text" />

  <button id="slow" hidden>Ready</button>
  <p id="reload-count">0</p>

  <script>
    var city = document.getElementById("city");
    var list = document.getElementById("suggestions");
    // One handler, counting the keystrokes the page actually saw. A bulk fill
    // fires this once with the whole string; typing fires it per character.
    city.addEventListener("input", function () {
      var n = Number(city.getAttribute("data-keys")) + 1;
      city.setAttribute("data-keys", String(n));
      // The list opens only once the page has seen more than one keystroke —
      // the behaviour that distinguishes a real autocomplete from a field that
      // merely has a value.
      if (n > 1) list.hidden = false;
    });

    setTimeout(function () { document.getElementById("slow").hidden = false; }, 2000);

    var loads = Number(sessionStorage.getItem("loads") || "0") + 1;
    sessionStorage.setItem("loads", String(loads));
    document.getElementById("reload-count").textContent = String(loads);
  </script>
</body></html>`;

let server: http.Server;
let base: string;

test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

let n = 0;
const s = (over: Partial<Step>): Step => ({ id: "if" + ++n, timestamp: 0, ...over }) as Step;

/**
 * Run the line the generator emits for a step, with real Playwright.
 *
 * The emitted TEXT is executed rather than re-derived, which is the whole
 * point: a test that reconstructed the call from the step would be asserting
 * this file's model of the generator, not the generator.
 */
async function runStepLine(page: Page, step: Step): Promise<{ ok: boolean; error?: string }> {
  const src = generateSpec({ name: "fidelity", url: base, steps: [step] });
  const line = src.split("\n").find((l) => l.trim().startsWith("await page."));
  if (!line) throw new Error("no line emitted for step: " + JSON.stringify(step));
  const run = new Function("page", "expect", `return (async () => { ${line.trim()} })();`);
  try {
    await run(page, expect);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const CITY = { k: "label" as const, v: "City" };

test.describe("typing mode", () => {
  test("a plain fill leaves the autocomplete closed — the bug this mode exists for", async ({
    page,
  }) => {
    await page.goto(base);
    const res = await runStepLine(
      page,
      s({ type: "fill", locator: CITY, value: "Lon" }),
    );
    expect(res.ok).toBe(true);
    // The field holds the right text, so nothing about the step looks wrong…
    await expect(page.locator("#city")).toHaveValue("Lon");
    // …but the page saw ONE input event for three characters, so its list never
    // opened. The next recorded step — clicking a suggestion — would fail here,
    // one step away from the cause.
    await expect(page.locator("#city")).toHaveAttribute("data-keys", "1");
    await expect(page.locator("#suggestion")).toBeHidden();
  });

  test("the per-character mode opens it", async ({ page }) => {
    await page.goto(base);
    const res = await runStepLine(
      page,
      s({ type: "fill", locator: CITY, value: "Lon", typeMode: "sequential" }),
    );
    expect(res.ok).toBe(true);
    await expect(page.locator("#city")).toHaveValue("Lon");
    await expect(page.locator("#city")).toHaveAttribute("data-keys", "3");
    await expect(page.locator("#suggestion")).toBeVisible();
  });

  test("a delay still delivers every character", async ({ page }) => {
    await page.goto(base);
    const res = await runStepLine(
      page,
      s({ type: "fill", locator: CITY, value: "Lon", typeMode: "sequential", typeDelayMs: 10 }),
    );
    expect(res.ok).toBe(true);
    await expect(page.locator("#city")).toHaveAttribute("data-keys", "3");
  });

  test("it appends rather than replacing — the documented difference", async ({ page }) => {
    // Pinned rather than lamented. The recorder only chooses this mode for a
    // field that was EMPTY at focus, where the two are equivalent; a user who
    // picks it by hand for a field with text needs the behaviour to be what
    // the step row says it is.
    await page.goto(base);
    await page.locator("#plain").fill("Lon");
    await runStepLine(
      page,
      s({ type: "fill", locator: { k: "css", v: "#plain" }, value: "don", typeMode: "sequential" }),
    );
    await expect(page.locator("#plain")).toHaveValue("London");
  });

  test("a plain fill replaces, as it always has", async ({ page }) => {
    await page.goto(base);
    await page.locator("#plain").fill("Lon");
    await runStepLine(
      page,
      s({ type: "fill", locator: { k: "css", v: "#plain" }, value: "Paris" }),
    );
    await expect(page.locator("#plain")).toHaveValue("Paris");
  });
});

test.describe("per-step timeout", () => {
  // The fixture's #slow button appears after 2s. These two rows are the same
  // step against the same page, differing only in the number — which is what
  // makes them evidence that the option REACHED the call rather than merely
  // appearing in the source.
  test("a short timeout gives up before the element arrives", async ({ page }) => {
    await page.goto(base);
    const started = Date.now();
    const res = await runStepLine(
      page,
      s({ type: "click", locator: { k: "css", v: "#slow" }, timeoutMs: 500 }),
    );
    expect(res.ok).toBe(false);
    // And it gave up at ITS timeout, not at Playwright's 30s default — the
    // assertion that would still pass if the option were ignored is the
    // failure alone, so the elapsed time is what carries this row.
    expect(Date.now() - started).toBeLessThan(1800);
  });

  test("a longer one waits for it", async ({ page }) => {
    await page.goto(base);
    const res = await runStepLine(
      page,
      s({ type: "click", locator: { k: "css", v: "#slow" }, timeoutMs: 8000 }),
    );
    expect(res.ok).toBe(true);
  });

  test("it bounds an assertion too", async ({ page }) => {
    await page.goto(base);
    const src = generateSpec({
      name: "fidelity",
      url: base,
      steps: [
        s({ type: "assert", assert: "visible", locator: { k: "css", v: "#slow" }, timeoutMs: 500 }),
      ],
    });
    const line = src.split("\n").find((l) => l.trim().startsWith("await expect"))!;
    const run = new Function("page", "expect", `return (async () => { ${line.trim()} })();`);
    const started = Date.now();
    await expect(run(page, expect)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1800);
  });
});

test.describe("reload", () => {
  test("actually reloads the page", async ({ page }) => {
    await page.goto(base);
    await expect(page.locator("#reload-count")).toHaveText("1");
    // Something held only in the document is the proof: it cannot survive a
    // real reload, and it would survive anything that merely looked like one.
    await page.locator("#plain").fill("typed before the reload");
    const res = await runStepLine(page, s({ type: "reload" }));
    expect(res.ok).toBe(true);
    await expect(page.locator("#reload-count")).toHaveText("2");
    await expect(page.locator("#plain")).toHaveValue("");
  });

  test("takes a timeout without changing what it does", async ({ page }) => {
    await page.goto(base);
    const res = await runStepLine(page, s({ type: "reload", timeoutMs: 15_000 }));
    expect(res.ok).toBe(true);
    await expect(page.locator("#reload-count")).toHaveText("2");
  });
});
