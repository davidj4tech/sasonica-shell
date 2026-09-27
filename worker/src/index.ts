/**
 * Sasonica Shell — the smallest relay that works. (Called Runlet until
 * 21 Sep 2026.)
 *
 * One MCP server, four tools: run_command queues a shell command for a runner
 * on your machine; get_result fetches it later; detach lets a slow foreground
 * command keep running without holding the queue; cancel stops pending or running
 * work. No Claude Code on the host, no panes, no mail.
 *
 * ###########################################################################
 * ##  This queues commands that a machine will EXECUTE as a real user.     ##
 * ##  Whoever can reach this Worker's URL can run arbitrary shell on the   ##
 * ##  runner host. Two things stand in the way:                            ##
 * ##                                                                       ##
 * ##   1. The URL secret. The MCP endpoint is /<SASONICA_URL_SECRET>/mcp   ##
 * ##      (or a per-client secret from the `clients` table), optionally    ##
 * ##      /<secret>/<name>/mcp, and any other path is 404. The name only   ##
 * ##      labels rows; the secret alone decides access. Treat each URL     ##
 * ##      like a password: it goes into the connector settings of the      ##
 * ##      assistants you trust and nowhere else.                           ##
 * ##   2. HMAC. Every row is signed with SASONICA_HMAC_KEY, held only here    ##
 * ##      and on the runner. Database access alone cannot make the runner ##
 * ##      execute anything.                                                ##
 * ###########################################################################
 *
 * The signature is byte-for-byte the v1 scheme of tmux-relay's runner
 * (nonce + "\n" + command, HMAC-SHA256 keyed with the ASCII hex key), so
 * sasonica.mjs and tmux-relay's d1-runner.sh agree; tests/vectors.json in that
 * repo pins it.
 */

import { oauthFetch, oauthOn, ownerId, type OAuthEnv } from './oauth.ts'

export interface Env extends OAuthEnv {
  DB: D1Database
  /** Hex key shared with the runner (relay.key). Set with `wrangler secret put`. */
  SASONICA_HMAC_KEY: string
  /** The path secret. Set with `wrangler secret put`. */
  SASONICA_URL_SECRET: string
  /**
   * Bearer token a runner presents at /runner. One per machine, so the
   * machine that executes commands holds no Cloudflare credential at all --
   * a D1 API token is account-wide, and would reach every other queue.
   * Absent = the runner API is off, and every request to it is a 404.
   */
  SASONICA_RUNNER_TOKEN?: string
  /** Seconds run_command waits by default / at most. */
  SASONICA_WAIT_DEFAULT?: string
  SASONICA_WAIT_MAX?: string
}

const PROTOCOL_VERSION = '2025-06-18'
// How long an isolate trusts what it read from the clients table. A revoked
// URL keeps working for at most this long on an isolate that had just looked
// it up; README and SETUP say so. Short enough that `sasonica client revoke`
// is prompt, long enough that a burst of MCP calls costs one D1 read.
const CLIENT_CACHE_MS = 30_000
// Cap on any `wait`. The claude.ai connector drops a call that stays silent
// for about a minute, and sometimes sooner, so a longer wait fails there even
// though the Worker answers. Measured 2026-09-17; keep this well under that.
const WAIT_MAX = 30
const TERMINAL = ['done', 'error', 'rejected', 'timeout', 'cancelled']
const FAILED = ['error', 'rejected', 'timeout', 'cancelled']
const MAX_COMMAND_CHARS = 8000

// --- signing (mirrors tmux-relay relay-sign.sh relay_hmac) -----------------
// Exported for tests/check-signing.sh, which holds this and the runner's
// openssl implementation to the same vectors.
export async function hmacHex(keyText: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  // The key is the ASCII characters of the hex string, not the decoded bytes:
  // bash passes `-macopt key:$KEY`, which takes the literal text.
  const key = await crypto.subtle.importKey('raw', enc.encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
}
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// --- who is asking -----------------------------------------------------------
// Three answers, recorded side by side on each row, because they are
// different kinds of fact:
//
//   client  which connector URL the request came through. The URL is the
//           credential, so this is the one that means something: revoking
//           it stops that assistant and no other.
//   name    the name the URL itself carries, /<secret>/<name>/mcp or
//           ?as=<name>, chosen by whoever pasted the URL. Several connectors
//           can share one secret and still be told apart ("desk", "phone").
//           It decides nothing: the same secret works under any name.
//   agent   what the assistant says it is (clientInfo.name at initialize,
//           else its User-Agent). Anyone can claim any name; it is there
//           so a person reading the rows can tell who did what on a URL
//           several assistants share, not to decide anything.

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The clients table, cached per isolate by the sha256 of the offered secret.
// A miss is cached too, so probing with one wrong secret does not become a
// D1 read per request -- but a probe with a new secret each time still is,
// which is why the cache is bounded rather than trusted to stay small.
type ClientLookup = { label: string; revoked: boolean } | null
const clientCache = new Map<string, { at: number; hit: ClientLookup }>()

/** For tests: forget every cached lookup, as a fresh isolate would. */
export function resetClientCache(): void {
  clientCache.clear()
}

async function lookupClient(env: Env, hash: string): Promise<ClientLookup> {
  const now = Date.now()
  const cached = clientCache.get(hash)
  if (cached && now - cached.at < CLIENT_CACHE_MS) return cached.hit
  let hit: ClientLookup = null
  try {
    const row = await env.DB.prepare(`SELECT label, revoked_at FROM clients WHERE secret_sha256 = ?`)
      .bind(hash).first<{ label: string; revoked_at: string | null }>()
    if (row) hit = { label: row.label, revoked: row.revoked_at !== null }
  } catch (e) {
    // No clients table: a database the installer has not migrated yet. The
    // shared URL must go on working through that, so this is "no row", and
    // it is not cached -- the next request looks again.
    console.error(`sasonica: clients lookup failed (${(e as Error).message}); only the shared URL is accepted`)
    return null
  }
  if (clientCache.size >= 256) clientCache.clear()
  clientCache.set(hash, { at: now, hit })
  return hit
}

// The label a path secret is good for, or null for a 404.
//
// The table is asked by hash, so what the database compares is a digest of
// the secret, not the secret: how long that takes says nothing about how
// close a guess was. The env secret is compared constant-time as before.
//
// A row wins over the env secret. That is how the shared URL is revoked: a
// 'default' row carrying the hash of SASONICA_URL_SECRET, with revoked_at
// set. Once the secret is rotated its hash no longer matches that row, and
// the new shared URL works again.
export async function clientFor(env: Env, secret: string): Promise<string | null> {
  if (!secret) return null
  const hit = await lookupClient(env, await sha256Hex(secret))
  if (hit) return hit.revoked ? null : hit.label
  if (env.SASONICA_URL_SECRET && timingSafeEqual(secret, env.SASONICA_URL_SECRET)) return 'default'
  return null
}

// The name slot of a connector URL: [a-z0-9._-]{1,32} after lowercasing, the
// same alphabet as a client label, or null. Short and plain because it goes
// into a D1 column, a terminal and the session id's MAC input.
const URL_NAME_RE = /^[a-z0-9._-]{1,32}$/
export function urlName(raw: string | null | undefined): string | null {
  const name = String(raw ?? '').toLowerCase()
  return URL_NAME_RE.test(name) ? name : null
}

// Where an MCP request is aimed: the secret, and the name if the URL gives
// one. The URL must end in /mcp -- some connector UIs refuse one that does
// not -- so the name sits between the two:
//
//     /<secret>/mcp            no name, as always
//     /<secret>/<name>/mcp     the named form
//     ...?as=<name>            the same name as a query, on either form
//
// A bad name in the path is a 404 like any other bad path, so it says nothing
// about whether the secret was right. A bad ?as= is only ignored: a query is
// something a connector UI may add to or mangle, and it was never part of
// the path that decides access. The path wins when both are given.
export function mcpTarget(url: URL): { secret: string; name: string | null } | null {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.at(-1) !== 'mcp') return null
  const asName = urlName(url.searchParams.get('as'))
  if (parts.length === 2) return { secret: parts[0], name: asName }
  if (parts.length === 3) {
    const name = urlName(parts[1])
    return name ? { secret: parts[0], name } : null
  }
  return null
}

// Visible ASCII only, and not much of it: this goes into a header, a D1
// column and a terminal, and nobody needs a 500-character client name.
function cleanName(raw: unknown, max = 64): string {
  return String(raw ?? '').replace(/[^\x21-\x7e ]/g, '').trim().replace(/\s+/g, '-').slice(0, max)
}

// The assistants people actually connect, by what they call themselves, and
// the name a person would call them. Matched case-insensitively on the name
// with any "/version" dropped. Measured 2026-09-21: Claude.ai's connector
// sends the User-Agent "Claude-User", ChatGPT's "openai-mcp/1.0.0"; neither
// had echoed a session id by then, so the User-Agent is what names them.
// Anything not listed keeps its raw form, so a new assistant is still told
// apart -- it just reads less kindly until it is added here.
const FRIENDLY: Record<string, string> = {
  'claude-user': 'claude.ai',
  'claude-ai': 'claude.ai',
  // clientInfo.name since late Sep 2026: "Anthropic/ClaudeAI" (the /version
  // split leaves "anthropic").
  'anthropic': 'claude.ai',
  'openai-mcp': 'chatgpt',
}
export function friendly(name: string): string | null {
  return FRIENDLY[name.split('/')[0].toLowerCase()] ?? null
}

/** The name an initialize request gives: clientInfo.name, with its version. */
export function agentFromInitialize(params: any): string | null {
  const name = cleanName(params?.clientInfo?.name, 48)
  if (!name) return null
  const known = friendly(name)
  if (known) return known
  const version = cleanName(params?.clientInfo?.version, 15)
  return version ? `${name}@${version}` : name
}

// The first product token of the User-Agent ("Claude-User",
// "python-httpx/0.28.1"). A known one gets its friendly name; an unknown one
// is marked as such: it is a weaker claim than clientInfo, and the row should
// say which one it is.
function agentFromUserAgent(request: Request): string | null {
  const first = cleanName((request.headers.get('user-agent') ?? '').trim().split(/\s+/)[0], 60)
  if (!first) return null
  return friendly(first) ?? `ua:${first}`
}

// --- the session id ------------------------------------------------------------
// MCP's streamable HTTP transport (2025-06-18) lets a server hand out an
// Mcp-Session-Id on the response to initialize; a client then sends it on
// every later request. Sasonica Shell keeps no sessions, so the id carries
// the name itself, signed, and a later request can be attributed without a
// D1 read:
//
//     base64url(agent) "." nonce "." hmac
//
// The spec asks for visible ASCII and a cryptographically secure, globally
// unique id: base64url, hex and dots are all visible ASCII, and the random
// nonce makes each id unique even for the same name.
//
// The key is DERIVED from SASONICA_HMAC_KEY, never the key itself. The
// agent's name is chosen by whoever calls initialize, and with the command
// key a session id would be a signature over attacker-chosen text: a name
// shaped like "<nonce>\n<command>" would come back signed as a runnable row.
// Under a derived key it signs nothing the runner would accept. The URL's
// client label and its name are inside the MAC too (sessionScope), so an id
// minted on one URL -- or under one name on the same secret -- means nothing
// on another, and one connector cannot carry its agent name to another.
//
// A missing or bad id never refuses a request. The spec allows a server to
// 400 a request without one, but clients that do not echo the header must
// keep working, and this is attribution, not access control.
const SESSION_KEY_LABEL = 'sasonica-shell session-id v1'
let sessionKeyCache: { from: string; key: string } | null = null
async function sessionKey(env: Env): Promise<string> {
  if (sessionKeyCache?.from !== env.SASONICA_HMAC_KEY) {
    sessionKeyCache = { from: env.SASONICA_HMAC_KEY, key: await hmacHex(env.SASONICA_HMAC_KEY, SESSION_KEY_LABEL) }
  }
  return sessionKeyCache.key
}

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlDecode(text: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}

// What a session id is bound to: the client label, and the URL's name after a
// '/'. A label cannot contain '/', so "a/b" is never a bare label; and an
// unnamed URL's scope is the label alone, exactly as before names existed, so
// the ids connectors already hold keep verifying across the deploy.
export function sessionScope(client: string, name: string | null): string {
  return name ? `${client}/${name}` : client
}

export async function mintSessionId(env: Env, scope: string, agent: string): Promise<string> {
  const name = b64urlEncode(agent)
  const nonce = randomHex(12)
  const mac = await hmacHex(await sessionKey(env), `${scope}\n${name}.${nonce}`)
  return `${name}.${nonce}.${mac}`
}

/** The agent name a session id carries, or null if it is absent, malformed or not ours. */
export async function agentFromSessionId(env: Env, scope: string, id: string | null): Promise<string | null> {
  if (!id || id.length > 400) return null
  const parts = id.split('.')
  if (parts.length !== 3 || !/^[0-9a-f]{24}$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) return null
  const want = await hmacHex(await sessionKey(env), `${scope}\n${parts[0]}.${parts[1]}`)
  if (!timingSafeEqual(parts[2], want)) return null
  const name = b64urlDecode(parts[0])
  return name ? cleanName(name) || null : null
}

// --- MCP -------------------------------------------------------------------
const TOOLS = [
  {
    name: 'run_command',
    description:
      "Run a shell command on the user's own machine and return its output. The " +
      'command is queued for a runner there, which executes it as the user with ' +
      'bash -lc, a 600 s limit and up to 60 KB of output kept; this call waits up ' +
      'to `wait` seconds for the result. Anything you send here RUNS on a real ' +
      "machine: prefer read-only commands unless the user asked for a change, and " +
      'never run something destructive on a guess.\n\n' +
      'Start with `sasonica skills` (or `"$SASONICA" skills` if sasonica is not on ' +
      'PATH): it lists the tools the owner has set up on this machine ' +
      '(messaging, services, project helpers), each with a file to read before ' +
      'using it. Check it before assuming something is not there. ' +
      '`sasonica --help` shows the rest.\n\n' +
      'How to operate it:\n' +
      '- The result starts with "#<id> <status> exit=<code>" then the output. ' +
      'Status done means it ran; check exit= before trusting the output.\n' +
      '- Commands run ONE AT A TIME in the order queued (unless the host set ' +
      'SASONICA_PARALLEL), so a long command holds everything behind it -- unless ' +
      'you pass background=true, which lets that one run alongside the queue.\n' +
      '- For anything long: pass background=true and a short wait, note the id, ' +
      'and call get_result with a wait when you want the output. Meanwhile other ' +
      'commands still run in turn.\n' +
      '- Output over 60 KB is cut; pipe through head, tail or grep instead of ' +
      'dumping large files.\n' +
      '- There is no working directory or shell state between calls: each ' +
      "command starts fresh in the user's home. Use cd inside the command.\n" +
      '- Quote carefully: the string is passed to bash exactly as given.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command, run with bash -lc from the home directory.' },
        wait: { type: 'number', description: 'Seconds to wait for the result (default 30, max 30). Use 0 to queue and return the id at once.' },
        background: {
          type: 'boolean',
          description:
            'true: start this command alongside the queue instead of in turn, so it does not ' +
            'block commands queued after it. For builds, downloads, long scripts. The host caps ' +
            'how many background jobs run at once (default 4); past the cap it waits.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'cancel',
    description:
      'Stop a command: one still queued never starts; one already running is killed by the ' +
      'runner (with everything it spawned) and its status becomes cancelled. Whatever the ' +
      'command had already done stays done -- this stops it, it does not undo it. ' +
      'Waits briefly (default 15 s, `wait` to change) for the runner to confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Row id from run_command.' },
        wait: { type: 'number', description: 'Seconds to wait for the runner to confirm (default 15, max 30).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'detach',
    description:
      'Let a command that is already running (or still queued) stop holding up the queue: ' +
      'it keeps running in the background and commands after it proceed. Use it when ' +
      'something is taking longer than expected and you want to do other things meanwhile. ' +
      'Collect its output later with get_result and a wait. Does not stop or kill anything.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Row id from run_command.' } },
      required: ['id'],
    },
  },
  {
    name: 'get_result',
    description:
      'Fetch the status and output of a command queued earlier, by the id run_command ' +
      'returned. Pass `wait` to block up to that many seconds until it finishes, so a ' +
      'long job needs one call rather than a polling loop; without it you get the ' +
      'current state at once. Status pending or running means it has not finished; ' +
      'a running job shows the output it has produced so far (refreshed every ~10 s).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Row id from run_command.' },
        wait: { type: 'number', description: 'Seconds to wait for it to finish (default 0: answer now; max 30).' },
      },
      required: ['id'],
    },
  },
]

// --- typed tools (docs/tools-and-approvals.md §1) ----------------------------
//
// A runner publishes what its skills can do: a name, a description and a
// JSON Schema for the arguments. The argv template that actually runs stays
// on the runner and is never sent here — so a leaked URL can call a tool the
// owner declared, with arguments that pass its schema, and can neither widen
// the command nor invent a tool. The row carries the manifest's sha256, and
// the runner refuses a call made against a manifest it no longer has.
//
// The schema subset is small on purpose (type, required, enum, pattern,
// min/max, maxLength, items for a string array): enough for a thin argv over
// a command that exists, small enough to check by hand in both places.

interface ToolRow {
  runner: string
  name: string
  description: string
  input: string
  sha256: string
}

/** `<skill>__<tool>`, lower case, so a published tool cannot shadow a built-in. */
const TOOL_NAME = /^[a-z0-9][a-z0-9_]{0,40}__[a-z0-9][a-z0-9_]{0,40}$/
const BUILT_IN = ['run_command', 'cancel', 'detach', 'get_result']

/** Every published tool, newest publish winning when two runners share a name. */
async function publishedTools(env: Env): Promise<ToolRow[]> {
  const { results = [] } = await env.DB.prepare(
    `SELECT runner, name, description, input, sha256 FROM tools
      GROUP BY name HAVING MAX(updated_at) ORDER BY name`,
  ).all<ToolRow>()
  return results
}

function parseSchema(text: string): any {
  try {
    const got = JSON.parse(text)
    return got && typeof got === 'object' ? got : { type: 'object' }
  } catch {
    return { type: 'object' }
  }
}

/**
 * `""` when `args` fit `schema`, else what is wrong with them, in the words
 * the caller sees. The runner checks the same things against its own copy;
 * this one is for a quick, useful error rather than a queued row that fails.
 */
export function checkArgs(schema: any, args: any): string {
  if (!schema || typeof schema !== 'object') return ''
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object'
  const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {}
  for (const want of Array.isArray(schema.required) ? schema.required : []) {
    if (args[String(want)] === undefined) return `missing required argument ${JSON.stringify(want)}`
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = props[key]
    if (!spec) {
      if (schema.additionalProperties === false || Object.keys(props).length) {
        return `unknown argument ${JSON.stringify(key)}`
      }
      continue
    }
    const bad = checkValue(spec, value, key)
    if (bad) return bad
  }
  return ''
}

function checkValue(spec: any, value: any, key: string): string {
  const type = String(spec.type ?? '')
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') {
    const ok = type === 'integer'
      ? typeof value === 'number' && Number.isInteger(value)
      : typeof value === type
    if (!ok) return `${key} must be ${type === 'integer' ? 'an integer' : `a ${type}`}`
  } else if (type === 'array') {
    if (!Array.isArray(value)) return `${key} must be an array`
    if (spec.maxItems !== undefined && value.length > Number(spec.maxItems)) {
      return `${key} has ${value.length} items; the limit is ${spec.maxItems}`
    }
    for (const item of value) {
      const bad = checkValue(spec.items ?? {}, item, `each item of ${key}`)
      if (bad) return bad
    }
    return ''
  }
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
    return `${key} must be one of ${spec.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}`
  }
  if (typeof value === 'string') {
    if (spec.maxLength !== undefined && value.length > Number(spec.maxLength)) {
      return `${key} is ${value.length} characters; the limit is ${spec.maxLength}`
    }
    if (spec.minLength !== undefined && value.length < Number(spec.minLength)) {
      return `${key} is shorter than ${spec.minLength} characters`
    }
    if (typeof spec.pattern === 'string') {
      let re: RegExp
      try { re = new RegExp(spec.pattern) } catch { return '' }
      if (!re.test(value)) return `${key} does not match ${spec.pattern}`
    }
  }
  if (typeof value === 'number') {
    if (spec.minimum !== undefined && value < Number(spec.minimum)) return `${key} is below ${spec.minimum}`
    if (spec.maximum !== undefined && value > Number(spec.maximum)) return `${key} is above ${spec.maximum}`
  }
  return ''
}

/**
 * What a tool row's `command` is: canonical JSON, keys in a fixed order, so
 * the string signed here is the string the runner verifies — byte for byte,
 * whatever either side's JSON library would otherwise do with key order or
 * spacing. The signing scheme itself is unchanged (nonce "\n" command).
 */
export function toolCommand(tool: string, args: Record<string, unknown>, manifestSha: string): string {
  const ordered: Record<string, unknown> = {}
  for (const key of Object.keys(args).sort()) ordered[key] = args[key]
  return JSON.stringify({ args: ordered, manifest_sha: manifestSha, tool })
}

interface Row {
  id: number
  status: string
  exit_code: number | null
  output: string | null
}

function render(row: Row, timedOut: boolean): string {
  const head = `#${row.id} ${row.status}${row.exit_code === null ? '' : ` exit=${row.exit_code}`}`
  if (timedOut) {
    const partial = row.status === 'running' && row.output ? `\n--- output so far ---\n${row.output}` : ''
    return `${head}\nStill running after the wait. Call get_result(id=${row.id}, wait=…) for the rest.${partial}`
  }
  return `${head}\n${row.output ?? ''}`
}

function rpc(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result })
}
function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } })
}
function toolText(id: unknown, text: string, isError = false): Response {
  return rpc(id, { content: [{ type: 'text', text }], isError })
}

// Poll a row until it is terminal or the wait runs out. Shared by
// run_command and get_result, so "wait for it" means the same thing in
// both: 250 ms growing to 2 s between looks, and the wait is a ceiling.
async function awaitRow(env: Env, id: number, waitSeconds: number): Promise<{ row: Row | null; timedOut: boolean }> {
  const deadline = Date.now() + waitSeconds * 1000
  let delay = 250
  for (;;) {
    const row = await env.DB.prepare(`SELECT id, status, exit_code, output FROM commands WHERE id = ?`).bind(id).first<Row>()
    if (row && TERMINAL.includes(row.status)) return { row, timedOut: false }
    if (Date.now() >= deadline) return { row, timedOut: true }
    await new Promise((r) => setTimeout(r, Math.min(delay, Math.max(0, deadline - Date.now()))))
    delay = Math.min(Math.round(delay * 1.5), 2000)
  }
}

// --- the runner API ---------------------------------------------------------
// Everything a runner used to do with its own D1 credential, as one POST with
// an `op`. Six ops, chosen so a poll costs one request and a watcher tick
// costs one: `claim` returns rows already claimed, and `heartbeat` writes
// progress and reads the cancel/background flags in the same round trip.
//
// The runner is not the assistant: it authenticates with a Bearer header
// rather than a path secret, so its credential stays out of URLs and logs.
const CLAIM_LIMIT = 5

function runnerJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
}

/** The owner's OAuth grants, or null when OAuth is off (no provider helpers in env). */
async function ownerGrants(env: Env): Promise<{ id: string; userId: string; label: string; clientName: string; createdAt: number }[] | null> {
  const helpers = (env as any).OAUTH_PROVIDER
  if (!helpers) return null
  const owner = ownerId(env)
  if (!owner) return null
  const out = []
  let cursor: string | undefined
  do {
    const page = await helpers.listUserGrants(owner, { limit: 1000, cursor })
    for (const g of page.items) {
      out.push({ id: g.id, userId: g.userId, label: String(g.metadata?.label ?? ''), clientName: String(g.metadata?.clientName ?? ''), createdAt: g.createdAt })
    }
    cursor = page.cursor
  } while (cursor)
  return out
}

/** The longest a runner's claim is held open (seconds): under the runner's
 *  60 s request timeout, and short enough that a dropped connection is noticed. */
const LONG_WAIT_MAX = 25

/** How long a sign-in waits for the owner, as SQLite's modifier. */
export const SIGNIN_WINDOW = '-10 minutes'

/** Sign-ins waiting for the owner; 0 on a database from before the table. */
async function pendingSignins(env: Env): Promise<number> {
  try {
    const r = await env.DB.prepare(
      `SELECT count(*) AS n FROM signins WHERE status = 'pending' AND created_at > datetime('now', ?)`,
    ).bind(SIGNIN_WINDOW).first<{ n: number }>()
    return Number(r?.n ?? 0)
  } catch {
    return 0
  }
}

export async function runnerApi(request: Request, env: Env): Promise<Response> {
  const offered = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  // Same 404 as an unknown path: whether the API exists must not depend on
  // whether the token was right.
  if (!env.SASONICA_RUNNER_TOKEN || !timingSafeEqual(offered, env.SASONICA_RUNNER_TOKEN)) {
    return new Response('not found', { status: 404 })
  }
  if (request.method !== 'POST') return new Response('POST JSON here', { status: 405 })

  let body: any
  try { body = await request.json() } catch { return runnerJson({ error: 'parse error' }, 400) }
  const runner = String(body?.runner ?? '')
  const id = Number(body?.id)

  switch (body?.op) {
    // OAuth grants (§6): list them, or revoke one assistant's. With the
    // runner's token, because revoking only ever takes access away -- it
    // cannot make a grant, as it cannot make a client URL. `null` when
    // OAuth is off.
    case 'grants':
      return runnerJson({ grants: await ownerGrants(env) })
    case 'grant-revoke': {
      const grants = await ownerGrants(env)
      if (!grants) return runnerJson({ error: 'OAuth is off on this Worker' }, 409)
      const label = String(body?.label ?? '')
      const hit = grants.filter((g) => g.id === body?.grant || (label && g.label === label))
      for (const g of hit) await (env as any).OAUTH_PROVIDER.revokeGrant(g.id, g.userId)
      return runnerJson({ revoked: hit.length })
    }
    // Claim pending rows and return them ALREADY claimed. The runner used to
    // SELECT and then UPDATE, and two runners could race for the same row;
    // doing both in one statement makes the claim atomic by construction.
    //
    // A claimed row is 'running', so a runner must only ask for what it can
    // start this moment -- hence separate counts. `fg` is the serial lane
    // (0 while it is busy), `bg` what is left under SASONICA_BACKGROUND_MAX.
    // Asking for both in one request is why a poll costs one round trip.
    case 'claim': {
      const fg = Math.min(Math.max(Number(body?.fg) || 0, 0), CLAIM_LIMIT)
      const bg = Math.min(Math.max(Number(body?.bg) || 0, 0), CLAIM_LIMIT)
      // Sign-ins waiting for the owner (SASONICA_SIGNIN=app): the count rides
      // every claim, so the runner asks for the list only when it moves.
      let signins = await pendingSignins(env)
      if (!fg && !bg) return runnerJson({ rows: [], signins })
      // Long wait (an idle runner asks with `wait`): held open until a row
      // arrives, the sign-ins move, or the wait is up, checking once a second
      // with a cheap read. An idle machine then costs one request per wait
      // instead of one per poll — what lets a free account hold ~30 of them —
      // and a command still starts within about a second (27 Sep 2026).
      const wait = Math.min(Math.max(Number(body?.wait) || 0, 0), LONG_WAIT_MAX)
      if (wait) {
        const seen = Number(body?.signins_seen ?? signins)
        const deadline = Date.now() + wait * 1000
        while (Date.now() < deadline && signins === seen) {
          const any = await env.DB.prepare(`SELECT 1 AS x FROM commands WHERE status = 'pending' LIMIT 1`).first()
          if (any) break
          await new Promise((r) => setTimeout(r, 1000))
          signins = await pendingSignins(env)
        }
      }
      const { results = [] } = await env.DB.prepare(
        `UPDATE commands SET status = 'running', runner = ?, updated_at = datetime('now')
         WHERE id IN (
           SELECT id FROM (SELECT id FROM commands WHERE status = 'pending' AND background = 0
                           ORDER BY id LIMIT ?)
           UNION ALL
           SELECT id FROM (SELECT id FROM commands WHERE status = 'pending' AND background = 1
                           ORDER BY id LIMIT ?)
         )
         RETURNING id, command, sig, nonce, COALESCE(background, 0) AS background,
                   COALESCE(kind, 'shell') AS kind`,
      ).bind(runner, fg, bg).all()
      return runnerJson({ rows: results, signins, ...(wait ? { waited: wait } : {}) })
    }
    // Sign-ins approved in the app (§6): the waiting ones, and a decision.
    // The decision is signed with SASONICA_HMAC_KEY as well as carried by
    // the runner's token: granting a connector is granting a shell, and the
    // key is what already stands between the database and running anything.
    case 'signins': {
      let rows: unknown[] = []
      try {
        rows = (await env.DB.prepare(
          `SELECT id, code, client_name, client_host, created_at FROM signins
            WHERE status = 'pending' AND created_at > datetime('now', ?) ORDER BY created_at`,
        ).bind(SIGNIN_WINDOW).all()).results ?? []
      } catch { rows = [] }
      return runnerJson({ signins: rows })
    }
    case 'signin-decide': {
      const sid = String(body?.id ?? '')
      const decision = body?.approve === true ? 'approve' : 'deny'
      const want = await hmacHex(env.SASONICA_HMAC_KEY, `signin\n${sid}\n${decision}`)
      if (!/^[0-9a-f]{32}$/.test(sid) || !timingSafeEqual(String(body?.sig ?? ''), want)) {
        return runnerJson({ error: 'bad signature' }, 403)
      }
      const r = await env.DB.prepare(
        `UPDATE signins SET status = ?, decided_at = datetime('now')
          WHERE id = ? AND status = 'pending' AND created_at > datetime('now', ?)`,
      ).bind(decision === 'approve' ? 'approved' : 'denied', sid, SIGNIN_WINDOW).run()
      if (!r.meta.changes) return runnerJson({ error: 'no such sign-in waiting' }, 404)
      return runnerJson({ id: sid, status: decision === 'approve' ? 'approved' : 'denied' })
    }

    // One tick of the watcher: store whatever the job has printed so far and
    // report the two flags back. Progress is only written while the row is
    // still running, so a finished row is never overwritten by a late tick.
    case 'heartbeat': {
      if (typeof body?.output === 'string') {
        await env.DB.prepare(
          `UPDATE commands SET output = ?, updated_at = datetime('now')
           WHERE id = ? AND status = 'running'`,
        ).bind(body.output, id).run()
      }
      const row = await env.DB.prepare(
        `SELECT COALESCE(background, 0) AS background, COALESCE(cancel, 0) AS cancel
         FROM commands WHERE id = ?`,
      ).bind(id).first<{ background: number; cancel: number }>()
      if (!row) return runnerJson({ error: 'no such row' }, 404)
      return runnerJson({ background: Number(row.background), cancel: Number(row.cancel) })
    }

    case 'result': {
      const status = String(body?.status ?? '')
      if (!TERMINAL.includes(status)) return runnerJson({ error: `bad status: ${status}` }, 400)
      await env.DB.prepare(
        `UPDATE commands SET status = ?, exit_code = ?, output = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(status, Number(body?.exitCode ?? -1), String(body?.output ?? ''), id).run()
      return runnerJson({ ok: true })
    }

    // Rows this runner left 'running': 'orphans' at startup (it restarted and
    // took its children with it), 'stale' for one whose runner hung rather
    // than restarted, which only the timeout can tell apart.
    case 'sweep': {
      const orphans = body?.kind === 'orphans'
      const note = orphans
        ? 'sasonica: the runner restarted while this was running; the command may or may not have completed'
        : 'sasonica: ran past the timeout without reporting; the runner may have hung'
      const sql = `UPDATE commands SET status = 'error', exit_code = -1, output = ?,
                     updated_at = datetime('now')
                   WHERE status = 'running' AND ` + (orphans
        ? '(runner = ? OR runner IS NULL)'
        : "runner = ? AND updated_at < datetime('now', ?)")
      const stmt = orphans
        ? env.DB.prepare(sql).bind(note, runner)
        : env.DB.prepare(sql).bind(note, runner, `-${Math.max(Number(body?.staleSeconds) || 720, 60)} seconds`)
      const { meta } = await stmt.run()
      return runnerJson({ changed: meta?.changes ?? 0 })
    }

    case 'prune': {
      const days = Math.max(Number(body?.keepDays) || 30, 1)
      const { meta } = await env.DB.prepare(
        `DELETE FROM commands WHERE status NOT IN ('pending', 'running')
         AND created_at < datetime('now', ?)`,
      ).bind(`-${days} days`).run()
      return runnerJson({ changed: meta?.changes ?? 0 })
    }

    // What this runner's skills can do (§1 of docs/tools-and-approvals.md).
    // The whole set, every time: the table is this runner's rows replaced,
    // so a tool the owner deleted stops being listed. `argv` is not sent and
    // is not wanted — only the runner knows what a tool actually runs.
    case 'tools': {
      if (!runner) return runnerJson({ error: 'tools needs a runner name' }, 400)
      const tools = Array.isArray(body?.tools) ? body.tools : []
      if (tools.length > 200) return runnerJson({ error: 'too many tools' }, 400)
      const rows: { name: string; description: string; input: string; sha256: string }[] = []
      for (const t of tools) {
        const name = String(t?.name ?? '')
        if (!TOOL_NAME.test(name) || BUILT_IN.includes(name)) {
          return runnerJson({ error: `bad tool name: ${JSON.stringify(name)}` }, 400)
        }
        if (!/^[0-9a-f]{64}$/.test(String(t?.sha256 ?? ''))) {
          return runnerJson({ error: `${name}: sha256 must be hex` }, 400)
        }
        rows.push({
          name,
          description: String(t?.description ?? '').slice(0, 4000),
          input: JSON.stringify(t?.input ?? { type: 'object' }).slice(0, 8000),
          sha256: String(t.sha256),
        })
      }
      const stmts = [env.DB.prepare(`DELETE FROM tools WHERE runner = ?`).bind(runner)]
      for (const r of rows) {
        stmts.push(env.DB.prepare(
          `INSERT INTO tools (runner, name, description, input, sha256, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        ).bind(runner, r.name, r.description, r.input, r.sha256))
      }
      await env.DB.batch(stmts)
      return runnerJson({ ok: true, tools: rows.length })
    }

    // Backs `sasonica status`, so the owner can ask a machine what it has been
    // doing without a Cloudflare credential in the picture.
    case 'status': {
      const { results = [] } = await env.DB.prepare(
        `SELECT id, status, exit_code, runner, client, name, agent, created_at, updated_at,
                substr(replace(replace(command, char(10), ' '), char(9), ' '), 1, 50) AS command,
                substr(replace(output, char(10), ' | '), 1, 70) AS output
         FROM commands ORDER BY id DESC LIMIT ?`,
      ).bind(Math.min(Math.max(Number(body?.limit) || 10, 1), 100)).all()
      return runnerJson({ rows: results })
    }

    default:
      return runnerJson({ error: `unknown op: ${body?.op}` }, 400)
  }
}

function clampWait(env: Env, asked: unknown, fallback: number): number {
  const max = Number(env.SASONICA_WAIT_MAX ?? WAIT_MAX)
  const n = Number(asked ?? fallback)
  return Math.min(Math.max(Number.isFinite(n) ? n : fallback, 0), max)
}

// `background` is scheduling advice, not part of what is signed: it changes
// WHEN the runner starts the row, never what runs, so a forged flag can at
// most start a signed command sooner.
//
// The same goes for `client`, `name` and `agent`: they say who asked, and
// are not signed either. The runner never reads them.
interface Caller {
  client: string
  name: string | null
  agent: string
}
async function enqueue(env: Env, command: string, waitSeconds: number, background: boolean, who: Caller,
                       kind: 'shell' | 'tool' = 'shell'): Promise<{ row: Row; timedOut: boolean }> {
  const nonce = randomHex(16)
  // Signed exactly as a shell row is: the scheme does not know or care
  // which kind of row it is, only what the runner will read back.
  const sig = await hmacHex(env.SASONICA_HMAC_KEY, `${nonce}\n${command}`)
  const ins = await env.DB.prepare(
    `INSERT INTO commands (command, status, sig, nonce, background, client, name, agent, kind, created_at, updated_at)
     VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(command, sig, nonce, background ? 1 : 0, who.client, who.name, who.agent, kind)
    .run()
  const id = Number(ins.meta.last_row_id)
  const r = await awaitRow(env, id, waitSeconds)
  return { row: r.row ?? { id, status: 'pending', exit_code: null, output: null }, timedOut: r.timedOut }
}

/**
 * Everything but OAuth: the runner's API, and MCP by secret URL. With OAuth
 * on (./oauth.ts) this still answers every path the OAuth provider does not
 * own, so the secret URLs keep working beside it until they are revoked.
 */
export async function secretFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  // The path IS the credential: the shared secret, or one of the
  // per-client ones (clientFor). Every miss is a plain 404, revoked or
  // unknown alike, so the endpoint cannot be found by probing and a
  // revoked URL cannot tell that it once worked.
  const parts = url.pathname.split('/').filter(Boolean)
  // The runner's own API, on a fixed path behind a Bearer token. Checked
  // first so it never has to be reachable through the assistant's secret.
  if (parts.length === 1 && parts[0] === 'runner') return runnerApi(request, env)
  const target = mcpTarget(url)
  const client = target ? await clientFor(env, target.secret) : null
  if (!target || !client) return new Response('not found', { status: 404 })
  return mcpServe(request, env, client, target.name)
}

/**
 * The MCP endpoint, once the caller is known: `client` is who the URL or
 * the OAuth grant says it is, and labels every row it queues.
 */
export async function mcpServe(request: Request, env: Env, client: string, urlName: string | null): Promise<Response> {
    const target = { name: urlName }
    const scope = sessionScope(client, target.name)
    if (request.method !== 'POST') return new Response('POST JSON-RPC here', { status: 405 })

    let body: any
    try {
      body = await request.json()
    } catch {
      return rpcError(null, -32700, 'parse error')
    }
    const { method, id, params } = body ?? {}
    if (id === undefined || id === null) return new Response(null, { status: 202 }) // a notification

    switch (method) {
      case 'initialize': {
        const res = rpc(id, {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'sasonica-shell', title: 'Sasonica Shell', version: '0.1.0' },
        })
        const agent = agentFromInitialize(params) ?? agentFromUserAgent(request)
        if (agent) res.headers.set('Mcp-Session-Id', await mintSessionId(env, scope, agent))
        return res
      }
      case 'ping':
        return rpc(id, {})
      case 'tools/list': {
        // The built-ins, then whatever the runners have published (§1 of
        // docs/tools-and-approvals.md). A published tool is an ordinary MCP
        // tool on the wire; its name is `<skill>__<tool>`, so it can never
        // be mistaken for one of the four above.
        let published: ToolRow[] = []
        try { published = await publishedTools(env) } catch { published = [] }
        const extra = published
          .filter((t) => TOOL_NAME.test(t.name) && !BUILT_IN.includes(t.name))
          .map((t) => ({ name: t.name, description: t.description, inputSchema: parseSchema(t.input) }))
        return rpc(id, { tools: [...TOOLS, ...extra] })
      }
      case 'tools/call': {
        const name = params?.name
        const args = params?.arguments ?? {}
        if (name === 'run_command') {
          const command = String(args.command ?? '')
          if (!command.trim()) return toolText(id, 'run_command needs a command.', true)
          if (command.length > MAX_COMMAND_CHARS) return toolText(id, `Command is ${command.length} characters; the limit is ${MAX_COMMAND_CHARS}.`, true)
          const wait = clampWait(env, args.wait, Number(env.SASONICA_WAIT_DEFAULT ?? 30))
          // The session id's name if it verifies, else what the User-Agent
          // says, else nothing to go on.
          const agent = (await agentFromSessionId(env, scope, request.headers.get('mcp-session-id')))
            ?? agentFromUserAgent(request) ?? 'unknown'
          const r = await enqueue(env, command, wait, args.background === true, { client, name: target.name, agent })
          return toolText(id, render(r.row, r.timedOut), !r.timedOut && FAILED.includes(r.row.status))
        }
        if (name === 'cancel') {
          const rid = Number(args.id)
          if (!Number.isInteger(rid)) return toolText(id, 'cancel needs a numeric id.', true)
          const row = await env.DB.prepare(`SELECT id, status, exit_code, output FROM commands WHERE id = ?`).bind(rid).first<Row>()
          if (!row) return toolText(id, `No command #${rid}.`, true)
          if (TERMINAL.includes(row.status)) return toolText(id, `#${rid} already finished (${row.status}); nothing to cancel.\n${render(row, false)}`)
          // Still queued: it never starts. The runner claims only 'pending'
          // rows, so flipping the status here is enough and needs no runner.
          const q = await env.DB.prepare(
            `UPDATE commands SET status = 'cancelled', exit_code = -1, output = 'sasonica: cancelled before it started', updated_at = datetime('now')
              WHERE id = ? AND status = 'pending'`,
          ).bind(rid).run()
          if (q.meta.changes === 1) return toolText(id, `#${rid} cancelled before it started.`)
          // Running: ask the runner to kill it, and wait a little for the
          // row to settle so the caller learns whether it did.
          await env.DB.prepare(`UPDATE commands SET cancel = 1, updated_at = datetime('now') WHERE id = ?`).bind(rid).run()
          const r = await awaitRow(env, rid, clampWait(env, args.wait, 15))
          if (r.row && r.row.status === 'cancelled') return toolText(id, `#${rid} cancelled: the runner killed it.\n${render(r.row, false)}`)
          if (r.row && TERMINAL.includes(r.row.status)) return toolText(id, `#${rid} finished on its own before the cancel took effect.\n${render(r.row, false)}`)
          return toolText(id, `#${rid}: cancel requested; the runner had not confirmed within the wait. Check with get_result(id=${rid}, wait=…).`)
        }
        if (name === 'detach') {
          const rid = Number(args.id)
          if (!Number.isInteger(rid)) return toolText(id, 'detach needs a numeric id.', true)
          const row = await env.DB.prepare(`SELECT id, status, exit_code, output FROM commands WHERE id = ?`).bind(rid).first<Row>()
          if (!row) return toolText(id, `No command #${rid}.`, true)
          if (TERMINAL.includes(row.status)) return toolText(id, `#${rid} already finished (${row.status}); nothing to detach.\n${render(row, false)}`)
          await env.DB.prepare(`UPDATE commands SET background = 1, updated_at = datetime('now') WHERE id = ?`).bind(rid).run()
          return toolText(
            id,
            `#${rid} detached: it keeps running, and commands queued after it no longer wait for it ` +
              `(the runner notices within a few seconds). Collect its output later with get_result(id=${rid}, wait=…).`,
          )
        }
        if (name === 'get_result') {
          const rid = Number(args.id)
          if (!Number.isInteger(rid)) return toolText(id, 'get_result needs a numeric id.', true)
          // Cece's suggestion (2026-09-17): let a check-back wait too, so one
          // call returns the moment the job finishes instead of the caller
          // polling by hand. Default 0 keeps the old immediate answer.
          const wait = clampWait(env, args.wait, 0)
          const r = await awaitRow(env, rid, wait)
          if (!r.row) return toolText(id, `No command #${rid}.`, true)
          return toolText(id, render(r.row, r.timedOut), FAILED.includes(r.row.status))
        }
        // A published tool: check the arguments against the schema the
        // runner gave us, then queue a row naming the tool rather than a
        // command. What runs is the runner's argv template; nothing here
        // can widen it.
        if (typeof name === 'string' && TOOL_NAME.test(name)) {
          const tool = await env.DB.prepare(
            `SELECT runner, name, description, input, sha256 FROM tools WHERE name = ?
              ORDER BY updated_at DESC LIMIT 1`,
          ).bind(name).first<ToolRow>()
          if (!tool) return rpcError(id, -32601, `unknown tool ${JSON.stringify(name)}`)
          if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return toolText(id, `${name}: arguments must be an object.`, true)
          }
          // `wait` means the same here as on the built-ins — how long to
          // block for the result — unless the tool declares an argument of
          // that name, in which case it is the tool's and is passed on.
          const schema = parseSchema(tool.input)
          const declaresWait = !!(schema?.properties && typeof schema.properties === 'object' && 'wait' in schema.properties)
          const callArgs: Record<string, unknown> = { ...(args as Record<string, unknown>) }
          if (!declaresWait) delete callArgs.wait
          const bad = checkArgs(schema, callArgs)
          if (bad) return toolText(id, `${name}: ${bad}.`, true)
          const command = toolCommand(name, callArgs, tool.sha256)
          if (command.length > MAX_COMMAND_CHARS) {
            return toolText(id, `${name}: the arguments are ${command.length} characters; the limit is ${MAX_COMMAND_CHARS}.`, true)
          }
          const wait = clampWait(env, args.wait, Number(env.SASONICA_WAIT_DEFAULT ?? 30))
          const agent = (await agentFromSessionId(env, scope, request.headers.get('mcp-session-id')))
            ?? agentFromUserAgent(request) ?? 'unknown'
          const r = await enqueue(env, command, wait, false, { client, name: target.name, agent }, 'tool')
          return toolText(id, render(r.row, r.timedOut), !r.timedOut && FAILED.includes(r.row.status))
        }
        return rpcError(id, -32601, `unknown tool ${JSON.stringify(name)}`)
      }
      default:
        return rpcError(id, -32601, `unknown method ${JSON.stringify(method)}`)
    }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return oauthOn(env) ? oauthFetch(request, env, ctx) : secretFetch(request, env)
  },
}
