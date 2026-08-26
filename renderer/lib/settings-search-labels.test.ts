// The settings SEARCH INDEX and the settings PANES say the same thing.
//
// `settings-schema.ts` carries a `label` per row so search can match on it, and
// each pane carries the same label on its `<SettingRow>` because that is what a
// person reads. Two copies of one string, and nothing compared them — so a row
// could be found under one name and displayed under another, which is the
// failure mode of a search index in general: it does not error, it just answers
// about something the screen does not show.
//
// Found while finishing the Batch → Routine rename (R48). Renaming the two
// batch rows in their panes left the index still saying "batch", and no test
// noticed. It also surfaced a pre-existing one — `github-token` read "GitHub
// token" in search and "GitHub token (branch switcher)" on screen.
//
// Rows with no `<SettingRow>` are skipped rather than failed: some are buttons,
// selects or connection widgets built by hand, and demanding one shape from
// every pane would be a test about markup rather than about copy.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PANE_DIR = join(ROOT, "renderer/settings/panes");

/** JSX decodes entities in an attribute value, so `&amp;` on the page IS `&`.
 *  Comparing the raw text would fail on a difference nobody can see. */
function asRendered(label: string): string {
  return label
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function paneLabels(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of readdirSync(PANE_DIR)) {
    if (!file.endsWith(".tsx") || file.includes(".test.")) continue;
    const src = readFileSync(join(PANE_DIR, file), "utf8");
    for (const m of src.matchAll(/id="([^"]+)"\s*\n\s*label="([^"]*)"/g)) {
      out.set(m[1], asRendered(m[2]));
    }
  }
  return out;
}

function schemaRows(): { id: string; label: string }[] {
  const src = readFileSync(join(ROOT, "renderer/lib/settings-schema.ts"), "utf8");
  return [...src.matchAll(/\{\s*id:\s*"([^"]+)",\s*pane:\s*"([^"]+)",\s*label:\s*"([^"]*)"/g)].map(
    (m) => ({ id: m[1], label: asRendered(m[3]) }),
  );
}

describe("every searchable setting is displayed under the name search found it by", () => {
  it("matches each schema label to its pane's SettingRow", () => {
    const panes = paneLabels();
    const mismatched = schemaRows()
      .filter((row) => panes.has(row.id))
      .filter((row) => panes.get(row.id) !== row.label)
      .map((row) => `${row.id}: index says "${row.label}", pane says "${panes.get(row.id)}"`);
    expect(mismatched).toEqual([]);
  });

  it("compares enough rows to be worth having", () => {
    // The guard against the extractors silently matching nothing — a regex that
    // stops finding `SettingRow`s would make the assertion above pass on an
    // empty set, which is the shape this repo keeps meeting.
    const panes = paneLabels();
    const compared = schemaRows().filter((row) => panes.has(row.id));
    expect(panes.size).toBeGreaterThan(50);
    expect(compared.length).toBeGreaterThan(50);
  });
});
