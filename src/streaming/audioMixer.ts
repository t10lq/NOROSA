/**
 * AudioMixer — blends the presenter's microphone with the screen's system
 * audio into ONE clean, gain-controlled output track.
 *
 * Web Audio chain, per source:
 *   MediaStreamSource -> sourceGain -> masterGain -> MediaStreamAudioDestination
 *
 * The single destination track is the only audio track attached to the
 * broadcast stream, so peers always see one stable track no matter how many
 * sources are toggled live. The same masterGain doubles as the broadcast
 * "output volume", driven directly by the room's 0–100 slider.
 */

export type MixTrackKind = 'mic' | 'system'

const AudioContextCtor: typeof AudioContext | undefined =
  typeof AudioContext !== 'undefined'
    ? AudioContext
    : (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

export class AudioMixer {
  readonly ctx: AudioContext
  readonly dest: MediaStreamAudioDestinationNode
  readonly master: GainNode
  readonly meter: AnalyserNode | null
  private readonly nodes = new Map<MixTrackKind, GainNode>()

  private constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.dest = ctx.createMediaStreamDestination()
    this.master = ctx.createGain()
    this.master.gain.value = 1
    this.master.connect(this.dest)

    try {
      this.meter = ctx.createAnalyser()
      this.meter.fftSize = 512
      this.master.connect(this.meter)
    } catch {
      this.meter = null
    }
  }

  static isSupported(): boolean {
    return Boolean(AudioContextCtor)
  }

  static create(): AudioMixer | null {
    if (!AudioMixerCtorAvailable()) return null
    try {
      return new AudioMixer(new AudioContextCtor!())
    } catch {
      return null
    }
  }

  /** Browsers may start the context suspended; must run inside a user gesture. */
  async prime(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => {})
    }
  }

  addSource(kind: MixTrackKind, track: MediaStreamTrack): void {
    this.removeSource(kind, false)
    const source = this.ctx.createMediaStreamSource(new MediaStream([track]))
    const gain = this.ctx.createGain()
    gain.gain.value = 1
    source.connect(gain)
    gain.connect(this.master)
    this.nodes.set(kind, gain)
  }

  removeSource(kind: MixTrackKind, stopTrack = true): void {
    const node = this.nodes.get(kind)
    if (node) {
      try {
        node.disconnect()
      } catch {
        /* already detached */
      }
      this.nodes.delete(kind)
    }
  }

  setSourceLevel(kind: MixTrackKind, level: number): void {
    const node = this.nodes.get(kind)
    if (node) {
      node.gain.setTargetAtTime(clamp01(level), this.ctx.currentTime, 0.015)
    }
  }

  setVolume(volume: number): void {
    this.master.gain.setTargetAtTime(clamp01(volume), this.ctx.currentTime, 0.015)
  }

  get outputTrack(): MediaStreamTrack {
    return this.dest.stream.getAudioTracks()[0]!
  }

  close(): void {
    for (const node of this.nodes.values()) {
      try {
        node.disconnect()
      } catch {
        /* already detached */
      }
    }
    this.nodes.clear()
    try {
      void this.ctx.close()
    } catch {
      /* audio context already closed */
    }
  }
}

function AudioMixerCtorAvailable(): boolean {
  return Boolean(AudioContextCtor)
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}