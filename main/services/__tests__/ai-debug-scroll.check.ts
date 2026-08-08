// Standalone regression check for the AI debug dialog's ScrollArea scroll behavior.
//
// The AI debug dialog (AiDebugDialog + StepAiDebugDialog in
// renderer/main/ai-debug-panel.tsx) wraps long content (prompt review, streamed
// AI response) in ScrollArea components. A ScrollArea's root element gets
// `h-full max-h-screen` from the SDK component, and a `max-h-[..vh]` on the root
// alone is not enough: the Radix viewport inside grows to full content height
// and never scrolls because its own scrollHeight === clientHeight. The fix is
// to also pass `viewportClassName="max-h-[..vh]"` so the viewport itself is
// constrained and actually scrolls when content overflows.
//
// There are now TWO valid shapes, and each has its own way of going wrong:
//
//   CONSTRAINED — `max-h-[..vh]` on the root. Needs a matching
//   `viewportClassName` or the viewport grows past it and never scrolls.
//
//   FILL — `flex-1` so the pane occupies the dialog. Needs `min-h-0` (a flex
//   child otherwise refuses to shrink below its content, so the PARENT
//   overflows instead of the child scrolling) and `viewportClassName="h-full"`
//   (without a bounded viewport there is again nothing to scroll). Missing
//   flex-1 is the failure that shipped: the response pane sized itself to its
//   content and sat in the top half of an otherwise empty dialog.
//
// This check reads the source file and verifies every ScrollArea satisfies one
// shape or the other. It guards against reintroducing either non-scrolling
// dialog the next time someone touches these ScrollAreas.
//
// It ALSO pins the dialog body to a fixed height. The two are one contract:
// FILL only bounds anything if the body it fills has a definite height, so a
// body that drifts back to `min-h`/`max-h` would silently un-bound every FILL
// pane below it — the panes would still LOOK right until content overflowed.
// The fixed height is a feature in its own right too: a body sized by a range
// resized the dialog as tokens streamed in, moving Stop and Apply out from
// under the pointer.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npx tsx main/services/__tests__/ai-debug-scroll.check.ts

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "../../../renderer/main/ai-debug-panel.tsx");
const source = readFileSync(sourcePath, "utf8");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// Split the file into ScrollArea JSX opening tags. Each <ScrollArea ...> tag
// spans from "<ScrollArea" to the ">" that closes the opening tag. We extract
// the opening-tag attributes and check that every max-h-[..vh] on className
// is paired with a viewportClassName.
const openingTags: string[] = [];
{
  let idx = 0;
  while (true) {
    const start = source.indexOf("<ScrollArea", idx);
    if (start === -1) break;
    // Find the closing ">" of this opening tag.
    let end = start;
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (ch === "<") depth++;
      else if (ch === ">") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    openingTags.push(source.slice(start, end + 1));
    idx = end + 1;
  }
}

assert(
  openingTags.length >= 3,
  `found at least 3 ScrollArea opening tags (found ${openingTags.length})`,
);

let checked = 0;
let fillCount = 0;
for (const tag of openingTags) {
  const className = tag.match(/className="([^"]*)"/)?.[1] ?? "";
  const viewport = tag.match(/viewportClassName="([^"]*)"/)?.[1] ?? null;

  // The old broken "fix" — clips the overflow without ever scrolling it.
  assert(!/overflow-hidden/.test(tag), "ScrollArea does not use overflow-hidden");

  const vh = className.match(/max-h-\[(\d+)vh\]/)?.[1];
  const fills = /\bflex-1\b/.test(className);

  if (vh) {
    assert(
      viewport !== null && viewport.includes(`max-h-[${vh}vh]`),
      `constrained ScrollArea max-h-[${vh}vh] has viewportClassName="max-h-[${vh}vh]"`,
    );
    checked++;
  }

  if (fills) {
    // Both halves matter and they fail differently: without min-h-0 the parent
    // overflows, without a bounded viewport nothing scrolls at all.
    assert(
      /\bmin-h-0\b/.test(className),
      "filling ScrollArea (flex-1) also sets min-h-0, or it refuses to shrink below its content",
    );
    assert(
      viewport !== null && (/\bh-full\b/.test(viewport) || /max-h-/.test(viewport)),
      'filling ScrollArea (flex-1) sets viewportClassName="h-full" so the viewport is bounded',
    );
    fillCount++;
    checked++;
  }

  // A ScrollArea that neither fills nor is constrained can only grow forever.
  if (!vh && !fills) {
    assert(
      /max-h-/.test(className),
      `ScrollArea is bounded somehow (neither flex-1 nor max-h-[..vh]): ${className}`,
    );
    checked++;
  }
}

assert(checked >= 4, `checked every ScrollArea (checked ${checked})`);
assert(
  fillCount >= 2,
  `the two streamed-response panes fill their dialog (found ${fillCount})`,
);

// ── Dialog bodies are a FIXED height ────────────────────────────────────────
// The wrapper each dialog's content sits in: `<div className="relative flex
// h-[..vh] flex-col gap-3">`. Both dialogs have one.
{
  const bodies = source.match(/className="relative flex [^"]*flex-col gap-3"/g) ?? [];
  assert(bodies.length >= 2, `found both dialog bodies (found ${bodies.length})`);
  for (const body of bodies) {
    assert(
      /\bh-\[\d+vh\]/.test(body),
      `dialog body has a definite height, so the FILL panes inside it are bounded: ${body}`,
    );
    assert(
      !/\bmin-h-\[/.test(body) && !/\bmax-h-\[/.test(body),
      `dialog body is not sized by a range, which would resize the dialog as tokens stream in: ${body}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll ai-debug-scroll checks passed");
