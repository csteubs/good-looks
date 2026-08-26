# The mailbox Worker

A catch-all inbox on a domain you own, behind one authenticated JSON endpoint.
It exists so a test can read the six-digit code Shopify emails a customer, on a
CI runner, with no human present.

Why this and not a password: Shopify's new customer accounts have none. Classic
accounts were deprecated in February 2026, Multipass is not supported on the new
ones, and every Customer Account API flow begins at Shopify's hosted login —
the same emailed-code screen. There is no test mode and no admin bypass. See
[../../docs/plans/shopify-account-auth.md](../../docs/plans/shopify-account-auth.md).

```
  Shopify ──email──▶ Cloudflare Email Routing ──▶ this Worker ──▶ KV (1h TTL)
                                                       │
  your spec ── GET /messages?address=…&since=… ────────┘   Bearer token
```

It stores the subject, a capped body excerpt, the envelope addresses and the
receipt time — never the raw message — and everything expires in an hour. A
code is dead in thirty minutes; nothing here needs to outlive that.

## One-time setup

You need a domain on Cloudflare and the `wrangler` CLI (`npx wrangler`).

**1. Create the KV namespace and put its id in `wrangler.toml`.**

```bash
cd workers/mailbox
npx wrangler kv namespace create MAILBOX
```

**2. Set the token.** Anything long and random; this is the only thing guarding
the endpoint.

```bash
openssl rand -base64 32          # generate one
npx wrangler secret put MAILBOX_TOKEN
```

**3. Deploy.**

```bash
npx wrangler deploy
```

**4. Route the mail.** In the Cloudflare dashboard, under
*Email → Email Routing → Routing rules*, set the **catch-all address** to
*Send to a Worker* and pick `good-looks-mailbox`. Every address at the domain
now reaches the Worker, so you never have to register one.

**5. Check it.** Send yourself a message and ask for it:

```bash
curl -sS -H "Authorization: Bearer $MAILBOX_TOKEN" \
  "https://good-looks-mailbox.<your-subdomain>.workers.dev/messages?address=anything@<your-domain>&since=0"
```

You should get `{"messages":[{…}]}`. A `401` is the token, a `503` is a missing
secret or KV binding, and an empty list means the routing rule is not sending
mail here.

## Then, in Shopify admin

**Turn off hCaptcha on the account forms.** *Online Store → Preferences → Spam
protection*, uncheck login / create account / password recovery. This is the one
admin change that directly removes a blocker, and it is the same class of
decision as registering the crawler signature.

**Point the test customers' email addresses at the catch-all domain.** Shopify
sends the code to the address on the customer record and nowhere else, so this
is what makes the accounts drivable at all. It is a change to live customer
records — make it deliberately, and only for accounts that exist to be tested.

Sub-addressing (`shopper+anything@`) does **not** let one mailbox serve several
customers: Shopify identifies a customer by the exact address, so the address
the test polls is the address on the record.

## Then, in Good Looks!

*Settings → Integrations → Test mailbox*: paste the endpoint URL and the token.
The endpoint is stored in a plaintext register and the token encrypted, the same
split the Shopify crawler signature uses — so the standalone MCP server can tell
"no mailbox configured" from "one is, and I cannot read it".

## Running the suite unattended

Do **not** sign in on every test. Put the sign-in in one test with **session
saving** on, and have the rest start from it (*Variables → Login session*). The
saved state is good for 24 hours, which is what Shopify's own session cookie
lasts, so the code is paid once a day rather than once a test.

That is not only about speed. Five rejected codes locks the customer out for
thirty minutes, so every avoidable sign-in is a chance to spend the suite's
budget on nothing.

## Local development

```bash
npx wrangler dev
```

`http://localhost:8787` is accepted by the app's endpoint validation for exactly
this reason — every other host must be `https`, because the token rides every
request. `wrangler dev` does not receive real mail; to exercise the read path,
`wrangler kv key put` a record by hand in the shape `email()` writes.

## What it does not do

- **Send mail.** It is an inbox.
- **Store whole messages.** See above.
- **Serve a browser.** The endpoint answers `GET` with a bearer token and is
  read by a Playwright worker. There is no CORS header and nothing to open in a
  tab.
