// Is the test detail head the SAME HEIGHT for every test, and are its controls
// left-aligned under the test's name?
//
// WHY THIS CANNOT BE A UNIT TEST. Both properties are layout, and jsdom has no
// layout engine: every rectangle it reports is zeros, so "head is 161px for
// every test" and "head is 161px for one test and 190px for another" measure
// identically there. `check:narrow-layout` pins the CSS RULES that are meant to
// produce this; only a real browser can say whether they do.
//
// WHAT IT GUARDS AGAINST (2026-09-25). Moving the crawler-signature warning out
// of the toolbar and under the test's URL grew the identity column a line for
// tests with a warning, and shrank the toolbar below its line, where its auto
// start margin floated it right to start under nothing. Both were state-
// dependent: a test without a warning looked fine, which is how it shipped.
// The fixed-height two-line toolbar this spec pins replaced that.
//
// WHY THE BROWSER PREVIEW, not the Electron app. The states worth comparing
// already exist as preview fixtures — a test with an expired signature
// (`t-checkout`), one without (`t-login`), an imported test carrying the
// base-URL field AND a warning (`t-imported`), an imported test with a long
// name (`t-long`) — and a run can be started there (the bridge finishes it on
// a timer). Seeding the same four through the real app would need a
// signature store, an import and a recording, and would measure the same CSS.
//
// Built here rather than by `npm run build`, because that builds the APP; the
// preview is `vite build --mode preview`, into a temp dir so a stale
// `build-preview/` cannot answer for the current source.
//
// VERIFIED TO FAIL against: the head before this fix (the warning test's head is
// a line taller, and the controls start right of the name); a toolbar allowed
// to wrap its toggle labels (the imported test's head grows at 960px); and
// `.gl-detail-tools { margin-inline-start: auto }` restored.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The app's minimum window (main/index.ts, `scaled(960)` at scale 1), its
 *  default (1000), and two wider ones — the old head changed shape as the
 *  window crossed ~1260px, so a single width would not have seen it. */
const WIDTHS = [960, 1000, 1280, 1920] as const;

/** Fixture tests covering every state that changes what the head holds. */
const TESTS = [
  { id: "t-checkout", has: "an expired-signature warning" },
  { id: "t-login", has: "no warning" },
  { id: "t-imported", has: "a warning AND the imported test's base-URL field" },
  { id: "t-long", has: "an imported test's base-URL field and no warning" },
] as const;

let outDir = "";
let server: http.Server | null = null;
let baseUrl = "";

test.beforeAll(async () => {
  test.setTimeout(180_000);
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "good-looks-preview-"));
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"),
      "build",
      "--mode",
      "preview",
      "--outDir",
      outDir,
      "--emptyOutDir",
      "--logLevel",
      "error",
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".json": "application/json",
  };
  server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = path.join(outDir, urlPath);
    // SPA fallback, as the preview's own dev server does: every path is
    // preview.html, and the query string picks the view.
    if (!file.startsWith(outDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(outDir, "preview.html");
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/preview.html`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

interface HeadGeometry {
  head: number;
  tools: number;
  /** Left edge of the first control minus the left edge of the test's name. */
  controlsOffset: number;
  /** Any control whose box pokes past the head's right edge. */
  outside: string[];
  /** Pairs of controls whose boxes intersect. */
  overlaps: string[];
  /** Toggle labels cut to an ellipsis. */
  truncated: string[];
  hasWarning: boolean;
}

async function openTest(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}?test=${id}`);
  await page.locator(".gl-detail-tools").waitFor();
  // The preview opens a "missed run" dialog on load for its routine fixture;
  // it is modal, and the head is what is being measured, not the dialog.
  const missed = page.getByRole("alertdialog");
  if (await missed.isVisible().catch(() => false)) {
    await missed.getByRole("button", { name: "Cancel" }).click();
    await missed.waitFor({ state: "detached" });
  }
  // Wait for content, not containers: the name renders once the test query
  // resolves, and the head measured before that is a different head.
  await expect(page.locator(".gl-detail-ident h2")).not.toBeEmpty();
}

async function measure(page: Page): Promise<HeadGeometry> {
  return page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect();
    const head = box(document.querySelector(".gl-detail-head")!);
    const ident = document.querySelector(".gl-detail-ident")!;
    const name = box(ident.querySelector("h2") ?? ident);
    const tools = document.querySelector(".gl-detail-tools")!;
    const firstControl = box(tools.querySelector("button")!);
    const leaves = [
      ...tools.querySelectorAll(
        "button, input, [role=checkbox], .gl-run-option-text, .gl-run-option > span:first-child",
      ),
    ].filter((el) => box(el).width > 0);
    const label = (el: Element) =>
      (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().slice(0, 30);
    const overlaps: string[] = [];
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        if (leaves[i].contains(leaves[j]) || leaves[j].contains(leaves[i])) continue;
        const a = box(leaves[i]);
        const b = box(leaves[j]);
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
          overlaps.push(`${label(leaves[i])} / ${label(leaves[j])}`);
        }
      }
    }
    return {
      head: Math.round(head.height),
      tools: Math.round(box(tools).height),
      controlsOffset: Math.round(firstControl.left - name.left),
      outside: leaves.filter((el) => box(el).right > head.right + 0.5).map(label),
      overlaps,
      truncated: [...document.querySelectorAll(".gl-run-option-text")]
        .filter((el) => el.scrollWidth > el.clientWidth)
        .map(label),
      hasWarning: document.querySelector(".gl-detail-signature") !== null,
    };
  });
}

test("the detail head is one height for every test, state and window width", async ({ browser }) => {
  const heights = new Map<string, number>();
  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    for (const t of TESTS) {
      await openTest(page, t.id);
      const g = await measure(page);
      const where = `${t.id} (${t.has}) at ${width}px`;

      // The fixtures still hold the states this spec claims to compare — a
      // fixture edit that drops the warning would otherwise turn the whole
      // comparison into one state measured four times.
      expect(g.hasWarning, `${where}: warning present as the fixture intends`).toBe(
        t.id === "t-checkout" || t.id === "t-imported",
      );

      expect(g.controlsOffset, `${where}: controls start under the test's name`).toBe(0);
      expect(g.outside, `${where}: every control inside the pane`).toEqual([]);
      expect(g.overlaps, `${where}: no control painted over another`).toEqual([]);
      expect(g.truncated, `${where}: toggle labels readable in full`).toEqual([]);
      heights.set(where, g.head);

      if (t.id === "t-login") {
        // A running test swaps Run test for Stop and disables the toggles;
        // the head must not move while somebody is reaching for Stop.
        await page.getByRole("button", { name: /run test/i }).click();
        await expect(page.getByRole("button", { name: /^stop$/i })).toBeVisible();
        const running = await measure(page);
        heights.set(`${where}, running`, running.head);
        expect(running.controlsOffset, `${where}, running: controls start under the name`).toBe(0);
      }
    }
    await page.close();
  }

  const distinct = [...new Set(heights.values())];
  expect(
    distinct,
    `one head height across all cases, got: ${[...heights].map(([k, v]) => `${k}=${v}`).join("; ")}`,
  ).toHaveLength(1);
});
