# Sasonica Shell: setup from start to finish

Sasonica Shell lets an AI assistant run shell commands on this computer and read the results through a remote MCP connection.

You need:

- a free Cloudflare account
- this repository
- Linux, macOS with Homebrew, or Windows 10/11 with Node 20+
- an MCP client that can add a remote/custom server by URL

The target machine does **not** need a public IP, open port, VPN, SSH exposure, or a local AI runtime. The runner makes outbound HTTPS requests to Cloudflare.

> [!WARNING]
> Commands run as your user. The Sasonica Shell connector URL is a credential: anyone who has it can ask Sasonica Shell to execute commands on this machine. Keep it private.

## 1. Prepare Cloudflare

1. Create an account at <https://dash.cloudflare.com/sign-up>.
2. Confirm your email and sign in.
3. You do not need to add a website or domain.
4. On a brand-new account, open **Compute (Workers)** once so Workers is initialised.

The free plan is sufficient for a small personal install.

## 2. Create the API token

The installer uses a Cloudflare API token to create the Worker and D1 database. It is not the credential your MCP client uses — that is the connector URL, created later.

The installer also writes this token into the local config, because the runner needs one of its own: it reaches the queue over D1's HTTP API on every poll. The two uses have different needs, and it is worth knowing which is which.

**The installer** needs all three permissions below: it discovers the account, creates the database, deploys the Worker, and sets the Worker's secrets. It needs them once.

**The runner** needs no Cloudflare permissions at all. It reaches its queue through its own Worker, with a per-machine bearer token the installer generates, so the machine whose job is running shell commands from the internet holds no account credential. The installer does not write `CLOUDFLARE_API_TOKEN` into the machine's config, which is why a re-run asks for it again.

1. Open <https://dash.cloudflare.com/profile/api-tokens>.
2. Click **Create Token** and choose **Create Custom Token**.
3. Name it `sasonica`.
4. Add these permissions:

   | Scope | Permission | Level |
   |---|---|---|
   | Account | Workers Scripts | Edit |
   | Account | D1 | Edit |

5. Include the account where Sasonica Shell should live.
6. Create the token and copy it somewhere temporary and private. Cloudflare shows it once.

### Why only two

`Workers Scripts: Edit` deploys the Worker and sets its secrets. `D1: Edit` creates the database and applies the schema. That is the whole of provisioning.

Older versions of this guide also asked for `Account Settings: Read`, to look up your account ID. It turns out not to be needed: a token scoped to an account can already list that account, so the installer finds the ID with the two permissions above. Checked against a real two-permission token on 21 Sep 2026 — a full install, including the deploy, succeeds without it.

You can narrow it further by setting the account resource to one specific account rather than *All accounts*, and by giving the token a short TTL. The installer will also skip the account lookup entirely if you tell it the ID:

```sh
CLOUDFLARE_ACCOUNT_ID=<your account id> ./install.sh
```

Neither permission is needed once the install finishes. Nothing is stored on the machine: the runner reaches its queue through its own Worker with a bearer token of its own.

## 3. Run the installer

### Linux

```bash
cd sasonica-shell      # wherever you cloned this repository
./install.sh
```

Paste the Cloudflare API token when prompted.

### macOS

Install [Homebrew](https://brew.sh) first if it is not already installed, then run the same installer in Terminal:

```bash
cd sasonica-shell      # wherever you cloned this repository
./install.sh
```

The installer finds Homebrew on Apple Silicon (`/opt/homebrew`) or Intel (`/usr/local`), or uses the `brew` already on your PATH. It installs `jq`, GNU coreutils, OpenSSL 3, and Python 3. If a suitable Node is missing, it installs Homebrew's Node 22 for Cloudflare provisioning.

It creates `~/Library/LaunchAgents/com.sasonica.shell.plist`, starts it in your desktop login session, and starts it again at future logins. When installing over SSH without a desktop login, the agent is saved for your next login; you can run `node sasonica.mjs` manually meanwhile. `./install.sh --no-service` skips LaunchAgent creation and startup.

The runner uses Homebrew's GNU utilities internally; your shell configuration is not changed. To make `sasonica` available in Terminal, add this to `~/.zprofile` (zsh) or `~/.bash_profile` (bash), then open a new terminal:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

The Mac must be awake and connected to process commands. This is a per-user login agent, not a system-wide daemon.

### Windows

Windows runs natively: `sasonica.mjs` under Node, started by a Scheduled Task
at logon. WSL2 is no longer used or required.

1. Put the repository somewhere convenient, for example `C:\sasonica-shell`.
2. Install [Node 20+](https://nodejs.org) if you do not have it. The installer
   will try `winget install OpenJS.NodeJS.LTS` for you if winget is available.
3. Open PowerShell and run:

   ```powershell
   cd C:\sasonica-shell
   Set-ExecutionPolicy -Scope Process Bypass
   .\install.ps1
   ```

4. Paste the Cloudflare API token when it asks.
5. The runner is registered as the Scheduled Task `sasonica-shell`, running as you,
   starting at logon and restarting if it stops. Check it with:

   ```powershell
   Get-ScheduledTask sasonica-shell
   Get-ScheduledTaskInfo sasonica-shell
   Get-Content -Wait "$env:APPDATA\sasonica\runner.log"
   ```

Config lives in `%APPDATA%\sasonica\` rather than `~/.config/sasonica/`, and the
nonce history in `%LOCALAPPDATA%\sasonica\`.

## 4. What the installer creates

The installer:

1. checks required local dependencies
2. creates or finds a D1 database named `sasonica-shell-<site>`
3. applies `schema.sql`
4. creates or finds a Worker named `sasonica-shell-<site>`
5. ensures a `workers.dev` subdomain exists
6. generates the shared HMAC signing key
7. generates the secret URL path
8. stores the Worker secrets
9. deploys the Worker
10. runs an end-to-end smoke test
11. writes local config under `~/.config/sasonica/` (`%APPDATA%\sasonica\` on Windows)
12. installs and starts `sasonica.mjs` as a systemd user service (Linux), a LaunchAgent (macOS), or a Scheduled Task (Windows)

`install.sh` and `install.ps1` are bootstraps: they make sure Node 20+ is present and hand over to `install.mjs`, which does all of the above on every platform.

`<site>` defaults to the hostname. Several machines can therefore share one Cloudflare account without sharing a Worker or database.

Re-running the installer is safe. Existing stack IDs and secrets are reused unless you deliberately remove or rotate them.

### Non-interactive setup

```bash
cp install.conf.example install.conf
```

Fill in the values before installation. Keep this file private because it may contain the Cloudflare API token, and delete it when you no longer need it.

## 5. Save the connector URL

At the end, the installer prints an address similar to:

```text
https://sasonica-shell-example.example.workers.dev/jog-lapel-flame-lift-charm/mcp
```

The exact hostname will differ. The random word path is the important secret. The installer also attempts to copy the URL to your clipboard and open a connector page.

**Do not post this URL, commit it to Git, paste it into issue trackers, or share it with an assistant you do not trust.** It is effectively a capability token for shell access through Sasonica Shell.

## 6. Connect your MCP client

Add the printed URL as a remote/custom MCP server or connector. Sasonica Shell authenticates through the secret URL, so choose **no additional authentication** if your client asks.

The exact menu name differs between clients. Claude calls this a custom connector. ChatGPT can use a custom connector/plugin surface where available. Other MCP hosts generally ask for the remote server URL.

Start with a harmless command such as:

```text
uname -a
```

or:

```text
printf 'hello from sasonica\n'
```

The assistant receives Sasonica Shell's tool descriptions automatically, including how to wait, run work in the background, detach it, cancel it, and retrieve results later.

## 7. Give the assistant sensible operating rules

Sasonica Shell intentionally does not impose a command allowlist. If your MCP client supports project or custom instructions, tell the assistant how you want it to use the machine.

For example:

> You can run shell commands on my computer through Sasonica Shell. Commands run as me in a fresh `bash -lc` shell. Prefer read-only inspection unless I have asked for a change. Be cautious with deletion, package changes, service changes, credentials, and network exposure. For long jobs, use background execution or detach them and collect the result later. Keep large output bounded with tools such as `head`, `tail`, `grep`, and `sed`.

Adapt that to your own trust model. Sasonica Shell provides transport and verification; the operating policy belongs to you and the assistant using it.

## Everyday operation

On Linux, the runner starts automatically as a systemd user service.

```bash
systemctl --user status sasonica-shell
journalctl --user -u sasonica-shell -f
sasonica status
sasonica status 30
```

Stop and start it with:

```bash
systemctl --user stop sasonica-shell
systemctl --user start sasonica-shell
```

On macOS, inspect the agent and follow its log with:

```bash
launchctl print "gui/$(id -u)/com.sasonica.shell"
tail -f "$HOME/Library/Logs/sasonica/runner.log"
sasonica status
```

Stop and start it with:

```bash
launchctl bootout "gui/$(id -u)/com.sasonica.shell"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.sasonica.shell.plist"
```

These commands apply to your desktop login session. Logging out stops the agent; logging in starts it again. Logs append to `runner.log`; rotate or truncate that file periodically if needed.

## Rotate the connector URL

If the URL is exposed:

1. Open `~/.config/sasonica/env`.
2. Remove the `SASONICA_URL_SECRET=...` line.
3. Run the installer again.
4. Replace the old connector URL in every MCP client.

The old path stops being valid after the Worker is redeployed with the new secret.

If only one assistant's URL leaked and it has its own (`sasonica client add`), revoke that one instead; nothing else changes:

```sh
sasonica client revoke chatgpt
```

It stops working within 30 seconds. See [Several assistants](README.md#several-assistants).

## Give an assistant its own URL

```sh
sasonica client add chatgpt
```

prints a new connector URL, once; paste it into that assistant. `sasonica client list` shows every client and when each last queued a command; `sasonica client revoke <label>` turns one off. `revoke default` turns off the shared URL above, until it is rotated.

These commands need the Cloudflare token you gave the installer (D1: Edit), since they write the database directly: set `CLOUDFLARE_API_TOKEN`, or keep it in `~/.config/sasonica/install-token` (mode 600). The runner's token is not enough, on purpose.

## Sign in instead of a secret URL (OAuth)

Optional, and off unless you ask for it. The connector URL is then a plain
address, `https://<worker>/mcp`, and each assistant signs in once: a page on
the Worker asks you to allow it, then Cloudflare Access emails you a code.
Only your email gets through. The secret URL keeps working beside it until
you stop it.

1. **Zero Trust, once per account** (free): https://one.dash.cloudflare.com →
   pick a team name. A team made since June 2026 signs you in with your
   Cloudflare login (members of the account only), which is enough; One-time
   PIN (Integrations → Identity providers) is optional. The owner email below
   is then your Cloudflare login's.
2. **Three more token permissions** (section 2), all Account:
   Workers KV Storage: Edit; Access: Apps and Policies: Edit; Access:
   Organizations, Identity Providers, and Groups: Read.
   An account token (made under the account's own API Tokens) works as well
   as a personal one. `SASONICA_WORKERS_SUBDOMAIN=<name>` names the account's
   workers.dev subdomain if it has none yet (else a random `relay-xxxxxx`).
3. **Re-run the installer with your email**:
   `SASONICA_OWNER_EMAIL=you@example.com sasonica install` (or put it in
   `install.conf`). It creates a KV namespace (`<worker>-oauth`), an Access
   policy that lets only that email through, and an Access for SaaS app for
   the Worker, and sets the Worker's secrets. It is kept in the env file, so
   later re-runs keep OAuth on.
4. **Add the connector** with the plain URL the installer prints, choosing
   OAuth (or no authentication; the assistant finds the sign-in itself).
5. Once every assistant has signed in: `sasonica client revoke default`
   stops the secret URL.

`sasonica client grants` lists the signed-in assistants, one label each
(`oauth-claude`); `sasonica client revoke oauth-claude` signs one out. Rows
an assistant queues carry its label, so `sasonica status` shows who asked.

## Rotate a machine's runner token

`SASONICA_RUNNER_TOKEN` is what a machine presents to its own Worker. Replacing it touches neither the database nor the connector URL:

1. Delete the `SASONICA_RUNNER_TOKEN=` line from `~/.config/sasonica/env` (`%APPDATA%\sasonica\env` on Windows).
2. Re-run the installer: it mints a new one and sets it as the Worker's secret.
3. Watch one command run end to end.

The old token stops working the moment the Worker's secret is replaced, so the runner is briefly refused (a 404) until the new config is read.

## Find a lost connector URL

Print it from the install folder:

```sh
./install.sh --print-url
```

This only reads `~/.config/sasonica/env`; it needs no token and changes nothing. The components are stored there:

```text
SASONICA_WORKER_URL=...
SASONICA_URL_SECRET=...
```

The full connector URL is:

```text
<SASONICA_WORKER_URL>/<SASONICA_URL_SECRET>/mcp
```

`sasonica url` prints the same thing; `sasonica url --name desk` prints it as `.../<secret>/desk/mcp`, so the rows that connector queues say `desk`. The name labels, it does not protect: every form is the same password.

Keep it private when copying or displaying it.

## Tune the runner

Common settings in `~/.config/sasonica/env`:

```text
SASONICA_POLL=5
SASONICA_CMD_TIMEOUT=600
SASONICA_MAX_OUTPUT=60000
SASONICA_PARALLEL=1
SASONICA_BACKGROUND_MAX=4
SASONICA_DETACH_CHECK=3
SASONICA_PROGRESS_EVERY=10
SASONICA_KEEP_DAYS=30
SASONICA_LOAD_MAX=0
```

`SASONICA_PARALLEL=1` gives predictable one-at-a-time foreground execution. Background jobs are separately limited by `SASONICA_BACKGROUND_MAX`.

`SASONICA_LOAD_MAX=0` disables load-based admission control. Set it to a positive value to stop Sasonica Shell starting new work while the 1-minute load average is above that threshold.

Several tuning values are re-read while the runner is operating, so many operational changes do not require a service restart.

## Troubleshooting

### Commands stay pending

Check the service and log:

```bash
systemctl --user status sasonica-shell
journalctl --user -u sasonica-shell -n 100
```

On macOS, use the `launchctl print` and `tail` commands above instead.

A stopped runner, Cloudflare API problem, bad local config, or active load ceiling can leave work pending.

### A command says `rejected`

The runner rejected the signature or nonce. If signing code or keys changed, run:

```bash
./tests/check-signing.sh
```

The Worker and runner must use the same HMAC key and byte-for-byte signing format.

### A command says `error` after a restart

Sasonica Shell deliberately marks commands that were in flight when the runner restarted as ambiguous. The command may have partly or fully executed before the process disappeared. Inspect its effects before running it again.

### A command timed out

The default command limit is 600 seconds. Increase `SASONICA_CMD_TIMEOUT` if the work is legitimately longer, or use background execution and retrieve the result later.

### The queue is blocked by a long foreground command

Ask the assistant to `detach` it. The command keeps running while later work proceeds. If it should stop instead, use `cancel`.

### The connector URL no longer works

Confirm that the MCP client has the current URL. After rotating `SASONICA_URL_SECRET`, every client using the old URL must be updated.

## Removing Sasonica Shell

Stop and disable the local service:

```bash
systemctl --user disable --now sasonica-shell
```

On macOS, unload the agent and remove its login definition instead:

```bash
launchctl bootout "gui/$(id -u)/com.sasonica.shell"
rm "$HOME/Library/LaunchAgents/com.sasonica.shell.plist"
```

You can then remove the local config and repository. To remove the cloud side too, delete the Sasonica Shell Worker and D1 database from Cloudflare.

Be deliberate when deleting D1: it contains Sasonica Shell's command and result history until rows are pruned.
