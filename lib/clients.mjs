// `sasonica client add|list|revoke`: one connector URL per assistant, so a
// single one can be switched off without rotating the URL every other
// assistant holds.
//
// These write the clients table directly, over D1's HTTP API, with the
// Cloudflare token the installer used (CLOUDFLARE_API_TOKEN, or the
// install-token file beside the env file). NOT through the Worker with the
// runner's bearer token: that token sits on the machine all day, and it must
// not be able to mint shell URLs. Minting one takes the same credential that
// could redeploy the Worker anyway.
//
// Only the sha256 of each secret is stored; the full URL is printed once,
// by `add`, and never again.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { urlSecret, connectorUrl } from './install-lib.mjs';
import { CF_API, d1Query } from './cloudflare.mjs';

export const LABEL_RE = /^[a-z0-9._-]{1,32}$/;
export const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

// Mirrors the Worker's CLIENT_CACHE_MS: how long a revoked URL may still be
// accepted by an isolate that had just looked it up.
export const REVOKE_WINDOW_S = 30;

// The token goes on every request, so the API base must be https -- http only
// on loopback, which is where the tests serve a fake of it.
export function apiProblem(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'is not a URL'; }
  if (u.protocol === 'https:') return null;
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  return u.protocol === 'http:' && loopback ? null : 'must be https (http is allowed only on loopback)';
}

// Where the D1 credential comes from, in order. The env file never holds it
// (see renderEnv). install-token first: it is this shell's own, for the
// account its Worker lives in, where a CLOUDFLARE_API_TOKEN in the shell is
// often another account's, for other work (27 Sep 2026: red5's moved to the
// South Pen Labs account and the ambient one still named the old).
export function findToken(cfg, conf) {
  const file = path.join(conf, 'install-token');
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t) return t;
  }
  return (cfg.CLOUDFLARE_API_TOKEN || '').trim();
}

const USAGE = `usage: sasonica client add <label> [--qr]   a new connector URL, printed once (it is a password); --qr as a QR code too
       sasonica client list             every client, and when each last queued a command
       sasonica client revoke <label>   stop a URL working (within ${REVOKE_WINDOW_S} s); 'default' is the shared one
       sasonica client grants           assistants signed in with OAuth, one label each (oauth-<name>)
       sasonica client revoke oauth-<name>   sign that assistant out; it must sign in again
labels: ${LABEL_RE.source.slice(1, -1)}`;

/**
 * OAuth grants (docs/tools-and-approvals.md §6), through the Worker with the
 * runner's token: listing, and revoking -- which only ever takes access away,
 * so unlike minting a URL it needs no Cloudflare token. `runner(op, body)`
 * calls the Worker's runner API.
 */
async function grants(runner, verb, label, { out, err }) {
  if (verb === 'grants') {
    const { grants: list } = await runner('grants');
    if (list === null) { out('OAuth is off on this Worker (docs/tools-and-approvals.md §6).'); return 0; }
    if (!list.length) { out('No assistant is signed in with OAuth.'); return 0; }
    const w = Math.max(...list.map((g) => g.label.length), 5) + 2;
    out(`${pad('label', w)}${pad('signed in', 21)}name`);
    for (const g of list) out(`${pad(g.label, w)}${pad(new Date(g.createdAt * 1000).toISOString().slice(0, 16).replace('T', ' '), 21)}${g.clientName}`);
    return 0;
  }
  const { revoked } = await runner('grant-revoke', { label });
  if (!revoked) { err(`sasonica client revoke: no OAuth grant '${label}' (see sasonica client grants)`); return 1; }
  out(`Signed '${label}' out${revoked > 1 ? ` (${revoked} grants)` : ''}. Its tokens stop working now; it must sign in again.`);
  return 0;
}

const pad = (s, n) => String(s).padEnd(n);

/**
 * Run one `sasonica client` subcommand. Returns the exit code.
 * ctx: { cfg, conf, wordsFile, out, err } -- cfg is the merged env (file over
 * process), out/err print a line.
 */
export async function clientCommand(argv, { cfg, conf, wordsFile, runner, qr, out = console.log, err = console.error }) {
  const [verb, label] = argv;
  if (!['add', 'list', 'revoke', 'grants'].includes(verb)) { err(USAGE); return 2; }
  if (!['list', 'grants'].includes(verb) && !LABEL_RE.test(label ?? '')) {
    err(`sasonica client ${verb}: the label must match ${LABEL_RE.source}`);
    return 2;
  }
  if (verb === 'grants' || (verb === 'revoke' && label.startsWith('oauth-'))) {
    try {
      return await grants(runner, verb, label, { out, err });
    } catch (e) {
      err(`sasonica client ${verb}: ${e.message}`);
      return 1;
    }
  }
  if (verb === 'add' && label.startsWith('oauth-')) {
    err("sasonica client add: 'oauth-' labels belong to assistants signed in with OAuth; pick another");
    return 2;
  }

  const token = findToken(cfg, conf);
  const api = (cfg.SASONICA_CF_API || CF_API).replace(/\/+$/, '');
  const problems = [];
  if (!token) {
    problems.push('no Cloudflare API token: set CLOUDFLARE_API_TOKEN, or put the installer\'s token '
      + `(D1: Edit) in ${path.join(conf, 'install-token')}. The runner's own token cannot do this, by design.`);
  }
  if (!cfg.CLOUDFLARE_ACCOUNT_ID || !cfg.SASONICA_DB_ID) {
    problems.push(`CLOUDFLARE_ACCOUNT_ID or SASONICA_DB_ID is missing from ${path.join(conf, 'env')}; re-run the installer`);
  }
  const bad = apiProblem(api);
  if (bad) problems.push(`SASONICA_CF_API ${bad}`);
  if (problems.length) { for (const p of problems) err(`sasonica client: ${p}`); return 1; }

  const db = { api, token, accountId: cfg.CLOUDFLARE_ACCOUNT_ID, dbId: cfg.SASONICA_DB_ID };
  const q = (sql, params) => d1Query(db, sql, params);
  const shared = cfg.SASONICA_URL_SECRET || '';

  try {
    if (verb === 'add') return await add(q, label, { cfg, wordsFile, out, err, qr });
    if (verb === 'list') return await list(q, shared, out);
    return await revoke(q, label, shared, { out, err });
  } catch (e) {
    err(`sasonica client ${verb}: ${e.message}`);
    // The Worker was deployed before the table existed; the installer adds it.
    if (/no such table: clients/.test(e.message)) err('  the database predates client URLs: re-run the installer (sasonica install)');
    return 1;
  }
}

async function add(q, label, { cfg, wordsFile, out, err, qr }) {
  if (label === 'default') {
    err("sasonica client add: 'default' is the shared URL in SASONICA_URL_SECRET; pick another label");
    return 2;
  }
  const { rows: [have] } = await q('SELECT label, revoked_at FROM clients WHERE label = ?', [label]);
  if (have && have.revoked_at === null) {
    err(`sasonica client add: '${label}' already has a working URL. Revoke it first to issue a new one.`);
    return 1;
  }
  const secret = urlSecret(Number(cfg.SASONICA_SECRET_WORDS ?? 5), wordsFile, (m) => err(`sasonica client: ${m}`));
  // A revoked label is reissued in place: same name, new secret, working
  // again. The old secret's hash is gone with it, so the old URL stays dead.
  if (have) {
    await q(`UPDATE clients SET secret_sha256 = ?, created_at = datetime('now'), revoked_at = NULL
             WHERE label = ?`, [sha256Hex(secret), label]);
  } else {
    await q(`INSERT INTO clients (label, secret_sha256, created_at, revoked_at)
             VALUES (?, ?, datetime('now'), NULL)`, [label, sha256Hex(secret)]);
  }
  // In the named form, the label in the name slot: a person reading the URL
  // (or the rows it queues) can see whose it is. The secret alone decides
  // the client, so the name is only a label here too.
  const base = (cfg.SASONICA_WORKER_URL || '').replace(/\/+$/, '');
  out(`Connector URL for '${label}' (shown once; only its hash is kept -- treat it as a password):`);
  out('');
  const url = connectorUrl(base || '<SASONICA_WORKER_URL>', secret, label);
  out(`    ${url}`);
  out('');
  // --qr: the same URL for a phone's camera (then copy the link into the
  // assistant's connector form).
  if (qr) { qr(url); out(''); }
  out(`It works now; nothing to redeploy. Stop it with: sasonica client revoke ${label}`);
  return 0;
}

async function list(q, shared, out) {
  // Last used = the newest row the URL queued. Free: it reads the commands
  // table rather than writing a timestamp on every request. Rows are pruned
  // after SASONICA_KEEP_DAYS, so a quiet client shows '-' after that.
  const { rows } = await q(`SELECT label, secret_sha256, created_at, revoked_at,
      (SELECT max(created_at) FROM commands WHERE commands.client = clients.label) AS last_used
    FROM clients ORDER BY created_at, label`);
  const { rows: [d] } = await q(`SELECT max(created_at) AS last_used FROM commands WHERE client = 'default'`);
  const lines = [];
  // The shared URL is always listed. A 'default' row revokes it only while
  // it holds the hash of the current secret; after a rotation it is history.
  const drow = rows.find((r) => r.label === 'default');
  const defaultRevoked = drow && drow.revoked_at !== null && (!shared || drow.secret_sha256 === sha256Hex(shared));
  lines.push(['default', '(shared URL)', defaultRevoked ? drow.revoked_at : '-', d?.last_used ?? '-']);
  for (const r of rows) {
    if (r.label === 'default') continue;
    lines.push([r.label, r.created_at, r.revoked_at ?? '-', r.last_used ?? '-']);
  }
  const w = Math.max(...lines.map((l) => l[0].length), 5) + 2;
  out(`${pad('label', w)}${pad('created', 21)}${pad('revoked', 21)}last used`);
  for (const [a, b, c, e] of lines) out(`${pad(a, w)}${pad(b, 21)}${pad(c, 21)}${e}`);
  return 0;
}

async function revoke(q, label, shared, { out, err }) {
  if (label === 'default') {
    if (!shared) { err('sasonica client revoke default: SASONICA_URL_SECRET is not in the env file'); return 1; }
    // The row carries the hash of THIS secret, so it wins over the env secret
    // until the secret is rotated, and a rotated one works again.
    await q(`INSERT INTO clients (label, secret_sha256, created_at, revoked_at)
             VALUES ('default', ?, datetime('now'), datetime('now'))
             ON CONFLICT(label) DO UPDATE SET secret_sha256 = excluded.secret_sha256,
                                              revoked_at = excluded.revoked_at`, [sha256Hex(shared)]);
    out(`Revoked the shared URL. Every assistant using it is cut off within ${REVOKE_WINDOW_S} s; `
      + 'per-client URLs keep working.');
    out('To have a shared URL again, rotate SASONICA_URL_SECRET (SETUP.md, "Rotate the connector URL").');
    return 0;
  }
  const { meta } = await q(`UPDATE clients SET revoked_at = datetime('now')
                            WHERE label = ? AND revoked_at IS NULL`, [label]);
  if (!meta.changes) {
    const { rows: [have] } = await q('SELECT revoked_at FROM clients WHERE label = ?', [label]);
    err(have ? `sasonica client revoke: '${label}' was already revoked (${have.revoked_at})`
             : `sasonica client revoke: no client '${label}' (see sasonica client list)`);
    return 1;
  }
  out(`Revoked '${label}'. Its URL stops working within ${REVOKE_WINDOW_S} s.`);
  return 0;
}
