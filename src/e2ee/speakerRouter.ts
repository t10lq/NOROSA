/**
 * SpeakerRouter — routes inbound (remote) audio between the native media
 * element path and an explicit WebAudio "speakerphone" path.
 *
 * Why: while the page holds the microphone in a WebRTC call, browsers (Android
 * in particular) tend to play remote audio through the earpiece/in-call route.
 * Piping remote audio through the AudioContext destination forces the primary
 * speaker output — the classic "speakerphone" switch. Flipping back to the
 * plain <video> element returns playback to the browser's default call routing
 * (earpiece on phones).
 *
 * The router also owns the play() call for remote tiles (the browser's
 * autoplay policy usually refuses an attached stream until playback is
 * explicitly started) and applies setSinkId for a user-selected output device.
 */

interface PeerGraph {
  el: HTMLVideoElement
  full: MediaStream | null
  src: MediaStreamAudioSourceNode | null
  gain: GainNode | null
}

export class SpeakerRouter {
  private byPeer = new Map<string, PeerGraph>()
  private ctx: AudioContext | null = null
  private speakerOn = false
  private outputDevice = 'default'

  attach(peer: string, el: HTMLVideoElement, stream: MediaStream): void {
    const cur = this.byPeer.get(peer)
    if (cur) cur.full = stream
    else this.byPeer.set(peer, { el, full: stream, src: null, gain: null })
    this.render(peer)
  }

  detach(peer: string): void {
    const cur = this.byPeer.get(peer)
    if (cur) this.teardownGraph(cur)
    this.byPeer.delete(peer)
    this.maybeShutdownCtx()
  }

  setSpeaker(on: boolean): void {
    this.speakerOn = on
    if (on) this.ensureCtx()
    for (const peer of [...this.byPeer.keys()]) this.render(peer)
  }

  isSpeaker(): boolean {
    return this.speakerOn
  }

  setOutputDevice(id: string): void {
    this.outputDevice = (id && id !== 'default') ? id : 'default'
    const sink = this.outputDevice
    for (const g of this.byPeer.values()) this.applySink(g.el, sink)
  }

  reset(): void {
    for (const peer of [...this.byPeer.keys()]) this.detach(peer)
    this.speakerOn = false
    this.outputDevice = 'default'
  }

  private ensureCtx(): AudioContext | null {
    if (!this.ctx) {
      const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
      const Ctor = w.AudioContext || w.webkitAudioContext
      if (Ctor) this.ctx = new Ctor()
    }
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  private render(peer: string): void {
    const g = this.byPeer.get(peer)
    if (!g || !g.el) return
    const audio = g.full?.getAudioTracks()[0] ?? null
    const video = g.full?.getVideoTracks()[0] ?? null
    this.teardownGraph(g)
    g.src = null
    g.gain = null

    if (this.speakerOn && this.ctx && audio) {
      const ctx = this.ctx
      try {
        const src = ctx.createMediaStreamSource(new MediaStream([audio]))
        const gain = ctx.createGain()
        gain.gain.value = 1
        src.connect(gain)
        gain.connect(ctx.destination)
        g.src = src
        g.gain = gain
        g.el.srcObject = video ? new MediaStream([video]) : null
      } catch (err) {
        console.warn('[speaker] WebAudio route failed, falling back to element playback:', err)
        this.teardownGraph(g)
        g.src = null
        g.gain = null
        g.el.srcObject = g.full
      }
    } else {
      g.el.srcObject = g.full
    }

    this.applySink(g.el, this.outputDevice)
    void g.el.play().catch(() => {})
  }

  private applySink(el: HTMLVideoElement, id: string): void {
    const v = el as HTMLVideoElement & { setSinkId?: (sink: string) => Promise<void> | void }
    const fn = v.setSinkId
    if (fn) {
      try {
        void Promise.resolve(fn.call(v, id)).catch(() => {})
      } catch {
        // setSinkId threw synchronously — non-supporting engine; ignore.
      }
    }
  }

  private teardownGraph(g: PeerGraph): void {
    try { if (g.gain) g.gain.disconnect() } catch { /* node already dead */ }
    try { if (g.src) g.src.disconnect() } catch { /* node already dead */ }
    g.src = null
    g.gain = null
  }

  private maybeShutdownCtx(): void {
    if (this.ctx && this.byPeer.size === 0) {
      void this.ctx.close().catch(() => {})
      this.ctx = null
    }
  }
}