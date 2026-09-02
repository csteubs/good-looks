// The documentation the app ships really parses, and really contains the
// sections the app points at.
//
// WHAT FAILS WITHOUT THIS. `docs/MCP-GUIDE.md` is one file with two readers:
// people reading the repo, and the Documentation pane, which renders a parsed
// subset of markdown (`renderer/lib/doc-blocks.ts`). Both failure modes are
// silent from the writer's side:
//
//   • A construct outside the subset — an ordered list, a nested bullet, an
//     image — is written, reviewed and merged as ordinary markdown. The parser
//     throws at module scope, which in the renderer means a BLANK SETTINGS
//     WINDOW and a clean main log. Nothing else in the toolchain reads a `.md`.
//   • A heading is renamed. It still renders; the Help menu item that
//     deep-links its slug now resolves to nothing and lands the user at the top
//     of the document with no explanation.
//
// So this parses every shipped doc for real, and asserts the slugs the app
// links to are still there. Pure logic and no `@shell/backend`, so it runs
// under tsx.
//
//   npm run check:docs-blocks

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DocParseError,
  REQUIRED_TOPIC_SLUGS,
  blockText,
  parseDoc,
  parseInline,
  slugify,
} from "../../../renderer/lib/doc-blocks.js";

const root = process.cwd();

/** Every doc the renderer bundles. Adding one here and forgetting to import it
 *  is harmless; importing one and forgetting to list it is what this catches. */
const SHIPPED_DOCS = ["docs/MCP-GUIDE.md", "docs/CI-GUIDE.md", "docs/POPUPS-GUIDE.md"];

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ── Every shipped doc parses, and says something ─────────────────────

/** slug -> the docs that define it. Filled by the loop, read by the two blocks
 *  below, which both ask questions no single document can answer. */
const slugOwners = new Map<string, string[]>();

for (const rel of SHIPPED_DOCS) {
  const src = readFileSync(join(root, rel), "utf-8");

  let page;
  try {
    page = parseDoc(src);
  } catch (err) {
    failures++;
    const where = err instanceof DocParseError ? ` — ${err.message}` : ` — ${String(err)}`;
    console.error(
      `FAIL ${rel} uses markdown the Documentation pane cannot render${where}\n` +
        "     Rewrite that line, or teach renderer/lib/doc-blocks.ts the construct.",
    );
    continue;
  }

  assert(page.title.length > 0, `${rel} has a title`);
  assert(page.topics.length >= 3, `${rel} has topics to navigate (${page.topics.length})`);

  // A topic that parsed to nothing renders as a heading over blank space. That
  // reads as a bug in the app rather than as an empty section in the source.
  const empty = page.topics.filter((t) => blockText(t.blocks).trim().length === 0);
  assert(
    empty.length === 0,
    empty.length === 0
      ? `${rel} has no empty topics`
      : `${rel} topics with no content: ${empty.map((t) => t.slug).join(", ")}`,
  );

  for (const topic of page.topics) {
    const seen = slugOwners.get(topic.slug);
    if (seen === undefined) slugOwners.set(topic.slug, [rel]);
    else seen.push(rel);
  }
}

// ── Slugs are unique across documents, not within one ────────────────

{
  // A slug is the row id the settings search indexes a topic under, the React
  // key the topic list renders it with, and the segment
  // `/settings/documentation/$topic` carries. None of the three is scoped by
  // document, so two documents that both end in "See also" collide in all
  // three — and the visible symptom is a Help menu item opening the wrong
  // document's section. Caught here because nothing else looks across files.
  const collisions = [...slugOwners.entries()].filter(([, owners]) => owners.length > 1);
  assert(
    collisions.length === 0,
    collisions.length === 0
      ? `topic slugs are unique across the ${SHIPPED_DOCS.length} shipped documents`
      : `the same slug in more than one document: ${collisions
          .map(([slug, owners]) => `${slug} (${owners.join(", ")})`)
          .join("; ")}\n` +
          "     Rename one of the headings — a slug names a topic, not a document plus a topic.",
  );
}

// ── Every topic the app promises to keep is somewhere ────────────────

{
  // Across the union, not per document. Each doc carries its own topics, and
  // asking every doc for every linked slug would fail the moment there were two.
  const all = [...slugOwners.keys()];
  const missing = REQUIRED_TOPIC_SLUGS.filter((s) => all.indexOf(s) === -1);
  assert(
    missing.length === 0,
    missing.length === 0
      ? "every topic the app deep-links still exists"
      : `topics the Help menu links to are missing: ${missing.join(", ")}\n` +
          `     Present: ${all.join(", ")}\n` +
          "     Either restore the heading or update REQUIRED_TOPIC_SLUGS and the menu.",
  );
}

// ── Every topic the Help menu links to is a topic ────────────────────

{
  // SOURCE-LEVEL, and it has to be: the menu is built in the main process from
  // string literals, and nothing type-checks a slug. `REQUIRED_TOPIC_SLUGS`
  // above is the list the app PROMISES to keep; this is the list it actually
  // uses, and the two drifting apart is how a menu item silently opens the top
  // of the document instead of the section it names.
  const menu = readFileSync(join(root, "main/index.ts"), "utf-8");
  const linked = [...menu.matchAll(/openSettingsPane\("documentation\/([a-z0-9-]+)"\)/g)].map(
    (m) => m[1],
  );
  assert(linked.length > 0, `the Help menu deep-links topics (${linked.length})`);

  const slugs = SHIPPED_DOCS.flatMap((rel) =>
    parseDoc(readFileSync(join(root, rel), "utf-8")).topics.map((t) => t.slug),
  );
  const broken = linked.filter((s) => slugs.indexOf(s) === -1);
  assert(
    broken.length === 0,
    broken.length === 0
      ? "every Help menu item names a topic that exists"
      : `Help menu items pointing at nothing: ${broken.join(", ")}`,
  );

  const unguarded = linked.filter((s) => (REQUIRED_TOPIC_SLUGS as readonly string[]).indexOf(s) === -1);
  assert(
    unguarded.length === 0,
    unguarded.length === 0
      ? "every linked topic is also in REQUIRED_TOPIC_SLUGS"
      : `linked but not guarded — add to REQUIRED_TOPIC_SLUGS: ${unguarded.join(", ")}`,
  );
}

// ── The parser's own contract ────────────────────────────────────────

{
  // Marks combine. The guide contains both of these shapes, and a parser that
  // handled only one would drop the other's text entirely.
  const bolded = parseInline("**`triage_run`** is the one");
  assert(
    bolded[0].code === true && bolded[0].strong === true && bolded[0].text === "triage_run",
    "code inside bold keeps both marks",
  );

  const linked = parseInline("see [`mcp/README.md`](../mcp/README.md) for more");
  const link = linked.filter((s) => s.href !== undefined)[0];
  assert(
    link !== undefined && link.href === "../mcp/README.md" && link.code === true,
    "code inside a link keeps the href",
  );
  assert(
    linked.map((s) => s.text).join("") === "see mcp/README.md for more",
    "the text around a link survives it",
  );

  // Backticks win, so a document about command lines can show asterisks.
  const literal = parseInline("`**not bold**`");
  assert(
    literal.length === 1 && literal[0].text === "**not bold**" && !literal[0].strong,
    "markup inside code is literal",
  );

  // An unmatched delimiter is prose, not an error. A strict parser that refused
  // a paragraph over a stray asterisk would be turned off within a week.
  const stray = parseInline("2 * 3 and a [bracket");
  assert(
    stray.map((s) => s.text).join("") === "2 * 3 and a [bracket",
    "an unmatched delimiter stays literal",
  );
}

{
  // Numbering is a property of the document's reading order, not of the link.
  assert(slugify("5. Linear, GitHub and Slack") === "linear-github-and-slack", "slug drops numbering");
  assert(slugify("What it *deliberately* will not do").length > 0, "slug survives punctuation");
}

{
  // The refusals. Each of these is a construct someone will write by reflex,
  // and each renders as nothing without a guard.
  const cases: Array<[string, string]> = [
    ["# T\n\n## S\n\n1. one\n2. two\n", "ordered list"],
    ["# T\n\n## S\n\n- one\n  - nested\n", "nested list"],
    ["# T\n\n## S\n\n* star bullet\n", "asterisk bullet"],
    ["# T\n\n## S\n\n![shot](a.png)\n", "image"],
    ["# T\n\n## S\n\n<div>hi</div>\n", "raw HTML"],
    ["# T\n\n## S\n\n#### too deep\n", "h4"],
    ["# T\n\n## S\n\n| a | b |\n| x | y |\n", "table with no divider"],
    ["# T\n\n## S\n\n```\nunclosed\n", "unterminated fence"],
  ];
  for (const [src, label] of cases) {
    let threw = false;
    try {
      parseDoc(src);
    } catch (err) {
      threw = err instanceof DocParseError;
    }
    assert(threw, `refuses ${label}`);
  }
}

{
  // And the happy path really produces the blocks the pane switches on — a
  // parser that silently dropped tables would pass every refusal above.
  const page = parseDoc(
    "# Title\n\nIntro line.\n\n## First\n\nBody **bold**.\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> quoted\n\n```bash\nrun me\n```\n\n### Sub\n\n---\n",
  );
  const kinds = page.topics[0].blocks.map((b) => b.kind);
  for (const kind of ["paragraph", "list", "table", "quote", "code", "heading", "rule"]) {
    assert(kinds.indexOf(kind as (typeof kinds)[number]) !== -1, `parses a ${kind} block`);
  }
  assert(page.intro.length === 1, "content above the first `##` becomes the intro");
  assert(blockText(page.topics[0].blocks).includes("run me"), "blockText reaches code and cells");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall docs-blocks checks passed");
