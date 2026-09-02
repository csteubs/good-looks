// The documents the app ships, parsed once.
//
// `?raw` inlines the markdown into the renderer bundle at build time. That is
// what makes the packaged app work: `build.files` ships `build/**` and
// `package.json`, and NOT `docs/` — a pane that read the file from disk would
// work in dev and show nothing in the `.app`, which is the worst of the two
// failure orders.
//
// Parsed at module scope, deliberately. A malformed document is then a hard
// failure the moment the Settings window loads, which `check:docs-blocks`
// turns into a red gate long before that — rather than a section that renders
// as blank space for whoever happens to open it.

import { parseDoc, slugify, type DocPage } from "./doc-blocks";
import mcpGuideSource from "../../docs/MCP-GUIDE.md?raw";
import ciGuideSource from "../../docs/CI-GUIDE.md?raw";
import popupsGuideSource from "../../docs/POPUPS-GUIDE.md?raw";

/** Ids of the documents the pane can show. The pane is a list rather than a
 *  special case, so a further document costs a line here and a Help menu item.
 *
 *  SLUGS ARE UNIQUE ACROSS DOCUMENTS, not within one. A topic slug is the row
 *  id the settings search indexes it under (`docRowId`), the key the topic list
 *  renders it with, and the segment `/settings/documentation/$topic` carries —
 *  so two documents both ending in "See also" would collide in all three, and
 *  the visible symptom is a Help link that opens the wrong document.
 *  `check:docs-blocks` asserts it. */
export type DocId = "mcp" | "ci" | "popups";

export interface AppDoc {
  id: DocId;
  /** The rail label. Short — the page's own title is the heading. */
  label: string;
  page: DocPage;
}

export const APP_DOCS: readonly AppDoc[] = [
  { id: "mcp", label: "AI assistants (MCP)", page: parseDoc(mcpGuideSource) },
  { id: "ci", label: "Running tests without the app", page: parseDoc(ciGuideSource) },
  { id: "popups", label: "Pop-ups and dialogs", page: parseDoc(popupsGuideSource) },
];

export const MCP_GUIDE = APP_DOCS[0].page;
export const CI_GUIDE = APP_DOCS[1].page;
export const POPUPS_GUIDE = APP_DOCS[2].page;

/** The document a topic slug belongs to, or null when nothing ships it.
 *
 *  The pane needs this to title a topic with ITS OWN document rather than with
 *  the first one in the list — which is what it did while there was only one,
 *  and which would have labelled every CI topic as the MCP guide the day a
 *  second arrived. */
export function docForSlug(slug: string): AppDoc | null {
  for (const doc of APP_DOCS) {
    if (doc.page.topics.some((t) => t.slug === slug)) return doc;
  }
  return null;
}

/** The row id a topic is indexed and filtered under. Prefixed so it cannot
 *  collide with a setting row's id, which shares that namespace. */
export function docRowId(slug: string): string {
  return `doc-${slug}`;
}

/** The slug a row id refers back to. */
export function docSlugFromRowId(id: string): string {
  return id.startsWith("doc-") ? id.slice(4) : id;
}

/**
 * A topic's heading, from its slug — or null when no shipped document has one.
 *
 * The null is the point. `/settings/documentation/$topic` puts a slug in the
 * address, so a breadcrumb built from it would otherwise title-case whatever
 * arrived and confidently name a section that does not exist. Same rule as
 * `categoryMeta` in stats-categories.ts: an unknown segment gets no crumb of
 * its own, and the screen below says what happened.
 */
export function topicTitle(slug: string): string | null {
  for (const doc of APP_DOCS) {
    const topic = doc.page.topics.find((t) => t.slug === slug);
    if (topic) return topic.title;
  }
  return null;
}

export { slugify };
