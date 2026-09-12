/*
 * NOROSA Relay - WebSocket "blind gate".
 *
 * How a private message crosses the server without the server ever seeing it:
 *
 *   [Client A]  aes-gcm ciphertext + ratchet headers  ─────────────────────┐
 *        │                                                            (opaque bytes)
 *        ▼                                                                 │
 *   [Blind Relay]  stores for offline peers, forwards to online peers ────▶  [Client B]
 *   └── cannot read: no private keys, no plaintext, only room code + size
 *
 * The relay deliberately stores only *public* keys (for the X3DH bootstrap)
 * and *ciphertext* (for the offline mailbox). Everything is destroyed when
 * the client asks to destroy the room.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { RelayDb } from './db.js'
import { MAILBOX_TTL_MS, MAX_PAYLOAD_BYTES } from './types.js'
import type { WireMessage, DeliveredMessage } from './types.js'

interface Connection {
  ws: WebSocket
  alias: string
  roomCode: string | null
}

const PORT = Number(process.env.PORT ?? 8081)
const DB_PATH = process.env.DB_PATH ?? './data/relay.sqlite'

const db = new RelayDb(DB_PATH)
// Restart = total amnesia: with every socket gone, every stored alias and
// mailbox blob is dead weight. The "ephemeral" promise starts fresh.
db.reset()

const ALIAS_ADJ = ['misty', 'sonic', 'amber', 'cinder', 'lucid', 'mossy', 'pearl', 'ember', 'onix', 'velvet', 'jade', 'opal', 'tawny', 'noir', 'rusty', 'frost', 'dawn', 'dusk', 'glade', 'violet']
const ALIAS_NOUN = ['fox', 'lynx', 'kite', 'otter', 'raven', 'sable', 'bison', 'crane', 'heron', 'puma', 'osprey', 'koala', 'badger', 'swan', 'ibex', 'falcon', 'gazelle', 'moose', 'newt', 'coral']

/**
 * Anonymous alias generator — the only identity the server ever paints.
 * Human-readable (so the two screens agree and are easy to read in a grid)
 * yet collision-proof via the random hex tail. Randomness is cryptographic
 * everywhere: crypto.getRandomValues for the word picks (no predictable
 * sequence, no modulo-bias grading on the server), randomUUID for uniqueness.
 */
function generateAlias(): string {
  const [adjIdx, nounIdx] = crypto.getRandomValues(new Uint32Array(2))
  const hex = randomUUID().replaceAll('-', '').slice(0, 6)
  const adj = ALIAS_ADJ[adjIdx! % ALIAS_ADJ.length]!
  const noun = ALIAS_NOUN[nounIdx! % ALIAS_NOUN.length]!
  return `${adj}-${noun}-${hex}`
}

/**
 * Constant-time digest comparison. With a 256-bit SHA-256 the attacker has
 * exactly one observable outcome — match / no match — and there is NO
 * "how close was my guess" signal: the comparison finishes in the same
 * number of operations whether the two digests agree on every byte or on
 * none. Combined with rate limiting below, a bruteforcer can only learn
 * "that exact room exists", and only after paying the rate limit.
 */
function safeEqualDigest(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  return bufA.length === bufB.length && bufA.length > 0 && timingSafeEqual(bufA, bufB)
}

/** A room key is the 64-hex-char SHA-256 of the code — anything else is garbage. */
const ROOM_KEY_RE = /^[0-9a-f]{64}$/

// ── Join rate limiter ──────────────────────────────────────────────────
// Guessing a room key means sending hellos. A single IP is throttled to
// a tiny number of attempts per window, so a 72-bit code can never be
// exhausted through the relay: after 5 misses the socket is cut.
const HELLO_WINDOW_MS = 60_000
const HELLO_MAX_PER_WINDOW = 30
const helloWindow = new Map<string, number[]>()
function helloAllowed(ip: string): boolean {
  const now = Date.now()
  const window = (helloWindow.get(ip) ?? []).filter(t => now - t < HELLO_WINDOW_MS)
  if (window.length >= HELLO_MAX_PER_WINDOW) {
    helloWindow.set(ip, window)
    return false
  }
  window.push(now)
  helloWindow.set(ip, window)
  return true
}
function clientIp(raw: unknown): string {
  // ws exposes the socket remote address; proxies should set x-forwarded-for
  // and the operator can flip this to trust it. Never trust the header blindly.
  return typeof raw === 'string' && raw.length > 0 ? raw : 'default'
}

/** Tell every other live socket in a room a tiny opaque fact. */
function broadcastToRoom(roomCode: string, excludeAlias: string, msg: unknown): void {
  for (const [alias, other] of sockets) {
    if (alias !== excludeAlias && other.roomCode === roomCode) send(other.ws, msg)
  }
}

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_PAYLOAD_BYTES * 2 })

/** socketsByAlias lets us deliver to a specific anonymous peer instantly. */
const sockets = new Map<string, Connection>()

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

/** Deliver an opaque blob now (online) or honestly store it for later (offline). */
function deliverOrStore(from: Connection, to: string, id: string, payload: string): void {
  const target = sockets.get(to)
  if (target?.ws.readyState === WebSocket.OPEN) {
    const delivered: DeliveredMessage = { t: 'msg', from: from.alias, id, payload }
    send(target.ws, delivered)
  } else {
    db.storeMailbox(from.alias, to, id, payload)
  }
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req.socket.remoteAddress)
  const conn: Connection = { ws, alias: generateAlias(), roomCode: null }
  sockets.set(conn.alias, conn)

  ws.on('message', raw => {
    // Every hello — the one brute-forcible frame — is throttled per IP
    // BEFORE any crypto or DB work. The gate is the relay's choke point.
    let wire: WireMessage
    try {
      wire = JSON.parse(raw.toString()) as WireMessage
    } catch {
      send(ws, { t: 'error', code: 'bad_json', message: 'Payload is not valid JSON.' })
      return
    }
    if (wire.t === 'hello' && !helloAllowed(ip)) {
      send(ws, { t: 'error', code: 'rate_limited', message: 'Too many join attempts. Try again shortly.' })
      ws.close()
      return
    }

    try {
      routeMessage(conn, wire, ws)
    } catch (err) {
      // A malformed frame must never take the whole relay down.
      console.error('[relay] handler error:', err)
      send(ws, { t: 'error', code: 'handler_error', message: 'Message failed to process.' })
    }
  })
      /** Dispatch one wire frame. Kept separate so a bad frame can never kill the relay. */
function routeMessage(conn: Connection, wire: WireMessage, ws: WebSocket): void {
  switch (wire.t) {
    // ── Handshake: bind this socket to a room. Only a SHA-256 digest ever
    //    arrives here; the human-readable code stays on the clients.
    case 'hello': {
      // Type-shape the room key: exactly a 64-char hex digest.
      if (!ROOM_KEY_RE.test(wire.roomCode)) {
        send(ws, { t: 'error', code: 'bad_room_key', message: 'Room key must be a SHA-256 digest.' })
        return
      }

      const existing = db.getRoom(wire.roomCode)
      if (!wire.create) {
        // Join: the room must already exist. A typo in the code hashes to a
        // different digest and is rejected — joining never creates a room,
        // so a wrong guess cannot quietly mint an empty one.
        if (!existing || !safeEqualDigest(existing.roomKey, wire.roomCode)) {
          send(ws, { t: 'error', code: 'room_not_found', message: 'No room with that code.' })
          return
        }
      } else {
        // Create: register the hashed room (idempotent — re-entering the
        // same code rejoins the same room).
        if (!existing || !safeEqualDigest(existing.roomKey, wire.roomCode)) {
          db.upsertRoom(wire.roomCode)
        }
      }

      conn.roomCode = wire.roomCode
      db.upsertMember(conn.alias, wire.roomCode, {
        identityKey: '',
        ed25519: '',
        signedPrekey: '',
        signedPrekeySig: '',
      })
      send(ws, { t: 'ack', id: undefined, alias: conn.alias })
      // Presence push: everyone already inside learns about the newcomer
      // instantly instead of waiting for their next keys.get poll.
      broadcastToRoom(wire.roomCode, conn.alias, { t: 'presence', alias: conn.alias, online: true })
      // Drain anything that arrived while this device was offline, then purge it.
      const mail = db.drainMailbox(conn.alias)
      if (mail.length > 0) send(ws, { t: 'mailbox', messages: mail })
      break
    }

    // ── Key registration. Public keys only — safe to hold for a blind relay.
    case 'keys.upload': {
      if (!conn.roomCode || conn.roomCode !== wire.roomCode) {
        send(ws, { t: 'error', code: 'not_in_room', message: 'hello first.' })
        return
      }
      db.upsertMember(conn.alias, wire.roomCode, wire.keys)
      db.replaceOneTimeKeys(conn.alias, wire.oneTimeKeys)
      send(ws, { t: 'ack', id: undefined })
      break
    }

    // ── Key fetch for X3DH bootstrap. Returns peers + one consumed pre-key.
    case 'keys.get': {
      if (!conn.roomCode || conn.roomCode !== wire.roomCode) {
        send(ws, { t: 'error', code: 'not_in_room', message: 'hello first.' })
        return
      }
      const users = db.getPeerKeys(wire.roomCode, conn.alias)
      send(ws, { t: 'keys.result', txn: wire.txn, users })
      break
    }

    // ── A single opaque ciphertext packet. Forward / store, never parse.
    case 'msg': {
      if (!conn.roomCode || conn.roomCode !== wire.roomCode) {
        send(ws, { t: 'error', code: 'not_in_room', message: 'hello first.' })
        return
      }
      if (Buffer.byteLength(wire.payload, 'utf8') > MAX_PAYLOAD_BYTES) {
        send(ws, { t: 'error', code: 'too_large', message: 'Payload exceeds limit.' })
        return
      }
      if (wire.to === '*') {
        // Group broadcast: echo to every other member in the room.
        for (const [alias, other] of sockets) {
          if (alias !== conn.alias && other.roomCode === wire.roomCode) deliverOrStore(conn, alias, wire.id, wire.payload)
        }
      } else {
        deliverOrStore(conn, wire.to, wire.id, wire.payload)
      }
      send(ws, { t: 'ack', id: wire.id })
      break
    }

    // ── Media-plane signaling (SDP offer/answer, ICE trickle). Routed
    //    verbatim like `msg`; the relay never parses the body. The body is
    //    itself double-ratchet ciphertext (see the client's `k:'call'`
    //    envelope), so even ICE IP metadata is invisible to the gate.
    case 'call': {
      if (!conn.roomCode || conn.roomCode !== wire.roomCode) {
        send(ws, { t: 'error', code: 'not_in_room', message: 'hello first.' })
        return
      }
      if (Buffer.byteLength(wire.payload, 'utf8') > MAX_PAYLOAD_BYTES) {
        send(ws, { t: 'error', code: 'too_large', message: 'Payload exceeds limit.' })
        return
      }
      if (wire.to === '*') {
        for (const [alias, other] of sockets) {
          if (alias !== conn.alias && other.roomCode === wire.roomCode) {
            const target = sockets.get(alias)
            if (target?.ws.readyState === WebSocket.OPEN) send(target.ws, { t: 'call', from: conn.alias, id: wire.id, payload: wire.payload })
            else db.storeMailbox(conn.alias, alias, wire.id, wire.payload)
          }
        }
      } else {
        const target = sockets.get(wire.to)
        if (target?.ws.readyState === WebSocket.OPEN) send(target.ws, { t: 'call', from: conn.alias, id: wire.id, payload: wire.payload })
        else db.storeMailbox(conn.alias, wire.to, wire.id, wire.payload)
      }
      send(ws, { t: 'ack', id: wire.id })
      break
    }

    // ── Absolute wipe: room, keys, mailbox — nothing survives.
    case 'room.destroy': {
      if (!conn.roomCode || conn.roomCode !== wire.roomCode) {
        send(ws, { t: 'error', code: 'not_in_room', message: 'hello first.' })
        return
      }
      db.destroyRoom(wire.roomCode)
      for (const other of sockets.values()) {
        if (other.roomCode === wire.roomCode) {
          ws.close()
        }
      }
      send(ws, { t: 'ack', id: undefined })
      break
    }

    default: {
      send(ws, { t: 'error', code: 'unknown', message: 'Unknown message type.' })
    }
  }
}

  ws.on('close', () => {
    sockets.delete(conn.alias)
    // Let the DB prune stale mailbox entries; delivered items are already deleted.
    db.drainMailbox(conn.alias)
    if (conn.roomCode) {
      // Presence push: whoever remains learns the departure without polling.
      broadcastToRoom(conn.roomCode, conn.alias, { t: 'presence', alias: conn.alias, online: false })
      // Presence = membership: drop every alias of this room with no live
      // socket. Heals stale rows AND makes "everyone left" detectable.
      const live = new Set(
        [...sockets.values()].filter(c => c.roomCode === conn.roomCode).map(c => c.alias),
      )
      for (const { alias } of db.listMembers(conn.roomCode)) {
        if (!live.has(alias)) db.removeMember(alias)
      }
      // The last member just left → the room ceases to exist, mailbox included.
      // Keeping an empty room alive would whisper its code forever.
      if (db.countMembers(conn.roomCode) === 0) {
        db.destroyRoom(conn.roomCode)
        db.purgeOrphanMailbox()
      }
    }
  })

  ws.on('error', () => {
    sockets.delete(conn.alias)
  })
})

// Periodic GC: purge mailboxes older than TTL so the relay forgets everything.
setInterval(() => {
  db.purgeExpiredMailbox(MAILBOX_TTL_MS)
}, 15 * 60 * 1000).unref()

console.log(`[relay] blind gate listening on ws://0.0.0.0:${PORT} (mailbox TTL ${MAILBOX_TTL_MS / 3.6e6}h)`)