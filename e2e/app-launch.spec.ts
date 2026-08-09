// Does the app actually come up?
//
// Every assertion here is one the Vitest suite structurally cannot make. jsdom
// renders components; it does not boot a main process, register a custom
// scheme, run a preload, or open a window. The failures this catches are the
// ones that leave the unit suite entirely green:
//
//   - the renderer served from file:// and silently CORS-blocked (the reason
//     app:// exists at all — blank window, clean log)
//   - a preload that throws, so window.glazeAPI never exists and every view
//     renders its error state
//   - a main-process module that throws at import, before whenReady

import { test, expect } from "./fixtures.js";

test("the main window opens and renders the library", async ({ window }) => {
  // Served over the custom scheme, not file://. This is the regression that
  // produced a blank window with nothing in any log.
  expect(new URL(window.url()).protocol).toBe("app:");

  await expect(window.getByRole("heading", { name: "GOOD LOOKS!" })).toBeVisible();

  // A fresh userData dir means an empty library, so the empty state is the
  // correct thing to see. Asserting it — rather than just "something rendered"
  // — is what proves the store was read rather than merely constructed.
  await expect(window.getByText(/No tests yet/)).toBeVisible();
});

test("the preload bridge is exposed to the renderer", async ({ window }) => {
  // Not a style preference: if this is missing every view falls back to an
  // empty state that looks exactly like "you have no data yet".
  const bridge = await window.evaluate(() => {
    const api = (window as unknown as { glazeAPI?: Record<string, unknown> }).glazeAPI;
    if (!api) return null;
    return {
      hasIpc: typeof (api.glaze as { ipc?: { invoke?: unknown } })?.ipc?.invoke === "function",
      hasClipboard: typeof (api.clipboard as { writeText?: unknown })?.writeText === "function",
      hasMenu: typeof (api.Menu as { popup?: unknown })?.popup === "function",
    };
  });

  expect(bridge).not.toBeNull();
  expect(bridge).toEqual({ hasIpc: true, hasClipboard: true, hasMenu: true });
});

test("the sidebar offers every view", async ({ window }) => {
  for (const name of ["Stats", "Visual", "Batch", "Heals"]) {
    await expect(window.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await expect(window.getByRole("button", { name: "Add test" })).toBeVisible();
});

test("the renderer loads without console errors", async ({ app }) => {
  const window = await app.firstWindow();
  const errors: string[] = [];
  window.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // The LLM provider probe runs on mount and there is no Ollama on a CI
    // runner. That failure is the app working correctly, and the footer
    // reports it — filtering it here rather than not asserting at all keeps
    // the check meaningful for every OTHER error.
    if (text.includes("11434") || text.includes("127.0.0.1") || text.includes("localhost")) return;
    errors.push(text);
  });

  await window.reload();
  await expect(window.getByRole("heading", { name: "GOOD LOOKS!" })).toBeVisible();

  expect(errors).toEqual([]);
});
