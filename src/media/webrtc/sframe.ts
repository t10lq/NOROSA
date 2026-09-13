export type PeerEntry = {
  pc: RTCPeerConnection
  stream: MediaStream
  audioSender: RTCRtpSender | null
  /** Resolves with the media key + per-direction SFrame salts once the key
   *  lands. Crypto attachment must AWAIT this — never attach with a zero key. */
  salts: Promise<{ key: Uint8Array; send: Uint8Array<ArrayBuffer>; recv: Uint8Array<ArrayBuffer> }>
  /** Encrypt transform attached per SENDER. Once attached it encrypts
   *  whichever (audio) track the sender carries — modern engines KEEP
   *  sender.transform across replaceTrack(), so a once-only guard is both
   *  safe and required: re-assigning a second transform on the same tick
   *  tears the worker's pipe and throws InvalidStateError. */
  encAttach: WeakSet<RTCRtpSender>
  /** Fingerprint (sdp length + tail) of the LAST received offer, to drop
   *  duplicate deliveries that would otherwise renegotiate and duplicate
   *  m-lines on the answering pc. */
  lastOffer: string
  /** One offer per pair — the negotiation-start gate (case-2 guard). Cleared
   *  on every return to `stable`, so a LEGITIMATE future renegotiation
   *  (ICE restart, re-offer) is never silently blocked — only the immediate
   *  duplicate of the in-flight attempt is. */
  offerInFlight: boolean
  iceBuffer: RTCIceCandidateInit[]
  /** ONE worker for every RTCRtpScriptTransform of this peer connection. A
   *  single worker can host many transformers (one per attach). This is what
   *  serializes the modern model: creating a fresh `new Worker` per attach
   *  leaked threads with every auto-heal cycle until Chrome threw
   *  "Too many active Worker threads". Terminated in closePeer. */
  worker: Worker | null
}

// ── SFrame-like framing (pure crypto helpers) ─────────────────────

const KEY_ID = 0
const HEADER_LEN = 9
const SALT_PREFIX = 'norosa-media-salt:'

export function deriveSalt(mediaKey: Uint8Array, targetAlias: string): Promise<Uint8Array<ArrayBuffer>> {
  const material = new TextEncoder().encode(SALT_PREFIX + targetAlias)
  const hk = new Uint8Array(mediaKey.length + material.length)
  hk.set(mediaKey, 0)
  hk.set(material, mediaKey.length)
  return crypto.subtle.digest('SHA-256', hk).then(d => new Uint8Array(d).slice(0, 12) as Uint8Array<ArrayBuffer>)
}

/** Fresh ArrayBuffer-backed byte buffer (TS 5.7 generic TypedArray form). */
function u8(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(n) as Uint8Array<ArrayBuffer>
}

function incCounter(ctr: Uint8Array): void {
  for (let i = ctr.length - 1; i >= 0; i--) {
    ctr[i] = (ctr[i]! + 1) & 0xff
    if (ctr[i] !== 0) break
  }
}

function ivOf(salt: Uint8Array, ctr: Uint8Array): Uint8Array<ArrayBuffer> {
  const iv = u8(12)
  for (let i = 0; i < 8; i++) iv[i] = salt[i]! ^ ctr[i]!
  for (let i = 8; i < 12; i++) iv[i] = salt[i]!
  return iv
}

/** Import the shared AES-256 media key once per transform attachment. */
export function importMediaKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export type EncodedFrame = RTCEncodedAudioFrame | RTCEncodedVideoFrame

/**
 * The runtime object handed to a function-transform's start callback. The
 * DOM lib's RTCRtpScriptTransform declares the constructor but not this
 * controller type, so it is described locally.
 */
interface RtcTransformController {
  readable: ReadableStream<EncodedFrame>
  writable: WritableStream<EncodedFrame>
}

/** Per-frame AES-GCM-256 (re)seal, shared by every packet direction. */
async function sealFrame(
  frame: EncodedFrame,
  original: Uint8Array<ArrayBuffer>,
  ctr: Uint8Array,
  mode: 'encrypt' | 'decrypt',
  key: CryptoKey,
  salt: Uint8Array,
): Promise<void> {
  if (mode === 'encrypt') {
    incCounter(ctr)
    const header = u8(HEADER_LEN)
    header.set(ctr, 0)
    header[HEADER_LEN - 1] = KEY_ID
    const iv = ivOf(salt, ctr)
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, original))
    const out = u8(HEADER_LEN + ct.length)
    out.set(header, 0)
    out.set(ct, HEADER_LEN)
    frame.data = out.buffer as ArrayBuffer
    return
  }
  // decrypt
  if (original.byteLength < HEADER_LEN + 16) throw new Error('short frame')
  const header = new Uint8Array(original.subarray(0, HEADER_LEN))
  const iv = ivOf(salt, header.subarray(0, 8))
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: header },
    key,
    original.subarray(HEADER_LEN),
  )
  frame.data = plain as ArrayBuffer
}

/**
 * Build the function-transform handed to `new RTCRtpScriptTransform(...)`.
 * It pins a per-direction TransformStream between the reader and writer, so
 * every RTP packet is (re)sealed before leaving / after arriving.
 */
export function makeFrameTransformer(
  key: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  mode: 'encrypt' | 'decrypt',
  onThrottledDrop?: () => void,
): (controller: RtcTransformController) => void {
  const ctr = crypto.getRandomValues(new Uint8Array(8))
  // Throttled drop diagnostics: bursts of dropped frames are exactly what a
  // black/unheard stream looks like, and silent drops are undiagnosable.
  let lastWarn = 0
  let dropped = 0
  const handler: Transformer<EncodedFrame>['transform'] = async (frame, controller) => {
    try {
      const original = new Uint8Array(frame.data as ArrayBuffer) as Uint8Array<ArrayBuffer>
      await sealFrame(frame, original, ctr, mode, key, salt)
      controller.enqueue(frame)
    } catch {
      dropped++
      if (mode === 'decrypt') {
        const now = Date.now()
        if (now - lastWarn > 2000) {
          console.warn(`[media] ${dropped} inbound frame(s) dropped (~every 2s) — wrong media key/salt, or peer not yet attached.`)
          onThrottledDrop?.()
          lastWarn = now
          dropped = 0
        }
      }
    }
  }
  return (controller: RtcTransformController) => {
    controller.readable
      .pipeThrough(new TransformStream<EncodedFrame, EncodedFrame>({ transform: handler }))
      .pipeTo(controller.writable)
      .catch(() => {})
  }
}
/** Browsers without the typed createEncodedStreams in the DOM lib still carry it. */
export interface EncodedStreamHost {
  createEncodedStreams(): { readable: ReadableStream<EncodedFrame>; writable: WritableStream<EncodedFrame> }
}
export type EncodedStreams = { readable: ReadableStream<EncodedFrame>; writable: WritableStream<EncodedFrame> }
