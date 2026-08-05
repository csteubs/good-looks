// Shared error-message formatter for LLM failures shown in the AI debug
// panel, generate-steps dialog, and generate-test dialog. The backend
// (llm-service.ts, via llm/provider-errors.ts) already decodes a provider's
// error body into one actionable sentence, so this only adds the Settings
// hint and handles any raw messages that slip through.

export function friendlyError(message: string): string {
  if (/no model selected/i.test(message)) {
    return `${message} Open Settings (⌘,) → AI provider to pick one.`;
  }
  // A model that won't load already carries its own instructions (load it,
  // pull it, or pick another), and the connection is fine — telling the user
  // to go check it would send them after the wrong problem. Checked BEFORE the
  // connection patterns below because the backend quotes the provider
  // verbatim, and those words are outside our control.
  if (/couldn't load the model|failed to load model|model not found|model_not_found/i.test(message)) {
    return `${message} You can change the model from the title of this window.`;
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
  if (/invalid api key|401|rejected the api key/i.test(message)) {
    return `${message} Open Settings (⌘,) → AI provider to update your API key.`;
  }
  return message;
}
