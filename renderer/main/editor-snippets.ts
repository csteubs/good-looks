// Live templates for the script editor: the shapes a recorded spec is made
// of, typed by their first word. Each lands inside a `test.step` wrapper,
// because that is the shape the Steps tab can show (DECISIONS 2026-08-22).

import { snippetCompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";

export const SNIPPETS = [
  snippetCompletion('await test.step("${title}", async () => {\n  ${}\n});', {
    label: "step",
    detail: "test.step wrapper",
    type: "keyword",
  }),
  snippetCompletion('await test.step("click ${name}", async () => {\n  await page.getByRole("${button}", { name: "${name}" }).click();\n});', {
    label: "click",
    detail: "click by role and name, as a step",
    type: "function",
  }),
  snippetCompletion('await test.step("fill ${label}", async () => {\n  await page.getByLabel("${label}").fill("${value}");\n});', {
    label: "fill",
    detail: "fill by label, as a step",
    type: "function",
  }),
  snippetCompletion('await test.step("goto ${url}", async () => {\n  await page.goto("${url}");\n});', {
    label: "goto",
    detail: "navigate, as a step",
    type: "function",
  }),
  snippetCompletion('await test.step("expect ${name} visible", async () => {\n  await expect(page.getByRole("${heading}", { name: "${name}" })).toBeVisible();\n});', {
    label: "visible",
    detail: "expect visible, as a step",
    type: "function",
  }),
  snippetCompletion('await test.step("expect text ${text}", async () => {\n  await expect(page.getByText("${text}")).toBeVisible();\n});', {
    label: "text",
    detail: "expect text visible, as a step",
    type: "function",
  }),
  snippetCompletion('await test.step("expect URL", async () => {\n  await expect(page).toHaveURL(/${pattern}/);\n});', {
    label: "url",
    detail: "expect the URL, as a step",
    type: "function",
  }),
];

/** Offered at a line start only (after indentation): a template is a
 *  statement, and inside an expression it would be noise. */
export function snippetSource(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/\w*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  if (ctx.state.doc.sliceString(line.from, word.from).trim() !== "") return null;
  return { from: word.from, options: SNIPPETS, validFor: /^\w*$/ };
}
