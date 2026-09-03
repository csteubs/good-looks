# Porting off Glaze — what changed, and what to do next

This tree is **Good Looks!** with every Glaze dependency removed. It builds and
runs on stock Electron + Vite + esbuild, with no SDK outside `node_modules` and
no requirement that the folder sit at a particular path.

Status: `lint`, `type-check`, `test:all` (890 Vitest tests + 26 checks) and
`build` all pass; the app boots, renders, and packages to a `.app`.

---

## Why Electron

The Glaze SDK mirrored Electron's API surface, so the backend port was close to
mechanical: 15 symbols across 32 files, nearly all 1:1. The alternative (Tauri)
would have meant rewriting every Node service — the Playwright runner, the
import service, the LLM integration, all the stores — in Rust or behind a
sidecar. That is a rewrite, not a port.

The cost is bundle size: ~386 MB unpacked, against a Glaze app's few MB.

## The seam: `@shell/backend`

App code never imports `electron`. It imports `@shell/backend`
([main/shell/backend.ts](main/shell/backend.ts)), which re-exports Electron's
`app`, `BrowserWindow`, `Menu`, `Notification`, `dialog`, `ipcMain`,
`safeStorage`, `screen`, `globalShortcut`, plus:

- a local `logger` (console + an append-only file under `userData/logs`),
- a `BrowserWindow` wrapper that strips Glaze's `windowKey` option so window
  creation code was not rewritten,
- `initDevToolsButtonState` as a no-op (Electron has the standard View menu
  role instead),
- the `WebContentsNavigationEvent` type the recorder's navigation guards use.

**An ESLint rule enforces this** — importing `electron` anywhere under `main/`
outside `main/shell/` is an error. Verified to actually fire, not just
configured.

## Things that genuinely changed behaviour

Everything else is a like-for-like port. These are not:

| Area | Change | Why |
|---|---|---|
| Renderer transport | Served over a custom `app://` scheme, not `file://` | Vite emits `<script type="module" crossorigin>`. From `file://` that has a null origin and is **blocked by CORS** — the window opens, renders nothing, and the main log stays clean. See [main/shell/app-protocol.ts](main/shell/app-protocol.ts). The alternative, `webSecurity: false`, is unacceptable in a process that loads arbitrary untrusted sites. |
| Capture/replay script injection | `executeJavaScriptInIsolatedWorld` via a `pageExecutor()` adapter | Preserves the original's content-world isolation: the recorded page must not see or tamper with the capture machinery. The adapter is the only place the world id appears, so every helper and test still types against plain `executeJavaScript`. |
| Playwright + git subprocesses | `ELECTRON_RUN_AS_NODE=1` added to the spawn env | Under Electron, `process.execPath` is the Electron binary. Without this the runner would launch a second copy of the app instead of running the CLI. Verified against the packaged bundle. |
| Date picker | Now a DOM `<input type="date">` | The original was native-backed via `dialog.showDatePicker`, which Electron has no equivalent for. Only `stats-view.tsx` uses it. It is now keyboard-accessible and testable, which the original was not. |
| App identity | `main/handlers/app.ts` and its `app:getInfo` channel deleted (2026-09-03) | The template's app-handlers module answered with the template's own identity — `"My Glaze App"`, `"1.0.0"`, and an `environment` off `NODE_ENV` that nothing sets in a packaged build. The port carried it forward untouched because **nothing called it**, and a handler with no caller has no symptom to notice. Deleted rather than corrected, for the same reason the preload drops the template's location/systemPreferences/webUtils surfaces: only APIs with actual renderer call sites are exposed. The app already reads its real name and version from the bundle and `package.json`. `check:app-identity` now fails on a stated app name or version anywhere in the tree, which is also how the MCP server's matching stale `"1.0.0"` handshake was found. See DECISIONS 2026-09-03. |

**`Select` and `DropdownMenu` deliberately did NOT change.** They are still
backed by real macOS menus via `Menu.popup` — items render to `null`, the tree
is walked into a plain-data template, and the answer comes back as a
`commandId`. Keeping that architecture preserved both the native menu behaviour
and the existing tests, which drive these by stubbing `glazeAPI.Menu.popup`.
The documented caveat is unchanged: options are not in the DOM, so assert the
displayed value and cover persistence at the IPC layer.

## The component library

`@glaze/core/components` was 73 symbols across 36 files. It is replaced by
[renderer/ui/](renderer/ui/) — same symbol names, same prop contracts (read off
the SDK's `.d.ts` files), so **the 36 consuming views were not rewritten**; only
their import specifier changed to `@ui`.

It is built on the dependencies the app already had — `radix-ui`,
`class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `sonner` —
which are exactly the SDK's own peer dependencies.

Two compatibility aliases exist because call sites use them: `Badge variant=`
(alias of `color`) and `Text size=` (alias of `variant`).

Design tokens live in [renderer/ui/tokens.css](renderer/ui/tokens.css) and are
bridged to Tailwind in [renderer/styles.css](renderer/styles.css). **The visual
result is an approximation of the original design system, not a pixel match** —
this is the part of the port most worth your eye.

**Not rewriting the views had a cost that took until 2026-08-09 to find.** They
still address the SDK's *vocabulary* — the `text-primary/secondary/tertiary`
ramp, the `support-*` status family, `bg-panel`, `bg-well`, `blue-9` — and 28 of
those names, plus 14 custom properties, had nothing on the other end. They
styled nothing, silently: the Stats chart drew no bars, the Script view had no
syntax highlighting, and `text-secondary` resolved to a panel *fill* used as
text colour at 1.4:1. All of it is declared now, and `check:renderer-classes`
builds the renderer and asks the emitted stylesheet whether every class the
renderer uses actually produces a rule. See DECISIONS 2026-08-09.

## Licensing note

`@glaze/core` ships with no LICENSE file and carries Raycast copyright. Nothing
from it was copied into this tree — the component library was rebuilt from the
public Radix primitives against the SDK's published type signatures. If you ever
consider vendoring the SDK instead, that is a licensing question to settle
first.

---

## Build

```bash
npm install --include=dev
```

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server + Electron, renderer hot-reloads |
| `npm run build` | `vite build` (renderer) then esbuild (main + preload) |
| `npm run package` | Build, then electron-builder → `dist/mac-arm64/Good Looks!.app` |
| `npm run lint` / `type-check` / `test:all` | The gate. All three pass. |

Three config files replace the SDK CLI: [vite.config.ts](vite.config.ts),
[scripts/build-main.mjs](scripts/build-main.mjs), [eslint.config.js](eslint.config.js).

Two non-obvious build details, both of which cost real debugging time:

- **`scripts/build-main.mjs` injects a `createRequire` banner.** Bundling CJS
  deps (pngjs, pixelmatch) into ESM makes esbuild emit a `__require` shim that
  throws `Dynamic require of "util" is not supported` at load. The banner
  defines only `require` — adding `__filename`/`__dirname` collides with
  `main/index.ts`'s own declarations and is a SyntaxError.
- **`asar` must stay `false`.** The runner spawns the Playwright CLI as a real
  child process, and a path inside an asar archive is not a real path on disk.

---

## Next: Developer ID signing and notarization

The build is currently **unsigned** (`mac.identity: null`). To ship:

1. Apple Developer Program membership ($99/yr), then create a **Developer ID
   Application** certificate and install it in your login keychain.
2. Remove `"identity": null` from `build.mac` in `package.json` and add
   `"hardenedRuntime": true` plus an entitlements file. The app needs
   `com.apple.security.cs.allow-jit` and
   `com.apple.security.cs.allow-unsigned-executable-memory` (Electron/V8), and
   `com.apple.security.cs.disable-library-validation` (Playwright's browsers are
   not signed by you).
3. Notarize with an app-specific password or an App Store Connect API key
   (`notarize` in electron-builder config), then staple.
4. Switch the mac target from `dir` to `dmg` or `zip` for distribution.

### The App Store is not a viable target for this app

Worth restating in the repo, because it constrains the roadmap:
`playwright install` downloads and executes browser binaries at runtime, which
App Review guideline 2.5.2 prohibits outright, and the App Sandbox independently
blocks spawning executables you did not sign. Shipping to the Mac App Store
would mean cutting test execution and project import — i.e. shipping the
recorder without the runner. Developer ID has none of these constraints.

---

## Verified

- `npm run lint` — clean.
- `npm run type-check` — 0 errors.
- `npm run test:all` — 26/26 checks, 890/890 Vitest tests.
- `npm run build` — clean.
- `npm run package` — produces `Good Looks!.app`; boots with no renderer errors.
- Dev build visually confirmed: sidebar, Stats/Visual/Batch/Heals nav, home
  view, footer all render.
- `ELECTRON_RUN_AS_NODE=1 <packaged binary> <bundled playwright cli> --version`
  → `Version 1.53.0`, exit 0. The runner's spawn path works from inside the
  bundle.

## Not verified

- **The packaged app's UI was not visually inspected** (screen-access for it was
  declined); only the dev build was. Same renderer bundle, and the packaged app
  boots clean, but the packaged window itself has not been looked at.
- **No end-to-end recording session was driven.** The trainer window, capture
  script injection, step drain and spec generation are covered by the test
  suite but were not exercised against a live website in the ported build.
  This is the first thing to try manually. (Partly closed on 2026-08-09: a
  recorded test was RUN end-to-end against a live site in the dev build, with
  capture, console/network recording and accessibility checks on. Recording
  itself — the trainer window and step capture — is still undriven here.)
- Visual fidelity of the rebuilt component library against the original.
