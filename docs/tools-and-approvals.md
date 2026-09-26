# Typed tools, phone approvals, and assistants as threads (proposal, 21 Sep 2026)

Status: **§1 typed tools and §3's client labels are built** (23 Sep 2026); the
rest is proposal. How Sasonica Shell and the assistants that use it
(Claude.ai, ChatGPT custom connectors, any remote MCP host) fit into the
Sasonica umbrella (`umbrella.md`) beyond "a shell with a skills list".

Six changes, most useful first. The first two are the ones worth building
soon; they reinforce each other.

## Where it stands

- An assistant gets one real capability, `run_command`, which is any
  `bash -lc` string as the user. Four tools in all (`worker/src/index.ts`).
- The skills directory tells it what is worth running. On red5 today:
  `agent-mail`, `agent-memory-search`, `claude-sessions`, `music`,
  `music-transit`, `red5-map`, `speak`. To use one, the assistant runs
  `sasonica skills`, reads a SKILL.md, then composes a shell command from the
  prose. That is three round trips before the first useful call, and the
  command is free text every time.
- **The HMAC protects D1, not the Worker.** The Worker holds
  `SASONICA_HMAC_KEY` and signs whatever the secret URL asks for. So whoever
  holds the URL has a shell, and nothing on the runner can tell a legitimate
  row from one queued by a leaked URL. The README says so plainly ("no
  command allowlist"). Everything below keeps that true for `run_command`
  and adds a narrower door beside it.

## 1. Typed tools — BUILT 23 Sep 2026

Built as proposed, with three differences, each noted where it belongs
below: the manifest goes to the Worker **without its argv**; the runner
publishes through the existing `/runner` API (`op: "tools"`) rather than a
path of its own; and there is no `tools/list_changed` notification, because
this transport has no way to push one.

**Idea:** a skill can declare actions with typed arguments. The runner
publishes them; the Worker lists them as ordinary MCP tools; a call runs a
**fixed argv template** with the arguments filled in, **never through a
shell**.

### The manifest

A sidecar, not new keys in SKILL.md: those files are shared with Claude
Code and the other harnesses through agent-config, and they are read as
prose. `~/.config/sasonica/tools/<skill>.json`:

```json
{
  "skill": "speak",
  "tools": [
    {
      "name": "speak",
      "description": "Say something out loud to David through agent-media's voice.",
      "input": {
        "type": "object",
        "properties": {"text": {"type": "string", "maxLength": 2000}},
        "required": ["text"]
      },
      "argv": ["media", "say", "--", "{text}"],
      "timeout_s": 30
    }
  ]
}
```

- `argv` is an array; each `{name}` is replaced by exactly one argument,
  never split and never interpreted. Run with `execFile`, no shell, so there
  is no quoting to get wrong and no injection to defend against.
- `input` is JSON Schema. It is checked by the Worker (for a quick, useful
  error) **and again by the runner** (the check that counts).
- Tool names get a prefix on the wire (`speak__speak`,
  `music__music_play`), so a skill cannot shadow `run_command`.

### How it flows

1. **Publish.** On start, and whenever the manifests change, the runner
   sends `{"op": "tools", "runner": "<host>", "tools": [...]}` to `/runner`
   (the API it already uses, behind the same bearer token). **AS BUILT:**
   each entry is the name, the description, the input schema and the
   sha256 — **not the argv**. The Worker cannot leak, and cannot be
   tricked into changing, a command it was never told. The table is
   `tools(runner, name, description, input, sha256, updated_at)`, and a
   publish replaces that runner's whole set, so a deleted tool stops being
   listed.
2. **List.** `tools/list` answers the four built-ins plus every published
   tool. **AS BUILT:** there is no `notifications/tools/list_changed` — the
   Worker answers requests and holds no connection to push one down. A
   client that caches the list sees a new tool when it next lists.
3. **Call.** `tools/call speak__speak {"text": "…"}` queues a row with
   `kind = 'tool'` and `command = {"tool": "speak__speak", "args": {…},
   "manifest_sha": "…"}` (canonical JSON), signed exactly as today — the
   signing scheme and its test vectors do not change.
4. **Run.** The runner re-validates the arguments against **its own copy**
   of the manifest, rejects a `manifest_sha` it does not have, builds the
   argv and runs it. The result goes back exactly as today, so
   `get_result`, `detach` and `cancel` work unchanged.

**What a leaked URL can do with a tool row:** call a tool the owner
declared, with arguments that pass the runner's schema. It cannot change
the argv — the template lives only on the runner. That is the whole point:
a tool row is safe to run without asking; a free-text row may not be (§2).

### The first manifests

`tools.example/agent-media.json` in this repo, copied to
`~/.config/sasonica/tools/`: `speak(text)`, `music_now()`, `music_pause()`,
`music_resume()`, `memory_search(query)`. Each is a thin argv over a command
that exists today.

`music_play(query)` is **not** among them, and the reason is the shape of
the idea: playing something by name is a search and then a play, which no
fixed argv can be. Tools here are the calls that are one command; anything
that needs a decision in the middle stays with `run_command`. `mail_send`
and `mail_inbox` want an `--agent` identity chosen per caller, so they wait
for §2 as well. `ask_session` is §4.

`sasonica tools` prints what this machine publishes, argv and all.

### Worker and runner changes

- Worker: the `tools` table, `POST /runner/tools`, merging tools into
  `tools/list`, `kind` on the row (`ALTER TABLE commands ADD COLUMN kind
  TEXT NOT NULL DEFAULT 'shell'`), schema validation, `list_changed`.
- Runner: load the manifests, publish them, and for `kind = 'tool'` spawn
  the argv directly instead of `bash -lc`. No new dependencies — the schema
  subset (type, required, enum, pattern, min/max, maxLength, and an array
  of strings) is small enough to check by hand, and it is checked in both
  places.
- **As built:** `wait` keeps its built-in meaning on a typed call (how long
  to block for the result) unless the tool declares an argument of that
  name. An optional argument that is not given drops its argv element, so
  `["media", "say", "{voice}", "{text}"]` with no voice is two elements.
  The sha256 is over everything that decides what runs (name, description,
  input, argv, timeout), so editing a manifest refuses calls queued against
  the old one. `timeout_s` is the tool's own limit, capped by the machine's
  `SASONICA_CMD_TIMEOUT` — a tool may ask for less time, never for more.
  Note that a tool which waits on something (`media say` waits for the words
  to be spoken, behind whatever speech is already queued) holds the serial
  lane while it does; that is `run_command`'s behaviour too, and §2's
  approvals are where per-tool scheduling belongs.
- Tests: `tests/check-worker.mjs` (publish, list, a call queued as a row,
  bad arguments refused before the queue, an unpublished tool, a name that
  would shadow a built-in) and `tests/check-runner.mjs` (the argv runs, an
  argument cannot widen it — `; touch marker; rm -rf ~` arrives as one
  element and no marker appears — an optional argument drops out, a changed
  manifest refuses an old call, the runner checks the arguments itself, and
  a bad signature is still refused).

## 2. Approvals on the phone

**Idea:** a runner-side policy decides which rows run straight away and
which wait for a tap in the Sasonica app. The approval **never passes
through the Worker**, so a leaked connector URL cannot approve its own
commands.

### Policy

`~/.config/sasonica/policy.json`, read by the runner:

```json
{
  "tool": "run",
  "shell": "approve",
  "shell_allow": ["^git (status|log|diff)\\b", "^ls\\b", "^cat \\S+$"],
  "approve_timeout_s": 300
}
```

- `tool` rows run (their argv is fixed by the owner).
- `shell` rows either `run` (today's behaviour, and the default so nothing
  changes for existing users), `approve`, or `refuse`. `shell_allow`
  patterns run without asking.
- A policy that is missing or unreadable means today's behaviour, and the
  runner logs this at start. Failing closed would break every existing
  install on upgrade.

### The path

1. The runner claims a row that needs approval and writes status
   **`awaiting`** (new; `get_result` shows it, so the assistant can tell
   the person "approve it on your phone").
2. The runner asks agent-media, **locally** (a unix socket or
   `127.0.0.1`, never the Worker): "row 42 from `claude.ai` wants to run
   `<command>`". agent-media puts it in the app as an approval, the same
   tool UI the app uses for permission prompts (server-contract §14).
3. The person taps allow or deny in the app. That request reaches the
   Sasonica server with the app's device token (server-contract §9). The
   runner is told locally, then runs or rejects.
4. No answer within `approve_timeout_s` → `rejected` with "not approved".

The approval travels phone → agent-media → runner. The Worker only ever
sees the final status. A leaked URL can queue rows, but approving them
takes the phone.

Without agent-media installed, `approve` falls back to a desktop
notification with a local confirm command (`sasonica approve 42`) — so
Sasonica Shell stays usable on its own, as its README promises.

## 3. Assistants as threads in the app

**Idea:** what a third-party assistant does through Sasonica Shell shows up in the
Sasonica app as a thread, next to the desk's Claude Code sessions. The phone
becomes the one place to see what every agent is doing.

- **Who asked. Done.** Two answers, side by side on every row:
  - `client`: **one connector URL per client**. A `clients(label,
    secret_sha256, created_at, revoked_at)` table beside the shared
    `SASONICA_URL_SECRET` (label `default`), managed with `sasonica client
    add|list|revoke` using the installer's Cloudflare token, never the
    runner's. It gives per-client revocation (within the Worker's 30 s
    cache) instead of rotating the one secret everyone shares.
  - `agent`: what the assistant calls itself — `clientInfo.name@version`
    from `initialize`, else `ua:<User-Agent>`. The Worker hands it back in
    a signed, stateless `Mcp-Session-Id` (key derived from
    `SASONICA_HMAC_KEY`, bound to the URL's label) and reads it on later
    requests; a client that does not echo it still works. Attribution on a
    shared URL, not security.
  - `name`: a label the caller puts in the URL, `/<secret>/<name>/mcp` or
    `?as=<name>` (`sasonica url --name`); it tells apart connectors on one
    secret, and is in the session id's MAC, but grants nothing.

  `sasonica status` shows `client/agent`, or `client/name (agent)` when the
  URL carried a name; the thread below can name itself from them.
- **The thread.** The runner already sees every row. It appends each row
  (client, command or tool call, status, trimmed output) to a local
  journal, and agent-media reads that journal as a thread source. In
  `/targets` the thread is "Sasonica Shell · claude.ai", and each row is a message:
  the command as the user turn, the output as the reply. The thread is
  read-only in v1. Replying from the app would mean pushing text back into
  a third-party chat, and nothing supports that.
- **Nothing new in the Worker** beyond the client label. D1 stays a queue,
  not an archive, which matters for the read quota.

## 4. Desk sessions from anywhere

**Idea:** an `ask_session` tool (a §1 manifest) lets Claude.ai or ChatGPT hand
work to a Claude Code session and read its answer.

- `sessions_list()` → the rows of agent-media's `/targets`.
- `ask_session(session, text)` → the same routing `/ask` and `/reply` use
  (a new chat, or into a live or revived session), returning the session
  id.
- `session_log(session, since)` → the conversation log's lines after
  `since`.

These go through agent-media's own CLI (`media ask …`, `media session-log
…`, the latter new) rather than HTTP, so no token is needed on the runner.
The app contract's rules still apply: only directories `/targets`
published, and never raw keystrokes.

The typing lands in David's real sessions, so `ask_session` should default
to `approve` in the §2 policy even though it is a typed tool — a per-tool
override: `"tool_overrides": {"claude_sessions__ask_session": "approve"}`.

## 5. Push instead of polling

The runner polls the Worker, and the Worker reads D1 on every poll. The
tmux-relay's poll ran D1 out of daily reads once (agent-media memory
`d1-quota-clips-silently`); Sasonica Shell has the same shape.

**A Durable Object per runner**, holding a WebSocket from `sasonica.mjs`:
- the Worker notifies the DO when it enqueues a row;
- the DO pushes "work available" down the socket;
- the runner claims as it does now.

D1 stays the record. Polling is kept at a slow interval as the fallback for
networks that drop long-lived sockets. The payoff: commands start in tens
of milliseconds instead of a poll interval, and idle D1 reads drop to
almost nothing. This is the least urgent of the five — the queue works —
but it is the one that makes interactive use (§4) feel immediate.

## 6. Sign-in instead of a secret URL

**Status, 27 Sep 2026: the Worker half is built, off until configured.**
`worker/src/oauth.ts` wraps the MCP endpoint in `workers-oauth-provider`
with Cloudflare Access (an Access for SaaS OIDC app) as the sign-in: the
consent page names the assistant and where its access goes, Allow hands off
to Access, and the callback checks the ID token (RS256 against the app's
JWKS, issuer, audience, expiry) and that its email is
`SASONICA_OWNER_EMAIL` before granting. Rows an OAuth connector queues are
labelled `oauth-<its name>`. It switches on only when `OAUTH_KV`,
`ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_TEAM_DOMAIN` and
`SASONICA_OWNER_EMAIL` are all set; until then the Worker is unchanged,
and with it on the secret URLs keep working beside it.
`tests/check-oauth.mjs` runs the whole flow in Node against a stand-in
Access that signs real tokens, and the refusals (another email, an
unverified one, a forged signature, the wrong audience, Deny, a callback or
consent post from another browser, markup in a client name).
The installer turns it on when given `SASONICA_OWNER_EMAIL`: a KV
namespace, an owner-only Access policy and an Access for SaaS app, and the
secrets (SETUP.md, "Sign in instead of a secret URL"). `sasonica client
grants` lists the signed-in assistants and `revoke oauth-<name>` signs one
out, through the runner API: revoking only takes access away, so unlike
minting a URL it needs no Cloudflare token. **Not yet run against a real
account**: the Access API shapes are from Cloudflare's docs and pinned in
check-install, not tried.

**The problem.** The connector URL is the only credential, and it opens a
shell as the owner. URLs travel further than passwords do:
- they are stored in each assistant's connector settings, so Anthropic's and
  OpenAI's security is part of ours;
- they end up in history and screenshots;
- they are **probably recorded in Cloudflare's own Workers Logs**:
  `observability` is on, and the path holds the secret. Not verified — the
  install token cannot read logs.

A leak is silent and lasts until the secret is rotated. §2 approvals limit
what a leaked URL can *do*; this section removes the secret from the URL.

**The idea.** The Worker becomes an OAuth 2.1 authorization server for its
own MCP endpoint, and it delegates the question "is this the owner?" to an
identity provider the installer sets up.

```
assistant ──(adds connector: plain URL, no secret)──▶ Worker /mcp → 401
assistant ──registers itself (dynamic client registration)──▶ Worker
you ──sent to Worker /authorize──▶ identity provider ──"yes, it's you"──▶ Worker
Worker ──issues an access token (expiring, revocable, per assistant)──▶ assistant
assistant ──Bearer token on every call──▶ Worker /mcp
```

- **Library:** Cloudflare's `workers-oauth-provider`, the documented way to
  put OAuth in front of an MCP server on Workers. It handles discovery, dynamic
  client registration, PKCE, and token storage in KV, with the grant
  encrypted so KV alone cannot mint access.
- **Per-assistant identity comes free.** Each connector registers as its own
  OAuth client and gets its own grant, so `client` on a row becomes the
  registered client — trustworthy, and revocable one at a time without
  inventing secrets (§3's per-client URLs become unnecessary for this).
- **Revocation and expiry:** `sasonica client list` shows the grants and
  `revoke` ends one. Access tokens expire, and refresh tokens are revocable.

### The identity provider (the installer's question)

`sasonica install shell` asks how the owner proves who they are:

| Provider | How | Setup the installer can do |
| --- | --- | --- |
| **The Sasonica app (recommended)** | The authorize page shows "approve on your phone" plus a short code; the app, holding its paired device token (agent-media server contract §9), shows the request, and a tap approves it | Nothing extra — pairing already happened. The Worker must reach the approval, which needs the Sasonica link (Tunnel) or a relay through the Worker the app polls. **Open question**, below |
| Cloudflare Access | Access protects `/authorize`; one-time PIN to the owner's email, or a Google/GitHub login configured in Access | Fully automatic with one more token permission (Access: Apps and Policies: Edit) |
| GitHub or Google OAuth | `/authorize` redirects to the provider; the Worker checks the returned account against the owner's | The OAuth app is created by hand in their console; the installer asks for the client id and secret |

**Why the phone.** It makes the phone the one identity across the umbrella:
pairing the app, signing a connector in, and (§2) approving a command become
the same gesture. It also needs no third-party account, which matters once
people other than David install this. Cloudflare Access is the fallback for
an install with no app.

### Migration

- The secret URL keeps working **alongside** OAuth until the owner turns it
  off: `sasonica client revoke default`, which exists today.
- Named URLs (`/<secret>/<name>/mcp`) stay meaningful only on the secret
  path. With OAuth, the name comes from the registered client, or a name the
  owner gives the grant when approving it.
- Turn off URL logging (or strip the path from what is logged) regardless of
  OAuth: that is a small change, and worth doing first.

### Open questions — verify before building

- **What each assistant supports today.** Claude.ai and ChatGPT custom
  connectors both document OAuth with dynamic client registration, but the
  details (scopes, whether refresh tokens are used, redirect URI allow-lists,
  whether a no-auth connector can be switched to OAuth in place or must be
  re-added) have changed before. Check their current docs and test each.
- **How the phone approval reaches the Worker.** The Worker is on Cloudflare
  and the app talks to agent-media over the tailnet. Either the Worker holds a
  pending approval that the app fetches (the Worker then needs to trust the
  device token — a verification key shared at pairing), or the approval goes
  phone → agent-media → Worker over the Sasonica link. The first is simpler
  and keeps the link optional.
- **Prompt injection is untouched.** OAuth proves the connector is yours; it
  does not stop your own assistant from being talked into running something.
  That remains §2's job.

## Order

1. §3's client labels — tiny, and every later step wants to know who asked.
   **Done**, with the self-reported agent name alongside.
2. §1 typed tools, with the agent-media manifests. **Done** (23 Sep 2026).
3. §2 policy and approvals — needs the app's approval UI (the rebuild, in
   progress) and a local approval endpoint in agent-media.
4. §4 `ask_session`, gated by §2.
5. §3's thread view in the app.
6. §5 when latency or the D1 quota starts to matter.
7. §6 in two parts: stop logging the URL path now (small); OAuth with
   Cloudflare Access first (fully automatic), then the phone as the identity
   provider once the app's pairing and approvals exist.

## Not proposed

- **A command allowlist in the Worker.** The Worker is exactly the party
  that cannot be trusted with the decision; the runner is.
- **Folding the Sasonica link into Sasonica Shell.** Settled in `umbrella.md`: two
  transports, two credentials, two off switches.
- **Persistent shells.** Still out, for the reasons in the README.
