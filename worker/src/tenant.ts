/**
 * The hosted relay (docs/hosted-relay.md): one Worker, a Durable Object per
 * tenant. Everything here is plain TypeScript with no `cloudflare:` import,
 * so tests drive it over node:sqlite; ./hosted.ts is the thin Cloudflare
 * wrapper around it.
 *
 * A tenant is one person's relay -- what a self-hosted install is, minus
 * their Cloudflare account. Its queue, tools and clients live in its own
 * object's SQLite, under the same schema.sql, and it is served by the same
 * runnerApi and mcpServe as a self-hosted Worker: the object hands them a
 * D1-shaped binding over its own storage. So a routing bug can at worst
 * reach the wrong object's front door, which still wants that object's
 * credentials, and a query cannot reach another tenant's rows at all.
 *
 * What the relay holds, honestly: the tenant's HMAC key, because the relay
 * signs the rows (as a self-hosted Worker holds SASONICA_HMAC_KEY). The
 * runner token and the connector secret are kept only as sha256.
 */

import { randomHex, secretFetch, sha256Hex, timingSafeEqual, type Env } from './index.ts'
import { cleanMachine, confirmPage, joinCode, page, type Creds } from './join.ts'

// --- a D1 binding over a Durable Object's SQLite ------------------------------

/** The slice of SqlStorage this needs (and that a node:sqlite fake can give). */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): any[] }
}

/**
 * Just what index.ts calls: prepare/bind/first/all/run and batch. `changes`
 * is SQLite's changes(), not the cursor's rowsWritten, which also counts
 * index writes -- cancel tests `changes === 1` and must see rows.
 */
export function d1Over(sql: SqlLike, transaction: <T>(fn: () => T) => T): D1Database {
  const scalar = (q: string) => Number(Object.values(sql.exec(q).toArray()[0] ?? { n: 0 })[0])
  const prepare = (query: string) => {
    let params: unknown[] = []
    const runSync = () => {
      sql.exec(query, ...params).toArray()
      return { results: [], success: true, meta: { changes: scalar('SELECT changes()'), last_row_id: scalar('SELECT last_insert_rowid()') } }
    }
    const stmt: any = {
      bind(...args: unknown[]) { params = args; return stmt },
      async first() { return sql.exec(query, ...params).toArray()[0] ?? null },
      async all() {
        const results = sql.exec(query, ...params).toArray()
        return { results, success: true, meta: { changes: scalar('SELECT changes()') } }
      },
      async run() { return runSync() },
      runSync,
    }
    return stmt
  }
  return {
    prepare,
    async batch(stmts: any[]) { return transaction(() => stmts.map((s) => s.runSync())) },
  } as unknown as D1Database
}

// --- one tenant ----------------------------------------------------------------

/** What a Durable Object's ctx.storage gives this (and the test fake). */
export interface StorageLike {
  sql: SqlLike
  transactionSync<T>(fn: () => T): T
}

export interface TenantInit {
  tenant: string
  account: string
  hmacKey: string
  runnerTokenSha256: string
  urlSecretSha256: string
}

interface Meta {
  tenant: string
  account: string
  hmac_key: string
  runner_token_sha256: string
  created_at: string
}

export class TenantCore {
  readonly db: D1Database
  private meta: Meta | null = null
  private storage: StorageLike
  private schema: string
  /** Rings the runner's doorbell: every authenticated socket hears 'ring'. */
  private ring: () => void

  // Plain fields, not parameter properties: tests load this file with
  // Node's type stripping, which does not do those.
  constructor(storage: StorageLike, schema: string, ring: () => void = () => {}) {
    this.storage = storage
    this.schema = schema
    this.ring = ring
    this.db = d1Over(storage.sql, (fn) => storage.transactionSync(fn))
  }

  /** The tenant's settings, or null for an object no tenant was made in.
   *  Read-only: a probe at a made-up tenant id must not create storage. */
  load(): Meta | null {
    if (this.meta) return this.meta
    const has = this.storage.sql.exec(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'tenant_meta'`).toArray()
    if (!has.length) return null
    const rows = this.storage.sql.exec(`SELECT key, value FROM tenant_meta`).toArray()
    if (!rows.length) return null
    const m: any = {}
    for (const r of rows) m[r.key] = r.value
    this.meta = m as Meta
    return this.meta
  }

  /** Make the tenant: schema, settings, and the connector URL as the
   *  'default' client (by hash, as `sasonica client` stores one). Once. */
  init(t: TenantInit): { ok: true } | { error: string } {
    if (this.load()) return { error: 'tenant exists' }
    if (!/^[0-9a-f]{64}$/.test(t.hmacKey) || !/^[0-9a-f]{64}$/.test(t.runnerTokenSha256) || !/^[0-9a-f]{64}$/.test(t.urlSecretSha256)) {
      return { error: 'bad init' }
    }
    this.storage.transactionSync(() => {
      this.storage.sql.exec(this.schema)
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tenant_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
      const put = (k: string, v: string) => this.storage.sql.exec(`INSERT INTO tenant_meta (key, value) VALUES (?, ?)`, k, v)
      put('tenant', t.tenant)
      put('account', t.account)
      put('hmac_key', t.hmacKey)
      put('runner_token_sha256', t.runnerTokenSha256)
      put('created_at', new Date().toISOString())
      this.storage.sql.exec(
        `INSERT INTO clients (label, secret_sha256, created_at) VALUES ('default', ?, datetime('now'))`, t.urlSecretSha256)
    })
    return { ok: true }
  }

  /** Whether `offered` is this tenant's runner token. */
  async runnerOk(offered: string): Promise<boolean> {
    const m = this.load()
    if (!m || !offered) return false
    return timingSafeEqual(await sha256Hex(offered), m.runner_token_sha256)
  }

  /** The runner API and MCP, as a self-hosted Worker serves them. The path
   *  is the tenant-relative one (/runner, /<secret>/mcp). */
  async fetch(request: Request): Promise<Response> {
    const m = this.load()
    if (!m) return new Response('not found', { status: 404 })
    const env: Env = {
      DB: this.db,
      SASONICA_HMAC_KEY: m.hmac_key,
      // Only the clients table decides MCP access here: the connector URL is
      // its 'default' row.
      SASONICA_URL_SECRET: '',
      SASONICA_TENANT: m.tenant,
      onQueued: this.ring,
    }
    const url = new URL(request.url)
    if (url.pathname === '/runner') {
      // runnerApi compares against SASONICA_RUNNER_TOKEN; here the token is
      // checked by hash first and, if it is right, handed over as itself.
      const offered = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '')
      if (await this.runnerOk(offered)) env.SASONICA_RUNNER_TOKEN = offered
    }
    return secretFetch(request, env)
  }
}

// --- the router ------------------------------------------------------------------

/** What the router needs of a Durable Object namespace (and the test fake). */
export interface TenantStub {
  fetch(request: Request): Promise<Response>
  init(t: TenantInit): Promise<{ ok: true } | { error: string }>
}
export interface JoinStub {
  start(pollSha256: string, machine: string, code: string): Promise<{ ok: true } | { error: string }>
  authorizeUrl(id: string, origin: string): Promise<string | null>
  callback(code: string, origin: string, allowList: string): Promise<
    { machine: string; code: string; confirm: string; who: string } | { error: string }>
  confirm(nonce: string): Promise<{ account: string; machine: string } | { error: string }>
  deliver(creds: Creds): Promise<void>
  collect(poll: string): Promise<{ status: string } | { creds: Creds } | null>
}
export interface RelayEnv {
  TENANTS: { idFromName(name: string): unknown; get(id: any): TenantStub }
  JOINS: { idFromName(name: string): unknown; get(id: any): JoinStub }
  /** Bearer token for POST /tenants (made by hand, no sign-in). Absent =
   *  only joining makes tenants. */
  RELAY_ADMIN_TOKEN?: string
  /**
   * Who may join, comma-separated `<issuer>|<sub>` (as agent-media's
   * MEDIA_OIDC_ALLOW), or `*` for any Sasonica account. Absent = nobody.
   */
  RELAY_ALLOW_ACCOUNTS?: string
}

/** Whether an account (`<issuer>|<sub>`) is on the allow list. */
export function accountAllowed(list: string | undefined, account: string): boolean {
  const items = String(list ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return items.includes('*') || items.includes(account)
}

/** 16 characters of base32 (80 bits): the tenant's part of its URLs. */
export const TENANT_RE = /^[a-z2-7]{16}$/
function tenantId(): string {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return [...a].map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b & 31]).join('')
}

const notFound = () => new Response('not found', { status: 404 })

/**
 * Everything at /t/<tenant>/... goes to that tenant's object with the prefix
 * taken off, so a machine's SASONICA_WORKER_URL is https://<relay>/t/<tenant>
 * and the runner and the connector URL need no change at all: /runner,
 * /runner/ws and /<secret>/mcp underneath it, as on a Worker of their own.
 */
export async function relayFetch(request: Request, env: RelayEnv): Promise<Response> {
  const url = new URL(request.url)
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length === 1 && parts[0] === 'tenants') return createTenant(request, env, url)
  if (parts[0] === 'join') return joinFetch(request, env, url, parts)
  if (parts[0] !== 't' || !TENANT_RE.test(parts[1] ?? '')) return notFound()
  const inner = new URL(`/${parts.slice(2).join('/')}${url.search}`, url.origin)
  const stub = env.TENANTS.get(env.TENANTS.idFromName(parts[1]))
  return stub.fetch(new Request(inner, request))
}

/**
 * POST /tenants {account}: a new tenant, and the three secrets its machine
 * needs, shown this once. Behind RELAY_ADMIN_TOKEN for now; `sasonica install
 * --hosted` will get here by a Sasonica account sign-in instead.
 */
async function createTenant(request: Request, env: RelayEnv, url: URL): Promise<Response> {
  const offered = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (!env.RELAY_ADMIN_TOKEN || !timingSafeEqual(offered, env.RELAY_ADMIN_TOKEN)) return notFound()
  if (request.method !== 'POST') return new Response('POST here', { status: 405 })
  let body: any
  try { body = await request.json() } catch { body = {} }
  const account = String(body?.account ?? '').slice(0, 200)
  if (!account) return Response.json({ error: 'account is required' }, { status: 400 })
  const made = await makeTenant(env, url.origin, account)
  if ('error' in made) return Response.json(made, { status: 409 })
  return Response.json({ account, ...made })
}

/** A new tenant for `account`, and the secrets its machine needs. */
async function makeTenant(env: RelayEnv, origin: string, account: string): Promise<Creds | { error: string }> {
  const tenant = tenantId()
  const hmacKey = randomHex(32)
  const runnerToken = randomHex(32)
  const urlSecret = randomHex(24)
  const stub = env.TENANTS.get(env.TENANTS.idFromName(tenant))
  const made = await stub.init({
    tenant, account, hmacKey,
    runnerTokenSha256: await sha256Hex(runnerToken),
    urlSecretSha256: await sha256Hex(urlSecret),
  })
  if ('error' in made) return made
  const workerUrl = `${origin}/t/${tenant}`
  return {
    tenant,
    // What the machine's env file takes, as the self-hosted installer
    // writes it, plus the key for relay.key.
    SASONICA_WORKER_URL: workerUrl,
    SASONICA_RUNNER_TOKEN: runnerToken,
    SASONICA_URL_SECRET: urlSecret,
    hmac_key: hmacKey,
    connector_url: `${workerUrl}/${urlSecret}/mcp`,
  }
}

// --- joining (./join.ts) ------------------------------------------------------------

const JOIN_ID = /^[0-9a-f]{32}$/
const expired = () => page('This join has expired', '<p>Run the installer again on your machine.</p>', 404)

/**
 *   POST /join/start {machine}       -> {id, code, poll, url}   (the installer)
 *   GET  /join/<id>                  -> 302 to sign in at cms.sasonica.com
 *   GET  /join/callback?code&state   -> the confirm page
 *   POST /join/<id>/confirm          -> the tenant is made; "back to your terminal"
 *   POST /join/<id>/poll {poll}      -> 202 {status} until joined, then the credentials, once
 */
async function joinFetch(request: Request, env: RelayEnv, url: URL, parts: string[]): Promise<Response> {
  const stubFor = (id: string) => env.JOINS.get(env.JOINS.idFromName(id))
  if (parts.length === 2 && parts[1] === 'start' && request.method === 'POST') {
    let body: any
    try { body = await request.json() } catch { body = {} }
    const id = randomHex(16)
    const poll = randomHex(32)
    const code = joinCode()
    const made = await stubFor(id).start(await sha256Hex(poll), cleanMachine(body?.machine), code)
    if ('error' in made) return Response.json(made, { status: 409 })
    return Response.json({ id, code, poll, url: `${url.origin}/join/${id}` })
  }
  if (parts.length === 2 && parts[1] === 'callback' && request.method === 'GET') {
    const id = url.searchParams.get('state') ?? ''
    if (!JOIN_ID.test(id)) return expired()
    if (url.searchParams.get('error')) return page('Sign-in cancelled', '<p>Nothing was added. Run the installer again to retry.</p>')
    const got = await stubFor(id).callback(url.searchParams.get('code') ?? '', url.origin, env.RELAY_ALLOW_ACCOUNTS ?? '')
    if ('error' in got) return page('Not joined', `<p>${got.error.replace(/[&<>]/g, '')}</p>`, 403)
    return confirmPage(id, got)
  }
  const id = parts[1] ?? ''
  if (!JOIN_ID.test(id)) return new Response('not found', { status: 404 })
  if (parts.length === 2 && request.method === 'GET') {
    const to = await stubFor(id).authorizeUrl(id, url.origin)
    return to ? Response.redirect(to, 302) : expired()
  }
  if (parts.length === 3 && parts[2] === 'confirm' && request.method === 'POST') {
    const form = await request.formData().catch(() => null)
    const stub = stubFor(id)
    const ok = await stub.confirm(String(form?.get('confirm') ?? ''))
    if ('error' in ok) return expired()
    const creds = await makeTenant(env, url.origin, ok.account)
    if ('error' in creds) return page('Not joined', '<p>Something went wrong. Run the installer again.</p>', 500)
    await stub.deliver(creds)
    return page('Joined', `<p><b>${ok.machine.replace(/[&<>]/g, '')}</b> is joining your relay. Go back to its terminal: the installer finishes from here.</p>`)
  }
  if (parts.length === 3 && parts[2] === 'poll' && request.method === 'POST') {
    let body: any
    try { body = await request.json() } catch { body = {} }
    const got = await stubFor(id).collect(String(body?.poll ?? ''))
    if (!got) return new Response('not found', { status: 404 })
    if ('creds' in got) return Response.json(got.creds)
    return Response.json(got, { status: 202 })
  }
  return new Response('not found', { status: 404 })
}
