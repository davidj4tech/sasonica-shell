/**
 * OAuth for the MCP endpoint (docs/tools-and-approvals.md §6): the Worker is
 * an OAuth 2.1 authorization server for its own /mcp, and Cloudflare Access
 * decides who the owner is.
 *
 *   assistant ── adds the connector: https://<worker>/mcp, no secret ──▶ 401
 *   assistant ── registers itself (dynamic client registration) ──────▶ /oauth/register
 *   you ──▶ /authorize: "Allow Claude to run commands on this machine?"
 *       Allow ──▶ Access (one-time PIN to your email, or your Google login)
 *       Access ──▶ /callback with a code; the Worker swaps it for an ID
 *                  token, checks it is SASONICA_OWNER_EMAIL, and grants
 *   assistant ── Bearer token on every call ─────────────────────────▶ /mcp
 *
 * `@cloudflare/workers-oauth-provider` does the OAuth: discovery, dynamic
 * registration, PKCE, tokens in KV (encrypted, so KV alone cannot mint
 * access), the consent page's binding cookie, and the state sent to Access.
 * This file is the two pages it leaves to the application — consent, and
 * the callback — and the check that the person Access signed in is the
 * owner. Access is an "Access for SaaS" OIDC app with its own policy; the
 * email is checked here as well, so a policy widened by mistake still does
 * not hand out a shell.
 *
 * Off unless every setting below is present: then the Worker is exactly
 * what it was, secret URLs only. On, the secret URLs keep working beside it
 * (every path the provider does not own falls through to secretFetch) until
 * the owner revokes them — `sasonica client revoke default`.
 *
 * Each assistant registers as its own client and gets its own grant, so the
 * `client` on a row it queues is that registration (`oauth-claude`), and
 * revoking one grant leaves the others working.
 */
import { mcpServe, secretFetch, type Env } from './index.ts'

export interface OAuthEnv {
  /** KV for the provider's clients, grants and tokens. */
  OAUTH_KV?: KVNamespace
  /** The Access for SaaS (OIDC) app: its client id and secret. */
  ACCESS_CLIENT_ID?: string
  ACCESS_CLIENT_SECRET?: string
  /** The Zero Trust team domain: `<team>.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string
  /** The one email that may authorize a connector. */
  SASONICA_OWNER_EMAIL?: string
}

/** Scope a connector is granted. One scope: the shell is all or nothing. */
const SCOPE = 'shell'

export function oauthOn(env: OAuthEnv): boolean {
  return !!(env.OAUTH_KV && env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET && env.ACCESS_TEAM_DOMAIN && env.SASONICA_OWNER_EMAIL)
}

/** The Access OIDC endpoints for this app (Access for SaaS, generic OIDC). */
export function accessEndpoints(env: OAuthEnv) {
  const team = String(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const issuer = `https://${team}/cdn-cgi/access/sso/oidc/${env.ACCESS_CLIENT_ID}`
  return { issuer, authorization: `${issuer}/authorization`, token: `${issuer}/token`, jwks: `${issuer}/jwks` }
}

/** What a grant carries to the MCP handler (encrypted in KV by the provider). */
interface GrantProps {
  client: string
}

/** A registered client's label on its rows: `oauth-` and a slug of its name. */
export function grantLabel(clientName: string | undefined, clientId: string): string {
  const slug = String(clientName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return `oauth-${slug || clientId.slice(0, 8)}`
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function page(title: string, body: string, headers = new Headers(), status = 200): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8')
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>body{font:17px/1.45 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}button{font:inherit;padding:.6rem 1.1rem;border-radius:10px;border:1px solid #888;background:#fff}button[value=approve]{background:#1f6f4a;color:#fff;border-color:#1f6f4a}.warn{color:#9a4b00}</style>
${body}`
  return new Response(html, { status, headers })
}

function consentPage(clientName: string, clientId: string, redirectUri: string, handle: string, machine: string): string {
  const name = escape(clientName || clientId)
  const host = new URL(redirectUri).hostname
  const local = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(host)
  const origin = clientId.startsWith('https://')
    ? `Published by <strong>${escape(new URL(clientId).hostname)}</strong>.`
    : 'It registered itself, so its name is not verified.'
  return `<h1>Allow ${name} to run commands on ${escape(machine)}?</h1>
<p>It will be able to run any shell command there, as you. ${origin} Its access goes to <strong>${escape(host)}</strong>.</p>
${local ? '<p class="warn"><strong>That is an app on this computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
<p>Next, Cloudflare Access checks that it is you.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

async function s256(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
}

/**
 * Verify an Access ID token: RS256 against the app's JWKS, this issuer, this
 * client, not expired. Returns its claims, or throws. The token came straight
 * from Access's token endpoint over TLS, authenticated with the client
 * secret, so this is the second check, not the only one.
 */
export async function verifyIdToken(idToken: string, env: OAuthEnv, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const [h, p, sig] = String(idToken).split('.')
  if (!h || !p || !sig) throw new Error('not a JWT')
  const header = JSON.parse(new TextDecoder().decode(b64urlBytes(h)))
  const claims = JSON.parse(new TextDecoder().decode(b64urlBytes(p)))
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`)
  const ep = accessEndpoints(env)
  const jwks = (await (await fetcher(ep.jwks)).json()) as { keys?: JsonWebKey[] & { kid?: string }[] }
  const jwk = (jwks.keys || []).find((k: any) => !header.kid || k.kid === header.kid)
  if (!jwk) throw new Error('no key for this token')
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`))
  if (!ok) throw new Error('bad signature')
  if (claims.iss !== ep.issuer) throw new Error('wrong issuer')
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(env.ACCESS_CLIENT_ID)) throw new Error('wrong audience')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() - 60_000) throw new Error('expired')
  return claims
}

/** Is this the owner? Case-insensitive, and only a verified email counts. */
export function isOwner(claims: Record<string, unknown>, env: OAuthEnv): boolean {
  const email = String(claims.email || '').trim().toLowerCase()
  return !!email && email === String(env.SASONICA_OWNER_EMAIL).trim().toLowerCase() && claims.email_verified !== false
}

/** The machine's name for the consent page: the Worker's own, `sasonica-shell-red5` → `red5`. */
function machineName(url: URL): string {
  const sub = url.hostname.split('.')[0]
  return sub.replace(/^sasonica-shell-/, '') || 'this machine'
}

type Helpers = any

/** `/authorize` and `/callback`; every other path the provider does not own is the secret URLs' and the runner's. */
async function authHandler(request: Request, env: Env & { OAUTH_PROVIDER: Helpers }): Promise<Response> {
  const url = new URL(request.url)
  const oauth = env.OAUTH_PROVIDER
  const { AuthorizationError } = await lib()
  try {
    if (url.pathname === '/authorize' && request.method === 'GET') {
      const req = await oauth.parseAuthRequest(request)
      const client = await oauth.lookupClient(req.clientId)
      if (!client) return page('Unknown app', '<p>That app is not registered here.</p>', undefined, 400)
      const consent = await oauth.beginConsent(req)
      return page('Allow access?', consentPage(client.clientName, client.clientId, req.redirectUri, consent.handle, machineName(url)), consent.headers)
    }
    if (url.pathname === '/authorize' && request.method === 'POST') {
      const form = await request.formData()
      const handle = String(form.get('handle') || '')
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle)
        denied.headers.set('Location', denied.redirectTo)
        return new Response(null, { status: 302, headers: denied.headers })
      }
      const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] })
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
      const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers })
      const to = new URL(accessEndpoints(env).authorization)
      to.searchParams.set('response_type', 'code')
      to.searchParams.set('client_id', String(env.ACCESS_CLIENT_ID))
      to.searchParams.set('redirect_uri', `${url.origin}/callback`)
      to.searchParams.set('scope', 'openid email')
      to.searchParams.set('state', state)
      to.searchParams.set('code_challenge', await s256(verifier))
      to.searchParams.set('code_challenge_method', 'S256')
      headers.set('Location', to.href)
      return new Response(null, { status: 302, headers })
    }
    if (url.pathname === '/callback' && request.method === 'GET') {
      const { request: original, data, headers } = await oauth.finishUpstream(request)
      const deny = (why: string) => {
        console.log(`oauth: refused at the callback: ${why}`)
        const back = new URL(original.redirectUri)
        back.searchParams.set('error', 'access_denied')
        back.searchParams.set('state', original.state)
        if (original.issuer) back.searchParams.set('iss', original.issuer)
        headers.set('Location', back.href)
        return new Response(null, { status: 302, headers })
      }
      if (url.searchParams.get('error')) return deny(`Access said ${url.searchParams.get('error')}`)
      const res = await fetch(accessEndpoints(env).token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: url.searchParams.get('code') || '',
          redirect_uri: `${url.origin}/callback`,
          client_id: String(env.ACCESS_CLIENT_ID),
          client_secret: String(env.ACCESS_CLIENT_SECRET),
          code_verifier: (data as { verifier: string }).verifier,
        }),
      })
      const tok = (await res.json().catch(() => ({}))) as { id_token?: string }
      if (!res.ok || !tok.id_token) return deny(`token endpoint answered ${res.status}`)
      let claims: Record<string, unknown>
      try {
        claims = await verifyIdToken(tok.id_token, env)
      } catch (e) {
        return deny(`ID token: ${(e as Error).message}`)
      }
      if (!isOwner(claims, env)) return deny('not the owner')
      const client = await oauth.lookupClient(original.clientId)
      const label = grantLabel(client?.clientName, original.clientId)
      const { redirectTo } = await oauth.completeAuthorization({
        request: original,
        userId: String(claims.email).toLowerCase(),
        metadata: { label, clientName: client?.clientName || '' },
        scope: [SCOPE],
        props: { client: label } satisfies GrantProps,
      })
      headers.set('Location', redirectTo)
      return new Response(null, { status: 302, headers })
    }
  } catch (error) {
    if (error instanceof AuthorizationError && (error as any).redirectUri) {
      const e = error as any
      const back = new URL(e.redirectUri)
      back.searchParams.set('error', e.code)
      back.searchParams.set('error_description', e.description)
      if (e.state) back.searchParams.set('state', e.state)
      if (e.issuer) back.searchParams.set('iss', e.issuer)
      return Response.redirect(back.href, 302)
    }
    if (error instanceof AuthorizationError || (error as Error)?.name === 'CimdFetchError') {
      const msg = error instanceof AuthorizationError ? (error as any).description : 'That app could not be verified.'
      return page('Could not connect', `<p>${escape(String(msg))}</p><p>Start connecting again from the app.</p>`, undefined, 400)
    }
    throw error
  }
  return secretFetch(request, env)
}

// The library imports `cloudflare:workers`, which only the Workers runtime
// has: loaded when OAuth is on, so the secret-URL Worker (and its tests under
// Node) never touch it.
let libPromise: Promise<typeof import('@cloudflare/workers-oauth-provider')> | null = null
const lib = () => (libPromise ??= import('@cloudflare/workers-oauth-provider'))

/** One provider per origin: its resource and issuer are this Worker's own URL. */
const providers = new Map<string, { fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> }>()

export async function oauthFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const origin = new URL(request.url).origin
  let provider = providers.get(origin)
  if (!provider) {
    const { OAuthProvider } = await lib()
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: {
        fetch: (req: Request, e: Env, c: ExecutionContext & { props: GrantProps }) => mcpServe(req, e, c.props.client, null),
      } as any,
      defaultHandler: { fetch: (req: Request, e: Env) => authHandler(req, e as Env & { OAUTH_PROVIDER: Helpers }) } as any,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      // Client ID Metadata Documents: how MCP clients identify themselves
      // from the 2026 spec on (dynamic registration stays for older ones).
      // Needs global_fetch_strictly_public (wrangler.jsonc.template).
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: [SCOPE],
        resource_name: 'Sasonica Shell',
      },
    }) as any
    providers.set(origin, provider!)
  }
  return provider!.fetch(request, env, ctx)
}
