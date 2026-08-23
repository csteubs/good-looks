// The TypeScript language service behind the Script IDE, and the app's own
// inspections over its AST. PURE with respect to the app: it imports
// `typescript` and `node:path` and reads the filesystem through `ts.sys`, and
// nothing else — no `@shell/backend`, no IPC — so it runs the same in the utilityProcess
// (`child.ts`), under Vitest, and in `check:ts-service`.
//
// The editor's document is a VIRTUAL file placed beside the app's
// `node_modules`, so `import { test } from "@playwright/test"` resolves to the
// SAME `.d.ts` the bundled CLI ships with — the types the user sees are the
// types the run will use. The generated runtime helper (`./glaze-runtime.mjs`)
// is a second virtual file beside it, handed in as text, so a spec that
// imports a helper type-checks without the service knowing where the scripts
// directory is.
//
// Inspections are the app's rules, not ESLint's (DECISIONS 2026-08-23): each
// is a walk over the AST with the checker at hand, reports a span, and may
// offer ONE fix as text edits. They are opinions about Playwright tests as
// this app records them, which is why they live here and not in a lint
// config the user would have to maintain.

import * as nodePath from "node:path";
import ts from "typescript";

export interface TsSpan {
  from: number;
  to: number;
}

export interface TsDiagnostic extends TsSpan {
  message: string;
  severity: "error" | "warning" | "info";
  code: number;
}

export interface TsCompletion {
  label: string;
  /** TypeScript's kind string ("method", "property", "keyword", …). */
  kind: string;
  /** Lower sorts first; TypeScript's own sortText. */
  sortText: string;
  detail?: string;
}

export interface TsHover extends TsSpan {
  /** The signature or type, as TypeScript prints it. */
  text: string;
  documentation?: string;
}

import type { InspectionRule } from "../../../shared/inspections.mjs";
export type { InspectionRule } from "../../../shared/inspections.mjs";

export interface TextEdit extends TsSpan {
  text: string;
}

export interface Inspection extends TsSpan {
  rule: InspectionRule;
  severity: "error" | "warning" | "hint";
  message: string;
  fix?: { title: string; edits: TextEdit[] };
}

export interface TsServiceOptions {
  /** The node_modules that holds `@playwright/test` — the bundled CLI's tree. */
  nodeModules: string;
}

/** Hard cap on completions returned: the editor shows a list, not a dump. */
const MAX_COMPLETIONS = 200;

export const VIRTUAL_DIR = "__gl_editor__";
export const RUNTIME_FILE = "glaze-runtime.mjs";

export function createTsService(opts: TsServiceOptions) {
  const root = path(opts.nodeModules, "..");
  const dir = path(root, VIRTUAL_DIR);
  const files = new Map<string, { text: string; version: number }>();

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: [],
    strict: true,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    noEmit: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
  };

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (f) => String(files.get(f)?.version ?? 0),
    getScriptSnapshot: (f) => {
      const v = files.get(f);
      if (v) return ts.ScriptSnapshot.fromString(v.text);
      const text = ts.sys.readFile(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dir,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => files.has(f) || ts.sys.fileExists(f),
    readFile: (f) => files.get(f)?.text ?? ts.sys.readFile(f),
    readDirectory: ts.sys.readDirectory,
    directoryExists: (d) => d === dir || ts.sys.directoryExists(d),
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());

  function fileName(id: string): string {
    return path(dir, id.replace(/[^a-zA-Z0-9_.-]/g, "_") + ".spec.ts");
  }

  function ensureRuntime(text: string | undefined): void {
    if (text === undefined) return;
    const name = path(dir, RUNTIME_FILE);
    const cur = files.get(name);
    if (cur && cur.text === text) return;
    files.set(name, { text, version: (cur?.version ?? 0) + 1 });
  }

  return {
    /** Register or replace a document. `runtime` is the helper module's
     *  source when the spec imports it. */
    update(id: string, text: string, runtime?: string): void {
      ensureRuntime(runtime);
      const name = fileName(id);
      const cur = files.get(name);
      if (cur && cur.text === text) return;
      files.set(name, { text, version: (cur?.version ?? 0) + 1 });
    },

    close(id: string): void {
      files.delete(fileName(id));
    },

    diagnostics(id: string): TsDiagnostic[] {
      const name = fileName(id);
      if (!files.has(name)) return [];
      const all = [...service.getSyntacticDiagnostics(name), ...service.getSemanticDiagnostics(name)];
      return all
        .filter((d) => d.file?.fileName === name && typeof d.start === "number")
        .map((d) => ({
          from: d.start!,
          to: d.start! + Math.max(1, d.length ?? 1),
          message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
          severity: d.category === ts.DiagnosticCategory.Error ? "error" : d.category === ts.DiagnosticCategory.Warning ? "warning" : "info",
          code: d.code,
        }));
    },

    completions(id: string, offset: number): TsCompletion[] {
      const name = fileName(id);
      if (!files.has(name)) return [];
      const info = service.getCompletionsAtPosition(name, offset, {
        includeCompletionsForModuleExports: false,
        includeCompletionsWithInsertText: false,
      });
      if (!info) return [];
      return info.entries.slice(0, MAX_COMPLETIONS).map((e) => ({
        label: e.name,
        kind: e.kind,
        sortText: e.sortText,
        ...(e.kindModifiers ? { detail: e.kindModifiers } : {}),
      }));
    },

    hover(id: string, offset: number): TsHover | null {
      const name = fileName(id);
      if (!files.has(name)) return null;
      const q = service.getQuickInfoAtPosition(name, offset);
      if (!q) return null;
      const text = ts.displayPartsToString(q.displayParts);
      const documentation = ts.displayPartsToString(q.documentation);
      return {
        from: q.textSpan.start,
        to: q.textSpan.start + q.textSpan.length,
        text,
        ...(documentation ? { documentation } : {}),
      };
    },

    inspections(id: string, enabled?: Partial<Record<InspectionRule, boolean>>): Inspection[] {
      const name = fileName(id);
      if (!files.has(name)) return [];
      const program = service.getProgram();
      const source = program?.getSourceFile(name);
      if (!program || !source) return [];
      const on = (r: InspectionRule) => enabled?.[r] !== false;
      return runInspections(source, program.getTypeChecker(), on);
    },
  };
}

export type TsService = ReturnType<typeof createTsService>;

function path(...parts: string[]): string {
  return nodePath.resolve(...parts);
}

// ── Inspections ─────────────────────────────────────────────────────────

function runInspections(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  on: (rule: InspectionRule) => boolean,
): Inspection[] {
  const out: Inspection[] = [];
  const text = source.text;

  const span = (n: ts.Node): TsSpan => ({ from: n.getStart(source), to: n.getEnd() });
  const statementRange = (s: ts.Statement): TsSpan => {
    // The whole line(s) the statement occupies, so removing it leaves no
    // blank line behind.
    let from = s.getStart(source);
    while (from > 0 && (text[from - 1] === " " || text[from - 1] === "\t")) from--;
    let to = s.getEnd();
    if (text[to] === "\n") to++;
    return { from, to };
  };
  const indentOf = (s: ts.Statement): string => {
    const lineStart = text.lastIndexOf("\n", s.getStart(source) - 1) + 1;
    return text.slice(lineStart, s.getStart(source)).replace(/\S.*$/, "");
  };

  const isCallTo = (n: ts.Node, member: string): n is ts.CallExpression =>
    ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === member;

  /** Is `n` inside the callback of a `test.step(...)` call? */
  const insideStep = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === "step") return true;
    }
    return false;
  };
  /** Is `n` a direct statement of a `test(...)` body? */
  const testBody = (block: ts.Block): boolean => {
    const fn = block.parent;
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
    const call = fn.parent;
    return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "test";
  };

  const visit = (node: ts.Node): void => {
    // no-wait-for-timeout
    if (on("no-wait-for-timeout") && isCallTo(node, "waitForTimeout")) {
      const stmt = enclosingStatement(node);
      out.push({
        rule: "no-wait-for-timeout",
        severity: "warning",
        ...span(node),
        message: "waitForTimeout waits a fixed time and passes whether or not the page is ready; a web-first assertion (await expect(locator).toBeVisible()) waits for the thing itself.",
        ...(stmt ? { fix: { title: "Remove the wait", edits: [{ ...statementRange(stmt), text: "" }] } } : {}),
      });
    }

    // no-force-without-reason
    if (on("no-force-without-reason") && ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "force" && node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      const stmt = enclosingStatement(node);
      const line = stmt ? lineTextOf(text, stmt) : "";
      const prev = stmt ? previousLineText(text, stmt) : "";
      if (!/\/\/.*\S/.test(line) && !/^\s*\/\//.test(prev)) {
        out.push({
          rule: "no-force-without-reason",
          severity: "warning",
          ...span(node),
          message: "force: true skips Playwright's actionability checks, so the step passes against a covered or disabled element. Keep it only with a comment saying why.",
          fix: { title: "Remove force: true", edits: [removeProperty(text, node)] },
        });
      }
    }

    // missing-await
    if (on("missing-await") && ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const type = checker.getTypeAtLocation(node.expression);
      if (isPromiseLike(type, checker)) {
        out.push({
          rule: "missing-await",
          severity: "error",
          ...span(node.expression),
          message: "This returns a promise that nothing awaits: the test moves on before it settles, and a failing assertion here would not fail the test.",
          fix: { title: "Add await", edits: [{ from: node.expression.getStart(source), to: node.expression.getStart(source), text: "await " }] },
        });
      }
    }

    // raw-css-locator
    if (on("raw-css-locator") && isCallTo(node, "locator") && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const sel = node.arguments[0].text;
      if (/^[#.]|[>[\]]|:nth-/.test(sel) && !/^internal:|^xpath=|^text=/.test(sel)) {
        out.push({
          rule: "raw-css-locator",
          severity: "hint",
          ...span(node.arguments[0]),
          message: `A CSS locator (${JSON.stringify(sel)}) follows the page's markup, which changes without the page changing. If the element has a role, label, placeholder or test id, getByRole/getByLabel/getByPlaceholder/getByTestId survive a restyle.`,
        });
      }
    }

    // index-pinned-locator
    if (on("index-pinned-locator") && (isCallTo(node, "nth") || isCallTo(node, "first") || isCallTo(node, "last"))) {
      out.push({
        rule: "index-pinned-locator",
        severity: "hint",
        ...span((node.expression as ts.PropertyAccessExpression).name),
        message: "Pinned by DOM order: this picks whichever match comes first, and a reordered page picks a different one. Narrowing the locator (a name, a container) picks by meaning.",
      });
    }

    // unwrapped-statement
    if (on("unwrapped-statement") && ts.isExpressionStatement(node) && ts.isBlock(node.parent) && testBody(node.parent) && !insideStep(node)) {
      const expr = ts.isAwaitExpression(node.expression) ? node.expression.expression : node.expression;
      if (ts.isCallExpression(expr) && mentionsPageOrExpect(expr) && !(ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "step")) {
        const indent = indentOf(node);
        const stmtText = text.slice(node.getStart(source), node.getEnd());
        const title = stepTitleFor(stmtText);
        out.push({
          rule: "unwrapped-statement",
          severity: "hint",
          ...span(node),
          message: "Not inside a test.step wrapper: the Steps tab shows this as code rather than as a step, and a run reports no step for it.",
          fix: {
            title: "Wrap in test.step",
            edits: [
              {
                from: node.getStart(source),
                to: node.getEnd(),
                text: `await test.step(${JSON.stringify(title)}, async () => {\n${indent}  ${stmtText}\n${indent}});`,
              },
            ],
          },
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return out.sort((a, b) => a.from - b.from);
}

function enclosingStatement(n: ts.Node): ts.Statement | null {
  for (let p: ts.Node | undefined = n; p; p = p.parent) if (ts.isStatement(p) && !ts.isBlock(p)) return p;
  return null;
}

function lineTextOf(text: string, s: ts.Statement): string {
  const start = s.getStart();
  const ls = text.lastIndexOf("\n", start - 1) + 1;
  const le = text.indexOf("\n", s.getEnd());
  return text.slice(ls, le === -1 ? text.length : le);
}

function previousLineText(text: string, s: ts.Statement): string {
  const ls = text.lastIndexOf("\n", s.getStart() - 1);
  if (ls <= 0) return "";
  const pls = text.lastIndexOf("\n", ls - 1) + 1;
  return text.slice(pls, ls);
}

/** Remove a property from an object literal along with the comma that
 *  joined it to its neighbour. */
function removeProperty(text: string, prop: ts.PropertyAssignment): TextEdit {
  let from = prop.getStart();
  let to = prop.getEnd();
  // Trailing comma and the whitespace after it: `{ a, force: true }` → `{ a }`.
  const after = text.slice(to).match(/^\s*,\s*/);
  if (after) {
    to += after[0].length;
    return { from, to, text: "" };
  }
  // Otherwise the comma before it: `{ a, force: true }` → `{ a }`.
  const before = text.slice(0, from).match(/\s*,\s*$/);
  if (before) {
    from -= before[0].length;
    return { from, to, text: "" };
  }
  // The only property: `{ force: true }` → `{}`.
  const ws = text.slice(0, from).match(/\s+$/);
  if (ws) from -= ws[0].length;
  const wsAfter = text.slice(to).match(/^\s+/);
  if (wsAfter) to += wsAfter[0].length;
  return { from, to, text: "" };
}

function isPromiseLike(type: ts.Type, checker: ts.TypeChecker): boolean {
  const sym = type.getSymbol();
  if (sym && (sym.name === "Promise" || sym.name === "PromiseLike")) return true;
  // A union (Promise<void> | undefined), or a thenable by structure.
  if (type.isUnion()) return type.types.some((t) => isPromiseLike(t, checker));
  const then = type.getProperty("then");
  return Boolean(then && checker.getTypeOfSymbol(then).getCallSignatures().length > 0);
}

function mentionsPageOrExpect(call: ts.CallExpression): boolean {
  let e: ts.Expression = call;
  for (;;) {
    if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isPropertyAccessExpression(e)) e = e.expression;
    else if (ts.isAwaitExpression(e)) e = e.expression;
    else break;
  }
  return ts.isIdentifier(e) && (e.text === "page" || e.text === "expect");
}

/** A short plain title for a wrapper: the statement with the noise
 *  stripped — `await page.getByRole("button", { name: "Go" }).click();` →
 *  `click getByRole("button", { name: "Go" })`. */
export function stepTitleFor(stmt: string): string {
  const s = stmt.replace(/^await\s+/, "").replace(/;$/, "").trim();
  const m = s.match(/^page\.(?:(.+)\.)?(\w+)\((.*)\)$/s);
  if (m) {
    const args = m[3].trim();
    return (m[2] + (m[1] ? " " + m[1] : "") + (args ? " " + args : "")).slice(0, 80);
  }
  const e = s.match(/^expect\((.+)\)\.(\w+)\((.*)\)$/s);
  if (e) return ("expect " + e[1] + " " + e[2] + (e[3].trim() ? " " + e[3].trim() : "")).slice(0, 80);
  return s.slice(0, 80);
}
