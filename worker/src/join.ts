/**
 * Joining the hosted relay with a Sasonica account (docs/hosted-relay.md):
 * what `sasonica install --hosted` does instead of asking for a Cloudflare
 * token. Plain TypeScript like ./tenant.ts; ./hosted.ts wraps it.
 *
 *   1. The installer POSTs /join/start and gets a link, a short code and a
 *      poll secret. It shows the link and the code.
 *   2. The person opens the link: /join/<id> sends them to cms.sasonica.com
 *      to sign in (authorization code + PKCE, the public client
 *      `sasonica-relay`), which comes back to /join/callback.
 *   3. The relay asks the issuer who signed in (userinfo, server to server),
 *      checks the account may have a tenant, and shows a page naming the
 *      machine and the code, with a Join button. The button is what binds a
 *      tenant to the account -- not the sign-in alone -- so a join link sent
 *      to someone else cannot quietly put a stranger's machine in their
 *      account: they would be asked about a code they have never seen.
 *   4. The installer, polling with its secret, collects the machine's
 *      credentials once; the join is then wiped. Unclaimed, it expires.
 *
 * One Durable Object per join, so a join's verifier, poll secret and the
 * credentials it hands over live nowhere else and go with it.
 */

import { randomHex, sha256Hex, timingSafeEqual } from './index.ts'
import type { StorageLike } from './tenant.ts'

export const ISSUER = 'https://cms.sasonica.com'
export const CLIENT_ID = 'sasonica-relay'
/** How long a join waits for its sign-in and its collection. */
export const JOIN_TTL_MS = 15 * 60_000

export interface Creds {
  tenant: string
  SASONICA_WORKER_URL: string
  SASONICA_RUNNER_TOKEN: string
  SASONICA_URL_SECRET: string
  hmac_key: string
  connector_url: string
}

type Status = 'started' | 'signed-in' | 'joined'

export function b64url(bytes: ArrayBuffer): string {
  let bin = ''
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Six letters and digits, none of 0/O/1/I: read off one screen, matched on another. */
export function joinCode(): string {
  const a = new Uint8Array(6)
  crypto.getRandomValues(a)
  return [...a].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b & 31]).join('')
}

/** A machine name as the installer sends it: short and plain, it goes into a page. */
export function cleanMachine(raw: unknown): string {
  return String(raw ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'a machine'
}

export class JoinCore {
  private storage: StorageLike
  private now: () => number

  constructor(storage: StorageLike, now: () => number = Date.now) {
    this.storage = storage
    this.now = now
  }

  private get(): Record<string, string> | null {
    const has = this.storage.sql.exec(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'join_state'`).toArray()
    if (!has.length) return null
    const rows = this.storage.sql.exec(`SELECT key, value FROM join_state`).toArray()
    if (!rows.length) return null
    const out: Record<string, string> = {}
    for (const r of rows) out[r.key] = r.value
    if (this.now() - Number(out.created_ms) > JOIN_TTL_MS) { this.wipe(); return null }
    return out
  }
  private put(values: Record<string, string>) {
    for (const [k, v] of Object.entries(values)) {
      this.storage.sql.exec(`INSERT INTO join_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, k, v)
    }
  }
  wipe() {
    this.storage.sql.exec(`DROP TABLE IF EXISTS join_state`)
  }

  /** Step 1. The poll secret is kept as a hash; the verifier as is (it must be sent). */
  async start(pollSha256: string, machine: string, code: string): Promise<{ ok: true } | { error: string }> {
    if (this.get()) return { error: 'join exists' }
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS join_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    this.put({
      status: 'started', created_ms: String(this.now()), poll_sha256: pollSha256,
      machine, code, verifier: randomHex(32), confirm: randomHex(16),
    })
    return { ok: true }
  }

  /** Step 2: where to send the browser, or null for a join that is gone. */
  async authorizeUrl(id: string, origin: string): Promise<string | null> {
    const s = this.get()
    if (!s || s.status !== 'started') return null
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.verifier)))
    const q = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: `${origin}/join/callback`,
      scope: 'openid profile email', state: id, code_challenge: challenge, code_challenge_method: 'S256',
    })
    return `${ISSUER}/oauth/authorize?${q}`
  }

  /**
   * Step 3: the code for the account behind it. `allowed` decides who may
   * have a tenant at all. Returns what the confirm page shows.
   */
  async callback(code: string, origin: string, allowed: (account: string) => boolean,
                 fetcher: typeof fetch = fetch): Promise<
    { machine: string; code: string; confirm: string; who: string; account: string } | { error: string }> {
    const s = this.get()
    if (!s || s.status !== 'started') return { error: 'This join has expired or was already used. Run the installer again.' }
    const tok = await fetcher(`${ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: `${origin}/join/callback`,
        client_id: CLIENT_ID, code_verifier: s.verifier,
      }),
    })
    const tj: any = await tok.json().catch(() => null)
    if (!tok.ok || !tj?.access_token) return { error: 'The sign-in could not be completed. Run the installer again.' }
    const ui = await fetcher(`${ISSUER}/oauth/userinfo`, { headers: { authorization: `Bearer ${tj.access_token}` } })
    const info: any = await ui.json().catch(() => null)
    const sub = String(info?.sub ?? '')
    if (!ui.ok || !sub) return { error: 'The sign-in could not be completed. Run the installer again.' }
    const account = `${ISSUER}|${sub}`
    if (!allowed(account)) {
      this.wipe()
      return { error: 'This Sasonica account cannot use the hosted relay yet.' }
    }
    const who = String(info?.preferred_username || info?.name || info?.email || `account ${sub}`).slice(0, 80)
    this.put({ status: 'signed-in', account, who })
    return { machine: s.machine, code: s.code, confirm: s.confirm, who, account }
  }

  /** Step 3, the button: the account and machine to make a tenant for. */
  confirm(nonce: string): { account: string; machine: string } | { error: string } {
    const s = this.get()
    if (!s || s.status !== 'signed-in' || !timingSafeEqual(nonce, s.confirm)) {
      return { error: 'This join has expired or was already used. Run the installer again.' }
    }
    return { account: s.account, machine: s.machine }
  }
  deliver(creds: Creds) {
    this.put({ status: 'joined', creds: JSON.stringify(creds) })
  }

  /** Step 4: the installer's poll. Credentials go out once. */
  async collect(poll: string): Promise<{ status: Status } | { creds: Creds } | null> {
    const s = this.get()
    if (!s || !timingSafeEqual(await sha256Hex(poll), s.poll_sha256)) return null
    if (s.status !== 'joined') return { status: s.status as Status }
    const creds = JSON.parse(s.creds) as Creds
    this.wipe()
    return { creds }
  }
}

// --- the pages ------------------------------------------------------------------

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} — Sasonica</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1.2rem;color:#111}
h1{font-size:1.4rem}.code{font:600 1.6rem ui-monospace,monospace;letter-spacing:.15em}
button{font:inherit;padding:.6rem 1.4rem;border-radius:.5rem;border:0;background:#111;color:#fff;cursor:pointer}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The confirm page carries a nonce; it must not be framed or cached.
      'cache-control': 'no-store', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  })
}

/**
 * The Join page. `replacing` is what joining this machine would remove: the
 * beta keeps one machine per account (RELAY_MACHINES_PER_ACCOUNT), and a
 * second join replaces the first rather than being refused -- the person
 * reinstalling, or moving to a new computer, is the common case -- but it
 * says so before the button, never after.
 */
export function confirmPage(id: string, p: { machine: string; code: string; confirm: string; who: string },
                            replacing: string[] = []): Response {
  const names = replacing.map((m) => `<b>${esc(m)}</b>`).join(', ')
  const swap = replacing.length
    ? `<p>Your account already has ${names} on the relay. During the beta an account has
${replacing.length === 1 ? 'one machine' : 'a limited number of machines'}, so joining this one <b>removes ${names}</b>:
its queue and history on the relay are deleted and its runner stops working with the relay.</p>`
    : ''
  return page('Add this machine to your relay?', `
<p>Signed in as <b>${esc(p.who)}</b>.</p>
<p>The machine <b>${esc(p.machine)}</b> wants to join, so assistants you connect can run commands on it.
Only go on if the installer on that machine shows this code:</p>
<p class="code">${esc(p.code)}</p>
${swap}
<form method="post" action="/join/${esc(id)}/confirm">
<input type="hidden" name="confirm" value="${esc(p.confirm)}">
<button type="submit">${replacing.length ? 'Replace and join' : 'Join'}</button></form>
<p>If you did not start this, close the page; nothing is added.</p>`)
}
