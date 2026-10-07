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
import {
  ACCOUNT_STATE, accountCallback, accountForToken, accountPage, accountSignIn, tokenOf,
  type MachineEntry, type MachineView,
} from './account.ts'

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
  /** The machine's name as it joined (cleanMachine): shown in the account's list. */
  machine?: string
}

interface Meta {
  tenant: string
  account: string
  machine?: string
  hmac_key: string
  runner_token_sha256: string
  created_at: string
  /** Epoch ms of the runner's last contact, written at most hourly. */
  last_runner_ms?: string
}

/** What a tenant says about itself: no credential, no key. */
export interface TenantInfo {
  tenant: string
  account: string
  machine: string
  created_at: string
  last_seen: string | null
}

/** Retention (docs/hosted-relay.md): how often the alarm runs, and how
 *  often the runner's last contact is written (not on every request). */
export const DAY_MS = 86_400_000
const SEEN_WRITE_MS = 3_600_000

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
      put('machine', t.machine || 'a machine')
      put('hmac_key', t.hmacKey)
      put('runner_token_sha256', t.runnerTokenSha256)
      put('created_at', new Date().toISOString())
      this.storage.sql.exec(
        `INSERT INTO clients (label, secret_sha256, created_at) VALUES ('default', ?, datetime('now'))`, t.urlSecretSha256)
    })
    return { ok: true }
  }

  /** Forget what was read: the object's storage was deleted under it. */
  forget() {
    this.meta = null
  }

  info(): TenantInfo | null {
    const m = this.load()
    if (!m) return null
    const seen = Number(m.last_runner_ms)
    return {
      tenant: m.tenant, account: m.account, machine: m.machine || 'a machine', created_at: m.created_at,
      last_seen: seen ? new Date(seen).toISOString() : null,
    }
  }

  /** The runner was here (a request or the doorbell with its token). Kept
   *  for the dormant rule, written at most hourly so it costs ~nothing. */
  noteRunner(now: number = Date.now()) {
    const m = this.load()
    if (!m || now - Number(m.last_runner_ms || 0) < SEEN_WRITE_MS) return
    m.last_runner_ms = String(now)
    this.storage.sql.exec(
      `INSERT INTO tenant_meta (key, value) VALUES ('last_runner_ms', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      m.last_runner_ms)
  }

  /**
   * The relay's own retention, whatever the client does (the runner prunes
   * too, but a client that never runs it must not mean rows kept forever):
   * command rows older than `keepDays` go, and so do sign-ins older than a
   * day. `dormant` is true when no runner has been in touch for
   * `dormantDays`: the caller then removes the tenant. A tenant from before
   * contact was recorded starts its clock now.
   */
  retain(now: number, keepDays: number, dormantDays: number): { deleted: number; dormant: boolean } {
    const m = this.load()
    if (!m) return { deleted: 0, dormant: false }
    const cutoff = new Date(now - keepDays * DAY_MS).toISOString().replace('T', ' ').slice(0, 19)
    this.storage.sql.exec(`DELETE FROM commands WHERE created_at < ?`, cutoff)
    const deleted = Number(Object.values(this.storage.sql.exec('SELECT changes() AS n').toArray()[0] ?? { n: 0 })[0])
    const dayAgo = new Date(now - DAY_MS).toISOString().replace('T', ' ').slice(0, 19)
    this.storage.sql.exec(`DELETE FROM signins WHERE created_at < ?`, dayAgo)
    if (!Number(m.last_runner_ms)) {
      this.noteRunner(now)
      return { deleted, dormant: false }
    }
    return { deleted, dormant: now - Number(m.last_runner_ms) > dormantDays * DAY_MS }
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
      if (await this.runnerOk(offered)) {
        env.SASONICA_RUNNER_TOKEN = offered
        this.noteRunner()
      }
    }
    return secretFetch(request, env)
  }
}

// --- the router ------------------------------------------------------------------

/** What the router needs of a Durable Object namespace (and the test fake). */
export interface TenantStub {
  fetch(request: Request): Promise<Response>
  init(t: TenantInit): Promise<{ ok: true } | { error: string }>
  info(): Promise<TenantInfo | null>
  /** Delete the tenant outright: its rows, its settings, its alarm. */
  destroy(): Promise<boolean>
}
export interface AccountStub {
  list(): Promise<MachineEntry[]>
  add(e: MachineEntry): Promise<void>
  remove(tenant: string): Promise<boolean>
}
export interface JoinStub {
  start(pollSha256: string, machine: string, code: string): Promise<{ ok: true } | { error: string }>
  authorizeUrl(id: string, origin: string): Promise<string | null>
  callback(code: string, origin: string, allowList: string): Promise<
    { machine: string; code: string; confirm: string; who: string; account: string } | { error: string }>
  confirm(nonce: string): Promise<{ account: string; machine: string } | { error: string }>
  deliver(creds: Creds): Promise<void>
  collect(poll: string): Promise<{ status: string } | { creds: Creds } | null>
}
/** Cloudflare's rate-limit binding (wrangler.relay.jsonc `ratelimits`). */
export interface RateLimit {
  limit(o: { key: string }): Promise<{ success: boolean }>
}
interface Namespace<T> { idFromName(name: string): unknown; get(id: any): T }
export interface RelayEnv {
  TENANTS: Namespace<TenantStub>
  JOINS: Namespace<JoinStub>
  /** One object per Sasonica account: its tenants (./account.ts). */
  ACCOUNTS: Namespace<AccountStub>
  /** Bearer token for POST /tenants and /admin/... (made by hand, no
   *  sign-in). Absent = those routes are off. */
  RELAY_ADMIN_TOKEN?: string
  /**
   * Who may join, comma-separated `<issuer>|<sub>` (as agent-media's
   * MEDIA_OIDC_ALLOW), or `*` for any Sasonica account. Absent = nobody.
   */
  RELAY_ALLOW_ACCOUNTS?: string
  /** Bearer token cms.sasonica.com presents at /hooks/account-deleted
   *  (sasonica_oidc, on deleting an account). Can only delete. */
  RELAY_ACCOUNT_HOOK_TOKEN?: string
  /** Machines one account may have joined at once (default 1, the beta). */
  RELAY_MACHINES_PER_ACCOUNT?: string
  /** Days a command row is kept on the relay, whatever the client does (default 30). */
  RELAY_KEEP_DAYS?: string
  /** Days without any runner contact before a tenant is removed (default 90). */
  RELAY_DORMANT_DAYS?: string
  /** Per client IP: /join/start and the account page's sign-in. */
  JOIN_LIMIT?: RateLimit
  /** Per tenant connector URL: MCP calls. */
  MCP_LIMIT?: RateLimit
  /** Per tenant runner token: the runner API and its doorbell. */
  RUNNER_LIMIT?: RateLimit
  /** Tests only: stands in for fetch() to cms.sasonica.com. */
  ISSUER_FETCH?: typeof fetch
}

const whole = (v: unknown, d: number) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : d
}
export function relaySettings(env: Partial<RelayEnv>) {
  return {
    machines: whole(env.RELAY_MACHINES_PER_ACCOUNT, 1),
    keepDays: whole(env.RELAY_KEEP_DAYS, 30),
    dormantDays: whole(env.RELAY_DORMANT_DAYS, 90),
  }
}

/** Whether `account` is on the allow list. */
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
const tenantStub = (env: RelayEnv, t: string) => env.TENANTS.get(env.TENANTS.idFromName(t))
const accountStub = (env: RelayEnv, a: string) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(a))
const clientIp = (r: Request) => r.headers.get('cf-connecting-ip') ?? 'unknown'
const bearer = (r: Request) => (r.headers.get('authorization') ?? '').replace(/^Bearer /, '')
const keyOf = async (t: string) => (await sha256Hex(t)).slice(0, 16)

/**
 * Over the limit? A missing binding, or one that fails, lets the request
 * through: a limiter outage must not take the relay down with it.
 */
async function overLimit(binding: RateLimit | undefined, key: string): Promise<boolean> {
  if (!binding) return false
  try { return !(await binding.limit({ key })).success } catch { return false }
}
const RATE_TEXT = 'Rate limited by the Sasonica relay: try again in a minute.'
const tooMany = (body: unknown = { error: RATE_TEXT }) =>
  Response.json(body, { status: 429, headers: { 'retry-after': '60' } })

/**
 * Everything at /t/<tenant>/... goes to that tenant's object with the prefix
 * taken off, so a machine's SASONICA_WORKER_URL is https://<relay>/t/<tenant>
 * and the runner and the connector URL need no change at all: /runner,
 * /runner/ws and /<secret>/mcp underneath it, as on a Worker of their own.
 *
 * Rate limits are taken here, before the object is woken, keyed by the
 * credential a request carries (hashed) under its tenant: so a stranger
 * guessing at a tenant's URL spends their own allowance, not its owner's.
 * Not by IP for MCP -- an assistant's calls come from its vendor's servers,
 * shared by every user of that assistant.
 */
export async function relayFetch(request: Request, env: RelayEnv): Promise<Response> {
  const url = new URL(request.url)
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length === 1 && parts[0] === 'tenants') return createTenant(request, env, url)
  if (parts[0] === 'join') return joinFetch(request, env, url, parts)
  if (parts[0] === 'account') return accountFetch(request, env, url, parts)
  if (parts[0] === 'admin') return adminFetch(request, env, parts)
  if (parts.length === 2 && parts[0] === 'hooks' && parts[1] === 'account-deleted') return accountDeleted(request, env)
  if (parts[0] !== 't' || !TENANT_RE.test(parts[1] ?? '')) return notFound()
  const rest = parts.slice(2)
  if (rest[0] === 'runner') {
    if (await overLimit(env.RUNNER_LIMIT, `${parts[1]}:${await keyOf(bearer(request) || 'ws')}`)) return tooMany()
  } else if (await overLimit(env.MCP_LIMIT, `${parts[1]}:${await keyOf(rest[0] ?? '')}`)) {
    return tooMany({ jsonrpc: '2.0', id: null, error: { code: -32000, message: RATE_TEXT } })
  }
  const inner = new URL(`/${rest.join('/')}${url.search}`, url.origin)
  return tenantStub(env, parts[1]).fetch(new Request(inner, request))
}

/**
 * POST /tenants {account, machine?}: a new tenant, and the three secrets its
 * machine needs, shown this once. Behind RELAY_ADMIN_TOKEN; people join with
 * `sasonica install --hosted` instead. Not held to the per-account limit.
 */
async function createTenant(request: Request, env: RelayEnv, url: URL): Promise<Response> {
  if (!adminOk(request, env)) return notFound()
  if (request.method !== 'POST') return new Response('POST here', { status: 405 })
  let body: any
  try { body = await request.json() } catch { body = {} }
  const account = String(body?.account ?? '').slice(0, 200)
  if (!account) return Response.json({ error: 'account is required' }, { status: 400 })
  const made = await makeTenant(env, url.origin, account, cleanMachine(body?.machine))
  if ('error' in made) return Response.json(made, { status: 409 })
  return Response.json({ account, ...made })
}

/** A new tenant for `account`, listed under it, and the secrets its machine needs. */
async function makeTenant(env: RelayEnv, origin: string, account: string, machine: string): Promise<Creds | { error: string }> {
  const tenant = tenantId()
  const hmacKey = randomHex(32)
  const runnerToken = randomHex(32)
  const urlSecret = randomHex(24)
  const made = await tenantStub(env, tenant).init({
    tenant, account, hmacKey, machine,
    runnerTokenSha256: await sha256Hex(runnerToken),
    urlSecretSha256: await sha256Hex(urlSecret),
  })
  if ('error' in made) return made
  await accountStub(env, account).add({ tenant, machine, created_at: new Date().toISOString() })
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

/** Delete a tenant and take it off its account's list. `account` lets the
 *  list be cleaned even when the tenant itself is already gone. */
export async function removeTenant(env: RelayEnv, tenant: string, account?: string): Promise<TenantInfo | null> {
  const stub = tenantStub(env, tenant)
  const info = await stub.info()
  if (info) await stub.destroy()
  const owner = info?.account ?? account
  if (owner) await accountStub(env, owner).remove(tenant)
  return info
}

/** The account's machines with when each was last seen; entries whose
 *  tenant is gone (removed by its alarm, say) are dropped from the list. */
async function machinesOf(env: RelayEnv, account: string): Promise<MachineView[]> {
  const out: MachineView[] = []
  for (const e of await accountStub(env, account).list()) {
    const info = await tenantStub(env, e.tenant).info()
    if (!info) { await accountStub(env, account).remove(e.tenant); continue }
    out.push({ ...e, last_seen: info.last_seen })
  }
  return out
}

/** One machine per account (RELAY_MACHINES_PER_ACCOUNT): after `keep` joins,
 *  the oldest others go. Returns the machines removed. */
async function keepToLimit(env: RelayEnv, account: string, keep: string): Promise<string[]> {
  const others = (await accountStub(env, account).list()).filter((e) => e.tenant !== keep)
  const excess = others.length + 1 - relaySettings(env).machines
  const gone: string[] = []
  for (const e of others.slice(0, Math.max(0, excess))) {
    await removeTenant(env, e.tenant, account)
    gone.push(e.machine)
  }
  return gone
}

// --- admin and the account-deletion hook ------------------------------------------

function adminOk(request: Request, env: RelayEnv): boolean {
  return !!env.RELAY_ADMIN_TOKEN && timingSafeEqual(bearer(request), env.RELAY_ADMIN_TOKEN)
}

/**
 *   GET    /admin/tenants/<id>        -> what it is (no credentials)
 *   DELETE /admin/tenants/<id>        -> removed
 *   POST   /admin/tenants/<id>/index  -> listed under its account (a tenant made before the list)
 *   GET    /admin/accounts/<account>  -> the account's machines (account URL-encoded)
 */
async function adminFetch(request: Request, env: RelayEnv, parts: string[]): Promise<Response> {
  if (!adminOk(request, env)) return notFound()
  if (parts[1] === 'tenants' && TENANT_RE.test(parts[2] ?? '')) {
    const t = parts[2]
    if (parts.length === 3 && request.method === 'GET') {
      const info = await tenantStub(env, t).info()
      return info ? Response.json(info) : notFound()
    }
    if (parts.length === 3 && request.method === 'DELETE') {
      const info = await removeTenant(env, t)
      return info ? Response.json({ removed: info }) : notFound()
    }
    if (parts.length === 4 && parts[3] === 'index' && request.method === 'POST') {
      const info = await tenantStub(env, t).info()
      if (!info) return notFound()
      await accountStub(env, info.account).add({ tenant: t, machine: info.machine, created_at: info.created_at })
      return Response.json({ indexed: info })
    }
  }
  if (parts.length === 3 && parts[1] === 'accounts' && request.method === 'GET') {
    const account = decodeURIComponent(parts[2])
    return Response.json({ account, machines: await machinesOf(env, account) })
  }
  return notFound()
}

/**
 * POST /hooks/account-deleted {account}: cms.sasonica.com deleted this
 * account (sasonica_oidc's hook_user_delete), so its tenants go too. Its own
 * token, which can do nothing but this.
 */
async function accountDeleted(request: Request, env: RelayEnv): Promise<Response> {
  const t = bearer(request)
  const ok = (env.RELAY_ACCOUNT_HOOK_TOKEN && timingSafeEqual(t, env.RELAY_ACCOUNT_HOOK_TOKEN)) || adminOk(request, env)
  if (!ok) return notFound()
  if (request.method !== 'POST') return new Response('POST here', { status: 405 })
  let body: any
  try { body = await request.json() } catch { body = {} }
  const account = String(body?.account ?? '')
  if (!account || account.length > 200) return Response.json({ error: 'account is required' }, { status: 400 })
  const removed: string[] = []
  for (const e of await accountStub(env, account).list()) {
    await removeTenant(env, e.tenant, account)
    removed.push(e.tenant)
  }
  return Response.json({ account, removed })
}

// --- the account's own page and API (./account.ts) ---------------------------------

/**
 *   GET    /account                   -> the page (signs in first)
 *   POST   /account/remove  tenant=   -> the page's Remove button
 *   GET    /account/machines          -> {account, machines}      (Bearer: the account's token)
 *   DELETE /account/machines/<tenant> -> {removed}                 (Bearer)
 */
async function accountFetch(request: Request, env: RelayEnv, url: URL, parts: string[]): Promise<Response> {
  const fetcher = env.ISSUER_FETCH ?? fetch
  const who = await accountForToken(tokenOf(request), fetcher)
  if (parts.length === 1 && request.method === 'GET') {
    if (!who) {
      if (await overLimit(env.JOIN_LIMIT, `acct:${clientIp(request)}`)) return tooMany()
      return accountSignIn(url.origin)
    }
    return accountPage(who.who, await machinesOf(env, who.account))
  }
  if (parts.length === 2 && parts[1] === 'remove' && request.method === 'POST') {
    // The cookie is SameSite=Strict already; the Origin check is belt and braces.
    if (request.headers.get('origin') !== url.origin) return new Response('forbidden', { status: 403 })
    if (!who) return Response.redirect(`${url.origin}/account`, 303)
    const form = await request.formData().catch(() => null)
    const tenant = String(form?.get('tenant') ?? '')
    const mine = (await accountStub(env, who.account).list()).find((e) => e.tenant === tenant)
    if (mine) await removeTenant(env, tenant, who.account)
    return accountPage(who.who, await machinesOf(env, who.account), mine ? `Removed ${mine.machine}.` : '')
  }
  if (parts[1] === 'machines') {
    if (!who) return Response.json({ error: 'sign in with a Sasonica account (Authorization: Bearer <access token>)' }, { status: 401 })
    if (parts.length === 2 && request.method === 'GET') {
      return Response.json({ account: who.account, machines: await machinesOf(env, who.account) })
    }
    if (parts.length === 3 && request.method === 'DELETE') {
      const mine = (await accountStub(env, who.account).list()).some((e) => e.tenant === parts[2])
      if (!mine) return notFound()
      await removeTenant(env, parts[2], who.account)
      return Response.json({ removed: parts[2] })
    }
  }
  return notFound()
}

// --- joining (./join.ts) ------------------------------------------------------------

const JOIN_ID = /^[0-9a-f]{32}$/
const expired = () => page('This join has expired', '<p>Run the installer again on your machine.</p>', 404)
const escText = (t: string) => t.replace(/[&<>]/g, '')

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
    if (await overLimit(env.JOIN_LIMIT, `join:${clientIp(request)}`)) return tooMany()
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
    // The account page signs in through here too (one redirect URI).
    if (ACCOUNT_STATE.test(id)) {
      if (url.searchParams.get('error')) return page('Sign-in cancelled', '<p>Nothing was changed.</p>')
      return accountCallback(request, url, env.ISSUER_FETCH ?? fetch)
    }
    if (!JOIN_ID.test(id)) return expired()
    if (url.searchParams.get('error')) return page('Sign-in cancelled', '<p>Nothing was added. Run the installer again to retry.</p>')
    const got = await stubFor(id).callback(url.searchParams.get('code') ?? '', url.origin, env.RELAY_ALLOW_ACCOUNTS ?? '')
    if ('error' in got) return page('Not joined', `<p>${escText(got.error)}</p>`, 403)
    const have = await accountStub(env, got.account).list()
    const replacing = have.slice(0, Math.max(0, have.length + 1 - relaySettings(env).machines)).map((e) => e.machine)
    return confirmPage(id, got, replacing)
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
    const creds = await makeTenant(env, url.origin, ok.account, ok.machine)
    if ('error' in creds) return page('Not joined', '<p>Something went wrong. Run the installer again.</p>', 500)
    // Made first, then the old one goes: a failure above leaves the old machine working.
    const gone = await keepToLimit(env, ok.account, creds.tenant)
    await stub.deliver(creds)
    const swapped = gone.length ? `<p>Removed from your relay: <b>${escText(gone.join(', '))}</b>.</p>` : ''
    return page('Joined', `<p><b>${escText(ok.machine)}</b> is joining your relay. Go back to its terminal: the installer finishes from here.</p>${swapped}
<p>Your machines: <a href="/account">${escText(url.host)}/account</a>.</p>`)
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
