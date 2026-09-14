/**
 * NOROSA Media plane — E2EE WebRTC audio (Insertable Streams).
 *
 * Design:
 *
 *   • One RTCPeerConnection per peer (deterministic offerer = the party with
 *     the lexicographically smaller relay alias — no glare, ever).
 *   • Every offer prepares a single audio m-line whose track may start null
 *     (mic granted later). Toggling the mic is then a plain
 *     `sender.replaceTrack(micTrack | null)` — NO renegotiation, no call
 *     teardown.
 *   • AES-GCM-256 (WebCrypto) over RTP frames via RTCRtpScriptTransform, in
 *     an SFrame-like framing:
 *         header = 8-byte big-endian frame counter || 1-byte keyId
 *         iv     = 12-byte per-direction salt XOR the counter
 *         aad    = header
 *         body   = AES-GCM(key, iv, plaintext, aad)  (16-byte tag appended)
 *     The counter rides in the header so a lost UDP frame can never desync
 *     the stream. Salt derivation is directional:
 *         send to P     → salt(key, 'norosa-media-salt:' + P)
 *         receive from P → salt(key, 'norosa-media-salt:' + MY alias)
 *     so P applies its own rule and both legs use different salts without
 *     ever transporting them. Both sides share ONE media key, agreed over
 *     the existing double ratchet (service.mediaKeyFor) — the blind relay
 *     only ever sees ciphertext.
 *
 * Support: the transform layer needs Chrome/Edge ≥89, Firefox ≥117, Safari
 * ≥18 — the transform is wired with the function-based RTCRtpScriptTransform
 * (a TransformStream piped between readable→writable), falling back to a Blob
 * worker where that form is unavailable. Browsers without that layer (older
 * Safari/iOS/WebViews) negotiate a LEGACY pair: seamless plain WebRTC media,
 * still encrypted end-to-end at the transport level by DTLS-SRTP, but without
 * the post-transform E2EE layer. The capability rides on every offer/answer,
 * so a mixed room silently falls back per pair instead of garbling audio.
 */

import { E2eEncryptionService } from '../../crypto/E2eEncryptionService'
import { dbg, debugEnabled } from '../../debug'
import { insertableStreamsSupported } from './caps'
import { fallbackIceServers } from './ice'
import { deriveSalt, type EncodedStreamHost, type EncodedStreams, type PeerEntry } from './sframe'
import { attachReceiverCrypto, attachSenderCrypto, encodedTransformModel, receiverStreamCache, senderStreamCache } from './transforms'

export interface MediaCallEvents {
  /** A peer's remote mix mutated (audio track added). */
  onStream?: (peerAlias: string, stream: MediaStream) => void
  onPeerState?: (peerAlias: string, state: RTCPeerConnectionState) => void
  /** Microphone grant failed — `message` is the browser's reason. */
  onMicError?: (message: string) => void
  /** A peer toggled their mic — drives the remote muted badge. */
  onPeerMic?: (peerAlias: string, muted: boolean) => void
  /** A peer's inbound audio is actively failing to decrypt (2s cadence). */
  onFrameDrop?: (peerAlias: string) => void
  /** Live transport readout for a peer (2s cadence) — the on-screen media
   *  diagnostics bar. */
  onStats?: (peerAlias: string, s: PeerMediaStats) => void
}

export interface PeerMediaStats {
  conn: RTCPeerConnectionState
  /** Where the pair's SDP exchange sits (new / have-local-offer / stable …). */
  sig: string
  /** Audio m-line direction as reported in OUR local SDP (ground truth that
   *  survives engines without sender.transceiver). */
  dir: string
  /** Audio m-line direction as reported in the peer's SDP. */
  rdir: string
  hasMic: boolean
  /** Local audio sender carries the encrypt transform. */
  txAttached: boolean
  /** Local audio receiver carries the decrypt transform. */
  rxAttached: boolean
  decryptFailing: boolean
  ts: number
  packetsSent: number
  packetsReceived: number
  rttMs: number | null
}

// ── Signaling payloads (inside the double-ratchet envelope) ───────
type CallSig =
  | { p: 'offer'; d: string; e: boolean }
  | { p: 'answer'; d: string; e: boolean }
  | { p: 'ice'; c: RTCIceCandidateInit }
  | { p: 'mute'; on: boolean }
  /** Explicit teardown notice — the sender closed its local peer connection. */
  | { p: 'bye' }

/** Empty-slot placeholder for legacy pairs (no transform layer uses it). */
const u8z = (): Uint8Array<ArrayBuffer> => new Uint8Array(0) as Uint8Array<ArrayBuffer>

/** sender.transceiver — standardized, but absent from the TS DOM lib. */
const transceiverOf = (sender: RTCRtpSender | null): RTCRtpTransceiver | null => {
  if (!sender) return null
  return (sender as unknown as { transceiver?: RTCRtpTransceiver }).transceiver ?? null
}

/** Direction of the `m=audio` section in an SDP, or `?` when absent. Unlike
 *  `transceiver.direction`, this IS the negotiated ground truth — Safari (and
 *  the PC browsers here) all report the direction column faithfully. */
function sdpAudioDir(sdp: string | undefined): string {
  if (!sdp) return '?'
  const lines = sdp.split('\r\n').filter(Boolean)
  const mAudio = lines.findIndex(l => l.startsWith('m=audio'))
  if (mAudio < 0) return '?'
  for (let i = mAudio + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('m=')) break
    if (/^a=(sendrecv|recvonly|sendonly|inactive)$/.test(l)) return l.slice(2)
  }
  return '?'
}

// ── The call client ───────────────────────────────────────────────

export class MediaCallClient {
  private peers = new Map<string, PeerEntry>()
  private started = false
  private disposed = false
  private reconnect?: ReturnType<typeof setTimeout>
  private statsTimer?: ReturnType<typeof setInterval>
  private micTrack: MediaStreamTrack | null = null
  private micDeviceId: string | null = null
  private audioEnabled = true
  private mediaKeyCache = new Map<string, Uint8Array>()
  private encryptFails = new Map<string, number>()
  private knownPresence = new Set<string>()
  /** Guards one background setup pass per peer (presence + reconcile may race). */
  private peerSetup = new Set<string>()
  /** A receiver gets one decrypt transform for its lifetime — ontrack may repeat. */
  private attachedReceivers = new WeakSet<RTCRtpReceiver>()
  /** Peers whose inbound frames are actively failing to decrypt. */
  private decryptFailing = new Set<string>()
  private healing = new Set<string>()
  private healCounts = new Map<string, number>()

  constructor(
    private svc: E2eEncryptionService,
    private events: MediaCallEvents = {},
    private iceServers: RTCIceServer[] = fallbackIceServers(),
    /** Device-level transform-layer capacity (deep probe, not the light ctor
     *  check). When false every pair falls back to plain DTLS-SRTP media. */
    private e2eeSupported = insertableStreamsSupported(),
  ) {}

  get supported(): boolean {
    return this.e2eeSupported
  }

  /**
   * Honest room-level encryption label. 'e2ee' only when every live pair uses
   * the transform layer; 'legacy' when THIS device cannot; 'mixed' when a live
   * peer lacks it (that pair runs DTLS-SRTP, not E2EE).
   */
  encryptionMode(): 'e2ee' | 'legacy' | 'mixed' {
    if (!this.e2eeSupported) return 'legacy'
    const peers = [...this.peers.values()]
    if (peers.length === 0) return 'e2ee'
    return peers.every(p => p.e2ee) ? 'e2ee' : 'mixed'
  }

  remoteStream(peerAlias: string): MediaStream | null {
    return this.peers.get(peerAlias)?.stream ?? null
  }

  listPeers(): string[] {
    return [...this.peers.keys()]
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.svc.onCall((from, payload) => {
      void this.handleSignal(from, payload)
    })
    this.unsubPresence = this.svc.onPresence((alias, online) => this.handlePresence(alias, online))

    await this.reconcile()
    this.reconnect = setTimeout(() => void this.tick(), 1500)
    this.statsTimer = setInterval(() => void this.emitStats(), 2000)
  }

  /** Emit a live transport readout per peer (drives the on-screen diagnostics
   *  bar — zero devtools needed to see whether a phone actually sends, and
   *  whether the far side receives + decrypts). getStats gives us ground
   *  truth that the two most common one-way-silence shapes disagree on:
   *    • sender never negotiated (recvonly)  → packetsSent stays 0
   *    • frames sent but undecryptable        → packetsReceived grows but the
   *      user hears nothing (the PC decrypts and drops them). */
  private async emitStats(): Promise<void> {
    for (const [peer, entry] of this.peers) {
      const sender = entry.audioSender
      const rx = entry.pc.getReceivers().find(r => r.track?.kind === 'audio')
      const base: PeerMediaStats = {
        conn: entry.pc.connectionState,
        sig: entry.pc.signalingState,
        dir: sdpAudioDir(entry.pc.localDescription?.sdp),
        rdir: sdpAudioDir(entry.pc.remoteDescription?.sdp),
        hasMic: this.micTrack?.readyState === 'live' && !!this.audioEnabled,
        txAttached: !!sender && entry.encAttach.has(sender),
        rxAttached: !!rx && this.attachedReceivers.has(rx),
        decryptFailing: this.decryptFailing.has(peer),
        ts: Date.now(),
        packetsSent: 0,
        packetsReceived: 0,
        rttMs: null,
      }
      void entry.pc.getStats().then(report => {
        let packetsSent = 0
        let packetsReceived = 0
        let rttMs: number | null = null
        for (const r of report.values()) {
          const s = r as { type: string; kind?: string; packetsSent?: number; packetsReceived?: number; droppedPackets?: number; state?: string; currentRoundTripTime?: number }
          if (s.type === 'outbound-rtp' && s.kind === 'audio' && typeof s.packetsSent === 'number') packetsSent += s.packetsSent
          if (s.type === 'inbound-rtp' && s.kind === 'audio' && typeof s.packetsReceived === 'number') packetsReceived += s.packetsReceived
          if (s.type === 'candidate-pair' && s.state === 'succeeded' && typeof s.currentRoundTripTime === 'number') rttMs = Math.round(s.currentRoundTripTime * 1000)
        }
        this.events.onStats?.(peer, { ...base, packetsSent, packetsReceived, rttMs })
      }).catch(() => {})
    }
  }

  private handlePresence(alias: string, online: boolean): void {
    if (this.disposed) return
    if (!online) {
this.closePeer(alias, 'presence-offline')
      this.knownPresence.delete(alias)
    } else if (alias !== this.svc.selfAlias) {
      this.knownPresence.add(alias)
      void this.connectTo(alias)
    }
  }

  /** Periodic self-heal: pick up peers that a missed presence push skipped,
   *  and re-attach any crypto step whose one-shot connection-time hook never
   *  ran (e.g. a mic granted after 'connected' or a receiver whose ontrack
   *  fired before the pair was decrypt-capable). All guards are idempotent. */
  private async tick(): Promise<void> {
    if (this.disposed) return
    await this.reconcile()
    for (const [alias, entry] of this.peers) {
      if (entry.pc.connectionState !== 'connected') continue
      // Rebuild the pair when a live mic never made it onto the negotiated
      // m-line (Safari answers recvonly for a trackless sender; the mic often
      // grants right AFTER the answer). The rebuild re-answers with the mic
      // present → sendrecv, and the remote rebuilds alongside (bye).
      const ld = sdpAudioDir(entry.pc.localDescription?.sdp)
      if (this.micTrack?.readyState === 'live' && this.audioEnabled && ld !== 'sendrecv') {
        console.warn('[media] audio m-line not sendrecv with a live mic — renegotiating', { peer: alias, dir: ld })
        dbg('tick heal: audio m-line renegotiation', { peer: alias, dir: ld })
        this.closePeer(alias, 'audio-line-not-send', true)
        setTimeout(() => void this.connectTo(alias), 500)
        continue
      }
      if (entry.e2ee) {
        // Sender transform missing + a live mic = we send this peer PLAIN
        // frames while they decrypt → their silence. Re-attach when the
        // one-shot 'connected' hook ran before the mic existed.
        if (this.micTrack?.readyState === 'live' && entry.audioSender && !entry.encAttach.has(entry.audioSender)) {
          dbg('tick heal: attaching sender crypto', { peer: alias })
          this.attachSend(alias, entry.audioSender, 'audio', this.micTrack)
        }
        // Receiver decrypt missing for an already-connected pair → their
        // encrypted frames arrive undecrypted (dropped). Idempotent WeakSet.
        for (const r of entry.pc.getReceivers()) {
          if (!this.attachedReceivers.has(r)) void this.attachReceiverWhenReady(alias, entry, r).catch(() => {})
        }
      }
    }
    this.reconnect = setTimeout(() => void this.tick(), 4000)
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return
    let peers: string[]
    try {
      peers = await this.allRoomPeers()
    } catch {
      return
    }
    for (const p of peers) {
      if (p === this.svc.selfAlias || this.peers.has(p)) continue
      void this.connectTo(p)
    }
    for (const alias of [...this.peers.keys()]) {
      if (!peers.includes(alias)) this.closePeer(alias, 'reconcile-missing')
    }
  }

  private async mediaKeyFor(peer: string): Promise<Uint8Array> {
    let k = this.mediaKeyCache.get(peer)
    if (k) return k
    k = await this.svc.mediaKeyFor(peer)
    this.mediaKeyCache.set(peer, k)
    return k
  }

  /** Re-run `fn` with linear backoff while `shouldRetry` holds. */
  private async withRetries<T>(
    fn: () => Promise<T>,
    shouldRetry: (err: unknown) => boolean,
    attempts = 6,
    delayMs = 800,
  ): Promise<T> {
    const attempt = async (n: number): Promise<T> => {
      try {
        return await fn()
      } catch (err) {
        if (n >= attempts || !shouldRetry(err)) throw err
        await new Promise(r => setTimeout(r, delayMs * n))
        return attempt(n + 1)
      }
    }
    return attempt(1)
  }

  /** Some webcam drivers leave getUserMedia pending forever (hanging device).
   *  A stuck promise would keep the button "pending/blocked" with NO way to
   *  clear it — surface a hard timeout instead so the UI can recover. */
  private withTimeout<T>(label: string, p: Promise<T>, ms = 8000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms (device hung)`)), ms)
      p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
    })
  }

  private async ensureMic(deviceId: string | null): Promise<MediaStreamTrack> {
    if (this.micTrack && this.micDeviceId === deviceId && this.micTrack.readyState === 'live') return this.micTrack
    this.micTrack?.stop()
    this.micTrack = null
    this.micDeviceId = deviceId

    // Some engines reject rich boolean constraints (echoCancellation etc.)
    // with a TypeError "Invalid constraint" — that is NOT a permission denial,
    // so "allow access" can never fix it. Mirror the camera path: try the full
    // audience first, then retry with NO constraints (bare capture) which only
    // fails on a genuine permission/hardware problem.
    let stream: MediaStream | null = null
    let lastErr = 'unknown failure'
    {
      const preferred = deviceId
        ? { deviceId: { exact: deviceId } }
        : { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      try {
        stream = await this.withTimeout('getUserMedia-mic', navigator.mediaDevices.getUserMedia({ audio: preferred }))
      } catch (err) {
        lastErr = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        console.warn('[media] mic request failed, retrying bare:', lastErr)
      }
    }
    if (!stream || !stream.getAudioTracks()[0]) {
      try {
        stream = await this.withTimeout('getUserMedia-mic-bare', navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        }))
      } catch (err) {
        lastErr = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      }
    }
    if (!stream || !stream.getAudioTracks()[0]) {
      console.warn('[media] mic unavailable:', lastErr)
      this.events.onMicError?.(lastErr)
      throw new Error('Microphone unavailable.')
    }
    this.micTrack = stream.getAudioTracks()[0]!
    return this.micTrack
  }

  /**
   * Create (once) the structural half of a peer's connection: PC, stream,
   * both m-lines, ICE/SDP/media wiring. SYNCHRONOUS except for the wire
   * handlers — so the moment an offer arrives the answerer ALREADY carries
   * matching audio+video transceivers and can answer instantly, regardless of
   * how far the media-key negotiation has progressed in the background.
   */
  private ensurePeer(peer: string): PeerEntry | null {
    // Entrance counter — BEFORE any guard. Two hits for one peer = the dial
    // layer fired twice (case-2 tell) even though the guard still reuses the
    // same pc below.
    dbg('ensurePeer enter', peer)
    if (this.disposed || peer === this.svc.selfAlias) return null
    const existing = this.peers.get(peer)
    if (existing) {
      // Tell for re-dials: if the SAME alias runs ensurePeer twice, reuse here
      // proves no second pc / no extra transceivers ever happen.
      dbg('ensurePeer reuse', { peer })
      return existing
    }
    // hadEntryBefore=false 4× for one alias = something wiped the entry between
    // calls (closePeer) — the recreation loop, not a guard failure.
    dbg('ensurePeer create', { peer, hadEntryBefore: !!existing, e2eeSupported: this.e2eeSupported })

    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    const stream = new MediaStream()
    let saltResolve: (s: { key: Uint8Array; send: Uint8Array<ArrayBuffer>; recv: Uint8Array<ArrayBuffer> }) => void = () => {}
    const entry: PeerEntry = {
      pc, stream, audioSender: null,
      salts: new Promise(res => { saltResolve = res }),
      encAttach: new WeakSet(),
      lastOffer: '',
      offerInFlight: false,
      iceBuffer: [],
      worker: null,
      // Initial assumption: full E2EE for the pair. Refined by the peer's
      // advertised capability on its offer/answer — both sides then converge.
      e2ee: this.e2eeSupported,
    }
    this.peers.set(peer, entry)

    // M-lines BEFORE any await (see method doc — adding them late mangles the
    // SDP map and turns calls half-open).
    const aT = pc.addTransceiver('audio', { direction: 'sendrecv' })
    entry.audioSender = aT.sender
    // Sanity: exactly one transceiver leaves here. A larger count means a
    // stray addTransceiver or a duplicated ensurePeer — the tell for mystery
    // receiver accumulation on the far side.
    dbg('peer pc created', { peer, transceivers: pc.getTransceivers().length })

    // LEGACY model: encoded streams MUST exist synchronously at negotiation;
    // Chromium throws "Too late to create encoded streams" once RTP is flowing.
    // MODERN model: sender.transform assignment works anytime — skip.
    if (this.e2eeSupported && encodedTransformModel() === 'legacy') {
      try {
        const s = (aT.sender as unknown as EncodedStreamHost).createEncodedStreams()
        senderStreamCache.set(aT.sender, s)
      } catch {
        /* negotiated later; attachSend will surface it */
      }
    }

    this.wireSignaling(peer, entry)
    this.wireMedia(peer, entry, saltResolve)
    return entry
  }

  private wireSignaling(peer: string, entry: PeerEntry): void {
    const { pc } = entry
    pc.onicecandidate = e => {
      if (e.candidate && this.peers.get(peer) === entry) {
        this.svc.sendCallSignal(peer, JSON.stringify({ p: 'ice', c: e.candidate.toJSON() }))
      }
    }
    pc.onconnectionstatechange = () => {
      this.events.onPeerState?.(peer, pc.connectionState)
      if (pc.connectionState === 'connected') {
        entry.offerInFlight = false
        // Never read `sender.track` to pick the attach track — current
        // Chromium keeps it transiently null right after a replaceTrack
        // (documented ground truth). The mic track we injected (prepareMedia
        // at connect, setMicOn on toggle) is authoritative, and when the mic
        // was denied here the sender simply stays trackless until a toggle.
        const t = this.audioEnabled && this.micTrack?.readyState === 'live' ? this.micTrack : null
        if (t && entry.audioSender) void this.attachSend(peer, entry.audioSender, 'audio', t)
        // Belt-and-suspenders decrypt: some browsers never fire ontrack for a
        // sendrecv m-line whose remote sender had no track at negotiation. An
        // audio sender starts muted (mic granted later) and the decrypted
        // frames would decode as garbage. Without a decrypt transform here,
        // that peer's encrypted frames never render. The same repair covers
        // late-granted mics for a peer connected during a mute.
        void this.attachAllReceivers(peer, entry)
        // Sync our current mic state so a freshly-connected peer renders the
        // muted badge correctly without waiting for a toggle.
        this.svc.sendCallSignal(peer, JSON.stringify({ p: 'mute', on: !this.audioEnabled }))
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.closePeer(peer, 'conn-failed')
    }
  }

  /** Attach decrypt crypto to every receiver hookable so far (idempotent). */
  private async attachAllReceivers(peer: string, entry: PeerEntry): Promise<void> {
    for (const r of entry.pc.getReceivers()) {
      await this.attachReceiverWhenReady(peer, entry, r).catch(() => {})
    }
  }

  private wireMedia(peer: string, entry: PeerEntry, saltResolve: (s: { key: Uint8Array; send: Uint8Array<ArrayBuffer>; recv: Uint8Array<ArrayBuffer> }) => void): void {
    entry.pc.ontrack = e => {
      if (!e.track) return
      // Track add + decrypt both run on the single connected-time path
      // (attachReceiverWhenReady): a pre-connect ontrack neither commits an
      // unplayable track nor burns the receiver in the WeakSet. Early ontrack
      // (pc still 'connecting') is swept later by the 'connected' handler's
      // attachAllReceivers; a repeat ontrack after connect is routed here.
      if (entry.pc.connectionState === 'connected') {
        void this.attachReceiverWhenReady(peer, entry, e.receiver)
      }
    }
    void this.prepareMedia(peer, entry).then(
      s => saltResolve(s),
      err => {
        console.warn('[media] media-key negotiation failed:', err instanceof Error ? err.message : err)
        this.closePeer(peer, 'media-key-fail')
      },
    )
  }

  /**
   * Background half of connect: settle the shared media key, derive the
   * directional SFrame salts, then bind the mic and (if we are the offerer)
   * fire the offer. The answerer starts answering the moment the offer shows
   * up — nothing here blocks that path.
   */
  private async prepareMedia(peer: string, entry: PeerEntry): Promise<{ key: Uint8Array; send: Uint8Array<ArrayBuffer>; recv: Uint8Array<ArrayBuffer> }> {
    let key: Uint8Array
    let send: Uint8Array<ArrayBuffer>
    let recv: Uint8Array<ArrayBuffer>
    if (!this.e2eeSupported) {
      // No transform layer on this device — media flows plain over the pair's
      // DTLS-SRTP (the transport still encrypts it end to end). Resolve the
      // salts slot with zeros: nothing that consumes it is wired in this mode.
      dbg('legacy device — plain DTLS-SRTP pair, skipping media key', peer)
      key = u8z(); send = u8z(); recv = u8z()
    } else {
      // The media-key handshake can race the peer's first key upload (a thread
      // joins → presence fires → we dial → their bundle is still being uploaded
      // for a second or two). Retry with backoff instead of tearing the entry
      // down: the message above-cache fix also stops a failed mint from being
      // served to every retry.
      const k = await this.withRetries(
        () => this.mediaKeyFor(peer),
        err => {
          if (!(err instanceof Error)) return false
          return err.message.includes('never received the media key') ||
            err.message.includes('never delivered the media key')
        },
        8,
        700,
      )
      dbg('media key ready for', peer)
      send = await deriveSalt(k, peer) // encrypt our sends TO this peer
      recv = await deriveSalt(k, this.svc.selfAlias ?? '') // decrypt THEIR sends
      key = k
    }

    // Mic permission is NEVER a connection blocker — audio m-line exists, and
    // the track drops in via replaceTrack the moment it is granted.
    try {
      const mic = await this.ensureMic(this.micDeviceId)
      entry.audioSender?.replaceTrack(mic)
    } catch (err) {
      console.warn('[media] mic declined on connect from:', err instanceof Error ? err.message : err)
      this.events.onMicError?.(err instanceof Error ? err.message : String(err))
    }

    if (this.svc.amOfferer(peer) && entry.pc.signalingState === 'stable') {
      if (entry.offerInFlight) {
        console.warn('[media] negotiation-start blocked (offer already in flight)', { peer })
      } else {
        entry.offerInFlight = true
        // Same m-line pinning as the answer path: a trackless sender at offer
        // time (mic still in the prompt / denied) must NOT collapse the audio
        // line to recvonly — the track arrives via replaceTrack later.
        const audioTr = transceiverOf(entry.audioSender)
        if (audioTr && audioTr.direction !== 'sendrecv') audioTr.direction = 'sendrecv'
        await entry.pc.setLocalDescription(await entry.pc.createOffer())
        // Same sanity as the answer path: an offer that drops our audio send
        // direction while the mic is live is never shipped — rebuild the pair
        // so the retry carries the track from the first SDP line.
        const offeredDir = sdpAudioDir(entry.pc.localDescription?.sdp)
        if (offeredDir !== 'sendrecv' && this.micTrack?.readyState === 'live') {
          console.warn(`[media] offer came back ${offeredDir} with a live mic — re-negotiating`, { peer })
          dbg('offer-not-sendrecv: immediate re-negotiation', { peer, dir: offeredDir })
          this.closePeer(peer, 'offer-not-sendrecv', true)
          setTimeout(() => void this.connectTo(peer), 300)
          // The pair is being torn down; these placeholders are never used.
          return { key: u8z(), send: u8z(), recv: u8z() }
        }
        const ml = entry.pc.localDescription?.sdp.match(/m=/g)?.length ?? 0
        const skel = entry.pc.localDescription?.sdp.split('\n').filter(l => /^m=/.test(l) || /^a=mid:/.test(l)).join(' ') || '∅'
        dbg('sent offer', { peer, mLines: ml, mids: skel, transceivers: entry.pc.getTransceivers().length, receivers: entry.pc.getReceivers().length, sdpTail: entry.pc.localDescription?.sdp.slice(-24) })
        this.svc.sendCallSignal(peer, JSON.stringify({ p: 'offer', d: entry.pc.localDescription!.sdp, e: this.e2eeSupported }))
        // Offer is out — future renegotiation is the caller's business now.
        entry.offerInFlight = false
      }
    }
    // ANSWERER: nothing here — answering happens inside handleSignal('offer').
    return { key, send, recv }
  }

  private async connectTo(peer: string): Promise<void> {
    const entry = this.ensurePeer(peer)
    if (!entry || this.peerSetup.has(peer)) return
    this.peerSetup.add(peer)
    try {
      // Same job as wireMedia's already-running `prepareMedia`; this entry
      // only exists to give presence/reconcile a fire-and-forget handle.
      await entry.salts
    } catch {
      /* failure already reported by wireMedia */
    } finally {
      this.peerSetup.delete(peer)
    }
  }

  private async handleSignal(from: string, payload: string): Promise<void> {
    if (this.disposed || from === this.svc.selfAlias) return
    let sig: CallSig
    try {
      sig = JSON.parse(payload) as CallSig
    } catch {
      return
    }

    if (sig.p === 'offer') {
      // We are the ANSWERER. ensurePeer() arms the connection synchronously —
      // PC, audio+video transceivers, wiring — so the received offer maps onto
      // existing m-lines and we answer immediately. No dependency on the media
      // key here: that only gates the (background) crypto attachment.
      const entry = this.ensurePeer(from)
      if (!entry) return
      // Pair-effective mode: E2EE only when BOTH ends carry the transform
      // layer. The answer echoes our own capability so the offerer converges.
      entry.e2ee = this.e2eeSupported && (sig.e ?? this.e2eeSupported)
      dbg('pair mode decided (offerer)', { peer: from, e2ee: entry.e2ee, theirCaps: sig.e, ourCaps: this.e2eeSupported })
      // Subtle: connectTo() is what kicks the shared background prepareMedia,
      // so the salts eventually resolve and the counters stay in sync even
      // when this offer was the very first sight of the peer.
      void this.connectTo(from)
      const gotML = sig.d.match(/m=/g)?.length ?? 0
      const fp = `${sig.d.length}:${sig.d.slice(-16)}`
      // Workaround: filter lines that are SDP headers / mid attribs.
      const skeleton = sig.d.split('\n').filter(l => /^m=/.test(l) || /^a=mid:/.test(l)).join(' ') || '∅'
      dbg('received offer', { from, mLines: gotML, mids: skeleton, transceivers: entry.pc.getTransceivers().length, receiversBefore: entry.pc.getReceivers().length })
      // Duplicate-delivery guard: the same offer reaching us twice (stale
      // relay, reconnect replay) makes the answerer renegotiate the identical
      // m-lines and DOUBLE every receiver — the tell behind the reproducible
      // 3→6 receiver jump. Answer the first copy only.
      if (entry.lastOffer === fp) {
        console.warn('[media] duplicate offer dropped', { from, mLines: gotML, fp })
        return
      }
      entry.lastOffer = fp
      if (entry.pc.signalingState !== 'stable') {
        // Duplicate/late offer — deterministic offerer means one offer total.
        return
      }
      try {
        await entry.pc.setRemoteDescription({ type: 'offer', sdp: sig.d })
        // iOS Safari derives the answer's m-line direction from which track is
        // attached AT answer time. The phone's mic is usually still inside the
        // permission prompt when a peer's offer lands (the browser's prompt
        // latency is a second or two), so the answer would come back `recvonly`
        // for audio — the phone's outbound audio is then never negotiated and
        // the far side hears silence in that direction forever (the one-way
        // call). Pin the audio line to sendrecv regardless of mic readiness:
        // the track drops in via replaceTrack the moment the grant resolves.
        const audioTr = transceiverOf(entry.audioSender)
        if (audioTr) {
          const was = audioTr.direction
          if (was !== 'sendrecv') {
            audioTr.direction = 'sendrecv'
            dbg('audio m-line pinned sendrecv on answer', { peer: from, was })
          }
        }
        // Safari derives the answer's direction from the track attached AT
        // answer time — the direction property alone does not override a
        // trackless sender. The peer's offer usually lands while the mic is
        // still in the OS permission prompt, so hold the reply until the
        // background ensureMic (already in flight via prepareMedia → salts)
        // either grants us a track or gives up, then answer with the mic
        // actually on the sender. Cap at 2.5s so a permanently-pending device
        // prompt never stalls negotiation — the track still lands later via
        // replaceTrack, but audio then needs a renegotiation to transport.
        await Promise.race([
          entry.salts,
          new Promise<void>(res => setTimeout(res, 2500)),
        ]).catch(() => {})
        dbg('answering offer', { from, audioDirection: sdpAudioDir(entry.pc.localDescription?.sdp), audioHasTrack: !!entry.audioSender?.track, micTrackLive: this.micTrack?.readyState === 'live' })
        await entry.pc.setLocalDescription(await entry.pc.createAnswer())
        // Safari can still answer recvonly for the audio m-line despite a
        // live track (it applies the sender's state at negotiation in ways
        // the direction property does not override). Never ship an answer
        // that eliminates our send — tear down and renegotiate; the dial
        // layer rebuilds both sides in under a second, and by then the mic
        // grant is cached so the retry answers with the track present.
        const answeredDir = sdpAudioDir(entry.pc.localDescription?.sdp)
        if (answeredDir !== 'sendrecv' && this.micTrack?.readyState === 'live') {
          console.warn(`[media] answer came back ${answeredDir} with a live mic — re-negotiating`, { peer: from })
          dbg('answer-not-sendrecv: immediate re-negotiation', { peer: from, dir: answeredDir })
          this.closePeer(from, 'answer-not-sendrecv', true)
          setTimeout(() => void this.connectTo(from), 300)
          return
        }
        this.svc.sendCallSignal(from, JSON.stringify({ p: 'answer', d: entry.pc.localDescription!.sdp, e: this.e2eeSupported }))
        await this.flushIce(entry)
      } catch (err) {
        console.warn('[media] answer failed:', err instanceof Error ? err.message : err)
        this.closePeer(from, 'answer-fail')
      }
      return
    }

    if (sig.p === 'mute') {
      // Handled BEFORE the peer-entry check: a mute frame from a peer we have
      // not dialed yet would otherwise vanish (badge sync broken in rooms of
      // 3+). The mute state does not need the connection to render.
      this.events.onPeerMic?.(from, sig.on === true)
      return
    }

    if (sig.p === 'bye') {
      // Explicit teardown notice: the far side closed its LOCAL peer
      // connection. Drop ours so we never keep a half-open pair (previously
      // the remote was never told, leaving stale/black media until a fresh
      // offer forced a rebuild). The reply chain stops here — a bye-triggered
      // closePeer never sends a bye back.
      const target = this.peers.get(from)
      if (target) this.closePeer(from, 'remote-bye', false)
      return
    }

    const entry = this.peers.get(from)
    if (!entry) return

    if (sig.p === 'answer') {
      // Pair-effective mode settled once the offerer learns their capability
      // (the answerer already decided at the offer — both converge on the
      // same flag): E2EE only when BOTH ends carry the transform layer.
      entry.e2ee = this.e2eeSupported && (sig.e ?? this.e2eeSupported)
      dbg('pair mode decided (answerer)', { peer: from, e2ee: entry.e2ee, theirCaps: sig.e, ourCaps: this.e2eeSupported })
      try {
        await entry.pc.setRemoteDescription({ type: 'answer', sdp: sig.d })
        await this.flushIce(entry)
      } catch (err) {
        console.warn('[media] remote answer rejected:', err instanceof Error ? err.message : err)
        this.closePeer(from, 'remote-answer-reject')
      }
      return
    }
    if (sig.p === 'ice') {
      if (!entry.pc.remoteDescription) {
        entry.iceBuffer.push(sig.c as RTCIceCandidateInit)
      } else {
        await entry.pc.addIceCandidate(sig.c as RTCIceCandidateInit).catch(() => {})
      }
      return
    }
  }

  /** Dump buffered pre-negotiation ICE candidates once the pair is described. */
  private async flushIce(entry: PeerEntry): Promise<void> {
    const pending = entry.iceBuffer
    entry.iceBuffer = []
    for (const c of pending) {
      await entry.pc.addIceCandidate(c).catch(() => {})
    }
  }

  private async attachReceiverWhenReady(peer: string, entry: PeerEntry, receiver: RTCRtpReceiver): Promise<void> {
    dbg('attachReceiver', { peer, receiverId: receiver.track?.id, pcReceivers: entry.pc.getReceivers().length, alreadyAttached: this.attachedReceivers.has(receiver), pc: entry.pc.connectionState, e2ee: entry.e2ee })
    if (this.attachedReceivers.has(receiver)) return
    if (entry.pc.connectionState !== 'connected') return
    if (!receiver.track || receiver.track.readyState === 'ended') return
    this.attachedReceivers.add(receiver)
    // Create the encoded streams SYNCHRONOUSLY (this runs inside the ontrack
    // task, before the first await) — LEGACY model only. MODERN engines wire
    // decrypt via receiver.transform (no encoded-stream plumbing at all), and
    // createEncodedStreams on top of a .transform assignment would double up.
    // Legacy PAIRS (one end without the transform layer) skip this entirely —
    // plain DTLS-SRTP media needs neither streams nor a decrypt transform.
    const modern = encodedTransformModel() === 'modern'
    let streams: EncodedStreams | null = null
    if (!modern) {
      if (!entry.e2ee) {
        dbg('legacy pair — plain DTLS-SRTP receiver, no encoded streams', peer)
      } else {
        streams = receiverStreamCache.get(receiver) ?? null
        if (!streams) {
          try {
            streams = (receiver as unknown as EncodedStreamHost).createEncodedStreams()
            receiverStreamCache.set(receiver, streams)
          } catch (err) {
            // Possible only on the belt-and-suspenders path ('connected' fallback
            // where ontrack never fired for a sendrecv m-line). Media is already
            // flowing there; the primary ontrack path always succeeds.
            console.warn('[media] receiver encoded streams too late:', err instanceof Error ? err.message : err)
            return
          }
        }
      }
    }
    try {
      // The key + salts settle asynchronously; attaching before that point
      // would decrypt against a zero salt and drop every frame (black video).
      const salts = await entry.salts
      if (this.disposed || !this.peers.has(peer)) return
      let added = false
      if (receiver.track) {
        // A healed/re-dialed pc can leave stale same-kind tracks behind; the
        // tile shows getVideoTracks()[0], so a dead video track from a closed
        // connection shadows the live one forever. Prune ended tracks of the
        // same kind as the incoming one so the stream never accumulates.
        let staleRemoved = 0
        for (const dead of entry.stream.getTracks()) {
          if (dead.kind === receiver.track.kind && (dead.readyState === 'ended' || dead === receiver.track)) {
            entry.stream.removeTrack(dead)
            staleRemoved++
          }
        }
        dbg('addTrack', { peer, trackId: receiver.track.id, trackKind: receiver.track.kind, beforeCount: entry.stream.getTracks().length + staleRemoved, isNew: !entry.stream.getTracks().includes(receiver.track), staleRemoved })
        if (!entry.stream.getTracks().includes(receiver.track)) {
          entry.stream.addTrack(receiver.track)
          added = true
        }
        // Who mutes a received track tells us whether the far side swapped its
        // sender (share/camera/replaceTrack): a mute on the video track right
        // when the sharer started = normal swap; a persistent mute with no
        // unmute = black-at-the-source (the tile never re-fetches). Diagnostic
        // listeners only — skipped in production builds.
        if (debugEnabled) {
          const t = receiver.track
          for (const ev of ['mute', 'unmute', 'ended'] as const) {
            t.addEventListener(ev, () => dbg(`rxTrack ${ev}`, { peer, kind: t.kind, id: t.id }))
          }
        }
      }
      if (entry.e2ee) {
        if (streams) {
          attachReceiverCrypto(receiver, streams, entry, salts.key, salts.recv, () => this.noteFrameDrop(peer))
        } else {
          attachReceiverCrypto(receiver, null as unknown as EncodedStreams, entry, salts.key, salts.recv, () => this.noteFrameDrop(peer))
        }
        dbg('decrypt attached', { peer, e2ee: entry.e2ee })
      } else {
        dbg('legacy pair — decrypt skipped (plain DTLS-SRTP media)', peer)
      }
      if (added) this.events.onStream?.(peer, entry.stream)
      dbg('receiver attached', { peer, tracks: entry.stream.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState, id: t.id })) })
    } catch (err) {
      console.warn(`[media] decrypt attach deferred for ${peer}:`, err instanceof Error ? err.message : err)
    }
  }

  private noteFrameDrop(peer: string): void {
    if (this.decryptFailing.has(peer)) return
    this.decryptFailing.add(peer)
    this.events.onFrameDrop?.(peer)
    this.scheduleHeal(peer)
  }

  /** Watchdog: a pair that stays undecryptable (black video) for seconds gets
   *  a fresh re-negotiation instead of sitting black forever. The media key is
   *  now persisted + ACKed, so the second agreement is fast and consistent —
   *  this is the auto-heal for any pair whose first handshake desynced. */
  private scheduleHeal(peer: string): void {
    if (this.healing.has(peer)) return
    const count = this.healCounts.get(peer) ?? 0
    if (count >= 3) return
    this.healing.add(peer)
    setTimeout(() => {
      this.healing.delete(peer)
      if (!this.decryptFailing.has(peer)) return
      this.healCounts.set(peer, (this.healCounts.get(peer) ?? 0) + 1)
      console.warn(`[media] auto-healing pair ${peer} — fresh key agreement`)
      this.closePeer(peer, 'heal')
      this.decryptFailing.delete(peer)
      setTimeout(() => void this.connectTo(peer), 500)
    }, 4000)
  }

  isDecryptFailing(peer: string): boolean {
    return this.decryptFailing.has(peer)
  }

  private attachSend(peer: string, sender: RTCRtpSender, kind: 'audio' | 'video', track?: MediaStreamTrack | null): void {
    const entry = this.peers.get(peer)
    // Never trust `sender.track` here: some Chromium builds keep it null for a
    // beat after replaceTrack(), which silently skipped the encrypt attach and
    // left the peer with undecryptable frames (permanent black). Callers pass
    // the exact track they just replaceTrack()'d in instead.
    const t = track ?? sender.track
    const alreadyBool = this.disposed || !entry || entry.encAttach.has(sender) || !entry.e2ee
    dbg('attachSend called', { peer, kind, hasTrack: !!t, already: alreadyBool, e2ee: entry?.e2ee ?? false })
    // One encrypt transform per sender for life — modern engines keep
    // `sender.transform` across replaceTrack, so a re-assign mid-life would
    // tear the worker pipe (InvalidStateError) and kill the video instead of
    // healing it. A legacy pair (no transform layer on one end) sends PLAIN
    // media over the pair's DTLS-SRTP — encrypting here would garble it.
    if (!entry || entry.encAttach.has(sender) || !t || !entry.e2ee) return
    const failKey = `${peer}:${kind}`
    void entry.salts.then(async salts => {
      if (this.disposed || !this.peers.get(peer) || entry.encAttach.has(sender)) return
      const ok = await attachSenderCrypto(sender, entry, salts.key, salts.send)
      if (!ok) {
        // createEncodedStreams is one-shot and now cached, so a retry can only
        // rebuild the transform — but a browser that refuses BOTH transform
        // forms will never heal here. Cap it instead of spinning forever.
        const fails = (this.encryptFails.get(failKey) ?? 0) + 1
        this.encryptFails.set(failKey, fails)
        if (fails > 5) {
          console.warn(`[media] giving up on encrypt attach for ${failKey} (${fails} attempts)`)
          return
        }
        console.warn(`[media] encrypt attach failed for ${failKey} — retrying`)
        setTimeout(() => this.attachSend(peer, sender, kind, t), 1500)
        return
      }
      this.encryptFails.delete(failKey)
      entry.encAttach.add(sender)
    }).catch(() => {})
  }

  /** Unmute/mute. replaceTrack — no renegotiation, the call stays up. */
  async setMicOn(on: boolean, deviceId?: string): Promise<void> {
    // Resolve the track BEFORE flipping client state: a denied/absent mic
    // must reject so the caller's revert keeps UI and client state in sync
    // (audioEnabled would otherwise claim "on" while the UI correctly shows
    // blocked, and the stale `on` would leak into the next mute broadcast).
    if (on && deviceId) await this.ensureMic(deviceId)
    const track = on ? (this.micTrack ?? await this.ensureMic(this.micDeviceId)) : null
    this.audioEnabled = on
    for (const [peer, entry] of this.peers) {
      if (!entry.audioSender) continue
      entry.audioSender.replaceTrack(track)
      if (on) this.attachSend(peer, entry.audioSender, 'audio', track)
    }
    this.broadcastMicState()
    // The badge must reach EVERYONE in the room, even peers we have not
    // dialed yet (no PeerEntry). Their handler processes 'mute' before the
    // connection check, so a bare ratchet frame is enough. Use BOTH key lists
    // so a peer hidden by the stale-identity filter still gets it.
    void this.allRoomPeers().then(all => {
      for (const peer of all) {
        if (!this.peers.has(peer) && peer !== this.svc.selfAlias) {
          this.svc.sendCallSignal(peer, JSON.stringify({ p: 'mute', on: !on }))
        }
      }
    }).catch(() => {})
  }

  private broadcastMicState(): void {
    if (this.peers.size === 0) return
    const frame = JSON.stringify({ p: 'mute', on: !this.audioEnabled })
    for (const peer of this.peers.keys()) this.svc.sendCallSignal(peer, frame)
  }

  /** Union of keyed + currently-online peers (online ones are never hidden). */
  private async allRoomPeers(): Promise<string[]> {
    const keyed: string[] = []
    try {
      keyed.push(...(await this.svc.listPeers()))
    } catch {
      /* fall through to presence only */
    }
    const self = this.svc.selfAlias
    return [...new Set([...keyed, ...this.svc.listOnlinePeers()].filter(a => a !== self))]
  }

  get audioOn(): boolean {
    return this.audioEnabled
  }

  private closePeer(peer: string, reason = 'unknown', notifyRemote = true): void {
    const entry = this.peers.get(peer)
    // Who closes a pair determines whether the recreation loop (offer×N for one
    // alias) is a heal, a prune, or a transient failure — log it every time.
    dbg('closePeer', { peer, reason, hadEntry: !!entry, pcState: entry?.pc.connectionState })
    if (!entry) return
    // Audit scope 5: a local teardown must be SIGNALED to the far side over
    // the encrypted channel, or it keeps a half-open pair with stale media
    // until a fresh offer rebuilds it. Gate on an actual exchange having
    // happened (descriptions set) — otherwise the bye would mint an unused
    // ratchet and burn a one-time pre-key for nothing. Never on 'dispose'
    // (the whole stack is unwinding) and never in reply to a bye (loop).
    const everNegotiated = !!entry.pc.localDescription || !!entry.pc.remoteDescription
    if (notifyRemote && reason !== 'dispose' && everNegotiated) {
      this.svc.sendCallSignal(peer, JSON.stringify({ p: 'bye' }))
    }
    this.peers.delete(peer)
    this.mediaKeyCache.delete(peer)
    this.decryptFailing.delete(peer)
    this.healCounts.delete(peer)
    this.attachedReceivers = new WeakSet<RTCRtpReceiver>()
    for (const k of [...this.encryptFails.keys()]) if (k.startsWith(peer)) this.encryptFails.delete(k)
    entry.pc.onicecandidate = null
    entry.pc.ontrack = null
    entry.pc.onconnectionstatechange = null
    entry.pc.close()
    // Free the shared encoding worker for this peer — otherwise every peer
    // that ever connected keeps a (potentially idle) worker thread alive for
    // the whole session (the original leak; see PeerEntry.worker).
    if (entry.worker) {
      entry.worker.terminate()
      entry.worker = null
    }
  }

  /** Restart the mic track (device picker changed). */
  async reconfigureDevices(micId: string | null): Promise<void> {
    await this.setMicOn(this.audioEnabled, micId ?? this.micDeviceId ?? 'default')
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnect) clearTimeout(this.reconnect)
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.unsubPresence?.()
    for (const peer of [...this.peers.keys()]) this.closePeer(peer, 'dispose')
    this.micTrack?.stop()
    this.micTrack = null
    this.started = false
  }

  private unsubPresence: (() => void) | null = null
}
