#!/usr/bin/env node
// check-runner.mjs — sasonica.mjs, the runner on every platform, driven against
// the real Worker over real SQLite.
//
//     node tests/check-runner.mjs            every case
//     node tests/check-runner.mjs <name>     one case, in this process
//
// sasonica.mjs reads its config once at module load, so each case runs in
// its own process. Cases marked `loop:` start the polling loop rather than
// --once, and assert while it runs; the rest use --once and assert after.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fakeD1, sign } from './fake-d1.mjs';

// The runner is driven against the REAL Worker, over real SQLite: no mock of
// the protocol sits between them, so a change to either side that breaks the
// other fails here.
const workerModule = await import('../worker/src/index.ts');
const worker = workerModule.default;
const RUNNER_TOKEN = 'runner-token-under-test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'sasonica.mjs');
const KEY = 'ab'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = process.platform === 'win32';

// The jobs the cases queue, in the shell the runner will actually use on this
// platform: bash -lc, or powershell.exe -Command on Windows. Same observable
// behaviour either way, so the assertions below stay platform-free.
const C = {
  helloExit7: WIN
    ? "Write-Output 'hello'; [Console]::Error.WriteLine('to-stderr'); exit 7"
    : 'echo hello; echo to-stderr >&2; exit 7',
  noop: WIN ? 'exit 0' : 'true',
  sleep: (s) => (WIN ? `Start-Sleep -Seconds ${s}` : `sleep ${s}`),
  startThenSleep: (s) => (WIN
    ? `Write-Output 'starting'; [Console]::Out.Flush(); Start-Sleep -Seconds ${s}`
    : `echo starting; sleep ${s}`),
  touch: (f) => (WIN
    ? `New-Item -ItemType File -Force -Path '${f}' | Out-Null`
    : `touch '${f}'`),
  tenAsHundredBs: WIN
    ? "[Console]::Out.Write('A' * 10); [Console]::Out.Write('B' * 100)"
    : 'printf "AAAAAAAAAA"; printf "B%.0s" $(seq 1 100)',
};
// PowerShell ends its lines with CRLF; the runner keeps bytes as they come.
const norm = (s) => (s ?? '').replace(/\r\n/g, '\n');

// --- per-case scaffolding ----------------------------------------------------
let TMP, MARKER, logs = [];

function setup(envLines = {}, ambient = {}) {
  TMP = mkdtempSync(path.join(tmpdir(), 'sasonica-win-'));
  process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
  MARKER = path.join(TMP, 'marker');
  const conf = path.join(TMP, 'conf');
  mkdirSync(conf, { recursive: true });
  writeFileSync(path.join(conf, 'relay.key'), `${KEY}\n`);
  writeFileSync(path.join(conf, 'env'),
    Object.entries(envLines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  Object.assign(process.env, {
    SASONICA_CONF: conf,
    XDG_STATE_HOME: path.join(TMP, 'state'),
    SASONICA_WORKER_URL: 'https://worker.test',
    SASONICA_RUNNER_TOKEN: RUNNER_TOKEN,
    SASONICA_RUNNER_ID: 'testrunner',
    SASONICA_DETACH_CHECK: '1',
    ...ambient,
  });
  // The runner logs through console.error; keep it for assertions and out of
  // the test output unless the case fails.
  const real = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  process.on('exit', () => { console.error = real; });
  return { conf, nonces: path.join(TMP, 'state', 'sasonica', 'nonces') };
}

const job = (command, extra = {}) => {
  const nonce = extra.nonce ?? `n${Math.random().toString(36).slice(2)}`;
  return { command, nonce, sig: extra.sig ?? sign(KEY, nonce, command), ...extra };
};

// Start the runner. `mode` is '--once' or 'loop'. Returns the mock's handle.
async function start(rows, mode = '--once') {
  const db = fakeD1(rows);
  const env = {
    DB: db.binding, SASONICA_HMAC_KEY: KEY,
    SASONICA_URL_SECRET: 'unused-here', SASONICA_RUNNER_TOKEN: RUNNER_TOKEN,
  };
  globalThis.fetch = (url, init) => worker.fetch(new Request(url, init), env);
  process.argv = [process.argv[0], RUNNER, ...(mode === '--once' ? ['--once'] : [])];
  // pathToFileURL, not the bare path: on Windows the ESM loader rejects
  // C:\... as an unsupported 'c:' URL scheme.
  const loaded = import(pathToFileURL(RUNNER).href);
  if (mode === '--once') await loaded; else loaded.catch((e) => { throw e; });
  return db;
}

const until = async (pred, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(100); }
  return false;
};
const logged = (re) => logs.some((l) => re.test(l));

// A real HTTP server in front of the real Worker, so a case can run the
// runner as an actual child process: signals, process groups and shutdown
// only mean anything outside this process. This is what lib/macos-job.py and
// check-platform.py's ProcessTests used to cover.
async function serveWorker(rows) {
  const db = fakeD1(rows);
  const env = {
    DB: db.binding, SASONICA_HMAC_KEY: KEY,
    SASONICA_URL_SECRET: 'unused-here', SASONICA_RUNNER_TOKEN: RUNNER_TOKEN,
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await worker.fetch(new Request(`http://localhost${req.url}`, {
      method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
    }), env);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  process.on('exit', () => server.close());
  return { db, url, stop: () => server.close() };
}

// A stand-in for Cloudflare's D1 HTTP API, over the same SQLite the Worker
// reads, so `sasonica client` writes rows the real Worker then honours. It
// checks the bearer token and the ids in the path as Cloudflare would, and
// counts requests, so a case can show that nothing was sent at all.
const CF_TOKEN = 'cloudflare-token-under-test';
async function serveCloudflare(db) {
  const seen = { requests: 0, auth: [] };
  const server = createServer(async (req, res) => {
    seen.requests++;
    seen.auth.push(req.headers.authorization ?? '');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${CF_TOKEN}`) {
      return reply(403, { success: false, errors: [{ message: 'Authentication error' }] });
    }
    if (req.method !== 'POST' || req.url !== '/client/v4/accounts/acct-test/d1/database/db-test/query') {
      return reply(404, { success: false, errors: [{ message: `no route ${req.url}` }] });
    }
    const { sql, params = [] } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    try {
      const st = db.db.prepare(sql);
      let results = [], meta = {};
      if (/RETURNING|^\s*(SELECT|PRAGMA)/is.test(sql)) results = st.all(...params);
      else { const info = st.run(...params); meta = { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) }; }
      reply(200, { success: true, errors: [], result: [{ success: true, results, meta }] });
    } catch (e) {
      reply(400, { success: false, errors: [{ message: e.message }] });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.on('exit', () => server.close());
  return { seen, api: `http://127.0.0.1:${server.address().port}/client/v4` };
}

// `sasonica client ...` as a real child process. Asynchronous on purpose: the
// fake API above answers from this process's event loop, which a sync spawn
// would block.
function runCli(argv, env) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [RUNNER, 'client', ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => res({ code, out, err }));
  });
}

// A config directory as the installer leaves it, plus whatever a case adds.
function clientConf(extra = {}) {
  const conf = mkdtempSync(path.join(tmpdir(), 'sasonica-clients-'));
  process.on('exit', () => rmSync(conf, { recursive: true, force: true }));
  writeFileSync(path.join(conf, 'env'), Object.entries({
    CLOUDFLARE_ACCOUNT_ID: 'acct-test', SASONICA_DB_ID: 'db-test',
    SASONICA_WORKER_URL: 'https://shell.example.workers.dev', SASONICA_URL_SECRET: 'shared-url-secret',
    SASONICA_RUNNER_TOKEN: RUNNER_TOKEN, ...extra,
  }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return conf;
}
const cliEnv = (conf, api, extra = {}) => {
  const env = { ...process.env, SASONICA_CONF: conf, SASONICA_CF_API: api, ...extra };
  if (!('CLOUDFLARE_API_TOKEN' in extra)) delete env.CLOUDFLARE_API_TOKEN;
  return env;
};

// One MCP call through the real Worker, over the same database, with a cold
// client cache -- what a fresh isolate would answer.
// `path` replaces /<secret>/mcp, to try a URL exactly as it was printed.
async function mcpStatus(db, secret, shared = 'shared-url-secret', path = `/${secret}/mcp`) {
  workerModule.resetClientCache();
  const env = { DB: db.binding, SASONICA_HMAC_KEY: KEY, SASONICA_URL_SECRET: shared, SASONICA_RUNNER_TOKEN: RUNNER_TOKEN };
  const r = await worker.fetch(new Request(`https://w.example${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'run_command', arguments: { command: 'true', wait: 0 } } }),
  }), env);
  return r.status;
}

// Spawn the runner the way a service manager does: its own process, its own
// session, reading the same env file.
function spawnRunner(url, conf, extra = {}) {
  const child = spawn(process.execPath, [RUNNER], {
    env: {
      ...process.env, SASONICA_CONF: conf, SASONICA_WORKER_URL: url,
      SASONICA_RUNNER_TOKEN: RUNNER_TOKEN, SASONICA_RUNNER_ID: 'testrunner',
      XDG_STATE_HOME: path.join(TMP, 'state'), SASONICA_POLL: '1',
      SASONICA_DETACH_CHECK: '1', SASONICA_CMD_TIMEOUT: '120', ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Keep the child's own log; a case that fails because the runner never
  // started should say why rather than just time out.
  child.err = '';
  child.stderr.on('data', (d) => { child.err += d; });
  child.stdout.on('data', (d) => { child.err += d; });
  return child;
}

// A job whose GRANDCHILD keeps writing, and ignores TERM. If only the direct
// child is killed the file keeps growing, which is the bug being tested for.
const grandchildJob = (marker) =>
  `( trap "" TERM; while true; do echo x >> '${marker}'; sleep 0.2; done ) & sleep 60`;

const sizeOf = (f) => { try { return statSync(f).size; } catch { return 0; } };

// The forced kill lands after the grace period (5s for a cancel, as
// the bash runner's cancel_job used), so wait for the writing to stop rather than
// assume how long it takes.
async function stopsGrowing(file, ms = 14000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const before = sizeOf(file);
    await sleep(700);
    if (sizeOf(file) === before) return true;
  }
  return false;
}

// --- cases -------------------------------------------------------------------
// --- typed tools ------------------------------------------------------------
// Two tools whose argv is this very node printing the arguments it was
// handed, so a case can see exactly what reached the process.
const ECHO_ARGS = 'console.log(JSON.stringify(process.argv.slice(1)))';

function writeTools(conf) {
  const dir = path.join(conf, 'tools');
  mkdirSync(dir, { recursive: true });
  const tools = [
    {
      name: 'echo',
      description: 'Print what it was given.',
      input: { type: 'object', properties: { text: { type: 'string', maxLength: 40 } }, required: ['text'] },
      argv: [process.execPath, '-e', ECHO_ARGS, '{text}'],
    },
    {
      name: 'optional',
      description: 'One argument that may be left out.',
      input: { type: 'object', properties: { extra: { type: 'string' } } },
      argv: [process.execPath, '-e', ECHO_ARGS, 'always', '{extra}'],
    },
  ];
  writeFileSync(path.join(dir, 'test.json'), JSON.stringify({ skill: 'test', tools }));
  // The sha the runner will compute, so a case can queue a row against it.
  const shas = {};
  for (const t of tools) {
    const entry = {
      argv: t.argv, description: t.description, input: t.input,
      name: `test__${t.name}`, timeout_s: 0,
    };
    shas[`test__${t.name}`] = createHash('sha256').update(canonicalJson(entry), 'utf8').digest('hex');
  }
  return shas;
}

/** One tool that sleeps for a minute but declares a two-second limit. */
function writeSlowTool(conf) {
  const dir = path.join(conf, 'tools');
  mkdirSync(dir, { recursive: true });
  const tool = {
    name: 'slow',
    description: 'Takes longer than it is allowed to.',
    input: { type: 'object', properties: {} },
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
    timeout_s: 2,
  };
  writeFileSync(path.join(dir, 'test.json'), JSON.stringify({ skill: 'test', tools: [tool] }));
  return createHash('sha256').update(canonicalJson({
    argv: tool.argv, description: tool.description, input: tool.input,
    name: 'test__slow', timeout_s: 2,
  }), 'utf8').digest('hex');
}

/** The runner's canonical JSON: keys sorted at every level. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** A tool row's command, as the Worker writes it. */
const toolCall = (tool, args, manifestSha) => {
  const ordered = {};
  for (const k of Object.keys(args).sort()) ordered[k] = args[k];
  return JSON.stringify({ args: ordered, manifest_sha: manifestSha, tool });
};

const cases = {
  // --- typed tools (docs/tools-and-approvals.md §1) --------------------------
  //
  // A tool row names a tool and its arguments; what runs is THIS machine's
  // argv template, through execFile, with no shell anywhere. The row cannot
  // widen it, and a manifest edited since the call was made is refused.

  async toolsArePublishedAtStartup() {
    const { conf } = setup();
    writeTools(conf);
    const db = await start([]);
    const rows = db.tools();
    assert.deepEqual(rows.map((r) => r.name), ['test__echo', 'test__optional']);
    assert.equal(rows[0].runner, 'testrunner');
    // The argv template never leaves this machine — that is the point.
    assert.ok(!JSON.stringify(rows).includes('argv'), 'an argv reached the Worker');
    assert.ok(logged(/tools: published 2/), logs.join('\n'));
  },

  async aToolRunsItsArgv() {
    const { conf } = setup();
    const sha = writeTools(conf).test__echo;
    const db = await start([job(toolCall('test__echo', { text: 'hello there' }, sha), { kind: 'tool' })]);
    assert.equal(db.row(1).status, 'done');
    assert.equal(db.row(1).exit_code, 0);
    assert.deepEqual(JSON.parse(norm(db.row(1).output)), ['hello there']);
  },

  // The argument is one argv element, whatever is in it: no shell reads it,
  // so there is nothing for a semicolon to mean.
  async anArgumentCannotWidenTheCommand() {
    const { conf } = setup();
    const sha = writeTools(conf).test__echo;
    const nasty = `; touch ${path.basename(MARKER)}; rm -rf ~`;
    const db = await start([job(toolCall('test__echo', { text: nasty }, sha), { kind: 'tool' })]);
    assert.equal(db.row(1).status, 'done', db.row(1).output);
    assert.deepEqual(JSON.parse(norm(db.row(1).output)), [nasty]);
    assert.ok(!existsSync(path.join(process.cwd(), path.basename(MARKER))), 'the argument reached a shell');
  },

  // An optional argument that was not given drops out of the argv instead of
  // arriving as an empty string.
  async anOptionalArgumentDropsOut() {
    const { conf } = setup();
    const sha = writeTools(conf).test__optional;
    const db = await start([job(toolCall('test__optional', {}, sha), { kind: 'tool' })]);
    assert.deepEqual(JSON.parse(norm(db.row(1).output)), ['always']);
  },

  async aChangedManifestRefusesAnOldCall() {
    const { conf } = setup();
    writeTools(conf);
    const db = await start([job(toolCall('test__echo', { text: 'hi' }, 'f'.repeat(64)), { kind: 'tool' })]);
    assert.equal(db.row(1).status, 'rejected');
    assert.match(db.row(1).output, /the manifest changed/);
  },

  async anUnknownToolIsRefused() {
    const { conf } = setup();
    writeTools(conf);
    const db = await start([job(toolCall('nothing__here', {}, 'a'.repeat(64)), { kind: 'tool' })]);
    assert.equal(db.row(1).status, 'rejected');
    assert.match(db.row(1).output, /no tool named "nothing__here"/);
  },

  // The Worker checks the arguments too, but the runner's check is the one
  // that counts: this row was queued straight into the table.
  async theRunnerChecksTheArgumentsItself() {
    const { conf } = setup();
    const sha = writeTools(conf).test__echo;
    const db = await start([job(toolCall('test__echo', { text: 'x'.repeat(50) }, sha), { kind: 'tool' })]);
    assert.equal(db.row(1).status, 'rejected');
    assert.match(db.row(1).output, /text is 50 characters; the limit is 40/);
  },

  // A tool may ask for a shorter limit than the machine's; the manifest says
  // so, and the sha covers it.
  async aToolsOwnTimeoutApplies() {
    const { conf } = setup({ SASONICA_CMD_TIMEOUT: 60 });
    const sha = writeSlowTool(conf);
    const db = await start([job(toolCall('test__slow', {}, sha), { kind: 'tool' })]);
    assert.equal(db.row(1).status, 'timeout');
    assert.equal(db.row(1).exit_code, 124);
    assert.match(norm(db.row(1).output), /killed after 2s/);
  },

  async aBadSignatureIsStillRefusedOnAToolRow() {
    const { conf } = setup();
    const sha = writeTools(conf).test__echo;
    const command = toolCall('test__echo', { text: 'hi' }, sha);
    const db = await start([job(command, { kind: 'tool', sig: 'de'.repeat(32) })]);
    assert.equal(db.row(1).status, 'rejected');
    assert.match(db.row(1).output, /signature did not verify/);
  },

  // THE regression test: the runner passed a not-yet-open createWriteStream to
  // spawn, which throws ERR_INVALID_ARG_VALUE, so every job wedged in 'running'.
  async basic() {
    setup();
    const db = await start([job(C.helloExit7)]);
    assert.equal(db.row(1).status, 'done');
    assert.equal(db.row(1).exit_code, 7);
    // Both streams land in the one file; their order is the shell's business.
    assert.match(norm(db.row(1).output), /hello/);
    assert.match(norm(db.row(1).output), /to-stderr/);
    if (!WIN) assert.equal(db.row(1).output, 'hello\nto-stderr\n');
  },

  async timeout() {
    setup({ SASONICA_CMD_TIMEOUT: 2 });
    const db = await start([job(C.startThenSleep(30))]);
    assert.equal(db.row(1).status, 'timeout');
    // 124 is what `timeout` gave the bash runner; the port must agree.
    assert.equal(db.row(1).exit_code, 124);
    assert.match(norm(db.row(1).output), /starting/);
    assert.match(norm(db.row(1).output), /killed after 2s/);
  },

  // A cancel reaches the job once it is up, and the partial output survives.
  async loopCancel() {
    setup({ SASONICA_POLL: 1, SASONICA_CMD_TIMEOUT: 60 });
    const db = await start([job(C.startThenSleep(30))], 'loop');
    assert.ok(await until(() => db.row(1).status === 'running'), 'row 1 never started');
    db.set(1, 'cancel', 1);
    assert.ok(await until(() => db.row(1).status === 'cancelled'), 'never cancelled');
    assert.equal(db.row(1).exit_code, -1);
    assert.match(norm(db.row(1).output), /starting/);
    assert.match(norm(db.row(1).output), /cancelled after it had started/);
  },

  // Every command is told where the runner is, as $SASONICA, so `"$SASONICA"
  // skills` works where ~/.local/bin is not on the login shell's PATH -- the
  // promise the run_command description makes. The bash runner exported it;
  // the port to Node dropped it without anyone noticing, which is why this is
  // pinned now.
  async sasonicaVarPointsAtRunner() {
    setup();
    const cmd = WIN
      ? 'Write-Output $env:SASONICA; & $env:SASONICA --help | Select-Object -First 1'
      : 'printf "%s\\n" "$SASONICA"; "$SASONICA" --help | head -1';
    const db = await start([job(cmd)]);
    assert.equal(db.row(1).status, 'done', db.row(1).output);
    const [where, help] = norm(db.row(1).output).split('\n');
    // In the state directory, never the config one, and runnable by name.
    assert.ok(where.startsWith(path.join(TMP, 'state', 'sasonica')), `$SASONICA is ${where}`);
    assert.match(readFileSync(where, 'utf8'), /sasonica\.mjs/);
    assert.match(help ?? '', /^sasonica: /, `"$SASONICA" --help did not run: ${db.row(1).output}`);
  },

  // A row whose signature does not verify is rejected and never executed.
  async badSignature() {
    setup();
    const db = await start([job(C.touch(MARKER), { sig: 'f'.repeat(64) })]);
    assert.equal(db.row(1).status, 'rejected');
    assert.match(db.row(1).output, /signature did not verify/);
    assert.equal(existsSync(MARKER), false, 'a rejected command must not run');
  },

  // A nonce already in the file is a replayed row, whoever signed it.
  async replayedNonce() {
    const { nonces } = setup();
    mkdirSync(path.dirname(nonces), { recursive: true });
    writeFileSync(nonces, 'used-before\n');
    const db = await start([job(C.touch(MARKER), { nonce: 'used-before' })]);
    assert.equal(db.row(1).status, 'rejected');
    assert.match(db.row(1).output, /replayed nonce/);
    assert.equal(existsSync(MARKER), false, 'a replayed command must not run');
  },

  // The bash runner did `set -a; . env`, so the env FILE wins over the
  // ambient environment. A 2 s timeout in the file must beat a 60 s one in the env.
  async envFileWins() {
    setup({ SASONICA_CMD_TIMEOUT: 2 }, { SASONICA_CMD_TIMEOUT: '60' });
    const started = Date.now();
    const db = await start([job(C.sleep(30))]);
    assert.equal(db.row(1).status, 'timeout');
    assert.ok(Date.now() - started < 20000, 'the file value was not used');
  },

  // Nonces live under $XDG_STATE_HOME, where the bash runner kept them, not in
  // the config directory: state and settings stay apart.
  async stateUnderXdg() {
    const { conf, nonces } = setup();
    const rows = [job(C.noop)];
    await start(rows);
    assert.ok(existsSync(nonces), `no nonce file at ${nonces}`);
    assert.match(readFileSync(nonces, 'utf8'), new RegExp(rows[0].nonce));
    assert.equal(existsSync(path.join(conf, 'seen-nonces')), false,
      'nonces must not be written into the config directory');
  },

  // With no XDG_STATE_HOME, the default is ~/.local/state — and on Windows,
  // which has no XDG at all, %LOCALAPPDATA%: machine-local, never roamed.
  async defaultStateHome() {
    setup();
    const home = path.join(TMP, 'userhome');
    mkdirSync(home, { recursive: true });
    delete process.env.XDG_STATE_HOME;
    Object.assign(process.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: home });
    const expected = WIN
      ? path.join(home, 'sasonica', 'nonces')
      : path.join(home, '.local', 'state', 'sasonica', 'nonces');
    const rows = [job(C.noop)];
    await start(rows);
    assert.ok(existsSync(expected), `no nonce file at ${expected}`);
    assert.match(readFileSync(expected, 'utf8'), new RegExp(rows[0].nonce));
  },

  // SASONICA_NONCE_FILE relocates it, as the bash runner's did.
  async nonceFileOverride() {
    const custom = path.join(mkdtempSync(path.join(tmpdir(), 'sasonica-nonce-')), 'deep', 'n');
    setup({}, { SASONICA_NONCE_FILE: custom });
    const rows = [job(C.noop)];
    await start(rows);
    assert.match(readFileSync(custom, 'utf8'), new RegExp(rows[0].nonce));
  },

  // The file is trimmed from poll(), or it grows without bound.
  async nonceTrim() {
    const { nonces } = setup();
    mkdirSync(path.dirname(nonces), { recursive: true });
    writeFileSync(nonces, Array.from({ length: 6100 }, (_, i) => `old${i}`).join('\n') + '\n');
    await start([job(C.noop)]);
    const lines = readFileSync(nonces, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length <= 5001, `nonce file not trimmed: ${lines.length} lines`);
    assert.ok(lines.length >= 5000, `trimmed too far: ${lines.length} lines`);
  },

  // The runner keeps the FIRST SASONICA_MAX_OUTPUT bytes (head -c): the start of
  // a failing command's output is the part that says why.
  async outputIsHeadNotTail() {
    setup({ SASONICA_MAX_OUTPUT: 20 });
    const db = await start([job(C.tenAsHundredBs)]);
    assert.equal(db.row(1).output.length, 20);
    assert.match(db.row(1).output, /^AAAAAAAAAA/);
  },

  // A long foreground job must not block the poll loop: a background row
  // queued behind it still starts, and a second foreground row still waits.
  async loopLaneDoesNotBlock() {
    setup({ SASONICA_POLL: 1, SASONICA_CMD_TIMEOUT: 60 });
    const db = await start([job(C.sleep(25))], 'loop');
    assert.ok(await until(() => db.row(1).status === 'running'), 'row 1 never started');
    db.add({ ...job(C.sleep(5)), background: 1 });
    db.add({ ...job(C.noop) });
    assert.ok(await until(() => db.row(2).status === 'running'),
      'a background row did not start beside a running foreground row');
    assert.equal(db.row(1).status, 'running', 'the foreground row should still be running');
    assert.equal(db.row(3).status, 'pending',
      'a second foreground row must wait for the lane');
  },

  // Detaching frees the lane; the job is still watched to its result.
  async loopDetach() {
    setup({ SASONICA_POLL: 1, SASONICA_CMD_TIMEOUT: 60 });
    const db = await start([job(C.sleep(6))], 'loop');
    assert.ok(await until(() => db.row(1).status === 'running'), 'row 1 never started');
    db.set(1, 'background', 1);                     // run_command --detach
    assert.ok(await until(() => logged(/#1: detached after/)), 'never detached');
    db.add({ ...job(C.noop) });
    assert.ok(await until(() => db.row(2).status === 'done'),
      'the lane was not freed by the detach');
    assert.ok(await until(() => db.row(1).status === 'done'),
      'the detached job never wrote its result');
  },

  // SASONICA_BACKGROUND_MAX caps background rows however many are queued.
  async loopBackgroundMax() {
    setup({ SASONICA_POLL: 1, SASONICA_BACKGROUND_MAX: 1, SASONICA_CMD_TIMEOUT: 60 });
    const db = await start([job(C.sleep(4), { background: 1 }), job(C.sleep(1), { background: 1 })],
      'loop');
    assert.ok(await until(() => db.row(1).status === 'running'), 'row 1 never started');
    await sleep(1500);
    assert.equal(db.row(2).status, 'pending', 'SASONICA_BACKGROUND_MAX was not honoured');
    assert.ok(await until(() => db.row(2).status === 'done', 20000),
      'the second background row never ran');
  },

  // Editing the env file is live within one poll.
  async loopReloadTunables() {
    const { conf } = setup({ SASONICA_POLL: 1, SASONICA_CMD_TIMEOUT: 600 });
    await start([], 'loop');
    await sleep(1200);
    writeFileSync(path.join(conf, 'env'), 'SASONICA_POLL=1\nSASONICA_CMD_TIMEOUT=5\n');
    assert.ok(await until(() => logged(/SASONICA_CMD_TIMEOUT now 5s \(was 600s\)/)),
      'the env file was not re-read');
  },

  // A row left 'running' by a runner that died is swept at startup, or a
  // waiting get_result can only ever time out.
  async loopSweepsOrphans() {
    setup({ SASONICA_POLL: 1 });
    const db = await start([{ ...job(C.noop), status: 'running', runner: 'testrunner' }], 'loop');
    assert.ok(await until(() => db.row(1).status === 'error'), 'orphan not swept');
    assert.match(db.row(1).output ?? '', /runner restarted/);
  },

  // Cancelling must reach everything the command started, not just the shell
  // it started. POSIX only: the job runs in its own session and is killed by
  // process group, where Windows uses taskkill /T (covered by loopCancel).
  async posixCancelKillsDescendants() {
    if (WIN) { console.log('  (skipped on Windows: taskkill /T is covered by loopCancel)'); return; }
    const { conf } = setup();
    const marker = path.join(TMP, 'grandchild');
    const { db, url } = await serveWorker([job(grandchildJob(marker))]);
    const runner = spawnRunner(url, conf);
    try {
      assert.ok(await until(() => sizeOf(marker) > 0), `the grandchild never started\n${runner.err}`);
      assert.ok(await until(() => db.row(1).status === 'running'), 'the row never went running');
      db.set(1, 'cancel', 1);
      assert.ok(await until(() => db.row(1).status === 'cancelled'), 'never cancelled');
      assert.ok(await stopsGrowing(marker), 'the grandchild outlived the cancel');
    } finally { runner.kill('SIGKILL'); }
  },

  // Stopping the service must take the jobs with it. systemd kills the whole
  // cgroup, but launchd kills only its own group and a job is in a session of
  // its own, so the runner kills them itself on SIGTERM.
  async posixShutdownKillsJobs() {
    if (WIN) { console.log('  (skipped on Windows: no SIGTERM to a Scheduled Task)'); return; }
    const { conf } = setup();
    const marker = path.join(TMP, 'grandchild2');
    const { db, url } = await serveWorker([job(grandchildJob(marker))]);
    const runner = spawnRunner(url, conf);
    try {
      assert.ok(await until(() => sizeOf(marker) > 0), `the grandchild never started\n${runner.err}`);
      assert.ok(await until(() => db.row(1).status === 'running'), 'the row never went running');
      runner.kill('SIGTERM');
      assert.ok(await until(() => runner.exitCode !== null || runner.signalCode !== null),
        'the runner ignored SIGTERM');
      assert.ok(await stopsGrowing(marker), 'a job outlived the runner that started it');
    } finally { runner.kill('SIGKILL'); }
  },

  // The runner token is a bearer credential on every request, so a plaintext
  // Worker URL would hand it to anyone on the path. Loopback is the exception.
  async refusesPlaintextWorkerUrl() {
    setup();
    process.env.SASONICA_WORKER_URL = 'http://shell.example.com';
    await assert.rejects(() => import(pathToFileURL(RUNNER).href), /must be https/);
  },

  // `sasonica --help` is what an assistant reads to learn the machine's surface,
  // so it has to work before there is any config -- no env file, no
  // relay.key, nothing. A machine that already had one hid this.
  async helpNeedsNoConfig() {
    const empty = mkdtempSync(path.join(tmpdir(), 'sasonica-noconf-'));
    const env = { ...process.env, SASONICA_CONF: empty, HOME: empty, USERPROFILE: empty };
    delete env.SASONICA_KEY;
    const out = execFileSync(process.execPath, [RUNNER, '--help'], { encoding: 'utf8', env });
    for (const expected of ['sasonica skills', 'sasonica status', 'sasonica url', 'sasonica install', 'sasonica pair', 'sasonica devices', 'SASONICA_WORKER_URL']) {
      assert.match(out, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    rmSync(empty, { recursive: true, force: true });
  },

  // `status [n]`: the last rows, newest first, as the bash runner printed them.
  async statusListing() {
    setup();
    const db = fakeD1([
      { ...job('echo one'), status: 'done', exit_code: 0, output: 'first\nsecond', runner: 'w' },
      { ...job('echo two'), status: 'running', runner: 'w' },
    ]);
    db.db.prepare(`UPDATE commands SET client = 'default', agent = 'claude-ai' WHERE id = 2`).run();
    db.add({ ...job('echo three'), status: 'done', exit_code: 0 });
    db.db.prepare(`UPDATE commands SET client = 'default', name = 'desk', agent = 'claude.ai' WHERE id = 3`).run();
    const env = {
      DB: db.binding, SASONICA_HMAC_KEY: KEY,
      SASONICA_URL_SECRET: 'unused-here', SASONICA_RUNNER_TOKEN: RUNNER_TOKEN,
    };
    globalThis.fetch = (url, init) => worker.fetch(new Request(url, init), env);
    process.argv = [process.argv[0], RUNNER, 'status', '5'];
    const out = [];
    const realLog = console.log, realExit = process.exit;
    console.log = (...a) => out.push(a.join(' '));
    process.exit = () => { throw new Error('__exit__'); };
    try { await import(pathToFileURL(RUNNER).href); }
    catch (e) { if (e.message !== '__exit__') throw e; }
    finally { console.log = realLog; process.exit = realExit; }
    // Newest first. A named URL reads client/name (agent); an unnamed one
    // client/agent, as before; the field is padded so commands line up.
    const w = 'default/desk (claude.ai)'.length;
    assert.match(out[0], /^#3\tdone exit=0\t\S+ \S+\tdefault\/desk \(claude\.ai\)\techo three$/);
    assert.equal(out[2].split('\t')[3], 'default/claude-ai'.padEnd(w));
    assert.match(out[2], /^#2\trunning\t\S+ \S+\tdefault\/claude-ai +\techo two$/);
    assert.ok(!/exit=/.test(out[2]), `a running row must not show an exit code: ${out[2]}`);
    assert.match(out[4], /^#1\tdone exit=0\t\S+ \S+\t-\/- +\t/, 'a row from before attribution shows -/-');
    assert.equal(out[4].split('\t')[3].length, w);
    assert.match(out[5], /first \| second/);      // newlines folded onto one line
  },
};

// --- sasonica client ----------------------------------------------------------
const clientCases = {
  // The whole life of a per-client URL: minted, used, listed, revoked,
  // reissued -- with the real Worker deciding whether each URL works.
  async clientAddListRevoke() {
    const db = fakeD1([]);
    const { api } = await serveCloudflare(db);
    const conf = clientConf();
    writeFileSync(path.join(conf, 'install-token'), `${CF_TOKEN}\n`);
    const env = cliEnv(conf, api);

    const added = await runCli(['add', 'chatgpt'], env);
    assert.equal(added.code, 0, added.err);
    const url = /(https:\/\/\S+\/mcp)/.exec(added.out)?.[1];
    assert.ok(url?.startsWith('https://shell.example.workers.dev/'), `no URL printed: ${added.out}`);
    // The named form, the label in the name slot, so the URL says whose it is.
    assert.match(url, /^https:\/\/shell\.example\.workers\.dev\/[^/]+\/chatgpt\/mcp$/);
    const secret = url.split('/').at(-3);
    // Only the hash is stored.
    const row = db.db.prepare(`SELECT * FROM clients WHERE label = 'chatgpt'`).get();
    assert.equal(row.secret_sha256, createHash('sha256').update(secret).digest('hex'));
    assert.equal(row.revoked_at, null);

    assert.equal(await mcpStatus(db, secret, undefined, new URL(url).pathname), 200,
      'the new URL, as printed, should work at once');
    assert.deepEqual([db.row(1).client, db.row(1).name], ['chatgpt', 'chatgpt']);
    // The secret decides the client; the bare form works as well.
    assert.equal(await mcpStatus(db, secret), 200);
    assert.deepEqual([db.row(2).client, db.row(2).name], ['chatgpt', null]);

    const dup = await runCli(['add', 'chatgpt'], env);
    assert.equal(dup.code, 1);
    assert.match(dup.err, /already has a working URL/);

    const listed = await runCli(['list'], env);
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, /^default\s+\(shared URL\)\s+-\s+-$/m);
    assert.match(listed.out, /^chatgpt\s+\d{4}-\d\d-\d\d \S+\s+-\s+\d{4}-\d\d-\d\d/m, 'last used should show the row it queued');
    assert.ok(!listed.out.includes(secret), 'list must never show a secret');

    const revoked = await runCli(['revoke', 'chatgpt'], env);
    assert.equal(revoked.code, 0, revoked.err);
    assert.match(revoked.out, /within 30 s/);
    assert.equal(await mcpStatus(db, secret), 404, 'a revoked URL must stop working');
    assert.equal(await mcpStatus(db, 'shared-url-secret'), 200, 'the shared URL is untouched');
    assert.match((await runCli(['list'], env)).out, /^chatgpt\s+\S+ \S+\s+\d{4}-/m);
    const again = await runCli(['revoke', 'chatgpt'], env);
    assert.equal(again.code, 1);
    assert.match(again.err, /already revoked/);

    // Reissuing a revoked label: a new secret, and the old one stays dead.
    const reissued = await runCli(['add', 'chatgpt'], env);
    assert.equal(reissued.code, 0, reissued.err);
    const secret2 = /\/([^/\s]+)\/chatgpt\/mcp/.exec(reissued.out)[1];
    assert.notEqual(secret2, secret);
    assert.equal(await mcpStatus(db, secret2), 200);
    assert.equal(await mcpStatus(db, secret), 404);
  },

  // Revoking the shared URL leaves per-client ones working, and rotating
  // SASONICA_URL_SECRET brings a shared URL back.
  async clientRevokeDefault() {
    const db = fakeD1([]);
    const { api } = await serveCloudflare(db);
    const conf = clientConf();
    const env = cliEnv(conf, api, { CLOUDFLARE_API_TOKEN: CF_TOKEN });
    const added = await runCli(['add', 'laptop'], env);
    const laptop = /\/([^/\s]+)\/laptop\/mcp/.exec(added.out)[1];
    const r = await runCli(['revoke', 'default'], env);
    assert.equal(r.code, 0, r.err);
    assert.equal(await mcpStatus(db, 'shared-url-secret'), 404);
    assert.equal(await mcpStatus(db, laptop), 200);
    assert.match((await runCli(['list'], env)).out, /^default\s+\(shared URL\)\s+\d{4}-/m);
    assert.equal(await mcpStatus(db, 'rotated-shared-secret', 'rotated-shared-secret'), 200,
      'a rotated shared secret is not covered by the old revocation');
  },

  // Refused before anything is sent: a bad label, 'default' as a new client,
  // and no installer token -- the runner's own token, which IS in the env
  // file, must not stand in for it.
  // OAuth grants go to the Worker with the runner's token, and need no
  // Cloudflare token: a fake runner API on loopback stands in for it.
  async clientGrants() {
    const seen = [];
    let list = [{ id: 'g1', userId: 'o@x', label: 'oauth-claude', clientName: 'Claude', createdAt: 1790000000 }];
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        const body = JSON.parse(b || '{}');
        seen.push({ auth: req.headers.authorization, ...body });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (body.op === 'grants') return res.end(JSON.stringify({ grants: list }));
        const hit = list.filter((g) => g.label === body.label);
        list = list.filter((g) => g.label !== body.label);
        res.end(JSON.stringify({ revoked: hit.length }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const conf = clientConf({ SASONICA_WORKER_URL: `http://127.0.0.1:${server.address().port}` });
      const env = cliEnv(conf, 'http://127.0.0.1:1/client/v4');
      const g = await runCli(['grants'], env);
      assert.equal(g.code, 0, g.err);
      assert.match(g.out, /oauth-claude\s+2026-\d\d-\d\d \d\d:\d\d\s+Claude/);
      const r = await runCli(['revoke', 'oauth-claude'], env);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Signed 'oauth-claude' out/);
      assert.equal(seen.at(-1).op, 'grant-revoke');
      assert.equal(seen.at(-1).auth, `Bearer ${RUNNER_TOKEN}`);
      const again = await runCli(['revoke', 'oauth-claude'], env);
      assert.equal(again.code, 1);
      assert.match(again.err, /no OAuth grant 'oauth-claude'/);
      const add = await runCli(['add', 'oauth-mine'], env);
      assert.equal(add.code, 2, 'oauth- labels are the grants\' own');
    } finally {
      server.close();
    }
  },

  async clientRefusals() {
    const db = fakeD1([]);
    const { api, seen } = await serveCloudflare(db);
    const conf = clientConf();
    const env = cliEnv(conf, api, { CLOUDFLARE_API_TOKEN: CF_TOKEN });
    for (const bad of ['Upper', 'has space', 'x'.repeat(33), '']) {
      const r = await runCli(['add', bad], env);
      assert.equal(r.code, 2, `label '${bad}' should be refused`);
    }
    assert.equal((await runCli(['add', 'default'], env)).code, 2);
    assert.equal((await runCli(['frobnicate'], env)).code, 2);
    assert.equal(seen.requests, 0, 'nothing should reach the API for a refused command');

    const noToken = await runCli(['add', 'phone'], cliEnv(conf, api));
    assert.equal(noToken.code, 1);
    assert.match(noToken.err, /install-token/);
    assert.match(noToken.err, /runner's own token cannot do this/);
    assert.equal(seen.requests, 0, 'with no installer token, no request at all');

    const plaintext = await runCli(['list'], cliEnv(conf, 'http://api.example.com/client/v4', { CLOUDFLARE_API_TOKEN: CF_TOKEN }));
    assert.equal(plaintext.code, 1);
    assert.match(plaintext.err, /must be https/);
  },

  // The runner's bearer token has no way to reach the clients table: the
  // Worker's runner API has no op for it.
  async runnerTokenCannotMintUrls() {
    const db = fakeD1([]);
    const env = { DB: db.binding, SASONICA_HMAC_KEY: KEY, SASONICA_URL_SECRET: 's', SASONICA_RUNNER_TOKEN: RUNNER_TOKEN };
    for (const op of ['client', 'clients', 'add_client']) {
      const r = await worker.fetch(new Request('https://w.example/runner', {
        method: 'POST', headers: { authorization: `Bearer ${RUNNER_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ op, label: 'x', secret_sha256: 'y' }),
      }), env);
      assert.equal(r.status, 400);
    }
    assert.equal(db.db.prepare('SELECT count(*) AS n FROM clients').get().n, 0);
  },
};

// Cases that need no database run as subprocesses of the real script.
const cliCases = {
  signMatchesVectors() {
    const v = JSON.parse(readFileSync(path.join(HERE, 'vectors.json'), 'utf8'));
    for (const t of v.vectors) {
      const cmd = Buffer.from(t.command_b64, 'base64').toString('utf8');
      const got = execFileSync(process.execPath, [RUNNER, 'sign', t.nonce, cmd],
        { env: { ...process.env, SASONICA_KEY: v.key }, encoding: 'utf8' }).trim();
      assert.equal(got, t.expected, `vector ${t.name}`);
    }
  },

  // `sasonica install` is install.mjs under the command a person already has.
  // --print-url is the one path through it that touches nothing, so it shows
  // the hand-over (arguments included) without provisioning anything; and a
  // piece of the umbrella that does not exist yet is refused, not quietly
  // turned into a shell install.
  installHandsOver() {
    const tmp = mkdtempSync(path.join(tmpdir(), 'sasonica-install-'));
    writeFileSync(path.join(tmp, 'env'),
      'SASONICA_WORKER_URL=https://w.example\nSASONICA_URL_SECRET=one-two-three-four\n');
    const env = { ...process.env, SASONICA_CONF: tmp };
    for (const argv of [['install', '--print-url'], ['install', 'shell', '--print-url']]) {
      const out = execFileSync(process.execPath, [RUNNER, ...argv], { env, encoding: 'utf8' });
      assert.equal(out.trim(), 'https://w.example/one-two-three-four/mcp', argv.join(' '));
    }
    let refused = null;
    try { execFileSync(process.execPath, [RUNNER, 'install', 'link'], { env, stdio: 'pipe' }); }
    catch (e) { refused = e; }
    assert.ok(refused, '`sasonica install link` should refuse: there is no link installer yet');
    assert.equal(refused.status, 2);
    assert.match(String(refused.stderr), /only the shell exists/);
    rmSync(tmp, { recursive: true, force: true });
  },

  // `sasonica pair` (and `devices`) is agent-media's `media-visual-canvas pair` under the
  // umbrella's name: it hands over with the arguments intact and the exit
  // status kept, and says what is missing when agent-media is not installed.
  pairHandsOver() {
    if (process.platform === 'win32') return;   // the stand-in below is a shell script
    const bin = mkdtempSync(path.join(tmpdir(), 'sasonica-pair-'));
    const fake = path.join(bin, 'media-visual-canvas');
    writeFileSync(fake, '#!/bin/sh\necho "args: $*"\nexit 3\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const r = spawnSync(process.execPath, [RUNNER, 'pair', '--device', 'Pixel 8a'], { env, encoding: 'utf8' });
    assert.equal(r.stdout.trim(), 'args: pair --device Pixel 8a');
    assert.equal(r.status, 3);
    const dev = spawnSync(process.execPath, [RUNNER, 'devices', '--revoke', 'abc'], { env, encoding: 'utf8' });
    assert.equal(dev.stdout.trim(), 'args: devices --revoke abc');
    const none = spawnSync(process.execPath, [RUNNER, 'pair'],
      { env: { ...process.env, PATH: bin + '-missing' }, encoding: 'utf8' });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /media-visual-canvas is not on PATH/);
    rmSync(bin, { recursive: true, force: true });
  },

  // `sasonica url [--name <n>]`: the shared URL from the env file, with the
  // name slot filled when asked. Needs no runner token and no Cloudflare
  // credential, and refuses a name the Worker would 404.
  urlCommand() {
    const tmp = mkdtempSync(path.join(tmpdir(), 'sasonica-url-'));
    writeFileSync(path.join(tmp, 'env'),
      'SASONICA_WORKER_URL=https://w.example/\nSASONICA_URL_SECRET=one-two-three-four\n');
    const env = { ...process.env, SASONICA_CONF: tmp };
    delete env.SASONICA_RUNNER_TOKEN; delete env.SASONICA_WORKER_URL; delete env.SASONICA_URL_SECRET;
    const url = (...argv) => execFileSync(process.execPath, [RUNNER, 'url', ...argv], { env, encoding: 'utf8' }).trim();
    assert.equal(url(), 'https://w.example/one-two-three-four/mcp');
    assert.equal(url('--name', 'desk'), 'https://w.example/one-two-three-four/desk/mcp');
    assert.equal(url('--name=Phone.2'), 'https://w.example/one-two-three-four/phone.2/mcp', 'lowercased');
    assert.match(url('--help'), /password/i);
    const fails = (argv, conf = tmp) => {
      try { execFileSync(process.execPath, [RUNNER, 'url', ...argv], { env: { ...env, SASONICA_CONF: conf }, stdio: 'pipe' }); }
      catch (e) { return e; }
      assert.fail(`sasonica url ${argv.join(' ')} should have failed`);
    };
    for (const bad of [['--name', 'has space'], ['--name', 'x'.repeat(33)], ['--name', 'a/b'], ['--name'], ['--name='], ['desk']]) {
      const e = fails(bad);
      assert.equal(e.status, 2, `sasonica url ${bad.join(' ')}`);
      assert.equal(String(e.stdout), '', 'a refused name must print no URL');
    }
    const empty = mkdtempSync(path.join(tmpdir(), 'sasonica-url-none-'));
    const missing = fails([], empty);
    assert.equal(missing.status, 1);
    assert.match(String(missing.stderr), /run the installer first/);
    rmSync(tmp, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  },

  skillsListing() {
    const tmp = mkdtempSync(path.join(tmpdir(), 'sasonica-skills-'));
    const env = { ...process.env, SASONICA_CONF: tmp, SASONICA_SKILLS_DIR: path.join(tmp, 'skills'),
                  SASONICA_KEY: KEY };
    const run = () => execFileSync(process.execPath, [RUNNER, 'skills'], { env, encoding: 'utf8' });
    assert.match(run(), /No skills listed/);
    mkdirSync(env.SASONICA_SKILLS_DIR);
    writeFileSync(path.join(env.SASONICA_SKILLS_DIR, 'deploy.md'),
      '---\nname: deploy\ndescription: push the site live\n---\n\nSteps.\n');
    const out = run();
    assert.match(out, /deploy: push the site live/);
    assert.match(out, /deploy\.md/);
    rmSync(tmp, { recursive: true, force: true });
  },
};

// --- driver ------------------------------------------------------------------
const all = { ...cases, ...clientCases, ...cliCases };
const name = process.argv[2];

if (name) {
  const fn = all[name];
  if (!fn) { console.log(`unknown case: ${name}`); process.exit(2); }
  await fn();
  process.exit(0);
} else {
  let failed = 0;
  for (const c of Object.keys(all)) {
    const t0 = Date.now();
    const r = await new Promise((res) => {
      const p = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), c],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.stdout.on('data', (d) => { err += d; });
      p.on('close', (code) => res({ code, err }));
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.code === 0) console.log(`  ok    ${c} (${secs}s)`);
    else { failed++; console.log(`  FAIL  ${c} (${secs}s)\n${r.err.replace(/^/gm, '        ')}`); }
  }
  console.log(failed ? `check-runner: ${failed} case(s) failed` : `check-runner: ${Object.keys(all).length} cases, all pass`);
  process.exit(failed ? 1 : 0);
}
