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
const { TenantCore, relayFetch, accountAllowed, relaySettings, RateWindow, DAY_MS } = await import('../worker/src/tenant.ts');
const { AccountCore } = await import('../worker/src/account.ts');
const { JoinCore, JOIN_TTL_MS } = await import('../worker/src/join.ts');
const { resetClientCache } = await import('../worker/src/index.ts');
const ADMIN = 'admin-token-under-test';
const HOOK = 'hook-token-under-test';
const DAVID = 'https://cms.sasonica.com|1';

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
  const env = {};
  const objects = new Map();
  const rings = new Map();
  const TENANTS = {
    idFromName: (name) => name,
    get(name) {
      if (!objects.has(name)) {
        const storage = fakeStorage();
        rings.set(name, 0);
        const core = new TenantCore(storage, SCHEMA, () => rings.set(name, rings.get(name) + 1), () => {
          const st = relaySettings(env);
          return { mcp: st.mcpPerMin, runner: st.runnerPerMin };
        });
        objects.set(name, {
          core, storage, fetch: (r) => core.fetch(r), init: async (t) => core.init(t), info: async () => core.info(),
          // What deleteAll does to a Durable Object: nothing of it is left.
          destroy: async () => {
            for (const { name: t } of storage.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all()) {
              storage.db.exec(`DROP TABLE "${t}"`);
            }
            core.forget();
            return true;
          },
        });
      }
      return objects.get(name);
    },
  };
  const accounts = new Map();
  const ACCOUNTS = {
    idFromName: (name) => name,
    get(name) {
      if (!accounts.has(name)) {
        const core = new AccountCore(fakeStorage());
        accounts.set(name, { core, list: async () => core.list(), add: async (e) => core.add(e), remove: async (t) => core.remove(t) });
      }
      return accounts.get(name);
    },
  };
  // The issuer, as far as a join sees it: the token endpoint and userinfo.
  // Access token 'at' is whoever signed in last (issuer.sub); 'tok-<sub>' is that account's.
  const issuer = { sub: '1', calls: [] };
  const fetcher = async (u, init = {}) => {
    issuer.calls.push({ url: String(u), body: init.body ? String(init.body) : '' });
    if (String(u).endsWith('/oauth/token')) {
      return new URLSearchParams(String(init.body)).get('code') === 'good-code'
        ? Response.json({ access_token: 'at', token_type: 'Bearer' })
        : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    if (String(u).endsWith('/oauth/userinfo')) {
      const tok = String(new Headers(init.headers).get('authorization') ?? '').replace(/^Bearer /, '');
      const sub = tok === 'at' ? issuer.sub : (/^tok-(\d+)$/.exec(tok)?.[1] ?? '');
      return sub ? Response.json({ sub, preferred_username: sub === '1' ? 'david' : `user${sub}` })
        : Response.json({ error: 'invalid_token' }, { status: 401 });
    }
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
  // The per-IP Limiter objects.
  const limiters = new Map();
  const LIMITS = {
    idFromName: (name) => name,
    get(name) {
      if (!limiters.has(name)) {
        const w = new RateWindow();
        limiters.set(name, { hit: async (k, limit) => w.hit(k, limit) });
      }
      return limiters.get(name);
    },
  };
  Object.assign(env, {
    TENANTS, JOINS, ACCOUNTS, LIMITS, RELAY_ADMIN_TOKEN: ADMIN, RELAY_ALLOW_ACCOUNTS: 'https://cms.sasonica.com|1,https://cms.sasonica.com|2',
    RELAY_ACCOUNT_HOOK_TOKEN: HOOK, RELAY_JOIN_PER_MIN: '1000', ISSUER_FETCH: fetcher,
  });
  const go = (p, init = {}) => relayFetch(new Request(`https://relay.example${p}`, init), env);
  return { env, objects, accounts, rings, go, issuer, clock };
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

async function makeTenant(relay, account = 'https://cms.sasonica.com|1', machine = undefined) {
  const r = await relay.go('/tenants', {
    method: 'POST', headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ account, machine }) });
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
    relay.issuer.sub = '3';
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


// --- opening it: limits, one machine per account, retention, the account's list ---

Object.assign(cases, {
  async joinStartIsLimitedPerIp() {
    const relay = fakeRelay();
    relay.env.RELAY_JOIN_PER_MIN = '2';
    const start = (ip) => relay.go('/join/start', { method: 'POST', headers: { 'cf-connecting-ip': ip }, body: '{}' });
    assert.equal((await start('1.1.1.1')).status, 200);
    assert.equal((await start('1.1.1.1')).status, 200);
    const third = await start('1.1.1.1');
    assert.equal(third.status, 429);
    assert.equal(third.headers.get('retry-after'), '60');
    assert.equal((await start('2.2.2.2')).status, 200);
    // A limiter that fails lets the request through rather than closing the relay.
    relay.env.LIMITS = { idFromName: (n) => n, get: () => ({ hit: async () => { throw new Error('down'); } }) };
    assert.equal((await start('1.1.1.1')).status, 200);
    // The window: a minute.
    const w = new RateWindow();
    assert.deepEqual([w.hit('k', 1, 0), w.hit('k', 1, 59_999), w.hit('k', 1, 60_000)], [true, false, true]);
  },

  async mcpAndRunnerAreLimitedPerTenantCredential() {
    const relay = fakeRelay();
    relay.env.RELAY_MCP_PER_MIN = '3';
    relay.env.RELAY_RUNNER_PER_MIN = '2';
    const a = await makeTenant(relay, 'acct-a');
    const b = await makeTenant(relay, 'acct-b');
    // A stranger guessing at A's URL spends their own allowance, not A's.
    for (let i = 0; i < 5; i++) await mcp(relay, a, 'ping', {}, 'f'.repeat(48));
    for (let i = 0; i < 3; i++) assert.equal((await mcp(relay, a, 'ping')).status, 200);
    const over = await mcp(relay, a, 'ping');
    assert.equal(over.status, 429);
    assert.equal((await over.json()).error.code, -32000);
    assert.equal((await mcp(relay, b, 'ping')).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await runner(relay, a, { op: 'claim', fg: 1 })).status, 200);
    assert.equal((await runner(relay, a, { op: 'claim', fg: 1 })).status, 429);
    assert.equal((await runner(relay, b, { op: 'claim', fg: 1 })).status, 200);
  },

  async aSecondJoinReplacesTheFirstAndSaysSo() {
    const relay = fakeRelay();
    const first = await joinToConfirm(relay, 'old-desk');
    assert.ok(first.html.includes('>Join<') && !first.html.includes('Replace'));
    await confirmJoin(relay, first.started.id, first.nonce);
    const old = await (await pollJoin(relay, first.started.id, first.started.poll)).json();
    assert.equal((await runner(relay, old, { op: 'claim', fg: 1 })).status, 200);
    // The second join says, before the button, what it will remove.
    const second = await joinToConfirm(relay, 'new-laptop');
    assert.ok(second.html.includes('Replace and join'));
    assert.ok(second.html.includes('removes <b>old-desk</b>'));
    // Nothing is removed by looking at the page.
    assert.equal((await runner(relay, old, { op: 'claim', fg: 1 })).status, 200);
    const done = await (await confirmJoin(relay, second.started.id, second.nonce)).text();
    assert.ok(done.includes('Removed from your relay: <b>old-desk</b>'));
    const fresh = await (await pollJoin(relay, second.started.id, second.started.poll)).json();
    assert.equal((await runner(relay, old, { op: 'claim', fg: 1 })).status, 404);
    assert.equal((await mcp(relay, old, 'ping')).status, 404);
    assert.equal((await runner(relay, fresh, { op: 'claim', fg: 1 })).status, 200);
    assert.deepEqual((await relay.accounts.get(DAVID).list()).map((e) => e.machine), ['new-laptop']);
    // Configurable: with two allowed, a second machine is simply added.
    relay.env.RELAY_MACHINES_PER_ACCOUNT = '2';
    const third = await joinToConfirm(relay, 'pi');
    assert.ok(!third.html.includes('Replace'));
    await confirmJoin(relay, third.started.id, third.nonce);
    assert.deepEqual((await relay.accounts.get(DAVID).list()).map((e) => e.machine).sort(), ['new-laptop', 'pi']);
  },

  async retentionDropsOldRowsAndFindsDormantTenants() {
    const relay = fakeRelay();
    const t = await makeTenant(relay);
    const { core, storage } = relay.objects.get(t.tenant);
    for (const age of [40, 31, 29, 1]) {
      await mcp(relay, t, 'tools/call', { name: 'run_command', arguments: { command: `echo ${age}`, wait: 0 } });
      storage.db.prepare(`UPDATE commands SET created_at = datetime('now', ?) WHERE id = (SELECT max(id) FROM commands)`).run(`-${age} days`);
    }
    storage.db.prepare(`INSERT INTO signins (id, code, state, created_at) VALUES ('x', 'ABC', 's', datetime('now', '-2 days'))`).run();
    const now = Date.now();
    // A tenant from before contact was recorded starts its clock at the first alarm.
    assert.equal(core.info().last_seen, null);
    const r = core.retain(now, 30, 90);
    assert.deepEqual(r, { deleted: 2, dormant: false });
    // Pending or not: the relay keeps nothing past 30 days.
    assert.deepEqual(storage.db.prepare(`SELECT command FROM commands ORDER BY id`).all().map((x) => x.command), ['echo 29', 'echo 1']);
    assert.equal(storage.db.prepare(`SELECT count(*) AS n FROM signins`).get().n, 0);
    assert.ok(core.info().last_seen);
    assert.equal(core.retain(now + 89 * DAY_MS, 30, 90).dormant, false);
    assert.equal(core.retain(now + 91 * DAY_MS, 30, 90).dormant, true);
    // The runner's contact resets it (written at most hourly).
    await runner(relay, t, { op: 'claim', fg: 1 });
    const seen = Date.parse(core.info().last_seen);
    await runner(relay, t, { op: 'claim', fg: 1 });
    assert.equal(Date.parse(core.info().last_seen), seen);
    core.noteRunner(now + 91 * DAY_MS);
    assert.equal(core.retain(now + 92 * DAY_MS, 30, 90).dormant, false);
  },

  async anAccountListsAndRemovesOnlyItsOwnMachines() {
    const relay = fakeRelay();
    const mine = await makeTenant(relay, DAVID, 'desk');
    const theirs = await makeTenant(relay, 'https://cms.sasonica.com|2', 'other');
    const as = (tok, init = {}) => ({ ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${tok}` } });
    assert.equal((await relay.go('/account/machines')).status, 401);
    assert.equal((await relay.go('/account/machines', as('nonsense'))).status, 401);
    const listed = await (await relay.go('/account/machines', as('tok-1'))).json();
    assert.equal(listed.account, DAVID);
    assert.deepEqual(listed.machines.map((m) => [m.tenant, m.machine]), [[mine.tenant, 'desk']]);
    assert.ok(!JSON.stringify(listed).includes(mine.SASONICA_RUNNER_TOKEN));
    // Not one's own: as if it did not exist.
    assert.equal((await relay.go(`/account/machines/${theirs.tenant}`, as('tok-1', { method: 'DELETE' }))).status, 404);
    assert.equal((await mcp(relay, theirs, 'ping')).status, 200);
    assert.equal((await relay.go(`/account/machines/${mine.tenant}`, as('tok-1', { method: 'DELETE' }))).status, 200);
    assert.equal((await mcp(relay, mine, 'ping')).status, 404);
    assert.deepEqual((await (await relay.go('/account/machines', as('tok-1'))).json()).machines, []);
  },

  async theAccountPageSignsInListsAndRemoves() {
    const relay = fakeRelay();
    const t = await makeTenant(relay, DAVID, 'desk');
    const start = await relay.go('/account');
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get('location'));
    assert.equal(to.searchParams.get('redirect_uri'), 'https://relay.example/join/callback');
    const state = to.searchParams.get('state');
    assert.match(state, /^acct\.[0-9a-f]{32}$/);
    const pkce = /sas_pkce=([^;]+)/.exec(start.headers.get('set-cookie'))[1];
    // Back without the cookie (another browser): nothing.
    assert.equal((await relay.go(`/join/callback?code=good-code&state=${state}`)).status, 400);
    const back = await relay.go(`/join/callback?code=good-code&state=${state}`, { headers: { cookie: `sas_pkce=${pkce}` } });
    assert.equal(back.status, 303);
    assert.equal(back.headers.get('location'), '/account');
    const cookies = back.headers.getSetCookie();
    const acct = cookies.find((c) => c.startsWith('sas_acct='));
    assert.match(acct, /HttpOnly; Secure; SameSite=Strict/);
    const jar = { cookie: acct.split(';')[0] };
    const pageHtml = await (await relay.go('/account', { headers: jar })).text();
    assert.ok(pageHtml.includes('desk') && pageHtml.includes(t.tenant) && pageHtml.includes('david'));
    // A form posted from elsewhere is refused.
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await relay.go('/account/remove', { method: 'POST', headers: { ...jar, ...form }, body: `tenant=${t.tenant}` })).status, 403);
    const removed = await relay.go('/account/remove', {
      method: 'POST', headers: { ...jar, ...form, origin: 'https://relay.example' }, body: `tenant=${t.tenant}` });
    assert.ok((await removed.text()).includes('Removed desk.'));
    assert.equal((await mcp(relay, t, 'ping')).status, 404);
    // Signing in is rate limited per IP.
    relay.env.RELAY_JOIN_PER_MIN = '1';
    await relay.go('/account');
    assert.equal((await relay.go('/account')).status, 429);
  },

  async deletingAnAccountRemovesItsTenants() {
    const relay = fakeRelay();
    relay.env.RELAY_MACHINES_PER_ACCOUNT = '3';
    const a1 = await makeTenant(relay, 'https://cms.sasonica.com|7', 'one');
    const a2 = await makeTenant(relay, 'https://cms.sasonica.com|7', 'two');
    const other = await makeTenant(relay, DAVID, 'desk');
    const hook = (tok, account) => relay.go('/hooks/account-deleted', {
      method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ account }) });
    assert.equal((await hook('nope', 'https://cms.sasonica.com|7')).status, 404);
    // The hook token reaches nothing else.
    assert.equal((await relay.go(`/admin/tenants/${a1.tenant}`, { headers: { authorization: `Bearer ${HOOK}` } })).status, 404);
    const r = await (await hook(HOOK, 'https://cms.sasonica.com|7')).json();
    assert.deepEqual(r.removed.sort(), [a1.tenant, a2.tenant].sort());
    assert.equal((await mcp(relay, a1, 'ping')).status, 404);
    assert.equal((await mcp(relay, a2, 'ping')).status, 404);
    assert.equal((await mcp(relay, other, 'ping')).status, 200);
    // Again: nothing left, and no error.
    assert.deepEqual((await (await hook(HOOK, 'https://cms.sasonica.com|7')).json()).removed, []);
  },

  async adminCanInspectRemoveAndIndexATenant() {
    const relay = fakeRelay();
    const t = await makeTenant(relay, DAVID, 'desk');
    const adm = (init = {}) => ({ ...init, headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal((await relay.go(`/admin/tenants/${t.tenant}`)).status, 404);
    const info = await (await relay.go(`/admin/tenants/${t.tenant}`, adm())).json();
    assert.deepEqual([info.account, info.machine], [DAVID, 'desk']);
    assert.ok(!JSON.stringify(info).includes(t.hmac_key));
    // A tenant from before the list: off it, then indexed back on.
    await relay.accounts.get(DAVID).remove(t.tenant);
    assert.equal((await relay.go(`/admin/tenants/${t.tenant}/index`, adm({ method: 'POST' }))).status, 200);
    const listed = await (await relay.go(`/admin/accounts/${encodeURIComponent(DAVID)}`, adm())).json();
    assert.deepEqual(listed.machines.map((m) => m.tenant), [t.tenant]);
    assert.equal((await relay.go(`/admin/tenants/${t.tenant}`, adm({ method: 'DELETE' }))).status, 200);
    assert.equal((await relay.go(`/admin/tenants/${t.tenant}`, adm())).status, 404);
    assert.deepEqual(await relay.accounts.get(DAVID).list(), []);
  },
});

const only = process.argv[2];
let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  if (only && name !== only) continue;
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n${e.stack}`); }
}
process.exit(failed ? 1 : 0);
