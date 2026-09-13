import { type EncodedStreamHost } from './sframe'

/** Deep capability check.
 *
 *  The WebRTC Encoded Transform API was "Baseline Newly available" in late
 *  2025, and the MAIN-THREAD contract changed:
 *   - MODERN  (Chrome ≈140+, all current engines): RTCRtpScriptTransform is
 *     constructed ONLY with a Worker; readable/writable are NOT public on the
 *     main thread (they live in the worker's RTCRtpScriptTransformer). You
 *     attach by assigning  sender.transform = … / receiver.transform = …
 *   - LEGACY  (older Chrome): created via createEncodedStreams() +
 *     pipeThrough(transform) where the main-thread transform carried a public
 *     readable/writable pair.
 *  A modern engine legitimately reports "no readable/writable on the main
 *  thread" — that is NOT a broken pipeline. Probe accordingly. */
export type EncodedCapsProbe = {
  supported: boolean
  form: 'modern' | 'legacy' | null
  /** First chars of RTCRtpScriptTransform.toString() — "function …
   *  [native code]" is genuine; anything readable is an injected shim. */
  ctorSource: string
  reason?: string
  ua: string
  isIframe: boolean
  blobWorker: boolean
  /** Legacy createEncodedStreams pairs functional (modern diagnostic). */
  cseWorks: boolean
}

export function probeEncodedStreamsCaps(): EncodedCapsProbe {
  const out: EncodedCapsProbe = {
    supported: false,
    form: null,
    ctorSource: '',
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    isIframe: typeof window !== 'undefined' && window.self !== window.top,
    blobWorker: false,
    cseWorks: false,
  }
  try {
    if (typeof RTCRtpScriptTransform === 'undefined') {
      out.reason = 'RTCRtpScriptTransform is undefined in this browser'
      return out
    }
    out.ctorSource = String(RTCRtpScriptTransform).slice(0, 160)

    const senderHasTransform =
      typeof RTCRtpSender !== 'undefined' && RTCRtpSender.prototype && 'transform' in RTCRtpSender.prototype
    const receiverHasTransform =
      typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.prototype && 'transform' in RTCRtpReceiver.prototype

    // MODERN: transform-assignment model.
    if (senderHasTransform && receiverHasTransform) {
      try {
        const w = new Worker(URL.createObjectURL(new Blob(['self.onmessage=()=>{}'], { type: 'text/javascript' })))
        w.terminate()
        out.blobWorker = true
        const t = new RTCRtpScriptTransform(
          new Worker(URL.createObjectURL(new Blob(['self.onmessage=()=>{};'], { type: 'text/javascript' }))),
          { name: 'probe' },
          [],
        )
        void t
        out.form = 'modern'
        out.supported = true
        out.reason = 'OK — sender/receiver.transform assignment model'
      } catch (err) {
        out.reason = 'modern model declared (transform in prototype) but construction failed: ' + (err instanceof Error ? err.message : String(err))
      }
      return out
    }

    // LEGACY: createEncodedStreams + public pair on the main thread.
    out.reason = 'legacy model fallback'
    try {
      const Ctor = RTCRtpScriptTransform as unknown as { new (arg: unknown): { readable?: unknown; writable?: unknown } }
      const t = new Ctor((_: unknown) => {})
      if (t && t.readable && t.writable) {
        out.form = 'legacy'
        out.blobWorker = true
        out.supported = true
        out.reason = 'OK — legacy createEncodedStreams model'
        return out
      }
    } catch { /* fall through */ }
    try {
      const pc = new RTCPeerConnection()
      const tr = pc.addTransceiver('audio', { direction: 'sendonly' })
      const s = (tr.sender as unknown as EncodedStreamHost).createEncodedStreams()
      out.cseWorks = !!(s && s.readable && s.writable)
      pc.close()
    } catch {
      out.cseWorks = false
    }
    out.reason = 'Neither model functional: no sender/receiver.transform, no legacy public pair.'
  } catch (err) {
    out.reason = err instanceof Error ? err.message : String(err)
  }
  return out
}

/** Light feature detection used by the UI entry gate. */
export function insertableStreamsSupported(): boolean {
  return typeof RTCRtpScriptTransform !== 'undefined'
}
