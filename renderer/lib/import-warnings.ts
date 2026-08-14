// What an import has to say out loud, beyond "N tests imported".
//
// An imported suite arrives with things missing that nothing about the copy
// makes visible: a base URL its navigations resolve against, a dev server it
// expected somebody to have started. Discovering those from a failed run is
// expensive — the base-URL one surfaces as a Playwright protocol error naming
// neither the config nor the URL — and the moment the user is actually looking
// is the moment the import finishes.
//
// Pure, and separate from the two dialogs that call it, because both the
// sidebar's "Select from files" and the git-URL dialog import the same way and
// should say the same thing. Returning strings rather than raising toasts is
// what lets this be tested at all: `renderer/lib/**` runs in the node project,
// which has no toast to look at.

import type { ImportResult } from "./api";

/** Cap on how many test names a warning lists before it summarises. A folder
 *  import can bring in hundreds, and a toast that lists them all is a toast
 *  nobody reads. */
const MAX_NAMED = 3;

/** Cap on a single name. A test's name here is its `test("…")` title, which is
 *  text from SOMEBODY ELSE'S project — capping how many are listed does nothing
 *  about one title that is two thousand characters long, or that carries
 *  newlines. */
const MAX_NAME_CHARS = 60;

function trimName(name: string): string {
  const flat = name.replace(/\s+/g, " ").trim();
  return flat.length > MAX_NAME_CHARS ? flat.slice(0, MAX_NAME_CHARS - 1) + "…" : flat;
}

function nameList(names: string[]): string {
  const shown = names.slice(0, MAX_NAMED).map(trimName).join(", ");
  // The comma matters: without it "alpha, bravo, charlie and 1 more" reads as a
  // third test called "charlie and 1 more".
  return names.length <= MAX_NAMED ? shown : `${shown}, and ${names.length - MAX_NAMED} more`;
}

/**
 * Warnings for a finished import, in the order they should be shown. Empty
 * when the import brought in everything it needed.
 */
export function importWarnings(
  // Partial, and the `?? []` below are load-bearing rather than defensive
  // habit: this is handed a value that crossed IPC, and a record written by an
  // older backend has neither field. Declaring them required would make the
  // guards look like dead code to the next person reading it.
  res: Partial<Pick<ImportResult, "needsBaseUrl" | "unsupported">>,
): string[] {
  const out: string[] = [];
  const needs = res.needsBaseUrl ?? [];
  if (needs.length > 0) {
    // Says what is missing, why it is missing, and where to put it — a warning
    // that only names the problem sends the user back to the same failed run.
    out.push(
      (needs.length === 1
        ? `${nameList(needs)} navigates to relative URLs`
        : `${needs.length} tests navigate to relative URLs (${nameList(needs)})`) +
        // Deliberately does not say "your playwright.config has no baseURL":
        // this fires when the project HAD no config to read as well, and
        // sending someone to look for a file that doesn't exist is worse than
        // saying less.
        " and no base URL came with the imported project. " +
        "Set Base URL on the test before running it.",
    );
  }
  const unsupported = res.unsupported ?? [];
  if (unsupported.length > 0) {
    out.push(
      "This project's playwright.config uses " +
        unsupported.join(", ") +
        ", which this app does not run for you.",
    );
  }
  return out;
}
