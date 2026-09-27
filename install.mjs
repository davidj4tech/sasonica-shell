#!/usr/bin/env node
// install.mjs — Sasonica Shell, from a Cloudflare API token to a running
// runner, on every platform. install.sh and install.ps1 are bootstraps: they
// make sure Node exists and hand over to this. Once a machine has the
// `sasonica` command, `sasonica install` hands over to it the same way.
//
//   node install.mjs                 interactive: asks for the token if not in env
//   node install.mjs --no-service    everything except registering the runner
//   node install.mjs --print-url     print this machine's connector URL and exit
//
// The ONE manual step is the token. Create it at
//   https://dash.cloudflare.com/profile/api-tokens  ->  Create Token  ->  Custom
// with these permissions, all at Account scope:
//   Workers Scripts : Edit     D1 : Edit     Account Settings : Read
//
// It is used here and not kept: the runner reaches its queue through its own
// Worker with a bearer token, so no Cloudflare credential is left behind.
//
// Re-running is safe: every step checks before it creates.

import { createInterface } from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cfRequest } from './lib/cloudflare.mjs';
import { hex, siteName, urlSecret, readEnvFile, renderEnv, renderShim, connectorUrl,
         winShellCommand, needsWindowsShell, OAUTH_KV_MARKER, oauthKvLine, ownerPolicyBody,
         accessAppBody } from './lib/install-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

const say = (m) => console.log(`\n${WIN ? '' : '\x1b[1m'}==> ${m}${WIN ? '' : '\x1b[0m'}`);
const note = (m) => console.log(`    ${m}`);
const die = (m) => { console.error(`\n${WIN ? '' : '\x1b[31m'}ERROR:${WIN ? '' : '\x1b[0m'} ${m}`); process.exit(1); };

const args = new Set(process.argv.slice(2));
const NO_SERVICE = args.has('--no-service');
const PRINT_URL = args.has('--print-url');

// --- config files ------------------------------------------------------------
// Windows has no XDG; %APPDATA% is where per-user config belongs there.
const CONF = process.env.SASONICA_CONF
  || (WIN && process.env.APPDATA ? path.join(process.env.APPDATA, 'sasonica')
      : path.join(homedir(), '.config', 'sasonica'));
const ENV_FILE = path.join(CONF, 'env');
const KEY_FILE = path.join(CONF, 'relay.key');
const RUNNER = path.join(HERE, 'sasonica.mjs');

// Written without a BOM: the runner's parser anchors each line at ^\s*KEY=,
// and a BOM would hide the first key behind three bytes it cannot match.
function writeText(file, text, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, { encoding: 'utf8' });
  if (mode && !WIN) chmodSync(file, mode);
  if (mode && WIN) {
    try { execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(R,W)`], { stdio: 'ignore' }); }
    catch { note(`could not restrict permissions on ${file}`); }
  }
}

// --- prompting ---------------------------------------------------------------
async function ask(question, { hidden = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (!hidden) {
    const answer = await new Promise((r) => rl.question(question, r));
    rl.close();
    return answer.trim();
  }
  // Echo nothing for a secret. readline still needs the line, so mute output.
  process.stdout.write(question);
  rl.output.write = () => {};
  const answer = await new Promise((r) => rl.question('', r));
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}

// --- Cloudflare ---------------------------------------------------------------
// lib/cloudflare.mjs, shared with `sasonica client`; here a failure ends the install.
async function cf(pathname, opts = {}) {
  try { return await cfRequest(pathname, opts); } catch (e) { return die(e.message); }
}

// --- secrets -------------------------------------------------------------------
// --- running things ------------------------------------------------------------
function run(exe, argv, { stdin, cwd, capture = false } = {}) {
  const shell = WIN && needsWindowsShell(exe);
  const r = spawnSync(shell ? winShellCommand(exe, argv) : exe, shell ? [] : argv, {
    cwd, input: stdin, encoding: 'utf8', shell,
    stdio: ['pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
  });
  if (r.error) die(`${exe}: ${r.error.message}`);
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// Beside the node that is running, not whatever `npm` resolves to: npm.cmd
// finds its own JS through %~dp0, so which copy gets picked decides which
// npm actually runs, and a bare name is resolved against the working
// directory before PATH.
function npmBesideNode() {
  const here = path.join(path.dirname(process.execPath), WIN ? 'npm.cmd' : 'npm');
  return existsSync(here) ? here : (WIN ? 'npm.cmd' : 'npm');
}
const NPM = npmBesideNode();

// The node the SERVICE should run, which is not necessarily the one running
// this script. process.execPath resolves symlinks, and under fnm or nvm that
// lands inside a version-specific directory that disappears on the next
// upgrade; the `node` on PATH is the stable alias that survives it.
function nodeForService() {
  const r = WIN ? run('where', ['node'], { capture: true })
                : run('sh', ['-c', 'command -v node'], { capture: true });
  const first = (r.out || '').split(/\r?\n/)[0].trim();
  return first && existsSync(first) ? first : process.execPath;
}
const NODE = nodeForService();
const WRANGLER = path.join(HERE, 'worker', 'node_modules', '.bin', WIN ? 'wrangler.cmd' : 'wrangler');
const wrangler = (argv, opts = {}) => run(WRANGLER, argv, { cwd: path.join(HERE, 'worker'), ...opts });

// =============================================================================
const existing = readEnvFile(ENV_FILE);

if (PRINT_URL) {
  const { SASONICA_WORKER_URL: url, SASONICA_URL_SECRET: secret } = existing;
  if (!url || !secret) {
    console.error(`${ENV_FILE} lacks SASONICA_WORKER_URL or SASONICA_URL_SECRET: run the installer first`);
    process.exit(1);
  }
  console.log(connectorUrl(url, secret));
  process.exit(0);
}

// install.conf beside this script answers the questions in advance.
for (const [k, v] of Object.entries(readEnvFile(path.join(HERE, 'install.conf')))) {
  if (!process.env[k]) process.env[k] = v;
}

const site = siteName(process.env.SASONICA_SITE || hostname().split('.')[0]);
// A re-run must find the stack it made, even if the machine was renamed.
const workerName = process.env.SASONICA_WORKER_NAME || existing.SASONICA_WORKER_NAME || `sasonica-shell-${site}`;
const dbName = process.env.SASONICA_DB_NAME || existing.SASONICA_DB_NAME || `sasonica-shell-${site}`;
// OAuth on /mcp (docs/tools-and-approvals.md §6), when the owner's email is
// given: the connector then signs in with Cloudflare Access instead of
// carrying a secret. Kept in the env file, so a re-run keeps it on.
const ownerEmail = (process.env.SASONICA_OWNER_EMAIL || existing.SASONICA_OWNER_EMAIL || '').trim().toLowerCase();
// SASONICA_SIGNIN=app: the owner's paired Sasonica app approves each sign-in
// (a code on the page) instead of Cloudflare Access — no Cloudflare login and
// no Access setup; only the KV namespace. Kept in the env file too.
const signin = (process.env.SASONICA_SIGNIN || existing.SASONICA_SIGNIN || (ownerEmail ? 'access' : '')).trim();
if (signin && !['app', 'access'].includes(signin)) {
  console.error(`SASONICA_SIGNIN is 'app' or 'access', not ${signin}`);
  process.exit(1);
}
const oauth = signin === 'app' || !!ownerEmail;
if (ownerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
  console.error(`SASONICA_OWNER_EMAIL is not an email: ${ownerEmail}`);
  process.exit(1);
}

// --- 1. dependencies -----------------------------------------------------------
say('Checking dependencies');
note(`node ${process.version}, npm ${run(NPM, ['-v'], { capture: true }).out.trim()}`);
if (run(NPM, ['install', '--silent', '--no-audit', '--no-fund'], { cwd: path.join(HERE, 'worker') }).code !== 0) {
  die('npm install failed in worker/');
}
if (!existsSync(WRANGLER)) die(`wrangler not found at ${WRANGLER}`);

// --- 2. the token ---------------------------------------------------------------
say(`Cloudflare API token (site: ${site} -> Worker ${workerName}, database ${dbName})`);
let token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.log(`    The installer needs a Cloudflare API token. Full steps are in SETUP.md;
    the short version:
      1. Sign in at https://dash.cloudflare.com (a free account is enough).
      2. Open https://dash.cloudflare.com/profile/api-tokens
         -> Create Token -> Create Custom Token (Get started).
      3. Name it sasonica and add three permissions, all "Account":
            Workers Scripts   Edit
            D1                Edit
            Account Settings  Read${oauth && signin !== 'app' ? `
         and, for OAuth sign-in (SASONICA_OWNER_EMAIL is set), two more:
            Workers KV Storage            Edit
            Access: Apps and Policies     Edit
            Access: Organizations, Identity Providers, and Groups   Read` : ''}
      4. Continue to summary -> Create Token -> copy it (shown once).`);
  token = await ask('    Paste the token here and press Enter: ', { hidden: true });
}
if (!token) die('no token given');
process.env.CLOUDFLARE_API_TOKEN = token;

// A user token verifies at /user/tokens/verify; an account token (made
// under an account's API Tokens, as South Pen Labs' is) answers "Invalid API
// Token" there and verifies at its account's own endpoint instead.
let tokenOk = false;
try { tokenOk = (await cfRequest('/user/tokens/verify', { token })).status === 'active'; } catch { tokenOk = false; }
if (!tokenOk) {
  let ids = process.env.CLOUDFLARE_ACCOUNT_ID ? [process.env.CLOUDFLARE_ACCOUNT_ID] : [];
  if (!ids.length) { try { ids = (await cfRequest('/accounts?per_page=50', { token })).map((a) => a.id); } catch { ids = []; } }
  for (const id of ids) {
    try { if ((await cfRequest(`/accounts/${id}/tokens/verify`, { token })).status === 'active') { tokenOk = true; break; } } catch { /* next */ }
  }
}
if (!tokenOk) die('the token did not verify (as a user token or an account token)');
// Listing accounts is the ONLY thing here that needs Account Settings: Read.
// Given the id, the token can be narrower -- Workers Scripts: Edit and D1:
// Edit are enough to provision -- which matters because whoever installs
// this has to create that token by hand.
let accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (accountId) {
  note(`account ${accountId} (from CLOUDFLARE_ACCOUNT_ID)`);
} else {
  const accounts = await cf('/accounts?per_page=50', { token });
  if (!accounts.length) die('the token can see no accounts; it needs Account Settings: Read, or set CLOUDFLARE_ACCOUNT_ID');
  if (accounts.length === 1) accountId = accounts[0].id;
  else {
    note('The token can see several accounts:');
    for (const a of accounts) console.log(`      ${a.id}  ${a.name}`);
    accountId = await ask('    Account id to use: ');
  }
  note(`account ${accountId} (${accounts.find((a) => a.id === accountId)?.name ?? '?'})`);
}
process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

// --- 3. D1 -----------------------------------------------------------------------
say(`D1 database '${dbName}'`);
const found = (await cf(`/accounts/${accountId}/d1/database?name=${dbName}&per_page=100`, { token }))
  .find((d) => d.name === dbName);
let dbId = found?.uuid;
if (dbId) note(`exists: ${dbId}`);
else {
  dbId = (await cf(`/accounts/${accountId}/d1/database`, { method: 'POST', body: { name: dbName }, token })).uuid;
  note(`created ${dbId}`);
}
if (!/^[0-9a-f-]{36}$/.test(dbId ?? '')) die('could not get a database id');

// --- 3b. OAuth's KV namespace (only with SASONICA_OWNER_EMAIL) -------------------
// The provider's clients, grants and tokens. It encrypts what a grant carries,
// so the namespace alone cannot mint access.
let kvId = '';
if (oauth) {
  const title = `${workerName}-oauth`;
  say(`OAuth: KV namespace '${title}'`);
  const spaces = await cf(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`, { token });
  kvId = spaces.find((n) => n.title === title)?.id;
  if (kvId) note(`exists: ${kvId}`);
  else {
    kvId = (await cf(`/accounts/${accountId}/storage/kv/namespaces`, { method: 'POST', body: { title }, token })).id;
    note(`created ${kvId}`);
  }
  if (!/^[0-9a-f]{32}$/.test(kvId ?? '')) die('could not get a KV namespace id');
}

// --- 4. wrangler config -----------------------------------------------------------
say('Writing worker/wrangler.jsonc');
writeText(path.join(HERE, 'worker', 'wrangler.jsonc'),
  readFileSync(path.join(HERE, 'worker', 'wrangler.jsonc.template'), 'utf8')
    .replace('__WORKER_NAME__', workerName).replace('__ACCOUNT_ID__', accountId)
    .replace('__DB_NAME__', dbName).replace('__DB_ID__', dbId)
    .replace(OAUTH_KV_MARKER, kvId ? oauthKvLine(kvId) : OAUTH_KV_MARKER));
if (wrangler(['d1', 'execute', dbName, '--remote', '--file', path.join(HERE, 'schema.sql')], { capture: true }).code !== 0) {
  die('applying schema.sql failed');
}
// Columns added after the first release, for a database created before them.
// ALTER TABLE is not idempotent in SQLite, so look first.
const cols = wrangler(['d1', 'execute', dbName, '--remote', '--json', '--command', 'PRAGMA table_info(commands);'],
  { capture: true }).out;
// client, name and agent say who queued a row; the clients table they refer
// to is in schema.sql as CREATE TABLE IF NOT EXISTS, so it arrived with the
// file. The Worker writes every one of these on each run_command, so they
// must exist before it is deployed -- which is why this comes first.
for (const spec of ['background INTEGER NOT NULL DEFAULT 0', 'cancel INTEGER NOT NULL DEFAULT 0', 'runner TEXT',
                    'client TEXT', 'agent TEXT', 'name TEXT',
                    // A typed tool call rather than a shell string (§1 of
                    // docs/tools-and-approvals.md).
                    "kind TEXT NOT NULL DEFAULT 'shell'"]) {
  const col = spec.split(' ')[0];
  if (!new RegExp(`"name"\\s*:\\s*"${col}"`).test(cols)) {
    if (wrangler(['d1', 'execute', dbName, '--remote', '--command', `ALTER TABLE commands ADD COLUMN ${spec};`],
      { capture: true }).code !== 0) die(`adding the ${col} column failed`);
    note(`added the ${col} column`);
  }
}
note('schema applied');

// --- 5. secrets ---------------------------------------------------------------------
say('Keys');
mkdirSync(CONF, { recursive: true });
if (!WIN) chmodSync(CONF, 0o700);
if (!existsSync(KEY_FILE) || !readFileSync(KEY_FILE, 'utf8').trim()) {
  writeText(KEY_FILE, `${hex(32)}\n`, 0o600); note('generated relay.key');
} else note('relay.key exists, keeping it');

let secret = existing.SASONICA_URL_SECRET;
if (secret) note('URL secret exists, keeping it');
else {
  secret = urlSecret(Number(process.env.SASONICA_SECRET_WORDS ?? 5), path.join(HERE, 'words.txt'), note);
  note('generated the URL secret');
}

// The runner's own credential: a bearer token for this machine's Worker, so
// the machine that executes commands holds no Cloudflare credential at all.
let runnerToken = existing.SASONICA_RUNNER_TOKEN;
if (runnerToken) note('runner token exists, keeping it');
else { runnerToken = hex(32); note('generated the runner token'); }

for (const [name, value] of [['SASONICA_HMAC_KEY', readFileSync(KEY_FILE, 'utf8').trim()],
                             ['SASONICA_URL_SECRET', secret], ['SASONICA_RUNNER_TOKEN', runnerToken]]) {
  if (wrangler(['secret', 'put', name], { stdin: value, capture: true }).code !== 0) die(`setting ${name} failed`);
}
note('Worker secrets set');

// --- 6. workers.dev subdomain, then deploy -------------------------------------------
say('Deploying the Worker');
// Registered here rather than left to `wrangler deploy`. Wrangler will offer
// to create one, but only as an interactive prompt, and its confirm falls
// back to NO when stdin is not a terminal -- so a piped install on a fresh
// account dies with "You need to register a workers.dev subdomain". It skips
// the prompt and auto-registers when it detects an AI agent is running it
// (it checks CLAUDECODE among others), which would make this pass under an
// assistant and fail for the person who ships it. Doing it ourselves is the
// same either way.
// An account with none answers with an error ("You do not have a workers.dev
// subdomain"), not an empty one: that is the case to register one.
let sub = '';
try { sub = (await cfRequest(`/accounts/${accountId}/workers/subdomain`, { token }))?.subdomain || ''; } catch { sub = ''; }
if (!sub) {
  // SASONICA_WORKERS_SUBDOMAIN picks it (it is in every Worker URL on the
  // account, so a name beats a random one); else a random relay-xxxxxx.
  sub = process.env.SASONICA_WORKERS_SUBDOMAIN || `relay-${hex(3)}`;
  await cf(`/accounts/${accountId}/workers/subdomain`, { method: 'PUT', body: { subdomain: sub }, token });
  note(`registered workers.dev subdomain: ${sub}`);
}
const workerUrl = `https://${workerName}.${sub}.workers.dev`;

// --- 6b. OAuth: the Access app that signs the owner in (only with SASONICA_OWNER_EMAIL)
if (signin === 'app') {
  say('OAuth: sign-in approved in the Sasonica app');
  if (wrangler(['secret', 'put', 'SASONICA_SIGNIN'], { stdin: 'app', capture: true }).code !== 0) die('setting SASONICA_SIGNIN failed');
  note('each sign-in waits for Approve on the paired phone (Home)');
} else if (ownerEmail) {
  say('OAuth: Cloudflare Access sign-in');
  let org = null;
  try { org = await cfRequest(`/accounts/${accountId}/access/organizations`, { token }); } catch { org = null; }
  if (!org?.auth_domain) {
    die(`this account has no Zero Trust organization (or the token cannot read it).
    Turn it on once, free: https://one.dash.cloudflare.com -> pick a team name;
    then Settings -> Authentication -> add "One-time PIN". Re-run this after.`);
  }
  note(`team domain ${org.auth_domain}`);
  const policyName = `${workerName} owner`;
  const policies = await cf(`/accounts/${accountId}/access/policies?per_page=100`, { token });
  let policy = policies.find((p) => p.name === policyName);
  if (policy) {
    policy = await cf(`/accounts/${accountId}/access/policies/${policy.id}`, { method: 'PUT', body: ownerPolicyBody(policyName, ownerEmail), token });
    note(`policy '${policyName}': only ${ownerEmail}`);
  } else {
    policy = await cf(`/accounts/${accountId}/access/policies`, { method: 'POST', body: ownerPolicyBody(policyName, ownerEmail), token });
    note(`created policy '${policyName}': only ${ownerEmail}`);
  }
  const apps = await cf(`/accounts/${accountId}/access/apps`, { token });
  let app = apps.find((a) => a.type === 'saas' && a.name === workerName);
  const body = accessAppBody({ name: workerName, callback: `${workerUrl}/callback`, policyId: policy.id });
  const oauthSecrets = [['ACCESS_TEAM_DOMAIN', org.auth_domain], ['SASONICA_OWNER_EMAIL', ownerEmail]];
  if (app) {
    // Updated in place: the client secret is shown only when an app is made,
    // and the Worker already holds it.
    app = await cf(`/accounts/${accountId}/access/apps/${app.id}`, { method: 'PUT', body, token });
    note(`Access app '${workerName}' updated (its client secret is unchanged)`);
  } else {
    app = await cf(`/accounts/${accountId}/access/apps`, { method: 'POST', body, token });
    if (!app?.saas_app?.client_secret) die('Access did not return a client secret for the new app');
    oauthSecrets.push(['ACCESS_CLIENT_SECRET', app.saas_app.client_secret]);
    note(`created Access app '${workerName}'`);
  }
  if (!app?.saas_app?.client_id) die('Access did not return a client id');
  oauthSecrets.push(['ACCESS_CLIENT_ID', app.saas_app.client_id]);
  for (const [name, value] of oauthSecrets) {
    if (wrangler(['secret', 'put', name], { stdin: value, capture: true }).code !== 0) die(`setting ${name} failed`);
  }
  note('OAuth secrets set');
}

const deploy = wrangler(['deploy'], { capture: true });
if (deploy.code !== 0) { console.error(deploy.err || deploy.out); die('wrangler deploy failed'); }
for (const line of `${deploy.out}${deploy.err}`.trim().split('\n').slice(-3)) note(line.trim());

// --- 7. local config ------------------------------------------------------------------
say(`Writing ${ENV_FILE}`);
// CLOUDFLARE_API_TOKEN is deliberately absent. The runner reaches its queue
// through the Worker, and a D1 API token is account-wide: one left on every
// machine would reach every other machine's queue.
writeText(ENV_FILE, renderEnv({
  accountId, site, workerName, dbName, dbId, secret, workerUrl, runnerToken, keyFile: KEY_FILE, ownerEmail, signin: signin === 'app' ? 'app' : '',
}), 0o600);
mkdirSync(path.join(CONF, 'skills'), { recursive: true });

// `sasonica` as a command. rm first: an earlier installer left a SYMLINK here,
// and writing through one rewrites the file it points at instead of replacing it.
const binDir = WIN ? path.join(CONF, 'bin') : path.join(homedir(), '.local', 'bin');
const shim = path.join(binDir, WIN ? 'sasonica.cmd' : 'sasonica');
rmSync(shim, { force: true });
writeText(shim, renderShim({ node: NODE, runner: RUNNER, win: WIN }));
if (!WIN) chmodSync(shim, 0o755);
if (WIN) {
  const userPath = process.env.Path ?? '';
  if (!userPath.split(';').includes(binDir)) {
    run('powershell.exe', ['-NoProfile', '-Command',
      `$p=[Environment]::GetEnvironmentVariable('Path','User'); if (($p -split ';') -notcontains '${binDir}') { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';${binDir}'), 'User') }`],
      { capture: true });
    note(`added ${binDir} to your PATH (new terminals only)`);
  }
}

// --- 8. smoke test -----------------------------------------------------------------------
say('Smoke test');
const mcp = `${workerUrl}/${secret}/mcp`;
const rpc = (id, name, argsObj) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: argsObj } });
let queued = null;
// A fresh deploy takes a few seconds to reach every edge.
for (let i = 1; i <= 12; i++) {
  try {
    const r = await fetch(mcp, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpc(1, 'run_command', { command: 'echo sasonica-ok', wait: 0 })) });
    if (r.ok) { queued = await r.json(); break; }
  } catch { /* not there yet */ }
  note(`waiting for the deploy to propagate (${i * 5}s)`);
  await new Promise((r) => setTimeout(r, 5000));
}
if (!queued) die(`the Worker did not answer at ${mcp} after a minute`);
const rid = /#(\d+)/.exec(queued.result?.content?.[0]?.text ?? '')?.[1];
if (!rid) die(`unexpected Worker reply: ${JSON.stringify(queued)}`);
const once = run(process.execPath, [RUNNER, '--once'], { capture: true });
for (const line of `${once.out}${once.err}`.trim().split('\n').filter(Boolean)) note(line);
const got = await (await fetch(mcp, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(rpc(2, 'get_result', { id: Number(rid), wait: 30 })) })).json();
if (!/sasonica-ok/.test(got.result?.content?.[0]?.text ?? '')) {
  die(`smoke test failed; the runner did not produce the result: ${JSON.stringify(got)}`);
}
note(`queued #${rid}, ran it, read the output back: OK`);

// --- 9. the service ------------------------------------------------------------------------
if (NO_SERVICE) {
  say(`Not starting the service (--no-service). Run it with: ${NODE} ${RUNNER}`);
} else if (WIN) {
  say('Registering the runner as a Scheduled Task');
  const { registerTask } = await import('./lib/service-windows.mjs');
  note(registerTask({ node: NODE, runner: RUNNER, logPath: path.join(CONF, 'runner.log') }));
} else if (MAC) {
  say('Starting the runner as a macOS LaunchAgent');
  const { installAgent } = await import('./lib/service-macos.mjs');
  for (const line of installAgent({ node: NODE, runner: RUNNER, home: homedir() })) note(line);
} else {
  say('Starting the runner as a systemd user service');
  const { installUnit } = await import('./lib/service-systemd.mjs');
  for (const line of installUnit({ node: NODE, runner: RUNNER, here: HERE, user: userInfo().username })) note(line);
}

// --- 10. hand the URL to the person -----------------------------------------------------------
const connectors = 'https://claude.ai/settings/connectors';
say('Done');
console.log(`
    Connector URL (treat it as a password; it is the only credential):

        ${mcp}
`);
note(`Open ${connectors} in a browser (sign in if it asks).`);
console.log(`    There: Add custom connector -> paste the URL -> no authentication -> save.
    Then ask Claude to run a command, e.g. "run hostname on my machine".
${signin === 'app' ? `
    Or sign in instead of a secret (OAuth, approved in the Sasonica app):

        ${workerUrl}/mcp

    Add it as a custom connector with no secret in it; the assistant opens a
    page to allow it, which shows a code; approve that code in Sasonica on the
    paired phone (Home). Once every assistant signs in, stop the secret URL:
    sasonica client revoke default
` : ''}${ownerEmail && signin !== 'app' ? `
    Or sign in instead of a secret (OAuth; only ${ownerEmail} gets through):

        ${workerUrl}/mcp

    Add it as a custom connector with no secret in it; the assistant opens a
    page to allow it, then Cloudflare Access signs you in (your Cloudflare
    login, or an emailed code if you added One-time PIN). Once every assistant
    signs in, stop the secret URL: sasonica client revoke default
    Signed-in assistants: sasonica client grants
` : ''}
    Status:      sasonica status        (sasonica --help for the rest)
    Skills:      link SKILL.md files into ${path.join(CONF, 'skills')} for assistants to find
    Config:      ${ENV_FILE}   (runner token, URL secret)   ${KEY_FILE}
    Re-run the installer any time (sasonica install); it keeps existing keys and ids.`);
