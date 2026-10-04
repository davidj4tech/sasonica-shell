#!/usr/bin/env node
// check-relay.mjs -- the hosted relay (docs/hosted-relay.md): tenants made,
// routed and kept apart, over real SQLite standing in for each Durable
// Object's storage.
//
//     node --experimental-strip-types --experimental-sqlite tests/check-relay.mjs
//
// The one property that matters most: nothing of one tenant -- its runner
// token, its connector URL, its rows -- works or shows on another.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sign } from './fake-d1.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(path.join(HERE, '..', 'schema.sql'), 'utf8');
const { TenantCore, relayFetch, accountAllowed } = await import('../worker/src/tenant.ts');
const { JoinCore, JOIN_TTL_MS } = await import('../worker/src/join.ts');
const { resetClientCache } = await import('../worker/src/index.ts');
const ADMIN = 'admin-token-under-test';

// ctx.storage as a Durable Object gives it: sql.exec (one statement with
// bindings, or a script without) and transactionSync.
function fakeStorage() {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    sql: {
      exec(query, ...bindings) {
        if (!bindings.length && query.trim().replace(/;\s*$/, '').includes(';')) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const st = db.prepare(query);
        const rows = /RETURNING|^\s*(SELECT|WITH|PRAGMA)/is.test(query) ? st.all(...bindings) : (st.run(...bindings), []);
        return { toArray: () => rows };
      },
    },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

// The namespace: one TenantCore per name, made on first get, as
// idFromName/get make an object on first use.
function fakeRelay() {
  const objects = new Map();
  const rings = new Map();
  const TENANTS = {
    idFromName: (name) => name,
    get(name) {
      if (!objects.has(name)) {
        const storage = fakeStorage();
        rings.set(name, 0);
        const core = new TenantCore(storage, SCHEMA, () => rings.set(name, rings.get(name) + 1));
        objects.set(name, { core, storage, fetch: (r) => core.fetch(r), init: async (t) => core.init(t) });
      }
      return objects.get(name);
    },
  };
  // The issuer, as far as a join sees it: the token endpoint and userinfo.
  const issuer = { sub: '1', calls: [] };
  const fetcher = async (u, init = {}) => {
    issuer.calls.push({ url: String(u), body: init.body ? String(init.body) : '' });
    if (String(u).endsWith('/oauth/token')) {
      return new URLSearchParams(String(init.body)).get('code') === 'good-code'
        ? Response.json({ access_token: 'at', token_type: 'Bearer' })
        : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    if (String(u).endsWith('/oauth/userinfo')) return Response.json({ sub: issuer.sub, preferred_username: 'david' });
    return new Response('?', { status: 404 });
  };
  const clock = { now: Date.now() };
  const joins = new Map();
  const JOINS = {
    idFromName: (name) => name,
    get(name) {
      if (!joins.has(name)) {
        const core = new JoinCore(fakeStorage(), () => clock.now);
        joins.set(name, {
          core,
          start: (...a) => core.start(...a),
          authorizeUrl: (...a) => core.authorizeUrl(...a),
          callback: (code, origin, list) => core.callback(code, origin, (acct) => accountAllowed(list, acct), fetcher),
          confirm: async (n) => core.confirm(n),
          deliver: async (c) => core.deliver(c),
          collect: (p) => core.collect(p),
        });
      }
      return joins.get(name);
    },
  };
  const env = { TENANTS, JOINS, RELAY_ADMIN_TOKEN: ADMIN, RELAY_ALLOW_ACCOUNTS: 'https://cms.sasonica.com|1' };
  const go = (p, init = {}) => relayFetch(new Request(`https://relay.example${p}`, init), env);
  return { env, objects, rings, go, issuer, clock };
}

// A join up to its confirm page: start, the redirect, the callback.
async function joinToConfirm(relay, machine = 'desk') {
  const started = await (await relay.go('/join/start', { method: 'POST', body: JSON.stringify({ machine }) })).json();
  const to = await relay.go(`/join/${started.id}`);
  const callback = await relay.go(`/join/callback?code=good-code&state=${started.id}`);
  const html = await callback.text();
  const nonce = /name="confirm" value="([0-9a-f]+)"/.exec(html)?.[1];
  return { started, to, callback, html, nonce };
}
const confirmJoin = (relay, id, nonce) => relay.go(`/join/${id}/confirm`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `confirm=${nonce}` });
const pollJoin = (relay, id, poll) => relay.go(`/join/${id}/poll`, { method: 'POST', body: JSON.stringify({ poll }) });

async function makeTenant(relay, account = 'https://cms.sasonica.com|1') {
  const r = await relay.go('/tenants', {
    method: 'POST', headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ account }) });
  assert.equal(r.status, 200);
  return r.json();
}

const prefix = (t) => new URL(t.SASONICA_WORKER_URL).pathname;
const runner = (relay, t, body, token = t.SASONICA_RUNNER_TOKEN, at = t) =>
  relay.go(`${prefix(at)}/runner`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ runner: 'box', ...body }) });
const mcp = (relay, t, method, params = {}, secret = t.SASONICA_URL_SECRET) =>
  relay.go(`${prefix(t)}/${secret}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

const cases = {
  async aTenantIsMadeOnlyWithTheAdminToken() {
    const relay = fakeRelay();
    for (const auth of [{}, { authorization: 'Bearer nope' }]) {
      const r = await relay.go('/tenants', { method: 'POST', headers: auth, body: '{"account":"a"}' });
      assert.equal(r.status, 404);
    }
    const t = await makeTenant(relay);
    assert.match(t.tenant, /^[a-z2-7]{16}$/);
    assert.equal(t.SASONICA_WORKER_URL, `https://relay.example/t/${t.tenant}`);
    assert.equal(t.connector_url, `${t.SASONICA_WORKER_URL}/${t.SASONICA_URL_SECRET}/mcp`);
    // Only hashes of the two credentials are stored; the key has to be.
    const stored = JSON.stringify(relay.objects.get(t.tenant).storage.db.prepare('SELECT * FROM tenant_meta').all())
      + JSON.stringify(relay.objects.get(t.tenant).storage.db.prepare('SELECT * FROM clients').all());
    assert.ok(!stored.includes(t.SASONICA_RUNNER_TOKEN));
    assert.ok(!stored.includes(t.SASONICA_URL_SECRET));
    assert.ok(stored.includes(t.hmac_key));
  },

  async anUnknownTenantIs404AndCreatesNothing() {
    const relay = fakeRelay();
    const r = await relay.go('/t/abcdefghijklmnop/runner', { method: 'POST', headers: { authorization: 'Bearer x' }, body: '{}' });
    assert.equal(r.status, 404);
    const tables = relay.objects.get('abcdefghijklmnop').storage.db.prepare(`SELECT name FROM sqlite_master`).all();
    assert.deepEqual(tables, []);
    for (const p of ['/', '/t/short/runner', '/t/ABCDEFGHIJKLMNOP/runner', '/runner']) {
      assert.equal((await relay.go(p)).status, 404, p);
    }
  },

  async aTenantIsMadeOnce() {
    const relay = fakeRelay();
    const t = await makeTenant(relay);
    const again = relay.objects.get(t.tenant).core.init({
      tenant: t.tenant, account: 'x', hmacKey: 'a'.repeat(64), runnerTokenSha256: 'b'.repeat(64), urlSecretSha256: 'c'.repeat(64) });
    assert.deepEqual(again, { error: 'tenant exists' });
  },

  async aCommandRoundTripsAndRingsTheBell() {
    const relay = fakeRelay();
    const t = await makeTenant(relay);
    const init = await (await mcp(relay, t, 'initialize', { clientInfo: { name: 'Claude-User' } })).json();
    assert.equal(init.result.serverInfo.name, 'sasonica-shell');
    const before = relay.rings.get(t.tenant);
    const q = await (await mcp(relay, t, 'tools/call', { name: 'run_command', arguments: { command: 'echo hi', wait: 0 } })).json();
    assert.match(q.result.content[0].text, /^#1 pending/);
    assert.equal(relay.rings.get(t.tenant), before + 1);
    // The claim answers at once (a held claim is billed; the bell is not)
    // and says the bell is there.
    const started = Date.now();
    const c = await (await runner(relay, t, { op: 'claim', fg: 1, bg: 0, wait: 25 })).json();
    assert.ok(Date.now() - started < 2000);
    assert.equal(c.doorbell, true);
    assert.equal(c.waited, undefined);
    assert.equal(c.rows.length, 1);
    const row = c.rows[0];
    // Signed with this tenant's key, so the runner holding relay.key accepts it.
    assert.equal(row.sig, sign(t.hmac_key, row.nonce, row.command));
    assert.equal((await runner(relay, t, { op: 'result', id: row.id, status: 'done', exitCode: 0, output: 'hi\n' })).status, 200);
    const g = await (await mcp(relay, t, 'tools/call', { name: 'get_result', arguments: { id: row.id } })).json();
    assert.equal(g.result.content[0].text, '#1 done exit=0\nhi\n');
  },

  async cancelSeesOneChangedRow() {
    // changes() rather than rowsWritten: a pending cancel flips status, which
    // also writes the partial index, and must still read as one row.
    const relay = fakeRelay();
    const t = await makeTenant(relay);
    await mcp(relay, t, 'tools/call', { name: 'run_command', arguments: { command: 'sleep 9', wait: 0 } });
    const r = await (await mcp(relay, t, 'tools/call', { name: 'cancel', arguments: { id: 1 } })).json();
    assert.equal(r.result.content[0].text, '#1 cancelled before it started.');
  },

  async toolsPublishInABatch() {
    const relay = fakeRelay();
    const t = await makeTenant(relay);
    const tools = [{ name: 'speak__speak', description: 'Say it.', sha256: 'a'.repeat(64), input: { type: 'object' } }];
    assert.equal((await (await runner(relay, t, { op: 'tools', tools })).json()).tools, 1);
    const listed = await (await mcp(relay, t, 'tools/list')).json();
    assert.ok(listed.result.tools.some((x) => x.name === 'speak__speak'));
  },

  async nothingCrossesBetweenTenants() {
    resetClientCache();
    const relay = fakeRelay();
    const a = await makeTenant(relay, 'acct-a');
    const b = await makeTenant(relay, 'acct-b');
    // A's connector URL works on A first, so the per-isolate cache has seen
    // its hash -- and then must still mean nothing on B.
    assert.equal((await mcp(relay, a, 'ping')).status, 200);
    assert.equal((await mcp(relay, b, 'ping', {}, a.SASONICA_URL_SECRET)).status, 404);
    // A's runner token on B's runner API.
    assert.equal((await runner(relay, a, { op: 'claim', fg: 1 }, a.SASONICA_RUNNER_TOKEN, b)).status, 404);
    // A's row is not B's to claim, see or fetch.
    await mcp(relay, a, 'tools/call', { name: 'run_command', arguments: { command: 'id', wait: 0 } });
    const cb = await (await runner(relay, b, { op: 'claim', fg: 1, bg: 1 })).json();
    assert.deepEqual(cb.rows, []);
    const gb = await (await mcp(relay, b, 'tools/call', { name: 'get_result', arguments: { id: 1 } })).json();
    assert.equal(gb.result.content[0].text, 'No command #1.');
    assert.equal(relay.rings.get(b.tenant), 0);
  },

  // --- joining with a Sasonica account (worker/src/join.ts) ------------------

  async aJoinSignsInConfirmsAndHandsOverOnce() {
    const relay = fakeRelay();
    const { started, to, callback, html, nonce } = await joinToConfirm(relay, 'desk');
    assert.match(started.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(started.url, `https://relay.example/join/${started.id}`);
    // Off to the issuer, with PKCE and the join as the state.
    assert.equal(to.status, 302);
    const auth = new URL(to.headers.get('location'));
    assert.equal(auth.origin + auth.pathname, 'https://cms.sasonica.com/oauth/authorize');
    assert.equal(auth.searchParams.get('client_id'), 'sasonica-relay');
    assert.equal(auth.searchParams.get('state'), started.id);
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('redirect_uri'), 'https://relay.example/join/callback');
    // The token request carried the verifier behind that challenge.
    const verifier = new URLSearchParams(relay.issuer.calls[0].body).get('code_verifier');
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
    assert.equal(digest, auth.searchParams.get('code_challenge'));
    // The confirm page names the machine and the code, and makes nothing yet.
    assert.equal(callback.status, 200);
    assert.ok(html.includes(started.code) && html.includes('desk') && html.includes('david'));
    assert.equal((await (await pollJoin(relay, started.id, started.poll)).json()).status, 'signed-in');
    assert.equal(relay.objects.size, 0);
    const joined = await confirmJoin(relay, started.id, nonce);
    assert.equal(joined.status, 200);
    const creds = await (await pollJoin(relay, started.id, started.poll)).json();
    assert.match(creds.SASONICA_WORKER_URL, /^https:\/\/relay\.example\/t\/[a-z2-7]{16}$/);
    // The credentials work, and went out once.
    assert.equal((await runner(relay, creds, { op: 'claim', fg: 1 })).status, 200);
    assert.equal((await pollJoin(relay, started.id, started.poll)).status, 404);
    // The tenant belongs to the account that signed in.
    const meta = relay.objects.get(creds.tenant).storage.db.prepare(`SELECT value FROM tenant_meta WHERE key = 'account'`).get();
    assert.equal(meta.value, 'https://cms.sasonica.com|1');
  },

  async aJoinNeedsItsPollSecretAndItsConfirm() {
    const relay = fakeRelay();
    const { started, nonce } = await joinToConfirm(relay);
    assert.equal((await pollJoin(relay, started.id, 'f'.repeat(64))).status, 404);
    assert.equal((await confirmJoin(relay, started.id, '0'.repeat(32))).status, 404);
    assert.equal(relay.objects.size, 0);
    assert.equal((await confirmJoin(relay, started.id, nonce)).status, 200);
    // A second press makes no second tenant.
    assert.equal((await confirmJoin(relay, started.id, nonce)).status, 404);
    assert.equal(relay.objects.size, 1);
  },

  async anAccountOffTheListCannotJoin() {
    const relay = fakeRelay();
    relay.issuer.sub = '2';
    const { callback, nonce } = await joinToConfirm(relay);
    assert.equal(callback.status, 403);
    assert.equal(nonce, undefined);
    assert.equal(relay.objects.size, 0);
    assert.equal(accountAllowed('*', 'x|2'), true);
    assert.equal(accountAllowed('', 'https://cms.sasonica.com|1'), false);
  },

  async aBadCodeOrAnOldJoinGoesNowhere() {
    const relay = fakeRelay();
    const s = await (await relay.go('/join/start', { method: 'POST', body: '{}' })).json();
    const bad = await relay.go(`/join/callback?code=bad-code&state=${s.id}`);
    assert.equal(bad.status, 403);
    relay.clock.now += JOIN_TTL_MS + 1000;
    assert.equal((await relay.go(`/join/${s.id}`)).status, 404);
    assert.equal((await pollJoin(relay, s.id, s.poll)).status, 404);
  },

  async theInstallersJoinCollectsOnceJoinIsPressed() {
    const { joinRelay } = await import('../lib/hosted-join.mjs');
    const relay = fakeRelay();
    const fetcher = (u, init) => relayFetch(new Request(u, init), relay.env);
    let shown = null;
    const joined = joinRelay({ relay: 'https://relay.example/', machine: 'desk', fetcher, every: 20,
      show: (url, code) => { shown = { url, code }; } });
    while (!shown) await new Promise((r) => setTimeout(r, 5));
    // The person: open the link, sign in, press Join.
    const id = shown.url.split('/').pop();
    await relay.go(`/join/${id}`);
    const html = await (await relay.go(`/join/callback?code=good-code&state=${id}`)).text();
    assert.ok(html.includes(shown.code));
    await confirmJoin(relay, id, /name="confirm" value="([0-9a-f]+)"/.exec(html)[1]);
    const creds = await joined;
    assert.equal((await runner(relay, creds, { op: 'claim', fg: 1 })).status, 200);
    // Refused: the installer stops with the reason rather than waiting out 15 minutes.
    relay.issuer.sub = '9';
    let shown2 = null;
    const refused = joinRelay({ relay: 'https://relay.example', machine: 'desk', fetcher, every: 20,
      show: (url) => { shown2 = url; } });
    while (!shown2) await new Promise((r) => setTimeout(r, 5));
    await relay.go(`/join/callback?code=good-code&state=${shown2.split('/').pop()}`);
    await assert.rejects(refused, /join ended without this machine/);
  },

  async aMachineNameCannotWriteThePage() {
    const relay = fakeRelay();
    const { html } = await joinToConfirm(relay, '<img src=x onerror=alert(1)>');
    assert.ok(!html.includes('<img'));
  },
};

const only = process.argv[2];
let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  if (only && name !== only) continue;
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n${e.stack}`); }
}
process.exit(failed ? 1 : 0);
