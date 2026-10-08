# Proposal: a hosted relay, for people with no Cloudflare account (27 Sep 2026)

Status: **steps 2 and 3 built, and live at `https://relay.sasonica.com`;
ready to open as a free beta (8 Oct 2026, "Opening it" below) except for the
switch itself**
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

**Joining with a Sasonica account (built 4 Oct 2026, `worker/src/join.ts`,
`lib/hosted-join.mjs`):** `sasonica install --hosted` starts a join, prints a
link and a six-character code, and waits. The link signs the person in at
cms.sasonica.com (the public PKCE client `sasonica-relay`, made by websites
`drush/accounts-setup.php`); the relay asks userinfo who it was, checks
`RELAY_ALLOW_ACCOUNTS` (`<issuer>|<sub>`, or `*`; David's account only for
now), and shows a page naming the machine and the code with a **Join**
button. The button, not the sign-in, makes the tenant — so a join link sent
to someone else cannot quietly add a stranger's machine to their account.
The installer collects the credentials once and writes the env file
(`SASONICA_HOSTED=1`, `SASONICA_RELAY_URL`) and `relay.key`; a join expires
after 15 minutes. One Durable Object per join (`Join`), wiped by an alarm.

**Not yet:** OAuth sign-in for hosted connectors (the secret URL works today).
The account list, removal, rate limits and retention were built for opening
(below).

**Deployed 4 Oct 2026**: `npx wrangler deploy -c wrangler.relay.jsonc` with
red5's `SPL_CLOUDFLARE_TOKEN`; `RELAY_ADMIN_TOKEN` is in red5's
`~/.config/sasonica-relay/admin.env`. A throwaway runner on red5 joined a
tenant made there and ran commands through the connector URL in 0.32 s each.

## Opening it: a free beta (built 8 Oct 2026)

David, 8 Oct 2026: a **free beta first**, billing later. Built and deployed
(sasonica-shell `a3d7943`, `90e0bc5`; websites `f153eab`); `tests/check-relay.mjs`
has a case for each. What stays David's call: `RELAY_ALLOW_ACCOUNTS=*`.

- **Rate limits**, per minute, as vars in `wrangler.relay.jsonc`:
  `RELAY_JOIN_PER_MIN` 5 (`/join/start` and the account page's sign-in, per
  client IP), `RELAY_MCP_PER_MIN` 120 (per connector URL), `RELAY_RUNNER_PER_MIN`
  300 (per runner token; a busy runner claims every 5 s and sends a heartbeat
  per running job every 3 s). Over the limit is a 429 with `Retry-After: 60`
  (a JSON-RPC error for MCP); the runner waits it out and retries rather than
  lose a result. Counted exactly, in memory, in Durable Objects: a tenant
  counts its own calls keyed by the credential's hash (so a stranger guessing
  at a tenant's URL spends their own allowance, not the owner's), and a
  `Limiter` object per client IP counts joins. Never per IP for MCP: an
  assistant's calls come from its vendor's servers. Cloudflare's rate-limit
  binding was tried first and, deployed, let every request through (40 joins
  a minute from one IP, 140 MCP calls against 120) though it worked under
  `wrangler dev`. Measured live after the change: 120 pings then 429; the 6th
  join in a minute refused; ten calls at a wrong URL left the owner's 120 intact.
- **One machine per account** (`RELAY_MACHINES_PER_ACCOUNT`, 1). A second join
  **replaces** the first rather than being refused: reinstalling, or moving to
  a new computer, is the common case, and refusing would send the person off
  to find a remove page first. It is safe because only the account's owner
  gets to the Join page (signed in, matching the code), and the page says
  before the button which machine goes ("Replace and join"). The new tenant
  is made first; the old one is removed only once that worked.
- **Retention on the relay**, whatever the client does: each tenant has a
  daily alarm that deletes command rows older than `RELAY_KEEP_DAYS` (30,
  pending or not) and sign-ins older than a day, and removes the tenant
  outright (from its account's list too) when no runner has been in touch for
  `RELAY_DORMANT_DAYS` (90). Runner contact is the runner API or the doorbell
  with its token, written at most hourly. A tenant made before this gets its
  alarm on first use, and its clock starts then.
- **An account's machines.** An `Account` object per account lists its tenants
  (ids, machine names, dates; no credentials). `https://relay.sasonica.com/account`
  signs in at cms.sasonica.com (the same `sasonica-relay` client and redirect
  URI as joining, told apart by the state) and lists the machines with when
  each was last seen and a **Remove** button. The same with any Sasonica access
  token: `GET /account/machines`, `DELETE /account/machines/<tenant>`
  (`Authorization: Bearer`). Removing deletes the tenant's storage at once.
- **Account deletion.** `sasonica_oidc` (websites) implements
  `hook_user_delete`: it posts `{account: "https://cms.sasonica.com|<uid>"}` to
  `/hooks/account-deleted` with `SASONICA_RELAY_HOOK_TOKEN` (red4's
  `sasonica/app.env`; the Worker secret `RELAY_ACCOUNT_HOOK_TOKEN`, a token
  that can do nothing else). A failed call is retried on cron for 90 days. The
  delete page says relay machines go. Tested live: a throwaway account's
  tenant was gone the moment the account was deleted.
- **Found on the way:** cms.sasonica.com refused every account but the admin
  (`access_denied`), because the authenticated role lacked simple_oauth's
  `grant simple_oauth codes`. Granted (websites `29ddbf0`); `/account` then
  signed in as `sasonica-test2` live and listed its (no) machines. The same
  fix applies to the app's sign-in for anyone but David.
- **Admin** (`RELAY_ADMIN_TOKEN`): `GET`/`DELETE /admin/tenants/<id>`,
  `POST /admin/tenants/<id>/index` (lists a tenant made before the account
  list under its account), `GET /admin/accounts/<account, URL-encoded>`.
- **Removed:** the 4 Oct live test's tenant `vjky5htb3q34kiut` (its account
  was literally `live-test (David, 4 Oct 2026)`, its credentials long thrown
  away). No other tenant id was known; David's account had none listed. A
  tenant joined before 8 Oct that is still in use can be listed with the
  `index` route above.

### The Windows end-to-end run (passed 8 Oct 2026)

A second account for it: **`sasonica-test2`** (uid 5, davidj4test1@gmail.com),
made 8 Oct 2026; its password is in red5's
`~/.config/sasonica-relay/test2.env` (0600), or use "Forgot password" with the
test address. It is **allowed** on the relay beside David's (74fc418,
deployed 8 Oct 2026), kept for future runs. The line in
`worker/wrangler.relay.jsonc`:

```jsonc
    "RELAY_ALLOW_ACCOUNTS": "https://cms.sasonica.com|1,https://cms.sasonica.com|5",
```

and deploy it (red5, from `worker/`):

```sh
set -a; . ~/.config/cloudflare/env; set +a
CLOUDFLARE_API_TOKEN=$SPL_CLOUDFLARE_TOKEN npx wrangler deploy -c wrangler.relay.jsonc
```

Then on the Windows machine (Windows PowerShell 5.1, no Cloudflare account):

1. `irm https://sasonica.com/install.ps1 | iex` — downloads the repo to
   `%LOCALAPPDATA%\sasonica\shell`, gets Node if missing, runs
   `install.ps1 -Hosted`; it prints a link and a six-character code.
2. Open the link, sign in as `sasonica-test2`, check the code matches, press
   **Join**. The installer finishes on its own: `%APPDATA%\sasonica\env` has
   `SASONICA_HOSTED=1` and a `https://relay.sasonica.com/t/<tenant>` Worker
   URL, and the Scheduled Task is running.
3. Add the connector URL it printed to an assistant (claude.ai: Settings,
   Connectors), and run `hostname` and `Get-Date` through it; then a 40-second
   command with `wait: 0`, `get_result` with a wait, and `cancel` on a
   `Start-Sleep 120`.
4. `https://relay.sasonica.com/account` signed in as `sasonica-test2`: the
   machine is listed with a recent "last seen".
5. Run the installer again on the same machine: the Join page offers
   **Replace and join** naming the old one; after it, the first tenant's URL
   is a 404 and the new one works.
6. Remove it on `/account`: the runner's requests start failing (404) and the
   connector says nothing is there. Optionally delete `sasonica-test2` at
   cms.sasonica.com and check `/hooks/account-deleted` left nothing
   (`GET /admin/accounts/https%3A%2F%2Fcms.sasonica.com%7C5`).
7. Put `RELAY_ALLOW_ACCOUNTS` back to David's alone (or open it) and deploy.

**Run on GitHub's Windows runner, 8 Oct 2026** (`.github/workflows/
windows-hosted-e2e.yml`, manual only; red5 has no KVM for a Windows VM).
The job runs the real one-liner on windows-latest (Windows Server 2025,
10.0.26100) and posts the join link, then the connector URL encrypted to a
key passed in, as check runs (a step's log can't be read until the job
ends); red5 signed in as `sasonica-test2` with headless Chromium and pressed
Join. Results:

- [Run 37701441963](https://github.com/davidj4tech/sasonica-shell/actions/runs/37701441963):
  joined; the installer's smoke test queued `echo sasonica-ok` through the
  hosted relay and read it back; the Scheduled Task reported **Running**
  (the worry that an Interactive task would sit at Ready on a runner with no
  one logged on didn't happen); the connector URL printed as `<secret>`.
  The job then failed on the workflow's own bug (an empty ExitCode from
  Start-Process without its handle held), fixed in 2e6dba9.
- [Run 37701570159](https://github.com/davidj4tech/sasonica-shell/actions/runs/37701570159):
  all steps green. The Join page replaced the first run's machine ("Removed
  from your relay: runnervmfi6oq"; its tenant then 404). An MCP client on
  red5 (initialize, then `tools/call run_command`) ran `hostname; uname -a;
  cmd.exe /c ver` on the runner through the relay: `runnervmfi6oq`, MSYS on
  Windows 10.0.26100, `Microsoft Windows [Version 10.0.26100.33438]`, exit 0.
- Cleanup: both tenants removed (404), the account's machine list empty,
  the run cancelled, the key pair deleted.

Not covered by this run: a person adding the connector to claude.ai, the
long-command `wait: 0` / `get_result` / `cancel` steps, and the
`/account` Remove button (each tested on Linux).

### Opened 8 Oct 2026

`RELAY_ALLOW_ACCOUNTS=*` deployed on David's go-ahead (6af1773): any
Sasonica account can join one machine. What was on the list before it:

#### Before opening (all done)

- ~~Publishing Google sign-in~~: published 8 Oct 2026.
- ~~The terms of service~~: published at sasonica.com/terms
  8 Oct 2026 (websites `sites/sasonica/content/terms-of-service.md`).
- The privacy policy's "not yet open to everyone" line, changed on opening;
  sasonica.com/start and /download's "coming soon" for Windows.
