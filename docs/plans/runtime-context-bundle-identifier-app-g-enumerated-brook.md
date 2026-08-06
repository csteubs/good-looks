# Add Claude (Anthropic) as an AI provider

## Context

Test Recorder's AI features (debug-a-failed-run, per-step debug, generate-steps, generate-test-from-prompt) currently talk to a **local LLM only** — Ollama / LM Studio — over loopback HTTP using an OpenAI-compatible streaming endpoint. There is no cloud provider and no authentication anywhere in the app.

The user wants Claude available so they can use a hosted, high-quality model for test development instead of relying on a local model. Decisions confirmed with the user:

- **Auth:** Anthropic **Console API key** (not OAuth). The user pastes a key from `console.anthropic.com`; it's stored **encrypted on-device via `safeStorage`** and never leaves the backend or returns to the renderer.
- **Scope:** Claude is **added alongside** Ollama / LM Studio as a third selectable provider. Existing local-model behavior is unchanged.

The design leans entirely on the app's existing provider-agnostic plumbing: prompts (`llm-prompts.ts`), the `useLlmChat` hook, the streaming `llm:chunk/done/error` push events, `ModelPicker`, and response parsing all stay as-is. The only new concepts are an `"anthropic"` provider branch and an encrypted API-key store.

## Architecture

Same request path as today — renderer hook → `api.llm.chat` → `llm:chat` IPC → `llmService.chat()` → streaming push events. `runChat` gains an Anthropic branch:

- **Endpoint:** `POST https://api.anthropic.com/v1/messages`
- **Headers:** `x-api-key: <key>`, `anthropic-version: 2023-06-01`, `content-type: application/json`
- **Body:** `{ model, max_tokens: 4096, system, messages, temperature, stream: true }` — Anthropic requires `max_tokens` and takes the system prompt as a **top-level `system` string**, not a message. Convert `LlmMessage[]`: join all `role: "system"` messages into `system`, map the rest to `{ role: "user"|"assistant", content }` (our prompt builders already emit `[system, user, ...]`, which is valid).
- **Streaming SSE:** parse `data:` lines; on `type === "content_block_delta"` with `delta.type === "text_delta"`, emit `delta.text` as an `llm:chunk` (same shape the UI already consumes). Handle `event: error` payloads → `llm:error`.

The API key stays backend-only. The renderer sends the plaintext key **once** when saving; every other call reports only whether a key is present. `safeStorage` from `@glaze/core/backend` is used for encryption (invoke the `glaze-data-storage` skill during implementation to confirm sync-vs-async signatures and `isEncryptionAvailable()` handling).

## Changes by file

### Backend

**`main/services/llm/types.ts`**
- `LlmProvider = "ollama" | "lmstudio" | "anthropic"`.
- Add optional `hasKey?: boolean` to `LlmProviderStatus` so the UI can gate on key presence.

**`main/services/anthropic-key-store.ts`** (new) — mirrors the `llm-config-store.ts` pattern:
- Stores the encrypted key at `userData/recorder/anthropic-key.enc` using `safeStorage.encryptString` / `decryptString`.
- Exports `getKey(): string | null`, `setKey(plain: string): void`, `clear(): void`, `hasKey(): boolean`.
- If `safeStorage.isEncryptionAvailable()` is false, surface a clear error rather than writing plaintext.

**`main/services/llm-service.ts`**
- `DEFAULT_BASE_URLS.anthropic = "https://api.anthropic.com"`.
- `providerLabel`: add `"Claude"`.
- `fetchModels`: for `anthropic`, `GET {base}/v1/models` with the `x-api-key` + `anthropic-version` headers; map `data[].id` → `{ id, label }` (label the display_name when present). If no key, return `[]`; if the request 401s, throw a friendly "Invalid API key" error.
- `runChat`: branch on provider. Local providers keep the existing OpenAI path untouched; add the Anthropic Messages path (headers/body/SSE parsing above). Missing key → `llm:error` "Add your Anthropic API key in Settings."
- `status("anthropic")`: `hasKey` from the key store; if key present, validate by listing models (`reachable: true` + models); if absent, `reachable: false, hasKey: false, error: "Add an API key…"`.

**`main/handlers/index.ts`**
- `asProvider`: also accept `"anthropic"`.
- New handlers (registered next to the existing `llm:*` block; no preload change needed — they go through the generic IPC bridge):
  - `llm:setApiKey` `{ key: string }` → `anthropicKeyStore.setKey`; returns `{ hasKey: true }`.
  - `llm:clearApiKey` → `anthropicKeyStore.clear`; returns `{ hasKey: false }`.
  - `llm:hasApiKey` → `{ hasKey: boolean }` (never returns the key).
- `llm:status` / `llm:listModels` already provider-parameterized — they work once `asProvider` accepts anthropic.
- (Optional) `app:openExternal` `{ url }` guarded to `https://console.anthropic.com*` using `shell.openExternal` from `@glaze/core/backend`, for a "Get an API key" button.

### Renderer

**`renderer/lib/llm-types.ts`** — mirror: add `"anthropic"` to `LlmProvider`, `hasKey?` to `LlmProviderStatus`.

**`renderer/lib/api.ts`** — add under `api.llm`: `setApiKey(key)`, `clearApiKey()`, `hasApiKey()`. (Optional `openExternal`.)

**`renderer/settings/settings-view.tsx`** — extend the existing "AI provider" `FieldSet`:
- Provider `RadioGroup`: add a **Claude** option (relabel the section from "Local AI provider" to "AI provider").
- Branch the fields by provider:
  - **Ollama / LM Studio:** unchanged (server URL + Test connection + model radio).
  - **Claude:** a password-style API-key `Input` + **Save**/**Clear** buttons, a `Status` reading Connected / Not connected (from `hasApiKey` + `status`), a hint that the key is stored encrypted on this Mac and traffic goes to `api.anthropic.com` over HTTPS, an optional "Get an API key" link, and the **Model** radio populated from `listModels("anthropic")` once a key is saved.
- Extend `defaultUrlFor` / `handleProviderChange` / model-fetch effects to handle the anthropic case (no server-URL field; refetch models after a key is saved). On provider switch, reset the model as the existing code already does.

No changes to `llm-prompts.ts`, `use-llm-chat.ts`, `parse-llm-response.ts`, `ai-debug-panel.tsx`, or the generate dialogs — they're provider-agnostic and inherit Claude automatically. `friendlyError`'s "Settings → AI provider" pointer stays correct.

### package.json
No new dependency — Anthropic is called with the built-in `fetch` (same as the local providers). No `@anthropic-ai/sdk`. Outbound HTTPS from the backend needs no capability declaration (the loopback-only note in `llm-service.ts` was about avoiding the local-network prompt, not a gate on internet access).

## Security notes
- API key never crosses IPC except on save; stored encrypted via `safeStorage`; excluded from all status/get responses.
- No key in logs — the existing `logger.info("llm", "Saved LLM config", …)` logs provider/model only; keep that.

## Verification
1. `BuildApp` (lint + type-check + build) must pass; fix anything it surfaces, then rebuild until green. Launch the app for runtime checks.
2. **Settings:** open Settings → AI provider, select **Claude**. With no key: Model list hidden, status "Not connected". Paste a key → Save → status "Connected", model list populates. (DOM inspect the settings view to confirm the branch renders; the key input must be a password field and must not echo the saved key back.)
3. **End-to-end generation:** with Claude selected + a model chosen, run "Generate from prompt" and a per-step "Debug with AI" — confirm tokens stream into the panel via the existing `llm:chunk` rendering (exercise the real path in the running app, not just a green build).
4. **Fallback intact:** switch back to Ollama/LM Studio and confirm local flows still work unchanged.
5. **Error paths:** invalid key → friendly "Invalid API key"; provider=Claude with no key → "Add your Anthropic API key in Settings" instead of a raw HTTP error.
6. Update `PROJECT-CONTEXT.md` (Current State: three-provider abstraction + encrypted key store; new Recent History entry).
