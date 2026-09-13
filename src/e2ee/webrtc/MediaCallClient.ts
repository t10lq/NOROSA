/**
 * NOROSA Media plane — E2EE WebRTC audio/video (Insertable Streams).
 *
 * Design (mirrors the "audio-only call that upgrades to video without ever
 * dropping the connection" requirement):
 *
 *   • One RTCPeerConnection per peer (deterministic offerer = the party with
 *     the lexicographically smaller relay alias — no glare, ever).
 *   • Every offer prepares BOTH an audio sender (real mic track) and a video
 *     transceiver whose track starts `null`. Toggling video is then a plain
 *     `sender.replaceTrack(cameraTrack | null)` — NO renegotiation, no call
 *     teardown. The video m-line is already there.
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
 * Support: Chrome/Edge ≥89, Firefox ≥117, Safari ≥18. The transform is wired
 * with the function-based RTCRtpScriptTransform (a TransformStream piped
 * between readable→writable), falling back to a Blob worker where that form
 * is unavailable.
 */

import { E2eEncryptionService } from '../../crypto/E2eEncryptionService'
import { insertableStreamsSupported } from './caps'
import { fallbackIceServers } from './ice'
import { deriveSalt, type EncodedStreamHost, type EncodedStreams, type PeerEntry } from './sframe'
import { attachReceiverCrypto, attachSenderCrypto, encodedTransformModel, receiverStreamCache, senderStreamCache } from './transforms'

export interface MediaCallEvents {
  /** A peer's remote mix mutated (audio/video track added). */
  onStream?: (peerAlias: string, stream: MediaStream) => void
  onPeerState?: (peerAlias: string, state: RTCPeerConnectionState) => void
  /** Microphone/camera grant failed — `message` is the browser's reason. */
  onMicError?: (message: string) => void
  onCamError?: (message: string) => void
  /** A peer toggled their mic — drives the remote muted badge. */
  onPeerMic?: (peerAlias: string, muted: boolean) => void
  /** A peer's inbound video/audio is actively failing to decrypt (2s cadence). */
  onFrameDrop?: (peerAlias: string) => void
}

// ── Signaling payloads (inside the double-ratchet envelope) ───────
type CallSig =
  | { p: 'offer'; d: string }
  | { p: 'answer'; d: string }
  | { p: 'ice'; c: RTCIceCandidateInit }
  | { p: 'mute'; on: boolean }

// ── The call client ───────────────────────────────────────────────

export class MediaCallClient {
  private peers = new Map<string, PeerEntry>()
  private started = false
  private disposed = false
  private reconnect?: ReturnType<typeof setTimeout>
  private micTrack: MediaStreamTrack | null = null
  private camTrack: MediaStreamTrack | null = null
  private micDeviceId: string | null = null
  private camDeviceId: string | null = null
  private audioEnabled = true
  private videoEnabled = false
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
  ) {}

  get supported(): boolean {
    return insertableStreamsSupported()
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
    if (!insertableStreamsSupported()) return

    this.svc.onCall((from, payload) => {
      void this.handleSignal(from, payload)
    })
    this.unsubPresence = this.svc.onPresence((alias, online) => this.handlePresence(alias, online))

    await this.reconcile()
    this.reconnect = setTimeout(() => void this.tick(), 1500)
  }

  private handlePresence(alias: string, online: boolean): void {
    if (this.disposed) return
    if (!online) {
      this.closePeer(alias)
      this.knownPresence.delete(alias)
    } else if (alias !== this.svc.selfAlias) {
      this.knownPresence.add(alias)
      void this.connectTo(alias)
    }
  }

  /** Periodic self-heal: pick up peers that a missed presence push skipped. */
  private async tick(): Promise<void> {
    if (this.disposed) return
    await this.reconcile()
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
      if (!peers.includes(alias)) this.closePeer(alias)
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

  private async ensureCam(deviceId: string | null): Promise<MediaStreamTrack> {
    if (this.camTrack && this.camDeviceId === deviceId && this.camTrack.readyState === 'live') return this.camTrack
    this.camTrack?.stop()
    this.camTrack = null
    this.camDeviceId = deviceId

    // A single strict getUserMedia can die on quirky webcams (Overconstrained-
    // /NotReadableError). Always try the FULL constraints first, then a BARE
    // capture with no constraints at all — the OS default device satisfies it.
    let stream: MediaStream | null = null
    let lastErr: string = 'unknown failure'
    {
      const preferred = deviceId
        ? { deviceId: { exact: deviceId } }
        : { frameRate: 30, height: { ideal: 1280 }, width: { ideal: 720 } }
      console.log('[media] camera request:', JSON.stringify(preferred))
      try {
        stream = await this.withTimeout('getUserMedia-cam', navigator.mediaDevices.getUserMedia({ video: preferred, audio: false }))
      } catch (err) {
        lastErr = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        console.warn('[media] camera request failed, retrying bare:', lastErr)
      }
    }
    if (!stream) {
      try {
        stream = await this.withTimeout('getUserMedia-cam-bare', navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false }))
      } catch (err) {
        lastErr = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      }
    }
    if (!stream || !stream.getVideoTracks()[0]) {
      console.warn('[media] camera unavailable:', lastErr)
      this.events.onCamError?.(lastErr)
      throw new Error('Camera unavailable.')
    }
    this.camTrack = stream.getVideoTracks()[0]!
    const settings = this.camTrack.getSettings()
    console.log('[media] camera ON — deviceId=%s %sx%s', settings.deviceId, settings.width, settings.height)
    return this.camTrack
  }

  /**
   * Create (once) the structural half of a peer's connection: PC, stream,
   * both m-lines, ICE/SDP/media wiring. SYNCHRONOUS except for the wire
   * handlers — so the moment an offer arrives the answerer ALREADY carries
   * matching audio+video transceivers and can answer instantly, regardless of
   * how far the media-key negotiation has progressed in the background.
   */
  private ensurePeer(peer: string): PeerEntry | null {
    if (this.disposed || peer === this.svc.selfAlias) return null
    const existing = this.peers.get(peer)
    if (existing) return existing
    if (!insertableStreamsSupported()) return null

    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    const stream = new MediaStream()
    let saltResolve: (s: { key: Uint8Array; send: Uint8Array<ArrayBuffer>; recv: Uint8Array<ArrayBuffer> }) => void = () => {}
    const entry: PeerEntry = {
      pc, stream, audioSender: null, videoSender: null,
      salts: new Promise(res => { saltResolve = res }),
      encAttach: { audio: false, video: false },
      iceBuffer: [],
      worker: null,
    }
    this.peers.set(peer, entry)

    // M-lines BEFORE any await (see method doc — adding them late mangles the
    // SDP map and turns calls half-open / video black).
    const aT = pc.addTransceiver('audio', { direction: 'sendrecv' })
    entry.audioSender = aT.sender
    const vT = pc.addTransceiver('video', { direction: 'sendrecv' })
    entry.videoSender = vT.sender

    // LEGACY model: encoded streams MUST exist synchronously at negotiation;
    // Chromium throws "Too late to create encoded streams" once RTP is flowing.
    // MODERN model: sender.transform assignment works anytime — skip.
    if (encodedTransformModel() === 'legacy') {
      for (const sender of [aT.sender, vT.sender]) {
        try {
          const s = (sender as unknown as EncodedStreamHost).createEncodedStreams()
          senderStreamCache.set(sender, s)
        } catch {
          /* negotiated later; attachSend will surface it */
        }
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
        if (entry.audioSender?.track) void this.attachSend(peer, entry.audioSender, 'audio')
        if (entry.videoSender?.track && this.videoEnabled) void this.attachSend(peer, entry.videoSender, 'video')
        // Belt-and-suspenders decrypt: some browsers never fire ontrack for a
        // sendrecv m-line whose remote sender had no track at negotiation (our
        // camera is enabled AFTER connect). Without a decrypt transform here,
        // that peer's encrypted frames decode as garbage → permanent black.
        void this.attachAllReceivers(peer, entry)
        // Sync our current mic state so a freshly-connected peer renders the
        // muted badge correctly without waiting for a toggle.
        this.svc.sendCallSignal(peer, JSON.stringify({ p: 'mute', on: !this.audioEnabled }))
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.closePeer(peer)
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
      entry.stream.addTrack(e.track)
      this.events.onStream?.(peer, entry.stream)
      this.attachReceiverWhenReady(peer, entry, e.receiver)
    }
    void this.prepareMedia(peer, entry).then(
      s => saltResolve(s),
      err => {
        console.warn('[media] media-key negotiation failed:', err instanceof Error ? err.message : err)
        this.closePeer(peer)
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
    // The media-key handshake can race the peer's first key upload (a thread
    // joins → presence fires → we dial → their bundle is still being uploaded
    // for a second or two). Retry with backoff instead of tearing the entry
    // down: the message above-cache fix also stops a failed mint from being
    // served to every retry.
    const key = await this.withRetries(
      () => this.mediaKeyFor(peer),
      err => {
        if (!(err instanceof Error)) return false
        return err.message.includes('never received the media key') ||
          err.message.includes('never delivered the media key')
      },
      8,
      700,
    )
    console.log('[media] media key ready for', peer)
    const send = await deriveSalt(key, peer) // encrypt our sends TO this peer
    const recv = await deriveSalt(key, this.svc.selfAlias ?? '') // decrypt THEIR sends

    // Mic permission is NEVER a connection blocker — audio m-line exists, and
    // the track drops in via replaceTrack the moment it is granted.
    try {
      const mic = await this.ensureMic(this.micDeviceId)
      entry.audioSender?.replaceTrack(mic)
    } catch (err) {
      console.warn('[media] mic declined on connect from:', err instanceof Error ? err.message : err)
      this.events.onMicError?.(err instanceof Error ? err.message : String(err))
    }

    // Video must follow the SAME rule: if the camera was enabled BEFORE this
    // peer existed (typical for the room creator), no setVideoEnabled() will
    // ever run for this newcomer otherwise, and the sender track stays null →
    // the creator's video would be the one permanent black tile.
    if (this.videoEnabled && this.camTrack) {
      try {
        entry.videoSender?.replaceTrack(this.camTrack)
        if (entry.videoSender?.track) this.attachSend(peer, entry.videoSender, 'video')
      } catch (err) {
        console.warn('[media] video declined on connect from:', err instanceof Error ? err.message : err)
        this.events.onCamError?.(err instanceof Error ? err.message : String(err))
      }
    }

    if (this.svc.amOfferer(peer) && entry.pc.signalingState === 'stable') {
      await entry.pc.setLocalDescription(await entry.pc.createOffer())
      this.svc.sendCallSignal(peer, JSON.stringify({ p: 'offer', d: entry.pc.localDescription!.sdp }))
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
      // Subtle: connectTo() is what kicks the shared background prepareMedia,
      // so the salts eventually resolve and the counters stay in sync even
      // when this offer was the very first sight of the peer.
      void this.connectTo(from)
      if (entry.pc.signalingState !== 'stable') {
        // Duplicate/late offer — deterministic offerer means one offer total.
        return
      }
      try {
        await entry.pc.setRemoteDescription({ type: 'offer', sdp: sig.d })
        await entry.pc.setLocalDescription(await entry.pc.createAnswer())
        this.svc.sendCallSignal(from, JSON.stringify({ p: 'answer', d: entry.pc.localDescription!.sdp }))
        await this.flushIce(entry)
      } catch (err) {
        console.warn('[media] answer failed:', err instanceof Error ? err.message : err)
        this.closePeer(from)
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

    const entry = this.peers.get(from)
    if (!entry) return

    if (sig.p === 'answer') {
      try {
        await entry.pc.setRemoteDescription({ type: 'answer', sdp: sig.d })
        await this.flushIce(entry)
      } catch (err) {
        console.warn('[media] remote answer rejected:', err instanceof Error ? err.message : err)
        this.closePeer(from)
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
    if (this.attachedReceivers.has(receiver)) return
    this.attachedReceivers.add(receiver)
    // Create the encoded streams SYNCHRONOUSLY (this runs inside the ontrack
    // task, before the first await) — LEGACY model only. MODERN engines wire
    // decrypt via receiver.transform (no encoded-stream plumbing at all), and
    // createEncodedStreams on top of a .transform assignment would double up.
    const modern = encodedTransformModel() === 'modern'
    let streams: EncodedStreams | null = null
    if (!modern) {
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
    try {
      // The key + salts settle asynchronously; attaching before that point
      // would decrypt against a zero salt and drop every frame (black video).
      const salts = await entry.salts
      if (this.disposed || !this.peers.has(peer)) return
      if (streams) {
        attachReceiverCrypto(receiver, streams, entry, salts.key, salts.recv, () => this.noteFrameDrop(peer))
      } else {
        attachReceiverCrypto(receiver, null as unknown as EncodedStreams, entry, salts.key, salts.recv, () => this.noteFrameDrop(peer))
      }
      console.log(`[media] decrypt attached — ${peer}`)
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
      this.closePeer(peer)
      this.decryptFailing.delete(peer)
      setTimeout(() => void this.connectTo(peer), 500)
    }, 4000)
  }

  isDecryptFailing(peer: string): boolean {
    return this.decryptFailing.has(peer)
  }

  private attachSend(peer: string, sender: RTCRtpSender, kind: 'audio' | 'video'): void {
    const entry = this.peers.get(peer)
    if (!entry || entry.encAttach[kind] || !sender.track) return
    const failKey = `${peer}:${kind}`
    void entry.salts.then(async salts => {
      if (this.disposed || !this.peers.get(peer) || entry.encAttach[kind]) return
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
        setTimeout(() => this.attachSend(peer, sender, kind), 1500)
        return
      }
      this.encryptFails.delete(failKey)
      entry.encAttach[kind] = true
    }).catch(() => {})
  }

  /** Unmute/mute. replaceTrack — no renegotiation, the call stays up. */
  async setMicOn(on: boolean, deviceId?: string): Promise<void> {
    this.audioEnabled = on
    if (on && deviceId) await this.ensureMic(deviceId)
    const track = on ? (this.micTrack ?? await this.ensureMic(this.micDeviceId)) : null
    for (const [peer, entry] of this.peers) {
      if (!entry.audioSender) continue
      entry.audioSender.replaceTrack(track)
      if (on) this.attachSend(peer, entry.audioSender, 'audio')
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

  /** Toggle camera. replaceTrack(null↔camera) — connection never drops. */
  async setVideoEnabled(on: boolean, deviceId?: string): Promise<void> {
    this.videoEnabled = on
    if (on) {
      const cam = await this.ensureCam(deviceId ?? this.camDeviceId)
      for (const [peer, entry] of this.peers) {
        if (!entry.videoSender) continue
        entry.videoSender.replaceTrack(cam)
        this.attachSend(peer, entry.videoSender, 'video')
      }
    } else {
      for (const entry of this.peers.values()) entry.videoSender?.replaceTrack(null)
      this.camTrack?.stop()
      this.camTrack = null
    }
  }

  get videoOn(): boolean {
    return this.videoEnabled
  }

  get audioOn(): boolean {
    return this.audioEnabled
  }

  localCameraTrack(): MediaStreamTrack | null {
    return this.camTrack
  }

  private closePeer(peer: string): void {
    const entry = this.peers.get(peer)
    if (!entry) return
    this.peers.delete(peer)
    this.mediaKeyCache.delete(peer)
    this.decryptFailing.delete(peer)
    this.healCounts.delete(peer)
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

  /** Restart the shared camera/mic tracks (device picker changed). */
  async reconfigureDevices(micId: string | null, camId: string | null): Promise<void> {
    await this.setMicOn(this.audioEnabled, micId ?? this.micDeviceId ?? 'default')
    if (this.videoEnabled) {
      await this.setVideoEnabled(true, camId ?? this.camDeviceId ?? 'default')
    } else {
      this.camDeviceId = camId
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnect) clearTimeout(this.reconnect)
    this.unsubPresence?.()
    for (const peer of [...this.peers.keys()]) this.closePeer(peer)
    this.micTrack?.stop()
    this.micTrack = null
    this.camTrack?.stop()
    this.camTrack = null
    this.started = false
  }

  private unsubPresence: (() => void) | null = null
}
