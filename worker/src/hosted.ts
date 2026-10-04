/**
 * The hosted relay's entry point (wrangler.relay.jsonc): the router, and the
 * Durable Object class. The logic is in ./tenant.ts; this file is only what
 * needs the Workers runtime -- WebSocketPair, hibernation, the class itself.
 */

import { DurableObject } from 'cloudflare:workers'
import SCHEMA from '../../schema.sql'
import { accountAllowed, relayFetch, TenantCore, type RelayEnv, type TenantInit } from './tenant.ts'
import { JOIN_TTL_MS, JoinCore, type Creds } from './join.ts'

/** Unauthenticated sockets kept at most; past this the oldest go. */
const MAX_PENDING_SOCKETS = 4

export class Tenant extends DurableObject<RelayEnv> {
  private core: TenantCore

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env)
    this.core = new TenantCore(ctx.storage, SCHEMA, () => this.ring())
    // The runner's keepalive is answered without waking the object, so an
    // idle machine costs nothing while it hibernates.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async init(t: TenantInit) {
    return this.core.init(t)
  }

  /**
   * /runner/ws is the doorbell: the runner opens it, sends its token as the
   * first message, hears 'ready', and from then on 'ring' whenever a row is
   * queued. A browser-style WebSocket cannot set headers, hence the token
   * as a message rather than Authorization.
   */
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/runner/ws') {
      if (!this.core.load() || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('not found', { status: 404 })
      }
      const pending = this.ctx.getWebSockets().filter((ws) => !ws.deserializeAttachment()?.ok)
      for (const ws of pending.slice(0, Math.max(0, pending.length - MAX_PENDING_SOCKETS + 1))) {
        try { ws.close(1008, 'too many') } catch { /* already gone */ }
      }
      const [client, server] = Object.values(new WebSocketPair())
      this.ctx.acceptWebSocket(server)
      return new Response(null, { status: 101, webSocket: client })
    }
    return this.core.fetch(request)
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (ws.deserializeAttachment()?.ok) return
    let token = ''
    try { token = String(JSON.parse(String(message))?.token ?? '') } catch { token = '' }
    if (await this.core.runnerOk(token)) {
      ws.serializeAttachment({ ok: true })
      ws.send('ready')
    } else {
      ws.close(1008, 'no')
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code, 'closing') } catch { /* already closed */ }
  }

  private ring() {
    for (const ws of this.ctx.getWebSockets()) {
      if (!ws.deserializeAttachment()?.ok) continue
      try { ws.send('ring') } catch { /* closing; the runner reconnects */ }
    }
  }
}

/** One join (./join.ts): its state, and an alarm that wipes it unclaimed. */
export class Join extends DurableObject<RelayEnv> {
  private core: JoinCore

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env)
    this.core = new JoinCore(ctx.storage)
  }

  async start(pollSha256: string, machine: string, code: string) {
    const r = await this.core.start(pollSha256, machine, code)
    if ('ok' in r) await this.ctx.storage.setAlarm(Date.now() + JOIN_TTL_MS + 60_000)
    return r
  }
  authorizeUrl(id: string, origin: string) { return this.core.authorizeUrl(id, origin) }
  callback(code: string, origin: string, allowList: string) {
    return this.core.callback(code, origin, (account) => accountAllowed(allowList, account))
  }
  confirm(nonce: string) { return this.core.confirm(nonce) }
  deliver(creds: Creds) { this.core.deliver(creds) }
  collect(poll: string) { return this.core.collect(poll) }

  async alarm() {
    this.core.wipe()
    await this.ctx.storage.deleteAll()
  }
}

export default {
  fetch: (request: Request, env: RelayEnv) => relayFetch(request, env),
}
