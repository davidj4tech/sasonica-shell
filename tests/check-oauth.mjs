#!/usr/bin/env node
// check-oauth.mjs -- OAuth on the MCP endpoint (docs/tools-and-approvals.md
// §6), end to end in Node: an assistant registers, the owner allows it on
// the consent page, a stand-in for Cloudflare Access signs a real RS256 ID
// token, and the access token that comes back runs a command whose row is
// labelled with that assistant. Then the ways it must refuse.
//
//     node --experimental-strip-types --experimental-sqlite --no-warnings tests/check-oauth.mjs
//
// The library imports `cloudflare:workers`, which only the Workers runtime
// has; a loader hook gives Node an empty stand-in for it.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createHash, generateKeyPairSync, createSign, randomBytes } from 'node:crypto';
import { fakeD1 } from './fake-d1.mjs';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env } }', shortCircuit: true };
  return next(spec, ctx);
}`));

const mod = await import('../worker/src/index.ts');
const worker = mod.default;
const ORIGIN = 'https://sasonica-shell-red5.example.workers.dev';
const URL_SECRET = 'five-word-url-secret-here';
const OWNER = 'Owner@Example.com';
const TEAM = 'team.cloudflareaccess.com';
const ACCESS_ID = 'access-client-id';
const ISSUER = `https://${TEAM}/cdn-cgi/access/sso/oidc/${ACCESS_ID}`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

// --- a KV namespace in memory ------------------------------------------------
function fakeKV() {
  const m = new Map();
  const live = (k) => { const e = m.get(k); if (e && e.exp && e.exp < Date.now()) { m.delete(k); return null; } return e ?? null; };
  const decode = (v, type) => (type === 'json' || type?.type === 'json') ? JSON.parse(v) : (type === 'arrayBuffer' || type?.type === 'arrayBuffer') ? new TextEncoder().encode(v).buffer : v;
  return {
    async get(k, type) { const e = live(k); return e ? decode(e.v, type) : null; },
    async getWithMetadata(k, type) { const e = live(k); return { value: e ? decode(e.v, type) : null, metadata: e?.meta ?? null }; },
    async put(k, v, opts = {}) {
      const exp = opts.expiration ? opts.expiration * 1000 : opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0;
      m.set(k, { v: typeof v === 'string' ? v : new TextDecoder().decode(v), exp, meta: opts.metadata ?? null });
    },
    async delete(k) { m.delete(k); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix) && live(k)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const done = start + limit >= keys.length;
      return { keys: page.map((name) => ({ name, metadata: m.get(name).meta, expiration: m.get(name).exp ? Math.floor(m.get(name).exp / 1000) : undefined })), list_complete: done, cursor: done ? undefined : String(start + limit) };
    },
  };
}

// --- a stand-in for Access: its JWKS, and a token endpoint -------------------
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (b) => Buffer.from(b).toString('base64url');
function idToken(claims, { key = privateKey } = {}) {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const p = b64u(JSON.stringify({ iss: ISSUER, aud: [ACCESS_ID], exp: now + 300, iat: now, email: OWNER.toLowerCase(), ...claims }));
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key);
  return `${h}.${p}.${b64u(s)}`;
}
const access = { claims: {}, key: privateKey, status: 200, seen: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === `${ISSUER}/jwks`) return Response.json({ keys: [jwk] });
  if (url === `${ISSUER}/token`) {
    const body = new URLSearchParams(String(init.body));
    access.seen.push(Object.fromEntries(body));
    if (access.status !== 200) return Response.json({ error: 'invalid_grant' }, { status: access.status });
    return Response.json({ id_token: idToken(access.claims, { key: access.key }), access_token: 'upstream', token_type: 'Bearer' });
  }
  return realFetch(input, init);
};

const envFor = (db, extra = {}) => ({
  DB: db, SASONICA_HMAC_KEY: 'ab'.repeat(32), SASONICA_URL_SECRET: URL_SECRET,
  OAUTH_KV: fakeKV(), ACCESS_CLIENT_ID: ACCESS_ID, ACCESS_CLIENT_SECRET: 'access-secret',
  ACCESS_TEAM_DOMAIN: TEAM, SASONICA_OWNER_EMAIL: OWNER, ...extra,
});
const ctx = { waitUntil() {}, passThroughOnException() {} };

// A browser, just enough of one: cookies by name, kept across requests.
function browser() {
  const jar = new Map();
  return {
    async go(path, init = {}) {
      const headers = new Headers(init.headers);
      if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      const res = await worker.fetch(new Request(path.startsWith('http') ? path : ORIGIN + path, { ...init, headers, redirect: 'manual' }), init.env, ctx);
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        const k = pair.slice(0, i), v = pair.slice(i + 1);
        if (/max-age=0/i.test(c) || v === '') jar.delete(k); else jar.set(k, v);
      }
      return res;
    },
  };
}

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

async function register_(env, name = 'Claude') {
  const r = await worker.fetch(new Request(ORIGIN + '/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: name, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  }), env, ctx);
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()).client_id;
}

const authorizeUrl = (clientId) => `/authorize?${new URLSearchParams({
  response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'client-state',
  code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp`, scope: 'shell',
})}`;

/** The browser half: consent, Allow, Access, back. Returns the final redirect. */
async function signIn(env, clientId, { decision = 'approve' } = {}) {
  const b = browser();
  const page = await b.go(authorizeUrl(clientId), { env });
  assert.equal(page.status, 200);
  const html = await page.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)[1];
  const posted = await b.go('/authorize', { env, method: 'POST', body: new URLSearchParams({ handle, decision }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(posted.status, 302);
  const to = new URL(posted.headers.get('location'));
  if (decision !== 'approve') return { to, html };
  assert.equal(to.origin + to.pathname, `${ISSUER}/authorization`);
  const back = await b.go(`/callback?code=upstream-code&state=${encodeURIComponent(to.searchParams.get('state'))}`, { env });
  assert.equal(back.status, 302, await back.clone().text());
  return { to: new URL(back.headers.get('location')), html, upstream: to };
}

async function token(env, clientId, code) {
  const r = await worker.fetch(new Request(ORIGIN + '/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
  }), env, ctx);
  return { status: r.status, body: await r.json() };
}

const rpc = (env, bearer, method, params = {}, path = '/mcp') => worker.fetch(new Request(ORIGIN + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
}), env, ctx);

const reset = () => { access.claims = {}; access.key = privateKey; access.status = 200; access.seen = []; };

const cases = {
  async offWithoutSettings() {
    // No KV or Access settings: /mcp is a 404 as it always was, and the
    // secret URL works — the Worker is untouched.
    const f = fakeD1([]);
    const env = envFor(f.binding, { OAUTH_KV: undefined });
    assert.equal((await rpc(env, null, 'ping')).status, 404);
    assert.equal((await rpc(env, null, 'ping', {}, `/${URL_SECRET}/mcp`)).status, 200);
  },

  async discovery() {
    const env = envFor(fakeD1([]).binding);
    const r = await rpc(env, null, 'ping');
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata="https:\/\/sasonica-shell-red5\.example\.workers\.dev\/\.well-known\/oauth-protected-resource\/mcp"/);
    const meta = await (await worker.fetch(new Request(ORIGIN + '/.well-known/oauth-protected-resource/mcp'), env, ctx)).json();
    assert.equal(meta.resource, `${ORIGIN}/mcp`);
    assert.deepEqual(meta.authorization_servers, [ORIGIN]);
    const as = await (await worker.fetch(new Request(ORIGIN + '/.well-known/oauth-authorization-server'), env, ctx)).json();
    assert.equal(as.authorization_endpoint, `${ORIGIN}/authorize`);
    assert.equal(as.registration_endpoint, `${ORIGIN}/oauth/register`);
  },

  async ownerSignsInAndRuns() {
    reset();
    const f = fakeD1([]);
    const env = envFor(f.binding);
    const clientId = await register_(env);
    const { to, html, upstream } = await signIn(env, clientId);
    assert.match(html, /Allow Claude to run commands on red5\?/);
    assert.match(html, /claude\.ai/, 'the page names where access goes');
    assert.equal(upstream.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(upstream.searchParams.get('redirect_uri'), `${ORIGIN}/callback`);
    assert.equal(access.seen[0].code_verifier.length > 40, true, 'PKCE verifier sent to Access');
    assert.equal(to.origin + to.pathname, REDIRECT);
    assert.equal(to.searchParams.get('state'), 'client-state');
    const t = await token(env, clientId, to.searchParams.get('code'));
    assert.equal(t.status, 200, JSON.stringify(t.body));
    const r = await rpc(env, t.body.access_token, 'tools/call', { name: 'run_command', arguments: { command: 'echo hi', wait: 0 } });
    assert.equal(r.status, 200);
    assert.match((await r.json()).result.content[0].text, /^#1 pending/);
    assert.equal(f.row(1).client, 'oauth-claude', 'the row names the assistant that registered');
    // The secret URL still works beside it.
    assert.equal((await rpc(env, null, 'ping', {}, `/${URL_SECRET}/mcp`)).status, 200);
    // A made-up token does not.
    assert.equal((await rpc(env, 'nope:nope:nope', 'ping')).status, 401);
  },

  async notTheOwner() {
    reset();
    access.claims = { email: 'someone@else.com' };
    const env = envFor(fakeD1([]).binding);
    const clientId = await register_(env);
    const { to } = await signIn(env, clientId);
    assert.equal(to.searchParams.get('error'), 'access_denied');
    assert.equal(to.searchParams.get('code'), null);
  },

  async unverifiedEmail() {
    reset();
    access.claims = { email_verified: false };
    const env = envFor(fakeD1([]).binding);
    const { to } = await signIn(env, await register_(env));
    assert.equal(to.searchParams.get('error'), 'access_denied');
  },

  async forgedToken() {
    reset();
    access.key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const env = envFor(fakeD1([]).binding);
    const { to } = await signIn(env, await register_(env));
    assert.equal(to.searchParams.get('error'), 'access_denied', 'a token not signed by Access is refused');
  },

  async wrongAudience() {
    reset();
    access.claims = { aud: ['another-app'] };
    const env = envFor(fakeD1([]).binding);
    const { to } = await signIn(env, await register_(env));
    assert.equal(to.searchParams.get('error'), 'access_denied');
  },

  async accessRefuses() {
    reset();
    access.status = 400;
    const env = envFor(fakeD1([]).binding);
    const { to } = await signIn(env, await register_(env));
    assert.equal(to.searchParams.get('error'), 'access_denied');
  },

  async denyOnTheConsentPage() {
    reset();
    const env = envFor(fakeD1([]).binding);
    const { to } = await signIn(env, await register_(env), { decision: 'deny' });
    assert.equal(to.origin + to.pathname, REDIRECT);
    assert.equal(to.searchParams.get('error'), 'access_denied');
    assert.equal(access.seen.length, 0, 'Access was never asked');
  },

  async callbackNeedsTheBrowserThatAllowed() {
    reset();
    const env = envFor(fakeD1([]).binding);
    const clientId = await register_(env);
    const b = browser();
    const html = await (await b.go(authorizeUrl(clientId), { env })).text();
    const handle = html.match(/name="handle" value="([^"]+)"/)[1];
    const posted = await b.go('/authorize', { env, method: 'POST', body: new URLSearchParams({ handle, decision: 'approve' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const state = new URL(posted.headers.get('location')).searchParams.get('state');
    // Another browser (no cookie) replays the callback.
    const other = browser();
    const r = await other.go(`/callback?code=upstream-code&state=${encodeURIComponent(state)}`, { env });
    assert.equal(r.status, 400);
    assert.equal(access.seen.length, 0, 'no code was exchanged');
  },

  async consentFormFromElsewhere() {
    reset();
    const env = envFor(fakeD1([]).binding);
    const clientId = await register_(env);
    const html = await (await browser().go(authorizeUrl(clientId), { env })).text();
    const handle = html.match(/name="handle" value="([^"]+)"/)[1];
    // Posted by another site: the handle, but not the cookie.
    const r = await browser().go('/authorize', { env, method: 'POST', body: new URLSearchParams({ handle, decision: 'approve' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 400);
  },

  async clientNameIsEscaped() {
    reset();
    const env = envFor(fakeD1([]).binding);
    const clientId = await register_(env, '<script>alert(1)</script>');
    const html = await (await browser().go(authorizeUrl(clientId), { env })).text();
    assert.ok(!html.includes('<script>alert'), 'no markup from the client name');
    assert.match(html, /&#60;script&#62;/);
  },

  async grantsListedAndRevokedByLabel() {
    reset();
    const f = fakeD1([]);
    const env = envFor(f.binding, { SASONICA_RUNNER_TOKEN: 'runner-token' });
    const runner = async (body) => (await worker.fetch(new Request(ORIGIN + '/runner', {
      method: 'POST', headers: { authorization: 'Bearer runner-token', 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), env, ctx)).json();
    const tokens = {};
    for (const name of ['Claude', 'ChatGPT']) {
      const id = await register_(env, name);
      const { to } = await signIn(env, id);
      tokens[name] = (await token(env, id, to.searchParams.get('code'))).body.access_token;
    }
    const { grants } = await runner({ op: 'grants' });
    assert.deepEqual(grants.map((g) => g.label).sort(), ['oauth-chatgpt', 'oauth-claude']);
    assert.equal((await runner({ op: 'grant-revoke', label: 'oauth-claude' })).revoked, 1);
    assert.equal((await rpc(env, tokens.Claude, 'ping')).status, 401, 'the revoked assistant is out');
    assert.equal((await rpc(env, tokens.ChatGPT, 'ping')).status, 200, 'the other still works');
    // Off: the ops say so rather than failing.
    const off = envFor(f.binding, { OAUTH_KV: undefined, SASONICA_RUNNER_TOKEN: 'runner-token' });
    const r = await (await worker.fetch(new Request(ORIGIN + '/runner', {
      method: 'POST', headers: { authorization: 'Bearer runner-token' }, body: JSON.stringify({ op: 'grants' }),
    }), off, ctx)).json();
    assert.equal(r.grants, null);
  },

  async grantLabels() {
    const { grantLabel } = await import('../worker/src/oauth.ts');
    assert.equal(grantLabel('ChatGPT', 'abcdef123'), 'oauth-chatgpt');
    assert.equal(grantLabel('Claude Desktop', 'x'), 'oauth-claude-desktop');
    assert.equal(grantLabel('', 'abcdef123456'), 'oauth-abcdef12');
    assert.equal(grantLabel('!!!', 'abcdef123456'), 'oauth-abcdef12');
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n${e.stack}`);
  }
}
console.log(`check-oauth: ${Object.keys(cases).length} cases, ${failed ? `${failed} failed` : 'all pass'}`);
process.exit(failed ? 1 : 0);
