# Sasonica Shell

Run shell commands on your own computer from an AI assistant, without opening an inbound port, exposing SSH, or keeping an agent runtime on the machine.

Sasonica Shell is the shell piece of [Sasonica](docs/umbrella.md). It was called Runlet until 21 September 2026; an install made under that name moves across with [MIGRATING.md](MIGRATING.md).

Sasonica Shell is deliberately small. A remote MCP client queues a signed command through a Cloudflare Worker; a local runner polls for it, verifies it, runs it, and writes the result back.

```text
assistant  ──MCP──▶  Cloudflare Worker  ──▶  signed row in D1
                                                   ▲
your machine ◀──────── sasonica.mjs polls, verifies, runs, returns output
```

The local machine only makes outbound HTTPS requests. It needs no public IP, open port, VPN, or inbound firewall rule.

> [!WARNING]
> Sasonica Shell executes shell commands **as your user**. Anyone who has the secret connector URL can ask the Worker to queue commands for that machine. Treat the URL like a password, and only give it to assistants or clients you trust.

## What Sasonica Shell is

Sasonica Shell is a small remote-execution primitive, not an agent framework. It does one job: give an MCP-capable assistant a shell on a machine you control.

That makes it useful on its own, or as a low-level building block underneath larger agent, automation, CI, homelab, and administration workflows.

It works with MCP clients that can connect to a remote server by URL, including Claude clients, ChatGPT custom connectors where available, and other MCP hosts.

## Tools

Sasonica Shell exposes four MCP tools:

| Tool | Purpose |
|---|---|
| `run_command` | Queue a shell command and optionally wait for its result. |
| `get_result` | Fetch a queued command later, optionally waiting for completion. |
| `detach` | Let an already-running command continue without holding the foreground queue. |
| `cancel` | Stop a pending command, or kill a running command and its process group. |

A short command can usually be handled in one call:

```text
run_command("uname -a")
```

For a long command, start it in the background and collect it later:

```text
run_command("make test", background=true, wait=2)
get_result(id=42, wait=30)
```

If a foreground command turns out to be slow, `detach` lets it keep running while later commands move through the queue. `cancel` stops a queued command before it starts, or asks the runner to terminate a running process group.

Each command starts in a fresh `bash -lc` shell. Shell state, including the working directory, does not persist between calls, so use `cd` in the command when needed.

## Skills

A shell alone does not tell an assistant what is worth running. List the tools you have set up on the machine, one file per tool, in `~/.config/sasonica/skills/`:

```bash
ln -s ~/projects/agent-mail/skills/agent-mail/SKILL.md ~/.config/sasonica/skills/agent-mail.md
```

Each entry is a Markdown file, a symlink to one, or a directory containing a `SKILL.md`. Its frontmatter should give a `name:` and a `description:`. The `run_command` description tells the assistant to start with `sasonica skills`. The installer puts a `sasonica` command in `~/.local/bin`, and `sasonica --help` points there too. That command prints each skill's name, its description and the path to read before using it. Where `~/.local/bin` is not on the login-shell `PATH`, `"$SASONICA" skills` works instead: the runner sets `$SASONICA` for every command it runs. Nothing is found by scanning the disk: a tool is listed only when you put it in this directory.

## Typed tools

A skill can also declare **actions with typed arguments**, in
`~/.config/sasonica/tools/<skill>.json`. Each one names a fixed argv, and a
call fills the arguments into it and runs it **directly — never through a
shell**:

```json
{"skill": "media",
 "tools": [{"name": "speak",
            "description": "Say something out loud through agent-media's voice.",
            "input": {"type": "object", "required": ["text"],
                      "properties": {"text": {"type": "string", "maxLength": 2000}}},
            "argv": ["media", "say", "--", "{text}"],
            "timeout_s": 60}]}
```

`tools.example/agent-media.json` is a working set (speak, music now / pause /
resume, memory search); copy it there to try it. The runner publishes them to
the Worker at startup and whenever a manifest changes, and the assistant sees
them as ordinary MCP tools named `<skill>__<tool>` — `media__speak`.
`sasonica tools` prints what this machine publishes, argv and all.

**Why bother, when `run_command` can do anything?** Because the argv never
leaves the machine. The Worker is told the name, the description and the
schema; it can queue a call to a tool you declared, with arguments that pass
your schema, and nothing else. An argument is one argv element whatever is in
it — `; rm -rf ~` is a string that happens to contain semicolons. So a typed
call is safe in a way a free-text command is not, which is what the approvals
in `docs/tools-and-approvals.md` will build on. Only calls that are *one
command* belong here: playing music by name is a search and then a play, so
it stays with `run_command`.

## How it works

1. The MCP client calls the Worker through a secret URL.
2. The Worker creates a nonce, signs `nonce + "\n" + command` with HMAC-SHA256, and writes the command to D1.
3. `sasonica.mjs` polls its Worker over HTTPS, with a per-machine bearer token; the Worker is the only thing that touches D1.
4. The runner verifies the signature and rejects reused nonces.
5. The runner atomically claims the row, then executes the command locally.
6. Output, exit status, runner identity, and final state are written back to D1.
7. The Worker returns the result to the MCP client, or the client retrieves it later with `get_result`.

There is no persistent shell session between calls, and no requirement for Claude Code, tmux, SSH, or a local AI runtime.

## Install

For the complete walkthrough, see **[SETUP.md](SETUP.md)**.

The short version for an existing Cloudflare user:

1. Create a Custom API token with these **Account** permissions:
   - **Workers Scripts: Edit**
   - **D1: Edit**

   Those two are the whole of provisioning, and the installer needs them once — nothing is left on the machine afterwards. See [Why only two](SETUP.md#why-only-two). It no longer leaves a Cloudflare token on the machine at all: the runner reaches its queue through its own Worker with a per-machine bearer token. See [Use a separate token per machine](SETUP.md#use-a-separate-token-per-machine) for the background.
2. Run the installer:

   ```bash
   ./install.sh
   ```

   On macOS, install [Homebrew](https://brew.sh) first; the same `./install.sh` sets up dependencies and a login LaunchAgent.

   On Windows, run `.\install.ps1` from PowerShell. It is a native installer: no WSL2, no Ubuntu. The runner there is the same `sasonica.mjs` under Node, started by a Scheduled Task at logon. With no clone at all, `irm https://sasonica.com/install.ps1 | iex` downloads this repository (`get.ps1`) and joins the hosted relay with a Sasonica account — no Cloudflare account needed (`install.ps1 -Hosted`, or `--hosted` to `install.sh`/`install.mjs`, does the same from a clone).
3. Add the printed `https://.../<secret>/mcp` URL to your MCP client as a remote/custom connector with no additional authentication.

The installer creates the D1 database, applies the schema, creates the Worker, generates the signing key and URL secret, stores the required Worker secrets, deploys the Worker, runs an end-to-end smoke test, writes the local config, and starts the runner as a systemd user service (Linux), a LaunchAgent (macOS), or a Scheduled Task (Windows). The runner is the same `sasonica.mjs` on all three.

Re-running the installer is safe. Existing IDs and secrets are reused unless you deliberately rotate them. Once a machine has the `sasonica` command, `sasonica install` re-runs it from anywhere, with the same flags (`--no-service`, `--print-url`); `sasonica install shell` is the same thing, named the way the [umbrella](docs/umbrella.md#installer-shape) names its pieces.

Several machines can share one Cloudflare account. Each gets its own Worker and D1 database named `sasonica-shell-<site>`; the site name defaults to the hostname. Copy `install.conf.example` to `install.conf` if you want to pre-answer the installer prompts.

## Security model

Sasonica Shell is intentionally capability-based and minimal. It does not try to be a multi-user authorization system.

### Secret connector URL

The endpoint is `/<secret>/mcp`, or `/<secret>/<name>/mcp` with a name that only labels the rows (see *Several assistants*); other paths, and revoked secrets, return 404. The secret is five random words from the bundled EFF short wordlist by default, roughly 52 bits of entropy. The comparison is constant-time.

Use `SASONICA_SECRET_WORDS=6` during installation if you want a longer secret. Fewer than four words are refused.

To rotate a leaked connector URL, remove `SASONICA_URL_SECRET` from `~/.config/sasonica/env` and run the installer again. If each assistant has its own URL (below), revoke just the one that leaked instead.

### Several assistants

One shared URL is fine for several assistants: Claude.ai, ChatGPT and a phone app can all use it, and every row still says who asked (see *Who asked*, below).

To tell connectors on the same secret apart, give each a name in its URL. The name goes between the secret and `/mcp`, so the URL still ends in `/mcp` (some connector UIs check):

```text
https://sasonica-shell-example.example.workers.dev/<secret>/desk/mcp
https://sasonica-shell-example.example.workers.dev/<secret>/phone/mcp
```

`sasonica url --name desk` prints the first; `sasonica url` alone prints the bare shared URL. A name is `[a-z0-9._-]`, up to 32 characters, lowercased; anything else in that slot is a 404. `?as=desk` on either form works too (the path wins if both are given; an invalid `?as=` is ignored). **The name is not a credential**: the secret alone decides access, and it works under any name, so every form of the URL is a password.

Give an assistant a URL of its own when you want to be able to cut it off without re-pasting a new URL into all the others:

```bash
sasonica client add chatgpt      # prints https://.../<secret>/chatgpt/mcp once
sasonica client list             # label, created, revoked, last used
sasonica client revoke chatgpt   # that URL is a 404 within 30 seconds
```

`add` prints the named form, with the label as the name, so the URL says whose it is; the secret still decides the client. Only the sha256 of each secret is stored, so the URL cannot be printed again; `add` a new label, or revoke and re-`add` the same one, if it is lost. A revocation takes effect within **30 seconds**: each Worker isolate remembers a lookup for that long so that a burst of calls costs one D1 read. The shared URL is the client `default`; `sasonica client revoke default` turns it off (per-client URLs keep working) until you rotate `SASONICA_URL_SECRET`.

These commands write the `clients` table with the Cloudflare token the installer used, from `CLOUDFLARE_API_TOKEN` or `~/.config/sasonica/install-token`. The runner's own token cannot mint URLs, by design: it is the credential that sits on the machine all day.

### Who asked

Every row records three things. `sasonica status` shows them as `client/agent`, e.g. `default/claude.ai` or `default/chatgpt`, and as `client/name (agent)` when the URL carried a name, e.g. `default/desk (claude.ai)`:

- **client**: which URL queued it (`default` or a label from `sasonica client`). This is the one that means something, because the URL's secret is the credential.
- **name**: the name in the URL (`/<secret>/desk/mcp`, or `?as=desk`), if it had one. Whoever pasted the URL chose it; it tells apart connectors that share a secret, and decides nothing.
- **agent**: what the assistant says it is. The Worker reads `clientInfo.name` from MCP `initialize` (falling back to the first token of the `User-Agent`, written `ua:...`) and hands it back inside a signed `Mcp-Session-Id`, which clients send on later requests. Any client can claim any name, so this is attribution, not security; the session id is bound to the URL's client and name, so it does not carry over to another URL or another name. A client that does not echo the session id is still served, and its rows fall back to `ua:...` or `unknown`. The assistants people actually connect get the name a person would use — Claude.ai's connector (`Claude-User`) reads as `claude.ai`, ChatGPT's (`openai-mcp`) as `chatgpt` — from a short table in the Worker (`FRIENDLY`); anything else keeps its own name.

### Signed rows

Every queued command is signed with HMAC-SHA256 using a key known only to the Worker and runner. Writing directly to the D1 table is therefore not enough to make the runner execute an arbitrary row.

The runner also records seen nonces and refuses replays.

### Local execution boundary

Commands run as the account that owns the runner service. Sasonica Shell has no command allowlist or sandbox of its own. Normal operating-system permissions remain the boundary.

The defaults are:

- command timeout: 600 seconds
- stored output: 60 KB
- foreground concurrency: 1
- background concurrency cap: 4
- progress copy interval: 10 seconds
- finished-row retention: 30 days

A cancellation stops future execution, but it cannot undo side effects a command already caused.

## Queueing and concurrency

By default Sasonica Shell is serial: one foreground command finishes before the next begins. This keeps command order predictable.

Set `SASONICA_PARALLEL=4` in `~/.config/sasonica/env` to allow up to four foreground commands at once. The runner reloads several operational settings while it is running, so many tuning changes do not need a service restart.

A single command can bypass the foreground lane with `run_command(..., background=true)`. Background jobs have their own cap, `SASONICA_BACKGROUND_MAX`, which defaults to 4.

`detach` promotes an already-running foreground command out of the lane without killing it. The runner checks for detach and cancel requests every `SASONICA_DETACH_CHECK` seconds, default 3.

## Failure handling

Sasonica Shell tries to make ambiguous states visible rather than pretending they did not happen.

- A runner restart marks that runner's in-flight rows as `error`, with a note that the command may or may not have completed.
- A row that remains `running` well beyond the command timeout is marked `error` by the stale-job sweep.
- A command that exceeds `SASONICA_CMD_TIMEOUT` becomes `timeout`.
- A bad signature or reused nonce becomes `rejected`.
- A cancelled command becomes `cancelled`.
- Partial output from a running command is copied to D1 periodically, so `get_result` can show progress before completion.
- Finished rows are pruned daily after `SASONICA_KEEP_DAYS`; pending and running rows are never pruned.

Each claimed row records the runner name, normally the hostname. This keeps restart and stale-job cleanup scoped correctly when more than one runner uses a database.

## Configuration

The normal local config lives in:

```text
~/.config/sasonica/env
~/.config/sasonica/relay.key
```

Useful runtime settings include:

| Variable | Default | Meaning |
|---|---:|---|
| `SASONICA_POLL` | `5` | Seconds between queue polls. |
| `SASONICA_CMD_TIMEOUT` | `600` | Maximum command runtime in seconds. |
| `SASONICA_MAX_OUTPUT` | `60000` | Maximum output bytes retained per command. |
| `SASONICA_PARALLEL` | `1` | Foreground commands allowed to run at once. |
| `SASONICA_BACKGROUND_MAX` | `4` | Maximum background jobs. |
| `SASONICA_DETACH_CHECK` | `3` | Seconds between detach/cancel checks. |
| `SASONICA_PROGRESS_EVERY` | `10` | Seconds between partial-output updates; `0` disables them. |
| `SASONICA_KEEP_DAYS` | `30` | Days to retain finished rows. |
| `SASONICA_LOAD_MAX` | `0` | Hold new work above this 1-minute load average; `0` disables the ceiling. |
| `SASONICA_RUNNER_ID` | hostname | Name written on rows claimed by this runner. |

The Worker also supports `SASONICA_WAIT_DEFAULT` and `SASONICA_WAIT_MAX`; waits are capped at 30 seconds by the current Worker implementation so MCP clients are not left silent for too long.

## Operations

Check recent commands:

```bash
sasonica status
sasonica status 30
```

Follow the runner log:

```bash
journalctl --user -u sasonica-shell -f
```

Inspect the service:

```bash
systemctl --user status sasonica-shell
```

Stop or start it:

```bash
systemctl --user stop sasonica-shell
systemctl --user start sasonica-shell
```

On macOS, use `launchctl print "gui/$(id -u)/com.sasonica.shell"` and `tail -f "$HOME/Library/Logs/sasonica/runner.log"`. See [SETUP.md](SETUP.md#everyday-operation) for stop/start commands. The Mac runs queued work while awake, online, and logged in.

The signing compatibility test keeps the runner's OpenSSL implementation and the Worker's WebCrypto implementation pinned to the same vectors:

```bash
./tests/check-signing.sh
```

Run it after changing signing code on either side. Portability checks exercise installer routing with mocked external services and real job execution, timeouts, and cancellation:

```bash
python3 tests/check-platform.py
```

The runner is driven against the real Worker over real SQLite, so both sides are tested against each other: execution, timeout, cancel, detach, signature and replay rejection, the serial lane, env-file reloading, and — as real child processes — that a cancel and a shutdown both reach everything a command started. `check-platform.py` runs it too; run it alone while working on the runner:

```bash
node --experimental-strip-types --experimental-sqlite tests/check-runner.mjs        # every case
node --experimental-strip-types --experimental-sqlite tests/check-runner.mjs basic  # one case
node --experimental-strip-types --experimental-sqlite tests/check-worker.mjs        # the Worker's runner API
```

The installer provisions Cloudflare and cannot be exercised offline, but what it *decides* is pure and is where the bugs have been:

```bash
node tests/check-install.mjs
```

The CI matrix runs these checks on Linux and macOS, including the Mac's system Bash. A real Cloudflare installation is still required to validate the complete setup on a target Mac.

## Deliberate non-features

Sasonica Shell does **not** yet provide OAuth (the Worker half is built but off; see docs/tools-and-approvals.md §6), per-client permissions, command allowlists, verified identity for which assistant queued a row (the client label says which URL; the agent name is only what the assistant claims), persistent shell sessions, or an agent runtime on the target machine.

Those omissions are part of the design. If you need richer client identity, session routing, or multi-user policy, see [tmux-relay](https://github.com/davidj4tech/tmux-relay), the larger system from which Sasonica Shell was distilled. The two projects use the same command-signing scheme.

## Repository map

| File | Purpose |
|---|---|
| `worker/src/index.ts` | Remote MCP Worker: four built-in tools plus whatever the runners publish, signing, queueing, and result retrieval. |
| `schema.sql` | D1 schema: the command table and its pending-row index, and the per-client URL table. |
| `sasonica.mjs` | The runner on every platform: poll, verify, execute, monitor, and report. |
| `install.mjs` | The installer on every platform: provisioning, config, and the service. |
| `install.sh` | Linux/macOS bootstrap: finds Node, hands over to `install.mjs`. |
| `sasonica-shell.service` | systemd user-service template. |
| `install.ps1` | Windows bootstrap: finds Node, hands over to `install.mjs`. |
| `lib/clients.mjs` | `sasonica client` add, list and revoke: per-assistant connector URLs. |
| `lib/cloudflare.mjs` | The Cloudflare API and D1 queries, shared by the installer and `sasonica client`. |
| `lib/service-systemd.mjs` | The systemd user service. |
| `lib/service-macos.mjs` | The macOS LaunchAgent. |
| `lib/service-windows.mjs` | The Windows Scheduled Task. |
| `install.conf.example` | Optional non-interactive installer configuration. |
| `SETUP.md` | Start-to-finish setup guide. |
| `MIGRATING.md` | Moving an install made under the old name, Runlet, to Sasonica Shell. |
| `tests/check-signing.sh` | Cross-implementation signing compatibility test. |
| `tests/check-platform.py` | Installer routing and real job supervision, with external services mocked. |
| `tests/check-runner.mjs` | The runner driven against the real Worker over real SQLite. |
| `tests/check-install.mjs` | What the installer decides: names, secrets, the env file, each service definition. |
| `tests/check-windows-install.ps1` | The Windows bootstrap: that it finds Node and hands over. |
| `tests/check-worker.mjs` | The Worker's runner API, client URLs and attribution, executed against real SQLite via `tests/fake-d1.mjs`. |

## License

MIT. See [LICENSE](LICENSE).
