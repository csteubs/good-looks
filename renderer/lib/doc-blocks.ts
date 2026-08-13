// The markdown the Documentation pane renders, as data.
//
// WHY THIS EXISTS AT ALL. The user-facing docs are markdown in `docs/`, because
// that is where they are read from the repo, reviewed in a diff, and linked
// from README. The app needs the same words. Two copies of a document is two
// documents: the file is right the day it is written and silently wrong
// afterwards, and nothing in the toolchain can see the drift.
//
// So there is one file and this parser. `renderer/lib/docs.ts` imports the
// markdown with Vite's `?raw`, which inlines it into the renderer bundle — that
// also solves packaging, since `build.files` ships `build/**` and NOT `docs/`.
//
// NO RUNTIME DEPENDENCY, and that is deliberate rather than frugal. A general
// markdown renderer accepts everything and renders whatever it likes; this
// takes a SUBSET and THROWS on anything outside it. `check:docs-blocks` parses
// every shipped doc in the gate, so writing a construct the pane cannot draw is
// a red build rather than a section that silently renders as nothing — which is
// this repo's most-repeated failure (a class that does not exist emits nothing
// and throws nothing; see CLAUDE.md).
//
// The subset is: `#` title, `##`/`###` headings, paragraphs, `-` lists, fenced
// code, `|` tables, `>` quotes, `---` rules, and inline `**strong**`, `*em*`,
// `` `code` `` and `[label](href)`. Nested lists, ordered lists, images and raw
// HTML are refused — not because they are hard, but because a doc that uses one
// should be a conversation rather than a silent half-rendering.

/** A run of text with the marks that apply to it. Marks COMBINE — the guide
 *  contains ``**`triage_run`**`` and ``[`mcp/README.md`](…)`` — so this is a
 *  flat span with flags rather than a tree of one node type per mark. */
export interface DocSpan {
  text: string;
  strong?: true;
  em?: true;
  code?: true;
  /** Set when the span came from `[label](href)`. */
  href?: string;
}

export type DocBlock =
  | { kind: "heading"; text: string; slug: string }
  | { kind: "paragraph"; spans: DocSpan[] }
  | { kind: "list"; items: DocSpan[][] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; spans: DocSpan[] }
  | { kind: "table"; head: DocSpan[][]; rows: DocSpan[][][] }
  | { kind: "rule" };

export interface DocTopic {
  /** URL-safe, derived from the heading with any leading "N. " dropped. This is
   *  what a Help-menu item deep-links to, so it is part of the app's contract —
   *  see `REQUIRED_TOPIC_SLUGS`. */
  slug: string;
  title: string;
  blocks: DocBlock[];
}

export interface DocPage {
  title: string;
  /** Everything above the first `##`. */
  intro: DocBlock[];
  topics: DocTopic[];
}

export class DocParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${line})`);
    this.name = "DocParseError";
  }
}

/**
 * Topic slugs something in the app points AT.
 *
 * The Help menu deep-links these, and a deep link that resolves to nothing
 * lands the user on the top of the document with no explanation — the exact
 * silent failure this file exists to prevent, one level up. `check:docs-blocks`
 * asserts every one of them is a real topic, so renaming a heading in
 * `docs/MCP-GUIDE.md` fails the gate instead of quietly breaking a menu item.
 */
export const REQUIRED_TOPIC_SLUGS = [
  "what-it-is",
  "setup",
  "what-you-can-ask-for",
  "linear-github-and-slack",
  "troubleshooting",
] as const;

/** Heading → slug. Drops a leading "3. " so the section numbering in the
 *  markdown can change without changing what the menu links to. */
export function slugify(heading: string): string {
  return heading
    .replace(/^\d+\.\s+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Heading text as the pane shows it: the numbering belongs to the document's
 *  reading order, not to a sidebar of topics. */
function topicTitle(heading: string): string {
  return heading.replace(/^\d+\.\s+/, "").trim();
}

/**
 * Inline marks, innermost-last.
 *
 * Code is matched FIRST and never recurses: everything between backticks is
 * literal, so `` `**not bold**` `` renders the asterisks, which is what a
 * document about command lines needs. Every other mark recurses with the
 * current style carried down, which is what makes marks combine.
 *
 * An unmatched delimiter is literal text rather than an error. Prose contains
 * stray asterisks and brackets, and refusing to render a paragraph over one
 * would make the strict parser a liability instead of a guard.
 */
export function parseInline(src: string, style: Omit<DocSpan, "text"> = {}): DocSpan[] {
  const out: DocSpan[] = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf.length > 0) {
      out.push({ text: buf, ...style });
      buf = "";
    }
  };

  while (i < src.length) {
    const rest = src.slice(i);

    if (rest.startsWith("`")) {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ text: src.slice(i + 1, end), ...style, code: true });
        i = end + 1;
        continue;
      }
    }

    if (rest.startsWith("**")) {
      const end = src.indexOf("**", i + 2);
      if (end > i) {
        flush();
        out.push(...parseInline(src.slice(i + 2, end), { ...style, strong: true }));
        i = end + 2;
        continue;
      }
    }

    if (rest.startsWith("*")) {
      const end = src.indexOf("*", i + 1);
      if (end > i) {
        flush();
        out.push(...parseInline(src.slice(i + 1, end), { ...style, em: true }));
        i = end + 1;
        continue;
      }
    }

    if (rest.startsWith("[")) {
      const m = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
      if (m) {
        flush();
        out.push(...parseInline(m[1], { ...style, href: m[2] }));
        i += m[0].length;
        continue;
      }
    }

    buf += src[i];
    i += 1;
  }

  flush();
  return out;
}

/** Cells of one `| a | b |` row, without the outer pipes. */
function tableCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isTableDivider(line: string | undefined): boolean {
  return line !== undefined && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
}

/** Constructs the pane cannot draw. Refused with the line number, because the
 *  author is looking at the markdown when this fires. */
function refuseUnsupported(line: string, n: number): void {
  if (/^#{4,}\s/.test(line)) {
    throw new DocParseError("headings deeper than ### are not rendered", n);
  }
  if (/^\s*\d+[.)]\s/.test(line)) {
    throw new DocParseError("ordered lists are not rendered — use a table or `-`", n);
  }
  if (/^\s+[-*+]\s/.test(line)) {
    throw new DocParseError("nested lists are not rendered", n);
  }
  if (/^[*+]\s/.test(line)) {
    throw new DocParseError("bullets must be written with `-`", n);
  }
  if (/^!\[/.test(line)) {
    throw new DocParseError("images are not rendered", n);
  }
  if (/^<[a-zA-Z/]/.test(line)) {
    throw new DocParseError("raw HTML is not rendered", n);
  }
}

/**
 * Markdown → one page of topics.
 *
 * Topics are the `##` sections. Everything above the first one is `intro`, so a
 * document keeps its opening paragraph without that paragraph having to invent
 * a heading to live under.
 */
export function parseDoc(src: string): DocPage {
  const lines = src.replace(/\r\n/g, "\n").split("\n");

  let title = "";
  const intro: DocBlock[] = [];
  const topics: DocTopic[] = [];

  /** Where blocks land: the current topic, or the intro before the first one. */
  let sink: DocBlock[] = intro;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const n = i + 1;

    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    // Fenced code first: everything inside is literal, including lines that
    // would otherwise look like headings or tables.
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i >= lines.length) throw new DocParseError("unterminated code fence", n);
      i += 1;
      sink.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    refuseUnsupported(line, n);

    if (/^#\s/.test(line)) {
      if (title.length > 0) {
        throw new DocParseError("a second `#` title — use `##` for sections", n);
      }
      title = line.slice(2).trim();
      i += 1;
      continue;
    }

    if (/^##\s/.test(line)) {
      const heading = line.slice(3).trim();
      const topic: DocTopic = { slug: slugify(heading), title: topicTitle(heading), blocks: [] };
      topics.push(topic);
      sink = topic.blocks;
      i += 1;
      continue;
    }

    if (/^###\s/.test(line)) {
      const heading = line.slice(4).trim();
      sink.push({ kind: "heading", text: heading, slug: slugify(heading) });
      i += 1;
      continue;
    }

    if (/^(---+|___+|\*\*\*+)\s*$/.test(line)) {
      sink.push({ kind: "rule" });
      i += 1;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      if (!isTableDivider(lines[i + 1])) {
        throw new DocParseError("a table needs a `| --- |` divider under its header", n);
      }
      const head = tableCells(line).map((c) => parseInline(c));
      const rows: DocSpan[][][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(tableCells(lines[i]).map((c) => parseInline(c)));
        i += 1;
      }
      sink.push({ kind: "table", head, rows });
      continue;
    }

    if (/^-\s/.test(line)) {
      const items: DocSpan[][] = [];
      while (i < lines.length && /^-\s/.test(lines[i])) {
        const parts = [lines[i].slice(2).trim()];
        // A continuation line is indented and is not itself a bullet — this is
        // how the guide wraps a long item.
        i += 1;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i])) {
          parts.push(lines[i].trim());
          i += 1;
        }
        items.push(parseInline(parts.join(" ")));
      }
      sink.push({ kind: "list", items });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        parts.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      sink.push({ kind: "quote", spans: parseInline(parts.join(" ").trim()) });
      continue;
    }

    // Anything else is a paragraph, running to the next blank line.
    const parts: string[] = [];
    while (i < lines.length && lines[i].trim().length > 0 && !/^(#{1,3}\s|```|>|-\s|\s*\|)/.test(lines[i])) {
      refuseUnsupported(lines[i], i + 1);
      parts.push(lines[i].trim());
      i += 1;
    }
    sink.push({ kind: "paragraph", spans: parseInline(parts.join(" ")) });
  }

  if (title.length === 0) throw new DocParseError("no `#` title", 1);
  if (topics.length === 0) throw new DocParseError("no `##` sections to make topics of", 1);

  const seen = new Set<string>();
  for (const topic of topics) {
    if (topic.slug.length === 0) throw new DocParseError(`heading "${topic.title}" has no slug`, 1);
    if (seen.has(topic.slug)) {
      throw new DocParseError(`two sections both slug to "${topic.slug}"`, 1);
    }
    seen.add(topic.slug);
  }

  return { title, intro, topics };
}

/** The topic a slug names, or undefined. Unknown slugs are the caller's problem
 *  to fall back from — same contract as `paneById`. */
export function topicBySlug(page: DocPage, slug: string): DocTopic | undefined {
  return page.topics.filter((t) => t.slug === slug)[0];
}

/** Every span's text, joined. What search and the tests match on, so a topic is
 *  findable by words in its body rather than only by its heading. */
export function blockText(blocks: readonly DocBlock[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        out.push(block.text);
        break;
      case "paragraph":
      case "quote":
        out.push(block.spans.map((s) => s.text).join(""));
        break;
      case "list":
        for (const item of block.items) out.push(item.map((s) => s.text).join(""));
        break;
      case "code":
        out.push(block.text);
        break;
      case "table":
        for (const cell of block.head) out.push(cell.map((s) => s.text).join(""));
        for (const row of block.rows) {
          for (const cell of row) out.push(cell.map((s) => s.text).join(""));
        }
        break;
      case "rule":
        break;
    }
  }
  return out.join(" ");
}
