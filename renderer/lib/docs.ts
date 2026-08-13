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

/** Ids of the documents the pane can show. One today; the pane is a list, not a
 *  special case, so a second costs a line here and nothing in the UI. */
export type DocId = "mcp";

export interface AppDoc {
  id: DocId;
  /** The rail label. Short — the page's own title is the heading. */
  label: string;
  page: DocPage;
}

export const APP_DOCS: readonly AppDoc[] = [
  { id: "mcp", label: "AI assistants (MCP)", page: parseDoc(mcpGuideSource) },
];

export const MCP_GUIDE = APP_DOCS[0].page;

/** The row id a topic is indexed and filtered under. Prefixed so it cannot
 *  collide with a setting row's id, which shares that namespace. */
export function docRowId(slug: string): string {
  return `doc-${slug}`;
}

/** The slug a row id refers back to. */
export function docSlugFromRowId(id: string): string {
  return id.startsWith("doc-") ? id.slice(4) : id;
}

export { slugify };
