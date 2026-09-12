/*
 * olm.js is Emscripten glue with an unusual CJS shape. On import it does:
 *
 *   module.exports = <emscripten factory>   (line ~119)
 *   window.Olm     = <wrapper object>       (line ~152)
 *   module.exports = <wrapper object>       (line ~159)
 *
 * The wrapper object initially holds ONLY `init` — the classes (Account,
 * Session, ...) are attached INSIDE the emscripten factory body that init()
 * invokes, so they exist only AFTER Olm.init() resolves. Confirmed:
 *
 *   > node -e "console.log(Object.keys(require('@matrix-org/olm')))"
 *   [ 'init' ]
 *
 * Bundlers that snapshot namespace exports at import time (the Rolldown/
 * Vite build) therefore fail with `Olm.Account is not a constructor` even
 * though init() resolved fine. olm.js explicitly documents `window.Olm` for
 * exactly this case, so we read the LIVE object off the window after awaiting
 * init. The side-effect import keeps the module (and its `window.Olm`
 * assignment) in the dependency graph.
 */
import '@matrix-org/olm'
/** Type-only: namespace types (Account, Session, ...) from the package d.ts. Erased at build. */
import type * as Olm from '@matrix-org/olm'
import { pad, unpad } from './padding'
import { b64Decode, b64Encode } from './encoding'
import { ACCOUNT_KEY, IdbStore, inboundGroupKeyOf, mediaKeyKeyOf, outboundGroupKeyOf, sessionKeyOf } from './idb'
import { safetyNumber } from './safetynum'
import { RelayLink } from './relay'
import type { OneTimePrekey, PublicKeyBundle } from './types'

/**
 * Where the browser fetches the Olm WebAssembly binary from.
 *
 * The wasm is copied verbatim from `node_modules/@matrix-org/olm/olm.wasm`
 * to `public/olm.wasm` (dist root). A FIXED path — instead of a hashed
 * `/assets/olm-*.wasm` bundle — is deliberate: static hosts and the Figma
 * Make preview apply SPA fallbacks that answer unknown asset routes with
 * `index.html` (hence the classic `expected magic word 00 61 73 6d, found
 * <!do` failure). A root-level asset we know exists on the origin always
 * returns real binary bytes. `import.meta.env.BASE_URL` keeps the path
 * correct when the app is served from a sub-path (FIGMA_PUBLIC_URL).
 */
const OLM_WASM_URL = `${import.meta.env.BASE_URL}olm.wasm`

/*
 * The @matrix-org/olm glue is old Emscripten output that reads AND writes a
 * bare global named `OLM_OPTIONS` (it is never declared with `var` anywhere
 * in olm.js):
 *
 *   olm_exports['init'] = function (opts) { if (opts) OLM_OPTIONS = opts; ... }
 *
 * Inside a strict-mode ES module (how Vite executes it) writing to a bare
 * identifier with no resolvable binding throws:
 *   ReferenceError: OLM_OPTIONS is not defined
 *
 * Fix (the same one Element Call ships): seed a resolvable global property
 * before init. Module code falls back to the global object record, so the
 * strict assignment then lands on `window.OLM_OPTIONS`.
 * See https://gitlab.matrix.org/matrix-org/olm/-/issues/10
 */
type OlmGlobalOptions = { locateFile?: () => string }

declare global {
  interface Window {
    OLM_OPTIONS?: OlmGlobalOptions
    /**
     * The LIVE Olm module object, populated by olm.js when it is evaluated.
     * Its classes only exist after `await Olm.init(...)` resolves (see the
     * import comment above). Typed via `typeof import(...)` — a pure type
     * query (no runtime import), so nothing gets bundled from it.
     */
    Olm: typeof import('@matrix-org/olm')
  }
}

/**
 * NOROSA E2E Encryption Service.
 *
 * Pipeline for a private 1:1 message:
 *
 *   plaintext text
 *     │ pad()                                   (metadata protection: fixed buckets)
 *     ▼
 *   padded blob (b64)
 *     │ session.encrypt()                       (Olm double ratchet / X3DH)
 *     ▼
 *   { olmType, body }  ──→ envelope ──→ RelayLink.sendPayload()
 *                                     ──→ blind relay (opaque) ──→ peer
 *
 * Pipeline for a group message (Megolm):
 *
 *   plaintext → pad → outbound_group.encrypt() → envelope{k:'group'}
 *   outbound_group.session_key() ─ encrypted per-member via 1:1 Olm
 *     → envelope{k:'key-share'} → peer bootstraps an InboundGroupSession
 */

type EnvelopeKind = 'direct' | 'group' | 'key-share' | 'media-key' | 'call'

/** A single encrypted frame travelling over the wire. */
interface Envelope {
  /** Purpose: direct 1:1 cipher, Megolm group cipher, or an out-of-band group key share. */
  k: EnvelopeKind
  /** Direct: target peer alias. Group / key-share: Megolm session id. */
  o: string
  /** Olm message type (0 = pre-key establishing the ratchet, 1 = normal). */
  i: number
  /** Opaque ciphertext body (base64). */
  b: string
}

export interface DecryptedMessage {
  from: string
  text: string
  groupId?: string
}

/** Derived fingerprint of a text (see safetynum.ts) with its TOFU verdict. */
export interface SafetyStatus {
  /** "60365 29653 …" — matches the peer's screen iff both hold genuine keys. */
  number: string
  /** True when this identity's digits differ from the first time we met it. */
  changed: boolean
}

const ONE_TIME_POOL_SIZE = 20
const ONE_TIME_LOW_WATER = 8

/**
 * IdbStore key prefix for committed ("first-seen") safety numbers. Keyed by
 * the peer's IDENTITY key — the stable anchor that survives reconnects —
 * never by the ephemeral per-connection alias. Purged by resetVault() like
 * everything else on this device.
 */
const SAFETY_PREFIX = 'safety:'

function bytesToBase64(bytes: Uint8Array): string { return b64Encode(bytes) }
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> { return b64Decode(b64) }

/** If the offerer runs out of redelivery attempts the promise MUST reject
 *  (not vanish), so prepareMedia's error path closes the pair and reconcile
 *  re-dials instead of leaving it dead forever. */
const MEDIA_KEY_NOT_DELIVERED = 'The peer never received the media key (no ACK).'
const MEDIA_KEY_NOT_SHIPPED = 'The peer never delivered the media key.'

export class E2eEncryptionService {
private constructor(
    /** Session-scoped key that unlocks every Olm pickle (see vault.ts). */
    private readonly pickleKey: string,
    private readonly storage: typeof IdbStore,
    private readonly relay: RelayLink,
    private account: Olm.Account = new window.Olm.Account(),
    private sessionsOut = new Map<string, Olm.Session>(),
    private sessionsIn = new Map<string, Olm.Session[]>(),
    private identityByPeer = new Map<string, { identityKey: string; signedPrekey: string }>(),
    private outGroups = new Map<string, Olm.OutboundGroupSession>(),
    private inGroups = new Map<string, Olm.InboundGroupSession>(),
    private groupMembers = new Map<string, string[]>(),
    private mediaKeys = new Map<string, Promise<Uint8Array>>(),
    private pendingMediaKeys = new Map<string, (key: Uint8Array) => void>(),
    private presenceListeners = new Set<(alias: string, online: boolean) => void>(),
  ) {}

  /** Aliases live right now (presence pushes we have seen this connection). */
  private onlineAliases = new Set<string>()

  /** Offerer-side key deliveries awaiting a peer ACK (see mediaKeyFor). */
  private awaitingMediaKeyAck = new Map<string, () => void>()

  /** Aliases confirmed online via presence. The media/UI layer unions this
   *  with listPeers() so a real peer is never hidden by the stale-identity
   *  filter inside listPeers (which exists to drop OUR OWN ghost aliases
   *  after a reconnect, but must not erase an actually-present party). */
  listOnlinePeers(): string[] {
    return [...this.onlineAliases]
  }

  /** A second page of THIS browser is online in the room. Aliases are per-socket
   *  (different hex tail each time), so we compare IDENTITY keys — the stable
   *  device anchor — not the alias. Two sockets sharing our identityKey mean
   *  the same person twice: the protocol can't tell them apart, ratchpets and
   *  media keys clobber in shared IndexedDB, and media between them is black. */
  sameDeviceDuplicateOpen(): boolean {
    let myIdentity = ''
    try {
      myIdentity = (JSON.parse(this.account.identity_keys()) as { curve25519: string }).curve25519
    } catch {
      return false
    }
    // Only a LIVE socket of our own device counts. After a reconnect the old
    // alias lingers in identityByPeer with OUR key — that is a ghost, not a
    // second participant, and must never raise this banner.
    for (const [alias, { identityKey }] of this.identityByPeer) {
      if (identityKey !== myIdentity) continue
      if (this.onlineAliases.has(alias)) return true
    }
    return false
  }

  /** Boot the service: init WASM, restore-or-create our identity, then upload keys. */
  static async create(relayUrl: string, roomCode: string, pickleKey: string, createRoom = true): Promise<E2eEncryptionService> {
    // Seed the OLM_OPTIONS host global, then let init() reuse+override it
    // with our options. Without the global the strict-mode write throws.
if (typeof window !== 'undefined') window.OLM_OPTIONS = {}
    await window.Olm.init({ locateFile: () => OLM_WASM_URL })

const relay = new RelayLink(relayUrl, roomCode, createRoom)
    const svc = new E2eEncryptionService(pickleKey, IdbStore, relay)

    // 1. Restore the long-term identity from IndexedDB, or create it once.
    const pickled = await IdbStore.get<string>(ACCOUNT_KEY)
    if (pickled) {
const acc = new window.Olm.Account()
      try {
        acc.unpickle(pickleKey, pickled)
        svc.account = acc
      } catch {
        // Pickled before the device vault existed (legacy constant key, or a
        // foreign keystore). Never fails hard — mint a fresh identity instead
        // and let restoreState() sweep the stale pickles below.
        console.warn('[norosa] Existing keystore belongs to an older pickle key — starting fresh.')
        await IdbStore.delete(ACCOUNT_KEY)
        const fresh = new window.Olm.Account()
        fresh.create()
        svc.account = fresh
      }
    } else {
      const acc = new window.Olm.Account()
      acc.create()
      svc.account = acc
    }

    // 1b. Restore ratchet + Megolm state so previous sessions survive reloads.
    await svc.restoreState()

// 2. Send messages straight off the wire into decryptMessage().
    relay.onMessage((from, payload) => {
      void svc.handleIncoming(from, payload)
    })

    // Presence is needed by BOTH the chat/grid layer (rooms.ts presence
    // bookkeeping) and the media layer (who to dial when they join). Relay
    // slots a single callback, so fan out here to every subscriber.
    relay.onPresence((alias, online) => {
      if (online) svc.onlineAliases.add(alias)
      else {
        svc.onlineAliases.delete(alias)
        // A departed alias that carried OUR identity is a ghost of a past
        // socket of this device — drop it so it can never trip the
        // same-device banner or the stale-identity filter.
        const entry = svc.identityByPeer.get(alias)
        if (entry) {
          try {
            const mine = (JSON.parse(svc.account.identity_keys()) as { curve25519: string }).curve25519
            if (entry.identityKey === mine) svc.identityByPeer.delete(alias)
          } catch { /* identity not readable yet */ }
        }
      }
      for (const cb of svc.presenceListeners) cb(alias, online)
    })

    relay.connect()
    // 3. The join can be REFUSED (typo'd or random code → the room's hash
    // does not exist on the relay). Surface that as a boot failure instead
    // of mounting an empty ghost room: a join must never fake a room. On
    // refusal the transport is shut down so no zombie socket keeps dialing.
    try {
      await relay.hello()
    } catch (err) {
      relay.close()
      throw err
    }
    return svc
  }

  get roomCode(): string {
    return this.relay.roomCode
  }

  /** The anonymous alias the relay painted for THIS connection. */
  get selfAlias(): string | null {
    return this.relay.alias
  }

  /**
   * Aliases of every other device currently holding keys in this room —
   * excluding our own. Bootstrap both legs of the X3DH ratchet with these.
   */
async listPeers(): Promise<string[]> {
    // Cached by relay.ts (60s) — this is the hot polling path (grid + media
    // reconcile); a round trip per poll is exactly what drained the OTK pool.
    const users = await this.relay.getPeerKeys()
    const me = this.identityKey
    const others: string[] = []
    for (const [alias, bundle] of Object.entries(users)) {
      if (alias === this.relay.alias) continue
      // Drop stale aliases from earlier connections that share our identity key.
      if (bundle.keys.identityKey === me) continue
      others.push(alias)
    }
    return others
  }

private get identityKey(): string {
    return (JSON.parse(this.account.identity_keys()) as { curve25519: string }).curve25519
  }

  private async identityOf(peerAlias: string): Promise<string> {
    const cached = this.identityByPeer.get(peerAlias)?.identityKey
    if (cached) return cached
    // fresh=true: an unknown / freshly-reconnected alias must resolve against
    // the CURRENT room state, not a 60s snapshot that may predate it.
    const users = await this.relay.getPeerKeys(true)
    const bundle = users[peerAlias]
    if (!bundle?.keys.identityKey) throw new Error('Peer identity is not available yet.')
    this.identityByPeer.set(peerAlias, { identityKey: bundle.keys.identityKey, signedPrekey: bundle.keys.signedPrekey })
    return bundle.keys.identityKey
  }

  /**
   * Safety fingerprint for ONE peer, committed on first contact (TOFU).
   *
   * The digits are symmetric and deterministic (see safetynum.ts): both
   * screens render the same number iff each side holds the other's genuine
   * public identity. What makes it a *security* feature is the commitment:
   * the first time a given identity key is ever seen, its digits are written
   * to IndexedDB; every later encounter is compared against that record. A
   * mismatch means the person claiming this identity now is NOT the one who
   * introduced it originally — surfaced as `changed`, never silently swapped.
   *
   * Keyed by the peer's identity key, so a reconnecting device (fresh alias,
   * same key) reports `changed: false` — no false alarms on relinks.
   */
  async safetyStatusFor(peerAlias: string): Promise<SafetyStatus> {
    const peerIdentity = await this.identityOf(peerAlias)

    const number = await safetyNumber(this.identityKey, peerIdentity)
    const key = SAFETY_PREFIX + peerIdentity
    const firstSeen = await this.storage.get<string>(key)
    if (!firstSeen) {
      await this.storage.set(key, number)
      return { number, changed: false }
    }
return { number, changed: firstSeen !== number }
  }

  // ── a) First-time key generation & upload ──────────────────────────
  /**
   * Generate the X3DH material and publish *public* halves to the relay.
   * The account (with all private keys) is pickled into IndexedDB and never
   * leaves the device. The signature on the signed pre-key is produced by
   * our Ed25519 identity key so peers can authenticate it.
   */
async generateAndUploadKeys(): Promise<void> {
    this.account.generate_one_time_keys(ONE_TIME_POOL_SIZE)

    // The signed pre-key is NOT reported under one_time_keys() — empirically
    // that JSON only ever contains `curve25519`, even after a fallback key is
    // generated. libolm exposes the signed pre-key via fallback_key(), which
    // this build returns as {"curve25519":{"<id>":"<key>"}}. Generate one on
    // demand (fresh account); restored accounts carry theirs inside the pickle.
    let signedPrekey = this.readSignedPrekey()
    if (!signedPrekey) {
      this.account.generate_fallback_key()
      signedPrekey = this.readSignedPrekey()
    }
    if (!signedPrekey) throw new Error('Olm did not generate a signed pre-key.')

    const pool = JSON.parse(this.account.one_time_keys()) as { curve25519?: Record<string, string> }
    const ids = JSON.parse(this.account.identity_keys()) as { curve25519: string; ed25519: string }
    const oneTimeKeys: OneTimePrekey[] = (Object.entries(pool.curve25519 ?? {}) as [string, string][]).map(([keyId, key]) => ({ keyId, key }))

    const bundle: PublicKeyBundle = {
      identityKey: ids.curve25519,
      ed25519: ids.ed25519,
      signedPrekey,
      signedPrekeySig: this.account.sign(signedPrekey),
    }

this.relay.uploadKeys(bundle, oneTimeKeys)
    // One-time pre-keys are single-use: once the server has taken them, stop
    // advertising them so the pool/platform counts stay accurate.
    this.account.mark_keys_as_published()
    await this.persistAccount()

// Track the signed pre-key so we (and peers) know it is current.
    this.identityByPeer.set(this.relay.alias ?? 'self', { identityKey: ids.curve25519, signedPrekey })
  }

  /**
   * Read the current signed pre-key off the account. libolm 3.2.x exposes it
   * via fallback_key(), which returns {"curve25519":{"<id>":"<key>"}} (the
   * same shape as ONE-TIME keys — NOT part of one_time_keys() itself).
   */
  private readSignedPrekey(): string {
    const raw = this.account.fallback_key()
    if (!raw) return ''
    const parsed = JSON.parse(raw) as { curve25519?: string | Record<string, string> }
    if (typeof parsed.curve25519 === 'object' && parsed.curve25519) {
      return Object.values(parsed.curve25519)[0] ?? ''
    }
    return typeof parsed.curve25519 === 'string' ? parsed.curve25519 : ''
  }

  private async topUpPrekeys(): Promise<void> {
    const pool = JSON.parse(this.account.one_time_keys()) as { curve25519?: Record<string, string> }
    const remaining = Object.keys(pool.curve25519 ?? {}).length
    if (remaining < ONE_TIME_LOW_WATER) {
      this.account.generate_one_time_keys(ONE_TIME_POOL_SIZE)
      const fresh = JSON.parse(this.account.one_time_keys()) as { curve25519?: Record<string, string> }
      const oneTimeKeys = (Object.entries(fresh.curve25519 ?? {}) as [string, string][]).map(([keyId, key]) => ({ keyId, key }))
      this.relay.uploadKeys(this.currentPublicBundle(), oneTimeKeys)
      await this.persistAccount()
    }
  }

private currentPublicBundle(): PublicKeyBundle {
    const ids = JSON.parse(this.account.identity_keys()) as { curve25519: string; ed25519: string }
    const signedPrekey = this.readSignedPrekey() || this.identityByPeer.get(this.relay.alias ?? 'self')?.signedPrekey || ''
    return {
      identityKey: ids.curve25519,
      ed25519: ids.ed25519,
      signedPrekey,
      signedPrekeySig: this.account.sign(signedPrekey),
    }
  }

  // ── b) Initiate a 1:1 double-ratchet session ──────────────────────
  /**
   * X3DH bootstrap: fetch the peer's bundle, authenticate the signed pre-key
   * against their Ed25519 identity, then build the outbound Olm session.
   */
async initiateSession(peerAlias: string): Promise<void> {
    if (peerAlias === this.relay.alias) throw new Error('Cannot start a session with yourself.')

    // fresh=true: a session bootstrap must see the CURRENT state — a cached
    // snapshot may still list a departed alias or miss a newcomer.
    const peers = await this.relay.getPeerKeys(true)
    const bundle = peers[peerAlias]
    if (!bundle) throw new Error(`Peer '${peerAlias}' has not registered keys.`)

    // Authenticate: the signed pre-key must carry our own signed identity's sig.
    const util = new window.Olm.Utility()
    try {
      util.ed25519_verify(bundle.keys.ed25519, bundle.keys.signedPrekey, bundle.keys.signedPrekeySig)
    } catch {
      throw new Error(`Peer '${peerAlias}' presented a tampered key bundle — session refused.`)
    } finally {
      util.free()
    }

    const session = new window.Olm.Session()
    session.create_outbound(this.account, bundle.keys.identityKey, bundle.keys.signedPrekey)

    this.sessionsOut.set(peerAlias, session)
    this.identityByPeer.set(peerAlias, { identityKey: bundle.keys.identityKey, signedPrekey: bundle.keys.signedPrekey })
    await this.topUpPrekeys()
    await this.persistSessions()
  }

  // ── c) 1:1 encryption / decryption ────────────────────────────────
  async encryptMessage(peerAlias: string, text: string): Promise<void> {
    if (!this.sessionsOut.has(peerAlias)) await this.initiateSession(peerAlias)
    const session = this.sessionsOut.get(peerAlias)!
    const envelope: Envelope = { k: 'direct', o: peerAlias, i: 0, b: '' }

    // Encrypt the *padded* plaintext (metadata protection on the wire).
    const padded = pad(text)
    const cipher = session.encrypt(padded)
    envelope.i = cipher.type
    envelope.b = cipher.body

    this.relay.sendPayload(peerAlias, JSON.stringify(envelope))
    await this.persistSessions()
  }

async decryptMessage(from: string, envelope: Envelope): Promise<string> {
    return unpad(await this.decryptEnvelopeRaw(from, envelope))
  }

  /**
   * Decrypt a double-ratchet (Olm) envelope to its RAW plaintext.
   *
   * Unlike `decryptMessage`, this does NOT strip metadata padding — the
   * key-share frames carry a plain (unpadded) JSON payload.
   */
  private async decryptEnvelopeRaw(from: string, envelope: Envelope, persist = true): Promise<string> {
    // Resolve the peer's identity lazily (needed for ratchet matching).
    if (!this.identityByPeer.has(from)) {
      try {
        // fresh=true: a message from an alias we have never keyed must resolve
        // against the live room (a reconnected peer ships a brand-new alias).
        const peers = await this.relay.getPeerKeys(true)
        const b = peers[from]
        if (b) this.identityByPeer.set(from, { identityKey: b.keys.identityKey, signedPrekey: b.keys.signedPrekey })
      } catch {
        /* peer may have left; keep original sessions only */
      }
    }

    let session = this.sessionsOut.get(from)
    const candidates = this.sessionsIn.get(from) ?? []

    // Pre-key messages create/rebuild the inbound leg of the ratchet.
    if (envelope.i === 0) {
      const identity = this.identityByPeer.get(from)?.identityKey
      if (!identity) throw new Error('No identity for pre-key message — fetch keys first.')
      session = new window.Olm.Session()
      session.create_inbound_from(this.account, identity, envelope.b)
      this.sessionsIn.set(from, [session, ...candidates])
    } else {
      // Normal messages: find the session that can (and only one can) decrypt.
      for (const cand of candidates) {
        if (cand.matches_inbound_from(this.identityByPeer.get(from)?.identityKey ?? '', envelope.b)) {
          session = cand
          break
        }
      }
    }

    if (!session) throw new Error('No matching Olm session for this message.')

    const plaintext = session.decrypt(envelope.i, envelope.b)
    if (envelope.i === 1) await this.topUpPrekeys()
    if (persist) await this.persistSessions()
    else void this.persistSessions().catch(() => {}) // media frames: don't block dispatch on the IDB write

    return plaintext
  }

  // ── Group chats (Megolm / sender keys) ───────────────────────────
  /**
   * Create an outbound Megolm session for a room. Members initially receive
   * chat *before* they hold a group key, so the key is shipped as an
   * out-of-band (per-member ratcheted) message before the first group text.
   */
  async createGroupSession(): Promise<string> {
    const og = new window.Olm.OutboundGroupSession()
    og.create()
    const id = og.session_id()
    this.outGroups.set(id, og)
    this.groupMembers.set(id, [])
    await this.persistGroups()
    return id
  }

  /** Share a Megolm session key with one member or the whole room. */
  async shareGroupSessionKey(groupId: string, peerAlias?: string): Promise<void> {
    const og = this.outGroups.get(groupId)
    if (!og) throw new Error('Unknown group session.')

    // The session key is itself a secret → ride the per-member double ratchet.
    const share = JSON.stringify({ g: groupId, k: og.session_key(), n: this.groupMembers.get(groupId)?.length ?? 0 })

const targets = peerAlias ?? '*'
    if (targets === '*') {
      await Promise.all(
        (this.groupMembers.get(groupId) ?? []).map(m => this.encryptRawTo(m, { k: 'key-share', o: groupId, i: 0, b: share })),
      )
    } else {
      await this.encryptRawTo(targets, { k: 'key-share', o: groupId, i: 0, b: share })
      // Track the recipient so we never re-ship the same key to them (a
      // peer that already holds it must not trigger a share-response loop).
      const members = this.groupMembers.get(groupId) ?? []
      if (!members.includes(targets)) members.push(targets)
      this.groupMembers.set(groupId, members)
      await this.persistGroups()
    }
  }

  /**
   * Reciprocate a key-share: when a peer onboards OUR newest outbound Megolm
   * key, hand them the keys WE have already created (their own share only
   * gives them *their* group). Without this, a device that joins AFTER the
   * first exchange could decrypt messages from its own side but never open
   * the existing peer's — exactly the half-broken flow after leaving and
   * re-entering a room.
   */
  private async respondShare(peer: string): Promise<void> {
    for (const [groupId] of this.outGroups) {
      const members = this.groupMembers.get(groupId) ?? []
      if (members.includes(peer)) continue
      await this.shareGroupSessionKey(groupId, peer)
    }
    await this.persistGroups()
  }

  /** Encrypt a padded plaintext with Megolm so the whole room can open it. */
  async encryptGroupMessage(groupId: string, text: string): Promise<void> {
    const og = this.outGroups.get(groupId)
    if (!og) throw new Error('Unknown group session.')
    const envelope: Envelope = { k: 'group', o: groupId, i: 1, b: og.encrypt(pad(text)) }
    this.relay.sendPayload('*', JSON.stringify(envelope))
    await this.persistGroups()
  }

  /** Decrypt a Megolm frame; requires the key-share to have been delivered. */
  async decryptGroupMessage(groupId: string, ciphertext: string): Promise<string> {
    const ig = this.inGroups.get(groupId)
    if (!ig) throw new Error('Group session key not yet received for ' + groupId)
    const { plaintext } = ig.decrypt(ciphertext)
    return unpad(plaintext)
  }

  /** Bootstrap an inbound Megolm session from the shipped session key. */
  private async acceptGroupKey(peer: string, groupId: string, sessionKey: string): Promise<void> {
    const ig = new window.Olm.InboundGroupSession()
    ig.create(sessionKey)
    this.inGroups.set(groupId, ig)

    const members = this.groupMembers.get(groupId) ?? []
    if (!members.includes(peer)) members.push(peer)
    this.groupMembers.set(groupId, members)
    await this.persistGroups()
  }

  /** Mark this device as part of the group's member list for key re-sharing. */
  async joinGroup(groupId: string): Promise<void> {
    const members = this.groupMembers.get(groupId) ?? []
    if (!members.includes(this.relay.alias ?? 'self')) members.push(this.relay.alias ?? 'self')
    this.groupMembers.set(groupId, members)
    await this.persistGroups()
  }

  // ── Inbound envelope router ───────────────────────────────────────
private async handleIncoming(from: string, raw: string): Promise<void> {
    let env: Envelope
    try {
      env = JSON.parse(raw) as Envelope
    } catch {
      return // foreign bytes — ignore, the ratchet would fail anyway
    }

    try {
      switch (env.k) {
        case 'direct':
          await this.emit({ from, text: await this.decryptMessage(from, env) })
          break
        case 'group':
          await this.emit({ from, groupId: env.o, text: await this.decryptGroupMessage(env.o, env.b) })
          break
        case 'key-share': {
          // The share rides inside our own double ratchet (see encryptRawTo),
          // so the frame body is ciphertext until decryptEnvelopeRaw opens it.
          const share = JSON.parse(await this.decryptEnvelopeRaw(from, env)) as { g: string; k: string; n: number }
          await this.acceptGroupKey(from, share.g, share.k)
          await this.respondShare(from)
          break
        }
        case 'media-key': {
          // The AES-256 media key for our call pair — rides the ratchet so the
          // relay never sees a byte of it. Base64-decoded into the waiting PC.
          const share = JSON.parse(await this.decryptEnvelopeRaw(from, env)) as { km: string }
          this.acceptMediaKey(from, base64ToBytes(share.km))
          break
        }
        case 'call': {
          // A media-plane frame (SDP/ICE) recovered from the MAILBOX. Live
          // frames arrive on the separate 'call' wire (service.onCall); ones
          // stored for an offline peer come back labelled 'msg', so route
          // them to the same listener here. Stale duplicates are dropped by
          // the ratchet's MAC check.
          const payload = await this.decryptEnvelopeRaw(from, env)
          if (payload) this.onCallFrame(from, payload)
          break
        }
      }
    } catch (err) {
      // Never kill the WebSocket message loop: log the failure instead of
      // swallowing it silently (that made "message missing on the other side"
      // impossible to diagnose).
      console.warn('[norosa] dropped inbound frame:', err instanceof Error ? err.message : err)
    }
  }

  private onDecrypted: (m: DecryptedMessage) => void = () => {}

/** Subscribe to fully decrypted inbound messages. Returns an unsubscribe fn. */
  onMessage(cb: (m: DecryptedMessage) => void): () => void {
    const previous = this.onDecrypted
    this.onDecrypted = cb
    return () => {
      if (this.onDecrypted === cb) this.onDecrypted = previous
    }
  }

  /**
   * Subscribe to decrypted media-plane signaling frames — SDP and ICE
   * landslide that rode the double ratchet, so the relay only ever saw
   * ciphertext for them too. Live frames arrive via relay.onCall; frames the
   * relay held in our mailbox (peer was briefly offline) arrive via the
   * normal message path and are routed here a second way — see
   * handleIncoming case 'call'.
   */
  onCall(cb: (from: string, payload: string) => void): void {
    this.onCallFrame = cb
    this.relay.onCall((from, raw) => {
      void this.handleCallIncoming(from, raw).then(payload => {
        if (payload) this.onCallFrame(from, payload)
      })
    })
  }

  /** True when WE are the statically designated offerer of the peer pair. */
  amOfferer(peerAlias: string): boolean {
    const me = this.relay.alias
    return !!me && me < peerAlias
  }

  /**
   * The AES-256 media key for one peer pair. Both parties derive it without
   * the relay ever seeing it: the OFFERER (lexicographically smaller alias)
   * mints 32 CSPRNG bytes and ships them inside the double ratchet; the
   * ANSWERER waits for that envelope. Per-direction SFrame salts are derived
   * from this single key, so one secret protects both legs.
   */
  async mediaKeyFor(peerAlias: string): Promise<Uint8Array> {
  const existing = this.mediaKeys.get(peerAlias)
  if (existing) return existing

  if (this.amOfferer(peerAlias)) {
    // A key this DEVICE pair already committed wins over a re-mint — after a
    // refresh the OTHER side still holds it, and a fresh random mint would
    // black out every frame until a full re-agreement. NOTE: persistence may
    // seed the key, but the ship+ACK protocol ALWAYS runs — a persisted key
    // that is never (re)shipped would leave the answerer waiting forever.
    // The cell is keyed by the STABLE identity pair (curve25519), never by the
    // per-connection alias — the alias changes on every reconnect and would
    // split the agreement between the two sides.
    let selfId = ''
    let peerId = ''
    try {
      selfId = this.identityKey
      peerId = await this.identityOf(peerAlias)
    } catch {
      /* peer bundle not up yet — mint below and let the redelivery loop
         persist once their identity resolves */
    }
    let key: Uint8Array
    try {
      const persisted = selfId && peerId
        ? await this.storage.get<string>(mediaKeyKeyOf(selfId, peerId))
        : undefined
      key = persisted ? base64ToBytes(persisted) : crypto.getRandomValues(new Uint8Array(32))
    } catch {
      key = crypto.getRandomValues(new Uint8Array(32))
    }
    const p = new Promise<Uint8Array>((resolve, reject) => {
      const deliver = async () => {
        for (let attempt = 1; attempt <= 12; attempt++) {
          if (!this.awaitingMediaKeyAck.has(peerAlias)) return
          try {
            const share = JSON.stringify({ km: bytesToBase64(key) })
            await this.encryptRawTo(peerAlias, { k: 'media-key', o: peerAlias, i: 0, b: share })
            void this.commitMediaKey(peerAlias, key)
          } catch {
            /* peer not yet keyed — back off and reship */
          }
          await new Promise(r => setTimeout(r, 2500))
        }
        // Give up loudly so the caller's error path closes + re-dials.
        this.mediaKeys.delete(peerAlias)
        this.awaitingMediaKeyAck.delete(peerAlias)
        reject(new Error(MEDIA_KEY_NOT_DELIVERED))
      }
      this.awaitingMediaKeyAck.set(peerAlias, () => resolve(key))
      void deliver()
    })
    this.mediaKeys.set(peerAlias, p)
    return p
  }

  const p = new Promise<Uint8Array>((resolve, reject) => {
    const t = setTimeout(() => {
      this.mediaKeys.delete(peerAlias)
      reject(new Error(MEDIA_KEY_NOT_SHIPPED))
    }, 25_000)
    this.pendingMediaKeys.set(peerAlias, key => {
      clearTimeout(t)
      this.pendingMediaKeys.delete(peerAlias)
      resolve(key)
    })
  })
  this.mediaKeys.set(peerAlias, p)
  return p
}

  /** Best-effort persist of the agreed media key under the STABLE identity
   *  pair, so a reload or reconnect of either device reuses it. Resolving the
   *  peer's identity may need a key fetch, therefore this is fire-and-forget:
   *  the in-memory key keeps the live call working even if the commit fails. */
  private async commitMediaKey(peerAlias: string, key: Uint8Array): Promise<void> {
    try {
      const peerId = await this.identityOf(peerAlias)
      await this.storage.set(mediaKeyKeyOf(this.identityKey, peerId), bytesToBase64(key))
    } catch {
      /* persisting is best-effort; the in-memory key still works */
    }
  }

  /** Route an inbound media-key envelope to its waiter. */
  private acceptMediaKey(peer: string, key: Uint8Array): void {
    void this.commitMediaKey(peer, key)
    const resolve = this.pendingMediaKeys.get(peer)
    if (resolve) resolve(key)
    else this.mediaKeys.set(peer, Promise.resolve(key))
    // Confirm delivery so the offerer stops re-shipping at once.
    this.sendCallSignal(peer, JSON.stringify({ p: 'mkey-ack' }))
  }

  /** Fire-and-forget an encrypted media-plane frame (SDP/ICE) to one peer.
   *  These ride the 'call' wire type so the relay's 'msg' router never has to
   *  page through them, and the media-plane router (handleCallIncoming) owns
   *  their one true delivery path. */
  sendCallSignal(peerAlias: string, payload: string): void {
    void this.encryptThenSend(peerAlias, { k: 'call', o: peerAlias, i: 0, b: payload }, 'call')
  }

  /** Decrypt one media-plane call frame then hand it to the subscriber. */
  private async handleCallIncoming(from: string, raw: string): Promise<string> {
    let env: Envelope
    try {
      env = JSON.parse(raw) as Envelope
    } catch {
      return ''
    }
    if (env.k !== 'call') return ''
    try {
      const plain = await this.decryptEnvelopeRaw(from, env, false)
      if (plain.startsWith('{"p":"mkey-ack"')) {
        // Confirmation from the answerer: stop re-shipping the pair key.
        const resolve = this.awaitingMediaKeyAck.get(from)
        if (resolve) { resolve(); this.awaitingMediaKeyAck.delete(from) }
        return ''
      }
      return plain
    } catch (err) {
      console.warn('[norosa] dropped call frame:', err instanceof Error ? err.message : err)
      return ''
    }
  }

  /** Single media-plane listener (MediaCallClient). */
  private onCallFrame: (from: string, payload: string) => void = () => {}

  /** Subscribe to instant presence pushes (someone joined/left this room).
   *  Multiple subscribers are safe (chat + media planes); returns unsub. */
  onPresence(cb: (alias: string, online: boolean) => void): () => void {
    this.presenceListeners.add(cb)
    return () => void this.presenceListeners.delete(cb)
  }

  private async emit(m: DecryptedMessage): Promise<void> {
    this.onDecrypted(m)
  }

// ── Raw ratcheted send (used for group key-shares) ────────────────
  private async encryptRawTo(peerAlias: string, envelope: Envelope): Promise<void> {
    await this.encryptThenSend(peerAlias, envelope, 'msg')
  }

  /** Ratchet-encrypt an envelope, then ship it on the requested wire type. */
  private async encryptThenSend(peerAlias: string, envelope: Envelope, wire: 'msg' | 'call'): Promise<void> {
    if (!this.sessionsOut.has(peerAlias)) await this.initiateSession(peerAlias)
    const session = this.sessionsOut.get(peerAlias)!
    const cipher = session.encrypt(envelope.b)
    envelope.i = cipher.type
    envelope.b = cipher.body
    const blob = JSON.stringify(envelope)
    if (wire === 'call') this.relay.sendCall(peerAlias, blob)
    else this.relay.sendPayload(peerAlias, blob)
    await this.persistSessions()
  }

  // ── Persistence (IndexedDB) ───────────────────────────────────────
  /** Rehydrate sessions / Megolm state from IndexedDB after a reload. */
  private async restoreState(): Promise<void> {
    const SESSION_PREFIX = sessionKeyOf('')         // 'session:'
    const INBOUND_MARKER = '#in#'

const sessionKeys = await IdbStore.keys(SESSION_PREFIX)
    for (const k of sessionKeys) {
      const pickle = await IdbStore.get<string>(k)
      if (!pickle) continue
      const s = new window.Olm.Session()
      try {
        s.unpickle(this.pickleKey, pickle)
      } catch {
        await IdbStore.delete(k)
        continue
      }
      const inIdx = k.indexOf(INBOUND_MARKER)
      if (inIdx !== -1) {
        const peer = k.slice(SESSION_PREFIX.length, inIdx)
        const list = this.sessionsIn.get(peer) ?? []
        list.push(s)
        this.sessionsIn.set(peer, list)
      } else {
        this.sessionsOut.set(k.slice(SESSION_PREFIX.length), s)
      }
    }

    const outKeys = await IdbStore.keys('outgroup:')
    for (const k of outKeys) {
      const pickle = await IdbStore.get<string>(k)
      if (!pickle) continue
      const og = new window.Olm.OutboundGroupSession()
      try {
        og.unpickle(this.pickleKey, pickle)
      } catch {
        await IdbStore.delete(k)
        continue
      }
      this.outGroups.set(k.slice('outgroup:'.length), og)
    }

    const inKeys = await IdbStore.keys('ingroup:')
    for (const k of inKeys) {
      const pickle = await IdbStore.get<string>(k)
      if (!pickle) continue
      const ig = new window.Olm.InboundGroupSession()
      try {
        ig.unpickle(this.pickleKey, pickle)
      } catch {
        await IdbStore.delete(k)
        continue
      }
      this.inGroups.set(k.slice('ingroup:'.length), ig)
    }

    const memberKeys = await IdbStore.keys('groupmembers:')
    for (const k of memberKeys) {
      const arr = await IdbStore.get<string[]>(k)
      if (arr) this.groupMembers.set(k.slice('groupmembers:'.length), arr)
    }
  }

  private async persistAccount(): Promise<void> {
    await this.storage.set(ACCOUNT_KEY, this.account.pickle(this.pickleKey))
  }

  private async persistSessions(): Promise<void> {
    for (const [peer, s] of this.sessionsOut) await this.storage.set(sessionKeyOf(peer), s.pickle(this.pickleKey))
    for (const [peer, list] of this.sessionsIn) {
      for (let i = 0; i < list.length; i++) await this.storage.set(sessionKeyOf(`${peer}#in#${i}`), list[i]!.pickle(this.pickleKey))
    }
  }

  private async persistGroups(): Promise<void> {
    for (const [id, og] of this.outGroups) await this.storage.set(outboundGroupKeyOf(id), og.pickle(this.pickleKey))
    for (const [id, ig] of this.inGroups) await this.storage.set(inboundGroupKeyOf(id), ig.pickle(this.pickleKey))
    for (const [id, members] of this.groupMembers) await this.storage.set(`groupmembers:${id}`, members)
  }

  /** Ask the relay to wipe the room; leaves nothing anywhere. */
  destroyRoom(): void {
    this.relay.destroyRoom()
  }

  /** Tear down this client's transport. Leaves relay state untouched. */
  dispose(): void {
    this.relay.close()
  }
}
