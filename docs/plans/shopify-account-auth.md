# Shopify customer accounts: signing a test in when the password is an email

Written 2026-08-26, against `origin/main` at `da98899`.

Goal: let a recorded test drive the **account management experience** of a
production Shopify store, unattended, on a CI runner, when Shopify's only
sign-in method is a six-digit code emailed to the customer.

---

## 1. What Shopify offers, which is nothing

Researched 2026-08-26. `shopify.dev`, `help.shopify.com` and
`community.shopify.dev` are unreachable from this session's egress policy, so
the findings below come from search-indexed copies and should be re-confirmed
against the live docs before anyone leans on a version number.

| Mechanism | State |
|---|---|
| Classic accounts (email + password) | Deprecated Feb 2026. Cannot be enabled on a store not already using it; final sunset unannounced; a theme upgrade that drops the legacy files auto-migrates the store |
| Storefront API `customerAccessTokenCreate` | Classic only; deprecated with it |
| **Multipass** | **Not supported on new customer accounts.** This was the only mechanism that minted a session from a signed token |
| Customer Account API | OAuth 2.0 only — public client + PKCE, or confidential client. Every flow begins at Shopify's hosted authorize endpoint, which is the emailed-code screen. No client-credentials grant, no password grant |
| Admin API | No mutation that mints a customer session or a login link for new accounts |
| Other sign-in methods | Google, Facebook, Sign in with Shop (optionally a Shop passkey). Each needs the corresponding third party; the passkey is a *Shop* credential, not a store one |

Shopify's own guidance for storefront E2E, and the community's, is to **reuse
an authenticated session**. There is no test mode, no dev-store bypass, and no
way to have the code delivered anywhere but the customer's inbox.

So the code has to be read out of a mailbox. That is what mabl's
`@mablmail.com` was, and it is still the only door.

### Operational limits that shape the design

| | |
|---|---|
| Emailed code validity | ~30 min |
| Failed sign-in attempts | ~5 → 30-minute lockout |
| Customer session cookie (`_secure_session_id`) | ~24 h |
| hCaptcha on login / create account / password recovery | **can be turned off**: Online Store → Preferences → Spam protection |
| Checkout bot protection | Settings → Bot protection |

The lockout is the reason this feature cannot be "retry the login until it
works": five wrong codes costs half an hour of the suite. The 24-hour cookie is
the reason it does not have to be fast.

## 2. What the app already has

Most of this feature is already built, which is why the new surface is small.

- **`main/services/session-state-store.ts`** — `saveSession` / `useSessionFrom`.
  A passing run of a session-saving test writes `storageState`; other tests
  start from it; stale past 24 h is refused *out loud*. That 24-hour cap and
  Shopify's cookie lifetime are the same number by coincidence, and it is the
  coincidence the whole design rests on: **the OTP is paid once a day, not once
  a test.**
- **Secret variables** — encrypted at rest, suppliable to an unattended run as
  `GOOD_LOOKS_SECRET_<TEST>_<NAME>` (`shared/ci-secrets.mjs`), and redacted out
  of run output by the same values that were injected.
- **`shared/totp.mjs` + `glazeTotp`** — the precedent for "a read mints a fresh
  one-time code", single-sourced between trainer replay and the emitted runtime
  because two implementations of an OTP is how a trainer that logs in and a run
  that does not happens.
- **`shared/shopify-signature.mjs`** — the precedent for a credential that is
  scoped to a host, expires, and is stored as an encrypted blob beside a
  plaintext register so the MCP can tell *unconfigured* from *unreadable*.

The missing piece is exactly one thing: **a step that obtains the emailed code
at run time, on a machine that has no app.**

## 3. The mechanism

A catch-all mailbox on a domain the maintainer owns, in front of a single
authenticated JSON endpoint:

```
  Shopify ──email──▶ Cloudflare Email Routing ──▶ Worker ──▶ KV (TTL 1h)
                                                    │
  spec ── GET /messages?address=…&since=… ──────────┘   (bearer token)
```

Chosen over a hosted email-testing API (Mailosaur, MailSlurp) because it costs
nothing, keeps live customer mail out of a third party, and is a domain the
maintainer already controls. Chosen over IMAP because a spec can reach an HTTPS
endpoint with `page.request.fetch` and no new runtime dependency, and the CLI
runs on a container with nothing installed.

The Worker stores **only what a code needs**: recipient, sender, subject, a
capped body excerpt, and the receipt time. Not the full message. It is a test
fixture, not a mail archive, and a full-message store on a public endpoint is a
liability nobody asked for.

### The freshness rule is the whole anti-flake story

The classic failure of every OTP automation is typing **a code that was already
in the inbox** — from the previous run, or from the same suite ten minutes ago.
Shopify accepts a code for 30 minutes, so a stale one is not obviously stale:
it is a plausible six digits that Shopify rejects, and five of those is a
30-minute lockout.

So a message is only a candidate when it arrived after a **watermark**:

```
  accept(message) = message.receivedAt > max(runStartedAt, lastConsumed[address])
```

`runStartedAt` is stamped when the runtime module loads, so a code minted
before this run existed can never be typed. `lastConsumed` advances past every
code the run uses, so a spec that signs in twice cannot reuse the first.

The residual hole is honest and documented: two runs signing the same customer
in concurrently can each see the other's code. Sub-addressing does not close it
— Shopify identifies the customer by exact address, so the address is the
customer's, and it cannot be varied per run. `useSessionFrom` is the mitigation
that matters: the login test runs once and everything else starts from its
state.

### Why polling, and with what budget

The endpoint is polled rather than pushed because a Playwright worker has no
address to be pushed to. The budget is bounded and stated once
(`shared/email-code.mjs`), not per call site: a login that never receives a
code must fail as "no code arrived in 60s at `<address>`", naming the address,
not as a Playwright timeout on a fill.

## 4. Shape of the change

Mirroring the `api` step, which is the closest existing thing — one HTTP call,
one capture into a variable, one awaited line.

| | |
|---|---|
| `shared/email-code.mjs` (+ `.d.mts`) | **Pure.** Endpoint/address validation, the code-extraction rule, the watermark rule, the polling budget. Read by the trainer (which shows the user the code it found), the emitted runtime (which types it), and the renderer (which labels the step) |
| `workers/mailbox/` | The Worker source + a README with the one-time deploy. In the repo because a mechanism only reachable through a dashboard is one nobody can debug |
| `main/services/mailbox-store.ts` | Encrypted endpoint + bearer token, beside a plaintext register (configured / unreadable / none), the `shopify-signature-store.ts` split |
| `glazeEmailCode` in `shared/glaze-runtime-source.mjs` | One awaited line: poll, apply the rule, write into `V`. `page.request.fetch`, so no new dependency and the run's proxy config is honoured |
| `emailCode` step | `StepType` + `normalizeStep` + generator emission + step-list rendering + trainer replay |
| Settings → Integrations | One row: endpoint, token, a Test button that says what it found |

### Deliberately not in scope

- **Reading the code from the app during a trainer session.** The user is
  sitting there and can read their own email. What the trainer must do is
  record the *step*, not the six digits it saw.
- **Sending mail.** This is an inbox, not a mail server.
- **The Customer Account API.** A refresh token buys API access to order and
  address data, not a browser session, and this feature exists for the browser.

## 5. Phasing

1. **Rules + Worker.** `shared/email-code.mjs`, its tests, the Worker, the
   docs. Nothing in the app changes; the endpoint can be exercised by hand.
2. **The step.** Runtime helper, `StepType`, normalize, generator, store,
   runner env, step-list rendering.
3. **The trainer and Settings.** Recording the step, replaying it, the
   Integrations row.

Each phase leaves the tree green and the app shippable.

## 6. What the maintainer has to do in Shopify admin

1. Online Store → Preferences → Spam protection: **uncheck hCaptcha** for
   login / create account / password recovery. This is the one admin change
   that directly removes a blocker, and it is the same class of decision as
   registering the crawler signature.
2. Point the test customers' email addresses at the catch-all domain. This is a
   one-time change to live customer records, and it is the change that makes
   the accounts drivable at all — Shopify sends the code to the address on the
   record and nowhere else.
