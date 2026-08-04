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
// This check reads the source file and verifies every ScrollArea that sets a
// `max-h-[..vh]` className also sets a matching `viewportClassName`. It guards
// against reintroducing the non-scrolling dialog the next time someone touches
// these ScrollAreas.
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
for (const tag of openingTags) {
  // Extract the max-h value from className="..."
  const classNameMatch = tag.match(/className="[^"]*max-h-\[(\d+)vh\][^"]*"/);
  if (!classNameMatch) continue; // not a constrained ScrollArea
  const vh = classNameMatch[1];

  // Must NOT have overflow-hidden (the old broken fix that clipped without scrolling)
  assert(
    !/overflow-hidden/.test(tag),
    `ScrollArea max-h-[${vh}vh] does not use overflow-hidden (clips without scrolling)`,
  );

  // Must have viewportClassName with the same max-h
  const viewportMatch = tag.match(/viewportClassName="([^"]*)"/);
  assert(
    viewportMatch !== null && viewportMatch[1].includes(`max-h-[${vh}vh]`),
    `ScrollArea max-h-[${vh}vh] has viewportClassName="max-h-[${vh}vh]"`,
  );

  checked++;
}

assert(
  checked >= 3,
  `checked at least 3 constrained ScrollAreas (checked ${checked})`,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll ai-debug-scroll checks passed");
