// How a check READS source, so that only one thing has to be right.
//
// Both egress checks scan shipped source for a shape that must not appear, and
// both were wrong in the same way, three months apart. The obvious pipeline —
// strip `/* … */` across the whole file, then walk the lines — is what anyone
// writes first, and it is wrong for any file holding `/*` inside a string or a
// line comment. That glob opens a comment span running to the next `*/`
// anywhere in the file, and everything between is gone before the scan reads
// it.
//
// It cost `check:main-egress` 101 lines across four files, and one of those
// windows sits squarely on the block where the app attaches a Shopify signature
// to an outgoing request. It cost `check:renderer-egress` five lines across two
// — small, but that check exists because a favicon fetch sent Google the
// hostname of every site under test and nobody noticed for months, so a URL
// inside one of those windows would have passed it. None was there. The window
// also MOVES, whenever anyone writes a glob, an XPath or a CSS path into a
// string, so "small today" is not a property anyone can rely on.
//
// Measure this by DIFFING THE TWO READERS, never by asking whether a blanked
// line looks like a comment: a JSX block comment's continuation lines start
// with neither `//` nor `*`, so that test counts them as lost code and inflated
// both figures about threefold when they were first published.
//
// So the reader lives here, once. Two spellings of this is how one of them
// drifts back, and the second one drifted for the whole life of the first.
//
// Not a `*.check.ts`: it is a library, it registers no npm script, and
// `check:repo-hygiene` would ask why a check was defined and never run.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every `.ts`/`.tsx` file under `dir`, skipping `node_modules` and dotfiles. */
export function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}


export interface Scan {
  /** As written, for reporting: an offender quoted with its strings blanked
   *  out reads as a different bug than the one it is. */
  raw: string[];
  /** Comments and string contents gone. What the rules below match. */
  code: string[];
  /** Comments gone, string contents KEPT — for the two questions that live
   *  inside a literal: `globalThis["fetch"](url)`, and which module a file
   *  imports. Blanking would hide both. */
  quoted: string[];
}

/**
 * One file, read three ways, all the same length and the same line count.
 *
 * ORDER IS THE WHOLE THING HERE, and getting it wrong is not cosmetic. The
 * obvious pipeline — strip `/* … *\/` across the file, then handle each line —
 * is what `check:renderer-egress` does, and it is wrong for any file that
 * contains `/*` inside a string or a line comment. `recorder-service.ts:2493`
 * registers `onBeforeSendHeaders({ urls: ["*://*\/*"] })`; that glob opens a
 * block-comment span that runs to the next `*\/` in the file and blanks 77
 * lines of real code — the block where this app attaches the Shopify signature
 * to an outgoing request, of all of them. Measured across shipped `main/**`,
 * four files lost 101 lines that way, and the window MOVES whenever anyone
 * writes a glob, an XPath or a CSS path into a string.
 *
 * So: per line first (blank the contents of string literals, then the line
 * comment), and only then find block spans in the result, where a `/*` inside
 * a literal can no longer open one. Every step preserves length and newlines,
 * so the spans found in the masked text can be applied at the same offsets to
 * the literal-preserving text, and one pass answers both questions.
 *
 * Two limits, both stated rather than hidden. A template literal spanning
 * lines keeps its contents, because tracking string state across lines is a
 * parser and this is a scan — the consequence is a false POSITIVE, which the
 * line hatch above answers. And an UNTERMINATED `/*` blanks nothing, which is
 * a false positive too, and does not compile.
 */
export function scanFile(file: string): Scan {
  const spaces = (n: number): string => " ".repeat(Math.max(0, n));
  const blankLiterals = (line: string): string =>
    line
      .replace(/`(?:\\.|[^`\\])*`/g, (m) => `\`${spaces(m.length - 2)}\``)
      .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => `"${spaces(m.length - 2)}"`)
      .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => `'${spaces(m.length - 2)}'`);
  // Length-preserving, and only where `//` is not preceded by a colon, or the
  // pattern eats the scheme of every URL on the line.
  const blankLineComment = (line: string): string =>
    line.replace(/(^|[^:])(\/\/.*)$/, (_m, before: string, comment: string) => before + spaces(comment.length));

  const source = readFileSync(file, "utf-8");
  const raw = source.split("\n");
  const masked = raw.map((line) => blankLineComment(blankLiterals(line)));
  const kept = raw.map(blankLineComment);

  const maskedText = masked.join("\n");
  const codeChars = [...maskedText];
  const quotedChars = [...kept.join("\n")];
  for (const match of maskedText.matchAll(/\/\*[\s\S]*?\*\//g)) {
    const start = match.index ?? 0;
    for (let i = start; i < start + match[0].length; i++) {
      if (codeChars[i] !== "\n") codeChars[i] = " ";
      if (quotedChars[i] !== "\n") quotedChars[i] = " ";
    }
  }
  return { raw, code: codeChars.join("").split("\n"), quoted: quotedChars.join("").split("\n") };
}

/** The scannable text of one file as a single string, for the pins that ask
 *  whether something is present rather than where. */
export function codeOf(file: string): string {
  return scanFile(file).code.join("\n");
}

/**
 * The line-scoped escape hatch: `egress-ok: <reason>` in a comment on the line.
 *
 * The file-scoped allowlists below are for a file that OWNS a rule's exception.
 * A single line that needs one is a different thing, and giving it the same
 * remedy would be the worse outcome: `main/recorder/capture-script.ts` holds
 * page-world source in a multi-line template, where the global `fetch` is the
 * PAGE's and nothing to do with this app's proxy — and exempting that whole
 * file to permit one such line would silently take the capture boundary, which
 * CLAUDE.md calls a security boundary, out of both rules forever.
 *
 * The reason is required, for the reason the allowlists demand one: what makes
 * an exception safe is that somebody wrote down why.
 */
export const HATCH = /egress-ok:\s*\S/;

/** Every offending line in one file under one rule, hatch and comments
 *  respected, reported as it was written. */
export function offendersIn(
  file: string,
  rel: string,
  hit: (code: string, quoted: string) => boolean,
): string[] {
  const { raw, code, quoted } = scanFile(file);
  const out: string[] = [];
  code.forEach((line, i) => {
    if (!hit(line, quoted[i])) return;
    if (HATCH.test(raw[i] ?? "")) return;
    out.push(`${rel}:${i + 1} — ${(raw[i] ?? line).trim().slice(0, 78)}`);
  });
  return out;
}
