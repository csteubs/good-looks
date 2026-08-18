# Private browsing and user-provided browser extensions

Written 2026-08-17, before any of it was built. Feasibility findings only — no
code changed. Read [../ARCHITECTURE.md](../ARCHITECTURE.md) for what the code
does now.

The question asked was two-part: can a user express a preference for a private
or incognito browser, and can the app preload user-provided extensions
(adblockers, scripting harnesses) as Chrome or Safari extensions.

The short answers are that the first is already true everywhere and the
interesting feature is its inverse, and that the second is Chromium-only,
structurally blocked on the run side today, and cheap on the trainer side.

## 1. Private browsing already holds on both surfaces

**The training browser.** Each recording session gets
`partition: recorder-incognito-${randomUUID()}` on the page's
`WebContentsView` (`main/services/recorder-service.ts`). It is per-session, so
nothing survives from one recording to the next, and `check:recorder-views`
pins the partition to the PAGE view — on the window it would still create a
partition, just not the one the site loads in, and every recording would
inherit the last one's state.

**Test runs.** Playwright gives each test a fresh `browser.newContext()`: no
profile, no cookies, no cache, no history, discarded at the end. That is what
incognito means. There is no toggle to add here.

Two things follow. Chromium's `--incognito` flag is not the mechanism and is
not usable under Playwright, which launches with its own user-data dir — so
"incognito" is not a mode this app could switch on even if it wanted to; it is
the shape of every context the app already creates. And a "private browsing"
preference in Settings would be a checkbox that is permanently checked, which
is worse than no checkbox: it implies an unchecked state that does not exist.

## 2. The feature with actual value is the inverse

What is missing is a **persistent profile** — an opt-in where a signed-in
session, a dismissed cookie banner, or a remembered 2FA device survives across
runs instead of being redone every time. Today that need is served by cookie
steps (`main/services/cookie-service.ts`) and `test-secrets-store`.

It is a real capability and it has real costs, all of which argue for a
per-test opt-in rather than a global default:

- A live credential then sits in a user-data dir on disk, which is a different
  storage story from `encrypted-secret-store`.
- Tests stop being independent. A run passes because the profile happens to be
  logged in, which is the "works on my machine" failure with a new cause.
- Retention has a new thing to prune.

## 3. Extensions: Chromium only, and Safari is a flat no

**Safari extensions cannot work.** Playwright's `webkit` is a bespoke WebKit
build, not Safari. Safari extensions are signed macOS app bundles that load
only into Safari itself. Nothing in this app can host one.

**Firefox cannot either** — Playwright's Firefox build does not load them.

So this is a capability of one engine out of the three in `RunBrowser`
(`main/recorder/types.ts`), which means it cannot be a global setting. Whatever
UI it gets has to say that choosing `firefox` or `webkit` turns it off.

### On the run side it is structurally blocked today

Extensions require `launchPersistentContext` with
`--disable-extensions-except=<dir> --load-extension=<dir>`. The app runs
through the `playwright test` CLI against one shared generated config
(`shared/playwright-config-source.mjs`) using the ordinary
`browser` → `context` → `page` fixture chain, with `--browser=` selecting the
engine. `launchOptions` in that config cannot express it.

The seam does exist. A run that captures artifacts already has its spec's
`@playwright/test` import redirected to a generated fixture module
(`capture-fixture-source.ts`, and `heal-fixture-source.ts` for heal runs), so a
fixture overriding `context`/`page` with a persistent context is the natural
home for this.

Note that this collapses into §2: an extension cannot be loaded without a
user-data dir, so extension support and persistent profiles are one feature,
not two.

**Headless is a second obstacle, and a quiet one.** The old headless shell does
not support extensions, and Chromium's install ships one — the runner already
has to distinguish it (`isBrowserInstalled` matches the engine prefix followed
by `-` precisely so a headless-shell-only install is not mistaken for a full
browser). An extension run would have to be headed, or forced onto the full
Chromium binary. Playwright is pinned at 1.53.0 here; verify the behaviour of
that exact version rather than trusting this paragraph.

### On the trainer side it is cheap

`session.fromPartition(...).loadExtension(dir)` against the existing
per-session partition. Constraints worth putting in the UI rather than letting
users discover by silent failure: unpacked directories only (no `.crx`, no
Chrome Web Store), and Electron implements a subset of the Chrome extension
APIs — enough for `declarativeNetRequest`-based adblockers, not enough for
arbitrary extensions.

## 4. Three consequences to settle before building

**An extension is arbitrary code inside the capture boundary.** The trainer
loads untrusted sites and compiles what it captures into a `.spec.ts` that
Playwright executes in Node. A content script cannot forge steps through the
console channel — that is nonce-authenticated from an isolated world
(`main/recorder/capture-channel.ts`) — but it can write `data-pw-queue`, the
second channel, which is exactly why `normalizeRawStep` rebuilds every step
regardless. That protection holds. What is new is that the user is installing
something with host permissions on every site they record, and the app should
say so at install time.

**An adblocker changes the page being recorded against.** Selectors, heal-map
keys and visual baselines all become extension-dependent. A run has to record
which extensions were active, or a baseline captured with an adblocker fails
against a run without one and the diff blames the site.

**It splits the browser matrix.** `get_browser_matrix`, the flake report and
the batch runner treat the three engines as interchangeable. "Chromium with
extensions" is effectively a fourth target.

## 5. Suggested order

Trainer first: extension loading on the recorder's partition is contained, does
not touch the runner, and pays off immediately by letting a user record against
the page as their own users see it. Then decide whether persistent profiles are
worth their cost on the run side, and take extensions there as a consequence of
that decision rather than as a separate feature.
