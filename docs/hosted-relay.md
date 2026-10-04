# Proposal: a hosted relay, for people with no Cloudflare account (27 Sep 2026)

Status: **steps 2 and 3 built, and live at `https://relay.sasonica.com`**
(Worker `sasonica-relay`, South Pen Labs account; 4 Oct 2026, David: "let's do
it" — the hosted relay is next, ahead of any hosted compute). See "Built"
below. **Decided (David, 27 Sep 2026): self-hosting
is the free tier and what we build and support now; the hosted relay is a
later middle tier (a small fee against its $5/month running cost), with a
Sasonica account's premium features above it.** Answers `umbrella.md`'s open question, "a user
with no Cloudflare account and no domain".

## Why

Today every install is self-hosted: `sasonica install` deploys a Worker, a D1
database and (for sign-in) a KV namespace into the installing person's own
Cloudflare account. That costs them nothing on the free plan, and costs
South Pen Labs nothing at all. But it asks everyone to make a Cloudflare
account and an API token, which is the most technical step of the whole setup
and the one most people would stop at.

A hosted relay removes it: South Pen Labs runs the relay, the person's machine
runs only the runner, and pairing with the Sasonica app is the whole setup.
David, 27 Sep 2026: this may be a premium feature that needs a Sasonica
account.

## What must not change

- **One machine's shell is reachable only through that machine's own
  queue.** A leak, a bug or a bad command in one user's relay must not reach
  another user's machine. This is why `umbrella.md` keeps one Worker per
  machine rather than one Worker fronting many.
- **Rows are signed with the tenant's key, and the runner refuses anything
  unsigned.** Corrected 4 Oct 2026: the relay *does* hold that key — a
  self-hosted Worker holds it too (`SASONICA_HMAC_KEY`), because it is the
  Worker that signs each row. What the key buys is that the database alone
  cannot run anything. Hosted, it means South Pen Labs' relay could sign a
  row for any tenant: the same trust a person places in any relay that
  queues commands for them, and the hosted tier has to say so plainly.
- **Sign-in is approved on the owner's phone** (§6 of
  `tools-and-approvals.md`, `SASONICA_SIGNIN=app`), signed with the machine's
  key. It works unchanged hosted: the relay never sees the key.

## Options

| | Isolation | Cost to South Pen Labs | Notes |
|---|---|---|---|
| **Self-hosted (today)** | a Worker, D1 and KV per machine, in the user's account | $0 | needs a Cloudflare account |
| **Workers for Platforms** | a Worker per user in a dispatch namespace | $25/month base (20M requests, 1,000 Workers included), then $0.30/M requests, $0.02/Worker | the product made for this, but the base fee comes first |
| **One multi-tenant Worker, rows keyed by user** | in code only: every query must filter by tenant | $5/month (Workers Paid) | one missed `WHERE` is a cross-user shell; rejected |
| **One Worker, a Durable Object per user** (recommended) | each user's queue, sign-ins and grants live in their own Durable Object with its own SQLite storage; the Worker only routes to it | $5/month (Workers Paid), usage within its allowances for a long while | the isolation of separate Workers without the platform fee |

Prices from Cloudflare's pricing pages, 27 Sep 2026.

## Recommended: a Durable Object per user

- **Routing.** The Worker maps an incoming request to one Durable Object:
  the MCP endpoint by the OAuth grant's tenant, the runner by its runner
  token (hashed), the sign-in page by its pending sign-in. Nothing outside
  the object reads or writes its storage, so a routing bug can at worst reach
  the wrong object's front door, which still needs that object's credentials.
- **No polling.** Today each runner polls its Worker every 5 s, about half a
  million requests a month per machine, which is what dominates cost at
  scale. Hosted, the runner holds one WebSocket to its Durable Object
  (hibernation: an idle socket costs nothing) and is told when a row arrives.
  The self-hosted Worker can adopt the same later.
- **Storage.** The object's SQLite holds what D1 and KV hold today:
  `commands`, `signins`, `tools`, and the OAuth grants (the provider library
  takes a storage adapter, or the grants move into the object).
- **Joining.** `sasonica install --hosted` needs no Cloudflare token: it asks
  the hosted relay for a new tenant, bound to a Sasonica account (below), and
  gets back a runner token and its connector URL. The relay key is generated
  on the machine as today and never leaves it.
- **Accounts.** A tenant belongs to a Sasonica account
  (`agent-media docs/proposals/2026-09-23-accounts-and-the-identity-seam.md`):
  that is where "premium" is decided, and where a person sees and removes
  their machines. The account does not replace phone approval for sign-in;
  it decides who may have a tenant at all.

## Cost

$5/month for the Workers Paid plan covers the whole hosted relay at first.
With held connections instead of polling, a machine that is idle most of the
day costs a fraction of a cent a month; commands and tool calls are ordinary
requests (10M a month included). Durable Object storage is billed per GB
beyond what is included, and a user's queue is kilobytes.

## Order

1. Idle backoff in the self-hosted runner (poll every 30 s after a quiet
   spell): a sixfold cut in requests, useful today, small.
2. The runner's held connection, against a Durable Object, in the
   self-hosted Worker first — the same code the hosted relay would run.
3. The hosted Worker: tenant routing, `--hosted` joining, the tenant list
   per Sasonica account.
4. Billing, when accounts and the premium tier exist.

## Open questions

- Whether the OAuth provider library's KV storage can move into a Durable
  Object cleanly, or whether a small KV per region stays for grants.
- What a hosted user's connector URL looks like: a path per tenant on one
  host (`relay.sasonica.com/t/<id>/mcp`) or a subdomain each.
- Rate limits per tenant, and what happens to a tenant whose account lapses
  (its machine keeps its data; the relay stops routing).

## Built (4 Oct 2026)

- **`worker/src/tenant.ts`** — `TenantCore`, one tenant over its Durable
  Object's SQLite: the same `schema.sql`, and the same `runnerApi` and
  `mcpServe` as a self-hosted Worker, handed a D1-shaped binding
  (`d1Over`) over the object's own storage. The runner token and the
  connector secret are kept as sha256 only; the HMAC key is kept as is (see
  above). `relayFetch` routes `/t/<tenant>/…` to the tenant's object with the
  prefix taken off, so a machine's `SASONICA_WORKER_URL` is
  `https://<relay>/t/<tenant>` and **the runner and the connector URL are
  unchanged**: `/runner`, `/runner/ws`, `/<secret>/mcp` beneath it. A probe at
  a made-up tenant id is a 404 and creates no storage.
- **`worker/src/hosted.ts`** — the `Tenant` Durable Object and the entry
  point; `worker/wrangler.relay.jsonc` deploys it as `sasonica-relay`.
- **The doorbell.** A tenant never holds a claim open (a held request is
  billed by the second). The claim answers `doorbell: true`, and an idle
  runner keeps a WebSocket at `/runner/ws` (token as the first message —
  a WebSocket cannot set headers — then `ready`, then `ring` whenever a row
  is queued) and claims when it rings, or every 2 minutes regardless. The
  socket hibernates, and `ping`/`pong` is answered without waking the
  object. Measured under `wrangler dev`: a command round trip in 0.3 s, and
  **no requests at all from an idle runner** over 40 s; a relay restart is
  picked up and the next command runs. A self-hosted Worker never offers the
  bell, so nothing changes there.
- **Tenants kept apart, tested** (`tests/check-relay.mjs`, in CI): one
  tenant's runner token, connector URL and rows mean nothing on another.
  This found a real hole: the per-isolate cache of connector secrets was
  keyed by the secret's hash alone, so in an isolate serving two tenants,
  tenant A's URL secret, once looked up, would have opened tenant B's shell.
  The cache is now keyed by tenant too (`SASONICA_TENANT`).
- **Making a tenant:** `POST /tenants {account}` with `RELAY_ADMIN_TOKEN`
  answers the machine's `SASONICA_WORKER_URL`, `SASONICA_RUNNER_TOKEN`,
  `SASONICA_URL_SECRET`, the key for `relay.key`, and the connector URL —
  shown once.

**Not yet:** `sasonica install --hosted` (joining by a Sasonica account
sign-in instead of the admin token, which needs an OAuth client for the
relay on cms.sasonica.com); the tenant list per account; OAuth sign-in for
hosted connectors (the secret URL works today); rate limits; deleting a tenant (the live
test's, `vjky5htb3q34kiut`, is still there with its credentials thrown away).

**Deployed 4 Oct 2026**: `npx wrangler deploy -c wrangler.relay.jsonc` with
red5's `SPL_CLOUDFLARE_TOKEN`; `RELAY_ADMIN_TOKEN` is in red5's
`~/.config/sasonica-relay/admin.env`. A throwaway runner on red5 joined a
tenant made there and ran commands through the connector URL in 0.32 s each.
