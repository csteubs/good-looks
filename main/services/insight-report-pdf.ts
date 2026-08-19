// Save one insights report as a PDF, main-side end to end.
//
// The same shape as `report-emitter.ts`, for the same reason: the renderer
// asks with a VERB (`insights:exportPdf`) and gets back a path and a byte
// count, never the bytes. The rendering surface is a hidden BrowserWindow
// loading the self-contained page `insight-report-html.ts` builds — content
// only, no preload, no navigation, destroyed in a `finally` so a failed print
// can't leak an invisible window that holds the app open.
//
// Beside `insight-report-store.ts` rather than under `insights/`, and the
// placement is load-bearing: `check:insights-egress` pins that nothing in
// that directory — the generation pipeline, whose output leaves the machine —
// touches the filesystem. This file WRITES a local file the user chose and
// sends nothing, so it lives with the store, outside the scanned boundary.
//
// Dialog FIRST, then render: the print costs a window and a layout pass, and
// a cancelled save should cost nothing. A cancel returns null and raises no
// toast (the user closed a dialog; that is an answer).

import { writeFileSync } from "fs";

import { BrowserWindow, dialog, logger } from "@shell/backend";

import type { InsightReport } from "../recorder/types.js";
import { insightReportHtml, insightReportPdfName } from "./insights/insight-report-html.js";

/** A page that fails to lay out must not hold the export forever. */
const PRINT_TIMEOUT_MS = 15_000;

export async function exportInsightReportPdf(
  report: InsightReport,
): Promise<{ path: string; bytes: number } | null> {
  const chosen = await dialog.showSaveDialog({
    defaultPath: insightReportPdfName(report),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (chosen.canceled || !chosen.filePath) return null;

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 1000,
    webPreferences: { sandbox: true },
  });
  try {
    const html = insightReportHtml(report);
    const timeout = new Promise<never>((_resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("The report page took too long to lay out.")),
        PRINT_TIMEOUT_MS,
      );
      t.unref?.();
    });
    await Promise.race([
      win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`),
      timeout,
    ]);
    const pdf = await Promise.race([
      win.webContents.printToPDF({ pageSize: "A4", printBackground: true }),
      timeout,
    ]);
    try {
      writeFileSync(chosen.filePath, pdf);
    } catch (err) {
      // A full disk or a read-only folder is the user's environment, not a
      // bug; rethrown as a plain sentence for the toast.
      logger.warn("insights", `could not write ${chosen.filePath}: ${String(err)}`);
      throw new Error(`Could not write that file: ${String(err)}`);
    }
    return { path: chosen.filePath, bytes: pdf.byteLength };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
