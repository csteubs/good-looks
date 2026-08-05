// Shared error-message formatter for LLM failures shown in the AI debug
// panel, generate-steps dialog, and generate-test dialog. The backend
// (llm-service.ts) already wraps low-level connection failures with a
// friendly prefix, so this mainly adds the Settings hint and handles any
// raw messages that slip through.

export function friendlyError(message: string): string {
  if (/no model selected/i.test(message)) {
    return `${message} Open Settings (⌘,) → AI provider to pick one.`;
  }
  if (/could not reach|make sure it is running|check your internet/i.test(message)) {
    // Backend already produced a friendly connection message — just add the
    // Settings hint.
    return `${message} Open Settings (⌘,) → AI provider to check the connection.`;
  }
  if (/abort|timeout|econnrefused|fetch failed|network/i.test(message)) {
    // Raw connection error that the backend didn't wrap (defensive).
    return `${message} Open Settings (⌘,) → AI provider to check the connection.`;
  }
  if (/invalid api key|401/i.test(message)) {
    return `${message} Open Settings (⌘,) → AI provider to update your API key.`;
  }
  return message;
}
