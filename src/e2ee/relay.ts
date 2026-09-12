import type { OneTimePrekey, PublicKeyBundle, WireCall, WireIn, WireKeysResult, WireMsg, WireOut, WireUpload } from './types'

/**
 * RelayLink — WebSocket transport to the NOROSA blind gate.
 *
 * Responsibilities:
 *   • WebSocket lifecycle (reconnect with backoff)
 *   • Room handshake (hello → receive our anonymous alias)
 *   • Request/response correlation for `keys.get`
 *   • Fire-and-forget ciphertext delivery with server acks
 *   • Replaying the offline mailbox that the relay kept for us
 *
 * Nothing here ever inspects `payload` — that is ciphertext, and it stays
 * opaque to the transport, exactly as the relay expects.
 */

export class RelayLink {
  private ws: WebSocket | null = null
  private readonly url: string
  readonly roomCode: string
  private readonly createRoom: boolean
  alias: string | null = null

  private connected = false
  private pendingTxn = new Map<string, (res: WireKeysResult) => void>()
  private queues: (WireMsg | WireCall | WireUpload)[] = []
  private onIncoming: (from: string, payload: string) => void = () => {}
  private onCallIncoming: (from: string, payload: string) => void = () => {}
  private onPresenceChange: (alias: string, online: boolean) => void = () => {}
  private onStateChange: (open: boolean) => void = () => {}
  private reconnectDelay = 300
  private stopped = false
  /** Pending handshake promise — resolved by our alias ack, rejected by a refused hello. */
  private helloWait: { resolve: () => void; reject: (e: Error) => void } | null = null
  /** Cache of the last keys.get result. The chat grid and the media reconcile
   *  poll keys.get every few seconds; every poll used to hit the relay and made
   *  the server consume one-time pre-keys (see server otk_grants). Serving
   *  repeat polls from this 60s cache keeps the pool intact and cuts chatter.
   *  Session-establishing callers (initiateSession / identityOf) pass
   *  fresh=true to bypass it, and ANY presence change invalidates it so a
   *  newcomer/leaver is never hidden for the whole window. */
  private keysCache: { ts: number; users: WireKeysResult['users'] } | null = null

  constructor(url: string, roomCode: string, createRoom = true) {
    this.url = url
    this.roomCode = roomCode
    this.createRoom = createRoom
  }

  connect(): void {
    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      this.connected = true
      this.reconnectDelay = 300
      this.onStateChange(true)
      // 1. Blind handshake — only the SHA-256 of the code ever leaves us.
      this.ws!.send(JSON.stringify({ t: 'hello', roomCode: this.roomCode, create: this.createRoom }))
      // 2. Flush anything queued while the socket was still connecting.
      for (const m of this.queues) this.ws!.send(JSON.stringify(m))
      this.queues = []
    }

    this.ws.onmessage = ev => {
      let wire: WireIn
      try {
        wire = JSON.parse(ev.data as string) as WireIn
      } catch {
        return
      }
      this.handle(wire)
    }

    this.ws.onclose = () => {
      this.connected = false
      this.onStateChange(false)
      if (!this.stopped) {
        setTimeout(() => this.connect(), this.reconnectDelay)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000)
      }
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  private handle(wire: WireIn): void {
    switch (wire.t) {
      case 'ack': {
        // The relay paints a FRESH moniker on EVERY connection. Adopting the
        // latest alias on every ack is mandatory: keeping the first one makes
        // amOfferer() and the persisted media-key cells disagree between the
        // two sides after any reconnect (glare / half-open calls, keys that a
        // reload cannot reuse). We address peers by THEIR alias; ours is only
        // ever compared, so it must track what the server actually called us.
        if (wire.alias) {
          this.alias = wire.alias
        }
        // Alias ack ⇒ the room handshake succeeded (create or genuine join).
        if (this.helloWait) {
          const w = this.helloWait
          this.helloWait = null
          w.resolve()
        }
        break
      }
      case 'keys.result': {
        const resolve = this.pendingTxn.get(wire.txn)
        if (resolve) {
          this.pendingTxn.delete(wire.txn)
          resolve(wire)
        }
        break
      }
      case 'msg': {
        this.onIncoming(wire.from, wire.payload)
        break
      }
      case 'call': {
        this.onCallIncoming(wire.from, wire.payload)
        break
      }
      case 'presence': {
        // Membership changed — a cached keys.result no longer reflects the
        // room, and a reconnecting device carries a brand-new alias. Drop it
        // so the next poll sees the newcomer / stops showing the leaver.
        this.keysCache = null
        this.onPresenceChange(wire.alias, wire.online)
        break
      }
      case 'mailbox': {
        for (const m of wire.messages) this.onIncoming(m.from, m.payload)
        break
      }
      case 'error': {
        // A hello refusal is FATAL for the handshake: a join to a room that
        // does not exist (typo'd / random code), a rate-limited attempt, or a
        // malformed room key can never succeed — not now, not after a
        // reconnect. Surface it so the caller rejects the join instead of
        // silently dumping the user into a ghost room.
        if (this.helloWait) {
          const w = this.helloWait
          this.helloWait = null
          w.reject(new Error(`${wire.code}: ${wire.message}`))
          if (wire.code === 'room_not_found' || wire.code === 'rate_limited' || wire.code === 'bad_room_key') {
            this.stopped = true // a refused hello will be refused forever
            this.ws?.close()
          }
          break
        }
        console.warn('[relay] server error:', wire.code, wire.message)
        break
      }
    }
  }

private send(out: WireOut): void {
    const raw = JSON.stringify(out)
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(raw)
    // Key uploads and ciphertext must never be dropped just because the socket
    // is still connecting — queue them and flush after the hello handshake.
    else if (out.t === 'msg' || out.t === 'keys.upload' || out.t === 'call') this.queues.push(out)
  }

  onMessage(cb: (from: string, payload: string) => void): void {
    this.onIncoming = cb
  }

  /** Media-plane signaling frames (SDP / ICE), never parsed by the transport. */
  onCall(cb: (from: string, payload: string) => void): void {
    this.onCallIncoming = cb
  }

  /** Someone joined/left this room — instant grid updates without polling. */
  onPresence(cb: (alias: string, online: boolean) => void): void {
    this.onPresenceChange = cb
  }

  onState(cb: (open: boolean) => void): void {
    this.onStateChange = cb
  }

  /** Upload our public key bundle once the alias has been assigned. */
  uploadKeys(keys: PublicKeyBundle, oneTimeKeys: OneTimePrekey[]): void {
    this.send({ t: 'keys.upload', roomCode: this.roomCode, keys, oneTimeKeys })
  }

  /** Fetch every other member's bundle + their freshly consumed pre-key.
   *  Cached for 60s; pass `fresh=true` to force a round-trip (only needed when
   *  establishing a session or resolving an identity for a brand-new alias). */
  async getPeerKeys(fresh = false): Promise<WireKeysResult['users']> {
    const now = Date.now()
    if (!fresh && this.keysCache && now - this.keysCache.ts < 60_000) return this.keysCache.users
    const txn = crypto.randomUUID()
    const users = await new Promise<WireKeysResult['users']>((resolve, reject) => {
      this.pendingTxn.set(txn, res => resolve(res.users))
      this.send({ t: 'keys.get', roomCode: this.roomCode, txn })
      setTimeout(() => {
        if (this.pendingTxn.has(txn)) {
          this.pendingTxn.delete(txn)
          reject(new Error('keys.get timed out'))
        }
      }, 10_000)
    })
    this.keysCache = { ts: Date.now(), users }
    return users
  }

  /** Deliver an opaque ciphertext blob directly to one peer, or broadcast '*'. */
  sendPayload(to: string, payload: string): void {
    this.send({ t: 'msg', roomCode: this.roomCode, to, id: crypto.randomUUID(), payload })
  }

  /** Deliver an opaque call-signaling blob (SDP/ICE) to one peer. */
  sendCall(to: string, payload: string): void {
    this.send({ t: 'call', roomCode: this.roomCode, to, id: crypto.randomUUID(), payload })
  }

  /** Ask the relay to forget the entire room. */
  destroyRoom(): void {
    this.send({ t: 'room.destroy', roomCode: this.roomCode })
  }

  /**
   * Await the room handshake outcome. Resolves once the relay has accepted
   * us (alias assigned). Rejects when the hello is refused — e.g. joining a
   * room that does not exist, in which case the socket is shut down so the
   * user is never led into an empty ghost room. Call right after connect().
   */
  hello(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.helloWait = { resolve, reject }
      // A live relay answers within a second. Never let a dead socket hold
      // the join screen hostage.
      setTimeout(() => {
        if (this.helloWait) {
          const w = this.helloWait
          this.helloWait = null
          w.reject(new Error('The relay did not answer the join request.'))
        }
      }, 8_000)
    })
  }

  close(): void {
    this.stopped = true
    this.ws?.close()
  }
}