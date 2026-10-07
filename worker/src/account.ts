/**
 * A Sasonica account's machines on the hosted relay (docs/hosted-relay.md):
 * which tenants belong to one account, so the account can list and remove
 * them, the beta's one-machine-per-account rule can be kept at join, and an
 * account deleted at cms.sasonica.com takes its tenants with it.
 *
 * One Durable Object per account (`Account`, by the account string
 * `<issuer>|<sub>`), holding only tenant ids, machine names and dates --
 * never a credential. Plain TypeScript like ./tenant.ts.
 *
 * Who is asking is decided by cms.sasonica.com, not here: a request carries
 * the account's access token (Authorization: Bearer, or the page's
 * short-lived cookie) and the relay asks userinfo whose it is.
 */

import { randomHex } from './index.ts'
import { b64url, CLIENT_ID, ISSUER, page } from './join.ts'
import type { StorageLike } from './tenant.ts'

export interface MachineEntry {
  tenant: string
  machine: string
  created_at: string
}

export class AccountCore {
  private storage: StorageLike

  constructor(storage: StorageLike) {
    this.storage = storage
  }

  /** Oldest first. Read-only: an account with nothing creates no storage. */
  list(): MachineEntry[] {
    const has = this.storage.sql.exec(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'account_tenants'`).toArray()
    if (!has.length) return []
    return this.storage.sql.exec(`SELECT tenant, machine, created_at FROM account_tenants ORDER BY created_at, tenant`).toArray() as MachineEntry[]
  }

  add(e: MachineEntry) {
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS account_tenants (tenant TEXT PRIMARY KEY, machine TEXT NOT NULL, created_at TEXT NOT NULL)`)
    this.storage.sql.exec(
      `INSERT INTO account_tenants (tenant, machine, created_at) VALUES (?, ?, ?)
       ON CONFLICT (tenant) DO UPDATE SET machine = excluded.machine`, e.tenant, e.machine, e.created_at)
  }

  /** Whether it was there. */
  remove(tenant: string): boolean {
    if (!this.list().some((e) => e.tenant === tenant)) return false
    this.storage.sql.exec(`DELETE FROM account_tenants WHERE tenant = ?`, tenant)
    return true
  }
}

// --- who is asking ------------------------------------------------------------------

/** The account behind an access token, or null. Any Sasonica client's token
 *  will do (the app's too): it is the account that is being proved. */
export async function accountForToken(token: string, fetcher: typeof fetch = fetch): Promise<{ account: string; who: string } | null> {
  if (!token || token.length > 4096) return null
  const r = await fetcher(`${ISSUER}/oauth/userinfo`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null)
  if (!r || !r.ok) return null
  const info: any = await r.json().catch(() => null)
  const sub = String(info?.sub ?? '')
  if (!sub) return null
  return { account: `${ISSUER}|${sub}`, who: String(info?.preferred_username || info?.name || info?.email || `account ${sub}`).slice(0, 80) }
}

export function cookie(request: Request, name: string): string {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return ''
}

/** The access token a request carries: Authorization, else the page's cookie. */
export function tokenOf(request: Request): string {
  const auth = request.headers.get('authorization') ?? ''
  if (/^Bearer /i.test(auth)) return auth.replace(/^Bearer /i, '').trim()
  return cookie(request, ACCOUNT_COOKIE)
}

export const ACCOUNT_COOKIE = 'sas_acct'
export const PKCE_COOKIE = 'sas_pkce'
/** The account page's sign-in reuses the join's redirect URI; its state says which. */
export const ACCOUNT_STATE = /^acct\.[0-9a-f]{32}$/

/** Start the account page's sign-in: PKCE, the verifier in a short cookie. */
export async function accountSignIn(origin: string): Promise<Response> {
  const state = randomHex(16)
  const verifier = randomHex(32)
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const q = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: `${origin}/join/callback`,
    scope: 'openid profile email', state: `acct.${state}`, code_challenge: challenge, code_challenge_method: 'S256',
  })
  return new Response(null, {
    status: 302,
    headers: {
      location: `${ISSUER}/oauth/authorize?${q}`,
      'set-cookie': `${PKCE_COOKIE}=${state}.${verifier}; Path=/join/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
      'cache-control': 'no-store',
    },
  })
}

/** Back from signing in: the code for a token, kept for the page in a
 *  cookie that lives as long as the token (5 minutes). */
export async function accountCallback(request: Request, url: URL, fetcher: typeof fetch = fetch): Promise<Response> {
  const state = (url.searchParams.get('state') ?? '').slice(5)
  const [want, verifier] = cookie(request, PKCE_COOKIE).split('.')
  if (!want || want !== state || !verifier) return page('Sign-in expired', '<p><a href="/account">Try again</a>.</p>', 400)
  const tok = await fetcher(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: `${url.origin}/join/callback`,
      client_id: CLIENT_ID, code_verifier: verifier,
    }),
  }).catch(() => null)
  const tj: any = await tok?.json().catch(() => null)
  const at = String(tj?.access_token ?? '')
  if (!tok?.ok || !/^[\w.~+/=-]+$/.test(at)) return page('Not signed in', '<p>The sign-in could not be completed. <a href="/account">Try again</a>.</p>', 403)
  const age = Math.min(Math.max(Number(tj?.expires_in) || 300, 60), 3600)
  const headers = new Headers({ location: '/account', 'cache-control': 'no-store' })
  headers.append('set-cookie', `${ACCOUNT_COOKIE}=${at}; Path=/account; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`)
  headers.append('set-cookie', `${PKCE_COOKIE}=; Path=/join/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
  return new Response(null, { status: 303, headers })
}

const esc = (t: string) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export interface MachineView extends MachineEntry {
  last_seen: string | null
}

export function accountPage(who: string, machines: MachineView[], note = ''): Response {
  const rows = machines.map((m) => `<li><b>${esc(m.machine)}</b><br><small>joined ${esc(m.created_at.slice(0, 10))}${
    m.last_seen ? `, last seen ${esc(m.last_seen.slice(0, 16).replace('T', ' '))} UTC` : ''}</small>
<form method="post" action="/account/remove"><input type="hidden" name="tenant" value="${esc(m.tenant)}">
<button type="submit">Remove</button></form></li>`).join('\n')
  return page('Your machines', `
<p>Signed in as <b>${esc(who)}</b>.</p>
${note ? `<p>${esc(note)}</p>` : ''}
${machines.length ? `<ul>${rows}</ul>
<p><small>Removing a machine deletes its queue and history on the relay at once; its runner stops working
with the relay. Run the installer again to join it back.</small></p>` : '<p>No machines are joined to the hosted relay.</p>'}`)
}
