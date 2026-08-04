// The artifact-capture fixture as a raw JS string, written next to the specs at
// runtime (like step-reporter-source.ts). When a run has the Phase 0 capture
// toggle enabled, the runner runs a temp copy of the spec whose
// `@playwright/test` import is redirected to this module; it re-exports `expect`
// unchanged and an extended `test` whose `page` fixture screenshots after every
// page-mutating action into GLAZE_ARTIFACT_DIR.
//
// Contract (Phase 1 of the visual-testing roadmap):
//   • Files:    <GLAZE_ARTIFACT_DIR>/<stepIndex>.png  (stepIndex = 0-based ACTION order)
//   • Manifest: <GLAZE_ARTIFACT_DIR>/manifest.json     (per-step artifact + outcome model)
// The check is env-gated so an off run pays nothing (falls back to base `test`,
// no prototype patching, no fixture wrapping). Every capture is wrapped so a
// failure (detached frame, navigation mid-shot, timeout) is logged and skipped
// and can NEVER fail or alter the underlying test's pass/fail result.
//
// Plain JavaScript (no TypeScript) because Playwright loads it via its own
// Babel transform, which does not understand `import type`.

export const captureFixtureSource = `import { test as base, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

export { expect };

const ON = process.env.GLAZE_CAPTURE_ARTIFACTS === "1";
const DIR = process.env.GLAZE_ARTIFACT_DIR || "";
const TEST_ID = process.env.GLAZE_TEST_ID || "";
const RUN_ID = process.env.GLAZE_RUN_ID || "";
const SHOT_TIMEOUT_MS = 5000;

// page/locator methods that mutate or navigate the page — the meaningful set for
// visual diffing. Pure queries and assertions are intentionally NOT captured.
const PAGE_ACTIONS = ["goto", "goBack", "goForward", "reload", "setViewportSize", "setContent"];
const LOCATOR_ACTIONS = [
  "click", "dblclick", "fill", "press", "type", "check", "uncheck", "setChecked",
  "selectOption", "tap", "hover", "focus", "clear", "setInputFiles", "dragTo",
];

// Module-level context for the active test. workers=1 + one spec per run means a
// single test owns this at a time, so the locator-prototype patch (which is
// global) reads the current run's context safely.
let ctx = null; // { dir, index, manifest, startedAt, captureMs }
let patched = false;

function describe(target, method, args) {
  let loc = "";
  try { loc = String(target); } catch (e) { loc = ""; }
  // Page-level actions (goto/reload/...) stringify to a bare object; the
  // meaningful detail lives in the value (e.g. the URL), so label them 'page'.
  if (!loc || loc.indexOf("[object") === 0) loc = "page";
  let value;
  try { if (typeof (args && args[0]) === "string") value = args[0]; } catch (e) { /* ignore */ }
  return { action: method, target: loc, value: value };
}

// The element's on-page rectangle, NORMALIZED against the viewport, recorded at
// capture time. Component-level diffing crops to this instead of re-resolving a
// selector later — the roadmap's "stable selector-to-region mapping" hazard is
// avoided by never doing the mapping twice.
async function elementRect(page, target) {
  try {
    if (!target || typeof target.boundingBox !== "function") return undefined;
    const box = await target.boundingBox({ timeout: 1000 });
    if (!box || !box.width || !box.height) return undefined;
    const vp = page.viewportSize && page.viewportSize();
    if (!vp || !vp.width || !vp.height) return undefined;
    return {
      x: box.x / vp.width,
      y: box.y / vp.height,
      w: box.width / vp.width,
      h: box.height / vp.height,
    };
  } catch (e) {
    return undefined; // geometry is best-effort; never fail the test for it
  }
}

async function capture(page, method, target, args) {
  if (!ctx) return;
  const index = ctx.index++;
  const info = describe(target, method, args);
  let ok = false;
  // Time the screenshot itself so the runner can report what capture actually
  // costs, rather than leaving the toggle's overhead to guesswork.
  // Measured BEFORE the screenshot so it reflects the element the action ran
  // against, and excluded from captureMs so overhead stays screenshot-only.
  const rect = await elementRect(page, target);
  const tShot = Date.now();
  try {
    if (page && (!page.isClosed || !page.isClosed())) {
      await page.screenshot({ path: path.join(ctx.dir, index + ".png"), timeout: SHOT_TIMEOUT_MS });
      ok = true;
    }
  } catch (err) {
    // Capture must never fail or alter the test. Log to stderr for diagnosis.
    process.stderr.write("[glaze-capture] step " + index + " (" + method + ") screenshot failed: " + String(err) + "\\n");
  }
  const ms = Date.now() - tShot;
  ctx.captureMs += ms;
  const entry = { index: index, action: info.action, target: info.target, value: info.value, ok: ok, ts: Date.now(), ms: ms };
  if (rect) entry.rect = rect;
  ctx.manifest.push(entry);
}

function wrap(obj, method, getPage) {
  const orig = obj[method];
  if (typeof orig !== "function") return;
  obj[method] = async function (...args) {
    const result = await orig.apply(this, args);
    // Screenshot AFTER the action resolves, so the frame reflects its effect.
    try { await capture(getPage(this), method, this, args); } catch (e) { /* never throw into the test */ }
    return result;
  };
}

function patchOnce(page) {
  if (patched) return;
  patched = true;
  for (const m of PAGE_ACTIONS) wrap(page, m, function () { return page; });
  // Reach the Locator prototype from a throwaway locator and patch it once.
  try {
    const proto = Object.getPrototypeOf(page.locator("body"));
    for (const m of LOCATOR_ACTIONS) wrap(proto, m, function (self) { return self.page(); });
  } catch (err) {
    process.stderr.write("[glaze-capture] could not patch locator prototype: " + String(err) + "\\n");
  }
}

export const test = (ON && DIR) ? base.extend({
  page: async ({ page }, use, testInfo) => {
    try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { /* ignore */ }
    ctx = { dir: DIR, index: 0, manifest: [], startedAt: Date.now(), captureMs: 0 };
    patchOnce(page);
    try {
      await use(page);
    } finally {
      // Persist the manifest: the per-step artifact + outcome model for this run.
      try {
        const manifest = {
          testId: TEST_ID,
          runId: RUN_ID,
          title: testInfo.title,
          status: testInfo.status,
          startedAt: ctx.startedAt,
          finishedAt: Date.now(),
          // Total wall-clock ms spent taking screenshots this run, and how many
          // were attempted — the raw inputs for the overhead readout in Stats.
          captureMs: ctx.captureMs,
          shotCount: ctx.manifest.length,
          steps: ctx.manifest,
        };
        fs.writeFileSync(path.join(DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
      } catch (err) {
        process.stderr.write("[glaze-capture] manifest write failed: " + String(err) + "\\n");
      }
      ctx = null;
    }
  },
}) : base;
`;
