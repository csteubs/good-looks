import * as React from "react";

/**
 * Read-only IDE-style viewer for a Playwright/TS test script.
 *
 * Renders a line-numbered gutter + lightweight syntax highlighting (keywords,
 * strings, comments, numbers, decorators) using only semantic design tokens so
 * it adapts to light/dark. No deps — a small regex tokenizer, good enough for
 * the spec files this app produces.
 */

const KEYWORDS = new Set([
  "import",
  "from",
  "export",
  "default",
  "const",
  "let",
  "var",
  "function",
  "async",
  "await",
  "return",
  "if",
  "else",
  "for",
  "while",
  "of",
  "in",
  "new",
  "class",
  "extends",
  "super",
  "this",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "instanceof",
  "void",
  "delete",
  "yield",
  "switch",
  "case",
  "break",
  "continue",
  "do",
  "interface",
  "type",
  "enum",
  "as",
  "public",
  "private",
  "readonly",
  "static",
  "get",
  "set",
]);

const LITERALS = new Set(["true", "false", "null", "undefined", "this"]);

type Token = { type: "plain" | "kw" | "lit" | "str" | "num" | "comment" | "decorator" | "punct"; value: string };

/**
 * Tokenize a single line. Multiline constructs (block comments, template
 * literals) are tracked across lines via the carried state so each line can be
 * rendered independently (keeps React keys stable + line numbers simple).
 */
function tokenizeLine(
  line: string,
  state: { inBlockComment: boolean; inTemplate: boolean },
): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = line.length;

  const push = (type: Token["type"], value: string) => {
    if (!value) return;
    const last = tokens[tokens.length - 1];
    if (last && last.type === type && last.type !== "plain") last.value += value;
    else tokens.push({ type, value });
  };
  const pushPlain = (value: string) => push("plain", value);

  while (i < n) {
    // Continue a block comment from a previous line.
    if (state.inBlockComment) {
      const end = line.indexOf("*/", i);
      if (end === -1) {
        push("comment", line.slice(i));
        break;
      }
      push("comment", line.slice(i, end + 2));
      i = end + 2;
      state.inBlockComment = false;
      continue;
    }

    // Continue a template literal from a previous line.
    if (state.inTemplate) {
      const end = findTemplateEnd(line, i);
      if (end === -1) {
        push("str", line.slice(i));
        break;
      }
      push("str", line.slice(i, end + 1));
      i = end + 1;
      state.inTemplate = false;
      continue;
    }

    const rest = line.slice(i);
    const ch = line[i];

    // Line comment
    if (ch === "/" && line[i + 1] === "/") {
      push("comment", rest);
      break;
    }
    // Block comment start
    if (ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        push("comment", line.slice(i));
        state.inBlockComment = true;
        break;
      }
      push("comment", line.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    // Decorator / @-annotation
    if (ch === "@" && /[@A-Za-z_$]/.test(line[i + 1] ?? "")) {
      const m = rest.match(/^@[A-Za-z_$][\w$.-]*/);
      if (m) {
        push("decorator", m[0]);
        i += m[0].length;
        continue;
      }
    }
    // Strings: ", ', `
    if (ch === '"' || ch === "'" || ch === "`") {
      if (ch === "`") {
        const end = findTemplateEnd(line, i + 1);
        if (end === -1) {
          push("str", line.slice(i));
          state.inTemplate = true;
          break;
        }
        push("str", line.slice(i, end + 1));
        i = end + 1;
        continue;
      }
      const end = findStringEnd(line, i + 1, ch);
      if (end === -1) {
        push("str", line.slice(i));
        break;
      }
      push("str", line.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    // Numbers
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(line[i + 1] ?? ""))) {
      const m = rest.match(/^(0x[0-9a-fA-F]+|\d+\.?\d*(?:e[+-]?\d+)?)/);
      if (m) {
        push("num", m[0]);
        i += m[0].length;
        continue;
      }
    }
    // Identifiers / keywords
    if (/[A-Za-z_$]/.test(ch)) {
      const m = rest.match(/^[A-Za-z_$][\w$]*/);
      if (m) {
        const word = m[0];
        if (KEYWORDS.has(word)) push("kw", word);
        else if (LITERALS.has(word)) push("lit", word);
        else pushPlain(word);
        i += word.length;
        continue;
      }
    }
    // Punctuation cluster
    if (/[{}[\]();,.<>:?=+\-*/%&|^!~]/.test(ch)) {
      const m = rest.match(/^[{}[\]();,.<>:?=+\-*/%&|^!~]+/);
      if (m) {
        push("punct", m[0]);
        i += m[0].length;
        continue;
      }
    }
    pushPlain(ch);
    i += 1;
  }

  return tokens.length ? tokens : [{ type: "plain", value: "" }];
}

function findStringEnd(line: string, start: number, quote: string): number {
  let i = start;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === quote) return i;
    i += 1;
  }
  return -1;
}

// Find the closing backtick, ignoring ${...} interpolations (treat as string).
function findTemplateEnd(line: string, start: number): number {
  let i = start;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === "`") return i;
    if (line[i] === "$" && line[i + 1] === "{") {
      // Skip interpolation — find matching }
      let depth = 1;
      i += 2;
      while (i < line.length && depth > 0) {
        if (line[i] === "{") depth += 1;
        else if (line[i] === "}") depth -= 1;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return -1;
}

// Use the design system's dedicated syntax-token CSS variables (they adapt to
// light/dark and are purpose-built for code, unlike the status text tokens).
const TOKEN_CLASS: Record<Token["type"], string> = {
  plain: "",
  kw: "text-[var(--color-token-primary)]",
  lit: "text-[var(--color-token-secondary)]",
  str: "text-[var(--color-token-string)]",
  num: "text-[var(--color-token-highlight)]",
  comment: "text-[var(--color-token-tertiary)] italic",
  decorator: "text-[var(--color-token-highlight)]",
  punct: "text-[var(--color-token-tertiary)]",
};

export function ScriptView({ code }: { code: string }) {
  const lines = React.useMemo(() => (code ? code.split("\n") : []), [code]);
  const gutterWidth = String(lines.length).length;

  // Tokenize all lines once, threading multiline block-comment / template
  // literal state across lines so each rendered line is self-contained.
  const rendered = React.useMemo(() => {
    const state = { inBlockComment: false, inTemplate: false };
    return lines.map((line) => tokenizeLine(line, state));
  }, [lines]);

  return (
    <div className="text-small-mono min-h-0 flex-1 overflow-auto">
      <div className="min-w-full table">
        {rendered.map((tokens, idx) => (
          <div key={idx} className="table-row group">
            <div
              className="table-cell select-none px-3 text-right align-top text-[var(--color-token-tertiary)] group-hover:text-[var(--color-token-secondary)]"
              style={{ minWidth: `${gutterWidth + 2}ch` }}
              aria-hidden
            >
              {idx + 1}
            </div>
            <code className="table-cell whitespace-pre px-4 align-top text-primary">
              {tokens.map((t, j) =>
                t.type === "plain" ? (
                  <React.Fragment key={j}>{t.value}</React.Fragment>
                ) : (
                  <span key={j} className={TOKEN_CLASS[t.type]}>
                    {t.value}
                  </span>
                )
              )}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}
