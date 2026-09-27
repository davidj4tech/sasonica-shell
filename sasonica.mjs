#!/usr/bin/env node
// sasonica.mjs — Sasonica Shell's runner, on every platform, and the
// `sasonica` command. It polls its Worker for signed commands, runs what
// verifies, and writes the results back.
//
// Sasonica Shell was called Runlet until 21 Sep 2026; MIGRATING.md moves an
// install across.
//
//   THIS PROCESS EXECUTES COMMANDS READ FROM A DATABASE, as you.
//   The HMAC check below is what stops a row that merely got INTO the
//   database from running: only a row signed with relay.key is executed.
//
// Usage (the installer puts a `sasonica` shim on PATH that runs this file):
//         sasonica               poll forever (the service form)
//         sasonica --help        the above, for a person or an assistant
//         sasonica --once        one poll, for testing
//         sasonica status [n]    the last n rows (default 10), newest first
//         sasonica skills        the skills listed in SASONICA_SKILLS_DIR
//         sasonica client add|list|revoke [label]
//                                per-assistant connector URLs (lib/clients.mjs)
//         sasonica url [--name <n>]
//                                the shared connector URL, optionally named
//         sasonica sign <nonce> <command>
//         sasonica install [shell] [--no-service|--print-url]
//                                hand over to install.mjs beside this file
//
// Every tunable is re-read from the env file each poll, so editing it is live
// within one interval and needs no restart.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync, readdirSync,
         realpathSync, statSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import { homedir, hostname, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderShim, connectorUrl, URL_NAME_RE } from './lib/install-lib.mjs';
import { clientCommand } from './lib/clients.mjs';

const WIN = process.platform === 'win32';
// This file, for `sasonica install` (install.mjs sits beside it) and for the
// $SASONICA every command is given.
const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.error(`${new Date().toISOString()} sasonica: ${m}`);

// --- config -----------------------------------------------------------------
// Windows has no XDG. Prefer %APPDATA%\sasonica, fall back to
// ~/.config/sasonica so a WSL-made config still works if someone migrates
// across.
const CONF = process.env.SASONICA_CONF
  || (WIN && process.env.APPDATA
      ? path.join(process.env.APPDATA, 'sasonica')
      : path.join(homedir(), '.config', 'sasonica'));
const ENV_FILE = path.join(CONF, 'env');

// The bash runner this replaced did `set -a; . env`, so the FILE wins over
// the ambient environment. Spread it last to match; getting this backwards means a stale
// exported token silently beats the one the installer wrote.
function loadEnv() {
  const out = {};
  if (!existsSync(ENV_FILE)) return out;
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  }
  return out;
}

// The token, key and database ids stay as loaded: changing those under a
// running job is not "on the fly". Only T below is re-read each poll.
const cfg = { ...process.env, ...loadEnv() };

// Read on first use, not at load: `sasonica --help` and `sasonica skills` must
// work on a machine that has no config yet, and reading the key eagerly made
// both die with ENOENT on relay.key.
let KEY_CACHE = null;
const key = () => (KEY_CACHE ??= (cfg.SASONICA_KEY
  ?? readFileSync(cfg.SASONICA_KEY_FILE || path.join(CONF, 'relay.key'), 'utf8')).replace(/\s+/g, ''));
const RUNNER_ID = cfg.SASONICA_RUNNER_ID || hostname().split('.')[0];
const MAX_OUTPUT = Number(cfg.SASONICA_MAX_OUTPUT ?? 60000);

// State, not config: the same split the bash runner made, so the replay
// history never mixes with the settings. %LOCALAPPDATA% is the Windows
// $XDG_STATE_HOME — data that belongs to this machine and is not roamed.
const STATE_HOME = process.env.XDG_STATE_HOME
  || (WIN && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA
      : path.join(homedir(), '.local', 'state'));
const STATE_DIR = path.join(STATE_HOME, 'sasonica');
const SEEN = cfg.SASONICA_NONCE_FILE || path.join(STATE_DIR, 'nonces');
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(path.dirname(SEEN), { recursive: true });

// Validated exactly as the bash runner validated them: a junk value falls back to
// the default rather than disabling the limit it describes.
const num = (v, re, dflt) => (re.test(String(v ?? '')) ? Number(v) : dflt);
const POS = /^[1-9][0-9]*$/, NAT = /^[0-9]+$/, DEC = /^[0-9]+(\.[0-9]+)?$/;
const DETACH_CHECK = num(cfg.SASONICA_DETACH_CHECK, POS, 3) * 1000;   // not reloaded
const T = {
  PARALLEL:       num(cfg.SASONICA_PARALLEL, POS, 1),
  BACKGROUND_MAX: num(cfg.SASONICA_BACKGROUND_MAX, POS, 4),
  CMD_TIMEOUT:    num(cfg.SASONICA_CMD_TIMEOUT, POS, 600),
  POLL:           num(cfg.SASONICA_POLL, POS, 5),
  PROGRESS_EVERY: num(cfg.SASONICA_PROGRESS_EVERY, NAT, 10),
  KEEP_DAYS:      num(cfg.SASONICA_KEEP_DAYS, POS, 30),
  LOAD_MAX:       num(cfg.SASONICA_LOAD_MAX, DEC, 0),
};
const RELOADABLE = [
  ['PARALLEL', 'SASONICA_PARALLEL', POS, 1, ''],
  ['BACKGROUND_MAX', 'SASONICA_BACKGROUND_MAX', POS, 4, ''],
  ['CMD_TIMEOUT', 'SASONICA_CMD_TIMEOUT', POS, 600, 's'],
  ['POLL', 'SASONICA_POLL', POS, 5, 's'],
  ['PROGRESS_EVERY', 'SASONICA_PROGRESS_EVERY', NAT, 10, 's'],
  ['KEEP_DAYS', 'SASONICA_KEEP_DAYS', POS, 30, ''],
  ['LOAD_MAX', 'SASONICA_LOAD_MAX', DEC, 0, ''],
];
function reloadTunables() {
  if (!existsSync(ENV_FILE)) return;
  const env = loadEnv();
  for (const [field, key, re, dflt, unit] of RELOADABLE) {
    // An absent line means the default, so deleting SASONICA_LOAD_MAX releases
    // a hold rather than leaving the last value latched.
    const want = key in env ? num(env[key], re, T[field]) : dflt;
    if (want !== T[field]) {
      log(`${key} now ${want}${unit} (was ${T[field]}${unit})`);
      T[field] = want;
    }
  }
}

// The Worker is the only thing that touches D1. This machine holds a bearer
// token for its own Worker and no Cloudflare credential at all: a D1 API
// token is account-wide, so one on every machine would reach every other
// machine's queue.
const WORKER_URL = (cfg.SASONICA_WORKER_URL || '').replace(/\/+$/, '');
const RUNNER_TOKEN = cfg.SASONICA_RUNNER_TOKEN || '';

// --- signing: identical to relay_hmac / relay_ct_equal ----------------------
// Note the newline between nonce and command — it is part of the signed text.
const hmac = (nonce, command) =>
  createHmac('sha256', key()).update(`${nonce}\n${command}`).digest('hex');

function ctEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// --- subcommands that need no database --------------------------------------
// --- typed tools (docs/tools-and-approvals.md §1) -----------------------------
//
// A skill declares actions with typed arguments in
// `$CONF/tools/<skill>.json`; this publishes them to the Worker, which lists
// them as ordinary MCP tools. A call arrives as a row whose command is
// canonical JSON — the tool's name, its arguments and the sha256 of the
// manifest entry it was made against — and runs a FIXED argv with the
// arguments filled in, through execFile, never a shell.
//
// So the worst a leaked connector URL can do with a tool row is call a tool
// the owner declared, with arguments that pass the schema. It cannot change
// the argv: that template exists only here.
const TOOLS_DIR = path.join(CONF, 'tools');
const TOOL_NAME_RE = /^[a-z0-9][a-z0-9_]{0,40}__[a-z0-9][a-z0-9_]{0,40}$/;
const BUILT_IN_TOOLS = ['run_command', 'cancel', 'detach', 'get_result'];
//: `{ name: {name, description, input, argv, timeout_s, sha256, skill} }`.
let TOOLS = new Map();
let TOOLS_STAMP = '';        // mtimes of the manifests, to notice an edit

/** Canonical JSON: keys sorted at every level, so two sides hash the same text. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The manifests on disk, as a map. A bad file is logged and skipped, never fatal. */
function readToolManifests() {
  const found = new Map();
  let files = [];
  try { files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.json')).sort(); } catch { return found; }
  for (const file of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(path.join(TOOLS_DIR, file), 'utf8')); } catch (e) {
      log(`tools: ${file} is not valid JSON (${e.message}) — skipped`);
      continue;
    }
    const skill = String(doc?.skill || path.basename(file, '.json'));
    for (const t of Array.isArray(doc?.tools) ? doc.tools : []) {
      const name = `${skill}__${String(t?.name ?? '')}`.toLowerCase();
      if (!TOOL_NAME_RE.test(name) || BUILT_IN_TOOLS.includes(name)) {
        log(`tools: ${file}: bad tool name ${JSON.stringify(name)} — skipped`);
        continue;
      }
      if (!Array.isArray(t?.argv) || !t.argv.length || t.argv.some((a) => typeof a !== 'string')) {
        log(`tools: ${name}: argv must be a non-empty array of strings — skipped`);
        continue;
      }
      const entry = {
        name,
        skill,
        description: String(t.description ?? ''),
        input: (t.input && typeof t.input === 'object') ? t.input : { type: 'object' },
        argv: t.argv,
        timeout_s: Number(t.timeout_s) > 0 ? Number(t.timeout_s) : 0,
      };
      // Over everything that decides what runs: a manifest edited after a
      // call was queued gives a different sha, and the call is refused.
      entry.sha256 = sha256Hex(canonical({
        argv: entry.argv, description: entry.description, input: entry.input,
        name: entry.name, timeout_s: entry.timeout_s,
      }));
      found.set(name, entry);
    }
  }
  return found;
}

/** A cheap stamp of the manifests, for noticing an edit without re-reading them. */
function toolsStamp() {
  try {
    return readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.json')).sort()
      .map((f) => {
        const st = statSync(path.join(TOOLS_DIR, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      }).join('|');
  } catch { return ''; }
}

/**
 * Load the manifests and tell the Worker about them, if anything changed.
 * `force` publishes even when nothing did (at startup, and after a failure).
 */
async function publishTools(force = false) {
  const stamp = toolsStamp();
  if (!force && stamp === TOOLS_STAMP) return false;
  TOOLS = readToolManifests();
  TOOLS_STAMP = stamp;
  const tools = [...TOOLS.values()].map(({ name, description, input, sha256 }) =>
    ({ name, description, input, sha256 }));
  try {
    await api('tools', { tools });
    log(`tools: published ${tools.length}${tools.length ? `: ${tools.map((t) => t.name).join(', ')}` : ''}`);
    return true;
  } catch (e) {
    // Try again next tick: an unpublished tool is simply not listed.
    TOOLS_STAMP = '';
    log(`tools: publishing failed (${e.message})`);
    return false;
  }
}

/** `""` when `args` fit `schema`, else what is wrong. The Worker checks first; this is the check that counts. */
function checkArgs(schema, args) {
  if (!schema || typeof schema !== 'object') return '';
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
  for (const want of Array.isArray(schema.required) ? schema.required : []) {
    if (args[String(want)] === undefined) return `missing required argument ${JSON.stringify(want)}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) {
      if (schema.additionalProperties === false || Object.keys(props).length) {
        return `unknown argument ${JSON.stringify(key)}`;
      }
      continue;
    }
    const bad = checkValue(spec, value, key);
    if (bad) return bad;
  }
  return '';
}

function checkValue(spec, value, key) {
  const type = String(spec.type ?? '');
  if (type === 'string' || type === 'number' || type === 'boolean') {
    if (typeof value !== type) return `${key} must be a ${type}`;
  } else if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return `${key} must be an integer`;
  } else if (type === 'array') {
    if (!Array.isArray(value)) return `${key} must be an array`;
    if (spec.maxItems !== undefined && value.length > Number(spec.maxItems)) {
      return `${key} has ${value.length} items; the limit is ${spec.maxItems}`;
    }
    for (const item of value) {
      const bad = checkValue(spec.items ?? {}, item, `each item of ${key}`);
      if (bad) return bad;
    }
    return '';
  }
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
    return `${key} must be one of ${spec.enum.map((e) => JSON.stringify(e)).join(', ')}`;
  }
  if (typeof value === 'string') {
    if (spec.maxLength !== undefined && value.length > Number(spec.maxLength)) {
      return `${key} is ${value.length} characters; the limit is ${spec.maxLength}`;
    }
    if (spec.minLength !== undefined && value.length < Number(spec.minLength)) {
      return `${key} is shorter than ${spec.minLength} characters`;
    }
    if (typeof spec.pattern === 'string') {
      let re;
      try { re = new RegExp(spec.pattern); } catch { return ''; }
      if (!re.test(value)) return `${key} does not match ${spec.pattern}`;
    }
  }
  if (typeof value === 'number') {
    if (spec.minimum !== undefined && value < Number(spec.minimum)) return `${key} is below ${spec.minimum}`;
    if (spec.maximum !== undefined && value > Number(spec.maximum)) return `${key} is above ${spec.maximum}`;
  }
  return '';
}

/**
 * The argv to run, with the arguments filled in — or `{ error }`.
 *
 * Every `{name}` in a template element is replaced by that argument's value,
 * as ONE element. A value is never split, never re-parsed and never reaches
 * a shell, so `; rm -rf ~` is an argument that happens to contain
 * semicolons. An element that is exactly `{name}` for an argument that was
 * not given drops out, which is how an optional argument works; a missing
 * one inside a longer element is an empty string.
 */
function buildArgv(entry, args) {
  const out = [];
  for (const part of entry.argv) {
    const whole = /^\{([a-zA-Z0-9_]+)\}$/.exec(part);
    if (whole) {
      const value = args[whole[1]];
      if (value === undefined || value === null) continue;      // optional, not given
      if (Array.isArray(value)) { out.push(...value.map((v) => String(v))); continue; }
      out.push(String(value));
      continue;
    }
    out.push(part.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => {
      const value = args[k];
      return value === undefined || value === null ? '' : String(value);
    }));
  }
  if (!out.length) return { error: 'the argv template filled in to nothing' };
  return { argv: out };
}

/** What a tool row asks for, checked against this machine's own manifest. */
function planToolRow(command) {
  let asked;
  try { asked = JSON.parse(command); } catch { return { error: 'not a tool call' }; }
  const name = String(asked?.tool ?? '');
  const entry = TOOLS.get(name);
  if (!entry) return { error: `no tool named ${JSON.stringify(name)} on this machine` };
  // The manifest may have been edited since the call was queued. Running the
  // new argv for an old call is exactly what the sha is here to prevent.
  if (String(asked?.manifest_sha ?? '') !== entry.sha256) {
    return { error: `${name}: the manifest changed since this call was made` };
  }
  const args = (asked?.args && typeof asked.args === 'object' && !Array.isArray(asked.args)) ? asked.args : {};
  const bad = checkArgs(entry.input, args);
  if (bad) return { error: `${name}: ${bad}` };
  const built = buildArgv(entry, args);
  if (built.error) return { error: `${name}: ${built.error}` };
  return { entry, argv: built.argv };
}


const [sub, ...rest] = process.argv.slice(2);

if (sub === '--help' || sub === '-h' || sub === 'help') {
  console.log(`sasonica: Sasonica Shell runs signed shell commands queued by an assistant, on this machine.

  sasonica skills        the tools the owner has set up here, and where to read about each
  sasonica tools         the typed tools this machine publishes, and the argv each runs
  sasonica status [n]    the last n rows (default 10), newest first, with who queued each
  sasonica client add <label> | list | revoke <label>
                         one connector URL per assistant, each revocable on its own
                         (needs the installer's Cloudflare token, not the runner's)
  sasonica url [--name <n>]
                         the shared connector URL; --name puts a label in it
                         (.../<secret>/<n>/mcp) so rows say which connector queued
                         them. Every form of it is a PASSWORD: whoever has it can
                         run commands here. Paste it only into a connector.
  sasonica --once        one poll, then exit
  sasonica               poll forever (what the service runs)
  sasonica sign <nonce> <command>   the signature this runner expects
  sasonica install [shell] [--no-service|--print-url]
                         set up or repair this machine (install.mjs)
  sasonica pair [--device <name>]
                         a one-time pairing link + QR: a browser by default, the
                         app with --device (agent-media's media-visual-canvas pair)
  sasonica devices [--revoke <id>]
                         the paired apps, or forget one (its token stops working)

Config: ${ENV_FILE}
  SASONICA_WORKER_URL     this machine's Worker
  SASONICA_RUNNER_TOKEN   its bearer token (no Cloudflare credential lives here)
  SASONICA_KEY_FILE       hex key shared with the Worker (default relay.key beside env)
  SASONICA_POLL           seconds between polls (default 5)
  SASONICA_CMD_TIMEOUT    seconds a command may run (default 600)
  SASONICA_MAX_OUTPUT     bytes of output kept (default 60000)
  SASONICA_PARALLEL       commands run at once (default 1: strictly in order)
  SASONICA_BACKGROUND_MAX rows sent with background=true running at once (default 4)
  SASONICA_DETACH_CHECK   seconds between looks for a detach or cancel (default 3)
  SASONICA_KEEP_DAYS      finished rows older than this are deleted daily (default 30)
  SASONICA_PROGRESS_EVERY seconds between progress copies (default 10; 0 = off)
  SASONICA_LOAD_MAX       hold new commands above this 1-minute load average (0 = off)
  SASONICA_RUNNER_ID      this runner's name on the rows it claims (default: hostname)
  SASONICA_SKILLS_DIR     SKILL.md files that \`skills\` lists (default skills/ beside env)

Every tunable above is re-read each poll: edit the file and it is live within
one interval.`);
  process.exit(0);
}

if (sub === 'sign') {
  // rest[1] whole, never rest.slice(1).join(' '): a command's own runs of
  // spaces are part of the signed text, and argv has already split nothing.
  console.log(hmac(rest[0], rest[1] ?? ''));
  process.exit(0);
}

// `sasonica install`: the umbrella's installer entry (docs/umbrella.md). Only
// the shell exists to install today, so `install` and `install shell` are the
// same thing, and both are install.mjs beside this file -- the command a
// person already has, rather than a path into the checkout they have to
// remember. The piece the umbrella sketches that is not built (link) is refused
// by name rather than silently installing the shell instead.
if (sub === 'install') {
  const args = rest[0] === 'shell' ? rest.slice(1) : rest;
  if (args[0] && !args[0].startsWith('-')) {
    console.error(`sasonica install: '${args[0]}' is not something this can install yet; `
      + 'only the shell exists (sasonica install [shell])');
    process.exit(2);
  }
  const installer = path.join(path.dirname(SELF), 'install.mjs');
  const r = spawnSync(process.execPath, [installer, ...args], { stdio: 'inherit' });
  if (r.error) { console.error(`sasonica install: ${r.error.message}`); process.exit(1); }
  process.exit(r.status ?? 1);
}

// `sasonica pair` / `sasonica devices`: the umbrella's pairing entry
// (docs/umbrella.md) and its other half, listing and revoking what was paired.
// Pairing lives in agent-media's canvas, which owns the codes and the tokens
// they unlock, so these hand over to `media-visual-canvas <sub>`, arguments
// and all: one name to remember, one implementation.
if (sub === 'pair' || sub === 'devices') {
  const r = spawnSync('media-visual-canvas', [sub, ...rest], { stdio: 'inherit' });
  if (r.error?.code === 'ENOENT') {
    console.error(`sasonica ${sub}: media-visual-canvas is not on PATH; `
      + 'pairing needs agent-media on this machine');
    process.exit(1);
  }
  if (r.error) { console.error(`sasonica ${sub}: ${r.error.message}`); process.exit(1); }
  process.exit(r.status ?? 1);
}

if (sub === 'skills') {
  // What this machine offers beyond a bare shell, one entry per file in
  // SASONICA_SKILLS_DIR. The owner curates the directory; nothing is found by
  // scanning the disk. The assistant reads a file in full only when it needs it.
  const dir = cfg.SASONICA_SKILLS_DIR || path.join(CONF, 'skills');
  let entries = [];
  try { entries = readdirSync(dir).sort(); } catch { /* missing = none */ }
  if (!entries.length) {
    console.log(`No skills listed on ${RUNNER_ID}. The owner can add one with:`);
    console.log(`  ln -s /path/to/SKILL.md ${path.join(dir, '<name>.md')}`);
    process.exit(0);
  }
  console.log(`Skills on ${RUNNER_ID}. Read one in full (cat the path) before using it.`);
  for (const e of entries) {
    let f = path.join(dir, e), text;
    try {
      f = realpathSync(f);
      if (statSync(f).isDirectory()) f = path.join(f, 'SKILL.md');
      text = readFileSync(f, 'utf8');
    } catch {
      console.log(`\n${e}: unreadable (${f})`);
      continue;
    }
    const lines = text.split(/\r?\n/);
    // Only the frontmatter: the block between a first-line --- and the next.
    let fm = [];
    if (/^---\s*$/.test(lines[0] ?? '')) {
      const end = lines.slice(1).findIndex((l) => /^---\s*$/.test(l));
      fm = lines.slice(1, end === -1 ? lines.length : end + 1);
    }
    const field = (k) => fm.map((l) => new RegExp(`^${k}:\\s*(.*)$`).exec(l))
      .find(Boolean)?.[1];
    const name = field('name') || e.replace(/\.md$/, '');
    const desc = field('description')
      || lines.find((l) => l.trim() && !/^(---|#)/.test(l)) || '';
    console.log(`\n${name}: ${desc}\n  ${f}`);
  }
  process.exit(0);
}

if (sub === 'tools') {
  // What an assistant is offered beyond run_command: the typed tools this
  // machine publishes (§1 of docs/tools-and-approvals.md). Reads the same
  // manifests the runner does, and prints the argv, which is the part that
  // never leaves here.
  const found = readToolManifests();
  if (!found.size) {
    console.log(`No typed tools on ${RUNNER_ID}. The owner can add one with a manifest in:`);
    console.log(`  ${TOOLS_DIR}/<skill>.json`);
    console.log('  (tools.example/agent-media.json beside sasonica.mjs is a working one)');
    process.exit(0);
  }
  console.log(`Typed tools on ${RUNNER_ID}. Each runs its argv with no shell in the way.`);
  for (const t of found.values()) {
    console.log(`\n${t.name}: ${t.description}`);
    console.log(`  argv: ${JSON.stringify(t.argv)}`);
    const props = Object.keys(t.input?.properties ?? {});
    const req = new Set(t.input?.required ?? []);
    console.log(`  args: ${props.length ? props.map((k) => (req.has(k) ? k : `[${k}]`)).join(', ') : 'none'}`);
    console.log(`  sha256: ${t.sha256}`);
  }
  process.exit(0);
}

// `client`: per-assistant connector URLs. Before the runner-token check on
// purpose -- it does not use the runner's credential at all, but the
// Cloudflare token the installer used (lib/clients.mjs says why).
if (sub === 'client') {
  // OAuth grants go through the Worker with the runner's token (revoking
  // only takes access away); everything else here uses the Cloudflare token.
  const runner = async (op, body = {}) => {
    const base = String(cfg.SASONICA_WORKER_URL || '').replace(/\/+$/, '');
    const u = base ? new URL(base) : null;
    if (!u || !cfg.SASONICA_RUNNER_TOKEN) throw new Error('SASONICA_WORKER_URL or SASONICA_RUNNER_TOKEN is missing; re-run the installer');
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('SASONICA_WORKER_URL must be https');
    const r = await fetch(`${base}/runner`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.SASONICA_RUNNER_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, ...body }), signal: AbortSignal.timeout(60_000),
    });
    if (r.status === 404) throw new Error('the Worker refused this runner (check SASONICA_RUNNER_TOKEN)');
    const out = await r.json().catch(() => null);
    if (!r.ok || out?.error) throw new Error(`worker: ${out?.error ?? r.status}`);
    return out;
  };
  process.exit(await clientCommand(rest, {
    cfg, conf: CONF, wordsFile: path.join(path.dirname(SELF), 'words.txt'), runner,
  }));
}

// `url [--name <n>]`: the shared connector URL, from the env file, with the
// name slot filled when asked. Reads the env file only, like
// `install --print-url`, and needs neither the runner token nor Cloudflare.
// The name labels the rows the URL queues; the secret is the credential, so
// this prints a password whatever name it carries.
if (sub === 'url') {
  const usage = 'usage: sasonica url [--name <n>]    prints the shared connector URL -- a password;\n'
    + `       name: ${URL_NAME_RE.source.slice(1, -1)} (lowercased)`;
  let name = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    const m = /^--name(?:=(.*))?$/.exec(a);
    if (!m) { console.error(usage); process.exit(2); }
    const raw = m[1] ?? rest[++i];
    name = String(raw ?? '').toLowerCase();
    if (!URL_NAME_RE.test(name)) {
      console.error(`sasonica url: the name must match ${URL_NAME_RE.source} after lowercasing`);
      process.exit(2);
    }
  }
  if (!cfg.SASONICA_WORKER_URL || !cfg.SASONICA_URL_SECRET) {
    console.error(`${ENV_FILE} lacks SASONICA_WORKER_URL or SASONICA_URL_SECRET: run the installer first`);
    process.exit(1);
  }
  console.log(connectorUrl(cfg.SASONICA_WORKER_URL, cfg.SASONICA_URL_SECRET, name));
  process.exit(0);
}

// The runner token goes on every request, so the Worker URL must be https --
// over plaintext to anything but this machine it would be handed to whoever
// is listening. Loopback is allowed because the tests serve the real Worker
// there, and a request that never leaves the machine has nothing to sniff.
function checkWorkerUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'is not a URL'; }
  if (u.protocol === 'https:') return null;
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  if (u.protocol === 'http:' && loopback) return null;
  return 'must be https (http is allowed only on loopback)';
}
const urlProblem = WORKER_URL ? checkWorkerUrl(WORKER_URL) : 'is not set';
if (urlProblem || !RUNNER_TOKEN) {
  throw new Error(`sasonica: SASONICA_WORKER_URL ${urlProblem ?? 'is set'}`
    + `${RUNNER_TOKEN ? '' : ' and SASONICA_RUNNER_TOKEN is not set'} in ${ENV_FILE}`
    + ' — re-run the installer if this machine predates them');
}

// `status [n]`: the last rows, newest first -- "is it stuck?" as one command.
if (sub === 'status') {
  const limit = /^[1-9][0-9]*$/.test(rest[0] ?? '') ? Number(rest[0]) : 10;
  const { rows } = await api('status', { limit });
  // client/agent: which URL queued it, and what the assistant called itself;
  // client/name (agent) when the URL carried a name, since the name is the
  // one a person chose. Rows from before either was recorded show '-'.
  const whoOf = (r) => (r.name
    ? `${r.client ?? '-'}/${r.name} (${r.agent ?? '-'})`
    : `${r.client ?? '-'}/${r.agent ?? '-'}`);
  // Padded to the widest on screen: the field now runs from '-/-' to past
  // forty characters, and a tab alone would scatter the command column.
  const width = Math.max(0, ...rows.map((r) => whoOf(r).length));
  for (const r of rows) {
    const code = r.exit_code === null ? '' : ` exit=${r.exit_code}`;
    console.log(`#${r.id}\t${r.status}${code}\t${r.updated_at}\t${whoOf(r).padEnd(width)}\t${r.command}`);
    console.log(`\t\t\t\t${r.output ?? ''}`);
  }
  process.exit(0);
}

// --- the Worker -------------------------------------------------------------
// Every exchange is POST /runner with an `op`. No SQL is built here any more,
// so neither is any SQL escaping.
async function api(op, body = {}) {
  const r = await fetch(`${WORKER_URL}/runner`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, runner: RUNNER_ID, ...body }),
    signal: AbortSignal.timeout(60_000),
  });
  // A 404 is what a wrong or missing token looks like, deliberately: the
  // Worker will not confirm that the runner API is there.
  if (r.status === 404) {
    throw new Error('the Worker refused this runner (check SASONICA_RUNNER_TOKEN)');
  }
  const out = await r.json().catch(() => null);
  if (!r.ok || out?.error) throw new Error(`worker: ${out?.error ?? r.status}`);
  return out;
}

const writeResult = (id, status, code, output) =>
  api('result', { id, status, exitCode: code, output });

// --- execution --------------------------------------------------------------
// Windows has no process groups in the POSIX sense, and detached is NOT the
// equivalent: on win32 it sets DETACHED_PROCESS, which denies the child a
// console, and PowerShell 5.1 then exits 0 immediately having run nothing.
// Detached is for POSIX, where it is setsid() and gives the process group
// that killTree's process.kill(-pid) needs. On Windows nothing is needed:
// taskkill /T walks the parent-child tree by pid, which a bare kill misses.
const SHELL = WIN ? (cfg.SASONICA_SHELL || 'powershell.exe') : '/bin/bash';
// Every command is told where this runner is, as $SASONICA, so an assistant
// can run `"$SASONICA" skills` on a machine whose login shell does not have
// ~/.local/bin on PATH. It points at a shim naming the very node that is
// running now, written into the state directory on first use. Not this file
// and its `env node` shebang: `bash -lc` rebuilds PATH from the login
// profile, and under fnm or nvm that PATH may have no node on it at all --
// which is how the first attempt at this failed its own test. Not the
// installer's shim either, which a runner started by hand may not have.
let SHIM_CACHE = null;
function sasonicaShim() {
  if (SHIM_CACHE) return SHIM_CACHE;
  const file = path.join(STATE_DIR, 'bin', WIN ? 'sasonica.cmd' : 'sasonica');
  mkdirSync(path.dirname(file), { recursive: true });
  // rm first, as the installer does: writing through a symlink someone left
  // here would rewrite whatever it points at.
  try { unlinkSync(file); } catch { /* not there */ }
  writeFileSync(file, renderShim({ node: process.execPath, runner: SELF, win: WIN }), { mode: 0o755 });
  return (SHIM_CACHE = file);
}
const shellArgs = (command) => WIN
  ? ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', command]
  : ['-lc', command];

// The FIRST MAX_OUTPUT bytes, as the bash runner's `head -c` kept: the start of a
// failing command's output is the part that says why. Read without pulling a
// multi-gigabyte log into memory.
const head = (file) => {
  try {
    const size = Math.min(statSync(file).size, MAX_OUTPUT);
    if (!size) return '';
    const buf = Buffer.alloc(size);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, size, 0); } finally { closeSync(fd); }
    return buf.toString('utf8');
  } catch { return ''; }
};

// Returns false when the polite request was refused outright, so the caller
// can escalate now instead of waiting out a grace period that cannot pass.
function killTree(pid, force) {
  if (WIN) {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    try { execFileSync('taskkill', args, { stdio: 'ignore' }); return true; }
    catch { return false; }          // already gone, or "/F required"
  }
  const sig = force ? 'SIGKILL' : 'SIGTERM';
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
  return true;
}
// Is anything left in the job's process group? Not "is the direct child
// alive": a shell that does not trap TERM dies at once while a descendant
// that does traps it survives, and waiting on the child alone would skip the
// forced kill and leave that descendant running. This is the group probe
// the bash runner made with `kill -0 -- -$pgid`.
function groupAlive(pid) {
  if (WIN) return false;           // taskkill /T walks the tree in one go
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

// TERM first, KILL after a grace period, like `timeout --kill-after=10` and
// cancel_job: a job that traps TERM still gets to clean up before it goes.
// Windows refuses the polite form for a console process outright ("can only
// be terminated forcefully"), and says so immediately, so there the grace
// period is skipped rather than burned -- it cost 10s on every timeout.
async function killTreeGracefully(pid, graceMs, alive) {
  if (!killTree(pid, false)) { killTree(pid, true); return; }
  for (let i = 0; i < Math.ceil(graceMs / 1000); i++) {
    if (!alive() && !groupAlive(pid)) return;
    await sleep(1000);
  }
  killTree(pid, true);
}

// Every job this runner started, so a shutdown can take them with it.
// systemd kills the whole cgroup on stop, but launchd kills only its own
// process group, and a job runs in a session of its own (detached), so it
// would survive -- which is what lib/macos-job.py existed to prevent. Doing
// it here covers launchd, Task Scheduler and a plain Ctrl-C alike.
const live = new Map();          // job id -> pid

let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  try {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (live.size) log(`${sig}: stopping ${live.size} running job(s)`);
      for (const pid of live.values()) killTree(pid, true);
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  } catch { /* not every signal exists on every platform */ }
}

// Returns { lane, done }. `lane` settles when the queue may move on — the job
// exited, or it was detached. `done` settles when the result is on the row.
// `run` is either a shell string (run_command) or `{ file, args }` — a typed
// tool's argv, spawned directly with no shell in the picture. A tool may ask
// for a shorter limit than the machine's (`timeout_s` in its manifest);
// nothing may ask for a longer one.
function executeAndWatch(id, run, limitS = 0) {
  const limit = limitS > 0 ? Math.min(limitS, T.CMD_TIMEOUT) : T.CMD_TIMEOUT;
  const outFile = path.join(STATE_DIR, `job.${id}.out`);
  // A raw fd, not createWriteStream: a fresh stream's .fd is still null when
  // spawn validates stdio, and spawn rejects it (ERR_INVALID_ARG_VALUE).
  // spawn dups the fd for the child, so the parent's copy closes right after.
  const fd = openSync(outFile, 'w');
  let child;
  try {
    const [file, args] = typeof run === 'string'
      ? [SHELL, shellArgs(run)]
      : [run.file, run.args];
    child = spawn(file, args, {
      detached: !WIN, windowsHide: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, SASONICA: sasonicaShim() },
    });
  } finally { closeSync(fd); }
  live.set(id, child.pid);

  let running = true, cancelled = false, timedOut = false, detached = false;
  const started = Date.now();
  const exited = new Promise((res) => child.on('close', (code) => { running = false; res(code ?? -1); }));
  let freeLane;
  const lane = new Promise((res) => { freeLane = res; });
  const alive = () => running;

  const timer = setTimeout(() => {
    timedOut = true;
    log(`#${id}: over the ${limit}s limit — stopping it`);
    killTreeGracefully(child.pid, 10_000, alive);
  }, limit * 1000);

  // Poll the row for cancel and background, and copy progress onto it, in
  // step with the bash watcher. Scheduled by the clock, not by loop count.
  let lastProgress = Date.now();
  const watcher = setInterval(async () => {
    try {
      // One request per tick: the progress write and the flag read share a
      // round trip, where they used to cost one each.
      let output;
      if (T.PROGRESS_EVERY > 0 && Date.now() - lastProgress >= T.PROGRESS_EVERY * 1000) {
        lastProgress = Date.now();
        output = head(outFile) || undefined;
      }
      const row = await api('heartbeat', { id, output });
      if (!cancelled && Number(row?.cancel) === 1) {
        cancelled = true;
        log(`#${id}: cancel requested — killing the process tree`);
        await killTreeGracefully(child.pid, 5000, alive);
        return;
      }
      if (!detached && Number(row?.background) === 1) {
        detached = true;
        log(`#${id}: detached after ${Math.round((Date.now() - started) / 1000)}s`
          + ' — it keeps running, the queue moves on');
        freeLane();          // the QUEUE moves on; the child is watched below
      }
    } catch { /* a failed poll is not fatal; try again next tick */ }
  }, DETACH_CHECK);

  const done = exited.then(async (code) => {
    clearTimeout(timer); clearInterval(watcher); live.delete(id);
    const out = head(outFile);
    try { unlinkSync(outFile); } catch {}
    if (cancelled) {
      await writeResult(id, 'cancelled', -1, `${out}\nsasonica: cancelled after it had `
        + 'started; whatever it did before that is done');
      log(`#${id}: cancelled, ${out.length} bytes of output kept`);
    } else if (timedOut) {
      // 124, the code `timeout` gave the bash runner, so a timeout reads the
      // same to anything written against exit_code before the port.
      await writeResult(id, 'timeout', 124, `${out}\nsasonica: killed after `
        + `${limit}s`);
      log(`#${id}: timed out`);
    } else {
      await writeResult(id, 'done', code, out);
      log(`#${id}: exit ${code}, ${out.length} bytes`);
    }
  }).finally(freeLane);

  return { lane, done };
}

// --- the loop ---------------------------------------------------------------
const seen = (nonce) =>
  existsSync(SEEN) && readFileSync(SEEN, 'utf8').split(/\r?\n/).includes(nonce);

// Returns { lane, done } like executeAndWatch; a row that never starts has
// both already settled.
//
// The row arrives already claimed: the Worker's claim is one conditional
// statement, so no second runner can hold it. What is still ours to check is
// what the Worker cannot -- that the row carries a signature made with the
// key only this machine and the Worker share, and a nonce new to this
// machine.
async function runOne({ id, command, sig, nonce, kind }) {
  const settled = { lane: Promise.resolve(), done: Promise.resolve() };
  if (seen(nonce)) {
    log(`#${id}: nonce already used — rejecting as a replay`);
    await writeResult(id, 'rejected', -1, 'sasonica: replayed nonce');
    return settled;
  }
  if (!ctEqual(hmac(nonce, command), sig)) {
    log(`#${id}: BAD SIGNATURE — not executing`);
    await writeResult(id, 'rejected', -1, 'sasonica: signature did not verify');
    return settled;
  }
  appendFileSync(SEEN, `${nonce}\n`);     // append-only: safe under parallelism

  // A typed tool call (§1): what runs is this machine's argv template with
  // the arguments filled in, not anything the row could name.
  let run = command, limitS = 0;
  if (String(kind) === 'tool') {
    const plan = planToolRow(command);
    if (plan.error) {
      log(`#${id}: refused: ${plan.error}`);
      await writeResult(id, 'rejected', -1, `sasonica: ${plan.error}`);
      return settled;
    }
    run = { file: plan.argv[0], args: plan.argv.slice(1) };
    limitS = plan.entry.timeout_s;
    log(`#${id}: running tool ${plan.entry.name}: ${plan.argv.join(' ').slice(0, 120)}`);
  } else {
    log(`#${id}: running: ${command.slice(0, 80)}`);
  }
  // The row is claimed and the nonce is spent, so it can never be retried:
  // anything thrown from here has to land on the row, not in the poll loop.
  try {
    return executeAndWatch(id, run, limitS);
  } catch (e) {
    log(`#${id}: failed to start: ${e.message}`);
    await writeResult(id, 'error', -1, `sasonica: ${e.message}`);
    return settled;
  }
}

// The queue's one serial lane, and the jobs running beside it. A detached
// foreground row leaves the lane while it keeps running, exactly as the bash
// watcher hands over to a background copy of itself.
let fgLane = null;
const bgJobs = new Set();
const inFlight = new Set();      // every unfinished job, for --once to wait on
const fgBusy = () => fgLane !== null;

function track(job, where) {
  const done = job.done.catch((e) => log(`job failed: ${e.message}`));
  inFlight.add(done);
  done.finally(() => inFlight.delete(done));
  if (where === 'bg') {
    bgJobs.add(done);
    done.finally(() => bgJobs.delete(done));
  } else {
    fgLane = job.lane;
    job.lane.finally(() => { if (fgLane === job.lane) fgLane = null; });
  }
}

// Not started while the 1-minute load average is over the ceiling. Windows
// has no load average (os.loadavg() is always zeroes), so the ceiling is
// refused there rather than silently never firing.
let loadHeld = false, loadWarned = false;
function overLoadCeiling() {
  if (T.LOAD_MAX === 0) {
    if (loadHeld) { log('load ceiling removed — resuming'); loadHeld = false; }
    return false;
  }
  if (WIN) {
    if (!loadWarned) { log('SASONICA_LOAD_MAX is set but Windows has no load average — ignoring it'); loadWarned = true; }
    return false;
  }
  const load = loadavg()[0];
  if (load > T.LOAD_MAX) {
    if (!loadHeld) log(`load average ${load.toFixed(2)} is over SASONICA_LOAD_MAX=${T.LOAD_MAX} — not starting new commands until it drops`);
    loadHeld = true;
    return true;
  }
  if (loadHeld) log(`load average ${load.toFixed(2)} is back under ${T.LOAD_MAX} — resuming`);
  loadHeld = false;
  return false;
}

// Trim from poll(), the one place that is never concurrent with an append.
function trimNonces() {
  try {
    // filter(Boolean) first: the file ends in a newline, so a bare split
    // leaves a trailing '' that would cost one real nonce off the tail.
    const lines = readFileSync(SEEN, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 6000) writeFileSync(SEEN, `${lines.slice(-5000).join('\n')}\n`);
  } catch { /* no file yet */ }
}

async function poll() {
  reloadTunables();
  await publishTools();          // a no-op unless a manifest changed
  if (overLoadCeiling()) return 0;
  // A claimed row is already 'running', so ask only for what can start this
  // moment; anything else would be marked running with nothing running it.
  const bg = Math.max(0, T.BACKGROUND_MAX - bgJobs.size);
  const fg = T.PARALLEL > 1
    ? Math.max(0, T.PARALLEL - (bgJobs.size + (fgBusy() ? 1 : 0)))
    : (fgBusy() ? 0 : 1);
  const { rows, signins } = await api('claim', { fg, bg });
  if (typeof signins === 'number') await noteSignins(signins);
  for (const row of rows) {
    const lane = Number(row.background) === 1 || T.PARALLEL > 1 ? 'bg' : 'fg';
    track(await runOne(row), lane);
  }
  trimNonces();
  return rows.length;
}

// --- sign-ins waiting for the owner (SASONICA_SIGNIN=app, §6) ---------------------
// The count rides every claim. When it moves, the waiting ones become one
// "needs you" alert on this machine's alert store (agent-alert, where the
// agent-media server is), so the phone is told and Home shows Approve; none
// waiting clears it. No agent-alert here: nothing to tell, and the owner
// approves from a machine that has one.
let lastSignins = 0;
function agentAlert(args) {
  const exe = [path.join(homedir(), '.local', 'bin', 'agent-alert'), '/usr/local/bin/agent-alert'].find((p) => existsSync(p));
  if (!exe) return;
  const p = spawn(exe, args, { stdio: 'ignore', detached: false });
  p.on('error', () => {});
}
async function noteSignins(n) {
  if (n === lastSignins) return;
  const was = lastSignins;
  lastSignins = n;
  const id = `shell.signin.${RUNNER_ID.toLowerCase().replace(/[^a-z0-9._:-]/g, '-')}`;
  // A clear only after a raise: nothing is reported for a quiet start.
  if (n <= 0) { if (was > 0) agentAlert(['report', id, '--level', 'ok', '--quiet']); return; }
  let rows = [];
  try { ({ signins: rows = [] } = await api('signins')); } catch { rows = []; }
  // One notification that says where to go, and nothing else: --quiet keeps
  // it off the desk's pane and out of speech (the store still notifies the
  // phone, and files no TODO for a sign-in). A new user reads it and knows
  // what to open (David, 27 Sep 2026).
  const first = rows[0] || {};
  const who = first.client_name || 'An assistant';
  const title = rows.length > 1 ? `Approve ${rows.length} sign-ins in Sasonica` : 'Approve a sign-in in Sasonica';
  const detail = rows.length > 1
    ? `${rows.map((r) => `${r.client_name || 'An assistant'} (code ${r.code})`).join(', ')} want to use ${RUNNER_ID}'s shell. `
      + 'Open Sasonica: they are at the top of Home, under Sign-in requests. Approve each only if its code matches its sign-in page.'
    : `${who} wants to use ${RUNNER_ID}'s shell. Open Sasonica: at the top of Home, under Sign-in requests, `
      + `approve code ${first.code || '?'} if it matches the sign-in page.`;
  agentAlert(['report', id, '--level', 'needs', '--title', title, '--detail', detail, '--host', RUNNER_ID, '--quiet']);
  log(`sign-in waiting: ${rows.map((r) => `${r.client_name} (${r.code})`).join(', ')}`);
}

// --- maintenance -------------------------------------------------------------
// Finished rows older than SASONICA_KEEP_DAYS go. The table is the only thing
// here that grows without bound, and nothing reads an old result.
async function pruneOld() {
  const { changed } = await api('prune', { keepDays: T.KEEP_DAYS });
  if (changed > 0) log(`pruned ${changed} finished row(s) older than ${T.KEEP_DAYS} days`);
}

// A row still 'running' when this runner starts belonged to a runner that is
// gone — a restart mid-job takes its children with it. Left alone it would
// stay 'running' forever and a waiting get_result would only ever time out.
async function sweepOrphans() {
  const { changed } = await api('sweep', { kind: 'orphans' });
  if (changed > 0) log(`marked ${changed} orphaned 'running' row(s) of runner '${RUNNER_ID}' as error`);
}

// A row 'running' past the timeout plus a grace period belonged to a job
// whose runner hung rather than restarted. Progress writes keep a talkative
// job's updated_at fresh, so a live job is never caught by this.
async function sweepStale() {
  const { changed } = await api('sweep', { kind: 'stale', staleSeconds: T.CMD_TIMEOUT + 120 });
  if (changed > 0) log(`marked ${changed} stale 'running' row(s) as error`);
}

if (sub === '--once') {
  const n = await poll();
  await Promise.all([...inFlight]);      // the bash runner's --once ended with `wait`
  log(`polled, ${n} row(s)`);
} else {
  log(`Sasonica Shell runner starting as ${RUNNER_ID}, polling every ${T.POLL}s`
    + ` with a ${T.CMD_TIMEOUT}s limit per command`
    + (T.PARALLEL > 1 ? `, up to ${T.PARALLEL} at once` : ''));
  await sweepOrphans();
  await publishTools(true);
  let lastPrune = 0, lastStale = Date.now();
  for (;;) {
    try {
      if (Date.now() - lastPrune >= 86_400_000) { lastPrune = Date.now(); await pruneOld(); }
      if (Date.now() - lastStale >= 300_000) { lastStale = Date.now(); await sweepStale(); }
      await poll();
    } catch (e) { log(`poll failed: ${e.message}`); }
    await sleep(T.POLL * 1000);
  }
}
