// The standing instructions an inline-AI prompt carries: the global text,
// then the text for the test's host, joined so the model reads them as one
// block. Host matching is exact on the lowercased hostname — a rule for
// shop.example.com does not apply to staging.shop.example.com, because the
// two sites are usually the point of having a rule.

export function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function resolveAiInstructions(
  settings: { aiInstructions?: string; aiInstructionsByHost?: Record<string, string> } | undefined,
  testUrl: string,
): string {
  if (!settings) return "";
  const parts: string[] = [];
  const global = settings.aiInstructions?.trim();
  if (global) parts.push(global);
  const host = hostOfUrl(testUrl);
  const byHost = host ? settings.aiInstructionsByHost?.[host]?.trim() : "";
  if (byHost) parts.push(`For ${host}:\n${byHost}`);
  return parts.join("\n\n");
}
