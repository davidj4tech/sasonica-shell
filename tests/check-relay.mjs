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
const { TenantCore, relayFetch } = await import('../worker/src/tenant.ts');
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
  const env = { TENANTS, RELAY_ADMIN_TOKEN: ADMIN };
  const go = (p, init = {}) => relayFetch(new Request(`https://relay.example${p}`, init), env);
  return { env, objects, rings, go };
}

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
};

const only = process.argv[2];
let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  if (only && name !== only) continue;
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n${e.stack}`); }
}
process.exit(failed ? 1 : 0);
