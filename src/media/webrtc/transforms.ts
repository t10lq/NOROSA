import { b64Encode } from '../../crypto/encoding'
import { importMediaKey, makeFrameTransformer, type EncodedFrame, type EncodedStreamHost, type EncodedStreams, type PeerEntry } from './sframe'

/** Blob-worker transform (fallback runtimes). */
const WORKER_SRC = `
function b64ToBytes(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function incCounter(ctr) { for (let i = ctr.length - 1; i >= 0; i--) { ctr[i] = (ctr[i] + 1) & 0xff; if (ctr[i] !== 0) break; } }
function ivOf(salt, ctr) { const iv = new Uint8Array(12); for (let i = 0; i < 8; i++) iv[i] = salt[i] ^ ctr[i]; for (let i = 8; i < 12; i++) iv[i] = salt[i]; return iv; }
onrtctransform = (event) => {
  const t = event.transformer;
  const o = t.options || {};
  const key = b64ToBytes(o.key); const salt = b64ToBytes(o.salt);
  const mode = o.mode;
  const ctr = Uint8Array.from(o.ctr || [0,0,0,0,0,0,0,0]);
  const HEADER_LEN = 9;
  const stream = new TransformStream({
    async transform(frame, controller) {
      try {
        if (mode === 'encrypt') {
          incCounter(ctr);
          const header = new Uint8Array(HEADER_LEN); header.set(ctr, 0);
          const iv = ivOf(salt, ctr);
          const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, new Uint8Array(frame.data)));
          const out = new Uint8Array(HEADER_LEN + ct.length);
          out.set(header, 0); out.set(ct, HEADER_LEN);
          frame.data = out.buffer;
        } else {
          const data = new Uint8Array(frame.data);
          if (data.length < HEADER_LEN + 16) { controller.enqueue(frame); return; }
          const header = data.slice(0, HEADER_LEN);
          const iv = ivOf(salt, header.subarray(0, 8));
          const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header }, key, data.slice(HEADER_LEN));
          frame.data = plain;
        }
        controller.enqueue(frame);
      } catch (e) {}
    }
  });
  t.readable.pipeThrough(stream).pipeTo(t.writable);
};
`
let workerUrl: string | null = null
function getWorkerUrl(): string {
  if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))
  return workerUrl
}


/** createEncodedStreams() is ONE-SHOT per sender: the second call throws
 *  InvalidStateError. A failed transform attach must NEVER re-create the
 *  streams (that is what made the retry loop fail forever). Cache them here
 *  and let the transform itself be rebuilt on retry. */
export const senderStreamCache = new WeakMap<RTCRtpSender, EncodedStreams>()
export const receiverStreamCache = new WeakMap<RTCRtpReceiver, EncodedStreams>()

/**
 * The DOM lib knows only the worker form of RTCRtpScriptTransform; browsers
 * also accept a function transform as first argument. Expose both via a cast
 * to the underlying TransformStream pair.
 */
type RtcTransformCtor = new (arg0: unknown, arg1?: unknown, arg2?: unknown[]) => TransformStream<EncodedFrame, EncodedFrame>
const MakeTransform = RTCRtpScriptTransform as unknown as RtcTransformCtor

/** Which insertable-streams contract this engine speaks. */
export function encodedTransformModel(): 'modern' | 'legacy' {
  const sender = (globalThis as { RTCRtpSender?: typeof RTCRtpSender }).RTCRtpSender
  const receiver = (globalThis as { RTCRtpReceiver?: typeof RTCRtpReceiver }).RTCRtpReceiver
  if (sender && sender.prototype && 'transform' in sender.prototype && receiver && receiver.prototype && 'transform' in receiver.prototype) {
    return 'modern'
  }
  return 'legacy'
}

/** MODERN model: assign straight onto the transport. The worker receives the
 *  key/salt via structured-clone options and pipes t.readable →
 *  TransformStream(mode) → t.writable on its rtctransform. No main-thread
 *  stream plumbing, no readable/writable pair — by design. */
function modernTransform(worker: Worker, options: Record<string, unknown>): RTCRtpScriptTransform {
  const Ctor = RTCRtpScriptTransform as unknown as { new (w: Worker, o: unknown, t: unknown[]): RTCRtpScriptTransform }
  return new Ctor(worker, options, [])
}

/** Lazily create the ONE encoding Worker shared by every transform of a peer
 *  connection (modern model). A worker hosts any number of transformers, one
 *  per `rtctransform` event, so a single instance serves both directions of
 *  every attach for the peer — see PeerEntry.worker. */
function workerFor(entry: PeerEntry): Worker {
  if (!entry.worker) entry.worker = new Worker(getWorkerUrl())
  return entry.worker
}

/** Attach an E2EE transform to one SENDER (encrypts our outbound frames). */
export async function attachSenderCrypto(sender: RTCRtpSender, entry: PeerEntry, keyBytes: Uint8Array, salt: Uint8Array<ArrayBuffer>, onThrottledDrop?: () => void): Promise<boolean> {
  try {
    if (encodedTransformModel() === 'modern') {
      // salt/ctr travel via structured clone in the options object.
      const ctr = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      const holder = sender as unknown as { transform: RTCRtpScriptTransform | null }
      // Re-attach is legal (spec: transforms update dynamically) but assigning
      // over an existing transform throws InvalidStateError — null it first.
      if (holder.transform) holder.transform = null
      holder.transform = modernTransform(
        workerFor(entry),
        { mode: 'encrypt', key: b64Encode(keyBytes), salt: b64Encode(salt), ctr },
      )
      return true
    }
    // LEGACY: createEncodedStreams + a public-pair transform piped inline.
    const key = await importMediaKey(keyBytes)
    let streams = senderStreamCache.get(sender)
    if (!streams) {
      streams = (sender as unknown as EncodedStreamHost).createEncodedStreams()
      senderStreamCache.set(sender, streams)
    }
    let transform: TransformStream<EncodedFrame, EncodedFrame>
    try {
      transform = new MakeTransform(makeFrameTransformer(key, salt, 'encrypt', onThrottledDrop))
    } catch {
      transform = new MakeTransform(
        workerFor(entry),
        { key: b64Encode(keyBytes), salt: b64Encode(salt), mode: 'encrypt', ctr: Array.from(crypto.getRandomValues(new Uint8Array(8))) },
        [],
      )
    }
    if (!transform || !streams || !transform.readable || !transform.writable) return false
    streams.readable.pipeThrough(transform).pipeTo(streams.writable).catch(() => {})
    return true
  } catch (err) {
    console.warn('[media] encrypt attach error:', err instanceof Error ? err.message : err)
    return false
  }
}

/** Attach an E2EE transform to one RECEIVER (decrypts inbound frames). In the
 *  modern model the streams argument is ignored (receiver.transform assigns
 *  the worker-side pipeline); in the legacy model it must be the synchronously
 *  created encoded streams. */
export async function attachReceiverCrypto(receiver: RTCRtpReceiver, streams: EncodedStreams, entry: PeerEntry, keyBytes: Uint8Array, salt: Uint8Array<ArrayBuffer>, onThrottledDrop?: () => void): Promise<void> {
  try {
    if (encodedTransformModel() === 'modern') {
      ;(receiver as unknown as { transform: RTCRtpScriptTransform | null }).transform = modernTransform(
        workerFor(entry),
        { mode: 'decrypt', key: b64Encode(keyBytes), salt: b64Encode(salt) },
      )
      return
    }
    const key = await importMediaKey(keyBytes)
    let transform: TransformStream<EncodedFrame, EncodedFrame>
    try {
      transform = new MakeTransform(makeFrameTransformer(key, salt, 'decrypt', onThrottledDrop))
    } catch {
      transform = new MakeTransform(
        workerFor(entry),
        { key: b64Encode(keyBytes), salt: b64Encode(salt), mode: 'decrypt' },
        [],
      )
    }
    if (!transform || !transform.readable || !transform.writable) return
    streams.readable.pipeThrough(transform).pipeTo(streams.writable).catch(() => {})
  } catch (err) {
    console.warn('[media] decrypt attach error:', err instanceof Error ? err.message : err)
  }
}
