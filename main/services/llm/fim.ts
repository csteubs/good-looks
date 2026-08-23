// Fill-in-the-middle prompts for the autocomplete role.
//
// Ollama's /api/generate takes `prompt` and `suffix` and applies the model's
// own FIM template; LM Studio's /v1/completions applies none, so the tokens
// are assembled here per model family. Unknown family: a plain prefix
// completion with no suffix, stopped at a blank line — worse, but honest,
// and named as such in the Settings row. Pure, so the table is testable.

export interface FimTemplate {
  /** Wrap prefix and suffix the way the family was trained. */
  prompt: (prefix: string, suffix: string) => string;
  /** Tokens that end the middle. */
  stop: string[];
}

// Specific families first: "starcoder" and "deepseek-coder" both contain
// "coder", which is the qwen rule's broad match.
const FAMILIES: { test: RegExp; template: FimTemplate }[] = [
  {
    test: /codellama|code-llama/i,
    template: { prompt: (p, s) => `<PRE> ${p} <SUF>${s} <MID>`, stop: ["<EOT>", "<PRE>", "<SUF>", "<MID>"] },
  },
  {
    test: /starcoder/i,
    template: {
      prompt: (p, s) => `<fim_prefix>${p}<fim_suffix>${s}<fim_middle>`,
      stop: ["<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<|endoftext|>"],
    },
  },
  {
    test: /deepseek/i,
    template: {
      prompt: (p, s) => `<｜fim▁begin｜>${p}<｜fim▁hole｜>${s}<｜fim▁end｜>`,
      stop: ["<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>"],
    },
  },
  {
    test: /qwen|coder/i,
    template: {
      prompt: (p, s) => `<|fim_prefix|>${p}<|fim_suffix|>${s}<|fim_middle|>`,
      stop: ["<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|endoftext|>"],
    },
  },
];

/** The family's template, or null when the model is not a known FIM model —
 *  the caller then sends the prefix alone. The qwen rule is deliberately
 *  broad (`coder` matches qwen2.5-coder and most fine-tunes of it). */
export function fimTemplateFor(model: string): FimTemplate | null {
  for (const f of FAMILIES) if (f.test.test(model)) return f.template;
  return null;
}

/** Trim a completion to what belongs at the caret: stop tokens gone, and
 *  nothing past the first blank line — a FIM model asked for one statement
 *  will happily write the rest of the file. */
export function trimCompletion(text: string, stop: string[]): string {
  let out = text;
  for (const s of stop) {
    const i = out.indexOf(s);
    if (i >= 0) out = out.slice(0, i);
  }
  const blank = out.indexOf("\n\n");
  if (blank >= 0) out = out.slice(0, blank);
  return out.replace(/\s+$/, "");
}
